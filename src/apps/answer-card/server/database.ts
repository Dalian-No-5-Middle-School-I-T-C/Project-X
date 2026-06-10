/**
 * SQLite 数据库层（基于 sql.js — 纯 WASM，无需本地编译）
 * 替代 JSON 文件存储，提供答题卡和扫描记录的持久化。
 * 首次启动时自动迁移现有 JSON 数据。
 */

import initSqlJs, { type Database as SqlJsDb, type BindParams } from "sql.js";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import type { AnswerCard, CardSummary, LayoutDocument } from "../../../shared/types";
import { buildLayout } from "../../../shared/layout";
import { createDefaultCard } from "../../../shared/defaultCard";

// ============================================================
// 路径配置
// ============================================================

export const rootDir = process.cwd();
export const dataDir = process.env.ANSWER_CARD_DATA_DIR
  ? path.resolve(process.env.ANSWER_CARD_DATA_DIR)
  : path.join(rootDir, "data", "answer-card");
export const dbPath = path.join(dataDir, "answer-card.db");
export const scansDir = path.join(dataDir, "scans");
export const thumbnailsDir = path.join(dataDir, "thumbnails");
export const assetsDir = path.join(dataDir, "assets");
export const cardsDir = path.join(dataDir, "cards");
export const layoutsDir = path.join(dataDir, "layouts");

// ============================================================
// 类型定义
// ============================================================

export type ScanStatus = "pending" | "processing" | "recognized" | "error";

export type ScanRecord = {
  id: string;
  file_name: string;
  original_path: string;
  stored_path: string;
  thumbnail_path: string | null;
  file_size: number;
  width: number | null;
  height: number | null;
  dpi: number;
  status: ScanStatus;
  card_id: string | null;
  page_number: number;
  student_id: string | null;
  student_name: string | null;
  class_name: string | null;
  recognition_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type ScanSummary = Pick<
  ScanRecord,
  "id" | "file_name" | "status" | "student_id" | "student_name" | "card_id" | "created_at"
> & { thumbnail_url: string | null };

// ============================================================
// 数据库单例（异步初始化）
// ============================================================

let db: SqlJsDb | null = null;

/**
 * 将数据库写入文件（sql.js 需要手动持久化）
 */
function saveDbToFile(): void {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(dbPath, buffer);
  } catch (err) {
    console.error("[database] 保存数据库文件失败:", err);
  }
}

/**
 * 获取数据库实例（异步初始化）
 */
export async function getDb(): Promise<SqlJsDb> {
  if (db) return db;

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(scansDir, { recursive: true });
  mkdirSync(thumbnailsDir, { recursive: true });

  const SQL = await initSqlJs();

  // 如果已有数据库文件，加载它；否则创建空库
  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath);
    db = new SQL.Database(new Uint8Array(fileBuffer));
  } else {
    db = new SQL.Database();
  }

  // 建表
  db.run(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '未命名答题卡',
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS layouts (
      card_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      original_path TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      thumbnail_path TEXT,
      file_size INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      dpi INTEGER NOT NULL DEFAULT 300,
      status TEXT NOT NULL DEFAULT 'pending',
      card_id TEXT,
      page_number INTEGER NOT NULL DEFAULT 1,
      student_id TEXT,
      student_name TEXT,
      class_name TEXT,
      recognition_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS scan_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_scans_card_id ON scans(card_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_scans_student_id ON scans(student_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at DESC)");

  saveDbToFile();

  // 默认配置
  await insertConfigDefaults();
  // 尝试迁移旧 JSON 数据
  await migrateJsonData();

  return db;
}

/**
 * 同步获取数据库（仅当已初始化后使用）
 */
export function getDbSync(): SqlJsDb {
  if (!db) throw new Error("[database] 数据库尚未初始化，请先调用 await getDb()");
  return db;
}

// ============================================================
// 辅助：sql.js 查询包装器
// ============================================================

/** 执行单条 SQL，返回匹配的行（对象数组） */
function queryAll<T = Record<string, unknown>>(sql: string, params?: BindParams): T[] {
  const d = getDbSync();
  const stmt = d.prepare(sql);
  if (params) stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as unknown as T);
  }
  stmt.free();
  return results;
}

