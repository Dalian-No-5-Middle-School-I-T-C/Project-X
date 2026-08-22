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
import { encryptField, hashSecret } from "../lib/field-crypto";

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

// v2.x: 初始/恢复密码固定为 admin123（部署便利优先，主理人决策）。
// 生产环境暴露网络端口时，部署完成后请立即在界面中修改 admin 密码。
const BOOTSTRAP_ADMIN_PASSWORD = "admin123";

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
  console.warn(`[DB] 管理员初始密码已写入引导文件（生产环境请尽快修改）: ${target}`);
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
    if (!existing.password_change_required) {
      // 已完成首次改密（或显式沿用初始密码）的在用账号：不做任何变更
      await (dialect === "mariadb" ? ensureDefaultApiKey(db) : ensureDefaultApiKeySqlite(getDatabase()));
      return { adminId: existing.id, rotated: false, passwordFile };
    }
    // 停留在引导态的存量库（旧随机一次性密码残留、改密标记未清除等）：统一重置为固定初始密码
    await db.run(
      "UPDATE users SET password_hash = ?, password_change_required = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      await hashPassword(BOOTSTRAP_ADMIN_PASSWORD), existing.id
    );
    writeBootstrapAdminPassword(BOOTSTRAP_ADMIN_PASSWORD);
    await (dialect === "mariadb" ? ensureDefaultApiKey(db) : ensureDefaultApiKeySqlite(getDatabase()));
    return { adminId: existing.id, rotated: true, passwordFile };
  }

  if (dialect === "mariadb") {
    const insertAdminSql = buildInsertIgnore("mariadb", "users", [
      "username", "password_hash", "name", "role_id", "is_active", "password_change_required",
    ]);
    const result = await db.run(insertAdminSql, "admin", await hashPassword(BOOTSTRAP_ADMIN_PASSWORD), "系统管理员", 1, 1, 0);
    writeBootstrapAdminPassword(BOOTSTRAP_ADMIN_PASSWORD);
    await ensureDefaultApiKey(db);
    return { adminId: result.lastInsertRowid, rotated: true, passwordFile };
  }

  // SQLite 模式
  const sqlite = getDatabase();
  const result = sqlite.prepare(
    `INSERT INTO users (username, password_hash, name, role_id, is_active, password_change_required)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("admin", await hashPassword(BOOTSTRAP_ADMIN_PASSWORD), "系统管理员", 1, 1, 0);
  writeBootstrapAdminPassword(BOOTSTRAP_ADMIN_PASSWORD);
  await ensureDefaultApiKeySqlite(sqlite);
  return { adminId: Number(result.lastInsertRowid), rotated: true, passwordFile };
}

// v1.6.0: 确保至少有一条扫描用的 API Key
// 安全审计（P1）：库内只存 SHA-256 哈希（与管理员签发接口一致），不打印完整明文；
// 明文一次性写入受保护文件（0600，随 data/ 目录一起 gitignore），供运维配置扫描端。
const SCANNER_API_KEY_FILE = "scanner-api-key.txt";

export function getScannerApiKeyPath(): string {
  return path.join(path.dirname(resolveProjectDbPath()), SCANNER_API_KEY_FILE);
}

function writeScannerApiKeyFile(key: string): void {
  const target = getScannerApiKeyPath();
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${SCANNER_API_KEY_FILE}.${process.pid}.${Date.now()}.tmp`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, target);
  } catch {
    rmSync(target, { force: true });
    renameSync(temp, target);
  }
  try { chmodSync(target, 0o600); } catch { /* Windows ACLs may ignore POSIX modes. */ }
  console.warn(`[SECURITY] 默认扫描端密钥已写入受保护文件: ${target}`);
}

function maskKey(key: string): string {
  if (key.length <= 12) return "****";
  return `${key.slice(0, 7)}****${key.slice(-4)}`;
}

async function ensureDefaultApiKey(db: any): Promise<void> {
  const existing = await db.get("SELECT id FROM api_keys WHERE scope = 'scanner' AND is_active = 1 LIMIT 1");
  if (existing) return;
  const key = `sk-${randomBytes(16).toString("hex")}`;
  await db.run("INSERT INTO api_keys (name, api_key, scope) VALUES (?, ?, ?)", "默认扫描端密钥", hashSecret(key), "scanner");
  writeScannerApiKeyFile(key);
  console.log(`[DB] Default scanner API key created (masked): ${maskKey(key)}`);
}

function ensureDefaultApiKeySqlite(db: any): Promise<void> {
  const existing = db.prepare("SELECT id FROM api_keys WHERE scope = 'scanner' AND is_active = 1 LIMIT 1").get();
  if (existing) return Promise.resolve();
  const key = `sk-${randomBytes(16).toString("hex")}`;
  db.prepare("INSERT INTO api_keys (name, api_key, scope) VALUES (?, ?, ?)").run("默认扫描端密钥", hashSecret(key), "scanner");
  writeScannerApiKeyFile(key);
  console.log(`[DB] Default scanner API key created (masked): ${maskKey(key)}`);
  return Promise.resolve();
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * 安全审计（P1）：把历史遗留的明文 api_keys 一次性哈希化，使明文兼容回退不再兜底生效。
 * 幂等：仅处理 64 位十六进制（sha256 hex）以外的旧值；SQLite / MariaDB 双模兼容。
 * 全表扫描后按正则过滤（避免 SQLite GLOB 字符类差异导致的兼容问题）。
 */
export async function migrateLegacyPlaintextApiKeys(db: DbAdapter): Promise<void> {
  try {
    const rows = await db.all<{ id: number; api_key: string }>(
      "SELECT id, api_key FROM api_keys WHERE api_key IS NOT NULL AND api_key != ''"
    );
    let count = 0;
    for (const row of rows) {
      if (!row.api_key || SHA256_HEX_RE.test(row.api_key)) continue;
      await db.run("UPDATE api_keys SET api_key = ? WHERE id = ?", hashSecret(row.api_key), row.id);
      count++;
    }
    if (count > 0) {
      console.log(`[secrets] 已哈希化 ${count} 条历史明文 api_keys`);
    }
  } catch (err) {
    console.warn("[secrets] 历史明文 api_keys 哈希化迁移失败（不影响启动，可稍后重试）:", err);
  }
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
