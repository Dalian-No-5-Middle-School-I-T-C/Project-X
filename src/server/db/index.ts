import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.PROJECTX_DB_PATH
  ? path.resolve(process.env.PROJECTX_DB_PATH)
  : path.join(__dirname, "..", "..", "..", "data", "projectx.db");

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
    dbInstance.pragma("synchronous = NORMAL");
    dbInstance.pragma("busy_timeout = 5000");
    console.log(`[DB] Connected to: ${DB_PATH}`);
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
    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = readFileSync(schemaPath, "utf8");
    db.exec(schema);
    console.log("[DB] Schema created successfully");
  }

  // Migrations for existing databases
  const cols = db.prepare("PRAGMA table_info(answer_cards)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "sided")) {
    db.exec("ALTER TABLE answer_cards ADD COLUMN sided TEXT DEFAULT 'double'");
    console.log("[DB] Migration: added sided column to answer_cards");
  }

  const roleCount = db.prepare("SELECT COUNT(*) as cnt FROM roles").get() as { cnt: number };
  if (roleCount.cnt === 0) {
    const insertRole = db.prepare(
      "INSERT OR IGNORE INTO roles (id, name, display_name, permissions) VALUES (?, ?, ?, ?)"
    );
    insertRole.run(1, "admin", "管理员", JSON.stringify(["*"]));
    insertRole.run(2, "teacher", "教师", JSON.stringify([
      "card:read",
      "card:write",
      "exam:read",
      "exam:write",
      "grade:read",
      "grade:write"
    ]));
    insertRole.run(3, "student", "学生", JSON.stringify(["score:read"]));
    console.log("[DB] Default roles inserted");
  }

  const policyCount = db.prepare("SELECT COUNT(*) as cnt FROM data_retention_policies").get() as { cnt: number };
  if (policyCount.cnt === 0) {
    const insertPolicy = db.prepare(
      "INSERT OR IGNORE INTO data_retention_policies (id, name, retain_days, auto_archive, auto_delete) VALUES (?, ?, ?, ?, ?)"
    );
    insertPolicy.run(1, "周测", 30, 1, 0);
    insertPolicy.run(2, "月考", 90, 1, 0);
    insertPolicy.run(3, "期中期末", 0, 1, 0);
    console.log("[DB] Default retention policies inserted");
  }
}

export async function hashPassword(password: string): Promise<string> {
  const bcrypt = await import("bcrypt");
  return bcrypt.default.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const bcrypt = await import("bcrypt");
  return bcrypt.default.compare(password, hash);
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
