import mariadb from "mysql2/promise";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase } from "./index";

// ── 模式检测 ───────────────────────────────────────────
// 优先级：环境变量 > config.yml > 默认 SQLite

function readConfigDbMode(): { mode: string; remote?: any } | null {
  const configPath = path.join(process.cwd(), "config.yml");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf8");
    // 简单解析：找 database: 段下的字段
    const modeMatch = raw.match(/^\s*mode:\s*(.+)$/m);
    const mode = modeMatch ? modeMatch[1].trim() : "local";
    if (mode !== "remote") return { mode };

    const hostMatch = raw.match(/^\s*host:\s*"?(.+?)"?\s*$/m);
    if (!hostMatch || !hostMatch[1].trim()) return { mode };

    const portMatch = raw.match(/^\s*port:\s*(\d+)\s*$/m);
    const dbMatch = raw.match(/^\s*database:\s*"?(.+?)"?\s*$/m);
    const userMatch = raw.match(/^\s*user:\s*"?(.+?)"?\s*$/m);
    const passMatch = raw.match(/^\s*password:\s*"?(.*?)"?\s*$/m);

    return {
      mode: "remote",
      remote: {
        host: hostMatch[1].trim(),
        port: portMatch ? parseInt(portMatch[1], 10) : 3306,
        database: dbMatch ? dbMatch[1].trim() : "projectx",
        user: userMatch ? userMatch[1].trim() : "projectx_app",
        password: passMatch ? passMatch[1].trim() : "",
      }
    };
  } catch {
    return null;
  }
}

let _detectedDialect: "sqlite" | "mariadb" | null = null;

export function detectDialect(): "sqlite" | "mariadb" {
  if (_detectedDialect) return _detectedDialect;

  // 1. 环境变量优先（Docker / K8s / CI）
  if (process.env.PROJECTX_MARIADB_HOST || process.env.PROJECTX_MYSQL_HOST) {
    _detectedDialect = "mariadb";
    return "mariadb";
  }

  // 2. config.yml（用户设置界面写入）
  const dbConfig = readConfigDbMode();
  if (dbConfig?.mode === "remote" && dbConfig?.remote?.host) {
    _detectedDialect = "mariadb";
    return "mariadb";
  }

  // 3. 兜底：本地 SQLite
  _detectedDialect = "sqlite";
  return "sqlite";
}

/** 重置方言检测（测试用） */
export function resetDialect(): void {
  _detectedDialect = null;
}

// ── 统一异步接口 ───────────────────────────────────────
// 所有方法返回 Promise，适配 Express async handler

export interface DbAdapter {
  /** 数据库方言 */
  readonly dialect: "sqlite" | "mariadb";
  /** 查询单行 */
  get<T = any>(sql: string, ...params: any[]): Promise<T | null>;
  /** 查询多行 */
  all<T = any>(sql: string, ...params: any[]): Promise<T[]>;
  /** 执行写操作，返回 insertId 和 affectedRows */
  run(sql: string, ...params: any[]): Promise<{ lastInsertRowid: number; changes: number }>;
  /** 执行原始 SQL */
  exec(sql: string): Promise<void>;
  /** 事务 */
  transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T>;
}

// ── 跨方言 SQL 工具函数 ──────────────────────────────

/**
 * 构建跨方言 UPSERT 语句
 * SQLite:  INSERT INTO ... ON CONFLICT(...) DO UPDATE SET ...
 * MariaDB: INSERT INTO ... ON DUPLICATE KEY UPDATE ...
 *
 * 注意：简单的全行替换请直接用 REPLACE INTO（SQLite + MariaDB 都支持）
 * 此函数用于需要"仅更新部分列"或"COALESCE 保留旧值"的场景
 */
export function buildUpsertSQL(
  dialect: "sqlite" | "mariadb",
  table: string,
  insertCols: string[],
  conflictCols: string[],
  updateCols?: string[]
): string {
  const cols = insertCols.join(", ");
  const placeholders = insertCols.map(() => "?").join(", ");
  const updCols = updateCols ?? insertCols.filter(c => !conflictCols.includes(c));

  if (dialect === "sqlite") {
    const setClause = updCols.map(c => `${c} = excluded.${c}`).join(", ");
    return `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT(${conflictCols.join(", ")}) DO UPDATE SET ${setClause}`;
  } else {
    const setClause = updCols.map(c => `${c} = VALUES(${c})`).join(", ");
    return `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${setClause}`;
  }
}

/**
 * 构建跨方言 INSERT IGNORE 语句
 * SQLite + MariaDB 都原生支持，此函数仅做统一封装
 */
