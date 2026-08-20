import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrations";
import { resolveProjectDbPath } from "./paths";
import { seedDefaultData } from "./seeds";
import { detectDialect, getMysqlDb, initMariadbSchema, buildInsertIgnore } from "./mysql";
import type { DbAdapter } from "./mysql";
import { encryptField } from "../lib/field-crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbInstance: Database.Database | null = null;

function schemaPath(): string {
  return path.join(__dirname, "schema.sql");
}

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    const dbPath = resolveProjectDbPath();
    mkdirSync(path.dirname(dbPath), { recursive: true });
    dbInstance = new Database(dbPath);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
    dbInstance.pragma("synchronous = NORMAL");
    dbInstance.pragma("busy_timeout = 5000");
    console.log(`[DB] Connected to: ${dbPath}`);
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    console.log("[DB] Connection closed");
  }
}

export function initializeDatabase(): void {
  const dialect = detectDialect();

  if (dialect === "mariadb") {
    // v1.6.0: MariaDB 增量迁移机制 — 检测并执行缺失的 schema_migrations
    console.log("[DB] MariaDB mode: schema seeded via schema.mariadb.sql");
    // initMariadbSchema() 在 getMysqlDb() 首次调用时自动执行
    // ensureDefaultAdmin() 在外部调用，自动生成 API Key
    return;
  }

  // SQLite 模式
  const db = getDatabase();
  const schema = readFileSync(schemaPath(), "utf8");

  // Always run the idempotent base schema so partially initialized deployments
  // recover missing core tables before cleanup jobs and migrations touch them.
  db.exec(schema);
  console.log("[DB] Schema checked successfully");

  runMigrations(db);
  seedDefaultData(db);
}

/**
 * 安全审计（F-2）：把库中历史遗留的明文 initial_password 一次性加密为 enc:v1: 密文。
 * 幂等（仅处理无 enc:v1: 前缀的旧数据）；SQLite / MariaDB 双模兼容。
 */
export async function encryptLegacyInitialPasswords(db: DbAdapter): Promise<void> {
  try {
    const rows = await db.all<{ id: number; initial_password: string }>(
      "SELECT id, initial_password FROM users WHERE initial_password IS NOT NULL AND initial_password != '' AND initial_password NOT LIKE 'enc:v1:%'"
    );
    let count = 0;
    for (const row of rows) {
      await db.run("UPDATE users SET initial_password = ? WHERE id = ?", encryptField(row.initial_password), row.id);
      count++;
    }
    if (count > 0) {
      console.log(`[secrets] 已加密 ${count} 条历史明文 initial_password`);
    }
  } catch (err) {
    console.warn("[secrets] 历史明文加密迁移失败（不影响启动，可稍后重试）:", err);
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || hash === "") {
    return false;
  }
  return bcrypt.compare(password, hash);
}

const BOOTSTRAP_ADMIN_FILE = "bootstrap-admin.txt";

export function getBootstrapAdminPath(): string {
  return path.join(path.dirname(resolveProjectDbPath()), BOOTSTRAP_ADMIN_FILE);
}

function writeBootstrapAdminPassword(password: string): void {
  const target = getBootstrapAdminPath();
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${BOOTSTRAP_ADMIN_FILE}.${process.pid}.${Date.now()}.tmp`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, `${password}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, target);
  } catch {
    rmSync(target, { force: true });
    renameSync(temp, target);
  }
  try { chmodSync(target, 0o600); } catch { /* Windows ACLs may ignore POSIX modes. */ }
  console.warn(`[SECURITY] 管理员一次性密码已写入受保护文件: ${target}`);
}

export function removeBootstrapAdminFile(): void {
  try { rmSync(getBootstrapAdminPath(), { force: true }); } catch (error) {
    console.warn("[SECURITY] 清理管理员一次性密码文件失败:", error);
  }
}

export interface DefaultAdminBootstrapResult {
  adminId: number;
  rotated: boolean;
  passwordFile: string;
}