/** 执行单条 SQL，返回第一行 */
function queryOne<T = Record<string, unknown>>(sql: string, params?: BindParams): T | null {
  const rows = queryAll<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/** 执行写入 SQL（INSERT/UPDATE/DELETE），自动持久化 */
function execAndSave(sql: string, params?: BindParams): void {
  const d = getDbSync();
  d.run(sql, params);
  saveDbToFile();
}

/** 批量写入（事务内），最后持久化一次 */
function execBatch(statements: Array<{ sql: string; params?: BindParams }>): void {
  const d = getDbSync();
  d.run("BEGIN TRANSACTION");
  try {
    for (const s of statements) {
      d.run(s.sql, s.params);
    }
    d.run("COMMIT");
    saveDbToFile();
  } catch (err) {
    d.run("ROLLBACK");
    throw err;
  }
}

// ============================================================
// 默认配置
// ============================================================

async function insertConfigDefaults(): Promise<void> {
  await getDb(); // ensure init
  const defaults: Record<string, string> = {
    input_folder: path.join(rootDir, "input"),
    auto_recognize: "true",
    default_dpi: "300",
    scanner_driver: "" // 预留：TWAIN/WIA 驱动路径
  };

  for (const [key, value] of Object.entries(defaults)) {
    execAndSave("INSERT OR IGNORE INTO scan_config (key, value) VALUES (?, ?)", [key, value]);
  }
}

// ============================================================
// JSON → SQLite 数据迁移
// ============================================================

async function migrateJsonData(): Promise<void> {
  await getDb(); // ensure init

  // 检查是否已迁移
  const migrated = queryOne<{ value: string }>(
    "SELECT value FROM scan_config WHERE key = ?", ["json_migrated"]
  );
  if (migrated?.value === "true") return;

  const oldCardsDir = cardsDir;
  if (!existsSync(oldCardsDir)) {
    execAndSave("INSERT OR REPLACE INTO scan_config (key, value) VALUES (?, ?)", ["json_migrated", "true"]);
    return;
  }

  const files = readdirSync(oldCardsDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    execAndSave("INSERT OR REPLACE INTO scan_config (key, value) VALUES (?, ?)", ["json_migrated", "true"]);
    return;
  }

  console.log(`[database] 正在迁移 ${files.length} 个答题卡 JSON → SQLite...`);

  const statements: Array<{ sql: string; params?: BindParams }> = [];
  for (const file of files) {
    try {
      const raw = readFileSync(path.join(oldCardsDir, file), "utf8");
      const card = JSON.parse(raw) as AnswerCard;
      statements.push({
        sql: "INSERT OR REPLACE INTO cards (id, title, data_json, updated_at) VALUES (?, ?, ?, ?)",
        params: [card.id, card.title || "未命名答题卡", raw, card.updatedAt || new Date().toISOString()]
      });

      // 同时迁移布局文件
      const layoutFile = path.join(layoutsDir, file);
      if (existsSync(layoutFile)) {
        const layoutRaw = readFileSync(layoutFile, "utf8");
        statements.push({
          sql: "INSERT OR REPLACE INTO layouts (card_id, data_json, updated_at) VALUES (?, ?, ?)",
          params: [card.id, layoutRaw, card.updatedAt || new Date().toISOString()]
        });
      } else {
        const layout = buildLayout(card);
        statements.push({
          sql: "INSERT OR REPLACE INTO layouts (card_id, data_json, updated_at) VALUES (?, ?, ?)",
          params: [card.id, JSON.stringify(layout), new Date().toISOString()]
        });
      }
    } catch (err) {
      console.error(`[database] 迁移 ${file} 失败:`, err);
    }
  }

  execBatch(statements);
  execAndSave("INSERT OR REPLACE INTO scan_config (key, value) VALUES (?, ?)", ["json_migrated", "true"]);

  console.log("[database] JSON → SQLite 迁移完成");
}

// ============================================================
// 答题卡 CRUD
// ============================================================

export function listCards(): CardSummary[] {
  const rows = queryAll<{ id: string; title: string; updated_at: string }>(
    "SELECT id, title, updated_at FROM cards ORDER BY updated_at DESC"
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at
  }));
}