export function buildInsertIgnore(
  _dialect: "sqlite" | "mariadb",
  table: string,
  cols: string[]
): string {
  const placeholders = cols.map(() => "?").join(", ");
  return `INSERT IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
}

// ── SQLite Adapter ─────────────────────────────────────
// 内部用 better-sqlite3（同步），对外暴露 async 接口

class SqliteAdapter implements DbAdapter {
  readonly dialect = "sqlite" as const;
  private db: any; // better-sqlite3 Database, 懒加载避免循环引用

  constructor() {
    this.db = getDatabase();
  }

  async get<T>(sql: string, ...params: any[]): Promise<T | null> {
    const row = this.db.prepare(sql).get(...params) as T | undefined;
    return row ?? null;
  }
  async all<T>(sql: string, ...params: any[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }
  async run(sql: string, ...params: any[]): Promise<{ lastInsertRowid: number; changes: number }> {
    const r = this.db.prepare(sql).run(...params);
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    const begin = this.db.prepare("BEGIN");
    const commit = this.db.prepare("COMMIT");
    const rollback = this.db.prepare("ROLLBACK");
    begin.run();
    try {
      const result = await fn(this);
      commit.run();
      return result;
    } catch (e) {
      rollback.run();
      throw e;
    }
  }
}

// ── MariaDB Adapter ────────────────────────────────────

function getMariadbConfig() {
  // 环境变量优先
  const host = process.env.PROJECTX_MARIADB_HOST || process.env.PROJECTX_MYSQL_HOST;
  if (host) {
    return {
      host,
      port: Number(process.env.PROJECTX_MARIADB_PORT || process.env.PROJECTX_MYSQL_PORT || 3306),
      user: process.env.PROJECTX_MARIADB_USER || process.env.PROJECTX_MYSQL_USER || "projectx",
      password: process.env.PROJECTX_MARIADB_PASSWORD || process.env.PROJECTX_MYSQL_PASSWORD || "projectx",
      database: process.env.PROJECTX_MARIADB_DATABASE || process.env.PROJECTX_MYSQL_DATABASE || "projectx",
    };
  }

  // config.yml
  const dbConfig = readConfigDbMode();
  if (dbConfig?.remote?.host) {
    return {
      host: dbConfig.remote.host,
      port: dbConfig.remote.port ?? 3306,
      user: dbConfig.remote.user ?? "projectx",
      password: dbConfig.remote.password ?? "",
      database: dbConfig.remote.database ?? "projectx",
    };
  }

  return null;
}

let mariadbPool: Pool | null = null;

function createMariadbPool(): Pool {
  const cfg = getMariadbConfig();
  if (!cfg) throw new Error("MariaDB 连接配置缺失");

  const pool = mariadb.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
    charset: "utf8mb4",
    // 生产级参数
    connectTimeout: 5000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    maxIdle: 10,
    idleTimeout: 60000,
    // 多个语句（建表用）
    multipleStatements: true,
  });

  pool.on("connection", () => {
    // 连接建立
  });
  (pool as any).on("error", (err: Error) => {
    console.error("[MariaDB] Pool error:", err.message);
  });

  console.log(`[MariaDB] Pool: ${cfg.host}:${cfg.port}/${cfg.database}`);
  return pool;
}

class MariadbAdapter implements DbAdapter {
  readonly dialect = "mariadb" as const;
  private executor: Pool | PoolConnection;

  constructor(source?: PoolConnection) {
    if (source) {
      this.executor = source;
    } else {
      if (!mariadbPool) {
        mariadbPool = createMariadbPool();
      }
      this.executor = mariadbPool;
    }
  }

  async get<T>(sql: string, ...params: any[]): Promise<T | null> {
    const [rows] = await this.executor.execute(sql, params) as [T[], any];
    return rows.length > 0 ? rows[0] : null;
  }
  async all<T>(sql: string, ...params: any[]): Promise<T[]> {
    const [rows] = await this.executor.execute(sql, params) as [T[], any];
    return rows as T[];
  }
  async run(sql: string, ...params: any[]): Promise<{ lastInsertRowid: number; changes: number }> {
    const [r] = await this.executor.execute(sql, params) as [ResultSetHeader, any];
    return { lastInsertRowid: r.insertId, changes: r.affectedRows };
  }
  async exec(sql: string): Promise<void> {
    await this.executor.execute(sql);
  }
  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    const conn = await (this.executor as Pool).getConnection();
    const txAdapter = new MariadbAdapter(conn);
    try {
      await conn.beginTransaction();
      const result = await fn(txAdapter);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

// ── 单例 ───────────────────────────────────────────────
let adapter: DbAdapter | null = null;

export function getMysqlDb(): DbAdapter {
  if (!adapter) {
    const dialect = detectDialect();
    if (dialect === "mariadb") {
      adapter = new MariadbAdapter();
      console.log("[DB] Mode: MariaDB (remote)");
    } else {
      adapter = new SqliteAdapter();
      console.log("[DB] Mode: SQLite (local)");
    }
  }
  return adapter;
}

/** 重置适配器（测试/配置变更后用） */
export function resetAdapter(): void {
  if (mariadbPool) {
    mariadbPool.end().catch(() => {});
    mariadbPool = null;
  }
  adapter = null;
  resetDialect();
}

/** 健康检查：测试数据库连通性 */
export async function healthCheck(): Promise<{ ok: boolean; dialect: string; latencyMs?: number; error?: string }> {
  try {
    const db = getMysqlDb();
    const start = Date.now();
    await db.get("SELECT 1 as val");
    const latency = Date.now() - start;
    return { ok: true, dialect: db.dialect, latencyMs: latency };
  } catch (err: any) {
    return { ok: false, dialect: detectDialect(), error: err.message };
  }
}

// ── MariaDB Schema 初始化 ──────────────────────────────

export async function initMariadbSchema(): Promise<void> {
  const dialect = detectDialect();
  if (dialect !== "mariadb") return;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.join(__dirname, "schema.mariadb.sql");

  let schema: string;
  try {
    schema = readFileSync(schemaPath, "utf8");
  } catch {
    console.warn("[MariaDB] schema.mariadb.sql not found, skipping schema init");
    return;
  }

  const pool = mariadbPool!;
  const conn = await pool.getConnection();
  try {
    const statements = schema
      .split("\n")
      .filter(line => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith("USE ") && !s.startsWith("CREATE DATABASE"));
    for (const stmt of statements) {
      try { await conn.execute(stmt); }
      catch (err: any) {
        if (err.code !== "ER_DUP_KEYNAME" && !err.message?.includes("already exists")) throw err;
      }
    }
    console.log("[MariaDB] Schema initialized");
  } finally {
    conn.release();
  }
}

// 保持旧名称兼容
export { initMariadbSchema as initMysqlSchema };
