import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrations";
import { resolveProjectDbPath } from "./paths";
import { seedDefaultData } from "./seeds";

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
  const db = getDatabase();
  const hasTables = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table'").get() as { cnt: number };

  if (hasTables.cnt === 0) {
    const schema = readFileSync(schemaPath(), "utf8");
    db.exec(schema);
    console.log("[DB] Schema created successfully");
  }

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
  const db = getDatabase();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
  if (existing) {
    return;
  }

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

// ── MySQL 异步适配器（供逐步迁移使用）──────────────────
export { getMysqlDb, initMysqlSchema } from "./mysql";
export type { DbAdapter } from "./mysql";