export function readCard(cardId: string): AnswerCard | null {
  const row = queryOne<{ data_json: string }>(
    "SELECT data_json FROM cards WHERE id = ?", [cardId]
  );
  if (!row) return null;
  return JSON.parse(row.data_json) as AnswerCard;
}

export function saveCard(card: AnswerCard): AnswerCard {
  const normalized: AnswerCard = {
    ...card,
    id: safeId(card.id),
    paper: { size: "A4", orientation: "portrait" },
    layoutVersion: 1,
    updatedAt: new Date().toISOString()
  };

  const json = JSON.stringify(normalized, null, 2);
  const now = normalized.updatedAt;

  execAndSave(
    "INSERT OR REPLACE INTO cards (id, title, data_json, updated_at) VALUES (?, ?, ?, ?)",
    [normalized.id, normalized.title, json, now]
  );

  // 同时保存布局
  saveLayout(normalized);

  return normalized;
}

export function createCard(): AnswerCard {
  let id = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    id = String(Math.floor(Math.random() * 100000000)).padStart(8, "0");
    const exists = queryOne("SELECT 1 FROM cards WHERE id = ?", [id]);
    if (!exists) break;
  }

  const card = createDefaultCard(id);
  saveCard(card);
  return card;
}

// ============================================================
// 布局
// ============================================================

export function saveLayout(card: AnswerCard): LayoutDocument {
  const layout = buildLayout(card);
  const now = new Date().toISOString();

  execAndSave(
    "INSERT OR REPLACE INTO layouts (card_id, data_json, updated_at) VALUES (?, ?, ?)",
    [card.id, JSON.stringify(layout, null, 2), now]
  );

  return layout;
}

export function readLayout(cardId: string): LayoutDocument | null {
  const row = queryOne<{ data_json: string }>(
    "SELECT data_json FROM layouts WHERE card_id = ?", [cardId]
  );
  if (row) return JSON.parse(row.data_json) as LayoutDocument;

  // 回退：从卡片重新生成布局
  const card = readCard(cardId);
  if (!card) return null;
  return saveLayout(card);
}

export function layoutPath(cardId: string): string {
  // 临时文件路径，供 C++ 识别程序读取
  const filePath = path.join(layoutsDir, `${safeId(cardId)}.json`);
  mkdirSync(layoutsDir, { recursive: true });

  const row = queryOne<{ data_json: string }>(
    "SELECT data_json FROM layouts WHERE card_id = ?", [cardId]
  );

  if (row) {
    writeFileSync(filePath, row.data_json, "utf8");
  }

  return filePath;
}

// ============================================================
// 扫描记录 CRUD
// ============================================================

