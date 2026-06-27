import mysql from "mysql2/promise";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";

// ── 模式检测 ───────────────────────────────────────────
// 设置了 PROJECTX_MYSQL_HOST 则走 MySQL，否则走 SQLite
const USE_MYSQL = !!(process.env.PROJECTX_MYSQL_HOST);

// ── 统一异步接口 ───────────────────────────────────────
// 所有方法返回 Promise，适配 Express async handler

export interface DbAdapter {
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

// ── SQLite Adapter ─────────────────────────────────────
// 内部用 better-sqlite3（同步），对外暴露 async 接口

class SqliteAdapter implements DbAdapter {
  private db: any; // better-sqlite3 Database, 懒加载避免循环引用

  constructor() {
    const { getDatabase } = require("./index"); // 延迟引用，避免循环
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
    // SQLite sync 事务 + 异步回调
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

// ── MySQL Adapter ──────────────────────────────────────

const mysqlPoolConfig = {
  host: process.env.PROJECTX_MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.PROJECTX_MYSQL_PORT) || 3306,
  user: process.env.PROJECTX_MYSQL_USER || "projectx",
  password: process.env.PROJECTX_MYSQL_PASSWORD || "projectx",
  database: process.env.PROJECTX_MYSQL_DATABASE || "projectx",
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  charset: "utf8mb4"
};

let mysqlPool: Pool | null = null;

class MysqlAdapter implements DbAdapter {
  private executor: Pool | PoolConnection;

  constructor(source?: PoolConnection) {
    if (source) {
      this.executor = source;
    } else {
      if (!mysqlPool) {
        mysqlPool = mysql.createPool(mysqlPoolConfig);
        console.log(`[MySQL] Pool: ${mysqlPoolConfig.host}:${mysqlPoolConfig.port}`);
      }
      this.executor = mysqlPool;
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
    const txAdapter = new MysqlAdapter(conn);
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
    if (USE_MYSQL) {
      adapter = new MysqlAdapter();
      console.log("[DB] Mode: MySQL");
    } else {
      adapter = new SqliteAdapter();
      console.log("[DB] Mode: SQLite (via AsyncAdapter)");
    }
  }
  return adapter;
}

// ── MySQL Schema 初始化 ────────────────────────────────
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function initMysqlSchema(): Promise<void> {
  if (!USE_MYSQL) return;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(path.join(__dirname, "schema.mysql.sql"), "utf8");
  const pool = mysqlPool!;
  const conn = await pool.getConnection();
  try {
    const statements = schema
      .split(";")
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith("--") && !s.startsWith("USE ") && !s.startsWith("CREATE DATABASE"));
    for (const stmt of statements) {
      try { await conn.execute(stmt); }
      catch (err: any) {
        if (!err.message?.includes("already exists")) throw err;
      }
    }
    console.log("[MySQL] Schema initialized");
  } finally {
    conn.release();
  }
}
