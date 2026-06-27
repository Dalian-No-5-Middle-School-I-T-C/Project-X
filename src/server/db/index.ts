import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrations";
import { resolveProjectDbPath } from "./paths";
import { seedDefaultData } from "./seeds";
import { detectDialect, getMysqlDb, initMariadbSchema } from "./mysql";
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
  const dialect = detectDialect();

  if (dialect === "mariadb") {
    // MariaDB 模式：schema 在 getMysqlDb() → MariadbAdapter 构造时通过 initMariadbSchema 初始化
    // seed 数据由 schema.mariadb.sql 中的 INSERT IGNORE 处理
    // 确保默认管理员
    console.log("[DB] MariaDB mode: schema seeded via schema.mariadb.sql");
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
    if (existing) return;
    const passwordHash = await hashPassword("admin123");
    await db.run(
      "INSERT IGNORE INTO users (username, password_hash, name, role_id, is_active) VALUES (?, ?, ?, ?, ?)",
      "admin", passwordHash, "系统管理员", 1, 1
    );
    console.log("[DB] Default admin created: username=admin, password=admin123");
    return;
  }

  // SQLite 模式
  const db = getDatabase();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
  if (existing) return;

  const passwordHash = await hashPassword("admin123");
  db.prepare(
    `INSERT INTO users (username, password_hash, name, role_id, is_active)
     VALUES (?, ?, ?, ?, ?)`
  ).run("admin", passwordHash, "系统管理员", 1, 1);
  console.log("[DB] Default admin created: username=admin, password=admin123");
  console.log("[DB] 请登录后立即修改默认密码");
}

export { runMigrations };
export { resolveAnswerCardDataDir, resolveProjectDbPath, resolveScannerDbPath } from "./paths";

// ── 跨方言 DB 适配器 ──────────────────────────────────
export {
  getMysqlDb,
  initMariadbSchema,
  initMariadbSchema as initMysqlSchema,
  detectDialect,
  buildUpsertSQL,
  buildInsertIgnore,
  healthCheck,
  resetAdapter,
} from "./mysql";
export type { DbAdapter } from "./mysql";