export function insertScan(scan: Omit<ScanRecord, "created_at" | "updated_at">): ScanRecord {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  execAndSave(
    `INSERT INTO scans (id, file_name, original_path, stored_path, thumbnail_path,
      file_size, width, height, dpi, status, card_id, page_number,
      student_id, student_name, class_name, recognition_json, error_message,
      created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scan.id, scan.file_name, scan.original_path, scan.stored_path,
      scan.thumbnail_path, scan.file_size, scan.width, scan.height,
      scan.dpi, scan.status, scan.card_id, scan.page_number,
      scan.student_id, scan.student_name, scan.class_name,
      scan.recognition_json, scan.error_message, now, now
    ]
  );

  return { ...scan, created_at: now, updated_at: now };
}

export function updateScan(id: string, fields: Partial<ScanRecord>): ScanRecord | null {
  const existing = queryOne<ScanRecord>("SELECT * FROM scans WHERE id = ?", [id]);
  if (!existing) return null;

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const merged = { ...existing, ...fields, updated_at: now };

  execAndSave(
    `UPDATE scans SET
      file_name = ?, original_path = ?, stored_path = ?, thumbnail_path = ?,
      file_size = ?, width = ?, height = ?, dpi = ?, status = ?,
      card_id = ?, page_number = ?, student_id = ?, student_name = ?,
      class_name = ?, recognition_json = ?, error_message = ?, updated_at = ?
    WHERE id = ?`,
    [
      merged.file_name, merged.original_path, merged.stored_path, merged.thumbnail_path,
      merged.file_size, merged.width, merged.height, merged.dpi, merged.status,
      merged.card_id, merged.page_number, merged.student_id, merged.student_name,
      merged.class_name, merged.recognition_json, merged.error_message, merged.updated_at,
      id
    ]
  );

  return merged;
}

export function getScan(id: string): ScanRecord | null {
  return queryOne<ScanRecord>("SELECT * FROM scans WHERE id = ?", [id]);
}

export function listScans(options?: {
  cardId?: string;
  status?: ScanStatus;
  studentId?: string;
  limit?: number;
  offset?: number;
}): ScanSummary[] {
  let sql = `
    SELECT id, file_name, status, student_id, student_name, card_id,
           thumbnail_path, created_at
    FROM scans WHERE 1=1
  `;
  const params: BindParams = [];

  if (options?.cardId) {
    sql += " AND card_id = ?";
    params.push(options.cardId);
  }
  if (options?.status) {
    sql += " AND status = ?";
    params.push(options.status);
  }
  if (options?.studentId) {
    sql += " AND student_id = ?";
    params.push(options.studentId);
  }

  sql += " ORDER BY created_at DESC";

  if (options?.limit != null) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }
  if (options?.offset != null) {
    sql += " OFFSET ?";
    params.push(options.offset);
  }

  const rows = queryAll<{
    id: string; file_name: string; status: string;
    student_id: string | null; student_name: string | null;
    card_id: string | null; thumbnail_path: string | null;
    created_at: string;
  }>(sql, params);

  return rows.map((row) => ({
    id: row.id,
    file_name: row.file_name,
    status: row.status as ScanStatus,
    student_id: row.student_id,
    student_name: row.student_name,
    card_id: row.card_id,
    thumbnail_url: row.thumbnail_path ? `/scans/${path.basename(row.thumbnail_path)}` : null,
    created_at: row.created_at
  }));
}

export function getScanCount(options?: { cardId?: string; status?: ScanStatus }): number {
  let sql = "SELECT COUNT(*) as count FROM scans WHERE 1=1";
  const params: BindParams = [];

  if (options?.cardId) {
    sql += " AND card_id = ?";
    params.push(options.cardId);
  }
  if (options?.status) {
    sql += " AND status = ?";
    params.push(options.status);
  }

  const row = queryOne<{ count: number }>(sql, params);
  return row?.count ?? 0;
}

// ============================================================
// 配置管理
// ============================================================

export function getConfig(key: string): string | null {
  const row = queryOne<{ value: string }>(
    "SELECT value FROM scan_config WHERE key = ?", [key]
  );
  return row?.value ?? null;
}

export function setConfig(key: string, value: string): void {
  execAndSave("INSERT OR REPLACE INTO scan_config (key, value) VALUES (?, ?)", [key, value]);
}

export function getAllConfig(): Record<string, string> {
  const rows = queryAll<{ key: string; value: string }>(
    "SELECT key, value FROM scan_config"
  );
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// ============================================================
// 工具函数
// ============================================================

export function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function cardPath(cardId: string): string {
  return path.join(cardsDir, `${safeId(cardId)}.json`);
}

export function cardAssetsDir(cardId: string): string {
  return path.join(assetsDir, safeId(cardId));
}

/**
 * 确保数据目录存在（兼容旧 storage.ts 接口）
 */
export async function ensureDataDirs(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(scansDir, { recursive: true });
  mkdirSync(thumbnailsDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(cardsDir, { recursive: true });
  mkdirSync(layoutsDir, { recursive: true });
  await getDb(); // 确保数据库已初始化
}

/**
 * 生成唯一扫描 ID
 */
export function generateScanId(): string {
  return `scan_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * 关闭数据库连接（应用退出时调用）
 */
export function closeDb(): void {
  if (db) {
    saveDbToFile();
    db.close();
    db = null;
  }
}
