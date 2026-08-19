import mariadb from "mysql2/promise";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase } from "./index";
import { readDbConfig } from "./config";

// ── 模式检测 ───────────────────────────────────────────
// 优先级：环境变量 > config.yml > 默认 SQLite

// v1.6.0: 统一使用 config.ts 解析 config.yml（消除正则/缩进两套解析不一致）
function readConfigDbMode(): { mode: string; remote?: any } | null {
  const cfg = readDbConfig();
  if (cfg.mode === "remote" && cfg.remote?.host) {
    return {
      mode: "remote",
      remote: {
        host: cfg.remote.host,
        port: cfg.remote.port ?? 443,
        database: cfg.remote.database ?? "projectx",
        user: cfg.remote.user ?? "projectx_app",
        password: cfg.remote.password ?? "",
      }
    };
  }
  return { mode: cfg.mode || "local" };
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
 * 跨方言 INSERT … ON CONFLICT 忽略
 * SQLite: INSERT OR IGNORE, MariaDB: INSERT IGNORE
 */
export function buildInsertIgnore(
  dialect: "sqlite" | "mariadb",
  table: string,
  cols: string[]
): string {
  const placeholders = cols.map(() => "?").join(", ");
  if (dialect === "sqlite") {
    return `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
  }
  return `INSERT IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
}

// ── SQLite Adapter ─────────────────────────────────────
// 内部用 better-sqlite3（同步），对外暴露 async 接口

class SqliteAdapter implements DbAdapter {
  readonly dialect = "sqlite" as const;
  private db: any; // better-sqlite3 Database, 懒加载避免循环引用
  /** 慢查询阈值 ms（建议 12：先测量再优化，>50ms 记日志定位） */
  private slowThresholdMs = 50;

  constructor() {
    this.db = getDatabase();
  }

  /** 统一耗时日志：只报 > threshold 的异常语句，正常路径零开销 */
  private logTiming(sql: string, elapsedMs: number): void {
    if (elapsedMs <= this.slowThresholdMs) return;
    const truncated = sql.replace(/\s+/g, " ").trim().slice(0, 200);
    console.warn(`[DB] slow query ${elapsedMs}ms: ${truncated}`);
  }

  async get<T>(sql: string, ...params: any[]): Promise<T | null> {
    const start = Date.now();
    const row = this.db.prepare(sql).get(...params) as T | undefined;
    this.logTiming(sql, Date.now() - start);
    return row ?? null;
  }
  async all<T>(sql: string, ...params: any[]): Promise<T[]> {
    const start = Date.now();
    const rows = this.db.prepare(sql).all(...params) as T[];
    this.logTiming(sql, Date.now() - start);
    return rows;
  }
  async run(sql: string, ...params: any[]): Promise<{ lastInsertRowid: number; changes: number }> {
    const start = Date.now();
    const r = this.db.prepare(sql).run(...params);
    this.logTiming(sql, Date.now() - start);
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
  }
  async exec(sql: string): Promise<void> {
    const start = Date.now();
    this.db.exec(sql);
    this.logTiming(sql, Date.now() - start);
  }
  /**
   * 事务约束（建议 12）：
   * 禁止在 `fn` 内做任何真正的异步 I/O（如 await fetch / 外部服务）。
   * better-sqlite3 是单连接同步驱动，`await fn(this)` 会在 BEGIN/COMMIT 之间让出事件循环；
   * 若并发事务穿插或外部 await 穿插，会破坏本事务的原子性/隔离性。
   * 需要长任务的写请先收集 DB 只读数据，再一次性进事务提交。
   */
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
    // v1.6.0: 跑增量迁移（处理 v1.7+ 新增的列/表）
    await runMariadbMigrations(conn);
  } finally {
    conn.release();
  }
}

// 保持旧名称兼容
export { initMariadbSchema as initMysqlSchema };

/**
 * v1.6.0 — MariaDB 增量迁移
 * 对比 schema_migrations 表与 MIGRATION_VERSIONS，执行缺失的 ALTER TABLE
 * 确保生产库不会因新增列/表而需要整库重建
 */
export async function runMariadbMigrations(conn: mariadb.Connection | mariadb.Pool): Promise<void> {
  // 确保 schema_migrations 表存在
  await conn.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INT PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const [rows] = await conn.execute("SELECT version FROM schema_migrations") as [RowDataPacket[], any];
  const applied = new Set(rows.map((r: any) => r.version));

  // 迁移定义：version → { name, sql }
  // 只包含 ALTER TABLE 和 CREATE TABLE（不含完整 schema）
  // 新增迁移在此追加
  const mariadbMigrations: Array<{ version: number; name: string; sqls: string[] }> = [
    {
      version: 11,
      name: "api-keys",
      sqls: [
        `CREATE TABLE IF NOT EXISTS api_keys (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          api_key VARCHAR(64) NOT NULL UNIQUE,
          scope VARCHAR(20) NOT NULL DEFAULT 'scanner',
          is_active TINYINT DEFAULT 1,
          created_by INT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      ]
    },
    {
      version: 12,
      name: "system-settings",
      sqls: [
        `CREATE TABLE IF NOT EXISTS system_settings (
          \`key\` VARCHAR(100) PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `INSERT IGNORE INTO system_settings (\`key\`, value) VALUES ('ladder_enabled', '1')`,
      ]
    },
    // v1.7+ 在此追加新版本...
    {
      version: 15,
      name: "exam-groups-columns",
      sqls: [
        `ALTER TABLE exam_groups ADD COLUMN description TEXT`,
        `ALTER TABLE exam_groups ADD COLUMN source VARCHAR(50) DEFAULT 'manual'`,
        `ALTER TABLE exam_groups ADD COLUMN start_date VARCHAR(20)`,
        `ALTER TABLE exam_groups ADD COLUMN end_date VARCHAR(20)`,
        `ALTER TABLE exam_groups ADD COLUMN grade_id INT`,
        `ALTER TABLE exam_groups ADD COLUMN tag VARCHAR(50)`,
        `ALTER TABLE exam_groups ADD COLUMN status VARCHAR(20) DEFAULT 'active'`,
        `ALTER TABLE exam_groups ADD COLUMN is_official TINYINT DEFAULT 0`,
        `ALTER TABLE exam_groups ADD COLUMN total_score_mode VARCHAR(20) DEFAULT 'raw'`,
        `ALTER TABLE exam_groups ADD COLUMN only_full_participants TINYINT DEFAULT 0`,
      ]
    },
    {
      version: 16,
      name: "teacher-permissions",
      sqls: [
        `CREATE TABLE IF NOT EXISTS teacher_permissions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          teacher_id INT NOT NULL,
          grade_id INT,
          can_view_scores TINYINT DEFAULT 1,
          can_view_charts TINYINT DEFAULT 1,
          can_view_students TINYINT DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
          UNIQUE KEY uk_teacher_grade (teacher_id, grade_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE INDEX IF NOT EXISTS idx_tp_teacher ON teacher_permissions(teacher_id)`,
      ]
    },
    {
      version: 17,
      name: "original-paper-and-knowledge-points",
      sqls: [
        `ALTER TABLE answer_cards ADD COLUMN has_original_paper TINYINT DEFAULT 0`,
        `ALTER TABLE answer_cards ADD COLUMN original_paper_filename VARCHAR(255)`,
        `ALTER TABLE answer_cards ADD COLUMN original_paper_path VARCHAR(500)`,
        `ALTER TABLE answer_cards ADD COLUMN question_range TEXT`,
        `ALTER TABLE answer_cards ADD COLUMN extra_notes TEXT`,
        `ALTER TABLE answer_cards ADD COLUMN knowledge_points_text TEXT`,
        `ALTER TABLE users ADD COLUMN require_original_paper TINYINT DEFAULT 1`,
        `ALTER TABLE users ADD COLUMN highlight_missing_paper TINYINT DEFAULT 1`,
        `CREATE TABLE IF NOT EXISTS knowledge_points (
          id INT AUTO_INCREMENT PRIMARY KEY,
          card_id VARCHAR(20) NOT NULL,
          question_number INT NOT NULL,
          point_text VARCHAR(50) NOT NULL,
          category VARCHAR(50),
          sort_order INT DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_card_question_point (card_id, question_number, point_text),
          FOREIGN KEY (card_id) REFERENCES answer_cards(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE INDEX IF NOT EXISTS idx_kp_card ON knowledge_points(card_id)`,
        `CREATE INDEX IF NOT EXISTS idx_kp_card_question ON knowledge_points(card_id, question_number)`,
      ]
    },
    {
      version: 18,
      name: "system-ai-provider",
      sqls: [
        `ALTER TABLE ai_providers ADD COLUMN is_system TINYINT DEFAULT 0`,
      ]
    },
    {
      version: 19,
      name: "online-review-v2",
      sqls: [
        // 1. review_assignments
        `CREATE TABLE IF NOT EXISTS review_assignments (
          id                   INT AUTO_INCREMENT PRIMARY KEY,
          exam_id              INT NOT NULL,
          block_id             VARCHAR(36) NOT NULL,
          teacher_id           INT NOT NULL,
          student_count        INT DEFAULT 0,
          assigned_student_ids LONGTEXT,
          created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_ra_exam_block_teacher (exam_id, block_id, teacher_id),
          FOREIGN KEY (exam_id)    REFERENCES exams(id) ON DELETE CASCADE,
          FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE INDEX IF NOT EXISTS idx_ra_exam_block ON review_assignments(exam_id, block_id)`,
        `CREATE INDEX IF NOT EXISTS idx_ra_teacher ON review_assignments(teacher_id)`,

        // 2. review_sessions
        `CREATE TABLE IF NOT EXISTS review_sessions (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          teacher_id    INT NOT NULL,
          exam_id       INT NOT NULL,
          block_id      VARCHAR(36) NOT NULL,
          current_index INT DEFAULT 0,
          position_json LONGTEXT,
          draft_scores  LONGTEXT,
          updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_rs_teacher_exam_block (teacher_id, exam_id, block_id),
          FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (exam_id)    REFERENCES exams(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE INDEX IF NOT EXISTS idx_rs_teacher ON review_sessions(teacher_id)`,

        // 3. review_annotations
        `CREATE TABLE IF NOT EXISTS review_annotations (
          id          VARCHAR(64) PRIMARY KEY,
          crop_id     VARCHAR(64) NOT NULL,
          reviewer_id INT NOT NULL,
          type        VARCHAR(16) NOT NULL,
          data_json   LONGTEXT NOT NULL,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (crop_id)     REFERENCES answer_block_crops(id) ON DELETE CASCADE,
          FOREIGN KEY (reviewer_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE INDEX IF NOT EXISTS idx_rannot_crop ON review_annotations(crop_id)`,

        // 4. block_grading_config
        `CREATE TABLE IF NOT EXISTS block_grading_config (
          id                 INT AUTO_INCREMENT PRIMARY KEY,
          exam_id            INT NOT NULL,
          block_id           VARCHAR(36) NOT NULL,
          dispute_threshold  DOUBLE DEFAULT 2,
          rounding           VARCHAR(16) DEFAULT 'ceil',
          arbitrator_id      INT,
          review_mode        INT DEFAULT 1,
          created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_bgc_exam_block (exam_id, block_id),
          FOREIGN KEY (exam_id)       REFERENCES exams(id) ON DELETE CASCADE,
          FOREIGN KEY (arbitrator_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE INDEX IF NOT EXISTS idx_bgc_exam ON block_grading_config(exam_id)`,

        // 5. answer_block_crops 加列
        `ALTER TABLE answer_block_crops ADD COLUMN reviewer_id     INT`,
        `ALTER TABLE answer_block_crops ADD COLUMN reviewed_at     DATETIME`,
        `ALTER TABLE answer_block_crops ADD COLUMN review_round    INT DEFAULT 0`,
        `ALTER TABLE answer_block_crops ADD COLUMN final_score     DOUBLE`,
        `ALTER TABLE answer_block_crops ADD COLUMN final_score_by  INT`,
        `ALTER TABLE answer_block_crops ADD COLUMN score_breakdown LONGTEXT`,
        `ALTER TABLE answer_block_crops ADD FOREIGN KEY fk_abc_reviewer  (reviewer_id)    REFERENCES users(id)`,
        `ALTER TABLE answer_block_crops ADD FOREIGN KEY fk_abc_final_by  (final_score_by) REFERENCES users(id)`,

        // 6. users 加列
        `ALTER TABLE users ADD COLUMN show_tab_bar TINYINT DEFAULT 0`,

        // 7. exams 加列
        `ALTER TABLE exams ADD COLUMN review_mode    INT DEFAULT 1`,
        `ALTER TABLE exams ADD COLUMN review_enabled TINYINT DEFAULT 0`,
      ]
    },
    {
      version: 20,
      name: "subjective-grid-json",
      sqls: [
        `ALTER TABLE subjective_questions ADD COLUMN line_grid_json TEXT`,
        `ALTER TABLE subjective_questions ADD COLUMN essay_grid_json TEXT`,
      ]
    },
    {
      version: 21,
      name: "subjective-score-grid-json",
      sqls: [
        `ALTER TABLE subjective_questions ADD COLUMN score_grid_json TEXT`,
      ]
    },
    {
      version: 22,
      name: "analysis-performance-indexes-parity",
      sqls: [
        `CREATE INDEX IF NOT EXISTS idx_student_scores_exam_total ON student_scores(exam_id, total_score)`,
        `CREATE INDEX IF NOT EXISTS idx_student_scores_exam_assigned ON student_scores(exam_id, assigned_score)`,
        `CREATE INDEX IF NOT EXISTS idx_student_scores_exam_student ON student_scores(exam_id, student_id)`,
        `CREATE INDEX IF NOT EXISTS idx_question_scores_exam_type ON question_scores(exam_id, score_type)`,
        `CREATE INDEX IF NOT EXISTS idx_exams_grade_class ON exams(grade_id, class_id)`,
      ]
    },
    {
      version: 23,
      name: "security-bootstrap-and-grading-status",
      sqls: [
        `ALTER TABLE users ADD COLUMN password_change_required TINYINT DEFAULT 0`,
        `ALTER TABLE scan_batches ADD COLUMN success_count INT DEFAULT 0`,
        `ALTER TABLE scan_batches ADD COLUMN failure_count INT DEFAULT 0`,
        `ALTER TABLE scan_batches ADD COLUMN error_summary LONGTEXT`,
      ]
    },
    {
      version: 24,
      name: "online-review-grading-enhancements-1.9.4",
      sqls: [
        `ALTER TABLE block_grading_config ADD COLUMN has_half_point TINYINT DEFAULT 0`,
        `ALTER TABLE block_grading_config ADD COLUMN auto_reassign_no_arb TINYINT DEFAULT 1`,
        `ALTER TABLE block_grading_config ADD COLUMN workload_balance_threshold INT DEFAULT 4`,
        `ALTER TABLE review_assignments ADD COLUMN auto_assigned TINYINT DEFAULT 0`,
        `INSERT IGNORE INTO system_settings (\`key\`, value) VALUES
          ('allow_half_point', '1'),
          ('default_dispute_threshold', '2'),
          ('default_rounding', 'ceil'),
          ('auto_reassign_policy', '1'),
          ('workload_balance_threshold', '4')`,
      ]
    },
    {
      version: 25,
      name: "backfill-security-bootstrap-columns",
      sqls: [
        `ALTER TABLE users ADD COLUMN password_change_required TINYINT DEFAULT 0`,
        `ALTER TABLE scan_batches ADD COLUMN success_count INT DEFAULT 0`,
        `ALTER TABLE scan_batches ADD COLUMN failure_count INT DEFAULT 0`,
        `ALTER TABLE scan_batches ADD COLUMN error_summary LONGTEXT`,
      ]
    },
    {
      version: 26,
      name: "global-original-paper-and-cleanup-review-defaults",
      sqls: [
        `INSERT IGNORE INTO system_settings (\`key\`, value) VALUES ('require_original_paper', '1'), ('highlight_missing_paper', '1')`,
        `DELETE FROM system_settings WHERE \`key\` IN ('allow_half_point', 'default_dispute_threshold', 'default_rounding', 'auto_reassign_policy', 'workload_balance_threshold')`,
      ]
    },
    {
      version: 27,
      name: "block-grading-scoring-mode",
      sqls: [
        `ALTER TABLE block_grading_config ADD COLUMN scoring_mode VARCHAR(16) NOT NULL DEFAULT 'block_total'`,
        `ALTER TABLE block_grading_config ADD COLUMN score_distribution VARCHAR(16) NOT NULL DEFAULT 'proportional'`,
      ]
    },
    {
      version: 28,
      name: "demo-data-source-flag",
      sqls: [
        `ALTER TABLE users ADD COLUMN is_demo TINYINT NOT NULL DEFAULT 0`,
        `ALTER TABLE answer_cards ADD COLUMN is_demo TINYINT NOT NULL DEFAULT 0`,
        `ALTER TABLE classes ADD COLUMN is_demo TINYINT NOT NULL DEFAULT 0`,
        `ALTER TABLE grades ADD COLUMN is_demo TINYINT NOT NULL DEFAULT 0`,
      ]
    },
    {
      version: 29,
      name: "selected-options-and-analysis-thresholds",
      sqls: [
        `ALTER TABLE question_scores ADD COLUMN selected_options TEXT`,
        `INSERT IGNORE INTO system_settings (\`key\`, value) VALUES
          ('analysis_pass_rate', '0.6'),
          ('analysis_excellent_rate', '0.9'),
          ('analysis_segment_size', '10'),
          ('analysis_error_tiers', '70,50,30')`,
      ]
    },
    {
      version: 30,
      name: "subjective-question-annotation",
      sqls: [
        `ALTER TABLE subjective_questions ADD COLUMN annotation TEXT`,
      ]
    },
    {
      version: 31,
      name: "exam-group-arts-science-track",
      sqls: [
        `ALTER TABLE users ADD COLUMN track TEXT`,
        `ALTER TABLE exam_group_members ADD COLUMN track_type VARCHAR(20) NOT NULL DEFAULT 'common'`,
      ]
    },
    {
      version: 32,
      name: "online-review-paper-pool",
      sqls: [
        `ALTER TABLE answer_block_crops ADD COLUMN claimed_by INT`,
        `ALTER TABLE answer_block_crops ADD COLUMN claimed_at DATETIME`,
        `ALTER TABLE answer_block_crops ADD COLUMN claim_count INT NOT NULL DEFAULT 0`,
        `CREATE INDEX idx_answer_block_crops_pool ON answer_block_crops(exam_id, block_id, status, claimed_by)`,
      ]
    },
    {
      version: 33,
      name: "user-theme-skin",
      sqls: [
        `ALTER TABLE users ADD COLUMN theme_skin VARCHAR(32) DEFAULT 'flat'`,
      ]
    },
    {
      version: 34,
      name: "exam-mode-dual-permission",
      sqls: [
        `ALTER TABLE exams ADD COLUMN exam_mode VARCHAR(20) NOT NULL DEFAULT 'formal'`,
      ]
    },
    {
      version: 35,
      name: "exam-closed-at",
      // 历史 closed 行用 updated_at 回填为近似出分时间（best-effort）
      sqls: [
        `ALTER TABLE exams ADD COLUMN closed_at DATETIME`,
        `UPDATE exams SET closed_at = updated_at WHERE status = 'closed' AND closed_at IS NULL`,
      ]
    },
    {
      version: 36,
      name: "review-round-fresh-crops-zero",
      sqls: [
        `UPDATE answer_block_crops SET review_round = 0 WHERE score_breakdown IS NULL OR score_breakdown = '' OR score_breakdown = '[]'`,
      ]
    },
    {
      version: 37,
      name: "question-scores-exam-question-type-index",
      sqls: [
        `CREATE INDEX IF NOT EXISTS idx_question_scores_exam_question_type ON question_scores(exam_id, question_number, score_type)`,
      ]
    },
    {
      version: 38,
      name: "ai-analysis-jobs",
      sqls: [
        `CREATE TABLE IF NOT EXISTS ai_analysis_jobs (
          id         INT AUTO_INCREMENT PRIMARY KEY,
          exam_id    INT,
          group_id   INT,
          class_id   INT,
          status     VARCHAR(16) NOT NULL DEFAULT 'queued',
          result     LONGTEXT,
          error      TEXT,
          model      VARCHAR(100),
          created_by INT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_ai_jobs_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      ]
    },
    {
      version: 39,
      name: "admin-console-observability-and-teacher-permission-dims",
      sqls: [
        // users：主题偏好拆分（ui_style=clarity/paper_edge；color_scheme=light/dark）
        `ALTER TABLE users ADD COLUMN ui_style VARCHAR(16) DEFAULT 'paper_edge'`,
        `ALTER TABLE users ADD COLUMN color_scheme VARCHAR(8) DEFAULT 'light'`,
        `UPDATE users SET ui_style = 'paper_edge' WHERE ui_style IS NULL`,
        `UPDATE users SET color_scheme = 'light' WHERE color_scheme IS NULL`,
        // teacher_permissions：科目/班级/题块/操作维度（NULL=该维度不限）
        `ALTER TABLE teacher_permissions ADD COLUMN subject VARCHAR(50)`,
        `ALTER TABLE teacher_permissions ADD COLUMN class_id INT`,
        `ALTER TABLE teacher_permissions ADD COLUMN block_id VARCHAR(64)`,
        `ALTER TABLE teacher_permissions ADD COLUMN can_grade TINYINT DEFAULT 1`,
        `ALTER TABLE teacher_permissions ADD COLUMN can_assign TINYINT DEFAULT 1`,
        // 主题切换审计
        `CREATE TABLE IF NOT EXISTS theme_change_events (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          user_id     INT,
          from_style  VARCHAR(32),
          to_style    VARCHAR(32),
          from_scheme VARCHAR(8),
          to_scheme   VARCHAR(8),
          changed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE INDEX IF NOT EXISTS idx_tce_user ON theme_change_events(user_id)`,
        // AI 调用观测：逻辑任务层
        `CREATE TABLE IF NOT EXISTS ai_analysis_runs (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          user_id     INT,
          feature     VARCHAR(50) NOT NULL,
          model       VARCHAR(50),
          stage       VARCHAR(30),
          success     TINYINT DEFAULT 1,
          latency_ms  INT,
          tokens_in   INT,
          tokens_out  INT,
          error_code  VARCHAR(30),
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE INDEX IF NOT EXISTS idx_aar_feature ON ai_analysis_runs(feature)`,
        `CREATE INDEX IF NOT EXISTS idx_aar_created ON ai_analysis_runs(created_at)`,
        // AI 调用观测：实际模型调用层
        `CREATE TABLE IF NOT EXISTS ai_provider_calls (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          run_id      INT,
          provider    VARCHAR(30),
          model       VARCHAR(50),
          stage       VARCHAR(30),
          success     TINYINT DEFAULT 1,
          latency_ms  INT,
          tokens      INT,
          error_code  VARCHAR(30),
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (run_id) REFERENCES ai_analysis_runs(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE INDEX IF NOT EXISTS idx_apc_run ON ai_provider_calls(run_id)`,
        // 实体生命周期事件：历史累计统计
        `CREATE TABLE IF NOT EXISTS entity_lifecycle_events (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          entity_type VARCHAR(30) NOT NULL,
          entity_id   VARCHAR(64) NOT NULL,
          action      VARCHAR(20) NOT NULL,
          actor_id    INT,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      ]
    },
  ];

  for (const m of mariadbMigrations) {
    if (applied.has(m.version)) continue;
    for (const sql of m.sqls) {
      try { await conn.execute(sql); }
      catch (err: any) {
        // 忽略已存在的列/表
        if (err.code === "ER_DUP_FIELDNAME" || err.code === "ER_DUP_KEYNAME"
          || err.message?.includes("already exists")) continue;
        throw err;
      }
    }
    await conn.execute("INSERT INTO schema_migrations (version, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)", [m.version, m.name]);
    console.log(`[MariaDB] Migration ${m.version}: ${m.name}`);
  }
}
export { getMariadbConfig };
