import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrations";
import { resolveProjectDbPath } from "./paths";
import { seedDefaultData } from "./seeds";
import { detectDialect, getMysqlDb, initMariadbSchema, buildInsertIgnore } from "./mysql";
import type { DbAdapter } from "./mysql";

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
<<<<<<< HEAD
  const db = getDatabase();
  const schema = readFileSync(schemaPath(), "utf8");

  // Always run the idempotent base schema so partially initialized deployments
  // recover missing core tables before cleanup jobs and migrations touch them.
  db.exec(schema);
  console.log("[DB] Schema checked successfully");
=======
  const dialect = detectDialect();

  if (dialect === "mariadb") {
    // v1.6.0: MariaDB 增量迁移机制 — 检测并执行缺失的 schema_migrations
    console.log("[DB] MariaDB mode: schema seeded via schema.mariadb.sql");
    // initMariadbSchema() 在 getMysqlDb() 首次调用时自动执行
    // ensureDefaultAdmin() 在外部调用，自动生成 API Key
    return;
  }
>>>>>>> b1ac78210777fb697a37248af724053c81fe7c2b

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

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || hash === "") {
    return false;
  }
  return bcrypt.compare(password, hash);
}

export async function ensureDefaultAdmin(): Promise<void> {
  const dialect = detectDialect();

  if (dialect === "mariadb") {
    const db = getMysqlDb();
    const existing = await db.get("SELECT id FROM users WHERE username = ?", "admin");
    if (existing) {
      await ensureDefaultApiKey(db);
      return;
    }
    const passwordHash = await hashPassword("admin123");
    const insertAdminSql = buildInsertIgnore("mariadb", "users", [
      "username", "password_hash", "name", "role_id", "is_active",
    ]);
    await db.run(insertAdminSql, "admin", passwordHash, "系统管理员", 1, 1);
    console.log("[DB] Default admin created: username=admin, password=admin123");
    await ensureDefaultApiKey(db);
    return;
  }

  // SQLite 模式
  const db = getDatabase();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
  if (existing) {
    await ensureDefaultApiKeySqlite(db);
    return;
  }

  const passwordHash = await hashPassword("admin123");
  db.prepare(
    `INSERT INTO users (username, password_hash, name, role_id, is_active)
     VALUES (?, ?, ?, ?, ?)`
  ).run("admin", passwordHash, "系统管理员", 1, 1);
  console.log("[DB] Default admin created: username=admin, password=admin123");
  console.log("[DB] 请登录后立即修改默认密码");
  await ensureDefaultApiKeySqlite(db);
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