export async function ensureDefaultAdmin(): Promise<DefaultAdminBootstrapResult> {
  const dialect = detectDialect();
  const db = getMysqlDb();
  const existing = await db.get<{ id: number; password_hash: string; password_change_required: number }>(
    "SELECT id, password_hash, password_change_required FROM users WHERE username = ?",
    "admin"
  );
  const passwordFile = getBootstrapAdminPath();

  if (existing) {
    const usesLegacyDefault = await verifyPassword("admin123", existing.password_hash);
    const lostBootstrapSecret = Boolean(existing.password_change_required) && !existsSync(passwordFile);
    if (usesLegacyDefault || lostBootstrapSecret) {
      const password = randomBytes(24).toString("base64url");
      await db.run(
        "UPDATE users SET password_hash = ?, password_change_required = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        await hashPassword(password), existing.id
      );
      writeBootstrapAdminPassword(password);
      await (dialect === "mariadb" ? ensureDefaultApiKey(db) : ensureDefaultApiKeySqlite(getDatabase()));
      return { adminId: existing.id, rotated: true, passwordFile };
    }
    await (dialect === "mariadb" ? ensureDefaultApiKey(db) : ensureDefaultApiKeySqlite(getDatabase()));
    return { adminId: existing.id, rotated: false, passwordFile };
  }

  if (dialect === "mariadb") {
    const password = randomBytes(24).toString("base64url");
    const passwordHash = await hashPassword(password);
    const insertAdminSql = buildInsertIgnore("mariadb", "users", [
      "username", "password_hash", "name", "role_id", "is_active", "password_change_required",
    ]);
    const result = await db.run(insertAdminSql, "admin", passwordHash, "系统管理员", 1, 1, 1);
    writeBootstrapAdminPassword(password);
    await ensureDefaultApiKey(db);
    return { adminId: result.lastInsertRowid, rotated: true, passwordFile };
  }

  // SQLite 模式
  const sqlite = getDatabase();
  const password = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(password);
  const result = sqlite.prepare(
    `INSERT INTO users (username, password_hash, name, role_id, is_active, password_change_required)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("admin", passwordHash, "系统管理员", 1, 1, 1);
  writeBootstrapAdminPassword(password);
  await ensureDefaultApiKeySqlite(sqlite);
  return { adminId: Number(result.lastInsertRowid), rotated: true, passwordFile };
}

// v1.6.0: 确保至少有一条扫描用的 API Key
async function ensureDefaultApiKey(db: any): Promise<void> {
  const existing = await db.get("SELECT id FROM api_keys WHERE scope = 'scanner' AND is_active = 1 LIMIT 1");
  if (existing) return;
  const key = `sk-${randomBytes(16).toString("hex")}`;
  await db.run("INSERT INTO api_keys (name, api_key, scope) VALUES (?, ?, ?)", "默认扫描端密钥", key, "scanner");
  console.log(`[DB] Default scanner API key created: ${key}`);
}

function ensureDefaultApiKeySqlite(db: any): Promise<void> {
  const existing = db.prepare("SELECT id FROM api_keys WHERE scope = 'scanner' AND is_active = 1 LIMIT 1").get();
  if (existing) return Promise.resolve();
  const key = `sk-${randomBytes(16).toString("hex")}`;
  db.prepare("INSERT INTO api_keys (name, api_key, scope) VALUES (?, ?, ?)").run("默认扫描端密钥", key, "scanner");
  console.log(`[DB] Default scanner API key created: ${key}`);
  return Promise.resolve();
}

export { runMigrations };
export { resolveAnswerCardDataDir, resolveProjectDbPath, resolveScannerDbPath } from "./paths";

// ── 跨方言 DB 适配器 ──────────────────────────────────
export {
  getMysqlDb,
  getMariadbConfig,
  runMariadbMigrations,
  initMariadbSchema,
  initMariadbSchema as initMysqlSchema,
  detectDialect,
  buildUpsertSQL,
  buildInsertIgnore,
  healthCheck,
  resetAdapter,
} from "./mysql";
export type { DbAdapter } from "./mysql";
