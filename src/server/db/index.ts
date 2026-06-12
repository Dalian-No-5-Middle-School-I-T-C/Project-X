import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 数据库文件路径，可通过环境变量覆盖
const DB_PATH = process.env.PROJECTX_DB_PATH
  ? path.resolve(process.env.PROJECTX_DB_PATH)
  : path.join(__dirname, "..", "..", "..", "data", "projectx.db");

let dbInstance: Database.Database | null = null;

/**
 * 获取数据库连接（单例）
 */
export function getDatabase(): Database.Database {
  if (!dbInstance) {
    dbInstance = new Database(DB_PATH);

    // 启用 WAL 模式，提升并发性能
    dbInstance.pragma("journal_mode = WAL");
    // 启用外键约束
    dbInstance.pragma("foreign_keys = ON");
    // 平衡安全与性能
    dbInstance.pragma("synchronous = NORMAL");
    // 设置忙等待超时（毫秒）
    dbInstance.pragma("busy_timeout = 5000");

    console.log(`[DB] Connected to: ${DB_PATH}`);
  }
  return dbInstance;
}

/**
 * 关闭数据库连接
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    console.log("[DB] Connection closed");
  }
}

/**
 * 初始化数据库（建表 + 初始数据）
 */
export function initializeDatabase(): void {
  const db = getDatabase();
  const schemaPath = path.join(__dirname, "schema.sql");

  // 检查是否已有表
  const hasTables = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table'"
  ).get() as { cnt: number };

  if (hasTables.cnt === 0) {
    // 读取并执行建表 SQL
    const schema = readFileSync(schemaPath, "utf8");

    // 按语句分割执行（better-sqlite3 不支持直接执行多语句）
    const statements = schema
      .split(";")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0 && !s.startsWith("--") && !s.startsWith("PRAGMA"));

    // 先执行 PRAGMA
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");

    // 执行建表语句
    for (const stmt of statements) {
      try {
        db.exec(stmt + ";");
      } catch (error) {
        console.error(`[DB] Failed to execute: ${stmt.substring(0, 100)}...`);
        throw error;
      }
    }

    console.log("[DB] Schema created successfully");
  }

  // 确保默认角色存在
  const roleCount = db.prepare("SELECT COUNT(*) as cnt FROM roles").get() as { cnt: number };
  if (roleCount.cnt === 0) {
    const insertRole = db.prepare(
      "INSERT OR IGNORE INTO roles (id, name, display_name, permissions) VALUES (?, ?, ?, ?)"
    );
    insertRole.run(1, "admin", "管理员", JSON.stringify(["*"]));
    insertRole.run(2, "teacher", "教师", JSON.stringify([
      "card:read", "card:write",
      "exam:read", "exam:write",
      "grade:read", "grade:write"
    ]));
    insertRole.run(3, "student", "学生", JSON.stringify(["score:read"]));
    console.log("[DB] Default roles inserted");
  }

  // 确保默认保留策略存在
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

/**
 * 生成 bcrypt 密码哈希
 */
export async function hashPassword(password: string): Promise<string> {
  // 动态导入 bcrypt，避免没有安装时报错
  const bcrypt = await import("bcrypt");
  return bcrypt.default.hash(password, 10);
}

/**
 * 验证密码
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const bcrypt = await import("bcrypt");
  return bcrypt.default.compare(password, hash);
}

/**
 * 生成默认管理员账号（如果不存在）
 * 默认账号：admin / admin123
 */
export async function ensureDefaultAdmin(): Promise<void> {
  const db = getDatabase();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
  if (!existing) {
    const passwordHash = await hashPassword("admin123");
    db.prepare(
      `INSERT INTO users (username, password_hash, name, role_id, is_active)
       VALUES (?, ?, ?, ?, ?)`
    ).run("admin", passwordHash, "系统管理员", 1, 1);
    console.log("[DB] Default admin created: username=admin, password=admin123");
    console.log("[DB] ⚠️  请立即登录并修改默认密码！");
  }
}
