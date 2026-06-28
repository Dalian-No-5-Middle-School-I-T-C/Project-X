var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/server/db/migrations.ts
function hasTable(db3, tableName) {
  const row = db3.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  ).get(tableName);
  return Boolean(row);
}
function tableColumns(db3, tableName) {
  if (!hasTable(db3, tableName)) return [];
  return db3.prepare(`PRAGMA table_info(${tableName})`).all();
}
function hasColumn(db3, tableName, columnName) {
  return tableColumns(db3, tableName).some((column) => column.name === columnName);
}
function addColumnIfMissing(db3, tableName, columnName, definition) {
  if (!hasColumn(db3, tableName, columnName)) {
    db3.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}
function createObjectiveQuestionsIfMissing(db3) {
  if (hasTable(db3, "objective_questions")) return;
  db3.exec(`
    CREATE TABLE objective_questions (
      block_id        TEXT NOT NULL REFERENCES objective_blocks(id) ON DELETE CASCADE,
      question_number INTEGER NOT NULL,
      sort_order      INTEGER DEFAULT 0,
      mode            TEXT NOT NULL,
      option_count    INTEGER NOT NULL,
      score           REAL NOT NULL,
      option_layout   TEXT,
      scoring_rule_json TEXT,
      PRIMARY KEY (block_id, question_number)
    );
    CREATE INDEX IF NOT EXISTS idx_objective_questions_block ON objective_questions(block_id);
  `);
}
function makeExamCardIdNullable(db3) {
  const examColumns = tableColumns(db3, "exams");
  const examCardCol = examColumns.find((column) => column.name === "card_id");
  if (!examCardCol || examCardCol.notnull !== 1) return;
  const hasAssignedFormula = examColumns.some((column) => column.name === "assigned_formula");
  const assignedFormulaSelect = hasAssignedFormula ? "assigned_formula" : "NULL";
  db3.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE exams_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      card_id       TEXT REFERENCES answer_cards(id),
      grade_id      INTEGER REFERENCES grades(id),
      class_id      INTEGER REFERENCES classes(id),
      subject       TEXT,
      start_time    DATETIME,
      end_time      DATETIME,
      status        TEXT DEFAULT 'draft',
      assigned_formula TEXT,
      retention_policy_id INTEGER REFERENCES data_retention_policies(id),
      created_by    INTEGER REFERENCES users(id),
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO exams_new (
      id, name, card_id, grade_id, class_id, subject, start_time, end_time,
      status, assigned_formula, retention_policy_id, created_by, created_at, updated_at
    )
    SELECT
      id, name, card_id, grade_id, class_id, subject, start_time, end_time,
      status, ${assignedFormulaSelect},
      retention_policy_id, created_by, created_at, updated_at
    FROM exams;
    DROP TABLE exams;
    ALTER TABLE exams_new RENAME TO exams;
    CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);
    CREATE INDEX IF NOT EXISTS idx_exams_grade ON exams(grade_id);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
function createTeacherClassesIfMissing(db3) {
  if (hasTable(db3, "teacher_classes")) return;
  db3.exec(`
    CREATE TABLE teacher_classes (
      teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      subject     TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (teacher_id, class_id)
    );
    CREATE INDEX IF NOT EXISTS idx_teacher_classes_teacher ON teacher_classes(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_teacher_classes_class ON teacher_classes(class_id);
  `);
}
function createExportTemplatesIfMissing(db3) {
  if (hasTable(db3, "export_templates")) return;
  db3.exec(`
    CREATE TABLE export_templates (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot          INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 4),
      name          TEXT NOT NULL DEFAULT '\u672A\u547D\u540D',
      columns       TEXT NOT NULL,
      side_table_n  INTEGER DEFAULT 0,
      gap_cols      INTEGER DEFAULT 3,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_export_templates_user ON export_templates(user_id, slot);
  `);
}
function createAiProvidersIfMissing(db3) {
  if (hasTable(db3, "ai_providers")) return;
  db3.exec(`
    CREATE TABLE ai_providers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      provider_type   TEXT NOT NULL,
      base_url        TEXT NOT NULL,
      api_key         TEXT NOT NULL,
      models          TEXT,
      is_active       INTEGER DEFAULT 1,
      sort_order      INTEGER DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id, provider_type);
  `);
}
function createAnswerOverridesIfMissing(db3) {
  if (hasTable(db3, "answer_overrides")) return;
  db3.exec(`
    CREATE TABLE answer_overrides (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      card_id         TEXT NOT NULL,
      question_number INTEGER,
      question_id     TEXT,
      block_id        TEXT,
      score_type      TEXT NOT NULL,
      override_type   TEXT NOT NULL,
      old_value       TEXT,
      new_value       TEXT,
      created_by      INTEGER REFERENCES users(id),
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_answer_overrides_exam ON answer_overrides(exam_id);
  `);
}
function runMigrations(db3) {
  db3.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const applied = new Set(
    db3.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    migration.up(db3);
    db3.prepare("INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name);
    console.log(`[DB] Migration ${migration.version}: ${migration.name}`);
  }
}
var MIGRATIONS;
var init_migrations = __esm({
  "src/server/db/migrations.ts"() {
    "use strict";
    MIGRATIONS = [
      {
        version: 1,
        name: "answer-card-metadata",
        up(db3) {
          addColumnIfMissing(db3, "answer_cards", "sided", "TEXT DEFAULT 'double'");
          addColumnIfMissing(db3, "answer_cards", "subject", "TEXT");
          addColumnIfMissing(db3, "answer_cards", "subject_label", "TEXT");
          addColumnIfMissing(db3, "answer_cards", "exam_date", "TEXT");
        }
      },
      {
        version: 2,
        name: "nullable-exam-card",
        up: makeExamCardIdNullable
      },
      {
        version: 3,
        name: "card-question-detail",
        up(db3) {
          createObjectiveQuestionsIfMissing(db3);
          addColumnIfMissing(db3, "objective_blocks", "option_layout", "TEXT DEFAULT 'horizontal'");
          addColumnIfMissing(db3, "objective_questions", "option_layout", "TEXT");
          addColumnIfMissing(db3, "subjective_blocks", "block_kind", "TEXT DEFAULT 'answer'");
          addColumnIfMissing(db3, "subjective_questions", "blanks_label_style", "TEXT");
          addColumnIfMissing(db3, "subjective_questions", "blanks_items_json", "TEXT");
        }
      },
      {
        version: 4,
        name: "teacher-classes",
        up(db3) {
          addColumnIfMissing(db3, "users", "teacher_role", "TEXT DEFAULT NULL");
          addColumnIfMissing(db3, "users", "subject", "TEXT");
          addColumnIfMissing(db3, "users", "initial_password", "TEXT");
          createTeacherClassesIfMissing(db3);
        }
      },
      {
        version: 5,
        name: "assigned-score-and-ai",
        up(db3) {
          addColumnIfMissing(db3, "student_scores", "assigned_score", "REAL");
          addColumnIfMissing(db3, "exams", "assigned_formula", "TEXT");
          addColumnIfMissing(db3, "users", "score_display_mode", "TEXT DEFAULT 'zscore'");
          addColumnIfMissing(db3, "users", "review_confidence_threshold", "REAL DEFAULT 0.12");
          addColumnIfMissing(db3, "users", "ai_api_key", "TEXT");
          createExportTemplatesIfMissing(db3);
          createAiProvidersIfMissing(db3);
        }
      },
      {
        version: 6,
        name: "score-editing-audit",
        up(db3) {
          addColumnIfMissing(db3, "student_scores", "manually_modified", "INTEGER DEFAULT 0");
          addColumnIfMissing(db3, "student_scores", "modified_by", "INTEGER REFERENCES users(id)");
          addColumnIfMissing(db3, "student_scores", "modified_at", "DATETIME");
          addColumnIfMissing(db3, "question_scores", "manually_modified", "INTEGER DEFAULT 0");
          addColumnIfMissing(db3, "question_scores", "modified_by", "INTEGER REFERENCES users(id)");
          addColumnIfMissing(db3, "question_scores", "modified_at", "DATETIME");
          createAnswerOverridesIfMissing(db3);
        }
      },
      {
        version: 7,
        name: "background-opacity",
        up(db3) {
          if (hasColumn(db3, "users", "background_opacity")) return;
          db3.exec("ALTER TABLE users ADD COLUMN background_opacity REAL DEFAULT 0");
          if (hasColumn(db3, "users", "show_background")) {
            db3.exec("UPDATE users SET background_opacity = CASE WHEN show_background = 1 THEN 0.12 ELSE 0 END");
          }
        }
      },
      {
        version: 8,
        name: "exam-groups",
        up(db3) {
          if (!hasTable(db3, "exam_groups")) {
            db3.exec(`
          CREATE TABLE exam_groups (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL,
            description     TEXT,
            source          TEXT DEFAULT 'manual',
            start_date      TEXT,
            end_date        TEXT,
            grade_id        INTEGER REFERENCES grades(id),
            tag             TEXT,
            status          TEXT DEFAULT 'active',
            is_official     INTEGER DEFAULT 0,
            total_score_mode TEXT DEFAULT 'raw',
            only_full_participants INTEGER DEFAULT 0,
            created_by      INTEGER REFERENCES users(id),
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);
          } else {
            addColumnIfMissing(db3, "exam_groups", "description", "TEXT");
            addColumnIfMissing(db3, "exam_groups", "source", "TEXT DEFAULT 'manual'");
            addColumnIfMissing(db3, "exam_groups", "start_date", "TEXT");
            addColumnIfMissing(db3, "exam_groups", "end_date", "TEXT");
            addColumnIfMissing(db3, "exam_groups", "grade_id", "INTEGER REFERENCES grades(id)");
            addColumnIfMissing(db3, "exam_groups", "tag", "TEXT");
            addColumnIfMissing(db3, "exam_groups", "status", "TEXT DEFAULT 'active'");
            addColumnIfMissing(db3, "exam_groups", "is_official", "INTEGER DEFAULT 0");
            addColumnIfMissing(db3, "exam_groups", "total_score_mode", "TEXT DEFAULT 'raw'");
            addColumnIfMissing(db3, "exam_groups", "only_full_participants", "INTEGER DEFAULT 0");
          }
          if (!hasTable(db3, "exam_group_members")) {
            db3.exec(`
          CREATE TABLE exam_group_members (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id        INTEGER NOT NULL REFERENCES exam_groups(id) ON DELETE CASCADE,
            exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
            sort_order      INTEGER DEFAULT 0,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, exam_id)
          );
          CREATE INDEX IF NOT EXISTS idx_exam_group_members_group ON exam_group_members(group_id);
          CREATE INDEX IF NOT EXISTS idx_exam_group_members_exam ON exam_group_members(exam_id);
        `);
          }
        }
      },
      {
        version: 9,
        name: "original-paper-and-knowledge-points",
        up(db3) {
          addColumnIfMissing(db3, "answer_cards", "has_original_paper", "INTEGER DEFAULT 0");
          addColumnIfMissing(db3, "answer_cards", "original_paper_filename", "TEXT");
          addColumnIfMissing(db3, "answer_cards", "original_paper_path", "TEXT");
          addColumnIfMissing(db3, "answer_cards", "question_range", "TEXT");
          addColumnIfMissing(db3, "answer_cards", "extra_notes", "TEXT");
          addColumnIfMissing(db3, "answer_cards", "knowledge_points_text", "TEXT");
          addColumnIfMissing(db3, "users", "require_original_paper", "INTEGER DEFAULT 1");
          addColumnIfMissing(db3, "users", "highlight_missing_paper", "INTEGER DEFAULT 1");
          if (!hasTable(db3, "knowledge_points")) {
            db3.exec(`
          CREATE TABLE knowledge_points (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id         TEXT NOT NULL REFERENCES answer_cards(id) ON DELETE CASCADE,
            question_number INTEGER NOT NULL,
            point_text      TEXT NOT NULL,
            category        TEXT,
            sort_order      INTEGER DEFAULT 0,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(card_id, question_number, point_text)
          );
          CREATE INDEX IF NOT EXISTS idx_kp_card ON knowledge_points(card_id);
          CREATE INDEX IF NOT EXISTS idx_kp_card_question ON knowledge_points(card_id, question_number);
        `);
          }
        }
      },
      {
        version: 10,
        name: "twain-scan-tables",
        up(db3) {
          if (!hasTable(db3, "twain_scan_sessions")) {
            db3.exec(`
          CREATE TABLE twain_scan_sessions (
            id          TEXT PRIMARY KEY,
            card_id     TEXT NOT NULL,
            name        TEXT NOT NULL DEFAULT '',
            dpi         INTEGER NOT NULL DEFAULT 300,
            duplex      INTEGER NOT NULL DEFAULT 1,
            color_mode  TEXT NOT NULL DEFAULT 'gray',
            paper_size  TEXT NOT NULL DEFAULT 'A4',
            page_count  INTEGER NOT NULL DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'pending',
            error_msg   TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE twain_scan_records (
            id              TEXT PRIMARY KEY,
            session_id      TEXT NOT NULL REFERENCES twain_scan_sessions(id) ON DELETE CASCADE,
            card_id         TEXT NOT NULL,
            student_id      TEXT,
            student_conf    REAL,
            image_path      TEXT NOT NULL,
            page_num        INTEGER NOT NULL DEFAULT 1,
            side            TEXT NOT NULL DEFAULT 'front',
            ocr_status      TEXT NOT NULL DEFAULT 'pending',
            scan_quality    REAL,
            ocr_error       TEXT,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            recognized_at   DATETIME
          );

          CREATE TABLE twain_recognition_results (
            id              TEXT PRIMARY KEY,
            scan_record_id  TEXT UNIQUE NOT NULL REFERENCES twain_scan_records(id) ON DELETE CASCADE,
            objective_json  TEXT,
            subjective_json TEXT,
            total_score     REAL,
            max_score       REAL,
            grade_status    TEXT NOT NULL DEFAULT 'pending',
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE twain_student_grading_results (
            session_id    TEXT NOT NULL,
            student_id    TEXT NOT NULL,
            objective_json  TEXT,
            subjective_json TEXT,
            total_score   REAL,
            max_score     REAL,
            page_count    INTEGER NOT NULL DEFAULT 1,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (session_id, student_id)
          );

          CREATE INDEX IF NOT EXISTS idx_twain_sessions_card ON twain_scan_sessions(card_id);
          CREATE INDEX IF NOT EXISTS idx_twain_records_session ON twain_scan_records(session_id);
          CREATE INDEX IF NOT EXISTS idx_twain_records_card ON twain_scan_records(card_id);
          CREATE INDEX IF NOT EXISTS idx_twain_records_student ON twain_scan_records(student_id);
          CREATE INDEX IF NOT EXISTS idx_twain_recognition_scan ON twain_recognition_results(scan_record_id);
          CREATE INDEX IF NOT EXISTS idx_twain_sgr_session ON twain_student_grading_results(session_id);
          CREATE INDEX IF NOT EXISTS idx_twain_sgr_student ON twain_student_grading_results(student_id);
        `);
          }
        }
      }
    ];
  }
});

// src/server/db/paths.ts
import path from "node:path";
function resolveProjectDbPath() {
  const envPath = process.env.PROJECTX_DB_PATH;
  if (envPath) return path.resolve(envPath);
  return path.join(process.cwd(), "data", "projectx.db");
}
function resolveAnswerCardDataDir() {
  const envDir = process.env.ANSWER_CARD_DATA_DIR;
  if (envDir) return path.resolve(envDir);
  return path.join(process.cwd(), "data", "answer-card");
}
function resolveScannerDbPath() {
  return path.join(resolveAnswerCardDataDir(), "scanner.db");
}
var init_paths = __esm({
  "src/server/db/paths.ts"() {
    "use strict";
  }
});

// src/server/db/seeds.ts
function seedDefaultData(db3) {
  const roleCount = db3.prepare("SELECT COUNT(*) as cnt FROM roles").get();
  if (roleCount.cnt === 0) {
    const insertRole = db3.prepare(
      "INSERT OR IGNORE INTO roles (id, name, display_name, permissions) VALUES (?, ?, ?, ?)"
    );
    insertRole.run(1, "admin", "\u7BA1\u7406\u5458", JSON.stringify(["*"]));
    insertRole.run(2, "teacher", "\u6559\u5E08", JSON.stringify([
      "card:read",
      "card:write",
      "exam:read",
      "exam:write",
      "grade:read",
      "grade:write"
    ]));
    insertRole.run(3, "student", "\u5B66\u751F", JSON.stringify(["score:read"]));
    console.log("[DB] Default roles inserted");
  }
  const policyCount = db3.prepare("SELECT COUNT(*) as cnt FROM data_retention_policies").get();
  if (policyCount.cnt === 0) {
    const insertPolicy = db3.prepare(
      "INSERT OR IGNORE INTO data_retention_policies (id, name, retain_days, auto_archive, auto_delete) VALUES (?, ?, ?, ?, ?)"
    );
    insertPolicy.run(1, "\u5468\u6D4B", 30, 1, 0);
    insertPolicy.run(2, "\u6708\u8003", 90, 1, 0);
    insertPolicy.run(3, "\u671F\u4E2D\u671F\u672B", 0, 1, 0);
    console.log("[DB] Default retention policies inserted");
  }
}
var init_seeds = __esm({
  "src/server/db/seeds.ts"() {
    "use strict";
  }
});

// src/server/db/mysql.ts
import mariadb from "mysql2/promise";
import { existsSync, readFileSync } from "node:fs";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
function readConfigDbMode() {
  const configPath2 = path2.join(process.cwd(), "config.yml");
  if (!existsSync(configPath2)) return null;
  try {
    const raw = readFileSync(configPath2, "utf8");
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
        password: passMatch ? passMatch[1].trim() : ""
      }
    };
  } catch {
    return null;
  }
}
function detectDialect() {
  if (_detectedDialect) return _detectedDialect;
  if (process.env.PROJECTX_MARIADB_HOST || process.env.PROJECTX_MYSQL_HOST) {
    _detectedDialect = "mariadb";
    return "mariadb";
  }
  const dbConfig = readConfigDbMode();
  if (dbConfig?.mode === "remote" && dbConfig?.remote?.host) {
    _detectedDialect = "mariadb";
    return "mariadb";
  }
  _detectedDialect = "sqlite";
  return "sqlite";
}
function resetDialect() {
  _detectedDialect = null;
}
function buildUpsertSQL(dialect, table, insertCols, conflictCols, updateCols) {
  const cols = insertCols.join(", ");
  const placeholders2 = insertCols.map(() => "?").join(", ");
  const updCols = updateCols ?? insertCols.filter((c) => !conflictCols.includes(c));
  if (dialect === "sqlite") {
    const setClause = updCols.map((c) => `${c} = excluded.${c}`).join(", ");
    return `INSERT INTO ${table} (${cols}) VALUES (${placeholders2}) ON CONFLICT(${conflictCols.join(", ")}) DO UPDATE SET ${setClause}`;
  } else {
    const setClause = updCols.map((c) => `${c} = VALUES(${c})`).join(", ");
    return `INSERT INTO ${table} (${cols}) VALUES (${placeholders2}) ON DUPLICATE KEY UPDATE ${setClause}`;
  }
}
function buildInsertIgnore(_dialect, table, cols) {
  const placeholders2 = cols.map(() => "?").join(", ");
  return `INSERT IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders2})`;
}
function getMariadbConfig() {
  const host = process.env.PROJECTX_MARIADB_HOST || process.env.PROJECTX_MYSQL_HOST;
  if (host) {
    return {
      host,
      port: Number(process.env.PROJECTX_MARIADB_PORT || process.env.PROJECTX_MYSQL_PORT || 3306),
      user: process.env.PROJECTX_MARIADB_USER || process.env.PROJECTX_MYSQL_USER || "projectx",
      password: process.env.PROJECTX_MARIADB_PASSWORD || process.env.PROJECTX_MYSQL_PASSWORD || "projectx",
      database: process.env.PROJECTX_MARIADB_DATABASE || process.env.PROJECTX_MYSQL_DATABASE || "projectx"
    };
  }
  const dbConfig = readConfigDbMode();
  if (dbConfig?.remote?.host) {
    return {
      host: dbConfig.remote.host,
      port: dbConfig.remote.port ?? 3306,
      user: dbConfig.remote.user ?? "projectx",
      password: dbConfig.remote.password ?? "",
      database: dbConfig.remote.database ?? "projectx"
    };
  }
  return null;
}
function createMariadbPool() {
  const cfg = getMariadbConfig();
  if (!cfg) throw new Error("MariaDB \u8FDE\u63A5\u914D\u7F6E\u7F3A\u5931");
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
    connectTimeout: 5e3,
    enableKeepAlive: true,
    keepAliveInitialDelay: 1e4,
    maxIdle: 10,
    idleTimeout: 6e4,
    // 多个语句（建表用）
    multipleStatements: true
  });
  pool.on("connection", () => {
  });
  pool.on("error", (err) => {
    console.error("[MariaDB] Pool error:", err.message);
  });
  console.log(`[MariaDB] Pool: ${cfg.host}:${cfg.port}/${cfg.database}`);
  return pool;
}
function getMysqlDb() {
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
function resetAdapter() {
  if (mariadbPool) {
    mariadbPool.end().catch(() => {
    });
    mariadbPool = null;
  }
  adapter = null;
  resetDialect();
}
async function healthCheck() {
  try {
    const db3 = getMysqlDb();
    const start = Date.now();
    await db3.get("SELECT 1 as val");
    const latency = Date.now() - start;
    return { ok: true, dialect: db3.dialect, latencyMs: latency };
  } catch (err) {
    return { ok: false, dialect: detectDialect(), error: err.message };
  }
}
async function initMariadbSchema() {
  const dialect = detectDialect();
  if (dialect !== "mariadb") return;
  const __dirname2 = path2.dirname(fileURLToPath(import.meta.url));
  const schemaPath2 = path2.join(__dirname2, "schema.mariadb.sql");
  let schema;
  try {
    schema = readFileSync(schemaPath2, "utf8");
  } catch {
    console.warn("[MariaDB] schema.mariadb.sql not found, skipping schema init");
    return;
  }
  const pool = mariadbPool;
  const conn = await pool.getConnection();
  try {
    const statements = schema.split(";").map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("--") && !s.startsWith("USE ") && !s.startsWith("CREATE DATABASE"));
    for (const stmt of statements) {
      try {
        await conn.execute(stmt);
      } catch (err) {
        if (!err.message?.includes("already exists") && err.errno !== 1061 && err.code !== "ER_DUP_KEYNAME") throw err;
      }
    }
    console.log("[MariaDB] Schema initialized");
  } finally {
    conn.release();
  }
}
var _detectedDialect, SqliteAdapter, mariadbPool, MariadbAdapter, adapter;
var init_mysql = __esm({
  "src/server/db/mysql.ts"() {
    "use strict";
    init_db();
    _detectedDialect = null;
    SqliteAdapter = class {
      dialect = "sqlite";
      db;
      // better-sqlite3 Database, 懒加载避免循环引用
      constructor() {
        this.db = getDatabase();
      }
      async get(sql, ...params) {
        const row = this.db.prepare(sql).get(...params);
        return row ?? null;
      }
      async all(sql, ...params) {
        return this.db.prepare(sql).all(...params);
      }
      async run(sql, ...params) {
        const r = this.db.prepare(sql).run(...params);
        return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
      }
      async exec(sql) {
        this.db.exec(sql);
      }
      async transaction(fn) {
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
    };
    mariadbPool = null;
    MariadbAdapter = class _MariadbAdapter {
      dialect = "mariadb";
      executor;
      constructor(source) {
        if (source) {
          this.executor = source;
        } else {
          if (!mariadbPool) {
            mariadbPool = createMariadbPool();
          }
          this.executor = mariadbPool;
        }
      }
      async get(sql, ...params) {
        const [rows] = await this.executor.execute(sql, params);
        return rows.length > 0 ? rows[0] : null;
      }
      async all(sql, ...params) {
        const [rows] = await this.executor.execute(sql, params);
        return rows;
      }
      async run(sql, ...params) {
        const [r] = await this.executor.execute(sql, params);
        return { lastInsertRowid: r.insertId, changes: r.affectedRows };
      }
      async exec(sql) {
        await this.executor.execute(sql);
      }
      async transaction(fn) {
        const conn = await this.executor.getConnection();
        const txAdapter = new _MariadbAdapter(conn);
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
    };
    adapter = null;
  }
});

// src/server/db/index.ts
var db_exports = {};
__export(db_exports, {
  buildInsertIgnore: () => buildInsertIgnore,
  buildUpsertSQL: () => buildUpsertSQL,
  closeDatabase: () => closeDatabase,
  detectDialect: () => detectDialect,
  ensureDefaultAdmin: () => ensureDefaultAdmin,
  getDatabase: () => getDatabase,
  getMysqlDb: () => getMysqlDb,
  hashPassword: () => hashPassword,
  healthCheck: () => healthCheck,
  initMariadbSchema: () => initMariadbSchema,
  initMysqlSchema: () => initMariadbSchema,
  initializeDatabase: () => initializeDatabase,
  resetAdapter: () => resetAdapter,
  resolveAnswerCardDataDir: () => resolveAnswerCardDataDir,
  resolveProjectDbPath: () => resolveProjectDbPath,
  resolveScannerDbPath: () => resolveScannerDbPath,
  runMigrations: () => runMigrations,
  verifyPassword: () => verifyPassword
});
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { mkdirSync, readFileSync as readFileSync2 } from "node:fs";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function schemaPath() {
  return path3.join(__dirname, "schema.sql");
}
function getDatabase() {
  if (!dbInstance) {
    const dbPath = resolveProjectDbPath();
    mkdirSync(path3.dirname(dbPath), { recursive: true });
    dbInstance = new Database(dbPath);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
    dbInstance.pragma("synchronous = NORMAL");
    dbInstance.pragma("busy_timeout = 5000");
    console.log(`[DB] Connected to: ${dbPath}`);
  }
  return dbInstance;
}
function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    console.log("[DB] Connection closed");
  }
}
function initializeDatabase() {
  const dialect = detectDialect();
  if (dialect === "mariadb") {
    console.log("[DB] MariaDB mode: schema seeded via schema.mariadb.sql");
    return;
  }
  const db3 = getDatabase();
  const schema = readFileSync2(schemaPath(), "utf8");
  db3.exec(schema);
  console.log("[DB] Schema checked successfully");
  runMigrations(db3);
  seedDefaultData(db3);
}
async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}
async function verifyPassword(password, hash) {
  if (!hash || hash === "") {
    return false;
  }
  return bcrypt.compare(password, hash);
}
async function ensureDefaultAdmin() {
  const dialect = detectDialect();
  if (dialect === "mariadb") {
    const db4 = getMysqlDb();
    const existing2 = await db4.get("SELECT id FROM users WHERE username = ?", "admin");
    if (existing2) return;
    const passwordHash2 = await hashPassword("admin123");
    await db4.run(
      "INSERT IGNORE INTO users (username, password_hash, name, role_id, is_active) VALUES (?, ?, ?, ?, ?)",
      "admin",
      passwordHash2,
      "\u7CFB\u7EDF\u7BA1\u7406\u5458",
      1,
      1
    );
    console.log("[DB] Default admin created: username=admin, password=admin123");
    return;
  }
  const db3 = getDatabase();
  const existing = db3.prepare("SELECT id FROM users WHERE username = ?").get("admin");
  if (existing) return;
  const passwordHash = await hashPassword("admin123");
  db3.prepare(
    `INSERT INTO users (username, password_hash, name, role_id, is_active)
     VALUES (?, ?, ?, ?, ?)`
  ).run("admin", passwordHash, "\u7CFB\u7EDF\u7BA1\u7406\u5458", 1, 1);
  console.log("[DB] Default admin created: username=admin, password=admin123");
  console.log("[DB] \u8BF7\u767B\u5F55\u540E\u7ACB\u5373\u4FEE\u6539\u9ED8\u8BA4\u5BC6\u7801");
}
var __dirname, dbInstance;
var init_db = __esm({
  "src/server/db/index.ts"() {
    "use strict";
    init_migrations();
    init_paths();
    init_seeds();
    init_mysql();
    init_paths();
    init_mysql();
    __dirname = path3.dirname(fileURLToPath2(import.meta.url));
    dbInstance = null;
  }
});

// src/shared/grading.ts
function normalizeOptions(options, optionCount) {
  const allowed = new Set(OPTION_LABELS.slice(0, optionCount ?? OPTION_LABELS.length));
  return Array.from(new Set((options ?? []).map((item) => item.toUpperCase()).filter((item) => allowed.has(item)))).sort();
}
function sameOptions(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}
function legacyScoringRule(block) {
  if (!block.multipleScoring) return void 0;
  return {
    type: "per_selected_count",
    partialScores: block.multipleScoring.partialScores ?? {},
    wrongOrExtraScore: block.multipleScoring.wrongOrExtraScore ?? 0
  };
}
function normalizeQuestionConfig(block, config) {
  return {
    questionNumber: config.questionNumber,
    mode: config.mode ?? block.mode,
    optionCount: config.optionCount ?? block.optionCount,
    score: config.score ?? block.scorePerQuestion,
    answerKey: config.answerKey ?? block.answerKey?.[config.questionNumber],
    scoringRule: config.scoringRule ?? legacyScoringRule(block),
    optionLayout: config.optionLayout ?? block.optionLayout ?? "horizontal"
  };
}
function objectiveQuestionDefinitions(block) {
  if (block.questions && block.questions.length > 0) {
    return block.questions.map((question) => normalizeQuestionConfig(block, question));
  }
  return Array.from({ length: block.questionCount }, (_, index) => {
    const questionNumber = block.questionStart + index;
    return normalizeQuestionConfig(block, { questionNumber });
  });
}
function findObjectiveQuestion(card, questionNumber) {
  for (const block of card.bodyBlocks) {
    if (block.type !== "objective") continue;
    const definition = objectiveQuestionDefinitions(block).find((item) => item.questionNumber === questionNumber);
    if (definition) {
      return { block, definition };
    }
  }
  return null;
}
function objectiveQuestionNumbers(block) {
  return objectiveQuestionDefinitions(block).map((question) => question.questionNumber);
}
function normalizeObjectiveAnswerKey(block) {
  const normalized = {};
  for (const question of objectiveQuestionDefinitions(block)) {
    const options = normalizeOptions(question.answerKey, question.optionCount);
    if (question.mode === "single" && options.length > 1) {
      normalized[question.questionNumber] = [options[0]];
    } else if (options.length > 0) {
      normalized[question.questionNumber] = options;
    }
  }
  return normalized;
}
function normalizeObjectiveQuestions(block) {
  const answerKey = normalizeObjectiveAnswerKey(block);
  return objectiveQuestionDefinitions(block).map((question) => {
    const options = normalizeOptions(answerKey[question.questionNumber], question.optionCount);
    return {
      questionNumber: question.questionNumber,
      mode: question.mode,
      optionCount: question.optionCount,
      score: question.score,
      answerKey: question.mode === "single" && options.length > 1 ? [options[0]] : options,
      scoringRule: question.scoringRule
    };
  });
}
function partialScoreFor(rule, selectedCorrectCount, correctCount) {
  if (!rule) return void 0;
  if (rule.type === "fixed_partial") return rule.partialScore;
  if (rule.type === "by_correct_count") return rule.partialScoresByCorrectCount[correctCount]?.[selectedCorrectCount] ?? 0;
  return rule.partialScores[selectedCorrectCount] ?? 0;
}
function wrongOrExtraScoreFor(rule) {
  return rule?.wrongOrExtraScore ?? 0;
}
function gradeObjectiveQuestion(card, question, confidenceThreshold = OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD) {
  const target = findObjectiveQuestion(card, question.questionNumber);
  const definition = target?.definition;
  const confidence = Number.isFinite(question.confidence) ? question.confidence : 0;
  const selectedOptions = normalizeOptions(question.selectedOptions, definition?.optionCount);
  const needsReview = confidence < confidenceThreshold;
  if (!definition) {
    return {
      questionNumber: question.questionNumber,
      selectedOptions,
      correctOptions: [],
      score: 0,
      maxScore: 0,
      confidence,
      status: "review",
      needsReview: true,
      message: "\u9898\u53F7\u4E0D\u5728\u5F53\u524D\u7B54\u9898\u5361\u7684\u5BA2\u89C2\u9898\u8303\u56F4\u5185"
    };
  }
  const maxScore = definition.score;
  const correctOptions = normalizeOptions(definition.answerKey, definition.optionCount);
  if (correctOptions.length === 0) {
    return {
      questionNumber: question.questionNumber,
      selectedOptions,
      correctOptions,
      score: 0,
      maxScore,
      confidence,
      status: "missing_key",
      needsReview: true,
      message: "\u672A\u914D\u7F6E\u6807\u51C6\u7B54\u6848"
    };
  }
  if (sameOptions(selectedOptions, correctOptions)) {
    return {
      questionNumber: question.questionNumber,
      selectedOptions,
      correctOptions,
      score: maxScore,
      maxScore,
      confidence,
      status: needsReview ? "review" : "correct",
      needsReview,
      message: needsReview ? "\u8BC6\u522B\u7F6E\u4FE1\u5EA6\u504F\u4F4E" : void 0
    };
  }
  const correctSet = new Set(correctOptions);
  const selectedCorrectCount = selectedOptions.filter((option) => correctSet.has(option)).length;
  const hasWrong = selectedCorrectCount < selectedOptions.length;
  const hasTooMany = selectedOptions.length > correctOptions.length;
  const allowsWrongOptions = definition.scoringRule?.allowWrongOptions === true;
  const canPartial = (definition.mode === "multiple" || definition.mode === "indefinite") && selectedOptions.length > 0 && selectedCorrectCount > 0 && !hasTooMany && (!hasWrong || allowsWrongOptions);
  const partialScore = canPartial ? partialScoreFor(definition.scoringRule, selectedCorrectCount, correctOptions.length) : void 0;
  const score = partialScore ?? wrongOrExtraScoreFor(definition.scoringRule);
  return {
    questionNumber: question.questionNumber,
    selectedOptions,
    correctOptions,
    score,
    maxScore,
    confidence,
    status: score > 0 ? "partial" : needsReview ? "review" : "wrong",
    needsReview,
    message: needsReview ? "\u8BC6\u522B\u7F6E\u4FE1\u5EA6\u504F\u4F4E" : void 0
  };
}
function gradeObjectiveRecognition(card, fileName, recognition) {
  const questionMap = new Map(recognition.questions.map((question) => [question.questionNumber, question]));
  const grades = [];
  for (const block of card.bodyBlocks) {
    if (block.type !== "objective") continue;
    for (const questionNumber of objectiveQuestionNumbers(block)) {
      const recognized = questionMap.get(questionNumber) ?? {
        questionNumber,
        selectedOptions: [],
        confidence: 0
      };
      grades.push(gradeObjectiveQuestion(card, recognized));
    }
  }
  const score = roundScore(grades.reduce((sum, item) => sum + item.score, 0));
  const maxScore = roundScore(grades.reduce((sum, item) => sum + item.maxScore, 0));
  const needsReviewCount = grades.filter((item) => item.needsReview).length;
  const issueCount = grades.filter((item) => item.status === "missing_key").length + (recognition.status === "ok" ? 0 : 1);
  const studentId = recognition.studentId?.status === "ok" ? recognition.studentId.value : null;
  return {
    fileName,
    studentId,
    recognitionStatus: recognition.status,
    score,
    maxScore,
    needsReviewCount,
    issueCount,
    message: recognition.message,
    questions: grades,
    recognition
  };
}
function roundScore(value) {
  return Math.round(value * 1e3) / 1e3;
}
function findSubjectiveQuestion(card, questionId) {
  for (const block of card.bodyBlocks) {
    if (block.type !== "subjective") continue;
    const q = block.questions.find((q2) => q2.id === questionId);
    if (q) return q;
  }
  return void 0;
}
function gradeSubjectiveRecognition(card, recognition) {
  const question = findSubjectiveQuestion(card, recognition.questionId);
  const maxScore = question?.score ?? recognition.maxScore;
  const needsReview = recognition.status !== "ok";
  let status = "ok";
  if (recognition.status === "invalid") status = "invalid";
  else if (needsReview) status = "missing_score_grid";
  return {
    questionId: recognition.questionId,
    questionNumber: recognition.questionNumber,
    score: Math.min(recognition.score, maxScore),
    maxScore,
    status,
    needsReview,
    confidence: recognition.confidence,
    validCells: recognition.validCells,
    invalidCells: recognition.invalidCells,
    message: recognition.message
  };
}
function gradeCombinedRecognition(card, fileName, recognition) {
  const objectiveRow = gradeObjectiveRecognition(card, fileName, recognition);
  const subjectiveQuestions = (recognition.subjectiveQuestions ?? []).map(
    (sq) => gradeSubjectiveRecognition(card, sq)
  );
  const objectiveScore = objectiveRow.score;
  const objectiveMaxScore = objectiveRow.maxScore;
  const subjectiveScore = roundScore(subjectiveQuestions.reduce((sum, q) => sum + q.score, 0));
  const subjectiveMaxScore = roundScore(subjectiveQuestions.reduce((sum, q) => sum + q.maxScore, 0));
  return {
    ...objectiveRow,
    objectiveScore,
    objectiveMaxScore,
    subjectiveScore,
    subjectiveMaxScore,
    totalScore: roundScore(objectiveScore + subjectiveScore),
    totalMaxScore: roundScore(objectiveMaxScore + subjectiveMaxScore),
    subjectiveQuestions,
    recognition
  };
}
function gradeSessionStudentResults(card, pages) {
  const objQMap = /* @__PURE__ */ new Map();
  const subjQMap = /* @__PURE__ */ new Map();
  const pageResults = pages.map((page) => {
    const row = gradeCombinedRecognition(card, page.imagePath, page.recognition);
    for (const q of row.questions) {
      const existing = objQMap.get(q.questionNumber);
      if (!existing || existing.status === "missing_key" && q.status !== "missing_key" || existing.score < q.score && q.status !== "missing_key") {
        objQMap.set(q.questionNumber, q);
      }
    }
    for (const sq of row.subjectiveQuestions) {
      const key = String(sq.questionId) || String(sq.questionNumber);
      const existing = subjQMap.get(key);
      if (!existing || existing.status === "missing_score_grid" && sq.status !== "missing_score_grid" || existing.score < sq.score && sq.status !== "missing_score_grid") {
        subjQMap.set(key, sq);
      }
    }
    return {
      recordId: page.recordId,
      pageNum: page.pageNum,
      side: page.side,
      imagePath: page.imagePath,
      objectiveScore: row.objectiveScore,
      objectiveMaxScore: row.objectiveMaxScore,
      subjectiveScore: row.subjectiveScore,
      subjectiveMaxScore: row.subjectiveMaxScore,
      totalScore: row.totalScore,
      totalMaxScore: row.totalMaxScore,
      ocrStatus: page.ocrStatus,
      needsReviewCount: row.needsReviewCount
    };
  });
  const allObjectiveQuestions = Array.from(objQMap.values());
  const allSubjectiveQuestions = Array.from(subjQMap.values());
  const objectiveScore = roundScore(allObjectiveQuestions.reduce((sum, q) => sum + q.score, 0));
  const objectiveMaxScore = roundScore(allObjectiveQuestions.reduce((sum, q) => sum + q.maxScore, 0));
  const subjectiveScore = roundScore(allSubjectiveQuestions.reduce((sum, q) => sum + q.score, 0));
  const subjectiveMaxScore = roundScore(allSubjectiveQuestions.reduce((sum, q) => sum + q.maxScore, 0));
  const totalScore = roundScore(objectiveScore + subjectiveScore);
  const totalMaxScore = roundScore(objectiveMaxScore + subjectiveMaxScore);
  const needsReviewCount = allObjectiveQuestions.filter((q) => q.needsReview).length + allSubjectiveQuestions.filter((q) => q.needsReview).length;
  return {
    studentId: pages[0]?.recognition.studentId?.value ?? "\u672A\u8BC6\u522B",
    pages: pageResults,
    totalScore,
    totalMaxScore,
    objectiveScore,
    objectiveMaxScore,
    subjectiveScore,
    subjectiveMaxScore,
    needsReviewCount,
    pageCount: pageResults.length,
    objectiveQuestions: allObjectiveQuestions,
    subjectiveQuestions: allSubjectiveQuestions
  };
}
var OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD, OPTION_LABELS;
var init_grading = __esm({
  "src/shared/grading.ts"() {
    "use strict";
    OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD = 0.12;
    OPTION_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  }
});

// src/server/repositories/ExamRepository.ts
var ExamRepository_exports = {};
__export(ExamRepository_exports, {
  ExamRepository: () => ExamRepository
});
var ExamRepository;
var init_ExamRepository = __esm({
  "src/server/repositories/ExamRepository.ts"() {
    "use strict";
    init_db();
    ExamRepository = class {
      db;
      constructor() {
        this.db = getMysqlDb();
      }
      async createExam(params) {
        const result = await this.db.run(
          `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, end_time, status, retention_policy_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
          params.name,
          params.card_id,
          params.grade_id ?? null,
          params.class_id ?? null,
          params.subject ?? null,
          params.start_time ?? null,
          params.end_time ?? null,
          params.retention_policy_id ?? 1,
          params.created_by ?? null
        );
        return await this.findExamById(result.lastInsertRowid);
      }
      async findExamById(id) {
        return await this.db.get("SELECT * FROM exams WHERE id = ?", id);
      }
      async findExamByName(name) {
        return await this.db.get("SELECT * FROM exams WHERE name = ?", name);
      }
      async listExams(filters) {
        let sql = "SELECT * FROM exams WHERE 1=1";
        const params = [];
        if (filters?.status) {
          sql += " AND status = ?";
          params.push(filters.status);
        }
        if (filters?.grade_id) {
          sql += " AND grade_id = ?";
          params.push(filters.grade_id);
        }
        if (filters?.class_id) {
          sql += " AND class_id = ?";
          params.push(filters.class_id);
        }
        if (filters?.subject) {
          sql += " AND subject = ?";
          params.push(filters.subject);
        }
        if (filters?.created_by) {
          sql += " AND created_by = ?";
          params.push(filters.created_by);
        }
        if (filters?.examIds && filters.examIds.length > 0) {
          sql += ` AND id IN (${filters.examIds.map(() => "?").join(",")})`;
          params.push(...filters.examIds);
        }
        sql += " ORDER BY created_at DESC";
        return await this.db.all(sql, ...params);
      }
      async listExamsForSelection(filters) {
        let sql = `SELECT e.id, e.name, e.subject, e.grade_id, g.name as grade_name,
        COALESCE(ac.exam_date, date(e.created_at)) as exam_date, e.status,
        COUNT(ss.id) as graded_count, ROUND(AVG(ss.total_score), 1) as avg_score,
        CASE WHEN e.assigned_formula IS NOT NULL AND e.assigned_formula != '' THEN 1 ELSE 0 END as has_assigned_score
      FROM exams e
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      LEFT JOIN grades g ON g.id = e.grade_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      WHERE 1=1`;
        const params = [];
        if (filters?.grade_id) {
          sql += " AND e.grade_id = ?";
          params.push(filters.grade_id);
        }
        if (filters?.subject) {
          sql += " AND e.subject = ?";
          params.push(filters.subject);
        }
        if (filters?.academic_year) {
          const [startYear] = filters.academic_year.split("-").map(Number);
          sql += ` AND ((ac.exam_date >= ? AND ac.exam_date < ?) OR (ac.exam_date IS NULL AND e.created_at >= ? AND e.created_at < ?))`;
          params.push(`${startYear}-09-01`, `${startYear + 1}-08-01`, `${startYear}-09-01T00:00:00.000Z`, `${startYear + 1}-08-01T00:00:00.000Z`);
        }
        if (filters?.examIds && filters.examIds.length > 0) {
          sql += ` AND e.id IN (${filters.examIds.map(() => "?").join(",")})`;
          params.push(...filters.examIds);
        }
        sql += ` GROUP BY e.id ORDER BY COALESCE(ac.exam_date, e.created_at) DESC`;
        return await this.db.all(sql, ...params);
      }
      async getAcademicYears() {
        const rows = await this.db.all(`SELECT DISTINCT COALESCE(ac.exam_date, e.created_at) as dt
      FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id`);
        const years = /* @__PURE__ */ new Set();
        for (const row of rows) {
          if (!row.dt) continue;
          const d = new Date(row.dt);
          const month = d.getMonth() + 1;
          const year = month >= 9 ? d.getFullYear() : d.getFullYear() - 1;
          years.add(`${year}-${year + 1}`);
        }
        return Array.from(years).sort().reverse();
      }
      async getSubjects() {
        const rows = await this.db.all(
          "SELECT DISTINCT subject FROM exams WHERE subject IS NOT NULL AND subject != '' ORDER BY subject"
        );
        return rows.map((r) => r.subject);
      }
      async updateStatus(id, status) {
        await this.db.run("UPDATE exams SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", status, id);
      }
      async createScanBatch(examId, name, createdBy) {
        const result = await this.db.run(
          "INSERT INTO scan_batches (exam_id, name, created_by) VALUES (?, ?, ?)",
          examId,
          name,
          createdBy ?? null
        );
        return result.lastInsertRowid;
      }
      async addScanRecord(input) {
        let expiresAt = input.expires_at;
        if (!expiresAt) {
          const d = /* @__PURE__ */ new Date();
          d.setDate(d.getDate() + 30);
          expiresAt = d.toISOString();
        }
        const result = await this.db.run(
          "INSERT INTO scan_records (batch_id, file_path, file_name, student_number, student_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
          input.batch_id,
          input.file_path,
          input.file_name,
          input.student_number ?? null,
          input.student_id ?? null,
          expiresAt
        );
        return result.lastInsertRowid;
      }
      async saveRecognition(recordId, blockId, questionNumber, selectedOptions, confidence) {
        await this.db.run(
          "REPLACE INTO objective_recognitions (record_id, block_id, question_number, selected_options, confidence) VALUES (?, ?, ?, ?, ?)",
          recordId,
          blockId,
          questionNumber,
          JSON.stringify(selectedOptions),
          confidence ?? null
        );
      }
      async saveObjectiveGrade(recordId, questionNumber, blockId, score, maxScore, isCorrect) {
        await this.db.run(
          "REPLACE INTO objective_grades (record_id, question_number, block_id, score, max_score, is_correct) VALUES (?, ?, ?, ?, ?, ?)",
          recordId,
          questionNumber,
          blockId,
          score,
          maxScore,
          isCorrect
        );
      }
      async saveStudentScore(examId, studentId, objectiveScore, subjectiveScore) {
        const total = objectiveScore + subjectiveScore;
        await this.db.run(
          "REPLACE INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score, graded_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
          examId,
          studentId,
          objectiveScore,
          subjectiveScore,
          total
        );
      }
      async getExamResults(examId) {
        return await this.db.all(`SELECT ss.*, u.student_number, u.name
      FROM student_scores ss JOIN users u ON u.id = ss.student_id
      WHERE ss.exam_id = ? ORDER BY ss.total_score DESC`, examId);
      }
      async finishBatch(batchId) {
        await this.db.run("UPDATE scan_batches SET status = 'done', finished_at = CURRENT_TIMESTAMP WHERE id = ?", batchId);
      }
    };
  }
});

// src/shared/defaultCard.ts
function generateCardId(subject) {
  const seed = `${subject}_${Date.now()}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i) | 0;
  }
  const num = Math.abs(hash) % 9e7 + 1e7;
  return String(num);
}
function createDefaultCard(id, subject) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    id,
    title: "",
    subject: subject ?? void 0,
    paper: { size: "A4", orientation: "portrait" },
    studentInfo: {
      fields: ["\u59D3\u540D", "\u73ED\u7EA7"],
      studentNumberDigits: 5
    },
    bodyBlocks: [],
    sided: "single",
    layoutVersion: 1,
    updatedAt: now
  };
}
var init_defaultCard = __esm({
  "src/shared/defaultCard.ts"() {
    "use strict";
  }
});

// src/shared/blankLabels.ts
function romanNumeral(value) {
  const numerals = [
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"]
  ];
  let remaining = value;
  let result = "";
  for (const [amount, label] of numerals) {
    while (remaining >= amount) {
      result += label;
      remaining -= amount;
    }
  }
  return result;
}
function formatBlankLabel(style, index) {
  if (!style || style === "none") return "";
  if (style === "roman_parentheses") return `(${romanNumeral(index + 1)})`;
  return `(${index + 1})`;
}
var init_blankLabels = __esm({
  "src/shared/blankLabels.ts"() {
    "use strict";
  }
});

// src/shared/layout.ts
function rect(x, y, width, height) {
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}
function round(value) {
  return Math.round(value * 1e3) / 1e3;
}
function markerRects() {
  const w = 2.6;
  const h = 7;
  return [
    { role: "top-left", rect: rect(MARGIN_X - 4.5, 21, w, h) },
    { role: "top-right", rect: rect(PAGE_WIDTH - MARGIN_X + 1.9, 21, w, h) },
    { role: "middle-left", rect: rect(MARGIN_X - 4.5, 163, w, h) },
    { role: "middle-right", rect: rect(PAGE_WIDTH - MARGIN_X + 1.9, 163, w, h) },
    { role: "bottom-left", rect: rect(MARGIN_X - 4.5, PAGE_HEIGHT - 35, w, h) },
    { role: "bottom-right", rect: rect(PAGE_WIDTH - MARGIN_X + 1.9, PAGE_HEIGHT - 35, w, h) }
  ];
}
function createPage(card, pageNumber, includeTitle) {
  const codeBoxes = Array.from({ length: 6 }, (_, index) => rect(58 + index * 6.1, 22, 4.8, 3.4));
  const markers = markerRects();
  const elements = markers.map((marker) => ({
    id: `p${pageNumber}_marker_${marker.role}`,
    type: "marker",
    role: marker.role,
    rect: marker.rect
  }));
  return {
    pageNumber,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    markers,
    header: {
      id: card.id,
      title: includeTitle ? card.title : void 0,
      idTextX: 21,
      idTextY: 26,
      codeBoxes,
      titleX: includeTitle ? PAGE_WIDTH / 2 : void 0,
      titleY: includeTitle ? 37 : void 0
    },
    blocks: [],
    elements
  };
}
function layoutStudentArea(card, page, y) {
  const rowCount = Math.max(1, card.studentInfo.studentNumberDigits);
  const rowH = 4.8;
  const areaHeight = Math.max(29, 7 + rowCount * rowH);
  const infoRect = rect(MARGIN_X, y, 66, areaHeight);
  const digitRect = rect(MARGIN_X + 70, y, BODY_WIDTH - 70, areaHeight);
  const digitCells = [];
  const cellW = 4.6;
  const cellH = 2.8;
  const startX = digitRect.x + 13;
  const startY = digitRect.y + 8;
  const usableW = digitRect.width - 18;
  const colGap = usableW / 10;
  for (let digitIndex = 0; digitIndex < rowCount; digitIndex += 1) {
    for (let digit = 0; digit <= 9; digit += 1) {
      const cell = rect(startX + digit * colGap, startY + digitIndex * rowH, cellW, cellH);
      digitCells.push({ digitIndex, digit, rect: cell });
      page.elements.push({
        id: `p${page.pageNumber}_student_${digitIndex}_${digit}`,
        type: "student_digit",
        digitIndex,
        digit,
        rect: cell
      });
    }
  }
  page.studentArea = { infoRect, digitRect, digitCells };
  return page.studentArea;
}
function bodyBottom() {
  return PAGE_HEIGHT - BOTTOM_MARGIN;
}
function titleHeight() {
  return 8;
}
function objectiveArrangementMode(questions) {
  if (questions.some(isVerticalQuestion)) {
    return "vertical-grid";
  }
  return questions.length >= 15 ? "grid" : "rows";
}
function isWideObjectiveQuestion(question) {
  return question.optionCount > OBJECTIVE_WIDE_OPTION_THRESHOLD;
}
function isVerticalQuestion(question) {
  return question.optionLayout === "vertical";
}
function isSoloRowQuestion(question) {
  return isWideObjectiveQuestion(question);
}
function objectiveGridCellQuestions(mode) {
  return mode === "vertical-grid" ? OBJECTIVE_VERTICAL_GROUP_QUESTIONS : OBJECTIVE_GRID_CELL_QUESTIONS;
}
function objectiveRowsForQuestions(questions, mode) {
  const rows = [];
  if (mode === "rows") {
    let standardRow = [];
    const flushStandardRow = () => {
      if (standardRow.length > 0) {
        rows.push({ type: "standard", questions: standardRow });
        standardRow = [];
      }
    };
    for (const question of questions) {
      if (isSoloRowQuestion(question)) {
        flushStandardRow();
        rows.push({ type: "wide", question });
        continue;
      }
      standardRow.push(question);
      if (standardRow.length === OBJECTIVE_STANDARD_COLUMNS) {
        flushStandardRow();
      }
    }
    flushStandardRow();
    return rows;
  }
  const gridCellQuestions = objectiveGridCellQuestions(mode);
  let gridCells = [[]];
  const flushGridRow = () => {
    const nonEmptyCells = gridCells.filter((cell) => cell.length > 0);
    if (nonEmptyCells.length > 0) {
      rows.push({ type: "grid", cells: nonEmptyCells });
    }
    gridCells = [[]];
  };
  for (const question of questions) {
    if (isSoloRowQuestion(question)) {
      flushGridRow();
      rows.push({ type: "wide", question });
      continue;
    }
    let currentCell = gridCells[gridCells.length - 1];
    if (currentCell.length === gridCellQuestions) {
      if (gridCells.length === OBJECTIVE_STANDARD_COLUMNS) {
        flushGridRow();
      } else {
        gridCells.push([]);
      }
      currentCell = gridCells[gridCells.length - 1];
    }
    currentCell.push(question);
  }
  flushGridRow();
  return rows;
}
function objectivePhysicalRowsForRows(rows) {
  return rows.reduce((sum, row) => {
    if (row.type === "grid") {
      return sum + Math.max(...row.cells.map((cell) => cell.length));
    }
    return sum + 1;
  }, 0);
}
function objectivePhysicalRowsForQuestions(questions, mode) {
  return objectivePhysicalRowsForRows(objectiveRowsForQuestions(questions, mode));
}
function objectiveRowHeight(row) {
  if (row.type === "grid") {
    return Math.max(...row.cells.map((cell) => cell.length));
  }
  return 1;
}
function objectivePhysicalRowOffsets(rows, mode) {
  const offsets = [];
  let yOffset = 0;
  rows.forEach((row, rowIndex) => {
    const rowHeight = objectiveRowHeight(row);
    for (let offset = 0; offset < rowHeight; offset += 1) {
      offsets.push(round(yOffset + offset * OBJECTIVE_SETTINGS.rowHeight));
    }
    yOffset += rowHeight * OBJECTIVE_SETTINGS.rowHeight;
    if (mode !== "rows" && rowIndex < rows.length - 1) {
      yOffset += OBJECTIVE_GRID_ROW_GAP;
    }
  });
  return offsets;
}
function objectiveSegmentQuestionsForMaxRows(questions, mode, maxRows) {
  let segment = [];
  for (const question of questions) {
    const candidate = [...segment, question];
    const candidateRows = objectivePhysicalRowsForQuestions(candidate, mode);
    if (candidateRows > maxRows && segment.length > 0) {
      return segment;
    }
    segment = candidate;
  }
  return segment.length > 0 ? segment : questions.slice(0, 1);
}
function objectiveHeightForQuestions(questions, mode) {
  const rows = objectiveRowsForQuestions(questions, mode);
  const rowOffsets = objectivePhysicalRowOffsets(rows, mode);
  if (rowOffsets.length === 0) {
    return OBJECTIVE_FRAME_TOP + OBJECTIVE_INNER_TOP + OBJECTIVE_INNER_BOTTOM;
  }
  const settings = OBJECTIVE_SETTINGS;
  let contentBottom = 0;
  let physicalRow = 0;
  for (const row of rows) {
    const heightInRows = objectiveRowHeight(row);
    const lastOffset = rowOffsets[physicalRow + heightInRows - 1] ?? (physicalRow + heightInRows - 1) * settings.rowHeight;
    contentBottom = Math.max(contentBottom, lastOffset + OBJECTIVE_OPTION_TOP_OFFSET + settings.optionHeight);
    physicalRow += heightInRows;
  }
  return OBJECTIVE_FRAME_TOP + OBJECTIVE_INNER_TOP + contentBottom + OBJECTIVE_INNER_BOTTOM;
}
function objectiveMaxRowsForAvailableHeight(height) {
  const firstRowHeight = OBJECTIVE_FRAME_TOP + OBJECTIVE_INNER_TOP + OBJECTIVE_SETTINGS.optionHeight + OBJECTIVE_INNER_BOTTOM;
  if (height <= firstRowHeight) return 1;
  return Math.max(1, Math.floor((height - firstRowHeight) / OBJECTIVE_SETTINGS.rowHeight) + 1);
}
function addObjectiveSegment(page, block, title, questions, mode, y) {
  const settings = OBJECTIVE_SETTINGS;
  const objectiveRows = objectiveRowsForQuestions(questions, mode);
  const rowOffsets = objectivePhysicalRowOffsets(objectiveRows, mode);
  const blockHeight = objectiveHeightForQuestions(questions, mode);
  const blockRect = rect(MARGIN_X, y, BODY_WIDTH, blockHeight);
  const frameRect = rect(MARGIN_X, y + OBJECTIVE_FRAME_TOP, BODY_WIDTH, blockHeight - OBJECTIVE_FRAME_TOP);
  const itemAreaY = frameRect.y + OBJECTIVE_INNER_TOP;
  const contentStartX = frameRect.x + OBJECTIVE_CONTENT_SIDE_INSET;
  const contentWidth = frameRect.width - OBJECTIVE_CONTENT_SIDE_INSET * 2;
  const columnWidth = contentWidth / OBJECTIVE_STANDARD_COLUMNS;
  const rowMarkers = rowOffsets.map((rowOffset, row) => {
    const markerY = itemAreaY + rowOffset + OBJECTIVE_OPTION_TOP_OFFSET + (settings.optionHeight - OBJECTIVE_ROW_MARKER_SIZE) / 2;
    const left = rect(frameRect.x + 3.4, markerY, OBJECTIVE_ROW_MARKER_SIZE, OBJECTIVE_ROW_MARKER_SIZE);
    const right = rect(frameRect.x + frameRect.width - 5.6, markerY, OBJECTIVE_ROW_MARKER_SIZE, OBJECTIVE_ROW_MARKER_SIZE);
    page.elements.push({
      id: `p${page.pageNumber}_obj_marker_${block.id}_${row}_left`,
      type: "objective_row_marker",
      blockId: block.id,
      row,
      side: "left",
      rect: left
    });
    page.elements.push({
      id: `p${page.pageNumber}_obj_marker_${block.id}_${row}_right`,
      type: "objective_row_marker",
      blockId: block.id,
      row,
      side: "right",
      rect: right
    });
    return { row, left, right };
  });
  const items = {
    type: "objective",
    blockId: block.id,
    title,
    rect: blockRect,
    frameRect,
    rowMarkers,
    items: [],
    density: "compact"
  };
  const addObjectiveQuestion = (question, column, physicalRow2) => {
    const questionNumber = question.questionNumber;
    const labelTextX = contentStartX + column * columnWidth;
    const labelX = labelTextX + 2.5;
    const rowOffset = rowOffsets[physicalRow2] ?? physicalRow2 * settings.rowHeight;
    const labelY = itemAreaY + rowOffset + 2.9;
    const optionStartX = labelTextX + OBJECTIVE_LABEL_TO_OPTION_GAP;
    const options = OPTIONS.slice(0, question.optionCount).map((label, optionIndex) => {
      const optionRect = rect(
        optionStartX + optionIndex * settings.optionGap,
        itemAreaY + rowOffset + OBJECTIVE_OPTION_TOP_OFFSET,
        settings.optionWidth,
        settings.optionHeight
      );
      page.elements.push({
        id: `p${page.pageNumber}_obj_${block.id}_${questionNumber}_${label}`,
        type: "objective_option",
        blockId: block.id,
        questionNumber,
        option: label,
        rect: optionRect
      });
      return { label, rect: optionRect };
    });
    items.items.push({ questionNumber, options, labelX: round(labelX), labelY: round(labelY) });
  };
  let physicalRow = 0;
  for (const objectiveRow of objectiveRows) {
    if (objectiveRow.type === "wide") {
      addObjectiveQuestion(objectiveRow.question, 0, physicalRow);
      physicalRow += 1;
      continue;
    }
    if (objectiveRow.type === "standard") {
      objectiveRow.questions.forEach((question, column) => addObjectiveQuestion(question, column, physicalRow));
      physicalRow += 1;
      continue;
    }
    const rowHeight = Math.max(...objectiveRow.cells.map((cell) => cell.length));
    objectiveRow.cells.forEach((cell, column) => {
      cell.forEach((question, offset) => addObjectiveQuestion(question, column, physicalRow + offset));
    });
    physicalRow += rowHeight;
  }
  page.blocks.push(items);
  return y + blockHeight + 4;
}
function getScoreValues(score) {
  if (score > 16) {
    const maxTens = Math.min(60, Math.floor(score / 10) * 10);
    const tens = Array.from({ length: Math.max(0, maxTens / 10) }, (_, index) => maxTens - index * 10).filter(
      (value) => value >= 10
    );
    return [...tens, null, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0.5];
  }
  const values = [];
  for (let value = score; value >= 0; value -= 1) {
    values.push(value);
  }
  if (!Number.isInteger(score)) {
    return values;
  }
  values.push(0.5);
  return values;
}
function addManualScoreCells(page, block, question, y, rightX) {
  const values = getScoreValues(question.score);
  const startX = rightX - values.length * SCORE_CELL_WIDTH - 2;
  return values.map((score, index) => {
    const scoreRect = rect(startX + index * SCORE_CELL_WIDTH, y, SCORE_CELL_WIDTH - 0.8, SCORE_CELL_HEIGHT);
    if (score !== null) {
      page.elements.push({
        id: `p${page.pageNumber}_score_${block.id}_${question.id}_${score}`,
        type: "score_cell",
        blockId: block.id,
        questionId: question.id,
        questionNumber: question.number,
        score,
        rect: scoreRect
      });
    }
    return { score, rect: scoreRect };
  }).filter((cell) => cell.score !== null);
}
function blankQuestionCount(question) {
  return Math.max(1, question.blanks?.items?.length ?? question.blanks?.count ?? 1);
}
function blankLineSpecs(question) {
  const fallbackWidth = question.blanks?.widthMm ?? 22;
  const fallbackHeight = question.blanks?.heightMm ?? 6;
  const items = question.blanks?.items;
  if (items?.length) {
    return items.map((item, index) => ({
      label: item.label ?? formatBlankLabel(question.blanks?.labelStyle, index),
      widthMm: item.widthMm || fallbackWidth,
      heightMm: item.heightMm || fallbackHeight
    }));
  }
  return Array.from({ length: blankQuestionCount(question) }, (_, index) => ({
    label: formatBlankLabel(question.blanks?.labelStyle, index),
    widthMm: fallbackWidth,
    heightMm: fallbackHeight
  }));
}
function blankQuestionLineWidth(question) {
  return Math.max(22, ...blankLineSpecs(question).map((item) => item.widthMm));
}
function blankQuestionLineHeight(question) {
  return Math.max(6, ...blankLineSpecs(question).map((item) => item.heightMm));
}
function blankMinimumLineWidth(question) {
  return Math.max(BLANK_MIN_LINE_WIDTH, blankQuestionLineWidth(question) * BLANK_MAX_SHRINK_RATIO);
}
function blankLabelWidth(question, index) {
  const label = blankLineSpecs(question)[index]?.label ?? "";
  return label ? label.length * 1.8 + 0.8 : 0;
}
function maxBlankLabelWidth(question) {
  return Math.max(0, ...blankLineSpecs(question).map((_, index) => blankLabelWidth(question, index)));
}
function blankColumnLineWidth(question, columnW, labelSlotWidth) {
  const blankCount = blankQuestionCount(question);
  const labelWidth = labelSlotWidth * blankCount;
  const availableLineWidth = (columnW - BLANK_NUMBER_WIDTH - labelWidth - BLANK_INNER_GAP_X * Math.max(0, blankCount - 1) - 2) / blankCount;
  return Math.min(
    blankQuestionLineWidth(question),
    Math.max(blankMinimumLineWidth(question), availableLineWidth)
  );
}
function blankQuestionFitsColumn(question, columnW, labelSlotWidth) {
  const blankCount = blankQuestionCount(question);
  const labelWidth = labelSlotWidth * blankCount;
  const availableLineWidth = (columnW - BLANK_NUMBER_WIDTH - labelWidth - BLANK_INNER_GAP_X * Math.max(0, blankCount - 1) - 2) / blankCount;
  return availableLineWidth >= blankMinimumLineWidth(question);
}
function blankBlockColumnCount(questions) {
  const labelSlotWidth = Math.max(0, ...questions.map(maxBlankLabelWidth));
  const usableW = BODY_WIDTH - BLANK_BLOCK_INSET_X * 2;
  const maxColumns = Math.min(BLANK_MAX_COLUMNS, questions.length);
  for (let columns = maxColumns; columns >= 1; columns -= 1) {
    const columnW = (usableW - BLANK_ITEM_GAP_X * (columns - 1)) / columns;
    if (questions.every((question) => blankQuestionFitsColumn(question, columnW, labelSlotWidth))) {
      return columns;
    }
  }
  return 1;
}
function blankScoreQuestion(questions) {
  return questions.find((question) => question.style === "manual_score_grid") ?? questions[0];
}
function answerBlankLabelWidth(spec) {
  return spec.label ? spec.label.length * 1.8 + 0.8 : 0;
}
function layoutAnswerBlankLines(question, contentRect) {
  const specs = blankLineSpecs(question);
  const gapX = 6;
  const gapY = 5;
  const leftInset = 8;
  const usableWidth = contentRect.width - leftInset - 6;
  let x = contentRect.x + leftInset;
  let y = contentRect.y + 13;
  let rowHeight = 0;
  const placed = [];
  specs.forEach((spec) => {
    const labelWidth = answerBlankLabelWidth(spec);
    const itemWidth = labelWidth + spec.widthMm;
    const rowHasItems = x > contentRect.x + leftInset;
    if (rowHasItems && x + itemWidth > contentRect.x + leftInset + usableWidth) {
      x = contentRect.x + leftInset;
      y += rowHeight + gapY;
      rowHeight = 0;
    }
    const blankX = x + labelWidth;
    const blankRect = rect(blankX, y, spec.widthMm, spec.heightMm);
    placed.push({ ...spec, rect: blankRect });
    x = blankX + spec.widthMm + gapX;
    rowHeight = Math.max(rowHeight, spec.heightMm);
  });
  return placed;
}
function answerBlankLinesHeight(question) {
  const contentRect = rect(0, 0, BODY_WIDTH, 1);
  const placed = layoutAnswerBlankLines(question, contentRect);
  if (placed.length === 0) return 0;
  const bottom = Math.max(...placed.map((item) => item.rect.y + item.rect.height));
  return bottom + 8;
}
function subjectiveQuestionHeight(question) {
  const scoreHeader = question.style === "manual_score_grid" ? 11 : 0;
  const blanksHeight = question.kind === "blank" ? answerBlankLinesHeight(question) : 0;
  const imageHeight = (question.images ?? []).reduce((sum, image) => sum + image.heightMm + 3, 0);
  return Math.max(question.minHeightMm, 18 + scoreHeader + blanksHeight + imageHeight);
}
function blankSubjectiveSegmentHeight(questions, blockTitle, includeScoreHeader = true) {
  const titleH = blockTitle ? titleHeight() : 0;
  const scoreHeader = includeScoreHeader && blankScoreQuestion(questions) ? BLANK_SCORE_HEADER_HEIGHT : 0;
  const rows = Math.ceil(questions.length / blankBlockColumnCount(questions));
  return titleH + scoreHeader + BLANK_BLOCK_INSET_Y * 2 + rows * BLANK_ITEM_ROW_HEIGHT;
}
function addSubjectiveQuestion(page, block, question, blockTitle, y) {
  const height = subjectiveQuestionHeight(question);
  const blockRect = rect(MARGIN_X, y, BODY_WIDTH, height);
  const titleH = blockTitle ? titleHeight() : 0;
  const questionY = y + titleH;
  const questionRect = rect(MARGIN_X, questionY, BODY_WIDTH, height - titleH);
  const scoreHeaderH = question.style === "manual_score_grid" ? SCORE_HEADER_HEIGHT : 0;
  const contentRect = rect(
    questionRect.x,
    questionRect.y + scoreHeaderH,
    questionRect.width,
    questionRect.height - scoreHeaderH
  );
  const scoreCells = [];
  const lineYs = [];
  const blanks = [];
  const blankLabels = [];
  const images = [];
  if (question.style === "manual_score_grid") {
    scoreCells.push(...addManualScoreCells(page, block, question, questionRect.y + 1.6, MARGIN_X + BODY_WIDTH));
  }
  if (question.kind === "lined_answer" && question.lineGrid?.enabled) {
    const spacing = question.lineGrid.lineSpacingMm || 8;
    for (let lineY = contentRect.y + 12; lineY < contentRect.y + contentRect.height - 5; lineY += spacing) {
      lineYs.push(round(lineY));
    }
  }
  if (question.kind === "blank") {
    const placedBlanks = layoutAnswerBlankLines(question, contentRect);
    blanks.push(...placedBlanks.map((item) => item.rect));
    blankLabels.push(...placedBlanks.map((item) => item.label));
  }
  let imageY = contentRect.y + 12;
  for (const image of question.images ?? []) {
    const x = image.align === "center" ? MARGIN_X + (BODY_WIDTH - image.widthMm) / 2 : image.align === "right" ? MARGIN_X + BODY_WIDTH - image.widthMm - 4 : MARGIN_X + 6;
    const imageRect = rect(x, imageY, image.widthMm, image.heightMm);
    images.push({ assetId: image.assetId, originalName: image.originalName, rect: imageRect });
    page.elements.push({
      id: `p${page.pageNumber}_image_${block.id}_${question.id}_${image.assetId}`,
      type: "image_area",
      blockId: block.id,
      questionId: question.id,
      assetId: image.assetId,
      rect: imageRect
    });
    imageY += image.heightMm + 3;
  }
  page.elements.push({
    id: `p${page.pageNumber}_subj_${block.id}_${question.id}`,
    type: "subjective_box",
    blockId: block.id,
    questionId: question.id,
    questionNumber: question.number,
    rect: questionRect
  });
  page.blocks.push({
    type: "subjective",
    blockId: block.id,
    title: blockTitle,
    rect: blockRect,
    questions: [
      {
        blockId: block.id,
        questionId: question.id,
        questionNumber: question.number,
        score: question.score,
        style: question.style,
        kind: question.kind,
        rect: questionRect,
        contentRect,
        scoreCells,
        lineYs,
        blanks,
        blankLabels,
        blankLabelStyle: question.blanks?.labelStyle,
        blankLabelSlotWidth: maxBlankLabelWidth(question),
        images
      }
    ]
  });
  return y + height + 4;
}
function addBlankSubjectiveSegment(page, block, questions, blockTitle, includeScoreHeader, y) {
  const height = blankSubjectiveSegmentHeight(questions, blockTitle, includeScoreHeader);
  const titleH = blockTitle ? titleHeight() : 0;
  const blockRect = rect(MARGIN_X, y, BODY_WIDTH, height);
  const frameRect = rect(MARGIN_X, y + titleH, BODY_WIDTH, height - titleH);
  const renderQuestions = [];
  const columns = blankBlockColumnCount(questions);
  const itemAreaW = frameRect.width - BLANK_BLOCK_INSET_X * 2;
  const columnW = itemAreaW / columns;
  const scoreQuestion = includeScoreHeader ? blankScoreQuestion(questions) : void 0;
  const scoreCellsByQuestionId = /* @__PURE__ */ new Map();
  const scoreHeader = scoreQuestion ? BLANK_SCORE_HEADER_HEIGHT : 0;
  const blankLabelSlotWidth = Math.max(0, ...questions.map(maxBlankLabelWidth));
  if (scoreQuestion) {
    scoreCellsByQuestionId.set(
      scoreQuestion.id,
      addManualScoreCells(page, block, scoreQuestion, frameRect.y + 1.6, frameRect.x + frameRect.width)
    );
  }
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const col = index % columns;
    const row = Math.floor(index / columns);
    const itemX = frameRect.x + BLANK_BLOCK_INSET_X + col * (columnW + BLANK_ITEM_GAP_X);
    const itemY = frameRect.y + scoreHeader + BLANK_BLOCK_INSET_Y + row * BLANK_ITEM_ROW_HEIGHT;
    const specs = blankLineSpecs(question);
    const blankCount = specs.length;
    const lineW = blankColumnLineWidth(question, columnW, blankLabelSlotWidth);
    const lineH = blankQuestionLineHeight(question);
    let blankX = itemX + BLANK_NUMBER_WIDTH;
    const blanks = [];
    for (let blankIndex = 0; blankIndex < blankCount; blankIndex += 1) {
      blankX += blankLabelSlotWidth;
      blanks.push(rect(blankX, itemY + 2, lineW, lineH));
      blankX += lineW + BLANK_INNER_GAP_X;
    }
    const questionRect = rect(itemX, itemY, Math.min(columnW - 1, blankX - itemX - BLANK_INNER_GAP_X + 1), BLANK_ITEM_ROW_HEIGHT);
    page.elements.push({
      id: `p${page.pageNumber}_subj_${block.id}_${question.id}`,
      type: "subjective_box",
      blockId: block.id,
      questionId: question.id,
      questionNumber: question.number,
      rect: questionRect
    });
    renderQuestions.push({
      blockId: block.id,
      questionId: question.id,
      questionNumber: question.number,
      score: question.score,
      style: question.id === scoreQuestion?.id ? "manual_score_grid" : "plain_subjective",
      kind: question.kind,
      rect: questionRect,
      contentRect: questionRect,
      scoreCells: scoreCellsByQuestionId.get(question.id) ?? [],
      lineYs: [],
      blanks,
      blankLabels: specs.map((item) => item.label),
      blankLabelStyle: question.blanks?.labelStyle,
      blankLabelSlotWidth,
      images: []
    });
  }
  page.blocks.push({
    type: "subjective",
    blockId: block.id,
    title: blockTitle,
    rect: blockRect,
    frameRect,
    questions: renderQuestions
  });
  return y + height + 4;
}
function availableHeight(y) {
  return bodyBottom() - y;
}
function firstBodyY(card, page) {
  const studentArea = layoutStudentArea(card, page, 48);
  return studentArea.digitRect.y + studentArea.digitRect.height + 5;
}
function nextPageY() {
  return 36;
}
function buildLayout(card) {
  const warnings = [];
  const pages = [createPage(card, 1, true)];
  let page = pages[0];
  let y = firstBodyY(card, page);
  const newPage = () => {
    page = createPage(card, pages.length + 1, false);
    pages.push(page);
    y = nextPageY();
  };
  const ensureSpace = (height) => {
    if (height > availableHeight(y) && page.blocks.length > 0) {
      newPage();
    }
  };
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") {
      let remaining = objectiveQuestionDefinitions(block);
      const arrangementMode = objectiveArrangementMode(remaining);
      let firstSegment = true;
      while (remaining.length > 0) {
        let maxRows = objectiveMaxRowsForAvailableHeight(availableHeight(y));
        const nextObjectiveRow = objectiveRowsForQuestions(remaining, arrangementMode)[0];
        const nextRowHeight = nextObjectiveRow ? objectivePhysicalRowsForRows([nextObjectiveRow]) : 1;
        if (page.blocks.length > 0 && nextRowHeight > maxRows) {
          newPage();
          maxRows = objectiveMaxRowsForAvailableHeight(availableHeight(y));
        }
        const segmentQuestions = objectiveSegmentQuestionsForMaxRows(remaining, arrangementMode, maxRows);
        const height = objectiveHeightForQuestions(segmentQuestions, arrangementMode);
        ensureSpace(height);
        if (height > availableHeight(y)) {
          warnings.push(`${block.title} \u7684\u9898\u91CF\u8F83\u591A\uFF0C\u5F53\u524D\u5BC6\u5EA6\u4E0B\u5355\u9875\u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u5DF2\u5C3D\u91CF\u5206\u9875\u6392\u7248\u3002`);
        }
        y = addObjectiveSegment(
          page,
          block,
          firstSegment ? block.title : `${block.title}\uFF08\u7EED\uFF09`,
          segmentQuestions,
          arrangementMode,
          y
        );
        remaining = remaining.slice(segmentQuestions.length);
        firstSegment = false;
        if (remaining.length > 0) {
          newPage();
        }
      }
      continue;
    }
    layoutSubjectiveBlock(block, ensureSpace, newPage, () => page, (nextY) => {
      y = nextY;
    }, () => y);
  }
  const allElements = pages.flatMap((item) => item.elements);
  return {
    cardId: card.id,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    pages,
    elements: allElements,
    warnings
  };
}
function layoutSubjectiveBlock(block, ensureSpace, newPage, getPage, setY, getY) {
  const isFillBlankBlock = block.blockKind === "fill_blank" || !block.blockKind && !block.title.includes("\u89E3\u7B54") && block.questions.length > 0 && block.questions.every((question) => question.kind === "blank");
  if (isFillBlankBlock) {
    let remaining = [...block.questions];
    let firstSegment = true;
    while (remaining.length > 0) {
      const title = firstSegment ? block.title : `${block.title}\uFF08\u7EED\uFF09`;
      const firstHeight = blankSubjectiveSegmentHeight([remaining[0]], title, firstSegment);
      ensureSpace(firstHeight);
      if (firstHeight > availableHeight(getY()) && getPage().blocks.length > 0) {
        newPage();
      }
      let count = 0;
      let height = firstHeight;
      for (let index = 1; index <= remaining.length; index += 1) {
        const nextQuestions = remaining.slice(0, index);
        const nextHeight = blankSubjectiveSegmentHeight(nextQuestions, title, firstSegment);
        if (index > 1 && nextHeight > availableHeight(getY())) break;
        count = index;
        height = nextHeight;
      }
      const segmentQuestions = remaining.slice(0, Math.max(1, count));
      const nextY = addBlankSubjectiveSegment(getPage(), block, segmentQuestions, title, firstSegment, getY());
      setY(nextY);
      remaining = remaining.slice(segmentQuestions.length);
      firstSegment = false;
      if (remaining.length > 0) {
        newPage();
      }
    }
    return;
  }
  let firstQuestion = true;
  for (const question of block.questions) {
    const title = firstQuestion ? block.title : "";
    const height = subjectiveQuestionHeight(question) + (title ? titleHeight() : 0);
    ensureSpace(height);
    if (height > availableHeight(getY()) && getPage().blocks.length > 0) {
      newPage();
    }
    const nextY = addSubjectiveQuestion(getPage(), block, question, title, getY());
    setY(nextY);
    firstQuestion = false;
  }
}
var PAGE_WIDTH, PAGE_HEIGHT, MARGIN_X, BOTTOM_MARGIN, BODY_WIDTH, OPTIONS, DENSITY, OBJECTIVE_SETTINGS, OBJECTIVE_FRAME_TOP, OBJECTIVE_INNER_TOP, OBJECTIVE_INNER_BOTTOM, OBJECTIVE_ROW_MARKER_SIZE, OBJECTIVE_OPTION_TOP_OFFSET, OBJECTIVE_CONTENT_SIDE_INSET, OBJECTIVE_LABEL_TO_OPTION_GAP, OBJECTIVE_STANDARD_COLUMNS, OBJECTIVE_GRID_CELL_QUESTIONS, OBJECTIVE_VERTICAL_GROUP_QUESTIONS, OBJECTIVE_WIDE_OPTION_THRESHOLD, OBJECTIVE_GRID_ROW_GAP, SCORE_CELL_WIDTH, SCORE_CELL_HEIGHT, SCORE_HEADER_HEIGHT, BLANK_BLOCK_INSET_X, BLANK_BLOCK_INSET_Y, BLANK_ITEM_GAP_X, BLANK_ITEM_ROW_HEIGHT, BLANK_NUMBER_WIDTH, BLANK_SCORE_HEADER_HEIGHT, BLANK_INNER_GAP_X, BLANK_MAX_COLUMNS, BLANK_MIN_LINE_WIDTH, BLANK_MAX_SHRINK_RATIO;
var init_layout = __esm({
  "src/shared/layout.ts"() {
    "use strict";
    init_blankLabels();
    init_grading();
    PAGE_WIDTH = 210;
    PAGE_HEIGHT = 297;
    MARGIN_X = 17;
    BOTTOM_MARGIN = 18;
    BODY_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
    OPTIONS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    DENSITY = {
      loose: { maxColumns: 4, rowHeight: 7.7, optionGap: 8.1, optionWidth: 5.1, optionHeight: 3, questionGap: 6.4 },
      normal: { maxColumns: 4, rowHeight: 6.7, optionGap: 7.4, optionWidth: 4.8, optionHeight: 2.8, questionGap: 5.6 },
      compact: { maxColumns: 5, rowHeight: 5.9, optionGap: 6.7, optionWidth: 4.4, optionHeight: 2.5, questionGap: 4.8 },
      dense: { maxColumns: 6, rowHeight: 5.2, optionGap: 6, optionWidth: 4.1, optionHeight: 2.3, questionGap: 4.2 }
    };
    OBJECTIVE_SETTINGS = DENSITY.compact;
    OBJECTIVE_FRAME_TOP = 6.2;
    OBJECTIVE_INNER_TOP = 2.4;
    OBJECTIVE_INNER_BOTTOM = 2.2;
    OBJECTIVE_ROW_MARKER_SIZE = 2.2;
    OBJECTIVE_OPTION_TOP_OFFSET = 0.9;
    OBJECTIVE_CONTENT_SIDE_INSET = 8.5;
    OBJECTIVE_LABEL_TO_OPTION_GAP = 6.3;
    OBJECTIVE_STANDARD_COLUMNS = 4;
    OBJECTIVE_GRID_CELL_QUESTIONS = 5;
    OBJECTIVE_VERTICAL_GROUP_QUESTIONS = 4;
    OBJECTIVE_WIDE_OPTION_THRESHOLD = 5;
    OBJECTIVE_GRID_ROW_GAP = 1.5;
    SCORE_CELL_WIDTH = 7.6;
    SCORE_CELL_HEIGHT = 6;
    SCORE_HEADER_HEIGHT = 10;
    BLANK_BLOCK_INSET_X = 6;
    BLANK_BLOCK_INSET_Y = 3;
    BLANK_ITEM_GAP_X = 1.6;
    BLANK_ITEM_ROW_HEIGHT = 13;
    BLANK_NUMBER_WIDTH = 8;
    BLANK_SCORE_HEADER_HEIGHT = 7;
    BLANK_INNER_GAP_X = 2.4;
    BLANK_MAX_COLUMNS = 5;
    BLANK_MIN_LINE_WIDTH = 16;
    BLANK_MAX_SHRINK_RATIO = 0.7;
  }
});

// src/apps/answer-card/server/storage.ts
var storage_exports = {};
__export(storage_exports, {
  assetReadStream: () => assetReadStream,
  assetsDir: () => assetsDir,
  cardAssetsDir: () => cardAssetsDir,
  cardPath: () => cardPath,
  cardsDir: () => cardsDir,
  createCard: () => createCard,
  dataDir: () => dataDir,
  ensureDataDirs: () => ensureDataDirs,
  layoutPath: () => layoutPath,
  layoutsDir: () => layoutsDir,
  listCards: () => listCards,
  readCard: () => readCard,
  readLayout: () => readLayout,
  rootDir: () => rootDir2,
  safeId: () => safeId,
  saveCard: () => saveCard,
  saveLayout: () => saveLayout
});
import { createReadStream, existsSync as existsSync5 } from "node:fs";
import { mkdir as mkdir2, readdir as readdir2, readFile as readFile2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import path7 from "node:path";
import { randomInt } from "node:crypto";
async function ensureDataDirs() {
  await mkdir2(cardsDir, { recursive: true });
  await mkdir2(assetsDir, { recursive: true });
  await mkdir2(layoutsDir, { recursive: true });
}
function cardPath(cardId) {
  return path7.join(cardsDir, `${safeId(cardId)}.json`);
}
function layoutPath(cardId) {
  return path7.join(layoutsDir, `${safeId(cardId)}.json`);
}
function cardAssetsDir(cardId) {
  return path7.join(assetsDir, safeId(cardId));
}
function safeId(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}
async function createCard() {
  await ensureDataDirs();
  let id = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    id = String(randomInt(0, 1e8)).padStart(8, "0");
    if (!existsSync5(cardPath(id))) break;
  }
  const card = createDefaultCard(id);
  await saveCard(card);
  return card;
}
async function listCards() {
  await ensureDataDirs();
  const files = await readdir2(cardsDir);
  const summaries = await Promise.all(
    files.filter((file) => file.endsWith(".json")).map(async (file) => {
      const fullPath = path7.join(cardsDir, file);
      const raw = await readFile2(fullPath, "utf8");
      const card = JSON.parse(raw);
      const info = await stat2(fullPath);
      return {
        id: card.id,
        title: card.title || "\u672A\u547D\u540D\u7B54\u9898\u5361",
        updatedAt: card.updatedAt || info.mtime.toISOString()
      };
    })
  );
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function readCard(cardId) {
  await ensureDataDirs();
  const fullPath = cardPath(cardId);
  if (!existsSync5(fullPath)) return null;
  const raw = await readFile2(fullPath, "utf8");
  return JSON.parse(raw);
}
async function saveCard(card) {
  await ensureDataDirs();
  const normalized = {
    ...card,
    id: safeId(card.id),
    bodyBlocks: card.bodyBlocks.map(
      (block) => block.type === "objective" ? { ...block, answerKey: normalizeObjectiveAnswerKey(block) } : block
    ),
    paper: { size: "A4", orientation: "portrait" },
    layoutVersion: 1,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeFile2(cardPath(normalized.id), JSON.stringify(normalized, null, 2), "utf8");
  await saveLayout(normalized);
  return normalized;
}
async function saveLayout(card) {
  const layout = buildLayout(card);
  await writeFile2(layoutPath(card.id), JSON.stringify(layout, null, 2), "utf8");
  return layout;
}
async function readLayout(cardId) {
  await ensureDataDirs();
  const card = await readCard(cardId);
  if (!card) return null;
  return saveLayout(card);
}
function assetReadStream(cardId, assetId) {
  return createReadStream(path7.join(cardAssetsDir(cardId), path7.basename(assetId)));
}
var rootDir2, dataDir, cardsDir, assetsDir, layoutsDir;
var init_storage = __esm({
  "src/apps/answer-card/server/storage.ts"() {
    "use strict";
    init_defaultCard();
    init_grading();
    init_layout();
    rootDir2 = process.cwd();
    dataDir = process.env.ANSWER_CARD_DATA_DIR ? path7.resolve(process.env.ANSWER_CARD_DATA_DIR) : path7.join(rootDir2, "data", "answer-card");
    cardsDir = path7.join(dataDir, "cards");
    assetsDir = path7.join(dataDir, "assets");
    layoutsDir = path7.join(dataDir, "layouts");
  }
});

// src/apps/answer-card/server/database/scan-store.ts
var scan_store_exports = {};
__export(scan_store_exports, {
  createScanRecord: () => createScanRecord,
  createSession: () => createSession,
  deleteRecognitionResult: () => deleteRecognitionResult,
  deleteScanRecord: () => deleteScanRecord,
  deleteSession: () => deleteSession,
  findScansByStudentId: () => findScansByStudentId,
  getScanRecord: () => getScanRecord,
  getScanRecordWithResult: () => getScanRecordWithResult,
  getSession: () => getSession,
  incrementPageCount: () => incrementPageCount,
  listScanRecords: () => listScanRecords,
  listScanRecordsByCard: () => listScanRecordsByCard,
  listScanRecordsGroupedByStudent: () => listScanRecordsGroupedByStudent,
  listScansForCard: () => listScansForCard,
  listSessions: () => listSessions,
  listStudentGradingResults: () => listStudentGradingResults,
  updateScanOcrResult: () => updateScanOcrResult,
  updateScanQuality: () => updateScanQuality,
  updateSessionStatus: () => updateSessionStatus,
  upsertRecognitionResult: () => upsertRecognitionResult,
  upsertStudentGradingResult: () => upsertStudentGradingResult
});
import { randomUUID } from "node:crypto";
function db2() {
  return getMysqlDb();
}
function generateId() {
  return randomUUID();
}
async function createSession(cardId, name, config = {}) {
  const id = generateId();
  await db2().run(
    `
    INSERT INTO twain_scan_sessions (id, card_id, name, dpi, duplex, color_mode, paper_size, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `,
    id,
    cardId,
    name,
    config.dpi ?? 300,
    config.duplex ? 1 : 0,
    config.colorMode ?? "gray",
    config.paperSize ?? "A4"
  );
  return await getSession(id);
}
async function getSession(id) {
  return await db2().get("SELECT * FROM twain_scan_sessions WHERE id = ?", id);
}
async function listSessions(cardId) {
  if (cardId) {
    return await db2().all(
      "SELECT * FROM twain_scan_sessions WHERE card_id = ? ORDER BY created_at DESC",
      cardId
    );
  }
  return await db2().all("SELECT * FROM twain_scan_sessions ORDER BY created_at DESC");
}
async function updateSessionStatus(id, status, errorMsg) {
  await db2().run(
    "UPDATE twain_scan_sessions SET status = ?, error_msg = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    status,
    errorMsg ?? null,
    id
  );
}
async function incrementPageCount(id) {
  await db2().run(
    "UPDATE twain_scan_sessions SET page_count = page_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    id
  );
}
async function deleteSession(id) {
  await db2().run("DELETE FROM twain_scan_sessions WHERE id = ?", id);
}
async function createScanRecord(params) {
  const id = generateId();
  await db2().run(`
    INSERT INTO twain_scan_records (id, session_id, card_id, image_path, page_num, side, ocr_status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `, id, params.sessionId, params.cardId, params.imagePath, params.pageNum, params.side ?? "front");
  return await getScanRecord(id);
}
async function getScanRecord(id) {
  return await db2().get("SELECT * FROM twain_scan_records WHERE id = ?", id);
}
async function getScanRecordWithResult(id) {
  const record = await db2().get("SELECT * FROM twain_scan_records WHERE id = ?", id);
  if (!record) return void 0;
  const recognition = await db2().get(
    "SELECT * FROM twain_recognition_results WHERE scan_record_id = ?",
    id
  );
  return { ...record, recognition: recognition ?? null };
}
async function listScanRecords(sessionId) {
  return await db2().all(
    "SELECT * FROM twain_scan_records WHERE session_id = ? ORDER BY page_num, side",
    sessionId
  );
}
async function listScanRecordsByCard(cardId) {
  return await db2().all(
    "SELECT * FROM twain_scan_records WHERE card_id = ? ORDER BY created_at DESC",
    cardId
  );
}
async function updateScanOcrResult(id, studentId, studentConf, status, error) {
  await db2().run(`
    UPDATE twain_scan_records
    SET student_id = ?, student_conf = ?, ocr_status = ?, ocr_error = ?, recognized_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, studentId, studentConf, status, error ?? null, id);
}
async function updateScanQuality(id, quality) {
  await db2().run("UPDATE twain_scan_records SET scan_quality = ? WHERE id = ?", quality, id);
}
async function deleteScanRecord(id) {
  await db2().run("DELETE FROM twain_scan_records WHERE id = ?", id);
}
async function upsertRecognitionResult(params) {
  const d = db2();
  const existing = await d.get(
    "SELECT id FROM twain_recognition_results WHERE scan_record_id = ?",
    params.scanRecordId
  );
  if (existing) {
    await d.run(
      `
      UPDATE twain_recognition_results
      SET objective_json = COALESCE(?, objective_json),
          subjective_json = COALESCE(?, subjective_json),
          total_score = COALESCE(?, total_score),
          max_score = COALESCE(?, max_score),
          grade_status = COALESCE(?, grade_status)
      WHERE scan_record_id = ?
    `,
      params.objectiveJson ?? null,
      params.subjectiveJson ?? null,
      params.totalScore ?? null,
      params.maxScore ?? null,
      params.gradeStatus ?? null,
      params.scanRecordId
    );
  } else {
    const id = generateId();
    await d.run(
      `
      INSERT INTO twain_recognition_results (id, scan_record_id, objective_json, subjective_json, total_score, max_score, grade_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      id,
      params.scanRecordId,
      params.objectiveJson ?? null,
      params.subjectiveJson ?? null,
      params.totalScore ?? null,
      params.maxScore ?? null,
      params.gradeStatus ?? "pending"
    );
  }
  return await d.get(
    "SELECT * FROM twain_recognition_results WHERE scan_record_id = ?",
    params.scanRecordId
  );
}
async function deleteRecognitionResult(scanRecordId) {
  await db2().run("DELETE FROM twain_recognition_results WHERE scan_record_id = ?", scanRecordId);
}
async function upsertStudentGradingResult(params) {
  const d = db2();
  const sql = buildUpsertSQL(d.dialect, "twain_student_grading_results", SGR_UPSERT_COLS, SGR_CONFLICT_COLS, SGR_UPDATE_COLS);
  await d.run(
    sql,
    params.sessionId,
    params.studentId,
    params.objectiveJson ?? null,
    params.subjectiveJson ?? null,
    params.totalScore ?? null,
    params.maxScore ?? null,
    params.pageCount ?? 1
  );
}
async function listStudentGradingResults(sessionId) {
  return await db2().all(
    "SELECT * FROM twain_student_grading_results WHERE session_id = ? ORDER BY student_id",
    sessionId
  );
}
async function listScanRecordsGroupedByStudent(sessionId) {
  const d = db2();
  const records = await d.all(
    "SELECT * FROM twain_scan_records WHERE session_id = ? ORDER BY student_id, page_num, side",
    sessionId
  );
  const grouped = /* @__PURE__ */ new Map();
  for (const record of records) {
    const key = record.student_id ?? "__unrecognized__";
    if (!grouped.has(key)) grouped.set(key, []);
    const recognition = await d.get(
      "SELECT * FROM twain_recognition_results WHERE scan_record_id = ?",
      record.id
    );
    grouped.get(key).push({ ...record, recognition: recognition ?? null });
  }
  return Array.from(grouped.entries()).map(([studentId, recs]) => ({ studentId, records: recs }));
}
async function listScansForCard(cardId) {
  const d = db2();
  const records = await d.all(
    "SELECT * FROM twain_scan_records WHERE card_id = ? ORDER BY page_num, side",
    cardId
  );
  const results = [];
  for (const record of records) {
    const recognition = await d.get(
      "SELECT * FROM twain_recognition_results WHERE scan_record_id = ?",
      record.id
    );
    results.push({ record, recognition: recognition ?? null });
  }
  return results;
}
async function findScansByStudentId(cardId, studentId) {
  return await db2().all(
    "SELECT * FROM twain_scan_records WHERE card_id = ? AND student_id = ? ORDER BY created_at DESC",
    cardId,
    studentId
  );
}
var SGR_UPSERT_COLS, SGR_CONFLICT_COLS, SGR_UPDATE_COLS;
var init_scan_store = __esm({
  "src/apps/answer-card/server/database/scan-store.ts"() {
    "use strict";
    init_db();
    SGR_UPSERT_COLS = ["session_id", "student_id", "objective_json", "subjective_json", "total_score", "max_score", "page_count"];
    SGR_CONFLICT_COLS = ["session_id", "student_id"];
    SGR_UPDATE_COLS = ["objective_json", "subjective_json", "total_score", "max_score", "page_count"];
  }
});

// src/server/db/config.ts
var config_exports = {};
__export(config_exports, {
  readConfigFile: () => readConfigFile,
  readDbConfig: () => readDbConfig,
  writeConfigFile: () => writeConfigFile,
  writeDbConfig: () => writeDbConfig
});
import { readFileSync as readFileSync4, writeFileSync as writeFileSync3, existsSync as existsSync10 } from "node:fs";
import path13 from "node:path";
function configPath() {
  return path13.join(process.cwd(), "config.yml");
}
function readConfigFile() {
  const filePath = configPath();
  if (!existsSync10(filePath)) return null;
  try {
    const raw = readFileSync4(filePath, "utf8");
    if (!raw.trim() || raw.trim() === "{}") return {};
    return parseYaml(raw);
  } catch (err) {
    console.warn("[Config] Failed to read config.yml:", err);
    return null;
  }
}
function writeConfigFile(partial) {
  const existing = readConfigFile() ?? {};
  const merged = deepMerge(existing, partial);
  const yaml = stringifyYaml(merged);
  writeFileSync3(configPath(), yaml, "utf8");
}
function readDbConfig() {
  const config = readConfigFile();
  return config?.database ?? { mode: "local" };
}
function writeDbConfig(db3) {
  writeConfigFile({ database: db3 });
}
function parseYaml(raw) {
  const result = {};
  const lines = raw.split("\n");
  const stack = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.search(/\S/);
    const depth = Math.floor(indent / 2);
    while (stack.length > depth) stack.pop();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    const parent = stack.length > 0 ? stack[stack.length - 1].obj : result;
    if (value === "" || value === "{}") {
      const child = {};
      parent[key] = child;
      stack.push({ key, obj: child });
    } else {
      parent[key] = parseYamlValue(value);
    }
  }
  return result;
}
function parseYamlValue(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  if (/^\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  return v;
}
function stringifyYaml(obj, indent = 0) {
  if (obj === null || obj === void 0) return "null\n";
  if (typeof obj !== "object") return `${obj}
`;
  const lines = [];
  const prefix = "  ".repeat(indent);
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === void 0) {
      lines.push(`${prefix}${key}: null`);
    } else if (typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      lines.push(stringifyYaml(value, indent + 1).trimEnd());
    } else if (typeof value === "string") {
      const needsQuote = /[:#\{\}\[\],&*?!|>'"@`]/.test(value) || value === "" || value.includes("\n");
      lines.push(`${prefix}${key}: ${needsQuote ? `"${value.replace(/"/g, '\\"')}"` : value}`);
    } else {
      lines.push(`${prefix}${key}: ${value}`);
    }
  }
  return lines.join("\n") + "\n";
}
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
var init_config = __esm({
  "src/server/db/config.ts"() {
    "use strict";
  }
});

// src/apps/answer-card/server/index.ts
init_db();
import express12 from "express";
import multer from "multer";
import { cpus } from "node:os";
import path14 from "node:path";
import { existsSync as existsSync11 } from "node:fs";
import { mkdir as mkdir4, readFile as readFile3, rename, rm as rm2, writeFile as writeFile3 } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL as pathToFileURL2 } from "node:url";

// src/server/db/cleanup.ts
init_db();
import path4 from "node:path";
import { pathToFileURL } from "node:url";
import { rmSync } from "node:fs";
async function runCleanup(retainDays = 30) {
  const db3 = getMysqlDb();
  const result = {
    scanRecordsDeleted: 0,
    recognitionRecordsDeleted: 0,
    filesDeleted: 0,
    errors: []
  };
  const cutoffDate = /* @__PURE__ */ new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retainDays);
  const cutoffStr = cutoffDate.toISOString();
  console.log(`[Cleanup] \u5F00\u59CB\u6E05\u7406 ${retainDays} \u5929\u524D\u7684\u6570\u636E\uFF08\u622A\u6B62\uFF1A${cutoffDate.toLocaleDateString()}\uFF09`);
  try {
    await db3.transaction(async (tx) => {
      const expiredRecords = await tx.all(
        `SELECT id, file_path, batch_id FROM scan_records
         WHERE expires_at IS NOT NULL AND expires_at < ?`,
        cutoffStr
      );
      console.log(`[Cleanup] \u627E\u5230 ${expiredRecords.length} \u6761\u8FC7\u671F\u626B\u63CF\u8BB0\u5F55`);
      for (const record of expiredRecords) {
        if (record.file_path) {
          try {
            const fullPath = path4.isAbsolute(record.file_path) ? record.file_path : path4.resolve(process.cwd(), record.file_path);
            rmSync(fullPath, { force: true });
            result.filesDeleted++;
          } catch (error) {
            const msg = `\u5220\u9664\u6587\u4EF6\u5931\u8D25 ${record.file_path}: ${error instanceof Error ? error.message : String(error)}`;
            result.errors.push(msg);
            console.warn(`[Cleanup] ${msg}`);
          }
        }
      }
      const deletedRecognitions = await tx.run(
        `DELETE FROM objective_recognitions
         WHERE record_id IN (
           SELECT id FROM scan_records WHERE expires_at IS NOT NULL AND expires_at < ?
         )`,
        cutoffStr
      );
      result.recognitionRecordsDeleted = deletedRecognitions.changes;
      const clearedFiles = await tx.run(
        `UPDATE scan_records
         SET file_path = NULL, status = 'expired'
         WHERE expires_at IS NOT NULL AND expires_at < ? AND file_path IS NOT NULL`,
        cutoffStr
      );
      result.scanRecordsDeleted = clearedFiles.changes;
      const archivedExpired = await tx.get(
        `SELECT COUNT(*) as cnt FROM exam_archives
         WHERE is_deleted = 0 AND archived_at < ?`,
        cutoffStr
      );
      if (archivedExpired.cnt > 0) {
        console.log(`[Cleanup] \u6709 ${archivedExpired.cnt} \u6761\u5F52\u6863\u8BB0\u5F55\u8D85\u8FC7\u4FDD\u7559\u671F\uFF0C\u5EFA\u8BAE\u624B\u52A8\u5BA1\u67E5\u540E\u5220\u9664`);
      }
    });
    console.log(`[Cleanup] \u5B8C\u6210\uFF1A\u6E05\u9664 ${result.scanRecordsDeleted} \u6761\u6587\u4EF6\u8BB0\u5F55\uFF0C${result.recognitionRecordsDeleted} \u6761\u8BC6\u522B\u8BB0\u5F55\uFF0C${result.filesDeleted} \u4E2A\u6587\u4EF6`);
  } catch (error) {
    const msg = `\u6E05\u7406\u4E8B\u52A1\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}`;
    result.errors.push(msg);
    console.error(`[Cleanup] ${msg}`);
  }
  if (result.errors.length > 0) {
    console.warn(`[Cleanup] \u6709 ${result.errors.length} \u4E2A\u9519\u8BEF\uFF0C\u8BF7\u68C0\u67E5\u65E5\u5FD7`);
  }
  return result;
}
function scheduleCleanup(intervalHours = 24, retainDays = 30) {
  console.log(`[Cleanup] \u5B9A\u65F6\u6E05\u7406\u5DF2\u6CE8\u518C\uFF0C\u6BCF ${intervalHours} \u5C0F\u65F6\u6267\u884C\u4E00\u6B21\uFF0C\u4FDD\u7559\u671F ${retainDays} \u5929`);
  runCleanup(retainDays).catch((error) => {
    console.error("[Cleanup] \u9996\u6B21\u6267\u884C\u5931\u8D25:", error);
  });
  const intervalMs = intervalHours * 60 * 60 * 1e3;
  return setInterval(() => {
    runCleanup(retainDays).catch((error) => {
      console.error("[Cleanup] \u5B9A\u65F6\u6E05\u7406\u6267\u884C\u5931\u8D25:", error);
    });
  }, intervalMs);
}
var invokedPath = process.argv[1] ? path4.resolve(process.argv[1]) : "";
var isMain = invokedPath !== "" && /^cleanup\.(?:ts|js|mjs)$/.test(path4.basename(invokedPath)) && import.meta.url === pathToFileURL(invokedPath).href;
if (isMain) {
  const args = process.argv.slice(2);
  const days = args.length > 0 ? parseInt(args[0]) : 30;
  if (isNaN(days) || days < 0) {
    console.error("\u7528\u6CD5: npx tsx src/server/db/cleanup.ts [\u4FDD\u7559\u5929\u6570]");
    process.exit(1);
  }
  runCleanup(days).then((result) => {
    console.log("\u6E05\u7406\u7ED3\u679C:", JSON.stringify(result, null, 2));
    process.exit(0);
  }).catch((err) => {
    console.error("\u6E05\u7406\u5931\u8D25:", err);
    process.exit(1);
  });
}

// src/server/repositories/CardRepository.ts
init_db();
init_grading();
function normalizeOptionLayout(value) {
  return value === "vertical" ? "vertical" : "horizontal";
}
var CardRepository = class {
  db;
  constructor() {
    this.db = getMysqlDb();
  }
  async createCard(card, createdBy) {
    await this.db.run(
      `INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      card.id,
      card.title,
      card.subject ?? null,
      card.subjectLabel ?? null,
      card.examDate ?? null,
      card.paper?.size ?? "A4",
      card.paper?.orientation ?? "portrait",
      JSON.stringify(card.studentInfo?.fields ?? []),
      card.studentInfo?.studentNumberDigits ?? 5,
      card.sided ?? "double",
      card.layoutVersion ?? 1,
      createdBy ?? null
    );
  }
  async updateCard(card) {
    await this.db.run(
      `UPDATE answer_cards SET title = ?, subject = ?, subject_label = ?, exam_date = ?, student_fields = ?, student_number_digits = ?, sided = ?, layout_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      card.title,
      card.subject ?? null,
      card.subjectLabel ?? null,
      card.examDate ?? null,
      JSON.stringify(card.studentInfo?.fields ?? []),
      card.studentInfo?.studentNumberDigits ?? 5,
      card.sided ?? "double",
      card.layoutVersion ?? 1,
      card.id
    );
    await this.db.run("DELETE FROM objective_blocks WHERE card_id = ?", card.id);
    await this.db.run("DELETE FROM subjective_blocks WHERE card_id = ?", card.id);
    if (card.bodyBlocks) {
      for (const block of card.bodyBlocks) {
        if (block.type === "objective") await this.insertObjectiveBlock(block, card.id);
        else if (block.type === "subjective") await this.insertSubjectiveBlock(block, card.id);
      }
    }
  }
  async insertObjectiveBlock(block, cardId) {
    const questions = normalizeObjectiveQuestions(block);
    const firstQuestion = questions[0];
    const blockOptionLayout = normalizeOptionLayout(block.optionLayout);
    await this.db.run(
      `INSERT INTO objective_blocks (id, card_id, sort_order, title, question_start, question_count, option_count, mode, score_per_question, density, option_layout, wrong_or_extra_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      block.id,
      cardId,
      0,
      block.title ?? "",
      firstQuestion?.questionNumber ?? block.questionStart ?? 1,
      questions.length || block.questionCount || 0,
      firstQuestion?.optionCount ?? block.optionCount ?? 4,
      firstQuestion?.mode ?? block.mode ?? "single",
      firstQuestion?.score ?? block.scorePerQuestion ?? 0,
      block.density ?? "compact",
      blockOptionLayout,
      firstQuestion?.scoringRule?.wrongOrExtraScore ?? block.multipleScoring?.wrongOrExtraScore ?? 0
    );
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      await this.db.run(
        `INSERT INTO objective_questions (block_id, question_number, sort_order, mode, option_count, score, option_layout, scoring_rule_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) -- note: upsert handled by DELETE-then-INSERT in updateCard()`,
        block.id,
        question.questionNumber,
        i,
        question.mode,
        question.optionCount,
        question.score,
        normalizeOptionLayout(question.optionLayout ?? blockOptionLayout),
        question.scoringRule ? JSON.stringify(question.scoringRule) : null
      );
      if (question.answerKey && question.answerKey.length > 0) {
        await this.db.run(
          `INSERT INTO objective_answer_keys (block_id, question_number, correct_options)
           VALUES (?, ?, ?) -- note: upsert handled by DELETE-then-INSERT`,
          block.id,
          question.questionNumber,
          JSON.stringify(question.answerKey)
        );
      }
    }
    if (block.multipleScoring?.partialScores) {
      for (const [partialCount, score] of Object.entries(block.multipleScoring.partialScores)) {
        await this.db.run(
          `INSERT INTO objective_multiple_scoring (block_id, correct_count, score)
           VALUES (?, ?, ?) -- note: upsert handled by DELETE-then-INSERT`,
          block.id,
          Number(partialCount),
          score
        );
      }
    }
  }
  async insertSubjectiveBlock(block, cardId) {
    await this.db.run(
      `INSERT INTO subjective_blocks (id, card_id, sort_order, block_kind, title) VALUES (?, ?, ?, ?, ?)`,
      block.id,
      cardId,
      0,
      block.blockKind ?? (block.title?.includes("\u586B\u7A7A") ? "fill_blank" : "answer"),
      block.title ?? ""
    );
    if (block.questions) {
      for (const q of block.questions) {
        await this.db.run(
          `INSERT INTO subjective_questions (id, block_id, number, score, style, kind, min_height_mm, line_grid_enabled, line_spacing_mm, blanks_count, blanks_width_mm, blanks_height_mm, blanks_label_style, blanks_items_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          q.id,
          block.id,
          q.number,
          q.score,
          q.style ?? "manual_score_grid",
          q.kind ?? "plain_box",
          q.minHeightMm ?? 68,
          q.lineGrid?.enabled ? 1 : 0,
          q.lineGrid?.lineSpacingMm ?? 8,
          q.blanks?.count,
          q.blanks?.widthMm,
          q.blanks?.heightMm,
          q.blanks?.labelStyle,
          q.blanks?.items ? JSON.stringify(q.blanks.items) : void 0
        );
        if (q.images) {
          for (const img of q.images) {
            await this.db.run(
              `INSERT INTO subjective_question_images (question_id, asset_id, original_name, width_mm, height_mm, align)
               VALUES (?, ?, ?, ?, ?, ?)`,
              q.id,
              img.assetId,
              img.originalName,
              img.widthMm,
              img.heightMm,
              img.align ?? "left"
            );
          }
        }
      }
    }
  }
  async listCards() {
    return await this.db.all(`
      SELECT c.id, c.title, c.subject, c.subject_label, c.updated_at, u.name as created_by_name
      FROM answer_cards c LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.updated_at DESC
    `);
  }
  async findById(cardId) {
    const cardRow = await this.db.get("SELECT * FROM answer_cards WHERE id = ?", cardId);
    if (!cardRow) return null;
    const card = {
      id: cardRow.id,
      title: cardRow.title,
      subject: cardRow.subject ?? void 0,
      subjectLabel: cardRow.subject_label ?? void 0,
      examDate: cardRow.exam_date ?? void 0,
      paper: { size: cardRow.paper_size, orientation: cardRow.orientation },
      studentInfo: { fields: JSON.parse(cardRow.student_fields ?? "[]"), studentNumberDigits: cardRow.student_number_digits },
      bodyBlocks: [],
      sided: cardRow.sided ?? "double",
      layoutVersion: cardRow.layout_version,
      updatedAt: cardRow.updated_at
    };
    const objBlocks = await this.db.all("SELECT * FROM objective_blocks WHERE card_id = ? ORDER BY sort_order", cardId);
    for (const b of objBlocks) {
      const answerKeys = {};
      const keys = await this.db.all("SELECT * FROM objective_answer_keys WHERE block_id = ?", b.id);
      for (const k of keys) {
        answerKeys[k.question_number] = JSON.parse(k.correct_options);
      }
      const partialScores = {};
      const scores = await this.db.all("SELECT * FROM objective_multiple_scoring WHERE block_id = ?", b.id);
      for (const s of scores) {
        partialScores[s.correct_count] = s.score;
      }
      const questionRows = await this.db.all("SELECT * FROM objective_questions WHERE block_id = ? ORDER BY sort_order, question_number", b.id);
      const blockOptionLayout = normalizeOptionLayout(b.option_layout);
      const block = {
        id: b.id,
        type: "objective",
        title: b.title,
        questionStart: b.question_start,
        questionCount: b.question_count,
        optionCount: b.option_count,
        mode: b.mode,
        scorePerQuestion: b.score_per_question,
        density: b.density,
        optionLayout: blockOptionLayout,
        answerKey: answerKeys,
        multipleScoring: { partialScores, wrongOrExtraScore: b.wrong_or_extra_score },
        questions: questionRows.length > 0 ? questionRows.map((q) => ({
          questionNumber: q.question_number,
          mode: q.mode,
          optionCount: q.option_count,
          score: q.score,
          optionLayout: normalizeOptionLayout(q.option_layout ?? blockOptionLayout),
          answerKey: answerKeys[q.question_number] ?? [],
          scoringRule: q.scoring_rule_json ? JSON.parse(q.scoring_rule_json) : void 0
        })) : void 0
      };
      block.questions ??= normalizeObjectiveQuestions(block);
      card.bodyBlocks.push(block);
    }
    const subBlocks = await this.db.all("SELECT * FROM subjective_blocks WHERE card_id = ? ORDER BY sort_order", cardId);
    for (const b of subBlocks) {
      const questions = await this.db.all("SELECT * FROM subjective_questions WHERE block_id = ? ORDER BY sort_order", b.id);
      const questionsWithImages = await Promise.all(questions.map(async (q) => {
        const images = await this.db.all("SELECT * FROM subjective_question_images WHERE question_id = ? ORDER BY sort_order", q.id);
        return {
          id: q.id,
          number: q.number,
          score: q.score,
          style: q.style,
          kind: q.kind,
          minHeightMm: q.min_height_mm,
          lineGrid: { enabled: q.line_grid_enabled === 1, lineSpacingMm: q.line_spacing_mm },
          blanks: q.blanks_count ? { count: q.blanks_count, widthMm: q.blanks_width_mm, heightMm: q.blanks_height_mm, labelStyle: q.blanks_label_style ?? void 0, items: q.blanks_items_json ? JSON.parse(q.blanks_items_json) : void 0 } : void 0,
          images: images.map((img) => ({ assetId: img.asset_id, originalName: img.original_name, widthMm: img.width_mm, heightMm: img.height_mm, align: img.align }))
        };
      }));
      card.bodyBlocks.push({ id: b.id, type: "subjective", blockKind: b.block_kind ?? (String(b.title ?? "").includes("\u586B\u7A7A") ? "fill_blank" : "answer"), title: b.title, questions: questionsWithImages });
    }
    return card;
  }
  async findByTitle(title) {
    return await this.db.get("SELECT id, title FROM answer_cards WHERE title = ?", title);
  }
  async deleteCard(cardId) {
    const result = await this.db.run("DELETE FROM answer_cards WHERE id = ?", cardId);
    return result.changes > 0;
  }
};

// src/apps/answer-card/server/index.ts
init_ExamRepository();

// src/server/repositories/AnalysisRepository.ts
init_db();

// src/shared/ranking.ts
function competitionRank(rows, score, setRank) {
  let prevScore = null;
  let prevRank = 0;
  for (let i = 0; i < rows.length; i++) {
    const s = score(rows[i]);
    if (prevScore !== null && s === prevScore) {
      setRank(rows[i], prevRank);
    } else {
      const rank = i + 1;
      setRank(rows[i], rank);
      prevRank = rank;
    }
    prevScore = s;
  }
}

// src/server/repositories/AnalysisRepository.ts
function classFilter(classId) {
  if (classId === void 0) return { join: "", where: "", params: [] };
  if (classId === 0) return { join: "", where: "AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = ss.student_id)", params: [] };
  return { join: "JOIN class_students cs ON cs.student_id = ss.student_id", where: "AND cs.class_id = ?", params: [classId] };
}
function classFilterQs(classId) {
  if (classId === void 0) return { join: "", where: "", params: [] };
  if (classId === 0) return { join: "", where: "AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = qs.student_id)", params: [] };
  return { join: "JOIN class_students cs ON cs.student_id = qs.student_id", where: "AND cs.class_id = ?", params: [classId] };
}
function round1(v) {
  return Math.round(v * 10) / 10;
}
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function errorRateLevel(rate) {
  if (rate >= 70) return "high";
  if (rate >= 50) return "medium";
  if (rate >= 30) return "low";
  return "none";
}
function emptyErrorRateBuckets() {
  return { low: 0, medium: 0, high: 0 };
}
function countErrorRateBuckets(qs) {
  return qs.reduce((b, q) => {
    if (q.errorRateLevel !== "none") b[q.errorRateLevel]++;
    return b;
  }, emptyErrorRateBuckets());
}
function placeholders(v) {
  return v.map(() => "?").join(",");
}
function normalizeExamIds(v) {
  const s = /* @__PURE__ */ new Set();
  const r = [];
  for (const raw of v ?? []) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && !s.has(id)) {
      s.add(id);
      r.push(id);
    }
  }
  return r;
}
function dateOnly(v) {
  if (!v) return null;
  return String(v).slice(0, 10);
}
function addDays(d, n) {
  return new Date((/* @__PURE__ */ new Date(`${d}T00:00:00.000Z`)).getTime() + n * 864e5).toISOString().slice(0, 10);
}
function generateDistributionRanges(fullScore) {
  const r = [];
  for (let min = 0; min < fullScore; min += 10) r.push({ range: `${min}-${Math.min(min + 9, fullScore)}`, min, max: Math.min(min + 9, fullScore) });
  return r;
}
var AnalysisRepository = class {
  db;
  constructor() {
    this.db = getMysqlDb();
  }
  async getExamClasses(examId) {
    const classes = await this.db.all(`SELECT DISTINCT cs.class_id as classId, c.name as className, g.name as gradeName FROM student_scores ss JOIN class_students cs ON cs.student_id = ss.student_id JOIN classes c ON c.id = cs.class_id LEFT JOIN grades g ON g.id = c.grade_id WHERE ss.exam_id = ? ORDER BY g.sort_order, c.sort_order, c.name`, examId);
    const unknown = await this.db.get(`SELECT COUNT(*) as count FROM student_scores ss WHERE ss.exam_id = ? AND NOT EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = ss.student_id)`, examId);
    const result = classes.map((c) => ({ ...c, gradeName: c.gradeName ?? void 0 }));
    return unknown.count > 0 ? [...result, { classId: 0, className: "\u672A\u77E5\u73ED\u7EA7", gradeName: "\u65E0\u5E74\u7EA7" }] : result;
  }
  async getExam(examId) {
    return await this.db.get("SELECT name FROM exams WHERE id = ?", examId) ?? void 0;
  }
  async getExamFilterItemsByIds(examIds) {
    const ids = normalizeExamIds(examIds);
    if (ids.length === 0) return [];
    return await this.db.all(`SELECT e.id, e.name, e.subject, e.grade_id, g.name as grade_name, date(COALESCE(ac.exam_date, e.created_at)) as exam_date, e.status, COUNT(ss.id) as graded_count, ROUND(AVG(ss.total_score), 1) as avg_score, CASE WHEN e.assigned_formula IS NOT NULL AND e.assigned_formula != '' THEN 1 ELSE 0 END as has_assigned_score FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id LEFT JOIN grades g ON g.id = e.grade_id LEFT JOIN student_scores ss ON ss.exam_id = e.id WHERE e.id IN (${placeholders(ids)}) GROUP BY e.id ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC`, ...ids);
  }
  async listExamGroups(createdBy) {
    const rows = createdBy == null ? await this.db.all("SELECT * FROM exam_groups WHERE source IN ('cross-manual', 'week') ORDER BY updated_at DESC, id DESC") : await this.db.all("SELECT * FROM exam_groups WHERE created_by = ? AND source IN ('cross-manual', 'week') ORDER BY updated_at DESC, id DESC", createdBy);
    const results = [];
    for (const row of rows) results.push(await this.hydrateExamGroup(row));
    return results;
  }
  async getExamGroup(groupId) {
    const row = await this.db.get("SELECT * FROM exam_groups WHERE id = ?", groupId);
    return row ? await this.hydrateExamGroup(row) : null;
  }
  async createExamGroup(params) {
    const examIds = normalizeExamIds(params.examIds);
    if (examIds.length === 0) throw new Error("\u8003\u8BD5\u7EC4\u81F3\u5C11\u9700\u8981\u4E00\u573A\u8003\u8BD5");
    const groupId = await this.db.transaction(async (tx) => {
      const info = await tx.run("INSERT INTO exam_groups (name, source, start_date, end_date, created_by) VALUES (?, ?, ?, ?, ?)", params.name.trim(), params.source ?? "manual", params.startDate ?? null, params.endDate ?? null, params.createdBy ?? null);
      const gid = info.lastInsertRowid;
      for (let i = 0; i < examIds.length; i++) {
        await tx.run("INSERT INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, ?)", gid, examIds[i], i);
      }
      return gid;
    });
    return await this.getExamGroup(groupId);
  }
  async deleteExamGroup(groupId, userId, isAdmin) {
    const row = await this.db.get("SELECT created_by FROM exam_groups WHERE id = ?", groupId);
    if (!row) return false;
    if (!isAdmin && row.created_by !== userId) return false;
    await this.db.run("DELETE FROM exam_groups WHERE id = ?", groupId);
    return true;
  }
  async getExamIdsForDatePackage(params) {
    const endDate = params.endDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const startDate = params.startDate || addDays(endDate, -6);
    if (params.visibleExamIds && params.visibleExamIds.length === 0) return [];
    let sql = `SELECT e.id FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id WHERE date(COALESCE(ac.exam_date, e.created_at)) >= date(?) AND date(COALESCE(ac.exam_date, e.created_at)) <= date(?)`;
    const q = [startDate, endDate];
    if (params.gradeId) {
      sql += " AND e.grade_id = ?";
      q.push(params.gradeId);
    }
    if (params.subject) {
      sql += " AND e.subject = ?";
      q.push(params.subject);
    }
    if (params.visibleExamIds) {
      sql += ` AND e.id IN (${placeholders(params.visibleExamIds)})`;
      q.push(...params.visibleExamIds);
    }
    sql += " ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC";
    return (await this.db.all(sql, ...q)).map((r) => r.id);
  }
  async getCrossExamTotal(request, options) {
    const mode = request.mode;
    const group = mode === "group" && request.groupId ? await this.getExamGroup(request.groupId) : null;
    let examIds = mode === "week" ? await this.getExamIdsForDatePackage({ startDate: request.startDate, endDate: request.endDate, gradeId: request.gradeId, subject: request.subject, visibleExamIds: options?.visibleExamIds }) : mode === "group" ? group?.examIds ?? [] : normalizeExamIds(request.examIds);
    if (options?.visibleExamIds) {
      const v = new Set(options.visibleExamIds);
      examIds = examIds.filter((id) => v.has(id));
    }
    examIds = normalizeExamIds(examIds);
    if (examIds.length === 0) return this.emptyCrossExamTotal(mode, group);
    const exams = await this.getCrossExamTotalExams(examIds);
    const examOrder = new Map(exams.map((e, i) => [e.id, i]));
    const totalFullScore = round1(exams.reduce((s, e) => s + e.fullScore, 0));
    const scores = await this.getCrossExamScoreRows(examIds, request.gradeId, request.classId);
    const byStudent = /* @__PURE__ */ new Map();
    for (const score of scores) {
      const existing = byStudent.get(score.student_id);
      const row = existing ?? { studentId: score.student_id, studentNumber: score.student_number ?? "", studentName: score.name ?? "", className: score.class_name ?? "\u672A\u77E5\u73ED\u7EA7", classId: score.class_id, gradeName: score.grade_name, totalScore: 0, totalFullScore, scoreRate: null, attendedCount: 0, absentCount: 0, gradeRank: 0, classRank: 0, scores: exams.map((e) => ({ examId: e.id, score: null, absent: true })) };
      const idx = examOrder.get(score.exam_id);
      if (idx != null) {
        row.scores[idx] = { examId: score.exam_id, score: round1(Number(score.total_score)), absent: false };
      }
      byStudent.set(score.student_id, row);
    }
    let rows = Array.from(byStudent.values()).map((row) => {
      const att = row.scores.filter((c) => !c.absent && c.score != null);
      return { ...row, totalScore: round1(att.reduce((s, c) => s + Number(c.score), 0)), attendedCount: att.length, absentCount: exams.length - att.length, scoreRate: totalFullScore > 0 ? round1(round1(att.reduce((s, c) => s + Number(c.score), 0)) / totalFullScore * 100) : null };
    });
    if ((request.attendanceMode ?? "all") === "full") rows = rows.filter((r) => r.absentCount === 0);
    rows.sort((a, b) => b.totalScore - a.totalScore || a.studentNumber.localeCompare(b.studentNumber));
    competitionRank(rows, (r) => r.totalScore, (r, rank) => {
      r.gradeRank = rank;
    });
    const byClass = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const k = row.classId == null ? "__unknown__" : String(row.classId);
      if (!byClass.has(k)) byClass.set(k, []);
      byClass.get(k).push(row);
    }
    for (const cr of byClass.values()) {
      cr.sort((a, b) => b.totalScore - a.totalScore);
      competitionRank(cr, (r) => r.totalScore, (r, rank) => {
        r.classRank = rank;
      });
    }
    rows.sort((a, b) => a.gradeRank - b.gradeRank);
    return { mode, group, exams, rows, classSummaries: this.buildCrossExamClassSummaries(rows), summary: this.buildCrossExamSummary(rows, exams.length, totalFullScore) };
  }
  async getExamOverview(examId, classId) {
    const c = classFilter(classId);
    const totalMax = await this.db.get(`SELECT SUM(max_score) as total FROM (SELECT DISTINCT question_number, score_type, max_score FROM question_scores WHERE exam_id = ?)`, examId);
    const fullScore = totalMax?.total ?? 100;
    const passLine = fullScore * 0.6, excellentLine = fullScore * 0.9;
    const stats = await this.db.get(`SELECT COUNT(*) as gradedCount, ROUND(AVG(ss.total_score), 1) as avgScore, ROUND(MAX(ss.total_score), 1) as maxScore, ROUND(MIN(ss.total_score), 1) as minScore, SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as passCount, SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as excellentCount FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where}`, passLine, excellentLine, examId, ...c.params);
    if (!stats || stats.gradedCount === 0) {
      return { totalStudents: 0, gradedCount: 0, avgScore: 0, maxScore: 0, minScore: 0, stdDev: 0, passRate: 0, excellentRate: 0, distribution: [], scoreSummary: null, overallScoreSummary: await this.getScoreSummary(examId), classSummaries: await this.getClassScoreSummaries(examId), highErrorQuestionCount: 0, errorRateBuckets: emptyErrorRateBuckets() };
    }
    const stdDevRow = await this.db.get(`SELECT ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as stdDev FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where}`, stats.avgScore, stats.avgScore, examId, ...c.params);
    const ranges = generateDistributionRanges(fullScore);
    const distribution = await Promise.all(ranges.map(async (r) => {
      const row = await this.db.get(`SELECT COUNT(*) as cnt FROM student_scores ss ${c.join} WHERE ss.exam_id = ? AND ss.total_score >= ? AND ss.total_score <= ? ${c.where}`, examId, r.min, r.max, ...c.params);
      return { ...r, count: row.cnt };
    }));
    const qa = await this.getQuestionAnalysis(examId, classId);
    const eb = countErrorRateBuckets(qa);
    return { totalStudents: stats.gradedCount, gradedCount: stats.gradedCount, avgScore: stats.avgScore, maxScore: stats.maxScore, minScore: stats.minScore, stdDev: stdDevRow?.stdDev ?? 0, passRate: Math.round(stats.passCount / stats.gradedCount * 100), excellentRate: Math.round(stats.excellentCount / stats.gradedCount * 100), distribution, scoreSummary: await this.getScoreSummary(examId, classId), overallScoreSummary: await this.getScoreSummary(examId), classSummaries: await this.getClassScoreSummaries(examId), highErrorQuestionCount: eb.low + eb.medium + eb.high, errorRateBuckets: eb };
  }
  async getClassScoreSummaries(examId) {
    const classes = await this.getExamClasses(examId);
    const results = [];
    for (const item of classes) {
      const summary = await this.getScoreSummary(examId, item.classId);
      if (summary) results.push({ ...item, summary });
    }
    return results;
  }
  async getScoreSummary(examId, classId) {
    const c = classFilter(classId);
    const rows = await this.db.all(`SELECT ss.total_score as totalScore FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where} ORDER BY ss.total_score ASC`, examId, ...c.params);
    const scores = rows.map((r) => Number(r.totalScore)).filter((s) => Number.isFinite(s));
    if (scores.length === 0) return null;
    const sum = scores.reduce((a, b) => a + b, 0);
    return { min: round1(scores[0]), q1: round1(percentile(scores, 0.25)), median: round1(percentile(scores, 0.5)), q3: round1(percentile(scores, 0.75)), max: round1(scores[scores.length - 1]), avg: round1(sum / scores.length), count: scores.length };
  }
  async getScoreTrend(subject, classId) {
    const s = subject.trim();
    if (!s) return [];
    const gradeRows = await this.db.all(`SELECT e.id as examId, e.name as examName, e.subject as subject, COALESCE(e.start_time, e.end_time, e.created_at) as examTime, ROUND(AVG(ss.total_score), 1) as gradeAvg, COUNT(*) as gradeCount FROM exams e JOIN student_scores ss ON ss.exam_id = e.id WHERE e.subject = ? GROUP BY e.id ORDER BY COALESCE(e.start_time, e.end_time, e.created_at) ASC, e.id ASC`, s);
    if (classId === void 0) return gradeRows.map((r) => ({ examId: r.examId, examName: r.examName, subject: r.subject, examTime: r.examTime, gradeAvg: r.gradeAvg, gradeCount: r.gradeCount }));
    const classRows = classId === 0 ? await this.db.all(`SELECT e.id as examId, ROUND(AVG(ss.total_score), 1) as classAvg, COUNT(*) as classCount FROM exams e JOIN student_scores ss ON ss.exam_id = e.id WHERE e.subject = ? AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = ss.student_id) GROUP BY e.id`, s) : await this.db.all(`SELECT e.id as examId, ROUND(AVG(ss.total_score), 1) as classAvg, COUNT(*) as classCount FROM exams e JOIN student_scores ss ON ss.exam_id = e.id JOIN class_students cs ON cs.student_id = ss.student_id WHERE e.subject = ? AND cs.class_id = ? GROUP BY e.id`, s, classId);
    const m = new Map(classRows.map((r) => [r.examId, r]));
    return gradeRows.map((r) => ({ ...r, classAvg: m.get(r.examId)?.classAvg ?? null, classCount: m.get(r.examId)?.classCount ?? 0 }));
  }
  async getStudentRanking(examId, classId) {
    const c = classFilter(classId);
    const rows = await this.db.all(`SELECT u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score, (SELECT COUNT(*) FROM question_scores qs WHERE qs.exam_id = ss.exam_id AND qs.student_id = ss.student_id AND qs.score < qs.max_score * 0.5) as low_score_count, (SELECT COUNT(*) FROM question_scores qs WHERE qs.exam_id = ss.exam_id AND qs.student_id = ss.student_id) as question_count FROM student_scores ss JOIN users u ON u.id = ss.student_id ${c.join} WHERE ss.exam_id = ? ${c.where} ORDER BY ss.total_score DESC`, examId, ...c.params);
    const items = rows.map((r) => ({ rank: 0, studentNumber: r.student_number, studentName: r.name, totalScore: r.total_score, objectiveScore: r.objective_score, subjectiveScore: r.subjective_score, lowScoreCount: r.low_score_count ?? 0, questionCount: r.question_count ?? 0, errorRate: (r.question_count ?? 0) > 0 ? Math.round((r.low_score_count ?? 0) / (r.question_count ?? 1) * 100) : 0, errorRateLevel: errorRateLevel((r.question_count ?? 0) > 0 ? Math.round((r.low_score_count ?? 0) / (r.question_count ?? 1) * 100) : 0) }));
    competitionRank(items, (r) => r.totalScore, (r, rank) => {
      r.rank = rank;
    });
    return items;
  }
  async getQuestionAnalysis(examId, classId) {
    const c = classFilterQs(classId);
    const rows = await this.db.all(`SELECT qs.question_number, qs.score_type as question_type, ROUND(AVG(qs.score), 1) as avgScore, MAX(qs.max_score) as maxScore, COUNT(*) as totalCount, SUM(CASE WHEN qs.score >= qs.max_score THEN 1 ELSE 0 END) as correctCount, SUM(CASE WHEN qs.score < qs.max_score THEN 1 ELSE 0 END) as objectiveErrorCount, SUM(CASE WHEN qs.score < qs.max_score * 0.5 THEN 1 ELSE 0 END) as subjectiveLowScoreCount FROM question_scores qs ${c.join} WHERE qs.exam_id = ? ${c.where} GROUP BY qs.question_number, qs.score_type ORDER BY CASE WHEN MAX(qs.max_score) > 0 THEN AVG(qs.score) / MAX(qs.max_score) ELSE 1 END ASC`, examId, ...c.params);
    return rows.map((r) => {
      const isObj = r.question_type === "objective", errCnt = isObj ? r.objectiveErrorCount : r.subjectiveLowScoreCount, errRate = r.totalCount > 0 ? Math.round(errCnt / r.totalCount * 100) : 0;
      return { questionNumber: String(r.question_number), questionType: isObj ? "\u5BA2\u89C2" : "\u4E3B\u89C2", scoreRate: r.maxScore > 0 ? Math.round(r.avgScore / r.maxScore * 100) : 0, correctRate: isObj && r.totalCount > 0 ? Math.round(r.correctCount / r.totalCount * 100) : null, avgScore: r.avgScore, maxScore: r.maxScore, errorCount: errCnt, errorRate: errRate, errorRateLevel: errorRateLevel(errRate), totalCount: r.totalCount };
    });
  }
  async getExportData(examId, classId) {
    const allStudents = await this.db.all(`SELECT ss.student_id, u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score, c.name as class_name, c.id as class_id FROM student_scores ss JOIN users u ON u.id = ss.student_id LEFT JOIN class_students cs ON cs.student_id = ss.student_id LEFT JOIN classes c ON c.id = cs.class_id WHERE ss.exam_id = ? ORDER BY ss.total_score DESC`, examId);
    if (allStudents.length === 0) return { students: [], questionHeaders: [] };
    const questionList = await this.db.all(`SELECT question_number, score_type, MAX(max_score) as max_score FROM question_scores WHERE exam_id = ? GROUP BY question_number, score_type ORDER BY question_number`, examId);
    const qHeaders = questionList.map((q) => String(q.question_number));
    const allQS = await this.db.all(`SELECT student_id, question_number, score FROM question_scores WHERE exam_id = ?`, examId);
    const qsLookup = /* @__PURE__ */ new Map();
    for (const qs of allQS) {
      if (!qsLookup.has(qs.student_id)) qsLookup.set(qs.student_id, /* @__PURE__ */ new Map());
      qsLookup.get(qs.student_id).set(qs.question_number, qs.score);
    }
    const graded = allStudents.map((s) => ({ ...s, gradeRank: 0, classRank: "" }));
    competitionRank(graded, (r) => r.total_score, (r, rank) => {
      r.gradeRank = rank;
    });
    const cg = /* @__PURE__ */ new Map();
    for (const s of graded) {
      const k = s.class_name ?? "__unassigned__";
      if (!cg.has(k)) cg.set(k, []);
      cg.get(k).push(s);
    }
    for (const g of cg.values()) competitionRank(g, (r) => r.total_score, (r, rank) => {
      r.classRank = rank;
    });
    const filtered = classId === void 0 ? graded : classId === 0 ? graded.filter((s) => s.class_id == null) : graded.filter((s) => s.class_id === classId);
    return { students: filtered.map((s) => ({ className: s.class_name ?? "\u672A\u77E5\u73ED\u7EA7", studentNumber: s.student_number ?? "", name: s.name ?? "", totalScore: s.total_score, classRank: s.classRank, gradeRank: s.gradeRank, objectiveScore: s.objective_score, subjectiveScore: s.subjective_score, questionScores: questionList.map((q) => {
      const m = qsLookup.get(s.student_id);
      if (!m) return "";
      const sc = m.get(q.question_number);
      return sc !== void 0 ? sc : "";
    }) })), questionHeaders: qHeaders };
  }
  async getScoreTableData(examId, classId, displayMode = "deviation") {
    const exam = await this.db.get(`SELECT e.name, e.subject, ac.exam_date, e.assigned_formula FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id WHERE e.id = ?`, examId);
    if (!exam) throw new Error("\u8003\u8BD5\u4E0D\u5B58\u5728");
    const hasAssigned = !!(exam.assigned_formula && exam.assigned_formula !== "");
    const allStudents = await this.db.all(`SELECT ss.student_id, u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score, ss.assigned_score, c.name as class_name, c.id as class_id, g.name as grade_name FROM student_scores ss JOIN users u ON u.id = ss.student_id LEFT JOIN class_students cs ON cs.student_id = ss.student_id LEFT JOIN classes c ON c.id = cs.class_id LEFT JOIN grades g ON g.id = c.grade_id WHERE ss.exam_id = ? ORDER BY ss.total_score DESC`, examId);
    if (allStudents.length === 0) return { examName: exam.name, subject: exam.subject, examDate: exam.exam_date, hasAssignedScore: hasAssigned, rows: [], totalCount: 0 };
    const gradeRanked = allStudents.map((s) => ({ ...s, gradeRank: 0, classRank: 0 }));
    competitionRank(gradeRanked, (r) => r.total_score, (r, rank) => {
      r.gradeRank = rank;
    });
    const cg = /* @__PURE__ */ new Map();
    for (const s of gradeRanked) {
      const k = s.class_name ?? "__unassigned__";
      if (!cg.has(k)) cg.set(k, []);
      cg.get(k).push(s);
    }
    for (const g of cg.values()) competitionRank(g, (r) => r.total_score, (r, rank) => {
      r.classRank = rank;
    });
    let filtered = gradeRanked;
    if (classId === 0) filtered = gradeRanked.filter((s) => s.class_id == null);
    else if (classId !== void 0) filtered = gradeRanked.filter((s) => s.class_id === classId);
    const scores = filtered.map((s) => s.total_score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);
    const prevExam = await this.db.get(`SELECT e.id, e.name FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id WHERE e.subject = ? AND e.grade_id = (SELECT grade_id FROM exams WHERE id = ?) AND e.id != ? AND (ac.exam_date IS NULL OR ac.exam_date < (SELECT ac2.exam_date FROM exams e2 LEFT JOIN answer_cards ac2 ON ac2.id = e2.card_id WHERE e2.id = ?)) ORDER BY COALESCE(ac.exam_date, e.created_at) DESC LIMIT 1`, exam.subject, examId, examId, examId);
    let prevRankMap = /* @__PURE__ */ new Map();
    if (prevExam) {
      const prevStudents = await this.db.all(`SELECT student_id, total_score FROM student_scores WHERE exam_id = ? ORDER BY total_score DESC`, prevExam.id);
      competitionRank(prevStudents, (r) => r.total_score, (r, rank) => prevRankMap.set(r.student_id, rank));
    }
    const rows = filtered.map((s) => {
      const prevRank = prevRankMap.get(s.student_id) ?? null;
      const rankChange = prevRank != null ? prevRank - s.gradeRank : null;
      let dv = null;
      if (displayMode === "deviation") dv = std > 0 ? Math.round((50 + 10 * (s.total_score - mean) / std) * 10) / 10 : 50;
      else if (displayMode === "zscore") dv = std > 0 ? Math.round((s.total_score - mean) / std * 100) / 100 : 0;
      else if (displayMode === "percentile") dv = Math.round((1 - (s.gradeRank - 1) / allStudents.length) * 1e3) / 10;
      return { studentId: s.student_id, studentNumber: s.student_number, studentName: s.name, className: s.class_name ?? "\u672A\u77E5\u73ED\u7EA7", classId: s.class_id, gradeName: s.grade_name ?? null, totalScore: s.total_score, assignedScore: s.assigned_score, gradeRank: s.gradeRank, classRank: s.classRank ?? 0, rankChange, prevRank, prevExamName: prevExam?.name ?? null, displayValue: dv, objectiveScore: s.objective_score, subjectiveScore: s.subjective_score };
    });
    if (classId !== void 0 && classId !== 0) rows.sort((a, b) => a.classRank - b.classRank);
    else rows.sort((a, b) => a.gradeRank - b.gradeRank);
    return { examName: exam.name, subject: exam.subject, examDate: exam.exam_date, hasAssignedScore: hasAssigned, rows, totalCount: rows.length };
  }
  async hydrateExamGroup(row) {
    const items = await this.db.all("SELECT exam_id FROM exam_group_members WHERE group_id = ? ORDER BY sort_order ASC, exam_id ASC", row.id);
    const examIds = items.map((i) => i.exam_id);
    return { id: row.id, name: row.name, source: row.source, startDate: row.start_date, endDate: row.end_date, examIds, exams: await this.getExamFilterItemsByIds(examIds), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  emptyCrossExamTotal(mode, group) {
    return { mode, group, exams: [], rows: [], classSummaries: [], summary: { examCount: 0, studentCount: 0, totalFullScore: 0, avgTotalScore: 0, maxTotalScore: 0, minTotalScore: 0, fullAttendanceCount: 0 } };
  }
  async getCrossExamTotalExams(examIds) {
    const fullScores = await this.getExamFullScoreMap(examIds);
    const rows = await this.db.all(`SELECT e.id, e.name, e.subject, g.name as gradeName, date(COALESCE(ac.exam_date, e.created_at)) as examDate, COUNT(ss.id) as gradedCount, ROUND(AVG(ss.total_score), 1) as avgScore FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id LEFT JOIN grades g ON g.id = e.grade_id LEFT JOIN student_scores ss ON ss.exam_id = e.id WHERE e.id IN (${placeholders(examIds)}) GROUP BY e.id ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC`, ...examIds);
    return rows.map((r) => ({ id: r.id, name: r.name, subject: r.subject, gradeName: r.gradeName, examDate: dateOnly(r.examDate), fullScore: round1(fullScores.get(r.id) ?? 0), gradedCount: r.gradedCount, avgScore: r.avgScore }));
  }
  async getExamFullScoreMap(examIds) {
    const result = /* @__PURE__ */ new Map();
    const qRows = await this.db.all(`SELECT exam_id, SUM(max_score) as fullScore FROM (SELECT exam_id, question_number, score_type, MAX(max_score) as max_score FROM question_scores WHERE exam_id IN (${placeholders(examIds)}) GROUP BY exam_id, question_number, score_type) GROUP BY exam_id`, ...examIds);
    for (const r of qRows) if (r.fullScore != null && r.fullScore > 0) result.set(r.exam_id, Number(r.fullScore));
    const missing = examIds.filter((id) => !result.has(id));
    if (missing.length > 0) {
      const fb = await this.db.all(`SELECT exam_id, MAX(total_score) as fullScore FROM student_scores WHERE exam_id IN (${placeholders(missing)}) GROUP BY exam_id`, ...missing);
      for (const r of fb) result.set(r.exam_id, Number(r.fullScore ?? 0));
    }
    for (const id of examIds) if (!result.has(id)) result.set(id, 0);
    return result;
  }
  async getCrossExamScoreRows(examIds, gradeId, classId) {
    let sql = `SELECT ss.exam_id, ss.student_id, u.student_number, u.name, c.id as class_id, c.name as class_name, g.name as grade_name, ss.total_score FROM student_scores ss JOIN users u ON u.id = ss.student_id LEFT JOIN class_students cs ON cs.student_id = ss.student_id LEFT JOIN classes c ON c.id = cs.class_id LEFT JOIN grades g ON g.id = c.grade_id WHERE ss.exam_id IN (${placeholders(examIds)})`;
    const params = [...examIds];
    if (classId === 0) sql += " AND c.id IS NULL";
    else if (classId !== void 0) {
      sql += " AND c.id = ?";
      params.push(classId);
    } else if (gradeId) {
      sql += " AND g.id = ?";
      params.push(gradeId);
    }
    sql += " ORDER BY ss.exam_id ASC, ss.total_score DESC";
    return await this.db.all(sql, ...params);
  }
  buildCrossExamSummary(rows, examCount, totalFullScore) {
    if (rows.length === 0) return { examCount, studentCount: 0, totalFullScore, avgTotalScore: 0, maxTotalScore: 0, minTotalScore: 0, fullAttendanceCount: 0 };
    const totals = rows.map((r) => r.totalScore), sum = totals.reduce((a, b) => a + b, 0);
    return { examCount, studentCount: rows.length, totalFullScore, avgTotalScore: round1(sum / rows.length), maxTotalScore: round1(Math.max(...totals)), minTotalScore: round1(Math.min(...totals)), fullAttendanceCount: rows.filter((r) => r.absentCount === 0).length };
  }
  buildCrossExamClassSummaries(rows) {
    const groups = /* @__PURE__ */ new Map();
    for (const r of rows) {
      const k = r.classId == null ? "__unknown__" : String(r.classId);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return Array.from(groups.values()).map((cr) => {
      const first = cr[0], totals = cr.map((r) => r.totalScore), sum = totals.reduce((a, b) => a + b, 0);
      return { classId: first.classId, className: first.className, gradeName: first.gradeName, count: cr.length, avgScore: round1(sum / cr.length), maxScore: round1(Math.max(...totals)), minScore: round1(Math.min(...totals)) };
    }).sort((a, b) => (a.gradeName ?? "").localeCompare(b.gradeName ?? "") || a.className.localeCompare(b.className));
  }
};

// src/server/repositories/ScoreRepository.ts
init_db();
var ScoreRepository = class {
  db;
  constructor() {
    this.db = getMysqlDb();
  }
  async getStudentScores(studentId) {
    const rows = await this.db.all(`
      SELECT
        ss.exam_id,
        e.name AS exam_name,
        e.subject,
        ss.objective_score,
        ss.subjective_score,
        ss.total_score,
        ss.graded_at,
        (
          SELECT COUNT(*) + 1 FROM student_scores s2
          WHERE s2.exam_id = ss.exam_id AND s2.total_score > ss.total_score
        ) AS rank,
        (
          SELECT COUNT(*) FROM student_scores s3 WHERE s3.exam_id = ss.exam_id
        ) AS class_size
      FROM student_scores ss
      JOIN exams e ON e.id = ss.exam_id
      WHERE ss.student_id = ?
      ORDER BY ss.graded_at DESC
    `, studentId);
    return rows.map((r) => ({
      ...r,
      percentile: r.class_size > 1 && r.rank != null ? Math.round((r.class_size - r.rank) / (r.class_size - 1) * 1e3) / 10 : null
    }));
  }
  async getStudentQuestionScores(studentId, examId) {
    return await this.db.all(`
      SELECT question_number, question_id, block_id, score, max_score, score_type
      FROM question_scores
      WHERE student_id = ? AND exam_id = ?
      ORDER BY score_type ASC, question_number ASC
    `, studentId, examId);
  }
  async getStudentTrendData(studentId) {
    const rows = await this.db.all(`
      SELECT
        ss.exam_id AS examId,
        e.name AS examName,
        e.subject,
        COALESCE(e.start_time, e.end_time, e.created_at) AS examTime,
        ss.total_score AS totalScore,
        ROUND(
          (SELECT AVG(s2.total_score) FROM student_scores s2
           WHERE s2.exam_id = ss.exam_id
             AND cs.class_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM class_students cs2
               WHERE cs2.student_id = s2.student_id AND cs2.class_id = cs.class_id
             )),
          1
        ) AS classAvg,
        ROUND(
          (SELECT AVG(s3.total_score) FROM student_scores s3 WHERE s3.exam_id = ss.exam_id),
          1
        ) AS gradeAvg,
        (SELECT COUNT(*) FROM student_scores s4 WHERE s4.exam_id = ss.exam_id) AS classSize,
        (
          SELECT COUNT(*) + 1 FROM student_scores s5
          WHERE s5.exam_id = ss.exam_id AND s5.total_score > ss.total_score
        ) AS rank
      FROM student_scores ss
      JOIN exams e ON e.id = ss.exam_id
      LEFT JOIN (
        SELECT student_id, MIN(class_id) AS class_id FROM class_students GROUP BY student_id
      ) cs ON cs.student_id = ss.student_id
      WHERE ss.student_id = ?
      ORDER BY COALESCE(e.start_time, e.end_time, e.created_at) ASC
    `, studentId);
    return rows.map((r) => ({
      ...r,
      percentile: r.classSize > 1 && r.rank != null ? Math.round((r.classSize - r.rank) / (r.classSize - 1) * 1e3) / 10 : null
    }));
  }
  async hasScore(studentId, examId) {
    const row = await this.db.get("SELECT 1 FROM student_scores WHERE student_id = ? AND exam_id = ? LIMIT 1", studentId, examId);
    return Boolean(row);
  }
};

// src/server/services/AssignedScoreService.ts
init_db();
import { Parser } from "expr-eval";
var ASSIGNED_SCORE_SUBJECTS = ["\u5316\u5B66", "\u751F\u7269", "\u5730\u7406", "\u653F\u6CBB"];
var AssignedScoreService = class {
  db;
  parser = new Parser();
  constructor() {
    this.db = getMysqlDb();
  }
  /**
   * 获取考试的赋分公式配置
   */
  async getFormula(examId) {
    const exam = await this.db.get(
      "SELECT assigned_formula FROM exams WHERE id = ?",
      examId
    );
    if (!exam?.assigned_formula) return null;
    try {
      return JSON.parse(exam.assigned_formula);
    } catch {
      return null;
    }
  }
  /**
   * 保存赋分公式配置
   */
  async saveFormula(examId, formula) {
    await this.db.run(
      "UPDATE exams SET assigned_formula = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      JSON.stringify(formula),
      examId
    );
  }
  /**
   * 删除赋分公式（禁用赋分）
   */
  async disableFormula(examId) {
    await this.db.run(
      "UPDATE exams SET assigned_formula = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      examId
    );
    await this.db.run("UPDATE student_scores SET assigned_score = NULL WHERE exam_id = ?", examId);
  }
  /**
   * 计算单个学生的赋分
   */
  calculateAssignedScore(rawScore, formula, stats) {
    if (!formula.enabled) return rawScore;
    switch (formula.type) {
      case "proportional": {
        const { minIn = 0, maxIn = 100, minOut = 30, maxOut = 100 } = formula.params;
        const span = maxIn - minIn || 1;
        const result = minOut + (rawScore - minIn) / span * (maxOut - minOut);
        return Math.round(Math.max(minOut - 10, Math.min(maxOut + 10, result)) * 10) / 10;
      }
      case "linear": {
        const { a = 0.7, b = 30 } = formula.params;
        const result = rawScore * a + b;
        return Math.round(Math.max(0, Math.min(120, result)) * 10) / 10;
      }
      case "custom": {
        if (!formula.params.expression) return rawScore;
        try {
          const expr = this.parser.parse(formula.params.expression);
          const result = expr.evaluate({
            raw: rawScore,
            max: stats.max,
            min: stats.min,
            avg: stats.avg,
            std: stats.std
          });
          if (typeof result === "number" && Number.isFinite(result)) {
            return Math.round(result * 10) / 10;
          }
        } catch {
        }
        return rawScore;
      }
      default:
        return rawScore;
    }
  }
  /**
   * 对整场考试执行赋分重算
   */
  async recalculateAll(examId) {
    const formula = await this.getFormula(examId);
    if (!formula || !formula.enabled) {
      return { updated: 0, skipped: 0 };
    }
    const stats = await this.db.get(`
      SELECT
        MAX(total_score) as max,
        MIN(total_score) as min,
        AVG(total_score) as avg
      FROM student_scores WHERE exam_id = ?
    `, examId);
    const scores = await this.db.all(
      "SELECT total_score FROM student_scores WHERE exam_id = ?",
      examId
    );
    const vals = scores.map((s) => s.total_score);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    const stdStats = { max: stats.max, min: stats.min, avg: stats.avg, std };
    const students = await this.db.all(
      "SELECT student_id, total_score FROM student_scores WHERE exam_id = ?",
      examId
    );
    let updated = 0;
    let skipped = 0;
    await this.db.transaction(async (tx) => {
      for (const s of students) {
        if (s.total_score == null) {
          skipped++;
          continue;
        }
        const assigned = this.calculateAssignedScore(s.total_score, formula, stdStats);
        await tx.run(
          "UPDATE student_scores SET assigned_score = ? WHERE exam_id = ? AND student_id = ?",
          assigned,
          examId,
          s.student_id
        );
        updated++;
      }
    });
    return { updated, skipped };
  }
  /**
   * 判断科目是否需要赋分
   */
  static isAssignedSubject(subject) {
    return ASSIGNED_SCORE_SUBJECTS.includes(subject);
  }
  /**
   * 获取所有可用公式预设
   */
  static getFormulaPresets() {
    return [
      {
        id: "proportional-default",
        name: "\u7B49\u6BD4\u4F8B\u8F6C\u6362 (\u65B0\u9AD8\u8003\u5E38\u7528)",
        formula: {
          type: "proportional",
          enabled: true,
          params: { minIn: 0, maxIn: 100, minOut: 30, maxOut: 100 }
        }
      },
      {
        id: "linear-070",
        name: "\u7EBF\u6027\u516C\u5F0F (\u539F\u59CB\u5206\xD70.7+30)",
        formula: {
          type: "linear",
          enabled: true,
          params: { a: 0.7, b: 30 }
        }
      },
      {
        id: "custom-starter",
        name: "\u81EA\u5B9A\u4E49 (\u53EF\u7F16\u8F91\u8868\u8FBE\u5F0F)",
        formula: {
          type: "custom",
          enabled: true,
          params: { expression: "raw * 0.7 + 30" }
        }
      }
    ];
  }
};

// src/server/routes/auth.ts
import express from "express";

// src/server/repositories/UserRepository.ts
init_db();
init_db();

// src/server/auth/passwordPolicy.ts
var MIN_PASSWORD_LENGTH = 6;
function isStudentDefaultPassword(password, studentNumber) {
  return Boolean(studentNumber) && password === studentNumber;
}
function validateInitialPassword(options) {
  const password = options.password;
  if (!password) return "\u8BF7\u4E3A\u8BE5\u8D26\u53F7\u8BBE\u7F6E\u521D\u59CB\u5BC6\u7801";
  if (options.isStudent && isStudentDefaultPassword(password, options.studentNumber)) return null;
  if (password.length < MIN_PASSWORD_LENGTH) return `\u521D\u59CB\u5BC6\u7801\u81F3\u5C11 ${MIN_PASSWORD_LENGTH} \u4F4D`;
  return null;
}
function validateUserChosenPassword(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `\u65B0\u5BC6\u7801\u957F\u5EA6\u81F3\u5C11 ${MIN_PASSWORD_LENGTH} \u4F4D`;
  }
  return null;
}

// src/server/repositories/UserRepository.ts
import crypto from "node:crypto";
var UserRepository = class {
  db;
  constructor() {
    this.db = getMysqlDb();
  }
  async findByUsername(username) {
    return await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = ? AND u.is_active = 1`, username);
  }
  async findByStudentNumber(studentNumber) {
    return await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.student_number = ? AND u.is_active = 1`, studentNumber);
  }
  async findById(id) {
    return await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.is_active = 1`, id);
  }
  async createUser(params) {
    const passwordHash = await hashPassword(params.password);
    const result = await this.db.run(
      `INSERT INTO users (username, password_hash, name, role_id, student_number, subject, teacher_role, initial_password, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params.username,
      passwordHash,
      params.name,
      params.role_id,
      params.student_number ?? null,
      params.subject ?? null,
      params.teacher_role ?? null,
      params.initial_password ?? null,
      params.email ?? null,
      params.phone ?? null
    );
    return await this.findById(result.lastInsertRowid);
  }
  async updateUser(id, params) {
    const updates = [];
    const values = [];
    if (params.name !== void 0) {
      updates.push("name = ?");
      values.push(params.name);
    }
    if (params.password !== void 0) {
      updates.push("password_hash = ?");
      values.push(await hashPassword(params.password));
    }
    if (params.email !== void 0) {
      updates.push("email = ?");
      values.push(params.email);
    }
    if (params.phone !== void 0) {
      updates.push("phone = ?");
      values.push(params.phone);
    }
    if (params.is_active !== void 0) {
      updates.push("is_active = ?");
      values.push(params.is_active);
    }
    if (params.student_number !== void 0) {
      updates.push("student_number = ?");
      values.push(params.student_number);
    }
    if (params.role_id !== void 0) {
      updates.push("role_id = ?");
      values.push(params.role_id);
    }
    if (params.teacher_role !== void 0) {
      updates.push("teacher_role = ?");
      values.push(params.teacher_role);
    }
    updates.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id);
    await this.db.run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, ...values);
    return await this.findById(id);
  }
  async deactivateUser(id) {
    await this.db.run("UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", id);
  }
  async updateLastLogin(id) {
    await this.db.run("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", id);
  }
  async listUsers(page = 1, pageSize = 20, roleName) {
    const offset = (page - 1) * pageSize;
    let where = "WHERE u.is_active = 1";
    const params = [];
    if (roleName) {
      where += " AND r.name = ?";
      params.push(roleName);
    }
    const users = await this.db.all(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id ${where} ORDER BY u.id ASC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
    const { total } = await this.db.get(`SELECT COUNT(*) as total FROM users u JOIN roles r ON r.id = u.role_id ${where}`, ...params);
    return { users, total };
  }
  async getUserClasses(userId) {
    return await this.db.all(`SELECT cs.class_id, c.name as class_name, g.name as grade_name FROM class_students cs JOIN classes c ON c.id = cs.class_id JOIN grades g ON g.id = c.grade_id WHERE cs.student_id = ?`, userId);
  }
  async findByIdIncludingInactive(id) {
    return await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, id);
  }
  async usernameExists(username) {
    const row = await this.db.get("SELECT 1 FROM users WHERE username = ? LIMIT 1", username);
    return Boolean(row);
  }
  async studentNumberExists(studentNumber) {
    const row = await this.db.get("SELECT 1 FROM users WHERE student_number = ? LIMIT 1", studentNumber);
    return Boolean(row);
  }
  async adminListUsers(options = {}) {
    const page = options.page && options.page > 0 ? options.page : 1;
    const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 20;
    const offset = (page - 1) * pageSize;
    let where = "WHERE 1=1";
    const params = [];
    if (!options.includeInactive) where += " AND u.is_active = 1";
    if (options.roleName) {
      where += " AND r.name = ?";
      params.push(options.roleName);
    }
    if (options.keyword) {
      where += " AND (u.username LIKE ? OR u.name LIKE ? OR u.student_number LIKE ?)";
      const like = `%${options.keyword}%`;
      params.push(like, like, like);
    }
    const users = await this.db.all(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id ${where} ORDER BY u.role_id ASC, u.id ASC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
    const { total } = await this.db.get(`SELECT COUNT(*) as total FROM users u JOIN roles r ON r.id = u.role_id ${where}`, ...params);
    return { users, total };
  }
  async reactivateUser(id) {
    await this.db.run("UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", id);
  }
  async countByRole() {
    return await this.db.all(`SELECT r.name as role_name, r.display_name, COUNT(u.id) as count FROM roles r LEFT JOIN users u ON u.role_id = r.id AND u.is_active = 1 GROUP BY r.id ORDER BY r.id ASC`);
  }
  async batchCreateStudents(rows) {
    const result = { created: 0, skipped: 0, errors: [], createdIds: [] };
    const prepared = [];
    for (const row of rows) {
      const username = (row.username || row.student_number || "").trim();
      const studentNumber = (row.student_number || "").trim();
      if (!username || !studentNumber || !row.name) {
        result.errors.push({ row, message: "\u7F3A\u5C11\u7528\u6237\u540D/\u5B66\u53F7/\u59D3\u540D" });
        continue;
      }
      if (await this.usernameExists(username) || await this.studentNumberExists(studentNumber)) {
        result.skipped++;
        result.errors.push({ row, message: "\u7528\u6237\u540D\u6216\u5B66\u53F7\u5DF2\u5B58\u5728" });
        continue;
      }
      const initialPassword = row.password || studentNumber;
      const passwordError = validateInitialPassword({ password: initialPassword, isStudent: true, studentNumber });
      if (passwordError) {
        result.errors.push({ row, message: passwordError });
        continue;
      }
      prepared.push({ row: { ...row, username, student_number: studentNumber }, username, hash: await hashPassword(initialPassword) });
    }
    await this.db.transaction(async (tx) => {
      for (const item of prepared) {
        try {
          const initPwd = item.row.password || item.row.student_number;
          const insertResult = await tx.run("INSERT INTO users (username, password_hash, name, role_id, student_number, initial_password) VALUES (?, ?, ?, 3, ?, ?)", item.username, item.hash, item.row.name, item.row.student_number, initPwd);
          result.created++;
          result.createdIds.push(insertResult.lastInsertRowid);
        } catch (err) {
          result.errors.push({ row: item.row, message: err instanceof Error ? err.message : String(err) });
        }
      }
    });
    return result;
  }
  generateTeacherUsername() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const username = `T${crypto.randomInt(1e5, 1e6)}`;
      return username;
    }
    return `T${Date.now().toString(36).slice(-6)}${crypto.randomInt(0, 1e3)}`;
  }
  generateTeacherPassword() {
    return String(crypto.randomInt(1e5, 1e6));
  }
  async listTeachers(options = {}) {
    const page = options.page && options.page > 0 ? options.page : 1;
    const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 50;
    const offset = (page - 1) * pageSize;
    let where = "WHERE u.role_id = 2 AND u.is_active = 1";
    const params = [];
    if (options.keyword) {
      where += " AND (u.name LIKE ? OR u.username LIKE ? OR u.subject LIKE ?)";
      const like = `%${options.keyword}%`;
      params.push(like, like, like);
    }
    const teachers = await this.db.all(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id ${where} ORDER BY u.created_at ASC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
    const kw = options.keyword;
    const { total } = await this.db.get(`SELECT COUNT(*) as total FROM users u WHERE u.role_id = 2 AND u.is_active = 1 ${kw ? "AND (u.name LIKE ? OR u.username LIKE ? OR u.subject LIKE ?)" : ""}`, ...kw ? [`%${kw}%`, `%${kw}%`, `%${kw}%`] : []);
    return { teachers, total };
  }
  async findTeacherById(id) {
    const teacher = await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.role_id = 2`, id);
    if (!teacher) return null;
    const classes = await this.db.all(`SELECT tc.class_id, c.name as class_name, g.name as grade_name, tc.subject FROM teacher_classes tc JOIN classes c ON c.id = tc.class_id JOIN grades g ON g.id = c.grade_id WHERE tc.teacher_id = ? ORDER BY g.sort_order ASC, c.sort_order ASC`, id);
    return { ...teacher, classes };
  }
  async updateTeacher(id, params) {
    const updates = [];
    const values = [];
    if (params.name !== void 0) {
      updates.push("name = ?");
      values.push(params.name);
    }
    if (params.subject !== void 0) {
      updates.push("subject = ?");
      values.push(params.subject);
    }
    if (params.teacher_role !== void 0) {
      updates.push("teacher_role = ?");
      values.push(params.teacher_role);
    }
    if (params.password !== void 0) {
      updates.push("password_hash = ?");
      values.push(await hashPassword(params.password));
      updates.push("initial_password = ?");
      values.push(params.password);
    }
    updates.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id);
    await this.db.run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, ...values);
    return await this.findById(id);
  }
  async listStudentsByClass(classId) {
    let sql = `SELECT cs.student_id, u.username, u.name, u.student_number, u.initial_password, c.id as class_id, c.name as class_name, g.id as grade_id, g.name as grade_name, cs.joined_at FROM class_students cs JOIN users u ON u.id = cs.student_id AND u.is_active = 1 JOIN classes c ON c.id = cs.class_id JOIN grades g ON g.id = c.grade_id`;
    const params = [];
    if (classId) {
      sql += " WHERE cs.class_id = ?";
      params.push(classId);
    }
    sql += " ORDER BY g.sort_order ASC, c.sort_order ASC, u.student_number ASC";
    return await this.db.all(sql, ...params);
  }
  async listAllStudentsForExport() {
    return await this.db.all(`SELECT cs.student_id, u.username, u.name, u.student_number, u.initial_password, c.name as class_name, g.name as grade_name FROM class_students cs JOIN users u ON u.id = cs.student_id AND u.is_active = 1 JOIN classes c ON c.id = cs.class_id JOIN grades g ON g.id = c.grade_id ORDER BY g.sort_order ASC, c.sort_order ASC, u.student_number ASC`);
  }
  async listAllTeachersForExport() {
    return await this.db.all(`SELECT id, name, username, subject, initial_password FROM users WHERE role_id = 2 AND is_active = 1 ORDER BY created_at ASC`);
  }
  async exportStudentsCsv() {
    const rows = await this.listAllStudentsForExport();
    const header = "\u5E74\u7EA7,\u73ED\u7EA7,\u5B66\u53F7,\u59D3\u540D,\u8D26\u53F7,\u5BC6\u7801";
    const csvEsc = (v) => v ? v.includes(",") ? `"${v}"` : v : "";
    return "\uFEFF" + [header, ...rows.map((r) => [csvEsc(r.grade_name), csvEsc(r.class_name), csvEsc(r.student_number), csvEsc(r.name), csvEsc(r.username), csvEsc(r.initial_password)].join(","))].join("\n");
  }
  async exportTeachersCsv() {
    const teachers = await this.listAllTeachersForExport();
    const header = "\u79D1\u76EE,\u59D3\u540D,\u8D26\u53F7,\u5BC6\u7801";
    const csvEsc = (v) => v ? v.includes(",") ? `"${v}"` : v : "";
    return "\uFEFF" + [header, ...teachers.map((t) => [csvEsc(t.subject), csvEsc(t.name), csvEsc(t.username), csvEsc(t.initial_password)].join(","))].join("\n");
  }
  async batchImportFromCsv(rows) {
    const result = { students: { created: 0, linked: 0, skipped: 0, errors: [] }, teachers: { created: 0, skipped: 0, errors: [] } };
    if (rows.length < 2) return result;
    const header = rows[0].map((c) => c.toLowerCase().replace(/[_\s]+/g, ""));
    const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim()));
    const isStudent = header.some((h) => /班级|class/.test(h));
    const isTeacher = header.some((h) => /科目|subject/.test(h)) && !isStudent;
    if (isStudent) {
      const gradeIdx = header.findIndex((h) => /年级|grade/.test(h));
      const classIdx = header.findIndex((h) => /班级|class/.test(h));
      const numberIdx = header.findIndex((h) => /学号|student_number|考号/.test(h));
      const nameIdx = header.findIndex((h) => /姓名|name/.test(h));
      if (classIdx < 0 || numberIdx < 0 || nameIdx < 0) {
        result.students.errors.push({ row: header, message: "\u8868\u5934\u4E0D\u5B8C\u6574" });
        return result;
      }
      const hasSeparateGrade = gradeIdx >= 0;
      const parseGradeFromClass = (cn) => {
        const m = cn.match(/^(?:高|初|小?)([一二三四五六]+)/);
        return m ? m[0] : cn;
      };
      let currentGradeName = "", currentClassName = "";
      for (const row of dataRows) {
        try {
          const rawClassName = (row[classIdx] ?? "").trim();
          let rawGradeName;
          if (hasSeparateGrade) {
            rawGradeName = (row[gradeIdx] ?? "").trim();
            if (rawGradeName && rawGradeName !== currentGradeName) {
              currentGradeName = rawGradeName;
              if (!rawClassName) currentClassName = "";
            }
          } else {
            rawGradeName = parseGradeFromClass(rawClassName);
            if (rawGradeName && rawGradeName !== currentGradeName) currentGradeName = rawGradeName;
          }
          if (rawClassName) currentClassName = rawClassName;
          const gradeName = currentGradeName, className = currentClassName;
          const studentNumber = (row[numberIdx] ?? "").trim(), studentName = (row[nameIdx] ?? "").trim();
          if (!studentNumber && !studentName) continue;
          if (!studentNumber || !studentName) {
            result.students.errors.push({ row, message: "\u7F3A\u5C11\u5B66\u53F7/\u59D3\u540D" });
            continue;
          }
          const username = `P${studentNumber}`, password = username;
          if (!gradeName || !className) {
            result.students.errors.push({ row, message: "\u7F3A\u5C11\u5E74\u7EA7/\u73ED\u7EA7" });
            continue;
          }
          const existingStudent = await this.findByStudentNumber(studentNumber);
          if (existingStudent) {
            if (existingStudent.role_id !== 3) {
              result.students.skipped++;
              result.students.errors.push({ row, message: "\u5B66\u53F7\u5DF2\u88AB\u975E\u5B66\u751F\u8D26\u53F7\u5360\u7528" });
              continue;
            }
            await this.db.transaction(async (tx) => {
              let grade = await tx.get("SELECT id FROM grades WHERE name = ?", gradeName);
              if (!grade) {
                const gr = await tx.run("INSERT INTO grades (name) VALUES (?)", gradeName);
                grade = { id: gr.lastInsertRowid };
              }
              let cls = await tx.get("SELECT id FROM classes WHERE grade_id = ? AND name = ?", grade.id, className);
              if (!cls) {
                const cr = await tx.run("INSERT INTO classes (grade_id, name) VALUES (?, ?)", grade.id, className);
                cls = { id: cr.lastInsertRowid };
              }
              await tx.run("UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND role_id = 3", studentName, existingStudent.id);
              await tx.run("INSERT IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)", cls.id, existingStudent.id);
            });
            result.students.linked++;
            continue;
          }
          if (await this.usernameExists(username) || await this.studentNumberExists(studentNumber)) {
            result.students.skipped++;
            result.students.errors.push({ row, message: "\u7528\u6237\u540D\u6216\u5B66\u53F7\u5DF2\u5B58\u5728" });
            continue;
          }
          const hash = await hashPassword(password);
          await this.db.transaction(async (tx) => {
            let grade = await tx.get("SELECT id FROM grades WHERE name = ?", gradeName);
            if (!grade) {
              const gr = await tx.run("INSERT INTO grades (name) VALUES (?)", gradeName);
              grade = { id: gr.lastInsertRowid };
            }
            let cls = await tx.get("SELECT id FROM classes WHERE grade_id = ? AND name = ?", grade.id, className);
            if (!cls) {
              const cr = await tx.run("INSERT INTO classes (grade_id, name) VALUES (?, ?)", grade.id, className);
              cls = { id: cr.lastInsertRowid };
            }
            const ins = await tx.run("INSERT INTO users (username, password_hash, name, role_id, student_number, initial_password) VALUES (?, ?, ?, 3, ?, ?)", username, hash, studentName, studentNumber, password);
            await tx.run("INSERT IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)", cls.id, ins.lastInsertRowid);
          });
          result.students.created++;
        } catch (err) {
          result.students.errors.push({ row, message: err instanceof Error ? err.message : String(err) });
        }
      }
    } else if (isTeacher) {
      const subjectIdx = header.findIndex((h) => /科目|subject/.test(h));
      const nameIdx = header.findIndex((h) => /姓名|name/.test(h));
      if (subjectIdx < 0 || nameIdx < 0) {
        result.teachers.errors.push({ row: header, message: "\u8868\u5934\u4E0D\u5B8C\u6574" });
        return result;
      }
      for (const row of dataRows.filter((r) => r[nameIdx]?.trim() || r[subjectIdx]?.trim())) {
        try {
          const subject = (row[subjectIdx] ?? "").trim(), teacherName = (row[nameIdx] ?? "").trim();
          if (!subject || !teacherName) {
            result.teachers.errors.push({ row, message: "\u7F3A\u5C11\u79D1\u76EE\u6216\u59D3\u540D" });
            continue;
          }
          const username = this.generateTeacherUsername(), password = this.generateTeacherPassword();
          await this.db.run("INSERT INTO users (username, password_hash, name, role_id, subject, initial_password) VALUES (?, ?, ?, 2, ?, ?)", username, await hashPassword(password), teacherName, subject, password);
          result.teachers.created++;
        } catch (err) {
          result.teachers.errors.push({ row, message: err instanceof Error ? err.message : String(err) });
        }
      }
    } else {
      result.students.errors.push({ row: header, message: "\u65E0\u6CD5\u8BC6\u522B CSV \u7C7B\u578B" });
    }
    return result;
  }
};

// src/server/services/AuthService.ts
init_db();

// src/server/auth/permissions.ts
init_db();
var PERMISSIONS = {
  // 答题卡
  CARD_READ: "card:read",
  CARD_WRITE: "card:write",
  // 考试
  EXAM_READ: "exam:read",
  EXAM_WRITE: "exam:write",
  // 阅卷 / 成绩
  GRADE_READ: "grade:read",
  GRADE_WRITE: "grade:write",
  // 学生查看自己的成绩
  SCORE_READ: "score:read",
  // 用户管理（仅管理员）
  USER_MANAGE: "user:manage",
  // 班级 / 年级管理（仅管理员）
  CLASS_MANAGE: "class:manage",
  // 系统维护（数据清理、归档等，仅管理员）
  SYSTEM_MANAGE: "system:manage"
};
var ROLE_IDS = {
  ADMIN: 1,
  TEACHER: 2,
  STUDENT: 3
};
var ROLE_NAMES = {
  ADMIN: "admin",
  TEACHER: "teacher",
  STUDENT: "student"
};
var TEACHER_ROLES = {
  SUBJECT_TEACHER: "subject_teacher",
  HEAD_TEACHER: "head_teacher",
  GRADE_LEADER: "grade_leader"
};
var TEACHER_ROLE_LABELS = {
  [TEACHER_ROLES.SUBJECT_TEACHER]: "\u5B66\u79D1\u8001\u5E08",
  [TEACHER_ROLES.HEAD_TEACHER]: "\u73ED\u4E3B\u4EFB",
  [TEACHER_ROLES.GRADE_LEADER]: "\u5B66\u5E74\u4E3B\u4EFB"
};
var DEFAULT_ROLE_PERMISSIONS = {
  admin: ["*"],
  teacher: [
    PERMISSIONS.CARD_READ,
    PERMISSIONS.CARD_WRITE,
    PERMISSIONS.EXAM_READ,
    PERMISSIONS.EXAM_WRITE,
    PERMISSIONS.GRADE_READ,
    PERMISSIONS.GRADE_WRITE
  ],
  student: [PERMISSIONS.SCORE_READ]
};
var permissionCache = null;
async function initPermissionCache() {
  const db3 = getMysqlDb();
  const rows = await db3.all("SELECT id, name, permissions FROM roles");
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) {
    let perms = [];
    if (row.permissions) {
      try {
        const parsed = JSON.parse(row.permissions);
        if (Array.isArray(parsed)) perms = parsed.map(String);
      } catch {
        perms = [];
      }
    }
    if (perms.length === 0 && DEFAULT_ROLE_PERMISSIONS[row.name]) {
      perms = DEFAULT_ROLE_PERMISSIONS[row.name];
    }
    map.set(row.id, new Set(perms));
  }
  permissionCache = map;
  console.log("[Perms] Cache loaded:", rows.length, "roles");
}
function loadRolePermissions(forceReload = false) {
  if (!permissionCache || forceReload) {
    const map = /* @__PURE__ */ new Map();
    map.set(1, /* @__PURE__ */ new Set(["*"]));
    map.set(2, new Set(DEFAULT_ROLE_PERMISSIONS.teacher));
    map.set(3, new Set(DEFAULT_ROLE_PERMISSIONS.student));
    return map;
  }
  return permissionCache;
}
function permissionSetGrants(held, required) {
  if (held.has("*")) return true;
  if (held.has(required)) return true;
  const domain = required.split(":")[0];
  if (held.has(`${domain}:*`)) return true;
  return false;
}
function roleHasPermission(roleId, required) {
  const cache = loadRolePermissions();
  const held = cache.get(roleId);
  if (!held) return false;
  return permissionSetGrants(held, required);
}
function permissionsForRole(roleId) {
  const cache = loadRolePermissions();
  return Array.from(cache.get(roleId) ?? []);
}

// src/server/services/AuthService.ts
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync } from "node:fs";
import { join } from "node:path";
var TOKEN_STORE_DIR = join(homedir(), ".projectx");
var TOKEN_STORE_PATH = join(TOKEN_STORE_DIR, "tokens.json");
var TOKEN_EXPIRE_MS = 8 * 60 * 60 * 1e3;
var PERSISTENT_TOKEN_EXPIRE_MS = 180 * 24 * 60 * 60 * 1e3;
var AuthService = class {
  userRepo;
  tokenStore = /* @__PURE__ */ new Map();
  saveScheduled = false;
  constructor() {
    this.userRepo = new UserRepository();
    this.loadTokens();
  }
  /** 从磁盘加载持久化 tokens */
  loadTokens() {
    try {
      if (!existsSync2(TOKEN_STORE_PATH)) return;
      const raw = readFileSync3(TOKEN_STORE_PATH, "utf8");
      const data = JSON.parse(raw);
      const now = Date.now();
      for (const [token, record] of Object.entries(data.tokens ?? {})) {
        if (record.expiresAt > now) {
          this.tokenStore.set(token, record);
        }
      }
      console.log(`[Auth] \u4ECE\u78C1\u76D8\u52A0\u8F7D\u4E86 ${this.tokenStore.size} \u4E2A\u6709\u6548 token`);
    } catch (error) {
      console.error("[Auth] \u52A0\u8F7D\u6301\u4E45\u5316 token \u5931\u8D25:", error);
    }
  }
  /** 异步保存 tokens 到磁盘（合并短时间内的多次写入） */
  scheduleSave() {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setImmediate(() => {
      this.saveScheduled = false;
      this.persistTokens();
    });
  }
  persistTokens() {
    try {
      if (!existsSync2(TOKEN_STORE_DIR)) {
        mkdirSync2(TOKEN_STORE_DIR, { recursive: true });
      }
      const data = { tokens: {} };
      for (const [token, record] of this.tokenStore.entries()) {
        data.tokens[token] = record;
      }
      writeFileSync(TOKEN_STORE_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.error("[Auth] \u6301\u4E45\u5316 token \u5931\u8D25:", error);
    }
  }
  /**
   * 用户登录
   * 支持用户名（学号/职工号）或邮箱登录
   */
  async login(identifier, password, isPersistent = false) {
    let user = await this.userRepo.findByUsername(identifier);
    if (!user && /^\d+$/.test(identifier)) {
      user = await this.userRepo.findByStudentNumber(identifier);
    }
    if (!user) {
      return { success: false, message: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF" };
    }
    let valid = false;
    if (!user.password_hash && user.role_name === "student" && user.student_number && password === user.student_number) {
      const newHash = await hashPassword(user.student_number);
      const db3 = getMysqlDb();
      await db3.run("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", newHash, user.id);
      user.password_hash = newHash;
      valid = true;
    } else {
      valid = await verifyPassword(password, user.password_hash);
    }
    if (!valid) {
      return { success: false, message: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF" };
    }
    await this.userRepo.updateLastLogin(user.id);
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + (isPersistent ? PERSISTENT_TOKEN_EXPIRE_MS : TOKEN_EXPIRE_MS);
    this.tokenStore.set(token, { userId: user.id, expiresAt });
    this.scheduleSave();
    const { password_hash, ...safeUser } = user;
    return {
      success: true,
      user: safeUser,
      token,
      permissions: permissionsForRole(user.role_id),
      message: "\u767B\u5F55\u6210\u529F"
    };
  }
  /**
   * 修改密码（需校验原密码）。
   * 任何已登录用户均可修改自己的密码。
   */
  async changePassword(userId, oldPassword, newPassword) {
    const passwordError = validateUserChosenPassword(newPassword);
    if (passwordError) return { success: false, message: passwordError };
    const db3 = getMysqlDb();
    const row = await db3.get("SELECT password_hash FROM users WHERE id = ?", userId);
    if (!row) {
      return { success: false, message: "\u7528\u6237\u4E0D\u5B58\u5728" };
    }
    if (row.password_hash) {
      const valid = await verifyPassword(oldPassword, row.password_hash);
      if (!valid) {
        return { success: false, message: "\u539F\u5BC6\u7801\u9519\u8BEF" };
      }
    }
    const newHash = await hashPassword(newPassword);
    await db3.run("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", newHash, userId);
    this.revokeUserTokens(userId);
    return { success: true, message: "\u5BC6\u7801\u4FEE\u6539\u6210\u529F\uFF0C\u8BF7\u4F7F\u7528\u65B0\u5BC6\u7801\u91CD\u65B0\u767B\u5F55" };
  }
  /**
   * 吊销指定用户的所有 token（改密 / 禁用账号时调用）。
   */
  revokeUserTokens(userId) {
    let changed = false;
    for (const [token, record] of this.tokenStore.entries()) {
      if (record.userId === userId) {
        this.tokenStore.delete(token);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }
  /**
   * 验证 token
   */
  verifyToken(token) {
    const record = this.tokenStore.get(token);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      this.tokenStore.delete(token);
      this.scheduleSave();
      return null;
    }
    return { userId: record.userId };
  }
  /**
   * 根据 token 获取用户
   */
  async getUserByToken(token) {
    const record = this.verifyToken(token);
    if (!record) return null;
    const user = await this.userRepo.findById(record.userId);
    if (!user) return null;
    const { password_hash, ...safeUser } = user;
    return safeUser;
  }
  /**
   * 退出登录
   */
  logout(token) {
    if (this.tokenStore.delete(token)) {
      this.scheduleSave();
    }
  }
  /**
   * 清理过期 token（定时执行）
   */
  cleanupExpiredTokens() {
    const now = Date.now();
    let changed = false;
    for (const [token, record] of this.tokenStore.entries()) {
      if (now > record.expiresAt) {
        this.tokenStore.delete(token);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }
};
var authService = new AuthService();

// src/server/middleware/auth.ts
var AUTH_COOKIE_NAME = "projectx_auth_token";
function tokenFromCookie(req) {
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return null;
  for (const part of rawCookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === AUTH_COOKIE_NAME) {
      return decodeURIComponent(valueParts.join("="));
    }
  }
  return null;
}
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const cookieToken = tokenFromCookie(req);
  if (cookieToken) {
    return cookieToken;
  }
  const queryToken = req.query.token;
  if (typeof queryToken === "string" && queryToken) {
    return queryToken;
  }
  return null;
}
async function attachUser(req, token) {
  const user = await authService.getUserByToken(token);
  if (!user) return false;
  req.user = {
    id: user.id,
    username: user.username,
    name: user.name,
    role_id: user.role_id,
    role_name: user.role_name ?? "unknown",
    student_number: user.student_number ?? null,
    teacher_role: user.teacher_role ?? null,
    subject: user.subject ?? null
  };
  return true;
}
async function authMiddleware(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ message: "\u672A\u63D0\u4F9B\u8BA4\u8BC1\u4EE4\u724C" });
    return;
  }
  if (!await attachUser(req, token)) {
    res.status(401).json({ message: "\u8BA4\u8BC1\u4EE4\u724C\u65E0\u6548\u6216\u5DF2\u8FC7\u671F" });
    return;
  }
  next();
}
async function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  if (token) {
    await attachUser(req, token);
  }
  next();
}
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ message: "\u672A\u8BA4\u8BC1" });
      return;
    }
    if (!allowedRoles.includes(req.user.role_name)) {
      res.status(403).json({ message: "\u6743\u9650\u4E0D\u8DB3\uFF1A\u9700\u8981\u89D2\u8272 " + allowedRoles.join("/") });
      return;
    }
    next();
  };
}
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ message: "\u672A\u8BA4\u8BC1" });
      return;
    }
    if (!roleHasPermission(req.user.role_id, permission)) {
      res.status(403).json({ message: `\u6743\u9650\u4E0D\u8DB3\uFF1A\u7F3A\u5C11 ${permission}` });
      return;
    }
    next();
  };
}
async function getCurrentUserHandler(req, res) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ message: "\u672A\u8BA4\u8BC1" });
    return;
  }
  const user = await authService.getUserByToken(token);
  if (!user) {
    res.status(401).json({ message: "\u8BA4\u8BC1\u4EE4\u724C\u65E0\u6548\u6216\u5DF2\u8FC7\u671F" });
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    role_id: user.role_id,
    role_name: user.role_name,
    role_display_name: user.role_display_name,
    student_number: user.student_number,
    teacher_role: user.teacher_role ?? null,
    subject: user.subject ?? null,
    email: user.email,
    last_login_at: user.last_login_at,
    permissions: permissionsForRole(user.role_id)
  });
}

// src/server/routes/auth.ts
var router = express.Router();
var PERSISTENT_TOKEN_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1e3;
function setAuthCookie(res, token, isPersistent) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    ...isPersistent ? { maxAge: PERSISTENT_TOKEN_COOKIE_MAX_AGE_MS } : {}
  });
}
function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    path: "/",
    sameSite: "lax"
  });
}
router.post("/login", async (req, res) => {
  try {
    const { identifier, password, isPersistent } = req.body;
    if (!identifier || !password) {
      res.status(400).json({ message: "\u8BF7\u8F93\u5165\u7528\u6237\u540D\u548C\u5BC6\u7801" });
      return;
    }
    const result = await authService.login(identifier, password, !!isPersistent);
    if (!result.success) {
      res.status(401).json({ message: result.message });
      return;
    }
    if (result.token) {
      setAuthCookie(res, result.token, !!isPersistent);
    }
    res.json({
      token: result.token,
      user: result.user,
      permissions: result.permissions,
      message: result.message
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "\u670D\u52A1\u5668\u9519\u8BEF" });
  }
});
router.post("/logout", (req, res) => {
  const token = extractToken(req);
  if (token) {
    authService.logout(token);
  }
  clearAuthCookie(res);
  res.json({ message: "\u5DF2\u9000\u51FA\u767B\u5F55" });
});
router.get("/me", getCurrentUserHandler);
router.post("/change-password", authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body ?? {};
    if (!newPassword) {
      res.status(400).json({ message: "\u8BF7\u8F93\u5165\u65B0\u5BC6\u7801" });
      return;
    }
    const result = await authService.changePassword(req.user.id, String(oldPassword ?? ""), String(newPassword));
    if (!result.success) {
      res.status(400).json({ message: result.message });
      return;
    }
    res.json({ message: result.message });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ message: "\u670D\u52A1\u5668\u9519\u8BEF" });
  }
});
var auth_default = router;

// src/server/routes/users.ts
import express2 from "express";
var router2 = express2.Router();
var userRepo = new UserRepository();
router2.use(authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE));
function stripHash(user) {
  const { password_hash, ...rest } = user;
  return rest;
}
var ROLE_NAME_TO_ID = {
  [ROLE_NAMES.ADMIN]: ROLE_IDS.ADMIN,
  [ROLE_NAMES.TEACHER]: ROLE_IDS.TEACHER,
  [ROLE_NAMES.STUDENT]: ROLE_IDS.STUDENT
};
function resolveRoleId(role) {
  if (typeof role === "number" && [1, 2, 3].includes(role)) return role;
  if (typeof role === "string") {
    if (ROLE_NAME_TO_ID[role] !== void 0) return ROLE_NAME_TO_ID[role];
    const n = Number(role);
    if ([1, 2, 3].includes(n)) return n;
  }
  return null;
}
router2.get("/", async (req, res) => {
  const page = req.query.page ? Number(req.query.page) : 1;
  const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 20;
  const roleName = typeof req.query.role === "string" ? req.query.role : void 0;
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword : void 0;
  const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";
  const { users, total } = await userRepo.adminListUsers({ page, pageSize, roleName, keyword, includeInactive });
  res.json({
    users: users.map(stripHash),
    total,
    page,
    pageSize,
    roleSummary: await userRepo.countByRole()
  });
});
router2.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const user = await userRepo.findByIdIncludingInactive(id);
  if (!user) {
    res.status(404).json({ message: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return;
  }
  res.json({ ...stripHash(user), classes: await userRepo.getUserClasses(id) });
});
router2.post("/", async (req, res) => {
  try {
    const { username, password, name, role, student_number, email, phone, teacher_role } = req.body ?? {};
    if (!username || !name) {
      res.status(400).json({ message: "\u7F3A\u5C11\u7528\u6237\u540D\u6216\u59D3\u540D" });
      return;
    }
    const roleId = resolveRoleId(role);
    if (roleId === null) {
      res.status(400).json({ message: "\u65E0\u6548\u7684\u89D2\u8272\uFF0C\u9700\u4E3A admin/teacher/student" });
      return;
    }
    if (await userRepo.usernameExists(String(username))) {
      res.status(409).json({ message: "\u7528\u6237\u540D\u5DF2\u5B58\u5728" });
      return;
    }
    if (roleId === ROLE_IDS.STUDENT && !student_number) {
      res.status(400).json({ message: "\u5B66\u751F\u8D26\u53F7\u5FC5\u987B\u63D0\u4F9B\u5B66\u53F7" });
      return;
    }
    if (student_number && await userRepo.studentNumberExists(String(student_number))) {
      res.status(409).json({ message: "\u5B66\u53F7\u5DF2\u5B58\u5728" });
      return;
    }
    if (roleId === ROLE_IDS.TEACHER && teacher_role && !["subject_teacher", "head_teacher", "grade_leader"].includes(teacher_role)) {
      res.status(400).json({ message: "\u65E0\u6548\u7684\u6559\u5E08\u89D2\u8272" });
      return;
    }
    const finalPassword = password || (roleId === ROLE_IDS.STUDENT ? String(student_number) : "");
    const passwordError = validateInitialPassword({
      password: String(finalPassword),
      isStudent: roleId === ROLE_IDS.STUDENT,
      studentNumber: student_number ? String(student_number) : void 0
    });
    if (passwordError) {
      res.status(400).json({ message: passwordError });
      return;
    }
    const created = await await userRepo.createUser({
      username: String(username),
      password: String(finalPassword),
      name: String(name),
      role_id: roleId,
      student_number: student_number ? String(student_number) : void 0,
      teacher_role: roleId === ROLE_IDS.TEACHER ? teacher_role || void 0 : void 0,
      email: email ? String(email) : void 0,
      phone: phone ? String(phone) : void 0
    });
    res.status(201).json(stripHash(created));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u521B\u5EFA\u5931\u8D25" });
  }
});
router2.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await userRepo.findByIdIncludingInactive(id);
    if (!existing) {
      res.status(404).json({ message: "\u7528\u6237\u4E0D\u5B58\u5728" });
      return;
    }
    const { name, email, phone, role, is_active, student_number, teacher_role } = req.body ?? {};
    const params = {};
    if (name !== void 0) params.name = String(name);
    if (email !== void 0) params.email = String(email);
    if (phone !== void 0) params.phone = String(phone);
    if (is_active !== void 0) params.is_active = is_active ? 1 : 0;
    if (student_number !== void 0) params.student_number = String(student_number);
    if (role !== void 0) {
      const roleId = resolveRoleId(role);
      if (roleId === null) {
        res.status(400).json({ message: "\u65E0\u6548\u7684\u89D2\u8272" });
        return;
      }
      if (existing.role_id === ROLE_IDS.ADMIN && roleId !== ROLE_IDS.ADMIN) {
        const admins = await userRepo.adminListUsers({ roleName: ROLE_NAMES.ADMIN, pageSize: 1e3 });
        if (admins.total <= 1) {
          res.status(400).json({ message: "\u7CFB\u7EDF\u81F3\u5C11\u9700\u4FDD\u7559\u4E00\u540D\u7BA1\u7406\u5458\uFF0C\u65E0\u6CD5\u964D\u7EA7" });
          return;
        }
      }
      params.role_id = roleId;
    }
    if (teacher_role !== void 0) {
      if (teacher_role && !["subject_teacher", "head_teacher", "grade_leader"].includes(teacher_role)) {
        res.status(400).json({ message: "\u65E0\u6548\u7684\u6559\u5E08\u89D2\u8272" });
        return;
      }
      params.teacher_role = teacher_role || null;
    }
    await await userRepo.updateUser(id, params);
    if (params.is_active === 0) authService.revokeUserTokens(id);
    const updated = await userRepo.findByIdIncludingInactive(id);
    res.json(updated ? stripHash(updated) : null);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u66F4\u65B0\u5931\u8D25" });
  }
});
router2.post("/:id/reset-password", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await userRepo.findByIdIncludingInactive(id);
    if (!existing) {
      res.status(404).json({ message: "\u7528\u6237\u4E0D\u5B58\u5728" });
      return;
    }
    const { newPassword } = req.body ?? {};
    const password = newPassword ? String(newPassword) : existing.student_number || "";
    const passwordError = validateInitialPassword({
      password,
      isStudent: existing.role_id === ROLE_IDS.STUDENT,
      studentNumber: existing.student_number
    });
    if (passwordError) {
      res.status(400).json({ message: passwordError });
      return;
    }
    await await userRepo.updateUser(id, { password });
    authService.revokeUserTokens(id);
    res.json({ message: "\u5BC6\u7801\u5DF2\u91CD\u7F6E" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u91CD\u7F6E\u5931\u8D25" });
  }
});
router2.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await userRepo.findByIdIncludingInactive(id);
  if (!existing) {
    res.status(404).json({ message: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return;
  }
  if (existing.role_id === ROLE_IDS.ADMIN) {
    const admins = await userRepo.adminListUsers({ roleName: ROLE_NAMES.ADMIN, pageSize: 1e3 });
    if (admins.total <= 1) {
      res.status(400).json({ message: "\u7CFB\u7EDF\u81F3\u5C11\u9700\u4FDD\u7559\u4E00\u540D\u7BA1\u7406\u5458\uFF0C\u65E0\u6CD5\u7981\u7528" });
      return;
    }
  }
  await userRepo.deactivateUser(id);
  authService.revokeUserTokens(id);
  res.json({ message: "\u8D26\u53F7\u5DF2\u7981\u7528" });
});
router2.post("/:id/reactivate", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await userRepo.findByIdIncludingInactive(id);
  if (!existing) {
    res.status(404).json({ message: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return;
  }
  await userRepo.reactivateUser(id);
  res.json({ message: "\u8D26\u53F7\u5DF2\u542F\u7528" });
});
router2.post("/import-students", async (req, res) => {
  try {
    const students = req.body?.students;
    if (!Array.isArray(students) || students.length === 0) {
      res.status(400).json({ message: "\u8BF7\u63D0\u4F9B students \u6570\u7EC4" });
      return;
    }
    const rows = students.map((s) => ({
      username: String(s.username ?? s.student_number ?? ""),
      name: String(s.name ?? ""),
      student_number: String(s.student_number ?? ""),
      password: s.password ? String(s.password) : void 0
    }));
    const result = await await userRepo.batchCreateStudents(rows);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u5BFC\u5165\u5931\u8D25" });
  }
});
router2.post("/import-csv", async (req, res) => {
  try {
    const { csvText } = req.body ?? {};
    if (!csvText || typeof csvText !== "string" || !csvText.trim()) {
      res.status(400).json({ message: "\u8BF7\u63D0\u4F9B csvText\uFF08CSV \u6587\u672C\u5185\u5BB9\uFF09" });
      return;
    }
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      res.status(400).json({ message: "CSV \u81F3\u5C11\u9700\u8981\u8868\u5934+1\u884C\u6570\u636E" });
      return;
    }
    const parseCsvLine = (line) => {
      const cells = [];
      let cell = "";
      let inQuotes = false;
      const sep = line.includes(",") ? "," : "	";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"') {
            if (line[i + 1] === '"') {
              cell += '"';
              i++;
            } else {
              inQuotes = false;
            }
          } else {
            cell += ch;
          }
        } else {
          if (ch === '"') {
            inQuotes = true;
          } else if (ch === sep) {
            cells.push(cell.trim());
            cell = "";
          } else {
            cell += ch;
          }
        }
      }
      cells.push(cell.trim());
      return cells;
    };
    const rows = lines.map(parseCsvLine);
    const result = await await userRepo.batchImportFromCsv(rows);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u5BFC\u5165\u5931\u8D25" });
  }
});
var users_default = router2;

// src/server/routes/classes.ts
import express3 from "express";

// src/server/repositories/ClassRepository.ts
init_db();
var ClassRepository = class {
  db;
  constructor() {
    this.db = getMysqlDb();
  }
  // ── 年级 ──────────────────────────────────────────────
  async listGrades() {
    return await this.db.all("SELECT * FROM grades ORDER BY sort_order ASC, id ASC");
  }
  async createGrade(name, sortOrder = 0) {
    const result = await this.db.run("INSERT INTO grades (name, sort_order) VALUES (?, ?)", name, sortOrder);
    return await this.db.get("SELECT * FROM grades WHERE id = ?", result.lastInsertRowid);
  }
  async deleteGrade(id) {
    await this.db.run("DELETE FROM grades WHERE id = ?", id);
  }
  // ── 班级 ──────────────────────────────────────────────
  async listClasses(gradeId) {
    let sql = `
      SELECT c.*, g.name as grade_name,
        (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.id) as student_count
      FROM classes c
      JOIN grades g ON g.id = c.grade_id
    `;
    const params = [];
    if (gradeId) {
      sql += " WHERE c.grade_id = ?";
      params.push(gradeId);
    }
    sql += " ORDER BY g.sort_order ASC, c.sort_order ASC, c.id ASC";
    return await this.db.all(sql, ...params);
  }
  async findClassById(id) {
    return await this.db.get(`
      SELECT c.*, g.name as grade_name
      FROM classes c JOIN grades g ON g.id = c.grade_id
      WHERE c.id = ?
    `, id);
  }
  async createClass(gradeId, name, sortOrder = 0) {
    const result = await this.db.run("INSERT INTO classes (grade_id, name, sort_order) VALUES (?, ?, ?)", gradeId, name, sortOrder);
    return await this.findClassById(result.lastInsertRowid);
  }
  async deleteClass(id) {
    await this.db.run("DELETE FROM classes WHERE id = ?", id);
  }
  // ── 花名册 ────────────────────────────────────────────
  async listStudents(classId) {
    return await this.db.all(`
      SELECT cs.student_id, u.username, u.name, u.student_number, cs.joined_at
      FROM class_students cs
      JOIN users u ON u.id = cs.student_id
      WHERE cs.class_id = ? AND u.is_active = 1
      ORDER BY u.student_number ASC, u.id ASC
    `, classId);
  }
  async addStudent(classId, studentId) {
    await this.db.run("INSERT IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)", classId, studentId);
  }
  async addStudents(classId, studentIds) {
    let added = 0;
    await this.db.transaction(async (tx) => {
      for (const sid of studentIds) {
        const r = await tx.run("INSERT IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)", classId, sid);
        added += r.changes;
      }
    });
    return added;
  }
  async removeStudent(classId, studentId) {
    await this.db.run("DELETE FROM class_students WHERE class_id = ? AND student_id = ?", classId, studentId);
  }
  async isStudentInClass(classId, studentId) {
    const row = await this.db.get("SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ? LIMIT 1", classId, studentId);
    return Boolean(row);
  }
  // ── v1.1.0: 教师-班级关联 ─────────────────────────────
  async addTeacherToClass(teacherId, classId, subject) {
    await this.db.run("INSERT IGNORE INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, ?)", teacherId, classId, subject ?? null);
  }
  async removeTeacherFromClass(teacherId, classId) {
    await this.db.run("DELETE FROM teacher_classes WHERE teacher_id = ? AND class_id = ?", teacherId, classId);
  }
  async listTeacherClasses(teacherId) {
    return await this.db.all(`
      SELECT tc.class_id, c.name as class_name, g.name as grade_name, tc.subject
      FROM teacher_classes tc
      JOIN classes c ON c.id = tc.class_id
      JOIN grades g ON g.id = c.grade_id
      WHERE tc.teacher_id = ?
      ORDER BY g.sort_order ASC, c.sort_order ASC
    `, teacherId);
  }
  async listAllClassesWithGrade() {
    return await this.db.all(`
      SELECT c.id as class_id, c.name as class_name, g.id as grade_id, g.name as grade_name
      FROM classes c
      JOIN grades g ON g.id = c.grade_id
      ORDER BY g.sort_order ASC, c.sort_order ASC
    `);
  }
};

// src/server/routes/classes.ts
var router3 = express3.Router();
var classRepo = new ClassRepository();
var userRepo2 = new UserRepository();
router3.use(authMiddleware);
var readRoles = requireRole(ROLE_NAMES.ADMIN, ROLE_NAMES.TEACHER);
var manage = requirePermission(PERMISSIONS.CLASS_MANAGE);
router3.get("/grades", readRoles, async (_req, res) => {
  res.json(await classRepo.listGrades());
});
router3.post("/grades", manage, async (req, res) => {
  const { name, sortOrder } = req.body ?? {};
  if (!name) {
    res.status(400).json({ message: "\u7F3A\u5C11\u5E74\u7EA7\u540D\u79F0" });
    return;
  }
  res.status(201).json(await classRepo.createGrade(String(name), Number(sortOrder ?? 0)));
});
router3.delete("/grades/:id", manage, async (req, res) => {
  await classRepo.deleteGrade(Number(req.params.id));
  res.json({ message: "\u5E74\u7EA7\u5DF2\u5220\u9664\uFF08\u542B\u5176\u4E0B\u73ED\u7EA7\uFF09" });
});
router3.get("/", readRoles, async (req, res) => {
  const gradeId = req.query.gradeId ? Number(req.query.gradeId) : void 0;
  res.json(await classRepo.listClasses(gradeId));
});
router3.post("/", manage, async (req, res) => {
  const { gradeId, name, sortOrder } = req.body ?? {};
  if (!gradeId || !name) {
    res.status(400).json({ message: "\u7F3A\u5C11 gradeId \u6216\u73ED\u7EA7\u540D\u79F0" });
    return;
  }
  res.status(201).json(await classRepo.createClass(Number(gradeId), String(name), Number(sortOrder ?? 0)));
});
router3.delete("/:id", manage, async (req, res) => {
  const cls = await classRepo.findClassById(Number(req.params.id));
  if (!cls) {
    res.status(404).json({ message: "\u73ED\u7EA7\u4E0D\u5B58\u5728" });
    return;
  }
  await classRepo.deleteClass(cls.id);
  res.json({ message: "\u73ED\u7EA7\u5DF2\u5220\u9664" });
});
router3.get("/:id/students", readRoles, async (req, res) => {
  const cls = await classRepo.findClassById(Number(req.params.id));
  if (!cls) {
    res.status(404).json({ message: "\u73ED\u7EA7\u4E0D\u5B58\u5728" });
    return;
  }
  res.json(await classRepo.listStudents(cls.id));
});
router3.post("/:id/students", manage, async (req, res) => {
  const cls = await classRepo.findClassById(Number(req.params.id));
  if (!cls) {
    res.status(404).json({ message: "\u73ED\u7EA7\u4E0D\u5B58\u5728" });
    return;
  }
  const { studentId, studentIds } = req.body ?? {};
  const ids = Array.isArray(studentIds) ? studentIds.map(Number) : studentId ? [Number(studentId)] : [];
  if (ids.length === 0) {
    res.status(400).json({ message: "\u8BF7\u63D0\u4F9B studentId \u6216 studentIds" });
    return;
  }
  const invalid = [];
  for (const sid of ids) {
    const u = await userRepo2.findByIdIncludingInactive(sid);
    if (!u || u.role_id !== ROLE_IDS.STUDENT) invalid.push(sid);
  }
  if (invalid.length > 0) {
    res.status(400).json({ message: `\u4EE5\u4E0B ID \u975E\u6709\u6548\u5B66\u751F\u8D26\u53F7\uFF1A${invalid.join(", ")}` });
    return;
  }
  const added = await classRepo.addStudents(cls.id, ids);
  res.json({ message: `\u5DF2\u6DFB\u52A0 ${added} \u540D\u5B66\u751F`, added });
});
router3.delete("/:id/students/:studentId", manage, async (req, res) => {
  await classRepo.removeStudent(Number(req.params.id), Number(req.params.studentId));
  res.json({ message: "\u5DF2\u4ECE\u73ED\u7EA7\u79FB\u9664" });
});
var classes_default = router3;

// src/server/routes/teachers.ts
import express4 from "express";
var router4 = express4.Router();
var userRepo3 = new UserRepository();
var classRepo2 = new ClassRepository();
router4.use(authMiddleware);
router4.use(requirePermission(PERMISSIONS.USER_MANAGE));
function stripHash2(user) {
  const { password_hash, ...rest } = user;
  return rest;
}
router4.get("/", async (req, res) => {
  const page = req.query.page ? Number(req.query.page) : 1;
  const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 50;
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword : void 0;
  const { teachers, total } = await userRepo3.listTeachers({ keyword, page, pageSize });
  res.json({ teachers: teachers.map(stripHash2), total, page, pageSize });
});
router4.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const teacher = await userRepo3.findTeacherById(id);
  if (!teacher) {
    res.status(404).json({ message: "\u6559\u5E08\u4E0D\u5B58\u5728" });
    return;
  }
  res.json(stripHash2(teacher));
});
router4.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await userRepo3.findByIdIncludingInactive(id);
    if (!existing || existing.role_id !== ROLE_IDS.TEACHER) {
      res.status(404).json({ message: "\u6559\u5E08\u4E0D\u5B58\u5728" });
      return;
    }
    const { name, subject, teacher_role } = req.body ?? {};
    const params = {};
    if (name !== void 0) params.name = String(name);
    if (subject !== void 0) params.subject = String(subject);
    if (teacher_role !== void 0) {
      if (![null, void 0, "subject_teacher", "head_teacher", "grade_leader"].includes(teacher_role)) {
        res.status(400).json({ message: "\u65E0\u6548\u7684\u6559\u5E08\u89D2\u8272" });
        return;
      }
      params.teacher_role = teacher_role || null;
    }
    await await userRepo3.updateTeacher(id, params);
    const updated = await userRepo3.findTeacherById(id);
    res.json(updated ? stripHash2(updated) : null);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u66F4\u65B0\u5931\u8D25" });
  }
});
router4.post("/:id/classes", async (req, res) => {
  try {
    const teacherId = Number(req.params.id);
    const existing = await userRepo3.findByIdIncludingInactive(teacherId);
    if (!existing || existing.role_id !== ROLE_IDS.TEACHER) {
      res.status(404).json({ message: "\u6559\u5E08\u4E0D\u5B58\u5728" });
      return;
    }
    const { classIds, subject } = req.body ?? {};
    const ids = Array.isArray(classIds) ? classIds.map(Number) : [];
    if (ids.length === 0) {
      res.status(400).json({ message: "\u8BF7\u63D0\u4F9B classIds \u6570\u7EC4" });
      return;
    }
    let added = 0;
    for (const classId of ids) {
      const cls = await classRepo2.findClassById(classId);
      if (!cls) continue;
      await classRepo2.addTeacherToClass(teacherId, classId, subject ? String(subject) : void 0);
      added++;
    }
    const teacher = await userRepo3.findTeacherById(teacherId);
    res.json({ message: `\u5DF2\u5173\u8054 ${added} \u4E2A\u73ED\u7EA7`, teacher: teacher ? stripHash2(teacher) : null });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u5173\u8054\u5931\u8D25" });
  }
});
router4.delete("/:id/classes/:classId", async (req, res) => {
  try {
    const teacherId = Number(req.params.id);
    const classId = Number(req.params.classId);
    await classRepo2.removeTeacherFromClass(teacherId, classId);
    const teacher = await userRepo3.findTeacherById(teacherId);
    res.json({ message: "\u5DF2\u89E3\u9664\u5173\u8054", teacher: teacher ? stripHash2(teacher) : null });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u89E3\u9664\u5931\u8D25" });
  }
});
router4.get("/:id/classes", async (req, res) => {
  const teacherId = Number(req.params.id);
  res.json(await classRepo2.listTeacherClasses(teacherId));
});
var teachers_default = router4;

// src/server/routes/export.ts
import express5 from "express";
import XLSX from "xlsx";
var router5 = express5.Router();
var userRepo4 = new UserRepository();
router5.use(authMiddleware);
router5.use(requirePermission(PERMISSIONS.USER_MANAGE));
router5.get("/students", async (_req, res) => {
  try {
    const rows = await userRepo4.listAllStudentsForExport();
    const data = rows.map((r) => ({
      "\u5E74\u7EA7": r.grade_name,
      "\u73ED\u7EA7": r.class_name,
      "\u5B66\u53F7": r.student_number ?? "",
      "\u59D3\u540D": r.name,
      "\u8D26\u53F7": r.username,
      "\u5BC6\u7801": r.initial_password ?? ""
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [
      { wch: 8 },
      { wch: 12 },
      { wch: 14 },
      { wch: 10 },
      { wch: 16 },
      { wch: 16 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "\u5B66\u751F\u8D26\u5BC6");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''student_accounts.xlsx");
    res.send(buf);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u5BFC\u51FA\u5931\u8D25" });
  }
});
router5.get("/teachers", async (_req, res) => {
  try {
    const teachers = await userRepo4.listAllTeachersForExport();
    const data = teachers.map((t) => ({
      "\u79D1\u76EE": t.subject ?? "",
      "\u59D3\u540D": t.name,
      "\u8D26\u53F7": t.username,
      "\u5BC6\u7801": t.initial_password ?? ""
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [
      { wch: 10 },
      { wch: 12 },
      { wch: 16 },
      { wch: 16 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "\u6559\u5E08\u8D26\u5BC6");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''teacher_accounts.xlsx");
    res.send(buf);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u5BFC\u51FA\u5931\u8D25" });
  }
});
router5.get("/students.csv", async (req, res) => {
  res.redirect(301, "/api/export/students");
});
router5.get("/teachers.csv", async (req, res) => {
  res.redirect(301, "/api/export/teachers");
});
var export_default = router5;

// src/server/routes/scores.ts
import express6 from "express";
var router6 = express6.Router();
var scoreRepo = new ScoreRepository();
var userRepo5 = new UserRepository();
router6.use(authMiddleware);
router6.get("/me", async (req, res) => {
  const scores = await scoreRepo.getStudentScores(req.user.id);
  res.json({ studentId: req.user.id, name: req.user.name, scores });
});
router6.get("/me/exams/:examId", async (req, res) => {
  const examId = Number(req.params.examId);
  if (!await scoreRepo.hasScore(req.user.id, examId)) {
    res.status(404).json({ message: "\u672A\u627E\u5230\u4F60\u5728\u8BE5\u573A\u8003\u8BD5\u7684\u6210\u7EE9" });
    return;
  }
  res.json({
    examId,
    questions: await scoreRepo.getStudentQuestionScores(req.user.id, examId)
  });
});
router6.get("/me/trends", async (req, res) => {
  const subject = typeof req.query.subject === "string" ? req.query.subject : void 0;
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : void 0;
  let trends = await scoreRepo.getStudentTrendData(req.user.id);
  if (subject) trends = trends.filter((t) => t.subject === subject);
  if (limit && limit > 0) trends = trends.slice(-limit);
  res.json(trends);
});
router6.get("/me/subject-comparison", async (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 0;
  const trends = await scoreRepo.getStudentTrendData(req.user.id);
  const bySubject = /* @__PURE__ */ new Map();
  for (const t of trends) {
    if (!t.subject) continue;
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject).push(t);
  }
  const subjects = [];
  for (const [subject, points] of bySubject) {
    const scores = points.map((p) => p.totalScore);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10;
    const avgClassAvg = Math.round(points.reduce((a, p) => a + p.classAvg, 0) / points.length * 10) / 10;
    const gapToClass = Math.round((avgScore - avgClassAvg) * 10) / 10;
    const bestScore = Math.max(...scores);
    const worstScore = Math.min(...scores);
    const sorted = [...points].sort((a, b) => a.examTime.localeCompare(b.examTime));
    let trend = "stable";
    if (sorted.length >= 2) {
      const last = sorted[sorted.length - 1].totalScore;
      const prev = sorted[sorted.length - 2].totalScore;
      if (last - prev > 3) trend = "up";
      else if (prev - last > 3) trend = "down";
    }
    subjects.push({ subject, examCount: points.length, avgScore, avgClassAvg, gapToClass, bestScore, worstScore, trend });
  }
  subjects.sort((a, b) => a.gapToClass - b.gapToClass);
  const weakSubject = subjects.length > 0 ? subjects[0].subject : null;
  res.json({
    subjects: limit > 0 ? subjects.slice(0, limit) : subjects,
    weakSubject,
    totalExams: trends.length
  });
});
var LLM_CLIENT_BASE = process.env.LLM_CLIENT_URL || "http://127.0.0.1:8766";
var LLM_INTERNAL_KEY = process.env.LLM_INTERNAL_KEY || "";
router6.post("/me/exams/:examId/ai-analysis", async (req, res) => {
  const examId = Number(req.params.examId);
  if (!Number.isFinite(examId) || examId <= 0) {
    res.status(400).json({ message: "\u65E0\u6548\u7684\u8003\u8BD5 ID" });
    return;
  }
  if (!await scoreRepo.hasScore(req.user.id, examId)) {
    res.status(403).json({ message: "\u4F60\u672A\u53C2\u52A0\u8BE5\u8003\u8BD5" });
    return;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12e4);
    const response = await fetch(`${LLM_CLIENT_BASE}/analysis/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...LLM_INTERNAL_KEY ? { Authorization: `Bearer ${LLM_INTERNAL_KEY}` } : {}
      },
      body: JSON.stringify({
        examId,
        model: typeof req.body?.model === "string" ? req.body.model : void 0,
        locale: "zh-CN"
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) {
      let message = `LLM service returned ${response.status}`;
      try {
        const body = await response.json();
        message = body.detail || body.message || message;
      } catch {
        const text = await response.text().catch(() => "");
        if (text) message = text;
      }
      res.status(response.status >= 400 && response.status < 500 ? response.status : 502).json({ message });
      return;
    }
    res.json(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      res.status(504).json({ message: "AI \u670D\u52A1\u8BF7\u6C42\u8D85\u65F6\u3002" });
      return;
    }
    res.status(503).json({ message: `AI \u670D\u52A1\u4E0D\u53EF\u7528: ${error instanceof Error ? error.message : String(error)}` });
  }
});
router6.post("/me/ai-analysis", async (req, res) => {
  const trends = await scoreRepo.getStudentTrendData(req.user.id);
  if (trends.length === 0) {
    res.status(400).json({ message: "\u6682\u65E0\u6210\u7EE9\u6570\u636E\u53EF\u5206\u6790" });
    return;
  }
  const bySubject = /* @__PURE__ */ new Map();
  for (const t of trends) {
    if (!t.subject) continue;
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject).push(t);
  }
  const subjectSummaries = Array.from(bySubject.entries()).map(([subject, points]) => {
    const scores = points.map((p) => p.totalScore);
    const avg = Math.round(scores.reduce((s, p) => s + p, 0) / points.length * 10) / 10;
    const classAvg = Math.round(points.reduce((s, p) => s + p.classAvg, 0) / points.length * 10) / 10;
    const gap = Math.round((avg - classAvg) * 10) / 10;
    const best = Math.max(...scores);
    const worst = Math.min(...scores);
    const sorted = [...points].sort((a, b) => a.examTime.localeCompare(b.examTime));
    let trend = "stable";
    if (sorted.length >= 2) {
      const last = sorted[sorted.length - 1].totalScore;
      const prev = sorted[sorted.length - 2].totalScore;
      if (last - prev > 3) trend = "up";
      else if (prev - last > 3) trend = "down";
    }
    return { subject, examCount: points.length, avgScore: avg, avgClassAvg: classAvg, gapToClass: gap, bestScore: best, worstScore: worst, trend };
  });
  subjectSummaries.sort((a, b) => a.gapToClass - b.gapToClass);
  const weakSubject = subjectSummaries.length > 0 ? subjectSummaries[0].subject : null;
  const strongSubjects = subjectSummaries.filter((s) => s.gapToClass > 0).map((s) => s.subject);
  const weakSubjects = subjectSummaries.filter((s) => s.gapToClass < 0).map((s) => `${s.subject}\uFF08\u4F4E\u4E8E\u5747\u5206 ${Math.abs(s.gapToClass)} \u5206\uFF09`);
  const improvingSubjects = subjectSummaries.filter((s) => s.trend === "up").map((s) => s.subject);
  const decliningSubjects = subjectSummaries.filter((s) => s.trend === "down").map((s) => s.subject);
  const weakPoints = [];
  const suggestions = [];
  const caveats = [];
  if (weakSubjects.length > 0) {
    weakPoints.push(`\u8584\u5F31\u5B66\u79D1\uFF1A${weakSubjects.join("\u3001")}\u3002\u5EFA\u8BAE\u5728\u8FD9\u4E9B\u79D1\u76EE\u4E0A\u6295\u5165\u66F4\u591A\u590D\u4E60\u65F6\u95F4\u3002`);
    suggestions.push(`\u91CD\u70B9\u63D0\u5347 ${weakSubjects[0].split("\uFF08")[0]}\uFF0C\u53EF\u9488\u5BF9\u6027\u505A\u4E13\u9879\u7EC3\u4E60\u3002`);
  }
  if (decliningSubjects.length > 0) {
    weakPoints.push(`\u6210\u7EE9\u4E0B\u6ED1\u5B66\u79D1\uFF1A${decliningSubjects.join("\u3001")}\u3002\u6700\u8FD1\u4E00\u6B21\u8003\u8BD5\u5206\u6570\u6709\u6240\u4E0B\u964D\uFF0C\u9700\u8981\u5173\u6CE8\u3002`);
    suggestions.push(`\u56DE\u987E ${decliningSubjects.join("\u3001")} \u8FD1\u671F\u9519\u9898\uFF0C\u5206\u6790\u5931\u5206\u539F\u56E0\u3002`);
  }
  if (strongSubjects.length > 0) {
    suggestions.push(`\u4FDD\u6301 ${strongSubjects.join("\u3001")} \u7684\u4F18\u52BF\uFF0C\u7EE7\u7EED\u5DE9\u56FA\u7EC3\u4E60\u3002`);
  }
  if (subjectSummaries.length > 0) {
    const avgAll = Math.round(subjectSummaries.reduce((s, x) => s + x.avgScore, 0) / subjectSummaries.length * 10) / 10;
    const avgGap = Math.round(subjectSummaries.reduce((s, x) => s + x.gapToClass, 0) / subjectSummaries.length * 10) / 10;
    const overall = avgGap >= 0 ? `\u6574\u4F53\u8868\u73B0\u826F\u597D\uFF0C\u5404\u79D1\u5E73\u5747 ${avgAll} \u5206\uFF0C\u9AD8\u4E8E\u73ED\u7EA7\u5747\u5206 ${avgGap} \u5206\u3002` : `\u6574\u4F53\u9700\u8981\u52A0\u6CB9\uFF0C\u5404\u79D1\u5E73\u5747 ${avgAll} \u5206\uFF0C\u4F4E\u4E8E\u73ED\u7EA7\u5747\u5206 ${Math.abs(avgGap)} \u5206\u3002`;
    caveats.push(overall);
  }
  caveats.push(`\u5171\u53C2\u4E0E ${trends.length} \u573A\u8003\u8BD5\uFF0C\u6DB5\u76D6 ${subjectSummaries.length} \u4E2A\u5B66\u79D1\u3002`);
  caveats.push("\u672C\u62A5\u544A\u4E3A\u7CFB\u7EDF\u57FA\u4E8E\u6210\u7EE9\u6570\u636E\u81EA\u52A8\u751F\u6210\uFF0C\u4EC5\u4F9B\u53C2\u8003\u3002\u82E5\u9700\u66F4\u6DF1\u5165\u7684\u5206\u6790\uFF0C\u8BF7\u914D\u7F6E\u4E2A\u4EBA AI \u670D\u52A1\u5546 API Key \u540E\u4F7F\u7528\u3002");
  res.json({
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    model: "server-side-v1",
    report: {
      overallJudgement: weakSubject ? `\u9700\u91CD\u70B9\u5173\u6CE8 ${weakSubject}\uFF0C\u8FD9\u662F\u5F53\u524D\u6700\u8584\u5F31\u5B66\u79D1` : "\u5404\u79D1\u6210\u7EE9\u8F83\u4E3A\u5747\u8861",
      distributionInsight: `\u57FA\u4E8E\u6700\u8FD1 ${trends.length} \u573A\u8003\u8BD5\u7684\u6210\u7EE9\u6570\u636E\u7EDF\u8BA1\u3002`,
      weakPoints,
      reviewRisks: [],
      teachingSuggestions: suggestions,
      nextActions: [],
      questionActions: [],
      caveats
    },
    toolCalls: []
  });
});
var canQueryOthers = requirePermission(PERMISSIONS.GRADE_READ);
router6.get("/students/:studentId", canQueryOthers, async (req, res) => {
  const studentId = Number(req.params.studentId);
  const student = await userRepo5.findByIdIncludingInactive(studentId);
  if (!student || student.role_id !== ROLE_IDS.STUDENT) {
    res.status(404).json({ message: "\u5B66\u751F\u4E0D\u5B58\u5728" });
    return;
  }
  res.json({
    studentId,
    name: student.name,
    student_number: student.student_number,
    scores: await scoreRepo.getStudentScores(studentId)
  });
});
router6.get("/students/:studentId/exams/:examId", canQueryOthers, async (req, res) => {
  const studentId = Number(req.params.studentId);
  const examId = Number(req.params.examId);
  res.json({
    studentId,
    examId,
    questions: await scoreRepo.getStudentQuestionScores(studentId, examId)
  });
});
var scores_default = router6;

// src/server/routes/sponsor.ts
import express7 from "express";
import { existsSync as existsSync3 } from "node:fs";
import { readFile } from "node:fs/promises";
import path5 from "node:path";
var router7 = express7.Router();
var rootDir = process.cwd();
var sponsorConfigPath = path5.join(
  rootDir,
  "src",
  "apps",
  "answer-card",
  "server",
  "data",
  "sponsor.json"
);
var sponsorQrDir = path5.join(rootDir, "data", "sponsor", "qr");
async function loadSponsorConfig() {
  const raw = await readFile(sponsorConfigPath, "utf8");
  return JSON.parse(raw);
}
function resolveQrPath(qrFile) {
  const fileName = path5.basename(qrFile);
  const fullPath = path5.join(sponsorQrDir, fileName);
  if (!fullPath.startsWith(sponsorQrDir)) return null;
  return existsSync3(fullPath) ? fullPath : null;
}
router7.get("/", async (_req, res) => {
  try {
    const config = await loadSponsorConfig();
    const channels = config.channels.filter((channel) => channel.enabled).map((channel) => {
      const qrPath = channel.qrFile ? resolveQrPath(channel.qrFile) : null;
      return {
        id: channel.id,
        name: channel.name,
        enabled: channel.enabled,
        qrUrl: qrPath ? `/api/sponsor/qr/${encodeURIComponent(channel.id)}` : null
      };
    });
    res.json({
      title: config.title,
      description: config.description,
      channels
    });
  } catch (error) {
    console.error("Sponsor config error:", error);
    res.status(500).json({ message: "\u8D5E\u52A9\u914D\u7F6E\u52A0\u8F7D\u5931\u8D25" });
  }
});
router7.get("/qr/:channelId", async (req, res) => {
  try {
    const channelId = req.params.channelId;
    const config = await loadSponsorConfig();
    const channel = config.channels.find((item) => item.id === channelId && item.enabled);
    if (!channel?.qrFile) {
      res.status(404).json({ message: "\u6536\u6B3E\u7801\u672A\u914D\u7F6E" });
      return;
    }
    const qrPath = resolveQrPath(channel.qrFile);
    if (!qrPath) {
      res.status(404).json({ message: "\u6536\u6B3E\u7801\u6587\u4EF6\u4E0D\u5B58\u5728" });
      return;
    }
    res.sendFile(qrPath);
  } catch (error) {
    console.error("Sponsor QR error:", error);
    res.status(500).json({ message: "\u6536\u6B3E\u7801\u52A0\u8F7D\u5931\u8D25" });
  }
});
var sponsor_default = router7;

// src/server/routes/backup.ts
import { Router } from "express";
import { raw as expressRaw } from "express";
import { ZipArchive } from "archiver";
import AdmZip from "adm-zip";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { mkdir, readdir, copyFile, rm, stat, writeFile } from "node:fs/promises";
import path6 from "node:path";
import os from "node:os";
import crypto2 from "node:crypto";
init_db();

// src/apps/answer-card/server/database/index.ts
import Database2 from "better-sqlite3";
init_db();
var db = null;
function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// src/server/routes/backup.ts
var router8 = Router();
router8.use(authMiddleware);
router8.use(requirePermission(PERMISSIONS.USER_MANAGE));
var rawBodyParser = expressRaw({ type: "application/zip", limit: "512mb" });
function getDataDir() {
  return resolveAnswerCardDataDir();
}
function getProjectXDbPath() {
  return resolveProjectDbPath();
}
function getScannerDbPath() {
  return resolveScannerDbPath();
}
router8.get("/backup", async (_req, res) => {
  const dialect = detectDialect();
  if (dialect === "mariadb") {
    res.status(501).json({ message: "MariaDB \u6A21\u5F0F\u4E0B\u5907\u4EFD\u529F\u80FD\u5C1A\u672A\u5B9E\u73B0\uFF0C\u8BF7\u4F7F\u7528 mysqldump \u547D\u4EE4\u884C\u5DE5\u5177\u624B\u52A8\u5907\u4EFD" });
    return;
  }
  const tmpDir = path6.join(os.tmpdir(), `projectx-backup-${crypto2.randomUUID()}`);
  const zipFile = path6.join(os.tmpdir(), `projectx-backup-${Date.now()}.zip`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const metadata = {
      version: 1,
      format: "projectx-backup",
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      files: []
    };
    const projectxDbPath = getProjectXDbPath();
    const projectxBak = path6.join(tmpDir, "projectx.db");
    if (existsSync4(projectxDbPath)) {
      const db3 = getDatabase();
      try {
        db3.exec(`VACUUM INTO '${projectxBak.replace(/\\/g, "\\\\")}'`);
      } catch (err) {
        console.warn("[Backup] VACUUM INTO failed, falling back to file copy:", err);
        await copyFile(projectxDbPath, projectxBak);
      }
      const fstat = await stat(projectxBak);
      metadata.files.push({ name: "projectx.db", size: fstat.size });
    }
    const scannerDbPath = getScannerDbPath();
    const scannerBak = path6.join(tmpDir, "scanner.db");
    if (existsSync4(scannerDbPath)) {
      try {
        closeDb();
      } catch {
      }
      await copyFile(scannerDbPath, scannerBak);
      const fstat = await stat(scannerBak);
      metadata.files.push({ name: "scanner.db", size: fstat.size });
    }
    const dataDir2 = getDataDir();
    const dataBakDir = path6.join(tmpDir, "data", "answer-card");
    const excludeDirs = /* @__PURE__ */ new Set(["scans"]);
    if (existsSync4(dataDir2)) {
      await copyDirectory(dataDir2, dataBakDir, (filePath) => {
        const base = path6.basename(filePath);
        if (base.endsWith(".db") || base.endsWith(".db-shm") || base.endsWith(".db-wal")) {
          return false;
        }
        return true;
      });
      const dirStat = await stat(dataBakDir);
      metadata.files.push({ name: "data/answer-card/", size: 0 });
    }
    await writeFile(path6.join(tmpDir, "metadata.json"), JSON.stringify(metadata, null, 2));
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("error", (err) => {
      console.error("[Backup] Archive error:", err?.message);
    });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''ProjectX_backup_${timestamp}.zip`
    );
    archive.pipe(res);
    archive.file(path6.join(tmpDir, "metadata.json"), { name: "metadata.json" });
    if (existsSync4(projectxBak)) {
      archive.file(projectxBak, { name: "projectx.db" });
    }
    if (existsSync4(scannerBak)) {
      archive.file(scannerBak, { name: "scanner.db" });
    }
    if (existsSync4(dataBakDir)) {
      archive.directory(dataBakDir, "data/answer-card");
    }
    await archive.finalize();
    cleanupDir(tmpDir).catch(() => {
    });
  } catch (error) {
    console.error("[Backup] Export failed:", error);
    cleanupDir(tmpDir).catch(() => {
    });
    if (!res.headersSent) {
      res.status(500).json({ message: error instanceof Error ? error.message : "\u5BFC\u51FA\u5931\u8D25" });
    }
  }
});
router8.post("/restore", rawBodyParser, async (req, res) => {
  const dialect = detectDialect();
  if (dialect === "mariadb") {
    res.status(501).json({ message: "MariaDB \u6A21\u5F0F\u4E0B\u6062\u590D\u529F\u80FD\u5C1A\u672A\u5B9E\u73B0\uFF0C\u8BF7\u4F7F\u7528 mysql \u547D\u4EE4\u884C\u5DE5\u5177\u624B\u52A8\u6062\u590D" });
    return;
  }
  const zipBuffer = req.body;
  if (!zipBuffer || !Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    res.status(400).json({ message: "\u8BF7\u4E0A\u4F20 .zip \u5907\u4EFD\u6587\u4EF6\uFF08\u9700\u4EE5 application/zip Content-Type \u53D1\u9001\uFF09" });
    return;
  }
  if (zipBuffer[0] !== 80 || zipBuffer[1] !== 75) {
    res.status(400).json({ message: "\u4E0A\u4F20\u7684\u6587\u4EF6\u4E0D\u662F\u6709\u6548\u7684 ZIP \u683C\u5F0F\uFF08\u7F3A\u5C11 PK \u6587\u4EF6\u5934\uFF09" });
    return;
  }
  const tmpDir = path6.join(os.tmpdir(), `projectx-restore-${crypto2.randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    extractZipFromBuffer(zipBuffer, tmpDir);
    const metadataPath = path6.join(tmpDir, "metadata.json");
    if (!existsSync4(metadataPath)) {
      res.status(400).json({ message: "\u5907\u4EFD\u6587\u4EF6\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u7F3A\u5C11 metadata.json" });
      return;
    }
    const projectxBak = path6.join(tmpDir, "projectx.db");
    if (!existsSync4(projectxBak)) {
      res.status(400).json({ message: "\u5907\u4EFD\u6587\u4EF6\u4E2D\u672A\u627E\u5230 projectx.db" });
      return;
    }
    const backupSuffix = Date.now();
    const projectxDbPath = getProjectXDbPath();
    const scannerDbPath = getScannerDbPath();
    const dataDir2 = getDataDir();
    if (existsSync4(projectxDbPath)) {
      await copyFile(projectxDbPath, projectxDbPath + `.bak.${backupSuffix}`);
    }
    if (existsSync4(scannerDbPath)) {
      await copyFile(scannerDbPath, scannerDbPath + `.bak.${backupSuffix}`);
    }
    try {
      closeDatabase();
    } catch (e) {
      console.warn("[Restore] closeDatabase:", e);
    }
    try {
      closeDb();
    } catch (e) {
      console.warn("[Restore] closeDb:", e);
    }
    await copyFile(projectxBak, projectxDbPath);
    const scannerBak = path6.join(tmpDir, "scanner.db");
    if (existsSync4(scannerBak)) {
      await copyFile(scannerBak, scannerDbPath);
    }
    const bakDataDir = path6.join(tmpDir, "data", "answer-card");
    if (existsSync4(bakDataDir)) {
      const dataBakDir = path6.join(path6.dirname(dataDir2), `answer-card.bak.${backupSuffix}`);
      if (existsSync4(dataDir2)) {
        await moveDir(dataDir2, dataBakDir);
      }
      await copyDirectory(bakDataDir, dataDir2, () => true);
    }
    await cleanupDir(tmpDir);
    res.json({
      ok: true,
      message: "\u6570\u636E\u5DF2\u6062\u590D\uFF01\u8BF7\u91CD\u542F\u670D\u52A1\u5668\u4EE5\u4F7F\u66F4\u6539\u5B8C\u5168\u751F\u6548\u3002"
    });
  } catch (error) {
    console.error("[Restore] Import failed:", error);
    await cleanupDir(tmpDir).catch(() => {
    });
    res.status(500).json({ message: error instanceof Error ? error.message : "\u5BFC\u5165\u5931\u8D25" });
  }
});
async function copyDirectory(src, dest, filter) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path6.join(src, entry.name);
    const destPath = path6.join(dest, entry.name);
    if (!filter(srcPath)) continue;
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath, filter);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}
async function moveDir(src, dest) {
  try {
    await copyDirectory(src, dest, () => true);
    await rm(src, { recursive: true, force: true });
  } catch {
  }
}
function extractZipFromBuffer(zipBuffer, destDir) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  for (const entry of entries) {
    const relativePath = path6.normalize(entry.entryName).replace(/^[\\/]+/, "");
    const safePath = path6.join(destDir, relativePath);
    if (!safePath.startsWith(path6.resolve(destDir))) {
      continue;
    }
    if (entry.isDirectory) {
      mkdirSync3(safePath, { recursive: true });
    } else {
      mkdirSync3(path6.dirname(safePath), { recursive: true });
      writeFileSync2(safePath, entry.getData());
    }
  }
}
async function cleanupDir(dirPath) {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch {
  }
}
var backup_default = router8;

// src/server/routes/export-scores.ts
import express8 from "express";
init_db();
import XLSX2 from "xlsx";
var router9 = express8.Router();
router9.use(authMiddleware);
router9.get("/templates", async (req, res) => {
  const db3 = getMysqlDb();
  const rows = await db3.all(
    "SELECT id, slot, name, columns, side_table_n, gap_cols FROM export_templates WHERE user_id = ? ORDER BY slot",
    req.user.id
  );
  const templates = rows.map((r) => ({
    ...r,
    columns: (() => {
      try {
        return JSON.parse(r.columns);
      } catch {
        return [];
      }
    })()
  }));
  res.json(templates);
});
router9.put("/templates/:slot", async (req, res) => {
  const db3 = getMysqlDb();
  const slot = Number(req.params.slot);
  if (slot < 1 || slot > 4) {
    res.status(400).json({ message: "\u69FD\u4F4D\u987B\u4E3A 1-4" });
    return;
  }
  const { name, columns, sideTableN, gapCols } = req.body;
  const insertCols = ["user_id", "slot", "name", "columns", "side_table_n", "gap_cols"];
  const sql = buildUpsertSQL(db3.dialect, "export_templates", insertCols, ["user_id", "slot"]);
  await db3.run(
    sql,
    req.user.id,
    slot,
    name ?? "\u672A\u547D\u540D",
    JSON.stringify(columns ?? []),
    sideTableN ?? 0,
    gapCols ?? 3
  );
  res.json({ ok: true, slot });
});
router9.delete("/templates/:slot", async (req, res) => {
  const db3 = getMysqlDb();
  const slot = Number(req.params.slot);
  await db3.run(
    "DELETE FROM export_templates WHERE user_id = ? AND slot = ?",
    req.user.id,
    slot
  );
  res.json({ ok: true });
});
var ALL_COLUMNS = {
  studentNumber: { label: "\u8003\u53F7", category: "basic" },
  grade: { label: "\u5E74\u7EA7", category: "basic" },
  className: { label: "\u73ED\u7EA7", category: "basic" },
  studentName: { label: "\u59D3\u540D", category: "basic" },
  totalScore: { label: "\u539F\u59CB\u5206", category: "score" },
  assignedScore: { label: "\u8D4B\u5206", category: "score" },
  objectiveScore: { label: "\u5BA2\u89C2\u5206", category: "score" },
  subjectiveScore: { label: "\u4E3B\u89C2\u5206", category: "score" },
  gradeRank: { label: "\u5E74\u6392", category: "ranking" },
  classRank: { label: "\u73ED\u6392", category: "ranking" },
  rankChange: { label: "\u540D\u6B21\u53D8\u5316", category: "ranking" },
  displayValue: { label: "\u504F\u5DEE\u503C/Z\u503C", category: "other" },
  needsReview: { label: "\u9700\u8981\u590D\u6838", category: "other" },
  confidence: { label: "\u7F6E\u4FE1\u5EA6", category: "other" },
  objectiveSubScores: { label: "\u5BA2\u89C2\u9898\u5C0F\u5206", category: "questions" },
  subjectiveSubScores: { label: "\u4E3B\u89C2\u9898\u5C0F\u5206", category: "questions" }
};
router9.get("/columns", (_req, res) => {
  res.json({ columns: ALL_COLUMNS });
});
router9.post("/exams/:examId/scores", async (req, res) => {
  try {
    const examId = Number(req.params.examId);
    const { columns, classId, sideTableN, gapCols } = req.body;
    if (!columns || columns.length === 0) {
      res.status(400).json({ message: "\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u5217" });
      return;
    }
    const db3 = getMysqlDb();
    const analysisRepo = new AnalysisRepository();
    const { rows, examName, hasAssignedScore } = await analysisRepo.getScoreTableData(examId, classId);
    const needObjSub = columns.includes("objectiveSubScores");
    const needSubjSub = columns.includes("subjectiveSubScores");
    let objQuestionDefs = [];
    let subQuestionDefs = [];
    let subScoreMap = /* @__PURE__ */ new Map();
    if (needObjSub || needSubjSub) {
      const allQs = await db3.all(`
        SELECT question_number as questionNumber, score_type, MAX(max_score) as maxScore
        FROM question_scores WHERE exam_id = ?
        GROUP BY question_number, score_type
        ORDER BY question_number
      `, examId);
      objQuestionDefs = allQs.filter((q) => q.score_type === "objective");
      subQuestionDefs = allQs.filter((q) => q.score_type === "subjective");
      const allSubScores = await db3.all(`
        SELECT student_id as studentId, question_number as questionNumber, score
        FROM question_scores WHERE exam_id = ?
      `, examId);
      for (const s of allSubScores) {
        if (!subScoreMap.has(s.studentId)) subScoreMap.set(s.studentId, /* @__PURE__ */ new Map());
        subScoreMap.get(s.studentId).set(s.questionNumber, s.score);
      }
    }
    const baseCols = columns.filter((c) => c !== "objectiveSubScores" && c !== "subjectiveSubScores");
    const headers = [];
    for (const col of baseCols) {
      switch (col) {
        case "studentNumber":
          headers.push("\u8003\u53F7");
          break;
        case "grade":
          headers.push("\u5E74\u7EA7");
          break;
        case "className":
          headers.push("\u73ED\u7EA7");
          break;
        case "studentName":
          headers.push("\u59D3\u540D");
          break;
        case "totalScore":
          headers.push("\u539F\u59CB\u5206");
          break;
        case "assignedScore":
          if (hasAssignedScore) headers.push("\u8D4B\u5206");
          break;
        case "objectiveScore":
          headers.push("\u5BA2\u89C2\u5206");
          break;
        case "subjectiveScore":
          headers.push("\u4E3B\u89C2\u5206");
          break;
        case "gradeRank":
          headers.push("\u5E74\u6392");
          break;
        case "classRank":
          headers.push("\u73ED\u6392");
          break;
        case "rankChange":
          headers.push("\u540D\u6B21\u53D8\u5316");
          break;
        case "displayValue":
          headers.push("\u504F\u5DEE\u503C/Z\u503C");
          break;
        case "needsReview":
          headers.push("\u9700\u8981\u590D\u6838");
          break;
        case "confidence":
          headers.push("\u7F6E\u4FE1\u5EA6");
          break;
      }
    }
    if (needObjSub) {
      objQuestionDefs.forEach((q) => headers.push(`\u5BA2\u89C2Q${q.questionNumber}(${q.maxScore}\u5206)`));
    }
    if (needSubjSub) {
      subQuestionDefs.forEach((q) => headers.push(`\u4E3B\u89C2Q${q.questionNumber}(${q.maxScore}\u5206)`));
    }
    const data = [];
    for (const row of rows) {
      const exportRow = {};
      for (const col of baseCols) {
        switch (col) {
          case "studentNumber":
            exportRow["\u8003\u53F7"] = row.studentNumber;
            break;
          case "grade":
            exportRow["\u5E74\u7EA7"] = row.gradeName || "-";
            break;
          case "className":
            exportRow["\u73ED\u7EA7"] = row.className;
            break;
          case "studentName":
            exportRow["\u59D3\u540D"] = row.studentName;
            break;
          case "totalScore":
            exportRow["\u539F\u59CB\u5206"] = row.totalScore;
            break;
          case "assignedScore":
            if (hasAssignedScore) exportRow["\u8D4B\u5206"] = row.assignedScore;
            break;
          case "objectiveScore":
            exportRow["\u5BA2\u89C2\u5206"] = row.objectiveScore;
            break;
          case "subjectiveScore":
            exportRow["\u4E3B\u89C2\u5206"] = row.subjectiveScore;
            break;
          case "gradeRank":
            exportRow["\u5E74\u6392"] = row.gradeRank;
            break;
          case "classRank":
            exportRow["\u73ED\u6392"] = row.classRank;
            break;
          case "rankChange": {
            const ch = row.rankChange;
            exportRow["\u540D\u6B21\u53D8\u5316"] = ch == null ? "-" : ch > 0 ? `\u2191+${ch}` : ch < 0 ? `\u2193${ch}` : "0";
            break;
          }
          case "displayValue":
            exportRow["\u504F\u5DEE\u503C/Z\u503C"] = row.displayValue;
            break;
          case "needsReview":
            exportRow["\u9700\u8981\u590D\u6838"] = "";
            break;
          case "confidence":
            exportRow["\u7F6E\u4FE1\u5EA6"] = null;
            break;
        }
      }
      if (needObjSub) {
        const scoreMap = subScoreMap.get(row.studentId);
        objQuestionDefs.forEach((q) => {
          const key = `\u5BA2\u89C2Q${q.questionNumber}(${q.maxScore}\u5206)`;
          exportRow[key] = scoreMap?.get(q.questionNumber) ?? "";
        });
      }
      if (needSubjSub) {
        const scoreMap = subScoreMap.get(row.studentId);
        subQuestionDefs.forEach((q) => {
          const key = `\u4E3B\u89C2Q${q.questionNumber}(${q.maxScore}\u5206)`;
          exportRow[key] = scoreMap?.get(q.questionNumber) ?? "";
        });
      }
      data.push(exportRow);
    }
    const wb = XLSX2.utils.book_new();
    const ws = XLSX2.utils.json_to_sheet(data, { header: headers });
    const colWidths = [];
    for (const h of headers) {
      if (h.startsWith("\u5BA2\u89C2Q") || h.startsWith("\u4E3B\u89C2Q")) {
        colWidths.push(8);
      } else {
        const wMap = {
          "\u8003\u53F7": 14,
          "\u5E74\u7EA7": 8,
          "\u73ED\u7EA7": 10,
          "\u59D3\u540D": 10,
          "\u539F\u59CB\u5206": 8,
          "\u8D4B\u5206": 8,
          "\u5BA2\u89C2\u5206": 8,
          "\u4E3B\u89C2\u5206": 8,
          "\u5E74\u6392": 6,
          "\u73ED\u6392": 6,
          "\u540D\u6B21\u53D8\u5316": 10,
          "\u504F\u5DEE\u503C/Z\u503C": 12,
          "\u9700\u8981\u590D\u6838": 8,
          "\u7F6E\u4FE1\u5EA6": 8
        };
        colWidths.push(wMap[h] ?? 10);
      }
    }
    ws["!cols"] = colWidths.map((w) => ({ wch: w }));
    if (sideTableN > 0) {
      const topN = rows.slice(0, sideTableN);
      const sideData = topN.map((r) => ({
        "\u5E74\u6392": r.gradeRank,
        "\u73ED\u7EA7": r.className,
        "\u539F\u59CB\u5206": r.totalScore
      }));
      const gap = gapCols || 3;
      const mainCols = colWidths.length;
      const originCol = mainCols + gap;
      XLSX2.utils.sheet_add_json(ws, sideData, { origin: { r: 0, c: originCol } });
      const sideWidths = [6, 10, 8];
      for (let i = 0; i < sideWidths.length; i++) {
        if (!ws["!cols"]) ws["!cols"] = [];
        ws["!cols"][originCol + i] = { wch: sideWidths[i] };
      }
      XLSX2.utils.sheet_add_json(ws, [{ "": `\u5E74\u7EA7\u524D${sideTableN}\u540D` }], { origin: { r: 0, c: originCol }, skipHeader: true });
    }
    XLSX2.utils.book_append_sheet(wb, ws, "\u6210\u7EE9\u8868");
    const fileName = `${examName.replace(/[\\/:*?"<>|]/g, "_")}_\u6210\u7EE9\u8868.xlsx`;
    const buf = Buffer.from(XLSX2.write(wb, { type: "buffer", bookType: "xlsx" }));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(buf);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u5BFC\u51FA\u5931\u8D25" });
  }
});
var export_scores_default = router9;

// src/server/routes/exam-groups.ts
import express9 from "express";
init_db();
import { ZipArchive as ZipArchive2 } from "archiver";
import XLSX3 from "xlsx";
var router10 = express9.Router();
router10.use(authMiddleware);
router10.get("/", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const params = [];
    let sql = `
      SELECT eg.*,
             g.name as grade_name,
             (SELECT COUNT(*) FROM exam_group_members egm WHERE egm.group_id = eg.id) as member_count,
             (SELECT COUNT(DISTINCT ss.student_id) FROM exam_group_members egm
              JOIN student_scores ss ON ss.exam_id = egm.exam_id
              WHERE egm.group_id = eg.id) as has_results
      FROM exam_groups eg
      LEFT JOIN grades g ON g.id = eg.grade_id
      WHERE eg.source IS NULL OR eg.source = 'manual'
    `;
    if (req.query.grade_id) {
      sql += " AND eg.grade_id = ?";
      params.push(req.query.grade_id);
    }
    if (req.query.status) {
      sql += " AND eg.status = ?";
      params.push(req.query.status);
    }
    sql += " ORDER BY eg.created_at DESC";
    const rows = await db3.all(sql, ...params);
    const result = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      tag: r.tag,
      grade_id: r.grade_id,
      grade_name: r.grade_name || null,
      status: r.status,
      is_official: r.is_official,
      total_score_mode: r.total_score_mode,
      only_full_participants: r.only_full_participants,
      member_count: r.member_count,
      has_results: r.has_results > 0 ? 1 : 0,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u83B7\u53D6\u5927\u8003\u5217\u8868\u5931\u8D25" });
  }
});
router10.post("/", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const { name, description, grade_id, tag, is_official, total_score_mode, only_full_participants, examIds } = req.body;
    if (!name || !name.trim()) {
      res.status(400).json({ message: "\u5927\u8003\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A" });
      return;
    }
    const result = await db3.run(
      `
      INSERT INTO exam_groups (name, description, grade_id, tag, status, is_official, total_score_mode, only_full_participants, created_by)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `,
      name.trim(),
      description ?? null,
      grade_id ?? null,
      tag ?? null,
      is_official ?? 0,
      total_score_mode ?? "raw",
      only_full_participants ?? 0,
      req.user.id
    );
    const groupId = result.lastInsertRowid;
    if (examIds && examIds.length > 0) {
      const insertSql = buildInsertIgnore(db3.dialect, "exam_group_members", ["group_id", "exam_id", "sort_order"]);
      for (const [idx, examId] of examIds.entries()) {
        await db3.run(insertSql, groupId, examId, idx);
      }
    }
    res.status(201).json({ id: groupId, message: "\u5927\u8003\u521B\u5EFA\u6210\u529F" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u521B\u5EFA\u5927\u8003\u5931\u8D25" });
  }
});
router10.get("/:groupId", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const group = await db3.get(`
      SELECT eg.*, g.name as grade_name
      FROM exam_groups eg LEFT JOIN grades g ON g.id = eg.grade_id
      WHERE eg.id = ?
    `, groupId);
    if (!group) {
      res.status(404).json({ message: "\u5927\u8003\u4E0D\u5B58\u5728" });
      return;
    }
    const members = await db3.all(`
      SELECT egm.id, egm.exam_id, egm.sort_order,
             e.name as exam_name, e.subject, ac.exam_date, e.status, e.assigned_formula,
             COUNT(ss.id) as graded_count,
             ROUND(AVG(ss.total_score), 1) as avg_score
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      GROUP BY egm.id
      ORDER BY egm.sort_order, egm.id
    `, groupId);
    res.json({
      id: group.id,
      name: group.name,
      description: group.description,
      grade_id: group.grade_id,
      grade_name: group.grade_name || null,
      tag: group.tag,
      status: group.status,
      is_official: group.is_official,
      total_score_mode: group.total_score_mode,
      only_full_participants: group.only_full_participants,
      created_by: group.created_by,
      created_at: group.created_at,
      updated_at: group.updated_at,
      members: members.map((m) => ({
        id: m.id,
        examId: m.exam_id,
        examName: m.exam_name,
        subject: m.subject,
        sortOrder: m.sort_order,
        examDate: m.exam_date || null,
        status: m.status,
        gradedCount: m.graded_count,
        avgScore: m.avg_score,
        hasAssignedScore: !!(m.assigned_formula && m.assigned_formula !== "") ? 1 : 0
      }))
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u83B7\u53D6\u5927\u8003\u8BE6\u60C5\u5931\u8D25" });
  }
});
router10.put("/:groupId", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const existing = await db3.get("SELECT id FROM exam_groups WHERE id = ?", groupId);
    if (!existing) {
      res.status(404).json({ message: "\u5927\u8003\u4E0D\u5B58\u5728" });
      return;
    }
    const { name, description, grade_id, tag, is_official, total_score_mode, only_full_participants } = req.body;
    const sets = ["updated_at = CURRENT_TIMESTAMP"];
    const vals = [];
    if (name !== void 0) {
      sets.push("name = ?");
      vals.push(name.trim());
    }
    if (description !== void 0) {
      sets.push("description = ?");
      vals.push(description || null);
    }
    if (grade_id !== void 0) {
      sets.push("grade_id = ?");
      vals.push(grade_id ?? null);
    }
    if (tag !== void 0) {
      sets.push("tag = ?");
      vals.push(tag || null);
    }
    if (is_official !== void 0) {
      sets.push("is_official = ?");
      vals.push(is_official);
    }
    if (total_score_mode !== void 0) {
      sets.push("total_score_mode = ?");
      vals.push(total_score_mode);
    }
    if (only_full_participants !== void 0) {
      sets.push("only_full_participants = ?");
      vals.push(only_full_participants);
    }
    await db3.run(`UPDATE exam_groups SET ${sets.join(", ")} WHERE id = ?`, ...vals, groupId);
    res.json({ ok: true, message: "\u5927\u8003\u66F4\u65B0\u6210\u529F" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u66F4\u65B0\u5927\u8003\u5931\u8D25" });
  }
});
router10.delete("/:groupId", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const deleteExams = req.query.deleteExams === "1";
    const existing = await db3.get("SELECT id, name FROM exam_groups WHERE id = ?", groupId);
    if (!existing) {
      res.status(404).json({ message: "\u5927\u8003\u4E0D\u5B58\u5728" });
      return;
    }
    const memberExams = await db3.all(`
      SELECT e.id, e.name FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      WHERE egm.group_id = ?
    `, groupId);
    if (deleteExams && memberExams.length > 0) {
      for (const exam of memberExams) {
        await db3.run("DELETE FROM exams WHERE id = ?", exam.id);
      }
    }
    await db3.run("DELETE FROM exam_groups WHERE id = ?", groupId);
    res.json({ ok: true, deletedExams: deleteExams ? memberExams.length : 0, message: "\u5927\u8003\u5DF2\u5220\u9664" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u5220\u9664\u5927\u8003\u5931\u8D25" });
  }
});
router10.post("/:groupId/exams", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const { examIds } = req.body;
    if (!examIds || examIds.length === 0) {
      res.status(400).json({ message: "\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u8003\u8BD5" });
      return;
    }
    const maxOrder = await db3.get(
      "SELECT MAX(sort_order) as m FROM exam_group_members WHERE group_id = ?",
      groupId
    );
    let nextOrder = (maxOrder?.m ?? -1) + 1;
    const insertSql = buildInsertIgnore(db3.dialect, "exam_group_members", ["group_id", "exam_id", "sort_order"]);
    const added = [];
    for (const examId of examIds) {
      const result = await db3.run(insertSql, groupId, examId, nextOrder);
      if (result.changes > 0) {
        added.push(examId);
        nextOrder++;
      }
    }
    res.json({ ok: true, added, message: `\u5DF2\u5173\u8054 ${added.length} \u573A\u8003\u8BD5` });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u5173\u8054\u8003\u8BD5\u5931\u8D25" });
  }
});
router10.delete("/:groupId/exams/:examId", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const examId = Number(req.params.examId);
    await db3.run(
      "DELETE FROM exam_group_members WHERE group_id = ? AND exam_id = ?",
      groupId,
      examId
    );
    res.json({ ok: true, message: "\u5DF2\u79FB\u9664\u8003\u8BD5\u5173\u8054" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u79FB\u9664\u8003\u8BD5\u5931\u8D25" });
  }
});
router10.put("/:groupId/exams/sort", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const items = req.body;
    if (!Array.isArray(items)) {
      res.status(400).json({ message: "\u8BF7\u6C42\u683C\u5F0F\u9519\u8BEF" });
      return;
    }
    for (const item of items) {
      await db3.run(
        "UPDATE exam_group_members SET sort_order = ? WHERE group_id = ? AND exam_id = ?",
        item.sortOrder,
        groupId,
        item.examId
      );
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u66F4\u65B0\u6392\u5E8F\u5931\u8D25" });
  }
});
router10.get("/:groupId/overview", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const group = await db3.get("SELECT name FROM exam_groups WHERE id = ?", groupId);
    if (!group) {
      res.status(404).json({ message: "\u5927\u8003\u4E0D\u5B58\u5728" });
      return;
    }
    const members = await db3.all(`
      SELECT e.id as exam_id, e.name as exam_name, e.subject,
             e.assigned_formula,
             COUNT(ss.id) as graded_count,
             ROUND(AVG(ss.total_score), 1) as avg_score,
             ROUND(MAX(ss.total_score), 1) as max_score,
             ROUND(MIN(ss.total_score), 1) as min_score
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      WHERE egm.group_id = ?
      GROUP BY e.id
      ORDER BY egm.sort_order, egm.id
    `, groupId);
    const subjects = [];
    for (const m of members) {
      const fullScoreRow = await db3.get(`
        SELECT SUM(max_score) as total FROM (
          SELECT DISTINCT question_number, score_type, max_score FROM question_scores WHERE exam_id = ?
        )
      `, m.exam_id);
      const fullScore = fullScoreRow?.total ?? 100;
      const stdRow = await db3.get(`
        SELECT ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as std
        FROM student_scores ss WHERE ss.exam_id = ?
      `, m.avg_score, m.avg_score, m.exam_id);
      const passLine = fullScore * 0.6;
      const excellentLine = fullScore * 0.9;
      const passRow = await db3.get(`
        SELECT
          SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as pass_count,
          SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as excellent_count
        FROM student_scores ss WHERE ss.exam_id = ?
      `, passLine, excellentLine, m.exam_id);
      subjects.push({
        examId: m.exam_id,
        examName: m.exam_name,
        subject: m.subject || "",
        gradedCount: m.graded_count,
        avgScore: m.avg_score || 0,
        maxScore: m.max_score || 0,
        minScore: m.min_score || 0,
        stdDev: stdRow?.std ?? 0,
        passRate: m.graded_count > 0 ? Math.round((passRow?.pass_count || 0) / m.graded_count * 100) : 0,
        excellentRate: m.graded_count > 0 ? Math.round((passRow?.excellent_count || 0) / m.graded_count * 100) : 0,
        fullScore,
        hasAssignedScore: !!(m.assigned_formula && m.assigned_formula !== "")
      });
    }
    const totalRow = await db3.get(`
      SELECT COUNT(DISTINCT s.student_id) as cnt FROM (
        SELECT ss.student_id FROM exam_group_members egm
        JOIN student_scores ss ON ss.exam_id = egm.exam_id
        WHERE egm.group_id = ?
      ) s
    `, groupId);
    const fullRow = await db3.get(`
      SELECT COUNT(*) as cnt FROM (
        SELECT ss.student_id, COUNT(DISTINCT egm.exam_id) as exam_count
        FROM exam_group_members egm
        JOIN student_scores ss ON ss.exam_id = egm.exam_id
        WHERE egm.group_id = ?
        GROUP BY ss.student_id
        HAVING exam_count = (SELECT COUNT(*) FROM exam_group_members WHERE group_id = ?)
      )
    `, groupId, groupId);
    res.json({
      groupId,
      groupName: group.name,
      totalParticipants: totalRow.cnt,
      fullParticipants: fullRow?.cnt ?? 0,
      subjects
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u83B7\u53D6\u5927\u8003\u6982\u89C8\u5931\u8D25" });
  }
});
router10.get("/:groupId/rankings", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const classId = req.query.classId ? Number(req.query.classId) : void 0;
    const fullOnly = req.query.fullOnly === "1";
    const group = await db3.get(`
      SELECT name, total_score_mode, only_full_participants
      FROM exam_groups WHERE id = ?
    `, groupId);
    if (!group) {
      res.status(404).json({ message: "\u5927\u8003\u4E0D\u5B58\u5728" });
      return;
    }
    const members = await db3.all(`
      SELECT egm.exam_id, e.subject, e.assigned_formula, egm.sort_order
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      WHERE egm.group_id = ?
      ORDER BY egm.sort_order, egm.id
    `, groupId);
    if (members.length === 0) {
      res.json({ groupId, groupName: group.name, totalStudents: 0, displayColumns: [], rows: [] });
      return;
    }
    const useAssigned = fullOnly ? group.only_full_participants : false;
    const memberIds = members.map((m) => m.exam_id);
    const allScores = await db3.all(`
      SELECT
        ss.student_id, ss.exam_id, ss.total_score, ss.assigned_score,
        ss.objective_score, ss.subjective_score,
        u.student_number, u.name,
        c.name as class_name, c.id as class_id,
        g.name as grade_name
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      LEFT JOIN class_students cs ON cs.student_id = ss.student_id
      LEFT JOIN classes c ON c.id = cs.class_id
      LEFT JOIN grades g ON g.id = c.grade_id
      WHERE ss.exam_id IN (${memberIds.map(() => "?").join(",")})
    `, ...memberIds);
    const studentMap = /* @__PURE__ */ new Map();
    for (const s of allScores) {
      if (!studentMap.has(s.student_id)) {
        studentMap.set(s.student_id, {
          studentId: s.student_id,
          studentNumber: s.student_number,
          studentName: s.name,
          className: s.class_name || "\u672A\u77E5\u73ED\u7EA7",
          classId: s.class_id,
          gradeName: s.grade_name || null,
          scores: /* @__PURE__ */ new Map()
        });
      }
      studentMap.get(s.student_id).scores.set(s.exam_id, {
        totalScore: s.total_score,
        assignedScore: s.assigned_score,
        objectiveScore: s.objective_score,
        subjectiveScore: s.subjective_score
      });
    }
    const examRanks = {};
    for (const examId of memberIds) {
      const rankRows = await db3.all(`
        SELECT ss.student_id, ss.total_score, c.name as class_name, c.id as class_id
        FROM student_scores ss
        JOIN users u ON u.id = ss.student_id
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id = ?
        ORDER BY ss.total_score DESC
      `, examId);
      const rankMap = /* @__PURE__ */ new Map();
      examRanks[examId] = rankMap;
      competitionRank(rankRows, (r) => r.total_score, (r, rank) => {
        rankMap.set(r.student_id, { gradeRank: rank, classRank: 0 });
      });
      const classGroups = /* @__PURE__ */ new Map();
      for (const r of rankRows) {
        const key = r.class_name || "__unassigned__";
        if (!classGroups.has(key)) classGroups.set(key, []);
        classGroups.get(key).push({ student_id: r.student_id, total_score: r.total_score });
      }
      for (const cg of classGroups.values()) {
        competitionRank(cg, (r) => r.total_score, (r, rank) => {
          const entry = rankMap.get(r.student_id);
          if (entry) entry.classRank = rank;
        });
      }
    }
    const rows = [];
    for (const [, student] of studentMap) {
      const subjects = members.map((m) => {
        const s = student.scores.get(m.exam_id);
        const ranks = examRanks[m.exam_id]?.get(student.studentId);
        return {
          examId: m.exam_id,
          subject: m.subject || "",
          totalScore: s?.totalScore ?? 0,
          assignedScore: s?.assignedScore ?? null,
          gradeRank: ranks?.gradeRank ?? 0,
          classRank: ranks?.classRank ?? 0,
          objectiveScore: s?.objectiveScore ?? 0,
          subjectiveScore: s?.subjectiveScore ?? 0
        };
      });
      const isFull = student.scores.size >= members.length;
      if (fullOnly && !isFull) continue;
      const totalRaw = subjects.reduce((sum, sub) => sum + sub.totalScore, 0);
      const totalAssigned = subjects.reduce((sum, sub) => sum + (sub.assignedScore ?? sub.totalScore), 0);
      rows.push({
        studentId: student.studentId,
        studentNumber: student.studentNumber,
        studentName: student.studentName,
        className: student.className,
        classId: student.classId,
        gradeName: student.gradeName,
        totalRawScore: totalRaw,
        totalAssignedScore: totalAssigned,
        subjectCount: student.scores.size,
        isFullParticipant: isFull,
        subjects
      });
    }
    const sortScore = useAssigned ? (r) => r.totalAssignedScore : (r) => r.totalRawScore;
    rows.sort((a, b) => sortScore(b) - sortScore(a));
    competitionRank(rows, sortScore, (r, rank) => {
      r.totalGradeRank = rank;
    });
    const classGroups2 = /* @__PURE__ */ new Map();
    for (const r of rows) {
      const key = r.className === "\u672A\u77E5\u73ED\u7EA7" ? "__unassigned__" : r.className;
      if (!classGroups2.has(key)) classGroups2.set(key, []);
      classGroups2.get(key).push(r);
    }
    for (const cg of classGroups2.values()) {
      competitionRank(cg, sortScore, (r, rank) => {
        r.totalClassRank = rank;
      });
    }
    let filtered = rows;
    if (classId !== void 0) {
      if (classId === 0) {
        filtered = rows.filter((r) => r.classId == null);
      } else {
        filtered = rows.filter((r) => r.classId === classId);
      }
    }
    const displayColumns = members.map((m) => m.subject || `\u79D1\u76EE${m.exam_id}`);
    res.json({
      groupId,
      groupName: group.name,
      totalStudents: filtered.length,
      displayColumns,
      rows: filtered
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "\u83B7\u53D6\u5927\u8003\u6392\u540D\u5931\u8D25" });
  }
});
router10.post("/:groupId/export", async (req, res) => {
  try {
    const db3 = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const { includeOverview = true, subjectExamIds = [], includeObjectiveSub = true, includeSubjectiveSub = true } = req.body;
    const group = await db3.get(`
      SELECT eg.name, eg.total_score_mode
      FROM exam_groups eg WHERE eg.id = ?
    `, groupId);
    if (!group) {
      res.status(404).json({ message: "\u5927\u8003\u4E0D\u5B58\u5728" });
      return;
    }
    const members = await db3.all(`
      SELECT egm.exam_id, e.name as exam_name, e.subject as subject, egm.sort_order
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      WHERE egm.group_id = ?
      ORDER BY egm.sort_order, egm.id
    `, groupId);
    if (members.length === 0) {
      res.status(400).json({ message: "\u5927\u8003\u4E2D\u6CA1\u6709\u5173\u8054\u8003\u8BD5" });
      return;
    }
    const safeName = group.name.replace(/[\\/:*?"<>|]/g, "_");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}_\u5BFC\u51FA.zip`);
    const archive = new ZipArchive2({ zlib: { level: 9 } });
    archive.pipe(res);
    if (includeOverview) {
      const memberIds = members.map((m) => m.exam_id);
      const allScores = await db3.all(`
        SELECT
          ss.student_id, ss.exam_id, ss.total_score, ss.assigned_score,
          u.student_number, u.name,
          c.name as class_name
        FROM student_scores ss
        JOIN users u ON u.id = ss.student_id
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id IN (${memberIds.map(() => "?").join(",")})
      `, ...memberIds);
      const stuMap = /* @__PURE__ */ new Map();
      for (const s of allScores) {
        if (!stuMap.has(s.student_id)) {
          stuMap.set(s.student_id, {
            number: s.student_number,
            name: s.name,
            className: s.class_name || "\u672A\u77E5\u73ED\u7EA7",
            exams: /* @__PURE__ */ new Map()
          });
        }
        stuMap.get(s.student_id).exams.set(s.exam_id, { raw: s.total_score, assigned: s.assigned_score });
      }
      const overviewHeaders = ["\u73ED\u7EA7", "\u59D3\u540D", "\u603B\u5206", "\u603B\u5206\u5E74\u6392", "\u603B\u5206\u73ED\u6392"];
      for (const m of members) {
        const sub = m.subject || `\u79D1\u76EE${m.exam_id}`;
        overviewHeaders.push(`${sub}\u539F\u59CB\u5206`, `${sub}\u5E74\u6392`, `${sub}\u73ED\u6392`);
      }
      const overviewRows = [];
      for (const [, stu] of stuMap) {
        let totalRaw = 0;
        for (const m of members) {
          const score = stu.exams.get(m.exam_id);
          totalRaw += score?.raw ?? 0;
        }
        const row = {
          "\u73ED\u7EA7": stu.className,
          "\u59D3\u540D": stu.name,
          "\u603B\u5206": totalRaw
        };
        for (const m of members) {
          const score = stu.exams.get(m.exam_id);
          const sub = m.subject || `\u79D1\u76EE${m.exam_id}`;
          row[`${sub}\u539F\u59CB\u5206`] = score?.raw ?? "";
          row[`${sub}\u5E74\u6392`] = "";
          row[`${sub}\u73ED\u6392`] = "";
        }
        overviewRows.push(row);
      }
      overviewRows.sort((a, b) => b["\u603B\u5206"] - a["\u603B\u5206"]);
      competitionRank(overviewRows, (r) => r["\u603B\u5206"], (r, rank) => {
        r["\u603B\u5206\u5E74\u6392"] = rank;
      });
      const cgMap = /* @__PURE__ */ new Map();
      for (const r of overviewRows) {
        const key = r["\u73ED\u7EA7"];
        if (!cgMap.has(key)) cgMap.set(key, []);
        cgMap.get(key).push(r);
      }
      for (const cg of cgMap.values()) {
        competitionRank(cg, (r) => r["\u603B\u5206"], (r, rank) => {
          r["\u603B\u5206\u73ED\u6392"] = rank;
        });
      }
      for (const m of members) {
        const sub = m.subject || `\u79D1\u76EE${m.exam_id}`;
        const rawKey = `${sub}\u539F\u59CB\u5206`;
        const grKey = `${sub}\u5E74\u6392`;
        const crKey = `${sub}\u73ED\u6392`;
        const sorted = [...overviewRows].sort((a, b) => (b[rawKey] || 0) - (a[rawKey] || 0));
        const withScore = sorted.filter((r) => r[rawKey] !== "");
        competitionRank(withScore, (r) => r[rawKey], (r, rank) => {
          r[grKey] = rank;
        });
        const classSorted = /* @__PURE__ */ new Map();
        for (const r of withScore) {
          const key = r["\u73ED\u7EA7"];
          if (!classSorted.has(key)) classSorted.set(key, []);
          classSorted.get(key).push(r);
        }
        for (const cs of classSorted.values()) {
          competitionRank(cs, (r) => r[rawKey], (r, rank) => {
            r[crKey] = rank;
          });
        }
      }
      const wsOverview = XLSX3.utils.json_to_sheet(overviewRows, { header: overviewHeaders });
      const overviewWb = XLSX3.utils.book_new();
      XLSX3.utils.book_append_sheet(overviewWb, wsOverview, "\u603B\u89C8");
      const overviewBuf = Buffer.from(XLSX3.write(overviewWb, { type: "buffer", bookType: "xlsx" }));
      archive.append(overviewBuf, { name: "\u603B\u89C8.xlsx" });
    }
    const exportExams = subjectExamIds.length > 0 ? members.filter((m) => subjectExamIds.includes(m.exam_id)) : members;
    for (const m of exportExams) {
      const qsRows = await db3.all(`
        SELECT qs.student_id, qs.question_number, qs.score, qs.max_score, qs.score_type,
               u.student_number, u.name, c.name as class_name
        FROM question_scores qs
        JOIN users u ON u.id = qs.student_id
        LEFT JOIN class_students cs ON cs.student_id = qs.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE qs.exam_id = ?
        ORDER BY u.student_number, qs.question_number
      `, m.exam_id);
      const scoreRows = await db3.all(`
        SELECT ss.student_id, ss.total_score, ss.assigned_score,
               ss.objective_score, ss.subjective_score
        FROM student_scores ss WHERE ss.exam_id = ?
        ORDER BY ss.total_score DESC
      `, m.exam_id);
      const gradeRankMap = /* @__PURE__ */ new Map();
      competitionRank(scoreRows, (r) => r.total_score, (r, rank) => {
        gradeRankMap.set(r.student_id, rank);
      });
      const classSorted = await db3.all(`
        SELECT ss.student_id, ss.total_score, c.name as class_name
        FROM student_scores ss
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id = ?
        ORDER BY ss.total_score DESC
      `, m.exam_id);
      const classRankMap = /* @__PURE__ */ new Map();
      const cGroups = /* @__PURE__ */ new Map();
      for (const cs of classSorted) {
        const key = cs.class_name || "__unassigned__";
        if (!cGroups.has(key)) cGroups.set(key, []);
        cGroups.get(key).push({ student_id: cs.student_id, total_score: cs.total_score });
      }
      for (const cg of cGroups.values()) {
        competitionRank(cg, (r) => r.total_score, (r, rank) => {
          classRankMap.set(r.student_id, rank);
        });
      }
      const stuQsMap = /* @__PURE__ */ new Map();
      for (const qs of qsRows) {
        if (!stuQsMap.has(qs.student_id)) stuQsMap.set(qs.student_id, /* @__PURE__ */ new Map());
        stuQsMap.get(qs.student_id).set(qs.question_number, {
          score: qs.score,
          maxScore: qs.max_score,
          type: qs.score_type
        });
      }
      const qList = await db3.all(`
        SELECT question_number, score_type, MAX(max_score) as max_score
        FROM question_scores WHERE exam_id = ?
        GROUP BY question_number, score_type
        ORDER BY question_number
      `, m.exam_id);
      const objQuestions = qList.filter((q) => q.score_type === "objective");
      const subQuestions = qList.filter((q) => q.score_type === "subjective");
      const headers = ["\u73ED\u7EA7", "\u59D3\u540D", "\u539F\u59CB\u5206", "\u5E74\u6392", "\u73ED\u6392"];
      if (scoreRows.some((s) => s.assigned_score != null && s.assigned_score !== s.total_score)) {
        headers.push("\u8D4B\u5206");
      }
      headers.push("\u5BA2\u89C2\u5206", "\u4E3B\u89C2\u5206");
      if (includeObjectiveSub && objQuestions.length > 0) {
        objQuestions.forEach((q) => headers.push(`\u5BA2\u89C2Q${q.question_number}(${q.max_score}\u5206)`));
      }
      if (includeSubjectiveSub && subQuestions.length > 0) {
        subQuestions.forEach((q) => headers.push(`\u4E3B\u89C2Q${q.question_number}(${q.max_score}\u5206)`));
      }
      const sheetRows = [];
      for (const sr of scoreRows) {
        const qsMap = stuQsMap.get(sr.student_id);
        const row = {
          "\u73ED\u7EA7": qsRows.find((q) => q.student_id === sr.student_id)?.class_name || "\u672A\u77E5\u73ED\u7EA7",
          "\u59D3\u540D": qsRows.find((q) => q.student_id === sr.student_id)?.name || "",
          "\u539F\u59CB\u5206": sr.total_score,
          "\u5E74\u6392": gradeRankMap.get(sr.student_id) || 0,
          "\u73ED\u6392": classRankMap.get(sr.student_id) || 0,
          "\u5BA2\u89C2\u5206": sr.objective_score,
          "\u4E3B\u89C2\u5206": sr.subjective_score
        };
        if (sr.assigned_score != null && sr.assigned_score !== sr.total_score) {
          row["\u8D4B\u5206"] = sr.assigned_score;
        }
        if (includeObjectiveSub) {
          objQuestions.forEach((q) => {
            const qs = qsMap?.get(q.question_number);
            row[`\u5BA2\u89C2Q${q.question_number}(${q.max_score}\u5206)`] = qs?.score ?? "";
          });
        }
        if (includeSubjectiveSub) {
          subQuestions.forEach((q) => {
            const qs = qsMap?.get(q.question_number);
            row[`\u4E3B\u89C2Q${q.question_number}(${q.max_score}\u5206)`] = qs?.score ?? "";
          });
        }
        sheetRows.push(row);
      }
      const subjectName = m.subject || m.exam_name;
      const wsSubject = XLSX3.utils.json_to_sheet(sheetRows, { header: headers });
      const subjectWb = XLSX3.utils.book_new();
      XLSX3.utils.book_append_sheet(subjectWb, wsSubject, "\u6210\u7EE9");
      const subjectBuf = Buffer.from(XLSX3.write(subjectWb, { type: "buffer", bookType: "xlsx" }));
      archive.append(subjectBuf, { name: `${subjectName}.xlsx` });
    }
    archive.finalize();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ message: error instanceof Error ? error.message : "\u5BFC\u51FA\u5927\u8003\u5931\u8D25" });
    }
  }
});
var exam_groups_default = router10;

// src/server/routes/ai-providers.ts
import express10 from "express";
init_db();
var router11 = express10.Router();
router11.use(authMiddleware);
router11.get("/", async (req, res) => {
  const db3 = getMysqlDb();
  const providers = await db3.all(`
    SELECT id, name, provider_type, base_url, api_key, models, is_active, sort_order
    FROM ai_providers
    WHERE user_id = ?
    ORDER BY sort_order, id
  `, req.user.id);
  res.json(providers.map((p) => ({
    id: p.id,
    name: p.name,
    providerType: p.provider_type,
    baseUrl: p.base_url,
    apiKey: p.api_key,
    models: p.models ? JSON.parse(p.models) : null,
    isActive: !!p.is_active
  })));
});
function normalizeBaseUrl(url, providerType) {
  if (!url) return url;
  let normalized = url.trim().replace(/\/+$/, "");
  if (providerType === "gemini") return normalized;
  if (!normalized.endsWith("/v1") && !normalized.includes("/openai/deployments")) {
    normalized = normalized + "/v1";
  }
  return normalized;
}
router11.post("/", async (req, res) => {
  const { name, providerType, baseUrl, apiKey, models } = req.body ?? {};
  const needsBaseUrl = providerType !== "gemini";
  if (!name || !providerType || !apiKey || needsBaseUrl && !baseUrl) {
    res.status(400).json({ message: needsBaseUrl ? "\u7F3A\u5C11\u5FC5\u8981\u53C2\u6570: name, providerType, baseUrl, apiKey" : "\u7F3A\u5C11\u5FC5\u8981\u53C2\u6570: name, providerType, apiKey (Gemini \u65E0\u9700 Base URL)" });
    return;
  }
  const normalizedUrl = needsBaseUrl ? normalizeBaseUrl(baseUrl, providerType) : "";
  const db3 = getMysqlDb();
  const result = await db3.run(`
    INSERT INTO ai_providers (user_id, name, provider_type, base_url, api_key, models)
    VALUES (?, ?, ?, ?, ?, ?)
  `, req.user.id, name, providerType, normalizedUrl, apiKey, models ? JSON.stringify(models) : null);
  res.status(201).json({ id: result.lastInsertRowid, baseUrl: normalizedUrl });
});
router11.put("/:id", async (req, res) => {
  const { name, providerType, baseUrl, apiKey, models, isActive } = req.body ?? {};
  const db3 = getMysqlDb();
  const provider = await db3.get(
    "SELECT * FROM ai_providers WHERE id = ? AND user_id = ?",
    Number(req.params.id),
    req.user.id
  );
  if (!provider) {
    res.status(404).json({ message: "\u670D\u52A1\u5546\u4E0D\u5B58\u5728" });
    return;
  }
  const effectiveType = providerType ?? provider.provider_type;
  const normalizedUrl = baseUrl ? normalizeBaseUrl(baseUrl, effectiveType) : null;
  await db3.run(
    `
    UPDATE ai_providers SET
      name = COALESCE(?, name),
      provider_type = COALESCE(?, provider_type),
      base_url = COALESCE(?, base_url),
      api_key = COALESCE(?, api_key),
      models = COALESCE(?, models),
      is_active = COALESCE(?, is_active),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    name ?? null,
    providerType ?? null,
    normalizedUrl,
    apiKey ?? null,
    models ? JSON.stringify(models) : null,
    isActive !== void 0 ? isActive ? 1 : 0 : null,
    Number(req.params.id)
  );
  res.json({ ok: true, baseUrl: normalizedUrl });
});
router11.delete("/:id", async (req, res) => {
  const db3 = getMysqlDb();
  const result = await db3.run(
    "DELETE FROM ai_providers WHERE id = ? AND user_id = ?",
    Number(req.params.id),
    req.user.id
  );
  if (result.changes === 0) {
    res.status(404).json({ message: "\u670D\u52A1\u5546\u4E0D\u5B58\u5728" });
    return;
  }
  res.json({ ok: true });
});
var ai_providers_default = router11;

// src/server/routes/score-editing.ts
init_db();
import express11 from "express";
init_grading();
var router12 = express11.Router();
router12.get("/:examId/students/search", async (req, res) => {
  const examId = Number(req.params.examId);
  const q = (req.query.q || "").trim();
  if (!Number.isFinite(examId) || !q) {
    res.status(400).json({ message: "\u975E\u6CD5\u53C2\u6570" });
    return;
  }
  const db3 = getMysqlDb();
  const students = await db3.all(`
    SELECT DISTINCT u.id, u.name, u.student_number
    FROM student_scores ss
    JOIN users u ON u.id = ss.student_id
    WHERE ss.exam_id = ? AND (u.student_number = ? OR u.name LIKE ?)
    ORDER BY u.student_number
    LIMIT 20
  `, examId, q, `%${q}%`);
  res.json(students.map((s) => ({
    id: s.id,
    name: s.name,
    studentNumber: s.student_number ?? ""
  })));
});
router12.get("/:examId/student/:studentId/scores", async (req, res) => {
  const examId = Number(req.params.examId);
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(examId) || !Number.isFinite(studentId)) {
    res.status(400).json({ message: "\u975E\u6CD5\u8003\u8BD5\u6216\u5B66\u751F ID" });
    return;
  }
  const db3 = getMysqlDb();
  const exam = await db3.get("SELECT id, card_id FROM exams WHERE id = ?", examId);
  if (!exam) {
    res.status(404).json({ message: "\u8003\u8BD5\u4E0D\u5B58\u5728" });
    return;
  }
  const cardId = exam.card_id;
  if (!cardId) {
    res.status(404).json({ message: "\u6B64\u8003\u8BD5\u672A\u5173\u8054\u7B54\u9898\u5361" });
    return;
  }
  const student = await db3.get(
    "SELECT id, name, username, student_number FROM users WHERE id = ?",
    studentId
  );
  if (!student) {
    res.status(404).json({ message: "\u5B66\u751F\u4E0D\u5B58\u5728" });
    return;
  }
  const totalRow = await db3.get(
    "SELECT * FROM student_scores WHERE exam_id = ? AND student_id = ?",
    examId,
    studentId
  );
  const questionScores = await db3.all(`
    SELECT id, question_number, question_id, block_id, score, max_score, score_type,
           manually_modified, modified_at
    FROM question_scores
    WHERE exam_id = ? AND student_id = ?
    ORDER BY question_number
  `, examId, studentId);
  const scans = [];
  try {
    const scanRows = await db3.all(`
      SELECT sr.id as recordId, sr.file_path as fileName
      FROM scan_records sr
      JOIN scan_batches sb ON sb.id = sr.batch_id
      WHERE sb.exam_id = ? AND sr.student_id = ?
      ORDER BY sr.id
    `, examId, studentId);
    scans.push(...scanRows.filter((r) => r.fileName).map((r, idx) => ({
      recordId: r.recordId,
      fileName: r.fileName,
      pageNum: idx + 1
    })));
  } catch {
  }
  const classQuestionStats = {};
  const classRow = await db3.get(
    "SELECT cs.class_id FROM class_students cs WHERE cs.student_id = ?",
    studentId
  );
  if (classRow) {
    const classAvgs = await db3.all(`
      SELECT qs.question_number, qs.score_type, ROUND(AVG(qs.score), 1) as avgScore, MAX(qs.max_score) as maxScore, COUNT(*) as cnt
      FROM question_scores qs
      JOIN class_students cs ON cs.student_id = qs.student_id
      WHERE qs.exam_id = ? AND cs.class_id = ?
      GROUP BY qs.question_number, qs.score_type
      ORDER BY qs.question_number
    `, examId, classRow.class_id);
    for (const row of classAvgs) {
      classQuestionStats[row.question_number] = { avgScore: row.avgScore, maxScore: row.maxScore, count: row.cnt };
    }
  }
  const cardRepo = new CardRepository();
  const card = await cardRepo.findById(cardId);
  if (!card) {
    res.status(404).json({ message: "\u7B54\u9898\u5361\u6570\u636E\u4E0D\u5B58\u5728" });
    return;
  }
  const questionDefMap = /* @__PURE__ */ new Map();
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") {
      for (const def of objectiveQuestionDefinitions(block)) {
        const step = (() => {
          if (!def.scoringRule) return def.score / (def.optionCount || 1);
          if (def.scoringRule.type === "fixed_partial") return def.scoringRule.partialScore;
          return def.score / (def.optionCount || 1);
        })();
        questionDefMap.set(def.questionNumber, {
          mode: def.mode,
          optionCount: def.optionCount,
          answerKey: def.answerKey ?? [],
          scoringRule: def.scoringRule ?? null,
          step,
          blockType: "objective"
        });
      }
    } else if (block.type === "subjective") {
      for (const q of block.questions) {
        const qNum = typeof q.number === "number" ? q.number : parseInt(String(q.number), 10);
        if (!Number.isFinite(qNum)) continue;
        questionDefMap.set(qNum, {
          mode: "manual",
          optionCount: 0,
          answerKey: [],
          scoringRule: null,
          step: q.score,
          blockType: "subjective"
        });
      }
    }
  }
  const enrichedScores = questionScores.map((qs) => {
    const def = questionDefMap.get(qs.question_number);
    return { ...qs, ...def ?? {} };
  });
  const recognitionRows = await db3.all(`
    SELECT orr.question_number, orr.selected_options, orr.confidence
    FROM objective_recognitions orr
    JOIN scan_records sr ON sr.id = orr.record_id
    JOIN scan_batches sb ON sb.id = sr.batch_id
    WHERE sb.exam_id = ? AND sr.student_id = ?
    ORDER BY orr.confidence DESC
  `, examId, studentId);
  const recognitionMap = /* @__PURE__ */ new Map();
  for (const r of recognitionRows) {
    const existing = recognitionMap.get(r.question_number);
    if (!existing || r.confidence > existing.confidence) {
      recognitionMap.set(r.question_number, {
        selectedOptions: r.selected_options ? JSON.parse(r.selected_options) : [],
        confidence: r.confidence
      });
    }
  }
  res.json({
    student: { id: student.id, name: student.name, studentNumber: student.student_number ?? "" },
    totalScore: totalRow ? {
      objectiveScore: totalRow.objective_score,
      subjectiveScore: totalRow.subjective_score,
      totalScore: totalRow.total_score,
      assignedScore: totalRow.assigned_score ?? null,
      manuallyModified: !!totalRow.manually_modified
    } : null,
    questionScores: enrichedScores,
    recognition: Object.fromEntries(recognitionMap),
    scans: scans.map((s) => ({ recordId: s.recordId, fileName: s.fileName, pageNum: s.pageNum })),
    classQuestionStats,
    cardId
  });
});
router12.put("/:examId/student/:studentId/scores", async (req, res) => {
  const examId = Number(req.params.examId);
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(examId) || !Number.isFinite(studentId)) {
    res.status(400).json({ message: "\u975E\u6CD5\u8003\u8BD5\u6216\u5B66\u751F ID" });
    return;
  }
  const updates = req.body?.scores;
  if (!updates || !Array.isArray(updates) || updates.length === 0) {
    res.status(400).json({ message: "\u672A\u63D0\u4F9B\u5206\u6570\u4FEE\u6539\u6570\u636E" });
    return;
  }
  const db3 = getMysqlDb();
  const userId = req.user.id;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const exam = await db3.get("SELECT card_id FROM exams WHERE id = ?", examId);
  if (!exam) {
    res.status(404).json({ message: "\u8003\u8BD5\u4E0D\u5B58\u5728" });
    return;
  }
  await db3.transaction(async (tx) => {
    for (const u of updates) {
      const existing = await tx.get(
        "SELECT id, score, max_score FROM question_scores WHERE exam_id = ? AND student_id = ? AND question_number = ? AND score_type = ?",
        examId,
        studentId,
        u.questionNumber,
        u.scoreType
      );
      if (existing) {
        await tx.run(
          `UPDATE question_scores SET score = ?, manually_modified = 1, modified_by = ?, modified_at = ?
           WHERE exam_id = ? AND student_id = ? AND question_number = ? AND score_type = ?`,
          u.score,
          userId,
          now,
          examId,
          studentId,
          u.questionNumber,
          u.scoreType
        );
        await tx.run(
          `INSERT INTO answer_overrides (exam_id, card_id, question_number, score_type, override_type, old_value, new_value, created_by, created_at)
           VALUES (?, ?, ?, ?, 'score', ?, ?, ?, ?)`,
          examId,
          exam.card_id,
          u.questionNumber,
          u.scoreType,
          JSON.stringify(existing.score),
          JSON.stringify(u.score),
          userId,
          now
        );
      }
    }
    const rows = await tx.all(
      "SELECT score, score_type FROM question_scores WHERE exam_id = ? AND student_id = ?",
      examId,
      studentId
    );
    let totalObjective = 0, totalSubjective = 0;
    for (const s of rows) {
      if (s.score_type === "objective") totalObjective += s.score;
      else totalSubjective += s.score;
    }
    const newTotal = totalObjective + totalSubjective;
    await tx.run(`
      UPDATE student_scores SET objective_score = ?, subjective_score = ?, total_score = ?,
        manually_modified = 1, modified_by = ?, modified_at = ?
      WHERE exam_id = ? AND student_id = ?
    `, totalObjective, totalSubjective, newTotal, userId, now, examId, studentId);
  });
  await recomputeRankings(db3, examId);
  res.json({ ok: true });
});
router12.get("/:examId/answers", async (req, res) => {
  const examId = Number(req.params.examId);
  if (!Number.isFinite(examId)) {
    res.status(400).json({ message: "\u975E\u6CD5\u8003\u8BD5 ID" });
    return;
  }
  const db3 = getMysqlDb();
  const exam = await db3.get(
    "SELECT id, card_id, name FROM exams WHERE id = ?",
    examId
  );
  if (!exam) {
    res.status(404).json({ message: "\u8003\u8BD5\u4E0D\u5B58\u5728" });
    return;
  }
  if (!exam.card_id) {
    res.status(404).json({ message: "\u6B64\u8003\u8BD5\u672A\u5173\u8054\u7B54\u9898\u5361" });
    return;
  }
  const cardRepo = new CardRepository();
  const card = await cardRepo.findById(exam.card_id);
  if (!card) {
    res.status(404).json({ message: "\u7B54\u9898\u5361\u6570\u636E\u4E0D\u5B58\u5728" });
    return;
  }
  const questions = [];
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") {
      for (const def of objectiveQuestionDefinitions(block)) {
        questions.push({
          questionNumber: def.questionNumber,
          questionType: "objective",
          mode: def.mode,
          optionCount: def.optionCount,
          score: def.score,
          answerKey: def.answerKey ?? [],
          scoringRule: def.scoringRule ?? null
        });
      }
    } else if (block.type === "subjective") {
      for (const q of block.questions) {
        questions.push({ questionNumber: q.number, questionType: "subjective", score: q.score });
      }
    }
  }
  res.json({ examId, examName: exam.name, cardId: exam.card_id, questions, sided: card.sided ?? "double" });
});
router12.put("/:examId/answers", async (req, res) => {
  const examId = Number(req.params.examId);
  if (!Number.isFinite(examId)) {
    res.status(400).json({ message: "\u975E\u6CD5\u8003\u8BD5 ID" });
    return;
  }
  const answerUpdates = req.body?.answers;
  if (!answerUpdates || Object.keys(answerUpdates).length === 0) {
    res.status(400).json({ message: "\u672A\u63D0\u4F9B\u7B54\u6848\u4FEE\u6539\u6570\u636E" });
    return;
  }
  const db3 = getMysqlDb();
  const userId = req.user.id;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const exam = await db3.get("SELECT card_id FROM exams WHERE id = ?", examId);
  if (!exam || !exam.card_id) {
    res.status(404).json({ message: "\u8003\u8BD5\u4E0D\u5B58\u5728\u6216\u672A\u5173\u8054\u7B54\u9898\u5361" });
    return;
  }
  const cardRepo = new CardRepository();
  const card = await cardRepo.findById(exam.card_id);
  if (!card) {
    res.status(404).json({ message: "\u7B54\u9898\u5361\u6570\u636E\u4E0D\u5B58\u5728" });
    return;
  }
  const oldAnswers = {};
  for (const block of card.bodyBlocks) {
    if (block.type !== "objective") continue;
    const answers = block.answerKey ?? {};
    if (block.questions && block.questions.length > 0) {
      for (const q of block.questions) {
        const key = String(q.questionNumber);
        if (answerUpdates[key]) {
          oldAnswers[key] = [...q.answerKey ?? []];
          q.answerKey = answerUpdates[key];
        }
      }
    } else {
      for (const key of Object.keys(answerUpdates)) {
        const qNum = Number(key);
        if (qNum >= block.questionStart && qNum < block.questionStart + block.questionCount) {
          oldAnswers[key] = [...answers[qNum] ?? []];
          answers[qNum] = answerUpdates[key];
        }
      }
      block.answerKey = answers;
    }
  }
  const students = await db3.all("SELECT student_id FROM student_scores WHERE exam_id = ?", examId);
  let updatedCount = 0;
  const upsertCols = ["exam_id", "student_id", "question_number", "question_id", "block_id", "score", "max_score", "score_type", "manually_modified", "modified_by", "modified_at"];
  const conflictCols = ["exam_id", "student_id", "question_number", "score_type"];
  const updateCols = ["score", "max_score", "manually_modified", "modified_by", "modified_at"];
  const upsertSQL = buildUpsertSQL(db3.dialect, "question_scores", upsertCols, conflictCols, updateCols);
  await db3.transaction(async (tx) => {
    for (const [qNum, newKey] of Object.entries(answerUpdates)) {
      await tx.run(
        `INSERT INTO answer_overrides (exam_id, card_id, question_number, score_type, override_type, old_value, new_value, created_by, created_at)
         VALUES (?, ?, ?, 'objective', 'answer', ?, ?, ?, ?)`,
        examId,
        exam.card_id,
        Number(qNum),
        JSON.stringify(oldAnswers[qNum] ?? []),
        JSON.stringify(newKey),
        userId,
        now
      );
    }
    for (const { student_id: studentId } of students) {
      const recognitionRows = await tx.all(`
        SELECT orr.question_number, orr.selected_options, orr.confidence
        FROM objective_recognitions orr
        JOIN scan_records sr ON sr.id = orr.record_id
        JOIN scan_batches sb ON sb.id = sr.batch_id
        WHERE sb.exam_id = ? AND sr.student_id = ?
        ORDER BY orr.confidence DESC
      `, examId, studentId);
      const recognitionMap = /* @__PURE__ */ new Map();
      for (const r of recognitionRows) {
        const existing = recognitionMap.get(r.question_number);
        if (!existing || r.confidence > existing.confidence) {
          recognitionMap.set(r.question_number, {
            selectedOptions: r.selected_options ? JSON.parse(r.selected_options) : [],
            confidence: r.confidence
          });
        }
      }
      let totalObj = 0;
      for (const block of card.bodyBlocks) {
        if (block.type !== "objective") continue;
        for (const def of objectiveQuestionDefinitions(block)) {
          const rec = recognitionMap.get(def.questionNumber);
          const grade = gradeObjectiveQuestion(card, {
            questionNumber: def.questionNumber,
            selectedOptions: rec?.selectedOptions ?? [],
            confidence: rec?.confidence ?? 0
          });
          await tx.run(
            upsertSQL,
            examId,
            studentId,
            def.questionNumber,
            null,
            block.id,
            grade.score,
            grade.maxScore,
            "objective",
            1,
            userId,
            now
          );
          totalObj += grade.score;
        }
      }
      const subjScore = await tx.get(
        "SELECT COALESCE(SUM(score), 0) as total FROM question_scores WHERE exam_id = ? AND student_id = ? AND score_type = 'subjective'",
        examId,
        studentId
      );
      const totalScore = totalObj + subjScore.total;
      await tx.run(`
        UPDATE student_scores SET objective_score = ?, total_score = ?,
          manually_modified = 1, modified_by = ?, modified_at = ?
        WHERE exam_id = ? AND student_id = ?
      `, totalObj, totalScore, userId, now, examId, studentId);
      updatedCount++;
    }
  });
  await recomputeRankings(db3, examId);
  res.json({ ok: true, updatedCount, modifiedAnswers: Object.keys(answerUpdates).length });
});
async function recomputeRankings(db3, examId) {
  const allStudents = await db3.all(`
    SELECT id, total_score FROM student_scores WHERE exam_id = ? ORDER BY total_score DESC
  `, examId);
  if (allStudents.length === 0) return;
  const n = allStudents.length;
  for (let i = 0; i < allStudents.length; i++) {
    const rank = i + 1;
    const percentile2 = n > 1 ? Math.round((1 - i / n) * 1e3) / 10 : 100;
    await db3.run(
      "UPDATE student_scores SET `rank` = ?, percentile = ? WHERE id = ?",
      rank,
      percentile2,
      allStudents[i].id
    );
  }
  try {
    const assignedService = new AssignedScoreService();
    await assignedService.recalculateAll(examId);
  } catch (_) {
  }
}
var score_editing_default = router12;

// src/apps/answer-card/server/index.ts
init_defaultCard();

// src/shared/cardTemplates.ts
var DEFAULT_DENSITY = "compact";
function templateId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}
function objectiveQuestion(questionNumber, mode, optionCount, score, scoringRule) {
  return { questionNumber, mode, optionCount, score, answerKey: [], scoringRule };
}
function objectiveBlock(title, questions) {
  const first = questions[0] ?? objectiveQuestion(1, "single", 4, 0);
  return {
    id: templateId("obj"),
    type: "objective",
    title,
    questionStart: first.questionNumber,
    questionCount: questions.length,
    optionCount: first.optionCount ?? 4,
    mode: first.mode ?? "single",
    scorePerQuestion: first.score ?? 0,
    density: DEFAULT_DENSITY,
    answerKey: {},
    multipleScoring: { partialScores: {}, wrongOrExtraScore: 0 },
    questions
  };
}
function linedQuestion(number, score = 0, minHeightMm = 34) {
  return {
    id: templateId("q"),
    number,
    score,
    style: "manual_score_grid",
    kind: "lined_answer",
    lineGrid: { enabled: true, lineSpacingMm: 8 },
    images: [],
    minHeightMm
  };
}
function blankQuestion(number, score = 0, count = 1) {
  return {
    id: templateId("q"),
    number,
    score,
    style: score > 0 ? "manual_score_grid" : "plain_subjective",
    kind: "blank",
    blanks: { count, widthMm: 24, heightMm: 6, labelStyle: "none" },
    lineGrid: { enabled: false, lineSpacingMm: 8 },
    images: [],
    minHeightMm: 14
  };
}
function answerBlankQuestion(number, score = 12, count = 4) {
  return {
    ...blankQuestion(number, score, count),
    style: "manual_score_grid",
    minHeightMm: 62,
    blanks: {
      count,
      widthMm: 32,
      heightMm: 6,
      labelStyle: "arabic_parentheses",
      items: Array.from({ length: count }, (_, index) => ({
        label: `(${index + 1})`,
        widthMm: 32,
        heightMm: 6
      }))
    }
  };
}
function subjectiveBlock(title, questions, blockKind) {
  return { id: templateId("subj"), type: "subjective", blockKind, title, questions };
}
function fillBlankBlock(title, questions) {
  return subjectiveBlock(title, questions, "fill_blank");
}
function answerBlock(number, question) {
  return subjectiveBlock("\u89E3\u7B54\u9898", [{ ...question, number }], "answer");
}
function rangeQuestions(start, end, mode, optionCount, score) {
  return Array.from(
    { length: end - start + 1 },
    (_, index) => objectiveQuestion(start + index, mode, optionCount, score)
  );
}
var chineseQuestion10Rule = {
  type: "per_selected_count",
  partialScores: { 1: 1, 2: 2 },
  wrongOrExtraScore: 0,
  allowWrongOptions: true
};
var mathMultiRule = {
  type: "by_correct_count",
  partialScoresByCorrectCount: {
    2: { 1: 3 },
    3: { 1: 2, 2: 4 }
  },
  wrongOrExtraScore: 0
};
var physicsMultiRule = {
  type: "fixed_partial",
  partialScore: 3,
  wrongOrExtraScore: 0
};
var biologyIndefiniteRule = {
  type: "fixed_partial",
  partialScore: 1,
  wrongOrExtraScore: 0
};
function chineseTemplate(options) {
  const choiceQuestions = [
    ...rangeQuestions(1, 2, "single", 4, 3),
    objectiveQuestion(6, "single", 4, 3),
    objectiveQuestion(10, "multiple", 8, 3, chineseQuestion10Rule),
    ...rangeQuestions(11, 12, "single", 4, 3),
    objectiveQuestion(15, "single", 4, 3)
  ];
  const subjectiveBlocks = [
    fillBlankBlock("\u586B\u7A7A\u9898", [blankQuestion(3, 0, 1)]),
    subjectiveBlock("\u89E3\u7B54\u9898", [linedQuestion(4), linedQuestion(5)], "answer"),
    subjectiveBlock("\u89E3\u7B54\u9898", [linedQuestion(7), linedQuestion(8), linedQuestion(9)], "answer"),
    subjectiveBlock("\u89E3\u7B54\u9898", [linedQuestion("13.1", 4, 28), linedQuestion("13.2", 4, 28)], "answer"),
    subjectiveBlock("\u89E3\u7B54\u9898", [linedQuestion(14)], "answer"),
    subjectiveBlock("\u89E3\u7B54\u9898", [linedQuestion(16)], "answer"),
    fillBlankBlock("\u586B\u7A7A\u9898", [blankQuestion("17.1", 6, 2), blankQuestion("17.2", 0, 2), blankQuestion("17.3", 0, 2)]),
    subjectiveBlock("\u8BED\u8A00\u6587\u5B57\u8FD0\u7528", [linedQuestion(18), linedQuestion(19), linedQuestion(20), linedQuestion(21), linedQuestion(22)], "answer")
  ];
  if (options.chineseChoicePlacement === "inline") {
    return [
      objectiveBlock("\u9009\u62E9\u9898", rangeQuestions(1, 2, "single", 4, 3)),
      subjectiveBlocks[0],
      subjectiveBlocks[1],
      objectiveBlock("\u9009\u62E9\u9898", [objectiveQuestion(6, "single", 4, 3)]),
      subjectiveBlocks[2],
      objectiveBlock("\u591A\u9009\u9898", [objectiveQuestion(10, "multiple", 8, 3, chineseQuestion10Rule)]),
      objectiveBlock("\u9009\u62E9\u9898", rangeQuestions(11, 12, "single", 4, 3)),
      subjectiveBlocks[3],
      subjectiveBlocks[4],
      objectiveBlock("\u9009\u62E9\u9898 15", [objectiveQuestion(15, "single", 4, 3)]),
      ...subjectiveBlocks.slice(5)
    ];
  }
  return [objectiveBlock("\u9009\u62E9\u9898", choiceQuestions), ...subjectiveBlocks];
}
function englishTemplate(withListening) {
  const questions = [
    ...withListening ? rangeQuestions(1, 20, "single", 3, 1.5) : [],
    ...rangeQuestions(21, 35, "single", 4, 2.5),
    ...rangeQuestions(36, 40, "single", 7, 2.5),
    ...rangeQuestions(41, 55, "single", 4, 1)
  ];
  return [
    objectiveBlock(withListening ? "\u5BA2\u89C2\u9898" : "\u5BA2\u89C2\u9898", questions),
    fillBlankBlock("\u8BED\u6CD5\u586B\u7A7A", Array.from({ length: 10 }, (_, index) => blankQuestion(56 + index, 1.5, 1)))
  ];
}
function mathTemplate() {
  const objective = [
    ...rangeQuestions(1, 8, "single", 4, 5),
    ...rangeQuestions(9, 11, "multiple", 4, 6).map((question) => ({ ...question, scoringRule: mathMultiRule }))
  ];
  return [
    objectiveBlock("\u9009\u62E9\u9898", objective),
    fillBlankBlock("\u586B\u7A7A\u9898", [blankQuestion(12, 5, 1), blankQuestion(13, 5, 1), blankQuestion(14, 5, 1)]),
    answerBlock(15, linedQuestion(15, 0, 72))
  ];
}
function physicsTemplate() {
  const objective = [
    ...rangeQuestions(1, 7, "single", 4, 4),
    ...rangeQuestions(8, 10, "multiple", 4, 6).map((question) => ({ ...question, scoringRule: physicsMultiRule }))
  ];
  return [
    objectiveBlock("\u9009\u62E9\u9898", objective),
    fillBlankBlock("\u586B\u7A7A\u9898", [blankQuestion(11, 0, 2), blankQuestion(12, 0, 2)]),
    answerBlock(13, linedQuestion(13)),
    answerBlock(14, linedQuestion(14)),
    answerBlock(15, linedQuestion(15))
  ];
}
function chemistryTemplate() {
  return [
    objectiveBlock("\u9009\u62E9\u9898", rangeQuestions(1, 15, "single", 4, 3)),
    answerBlock(16, answerBlankQuestion(16)),
    answerBlock(17, answerBlankQuestion(17)),
    answerBlock(18, answerBlankQuestion(18)),
    answerBlock(19, answerBlankQuestion(19))
  ];
}
function biologyTemplate() {
  const objective = [
    ...rangeQuestions(1, 15, "single", 4, 2),
    ...rangeQuestions(16, 20, "indefinite", 4, 2).map((question) => ({
      ...question,
      scoringRule: biologyIndefiniteRule
    }))
  ];
  return [
    objectiveBlock("\u9009\u62E9\u9898", objective),
    answerBlock(21, answerBlankQuestion(21)),
    answerBlock(22, answerBlankQuestion(22)),
    answerBlock(23, answerBlankQuestion(23)),
    answerBlock(24, answerBlankQuestion(24)),
    answerBlock(25, answerBlankQuestion(25))
  ];
}
function applySubjectTemplate(card, options = {}) {
  const subject = card.subject;
  let bodyBlocks = null;
  if (subject === "yuwen") bodyBlocks = chineseTemplate(options);
  if (subject === "yingyu" || subject === "waiyu") bodyBlocks = englishTemplate(options.englishListening !== false);
  if (subject === "shuxue") bodyBlocks = mathTemplate();
  if (subject === "wuli") bodyBlocks = physicsTemplate();
  if (subject === "huaxue") bodyBlocks = chemistryTemplate();
  if (subject === "shengwu") bodyBlocks = biologyTemplate();
  return bodyBlocks ? { ...card, bodyBlocks } : card;
}

// src/apps/answer-card/server/index.ts
init_grading();
init_layout();

// src/apps/answer-card/server/pdf.ts
init_layout();
init_blankLabels();
init_storage();
import { existsSync as existsSync6 } from "node:fs";
import path8 from "node:path";
import PDFDocument from "pdfkit";
var MM_TO_PT = 72 / 25.4;
var fontRegular = "C:\\Windows\\Fonts\\msyh.ttc";
var fontRegularPostscriptName = "MicrosoftYaHei";
var fontFallback = "C:\\Windows\\Fonts\\simhei.ttf";
function pt(mm) {
  return mm * MM_TO_PT;
}
function drawRect(doc, rect2, options = {}) {
  if (options.lineWidth) doc.lineWidth(pt(options.lineWidth));
  if (options.fill && options.stroke) {
    doc.rect(pt(rect2.x), pt(rect2.y), pt(rect2.width), pt(rect2.height)).fillAndStroke(options.fill, options.stroke);
  } else if (options.fill) {
    doc.rect(pt(rect2.x), pt(rect2.y), pt(rect2.width), pt(rect2.height)).fill(options.fill);
  } else {
    doc.rect(pt(rect2.x), pt(rect2.y), pt(rect2.width), pt(rect2.height)).stroke(options.stroke ?? "#222");
  }
}
function drawText(doc, text, x, y, size = 9, options = {}) {
  doc.font("regular").fontSize(size).fillColor("#111").text(text, pt(x), pt(y), options);
}
function drawCenteredText(doc, text, x, y, width, size = 9) {
  doc.font("regular").fontSize(size).fillColor("#111").text(text, pt(x), pt(y), { width: pt(width), align: "center" });
}
function drawCenteredBoxText(doc, text, x, y, width, height, size = 5.8) {
  const textHeightMm = size * 1.2 / 72 * 25.4;
  const centeredY = y + (height - textHeightMm) / 2;
  doc.font("regular").fontSize(size).fillColor("#111").text(text, pt(x), pt(centeredY), {
    width: pt(width),
    align: "center",
    lineBreak: false
  });
}
function drawHeader(doc, page) {
  for (const marker of page.markers) {
    drawRect(doc, marker.rect, { fill: "#1f302c" });
  }
  drawText(doc, `ID:${page.header.id}`, page.header.idTextX, page.header.idTextY - 4.3, 10);
  page.header.codeBoxes.forEach((box, index) => {
    drawRect(doc, box, { fill: index === 0 || index === page.header.codeBoxes.length - 1 ? "#1f302c" : void 0 });
  });
  if (page.header.title && page.header.titleX && page.header.titleY) {
    doc.font("regular").fontSize(15).fillColor("#111").text(page.header.title, pt(35), pt(page.header.titleY - 4), {
      width: pt(140),
      align: "center"
    });
  }
}
function drawStudentArea(doc, page) {
  if (!page.studentArea) return;
  const { infoRect, digitRect, digitCells } = page.studentArea;
  drawRect(doc, infoRect, { stroke: "#333", lineWidth: 0.25 });
  drawRect(doc, digitRect, { stroke: "#333", lineWidth: 0.25 });
  drawCenteredText(doc, "\u586B\u6D82\u53F7\u533A", digitRect.x, digitRect.y + 2, digitRect.width, 10);
  drawText(doc, "\u59D3\u540D\uFF1A", infoRect.x + 5, infoRect.y + 10, 9);
  doc.moveTo(pt(infoRect.x + 18), pt(infoRect.y + 14.5)).lineTo(pt(infoRect.x + infoRect.width - 9), pt(infoRect.y + 14.5)).stroke();
  drawText(doc, "\u73ED\u7EA7\uFF1A", infoRect.x + 5, infoRect.y + 22, 9);
  doc.moveTo(pt(infoRect.x + 18), pt(infoRect.y + 26.5)).lineTo(pt(infoRect.x + infoRect.width - 9), pt(infoRect.y + 26.5)).stroke();
  for (let row = 0; row < Math.max(...digitCells.map((cell) => cell.digitIndex)) + 1; row += 1) {
    doc.moveTo(pt(digitRect.x), pt(digitRect.y + 7 + row * 4.8)).lineTo(pt(digitRect.x + digitRect.width), pt(digitRect.y + 7 + row * 4.8)).stroke();
  }
  const separatorX = digitRect.x + 8.5;
  doc.moveTo(pt(separatorX), pt(digitRect.y + 7)).lineTo(pt(separatorX), pt(digitRect.y + digitRect.height)).stroke();
  digitCells.forEach((cell) => {
    drawRect(doc, cell.rect, { stroke: "#333", lineWidth: 0.15 });
    drawCenteredText(doc, String(cell.digit), cell.rect.x, cell.rect.y - 0.15, cell.rect.width, 5.5);
  });
}
function drawObjectiveBlock(doc, block) {
  drawText(doc, block.title, block.rect.x, block.rect.y - 0.5, 10);
  drawRect(doc, block.frameRect, { stroke: "#222", lineWidth: 0.25 });
  block.rowMarkers.forEach((marker) => {
    drawRect(doc, marker.left, { fill: "#1f302c" });
    drawRect(doc, marker.right, { fill: "#1f302c" });
  });
  block.items.forEach((item) => drawObjectiveItem(doc, item));
}
function drawObjectiveItem(doc, item) {
  const firstOption = item.options[0];
  if (firstOption) {
    drawCenteredBoxText(doc, String(item.questionNumber), item.labelX - 2.5, firstOption.rect.y, 5, firstOption.rect.height, 7.2);
  }
  item.options.forEach((option) => {
    drawRect(doc, option.rect, { stroke: "#333", lineWidth: 0.15 });
    drawCenteredBoxText(doc, option.label, option.rect.x, option.rect.y, option.rect.width, option.rect.height, 5.8);
  });
}
function drawSubjectiveBlock(doc, card, block) {
  if (block.title) {
    drawText(doc, block.title, block.rect.x, block.rect.y - 0.5, 10);
  }
  if (block.frameRect) {
    drawRect(doc, block.frameRect, { stroke: "#222", lineWidth: 0.25 });
  }
  block.questions.forEach((question) => drawSubjectiveQuestion(doc, card, question, block.frameRect));
}
function drawSubjectiveQuestion(doc, card, question, frameRect) {
  if (question.kind !== "blank") {
    drawRect(doc, question.rect, { stroke: "#222", lineWidth: 0.25 });
    drawText(doc, `${question.questionNumber}.\uFF08${question.score}\u5206\uFF09`, question.rect.x + 2, question.contentRect.y + 2, 8);
  } else {
    drawText(doc, String(question.questionNumber), question.contentRect.x + 3, question.contentRect.y + 3.2, 8);
  }
  if (question.style === "manual_score_grid") {
    const firstScoreCell = question.scoreCells[0];
    if (frameRect && question.kind === "blank" && firstScoreCell) {
      drawText(doc, "\u5F97\u5206", frameRect.x + 4, firstScoreCell.rect.y + 1.2, 7);
      const dividerY = firstScoreCell.rect.y + firstScoreCell.rect.height + 2;
      doc.moveTo(pt(frameRect.x), pt(dividerY)).lineTo(pt(frameRect.x + frameRect.width), pt(dividerY)).stroke();
    } else {
      const dividerY = question.contentRect.y;
      doc.moveTo(pt(question.rect.x), pt(dividerY)).lineTo(pt(question.rect.x + question.rect.width), pt(dividerY)).stroke();
    }
    question.scoreCells.forEach((cell) => {
      drawRect(doc, cell.rect, { stroke: "#222", lineWidth: 0.2 });
      if (cell.score !== null) {
        drawCenteredText(doc, String(cell.score), cell.rect.x, cell.rect.y + 1.2, cell.rect.width, 6);
      }
    });
  }
  question.lineYs.forEach((lineY) => {
    doc.moveTo(pt(question.contentRect.x + 8), pt(lineY)).lineTo(pt(question.contentRect.x + question.contentRect.width - 6), pt(lineY)).stroke("#777");
  });
  question.blanks.forEach((blank, index) => {
    const blankLabel = question.blankLabels?.[index] ?? (question.kind === "blank" ? formatBlankLabel(question.blankLabelStyle, index) : `${question.questionNumber}.${index + 1}`);
    if (blankLabel) {
      const slotWidth = question.blankLabelSlotWidth ?? blankLabel.length * 1.8 + 0.8;
      drawText(doc, blankLabel, blank.x - slotWidth - 0.8, blank.y + blank.height - 2.35, 8, {
        width: pt(slotWidth),
        align: "right"
      });
    }
    doc.moveTo(pt(blank.x), pt(blank.y + blank.height)).lineTo(pt(blank.x + blank.width), pt(blank.y + blank.height)).stroke();
  });
  question.images.forEach((image) => {
    const fullPath = path8.join(cardAssetsDir(card.id), path8.basename(image.assetId));
    if (existsSync6(fullPath)) {
      doc.image(fullPath, pt(image.rect.x), pt(image.rect.y), {
        width: pt(image.rect.width),
        height: pt(image.rect.height)
      });
      drawRect(doc, image.rect, { stroke: "#555", lineWidth: 0.15 });
    } else {
      drawRect(doc, image.rect, { stroke: "#999", lineWidth: 0.15 });
      drawCenteredText(doc, "\u56FE\u7247\u7F3A\u5931", image.rect.x, image.rect.y + image.rect.height / 2 - 2, image.rect.width, 8);
    }
  });
}
function drawFooter(doc, pageNumber, totalPages) {
  drawCenteredText(doc, `\u7B2C${pageNumber}\u9875/\u5171${totalPages}\u9875`, 0, 282, 210, 9);
}
function createPdf(card) {
  const layout = buildLayout(card);
  const doc = new PDFDocument({
    size: [pt(layout.width), pt(layout.height)],
    margin: 0,
    autoFirstPage: false,
    info: {
      Title: card.title,
      Author: "Answer Card Designer"
    }
  });
  if (existsSync6(fontRegular)) {
    doc.registerFont("regular", fontRegular, fontRegularPostscriptName);
  } else {
    doc.registerFont("regular", fontFallback);
  }
  layout.pages.forEach((page) => {
    doc.addPage();
    drawHeader(doc, page);
    drawStudentArea(doc, page);
    page.blocks.forEach((block) => {
      if (block.type === "objective") drawObjectiveBlock(doc, block);
      if (block.type === "subjective") drawSubjectiveBlock(doc, card, block);
    });
    drawFooter(doc, page.pageNumber, layout.pages.length);
  });
  return doc;
}

// src/apps/answer-card/server/recognition.ts
init_storage();
import { spawn } from "node:child_process";
import { existsSync as existsSync7 } from "node:fs";
import path9 from "node:path";
function processResourcesPath() {
  return process.resourcesPath;
}
function nativeResourceDir() {
  return process.arch === "ia32" ? "win-ia32" : "win-x64";
}
function nativeBuildPlatform() {
  return process.arch === "ia32" ? "Win32" : "x64";
}
function resolveRecognizerExe() {
  const configured = process.env.ANSWER_CARD_RECOGNIZER_EXE;
  const resourcesPath = processResourcesPath();
  const resourceDir = nativeResourceDir();
  const buildPlatform = nativeBuildPlatform();
  const candidates = [
    configured,
    resourcesPath ? path9.join(resourcesPath, "native", resourceDir, "answer-card-recognizer.exe") : void 0,
    path9.join(rootDir2, "resources", "native", resourceDir, "answer-card-recognizer.exe"),
    path9.join(rootDir2, "native", "AnswerCardRecognizer", buildPlatform, "Release", "answer-card-recognizer.exe"),
    path9.join(rootDir2, "native", "AnswerCardRecognizer", buildPlatform, "Debug", "answer-card-recognizer.exe")
  ].filter((item) => Boolean(item));
  const found = candidates.find((candidate) => existsSync7(candidate));
  if (!found) {
    throw new Error(`Native recognizer executable not found. Checked: ${candidates.join("; ")}`);
  }
  return found;
}
function parseRecognizerOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  return JSON.parse(text);
}
async function recognizeObjectiveAnswers(request) {
  const exePath = resolveRecognizerExe();
  const args = [
    "--image",
    request.imagePath,
    "--layout",
    request.layoutPath,
    "--page",
    String(request.pageNumber),
    "--dpi",
    String(request.dpi)
  ];
  if (request.debugDir) {
    args.push("--debug-dir", request.debugDir);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 3e4);
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (timedOut) {
        reject(new Error("Native recognizer timed out after 30000ms."));
        return;
      }
      try {
        const parsed = parseRecognizerOutput(stdout);
        if (parsed) {
          resolve(parsed);
          return;
        }
      } catch (error) {
        reject(new Error(`Native recognizer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      reject(new Error(`Native recognizer exited with code ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`));
    });
  });
}
async function recognizeAnswerCard(request) {
  const exePath = resolveRecognizerExe();
  const args = [
    "--image",
    request.imagePath,
    "--layout",
    request.layoutPath,
    "--page",
    String(request.pageNumber),
    "--dpi",
    String(request.dpi)
  ];
  if (request.debugDir) {
    args.push("--debug-dir", request.debugDir);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 3e4);
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (timedOut) {
        reject(new Error("Native recognizer timed out after 30000ms."));
        return;
      }
      try {
        const parsed = parseRecognizerOutput(stdout);
        if (parsed) {
          resolve(parsed);
          return;
        }
      } catch (error) {
        reject(new Error(`Native recognizer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      reject(new Error(`Native recognizer exited with code ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

// src/apps/answer-card/server/scanner/index.ts
import { Router as Router2 } from "express";
import { existsSync as existsSync9 } from "node:fs";
import path12 from "node:path";

// src/apps/answer-card/server/scanner/scanner-service.ts
init_storage();
init_scan_store();
import path11 from "node:path";
import { mkdir as mkdir3 } from "node:fs/promises";

// src/apps/answer-card/server/scanner/twain-bridge.ts
init_storage();
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync8 } from "node:fs";
import path10 from "node:path";
function processResourcesPath2() {
  return process.resourcesPath;
}
function nativeResourceDir2() {
  return process.arch === "ia32" ? "win-ia32" : "win-x64";
}
function nativeBuildPlatform2() {
  return process.arch === "ia32" ? "Win32" : "x64";
}
function resolveScannerBridgeExe() {
  const configured = process.env.SCANNER_BRIDGE_EXE;
  const resourcesPath = processResourcesPath2();
  const resourceDir = nativeResourceDir2();
  const buildPlatform = nativeBuildPlatform2();
  const candidates = [
    configured,
    resourcesPath ? path10.join(resourcesPath, "native", resourceDir, "scanner-bridge.exe") : void 0,
    path10.join(rootDir2, "resources", "native", resourceDir, "scanner-bridge.exe"),
    path10.join(rootDir2, "native", "ScannerBridge", "scanner-bridge", buildPlatform, "Release", "scanner-bridge.exe"),
    path10.join(rootDir2, "native", "ScannerBridge", "scanner-bridge", buildPlatform, "Debug", "scanner-bridge.exe")
  ].filter((item) => Boolean(item));
  const found = candidates.find((candidate) => existsSync8(candidate));
  if (!found) {
    throw new Error(`\u672A\u627E\u5230\u626B\u63CF\u4EEA\u6865\u63A5\u7A0B\u5E8F\uFF0C\u5DF2\u68C0\u67E5\u8DEF\u5F84\uFF1A${candidates.join("; ")}`);
  }
  return found;
}
function runBridge(args, timeoutMs = 12e4) {
  const exePath = resolveScannerBridgeExe();
  return new Promise((resolve, reject) => {
    const child = spawn2(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (timedOut) {
        reject(new Error(`\u626B\u63CF\u4EEA\u6865\u63A5\u7A0B\u5E8F\u8D85\u65F6\uFF08${timeoutMs}ms\uFF09`));
        return;
      }
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`\u626B\u63CF\u4EEA\u6865\u63A5\u7A0B\u5E8F\u9000\u51FA\uFF0C\u9519\u8BEF\u7801\uFF1A${code}${stderr ? `\uFF0C\u9519\u8BEF\u4FE1\u606F\uFF1A${stderr}` : ""}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
function parseBridgeJson(stdout) {
  const text = stdout.trim();
  if (!text) throw new Error("\u626B\u63CF\u4EEA\u6865\u63A5\u7A0B\u5E8F\u8FD4\u56DE\u7A7A\u6570\u636E");
  return JSON.parse(text);
}
async function listSources() {
  const { stdout } = await runBridge(["list"], 15e3);
  return parseBridgeJson(stdout);
}
async function scan(config) {
  const args = [
    "scan",
    "--source",
    config.sourceName,
    "--dpi",
    String(config.dpi),
    "--mode",
    config.colorMode,
    "--size",
    config.paperSize,
    "--output",
    config.outputDir,
    "--prefix",
    config.filePrefix,
    "--max-pages",
    String(config.maxPages || 9999)
  ];
  if (config.duplex) {
    args.push("--duplex");
  }
  if (config.showUi) {
    args.push("--show-ui");
  }
  const { stdout } = await runBridge(args, 6e5);
  return parseBridgeJson(stdout);
}

// src/apps/answer-card/server/scanner/scanner-service.ts
init_storage();
init_grading();
function scansDir(cardId) {
  return path11.join(dataDir, "scans", cardId);
}
async function runScanSession(config, onProgress) {
  const session = await createSession(config.cardId, config.sessionName, {
    dpi: config.dpi,
    duplex: config.duplex,
    colorMode: config.colorMode,
    paperSize: config.paperSize
  });
  const sessionId = session.id;
  const outputDir = scansDir(config.cardId);
  await mkdir3(outputDir, { recursive: true });
  try {
    await updateSessionStatus(sessionId, "scanning");
    onProgress({ sessionId, type: "scanning", message: "\u6B63\u5728\u8FDE\u63A5\u626B\u63CF\u4EEA..." });
    const filePrefix = `session_${sessionId}`;
    const scanConfig = {
      sourceName: config.sourceName,
      dpi: config.dpi,
      duplex: config.duplex,
      colorMode: config.colorMode,
      paperSize: config.paperSize,
      outputDir,
      filePrefix,
      maxPages: config.maxPages || 0,
      showUi: config.showUi
    };
    const result = await scan(scanConfig);
    if (!result.pages || result.pages.length === 0) {
      throw new Error(result.message || "\u626B\u63CF\u672A\u4EA7\u751F\u4EFB\u4F55\u9875\u9762");
    }
    const card = await readCard(config.cardId);
    const isSingleSided = card?.sided === "single";
    const filteredPages = isSingleSided ? result.pages.filter((page) => page.side === "front") : result.pages;
    if (filteredPages.length === 0) {
      throw new Error("\u626B\u63CF\u7ED3\u679C\u4E2D\u6CA1\u6709\u4EFB\u4F55\u6B63\u9762\u9875\u9762");
    }
    const recordIds = [];
    for (const page of filteredPages) {
      const record = await createScanRecord({
        sessionId,
        cardId: config.cardId,
        imagePath: page.path,
        pageNum: page.page,
        side: page.side
      });
      recordIds.push(record.id);
      await incrementPageCount(sessionId);
      onProgress({
        sessionId,
        type: "page_done",
        pageNum: page.page,
        side: page.side,
        totalPages: filteredPages.length
      });
    }
    if (isSingleSided && result.pages.length > filteredPages.length) {
      const skipped = result.pages.length - filteredPages.length;
      onProgress({
        sessionId,
        type: "scanning",
        message: `\uFF08\u5355\u9762\u7B54\u9898\u5361\uFF1A\u5DF2\u8DF3\u8FC7 ${skipped} \u5F20\u80CC\u9762\uFF09`
      });
    }
    await updateSessionStatus(sessionId, "completed");
    onProgress({
      sessionId,
      type: "ocr_start",
      message: "\u6B63\u5728\u8BC6\u522B\u7B54\u9898\u5361...",
      totalPages: recordIds.length
    });
    await runOcrOnSession(sessionId, config.cardId, onProgress);
    onProgress({
      sessionId,
      type: "done",
      message: `\u626B\u63CF\u5B8C\u6210\uFF0C\u5171 ${recordIds.length} \u5F20`
    });
    return sessionId;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await updateSessionStatus(sessionId, "error", msg);
    onProgress({ sessionId, type: "error", message: msg });
    throw error;
  }
}
async function runOcrOnSession(sessionId, cardId, onProgress) {
  const records = await listScanRecords(sessionId);
  await readLayout(cardId);
  const card = await readCard(cardId);
  const isSingleSided = card?.sided === "single";
  for (const record of records) {
    if (!record.image_path) continue;
    const layoutPage = isSingleSided ? record.page_num : (record.page_num - 1) * 2 + (record.side === "front" ? 1 : 2);
    try {
      const recognition = await recognizeAnswerCard({
        imagePath: record.image_path,
        layoutPath: (await Promise.resolve().then(() => (init_storage(), storage_exports))).layoutPath(cardId),
        pageNumber: layoutPage,
        dpi: 300
      });
      const studentId = recognition.studentId?.value ?? null;
      const studentConf = recognition.studentId?.status === "ok" ? 0.9 : 0;
      const ocrStatus = recognition.status === "ok" ? "done" : recognition.status === "failed" ? "failed" : "review";
      await updateScanOcrResult(
        record.id,
        studentId,
        studentConf,
        ocrStatus,
        recognition.message
      );
      if (card) {
        try {
          const graded = gradeCombinedRecognition(card, record.image_path, recognition);
          await upsertRecognitionResult({
            scanRecordId: record.id,
            objectiveJson: JSON.stringify(recognition.questions),
            subjectiveJson: JSON.stringify(recognition.subjectiveQuestions ?? []),
            totalScore: graded.totalScore,
            maxScore: graded.totalMaxScore,
            gradeStatus: "done"
          });
        } catch (gradeError) {
          console.error(`[Scanner] Grading failed for record ${record.id}:`, gradeError);
          await upsertRecognitionResult({
            scanRecordId: record.id,
            objectiveJson: JSON.stringify(recognition.questions),
            subjectiveJson: JSON.stringify(recognition.subjectiveQuestions ?? []),
            gradeStatus: "pending"
          });
        }
      }
      if (recognition.quality?.overallScore !== void 0) {
        await updateScanQuality(record.id, recognition.quality.overallScore);
      }
      onProgress({
        sessionId,
        type: "ocr_page_done",
        pageNum: record.page_num,
        side: record.side,
        studentId,
        studentConf
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await updateScanOcrResult(record.id, null, null, "failed", msg);
      onProgress({
        sessionId,
        type: "ocr_page_done",
        pageNum: record.page_num,
        side: record.side,
        studentId: null,
        message: msg
      });
    }
  }
  onProgress({ sessionId, type: "ocr_done", message: "\u8BC6\u522B\u5B8C\u6210" });
}
async function getCardScansWithStudents(cardId) {
  const { listScansForCard: listScansForCard2 } = await Promise.resolve().then(() => (init_scan_store(), scan_store_exports));
  return listScansForCard2(cardId);
}

// src/apps/answer-card/server/scanner/index.ts
init_scan_store();
init_storage();
init_grading();
function createScannerRouter() {
  const router13 = Router2();
  async function persistScannerResultToMainDb(cardId, result) {
    if (!result.studentId || result.studentId === "\u672A\u8BC6\u522B") return;
    const { getMysqlDb: getMysqlDb2 } = await Promise.resolve().then(() => (init_db(), db_exports));
    const db3 = getMysqlDb2();
    const user = await db3.get("SELECT id FROM users WHERE student_number = ?", result.studentId);
    if (!user) return;
    const exams = await db3.all("SELECT id FROM exams WHERE card_id = ? AND status != 'closed'", cardId);
    if (exams.length === 0) return;
    for (const exam of exams) {
      await db3.run(
        "REPLACE INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score, graded_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
        exam.id,
        user.id,
        result.objectiveScore,
        result.subjectiveScore,
        result.totalScore
      );
      for (const q of result.objectiveQuestions) {
        await db3.run(
          "REPLACE INTO question_scores (exam_id, student_id, question_number, question_id, score, max_score, score_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
          exam.id,
          user.id,
          q.questionNumber,
          "",
          q.score,
          q.maxScore,
          "objective"
        );
      }
      for (const sq of result.subjectiveQuestions) {
        await db3.run(
          "REPLACE INTO question_scores (exam_id, student_id, question_number, question_id, score, max_score, score_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
          exam.id,
          user.id,
          String(sq.questionNumber),
          sq.questionId,
          sq.score,
          sq.maxScore,
          "subjective"
        );
      }
      await db3.run(
        "UPDATE exams SET status = 'grading', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'",
        exam.id
      );
    }
  }
  const progressEmitters = /* @__PURE__ */ new Map();
  function emitProgress(sessionId, event) {
    const listeners = progressEmitters.get(sessionId);
    if (listeners) {
      for (const fn of listeners) fn(event);
    }
  }
  router13.get("/sources", async (_req, res, next) => {
    try {
      const result = await listSources();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
  router13.post("/scan", async (req, res, next) => {
    try {
      const body = req.body;
      if (!body.cardId) {
        res.status(400).json({ message: "\u7F3A\u5C11 cardId \u53C2\u6570" });
        return;
      }
      const config = {
        cardId: safeId(body.cardId),
        sessionName: body.sessionName || `\u626B\u63CF_${(/* @__PURE__ */ new Date()).toLocaleDateString("zh-CN")}`,
        sourceName: body.sourceName || "",
        dpi: body.dpi && body.dpi > 0 ? body.dpi : 300,
        duplex: body.duplex === true,
        colorMode: body.colorMode || "gray",
        paperSize: body.paperSize || "A4",
        maxPages: body.maxPages || 0,
        showUi: body.showUi === true
      };
      const sessionId = await runScanSession(config, (event) => {
        emitProgress(event.sessionId, event);
      });
      res.status(202).json({
        sessionId,
        message: "\u626B\u63CF\u5DF2\u542F\u52A8",
        status: "scanning"
      });
    } catch (error) {
      next(error);
    }
  });
  router13.get("/scan/:sessionId", async (req, res, next) => {
    try {
      const session = getSession(safeId(req.params.sessionId));
      if (!session) {
        res.status(404).json({ message: "\u626B\u63CF\u4F1A\u8BDD\u4E0D\u5B58\u5728" });
        return;
      }
      const records = listScanRecords(session.id);
      res.json({
        session,
        records: records.map((r) => ({
          id: r.id,
          pageNum: r.page_num,
          side: r.side,
          studentId: r.student_id,
          studentConf: r.student_conf,
          ocrStatus: r.ocr_status,
          scanQuality: r.scan_quality,
          imagePath: r.image_path
        }))
      });
    } catch (error) {
      next(error);
    }
  });
  router13.get("/sessions/:cardId", async (req, res, next) => {
    try {
      const sessions = listSessions(safeId(req.params.cardId));
      res.json(sessions);
    } catch (error) {
      next(error);
    }
  });
  router13.delete("/scan/:sessionId", async (req, res, next) => {
    try {
      const id = safeId(req.params.sessionId);
      const session = getSession(id);
      if (!session) {
        res.status(404).json({ message: "\u626B\u63CF\u4F1A\u8BDD\u4E0D\u5B58\u5728" });
        return;
      }
      deleteSession(id);
      res.json({ message: "\u5DF2\u5220\u9664" });
    } catch (error) {
      next(error);
    }
  });
  router13.get("/record/:recordId", async (req, res, next) => {
    try {
      const record = getScanRecordWithResult(safeId(req.params.recordId));
      if (!record) {
        res.status(404).json({ message: "\u626B\u63CF\u8BB0\u5F55\u4E0D\u5B58\u5728" });
        return;
      }
      res.json(record);
    } catch (error) {
      next(error);
    }
  });
  router13.delete("/record/:recordId", async (req, res, next) => {
    try {
      const id = safeId(req.params.recordId);
      const record = await getScanRecordWithResult(id);
      if (!record) {
        res.status(404).json({ message: "\u626B\u63CF\u8BB0\u5F55\u4E0D\u5B58\u5728" });
        return;
      }
      deleteScanRecord(id);
      res.json({ message: "\u5DF2\u5220\u9664" });
    } catch (error) {
      next(error);
    }
  });
  router13.get("/card/:cardId/scans", async (req, res, next) => {
    try {
      const scans = await getCardScansWithStudents(safeId(req.params.cardId));
      res.json(
        scans.map((s) => ({
          recordId: s.record.id,
          studentId: s.record.student_id,
          studentConf: s.record.student_conf,
          ocrStatus: s.record.ocr_status,
          pageNum: s.record.page_num,
          side: s.record.side,
          imagePath: s.record.image_path,
          scanQuality: s.record.scan_quality,
          createdAt: s.record.created_at,
          recognition: s.recognition ? {
            totalScore: s.recognition.total_score,
            maxScore: s.recognition.max_score,
            gradeStatus: s.recognition.grade_status
          } : null
        }))
      );
    } catch (error) {
      next(error);
    }
  });
  router13.get("/exam/:examId/student/:studentId/scans", async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(examId) || !Number.isFinite(studentId)) {
        res.status(400).json({ message: "Invalid examId or studentId" });
        return;
      }
      const { getMysqlDb: getMysqlDb2 } = await Promise.resolve().then(() => (init_db(), db_exports));
      const db3 = getMysqlDb2();
      const exam = await db3.get("SELECT card_id FROM exams WHERE id = ?", examId);
      if (!exam || !exam.card_id) {
        res.json({ studentId, studentNumber: "", pages: [] });
        return;
      }
      const cardId = exam.card_id;
      const user = await db3.get("SELECT student_number FROM users WHERE id = ?", studentId);
      const records = await db3.all(`
        SELECT sr.id, sr.file_path, sr.file_name
        FROM scan_records sr
        JOIN scan_batches sb ON sr.batch_id = sb.id
        WHERE sb.exam_id = ? AND sr.student_id = ?
        ORDER BY sr.id
      `, examId, studentId);
      if (records.length === 0) {
        res.json({ studentId, studentNumber: user?.student_number || "", pages: [] });
        return;
      }
      const pages = [];
      const { existsSync: fsExists } = await import("node:fs");
      for (const rec of records) {
        if (rec.file_path && fsExists(rec.file_path)) {
          const fileName = path12.basename(rec.file_path);
          pages.push({
            recordId: String(rec.id),
            pageNum: pages.length + 1,
            side: "front",
            fileName
          });
        }
      }
      res.json({
        studentId,
        studentNumber: user?.student_number || "",
        cardId,
        pages
      });
    } catch (error) {
      next(error);
    }
  });
  router13.get("/grading-image/:cardId/:fileName", (req, res, next) => {
    try {
      const cardId = safeId(req.params.cardId);
      const fileName = path12.basename(req.params.fileName);
      if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
        res.status(400).json({ message: "Invalid file name" });
        return;
      }
      const targetPath = path12.join(dataDir, "recognition", "uploads", cardId, fileName);
      if (!existsSync9(targetPath)) {
        res.status(404).json({ message: "\u56FE\u7247\u4E0D\u5B58\u5728" });
        return;
      }
      const ext = path12.extname(targetPath).toLowerCase();
      const contentType = ext === ".png" ? "image/png" : "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(targetPath);
    } catch (error) {
      next(error);
    }
  });
  router13.get("/session/:sessionId/results", async (req, res, next) => {
    try {
      const sessionId = safeId(req.params.sessionId);
      const session = getSession(sessionId);
      if (!session) {
        res.status(404).json({ message: "\u626B\u63CF\u4F1A\u8BDD\u4E0D\u5B58\u5728" });
        return;
      }
      const cached = listStudentGradingResults(sessionId);
      if (cached.length > 0) {
        res.json(cached.map((r) => ({
          studentId: r.student_id,
          totalScore: r.total_score,
          maxScore: r.max_score,
          pageCount: r.page_count,
          objectiveJson: r.objective_json ? JSON.parse(r.objective_json) : null,
          subjectiveJson: r.subjective_json ? JSON.parse(r.subjective_json) : null
        })));
        return;
      }
      const card = await readCard(session.card_id);
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      const groups = listScanRecordsGroupedByStudent(sessionId);
      const results = [];
      for (const group of groups) {
        const pages = group.records.filter((r) => r.recognition).map((r) => ({
          recordId: r.id,
          pageNum: r.page_num,
          side: r.side,
          imagePath: r.image_path,
          recognition: {
            status: "ok",
            studentId: { status: "ok", value: r.student_id },
            questions: r.recognition?.objective_json ? JSON.parse(r.recognition.objective_json) : [],
            subjectiveQuestions: r.recognition?.subjective_json ? JSON.parse(r.recognition.subjective_json) : [],
            message: r.ocr_error ?? void 0
          },
          ocrStatus: r.ocr_status
        }));
        if (pages.length === 0) continue;
        try {
          const combined = gradeSessionStudentResults(card, pages);
          results.push(combined);
          upsertStudentGradingResult({
            sessionId,
            studentId: combined.studentId,
            totalScore: combined.totalScore,
            maxScore: combined.totalMaxScore,
            pageCount: combined.pageCount
          });
          persistScannerResultToMainDb(session.card_id, combined).catch((err) => {
            console.error(`[Scanner] Main DB persist failed for ${combined.studentId}:`, err);
          });
        } catch (err) {
          console.error(`[Scanner] Combined grading failed for student ${group.studentId}:`, err);
        }
      }
      res.json(results.map((r) => ({
        studentId: r.studentId,
        totalScore: r.totalScore,
        maxScore: r.totalMaxScore,
        pageCount: r.pageCount,
        objectiveScore: r.objectiveScore,
        subjectiveScore: r.subjectiveScore,
        needsReviewCount: r.needsReviewCount,
        pages: r.pages.map((p) => ({
          recordId: p.recordId,
          pageNum: p.pageNum,
          side: p.side,
          imagePath: p.imagePath,
          objectiveScore: p.objectiveScore,
          subjectiveScore: p.subjectiveScore,
          totalScore: p.totalScore,
          totalMaxScore: p.totalMaxScore,
          needsReviewCount: p.needsReviewCount
        }))
      })));
    } catch (error) {
      next(error);
    }
  });
  router13.get("/scan-image/:recordId", async (req, res, next) => {
    try {
      const record = getScanRecordWithResult(safeId(req.params.recordId));
      if (!record || !record.image_path) {
        res.status(404).json({ message: "\u626B\u63CF\u8BB0\u5F55\u4E0D\u5B58\u5728" });
        return;
      }
      if (!existsSync9(record.image_path)) {
        res.status(404).json({ message: "\u56FE\u7247\u6587\u4EF6\u4E0D\u5B58\u5728" });
        return;
      }
      const ext = path12.extname(record.image_path).toLowerCase();
      const contentType = ext === ".png" ? "image/png" : "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(record.image_path);
    } catch (error) {
      next(error);
    }
  });
  router13.get("/progress/:sessionId", (req, res) => {
    const sessionId = safeId(req.params.sessionId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const handler = (event) => {
      res.write(`data: ${JSON.stringify(event)}

`);
      if (event.type === "done" || event.type === "error") {
        res.end();
      }
    };
    if (!progressEmitters.has(sessionId)) {
      progressEmitters.set(sessionId, /* @__PURE__ */ new Set());
    }
    progressEmitters.get(sessionId).add(handler);
    req.on("close", () => {
      const listeners = progressEmitters.get(sessionId);
      if (listeners) {
        listeners.delete(handler);
        if (listeners.size === 0) progressEmitters.delete(sessionId);
      }
    });
  });
  return router13;
}

// src/apps/answer-card/server/index.ts
init_storage();
function paramValue(value) {
  return Array.isArray(value) ? value[0] : value ?? "";
}
function fieldValue(value) {
  if (Array.isArray(value)) {
    return String(value[0] ?? "");
  }
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
function boolField(value) {
  const normalized = fieldValue(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
var EXAM_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
var MIN_EXAM_YEAR = 1900;
var MAX_EXAM_YEAR = 2100;
function isValidExamDate(value) {
  if (!value) return false;
  const match = EXAM_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_EXAM_YEAR || year > MAX_EXAM_YEAR || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
function normalizeCard(card, cardId) {
  const examDate = fieldValue(card.examDate ?? card.examDate).trim();
  return {
    ...card,
    id: safeId(cardId),
    subjectLabel: card.subjectLabel ?? card.subjectLabel ?? void 0,
    examDate: isValidExamDate(examDate) ? examDate : void 0,
    bodyBlocks: (card.bodyBlocks ?? []).map((block) => {
      if (block.type === "objective") {
        const answerKey = normalizeObjectiveAnswerKey(block);
        const normalizedBlock = { ...block, answerKey };
        return { ...normalizedBlock, questions: normalizeObjectiveQuestions(normalizedBlock) };
      }
      if (block.type === "subjective" && Array.isArray(block.questions)) {
        return {
          ...block,
          questions: block.questions.map((q) => ({
            ...q,
            score: typeof q.score === "number" ? q.score : 0,
            minHeightMm: typeof q.minHeightMm === "number" ? q.minHeightMm : 68
          }))
        };
      }
      return block;
    }),
    paper: { size: "A4", orientation: "portrait" },
    layoutVersion: 1,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function toCardSummary(row) {
  return {
    id: row.id,
    title: row.title || "\u672A\u547D\u540D\u7B54\u9898\u5361",
    subject: row.subject ?? void 0,
    subjectLabel: row.subject_label ?? void 0,
    examDate: row.exam_date ?? void 0,
    updatedAt: row.updatedAt ?? row.updated_at ?? (/* @__PURE__ */ new Date(0)).toISOString()
  };
}
async function writeLayoutDocument(cardId, layout) {
  const targetPath = layoutPath(cardId);
  await mkdir4(path14.dirname(targetPath), { recursive: true });
  await writeFile3(targetPath, JSON.stringify(layout, null, 2), "utf8");
}
async function saveCardWithLayout(cardRepo, card, createdBy) {
  const normalized = normalizeCard(card, card.id);
  const layout = buildLayout(normalized);
  const exists = await cardRepo.findById(normalized.id);
  if (exists) {
    await cardRepo.updateCard(normalized);
  } else {
    await cardRepo.createCard(normalized, createdBy);
    await cardRepo.updateCard(normalized);
  }
  await writeLayoutDocument(normalized.id, layout);
  return normalized;
}
async function prepareLayoutForCard(cardRepo, card) {
  const normalized = normalizeCard(card, card.id);
  const layout = buildLayout(normalized);
  await writeLayoutDocument(normalized.id, layout);
  return layoutPath(normalized.id);
}
function requestFlag(value) {
  return value === true || boolField(value);
}
async function deleteExamRows(db3, examIds) {
  for (const examId of examIds) {
    await db3.run("DELETE FROM question_scores WHERE exam_id = ?", examId);
    await db3.run("DELETE FROM student_scores WHERE exam_id = ?", examId);
    await db3.run("DELETE FROM scan_batches WHERE exam_id = ?", examId);
    await db3.run("DELETE FROM exams WHERE id = ?", examId);
  }
}
async function deleteCardFiles(cardId) {
  const cardJsonPath = path14.join(dataDir, "cards", `${cardId}.json`);
  const layoutJsonPath = layoutPath(cardId);
  const assetsPath = cardAssetsDir(cardId);
  try {
    if (existsSync11(cardJsonPath)) await rm2(cardJsonPath);
  } catch {
  }
  try {
    if (existsSync11(layoutJsonPath)) await rm2(layoutJsonPath);
  } catch {
  }
  try {
    if (existsSync11(assetsPath)) await rm2(assetsPath, { recursive: true, force: true });
  } catch {
  }
}
function parsePositiveNumber(value, fallback) {
  const parsed = Number(fieldValue(value) || String(fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function gradingPreviewUrl(cardId, imagePath) {
  if (!imagePath) return void 0;
  return `/api/cards/${encodeURIComponent(cardId)}/grading/preview/${encodeURIComponent(path14.basename(imagePath))}`;
}
var gradingProgressListeners = /* @__PURE__ */ new Map();
var gradingProgressSnapshots = /* @__PURE__ */ new Map();
function recognitionConcurrency() {
  const configured = Number(process.env.ANSWER_CARD_RECOGNITION_CONCURRENCY);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.floor(configured));
  }
  return Math.min(4, Math.max(2, Math.floor(cpus().length / 2)));
}
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    })
  );
  return results;
}
function emitGradingProgress(event) {
  gradingProgressSnapshots.set(event.batchId, event);
  const listeners = gradingProgressListeners.get(event.batchId);
  if (listeners) {
    for (const listener of listeners) listener(event);
  }
  if (event.type === "done" || event.type === "error") {
    gradingProgressListeners.delete(event.batchId);
    setTimeout(() => gradingProgressSnapshots.delete(event.batchId), 6e4).unref();
  }
}
async function persistGradingResults(examIdParam, rows, createdBy) {
  const { ExamRepository: ExamRepository2 } = await Promise.resolve().then(() => (init_ExamRepository(), ExamRepository_exports));
  const { getMysqlDb: getMysqlDb2, hashPassword: hashPassword2 } = await Promise.resolve().then(() => (init_db(), db_exports));
  const examRepo = new ExamRepository2();
  const db3 = getMysqlDb2();
  const examId = Number(examIdParam);
  const exam = await await examRepo.findExamById(examId);
  if (!exam) return;
  await examRepo.updateStatus(examId, "grading");
  const batchId = await examRepo.createScanBatch(examId, `\u9605\u5377_${(/* @__PURE__ */ new Date()).toLocaleDateString("zh-CN")}`, createdBy);
  const ensureStudentSql = `
    INSERT IGNORE INTO users (username, password_hash, name, role_id, student_number)
    VALUES (?, ?, ?, 3, ?)
  `;
  const updateBlankStudentPasswordSql = `
    UPDATE users
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE student_number = ? AND role_id = 3 AND password_hash = ''
  `;
  const findStudentSql = `
    SELECT id FROM users WHERE student_number = ? AND role_id = 3 LIMIT 1
  `;
  const insertQsSql = `
    REPLACE INTO question_scores
      (exam_id, student_id, question_number, question_id, score, max_score, score_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  let persisted = 0;
  const studentPasswordHashes = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (row.studentId && !studentPasswordHashes.has(row.studentId)) {
      studentPasswordHashes.set(row.studentId, await hashPassword2(row.studentId));
    }
  }
  for (const row of rows) {
    if (!row.studentId) continue;
    try {
      const studentPasswordHash = studentPasswordHashes.get(row.studentId) ?? "";
      await db3.run(ensureStudentSql, row.studentId, studentPasswordHash, row.studentId, row.studentId);
      await db3.run(updateBlankStudentPasswordSql, studentPasswordHash, row.studentId);
      const stu = await db3.get(findStudentSql, row.studentId);
      if (!stu) continue;
      await examRepo.addScanRecord({
        batch_id: batchId,
        file_path: row.actualPath || row.fileName,
        file_name: row.fileName,
        student_number: row.studentId,
        student_id: stu.id
      });
      await examRepo.saveStudentScore(examId, stu.id, row.objectiveScore, row.subjectiveScore);
      for (const q of row.questions) {
        await db3.run(insertQsSql, examId, stu.id, q.questionNumber, "", q.score, q.maxScore, "objective");
      }
      for (const sq of row.subjectiveQuestions ?? []) {
        await db3.run(insertQsSql, examId, stu.id, sq.questionNumber, sq.questionId, sq.score, sq.maxScore, "subjective");
      }
      persisted++;
    } catch (err) {
      console.error(`[Grading] Failed to persist row for ${row.studentId}:`, err);
    }
  }
  await examRepo.finishBatch(batchId);
  await examRepo.updateStatus(examId, "closed");
  console.log(`[Grading] Persisted ${persisted} student scores to exam ${examId}`);
}
function makeGate(enforce, readPerm, writePerm) {
  return (req, res, next) => {
    if (!enforce) {
      next();
      return;
    }
    if (!req.user) {
      res.status(401).json({ message: "\u672A\u63D0\u4F9B\u8BA4\u8BC1\u4EE4\u724C" });
      return;
    }
    const required = req.method === "GET" || req.method === "HEAD" ? readPerm : writePerm;
    if (!roleHasPermission(req.user.role_id, required)) {
      res.status(403).json({ message: `\u6743\u9650\u4E0D\u8DB3\uFF1A\u7F3A\u5C11 ${required}` });
      return;
    }
    next();
  };
}
async function getVisibleExamIds(user) {
  if (!user || user.role_name === "admin") return null;
  if (user.role_name !== "teacher") return null;
  if (!user.teacher_role) return null;
  if (user.teacher_role === "grade_leader") return null;
  const db3 = getMysqlDb();
  if (user.teacher_role === "head_teacher") {
    const teacherClasses = await db3.all(
      "SELECT class_id FROM teacher_classes WHERE teacher_id = ?",
      user.id
    );
    const classIds = teacherClasses.map((r) => r.class_id);
    if (classIds.length === 0) return [];
    const rows = await db3.all(
      `SELECT DISTINCT e.id FROM exams e
       JOIN classes c ON c.id = e.class_id
       WHERE e.class_id IN (${classIds.map(() => "?").join(",")})`,
      ...classIds
    );
    return rows.map((r) => r.id);
  }
  if (user.teacher_role === "subject_teacher") {
    if (!user.subject) return [];
    const teacherClasses = await db3.all(
      "SELECT class_id FROM teacher_classes WHERE teacher_id = ? AND (subject = ? OR subject IS NULL)",
      user.id,
      user.subject
    );
    const classIds = teacherClasses.map((r) => r.class_id);
    if (classIds.length === 0) return [];
    const rows = await db3.all(
      `SELECT DISTINCT e.id FROM exams e
       WHERE e.subject = ? AND e.class_id IN (${classIds.map(() => "?").join(",")})`,
      user.subject,
      ...classIds
    );
    return rows.map((r) => r.id);
  }
  return null;
}
async function requireExamAccess(req, res, next) {
  if (!req.user) {
    next();
    return;
  }
  const examId = Number(req.params.examId);
  if (!examId) {
    res.status(400).json({ message: "\u7F3A\u5C11 examId" });
    return;
  }
  if (req.user.role_name === "student") {
    if (req.method !== "POST" || !req.originalUrl.includes("/ai-analysis")) {
      res.status(403).json({ message: "\u6743\u9650\u4E0D\u8DB3" });
      return;
    }
    const scoreRepo2 = new ScoreRepository();
    if (await scoreRepo2.hasScore(req.user.id, examId)) {
      next();
      return;
    }
    res.status(403).json({ message: "\u6743\u9650\u4E0D\u8DB3\uFF1A\u4F60\u672A\u53C2\u52A0\u8BE5\u8003\u8BD5" });
    return;
  }
  const visibleIds = await getVisibleExamIds(req.user);
  if (visibleIds === null) {
    next();
    return;
  }
  if (visibleIds.includes(examId)) {
    next();
    return;
  }
  res.status(403).json({ message: "\u6743\u9650\u4E0D\u8DB3\uFF1A\u65E0\u6743\u8BBF\u95EE\u6B64\u8003\u8BD5" });
}
function numberArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const item of value) {
    const id = Number(item);
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
function optionalPositiveNumber(value) {
  if (value == null || value === "") return void 0;
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : void 0;
}
async function validateExamIdsAccess(req, res, examIds) {
  const visibleIds = await getVisibleExamIds(req.user);
  if (visibleIds === null) return true;
  const visible = new Set(visibleIds);
  const denied = examIds.filter((examId) => !visible.has(examId));
  if (denied.length === 0) return true;
  res.status(403).json({ message: "\u6743\u9650\u4E0D\u8DB3\uFF1A\u8003\u8BD5\u7EC4\u5305\u542B\u4E0D\u53EF\u8BBF\u95EE\u7684\u8003\u8BD5" });
  return false;
}
function scannerEnabled() {
  if (process.env.PROJECTX_ENABLE_SCANNER === "1" || process.env.PROJECTX_ENABLE_SCANNER === "true") {
    return true;
  }
  if (process.env.PROJECTX_ENABLE_SCANNER === "0" || process.env.PROJECTX_ENABLE_SCANNER === "false") {
    return false;
  }
  return process.env.PROJECTX_VARIANT === "teacher-scanner" || !process.env.PROJECTX_VARIANT;
}
function llmClientUrl(pathname = "") {
  const base = (process.env.LLMCLIENT_URL || "http://127.0.0.1:8766").replace(/\/+$/, "");
  return `${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}
function llmClientHeaders(extra) {
  const headers = { ...extra ?? {} };
  const internalKey = process.env.LLMCLIENT_INTERNAL_API_KEY;
  if (internalKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${internalKey}`;
  }
  return headers;
}
async function fetchLlmClient(pathname, init, timeoutMs = 5e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(llmClientUrl(pathname), {
      ...init,
      headers: llmClientHeaders(init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : void 0),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}
async function createApp() {
  const app = express12();
  console.log("[Server] \u6B63\u5728\u521D\u59CB\u5316\u6570\u636E\u5E93...");
  initializeDatabase();
  getMysqlDb();
  await initMariadbSchema();
  await ensureDefaultAdmin();
  await initPermissionCache();
  const cleanupTimer = scheduleCleanup(24, 30);
  cleanupTimer.unref();
  await ensureDataDirs();
  console.log("[Server] \u6570\u636E\u5E93\u521D\u59CB\u5316\u5B8C\u6210");
  const enforceAuth = process.env.PROJECTX_AUTH_ENFORCE === "1" || process.env.PROJECTX_AUTH_ENFORCE === "true";
  console.log(`[Server] RBAC \u9274\u6743\u5F3A\u5236\u6A21\u5F0F: ${enforceAuth ? "\u5F00\u542F" : "\u5173\u95ED\uFF08\u4EC5\u89E3\u6790\u8EAB\u4EFD\uFF09"}`);
  app.use(express12.json({ limit: "8mb" }));
  app.use("/assets", express12.static(assetsDir));
  app.use("/api", optionalAuth);
  app.use("/api/auth", auth_default);
  app.use("/api/users", users_default);
  app.use("/api/classes", classes_default);
  app.use("/api/teachers", teachers_default);
  app.use("/api/export", export_default);
  app.use("/api/export", export_scores_default);
  app.use("/api/exam-groups", exam_groups_default);
  app.use("/api/scores", scores_default);
  app.use("/api/sponsor", sponsor_default);
  app.use("/api/db", backup_default);
  app.use("/api/ai/providers", ai_providers_default);
  app.get("/api/app/db-config", authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE), async (req, res) => {
    try {
      const { readDbConfig: readDbConfig2 } = await Promise.resolve().then(() => (init_config(), config_exports));
      const config = readDbConfig2();
      res.json({
        mode: config.mode,
        remote: config.remote ? {
          host: config.remote.host,
          port: config.remote.port ?? 3306,
          database: config.remote.database ?? "projectx",
          user: config.remote.user ?? "",
          hasPassword: !!config.remote.password
        } : null
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });
  app.patch("/api/app/db-config", authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE), async (req, res) => {
    try {
      const { mode, remote } = req.body ?? {};
      if (mode !== "local" && mode !== "remote") {
        res.status(400).json({ message: "mode \u5FC5\u987B\u4E3A local \u6216 remote" });
        return;
      }
      const { writeDbConfig: writeDbConfig2 } = await Promise.resolve().then(() => (init_config(), config_exports));
      writeDbConfig2({
        mode,
        remote: remote ? {
          host: remote.host ?? "",
          port: remote.port ?? 3306,
          database: remote.database ?? "projectx",
          user: remote.user ?? "",
          password: remote.password ?? ""
        } : void 0
      });
      res.json({
        ok: true,
        message: mode === "remote" ? "\u6570\u636E\u5E93\u914D\u7F6E\u5DF2\u4FDD\u5B58\u4E3A\u8FDC\u7A0B\u6A21\u5F0F\u3002\u8BF7\u91CD\u542F\u670D\u52A1\u5668\u4EE5\u4F7F\u65B0\u8BBE\u7F6E\u751F\u6548\u3002" : "\u6570\u636E\u5E93\u914D\u7F6E\u5DF2\u4FDD\u5B58\u4E3A\u672C\u5730\u6A21\u5F0F\u3002\u8BF7\u91CD\u542F\u670D\u52A1\u5668\u4EE5\u4F7F\u65B0\u8BBE\u7F6E\u751F\u6548\u3002"
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });
  console.log("[Server] v1.6.0 routes mounted: /api/teachers, /api/export, /api/users/import-csv, /api/analysis/ai");
  const cardGate = makeGate(enforceAuth, PERMISSIONS.CARD_READ, PERMISSIONS.GRADE_WRITE);
  const examGate = makeGate(enforceAuth, PERMISSIONS.EXAM_READ, PERMISSIONS.EXAM_WRITE);
  const analysisGate = makeGate(enforceAuth, PERMISSIONS.GRADE_READ, PERMISSIONS.GRADE_READ);
  const scannerGate = makeGate(enforceAuth, PERMISSIONS.GRADE_WRITE, PERMISSIONS.GRADE_WRITE);
  app.use("/api/cards", cardGate);
  app.use("/api/exams", examGate);
  app.use("/api/analysis", analysisGate);
  const cardRepo = new CardRepository();
  const upload = multer({
    storage: multer.diskStorage({
      destination: async (req, _file, cb) => {
        const cardId = safeId(paramValue(req.params.cardId));
        const dir = cardAssetsDir(cardId);
        await mkdir4(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path14.extname(file.originalname).toLowerCase() || ".png";
        const name = `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        cb(null, name);
      }
    }),
    limits: { fileSize: 12 * 1024 * 1024 }
  });
  const recognitionUpload = multer({
    storage: multer.diskStorage({
      destination: async (req, _file, cb) => {
        const cardId = safeId(paramValue(req.params.cardId));
        const dir = path14.join(dataDir, "recognition", "uploads", cardId);
        await mkdir4(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path14.extname(file.originalname).toLowerCase() || ".png";
        const name = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        cb(null, name);
      }
    }),
    limits: { fileSize: 20 * 1024 * 1024 }
  });
  app.get("/api/cards", async (_req, res, next) => {
    try {
      res.json((await cardRepo.listCards()).map(toCardSummary));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/cards", async (req, res, next) => {
    try {
      const subject = (req.body?.subject ?? "").trim();
      const title = (req.body?.title ?? "").trim();
      const subjectLabel = (req.body?.subjectLabel ?? "").trim();
      const examDate = (req.body?.examDate ?? "").trim();
      const englishListening = req.body?.englishListening !== false;
      const chineseChoicePlacement = req.body?.chineseChoicePlacement === "inline" ? "inline" : "front";
      if (!subject) {
        res.status(400).json({ error: "\u79D1\u76EE\uFF08subject\uFF09\u4E3A\u5FC5\u586B\u9879" });
        return;
      }
      if (!title) {
        res.status(400).json({ error: "\u8003\u8BD5\u540D\u79F0\u4E3A\u5FC5\u586B\u9879" });
        return;
      }
      if (!isValidExamDate(examDate)) {
        res.status(400).json({ error: `\u8003\u8BD5\u65F6\u95F4\u4E3A\u5FC5\u586B\u9879\uFF0C\u9700\u4E3A ${MIN_EXAM_YEAR}-${MAX_EXAM_YEAR} \u8303\u56F4\u5185\u7684\u6709\u6548\u65E5\u671F\uFF08YYYY-MM-DD\uFF09` });
        return;
      }
      if (await cardRepo.findByTitle(title)) {
        res.status(409).json({ error: `\u5DF2\u5B58\u5728\u540C\u540D\u7B54\u9898\u5361\u300C${title}\u300D\uFF0C\u8BF7\u4FEE\u6539\u540D\u79F0\u540E\u91CD\u8BD5` });
        return;
      }
      let id = generateCardId(subject);
      let retry = 0;
      while (await cardRepo.findById(id) && retry < 100) {
        id = generateCardId(subject + "_" + String(retry++));
      }
      let card = createDefaultCard(id, subject);
      card.title = title;
      card.subjectLabel = subjectLabel || void 0;
      card.examDate = examDate;
      card = applySubjectTemplate(card, { englishListening, chineseChoicePlacement });
      const saved = await saveCardWithLayout(cardRepo, card, req.user?.id);
      res.status(201).json(saved);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/cards/:cardId", async (req, res, next) => {
    try {
      const card = await cardRepo.findById(safeId(paramValue(req.params.cardId)));
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      res.json(card);
    } catch (error) {
      next(error);
    }
  });
  app.put("/api/cards/:cardId", async (req, res, next) => {
    try {
      const examDate = fieldValue(req.body?.examDate).trim();
      if (examDate && !isValidExamDate(examDate)) {
        res.status(400).json({ message: `\u8003\u8BD5\u65F6\u95F4\u9700\u4E3A ${MIN_EXAM_YEAR}-${MAX_EXAM_YEAR} \u8303\u56F4\u5185\u7684\u6709\u6548\u65E5\u671F\uFF08YYYY-MM-DD\uFF09` });
        return;
      }
      const card = normalizeCard(req.body, paramValue(req.params.cardId));
      const saved = await saveCardWithLayout(cardRepo, card, req.user?.id);
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/cards/:cardId/layout", async (req, res, next) => {
    try {
      const card = await cardRepo.findById(safeId(paramValue(req.params.cardId)));
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      const layout = buildLayout(card);
      await writeLayoutDocument(card.id, layout);
      res.json(layout);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/cards/:cardId/recognition/objective", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "\u6CA1\u6709\u6536\u5230\u7B54\u9898\u5361\u56FE\u7247" });
        return;
      }
      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug ? path14.join(dataDir, "processed", "recognition-debug", cardId, String(Date.now())) : void 0;
      if (debugDir) {
        await mkdir4(debugDir, { recursive: true });
      }
      const result = await recognizeObjectiveAnswers({
        imagePath: req.file.path,
        layoutPath: await prepareLayoutForCard(cardRepo, card),
        pageNumber,
        dpi,
        debugDir
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/cards/:cardId/recognition", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "\u6CA1\u6709\u6536\u5230\u7B54\u9898\u5361\u56FE\u7247" });
        return;
      }
      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug ? path14.join(dataDir, "processed", "recognition-debug", cardId, String(Date.now())) : void 0;
      if (debugDir) {
        await mkdir4(debugDir, { recursive: true });
      }
      const result = await recognizeAnswerCard({
        imagePath: req.file.path,
        layoutPath: await prepareLayoutForCard(cardRepo, card),
        pageNumber,
        dpi,
        debugDir
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/cards/:cardId/grading/progress/:batchId", (req, res) => {
    const batchId = safeId(paramValue(req.params.batchId));
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const handler = (event) => {
      res.write(`data: ${JSON.stringify(event)}

`);
      if (event.type === "done" || event.type === "error") {
        res.end();
      }
    };
    if (!gradingProgressListeners.has(batchId)) {
      gradingProgressListeners.set(batchId, /* @__PURE__ */ new Set());
    }
    gradingProgressListeners.get(batchId).add(handler);
    const snapshot = gradingProgressSnapshots.get(batchId);
    if (snapshot) {
      handler(snapshot);
    }
    req.on("close", () => {
      const listeners = gradingProgressListeners.get(batchId);
      if (listeners) {
        listeners.delete(handler);
        if (listeners.size === 0) gradingProgressListeners.delete(batchId);
      }
    });
  });
  app.post("/api/cards/:cardId/grading/objective", recognitionUpload.array("files"), async (req, res, next) => {
    let progressId = "";
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      progressId = safeId(fieldValue(req.body.progressId));
      const card = await cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        res.status(400).json({ message: "\u6CA1\u6709\u6536\u5230\u7B54\u9898\u5361\u56FE\u7247" });
        return;
      }
      const backSidePattern = /B\.(jpg|jpeg|png|bmp|tiff|tif)$/i;
      const gradingFiles = card.sided === "single" ? files.filter((f) => !backSidePattern.test(f.originalname)) : files;
      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const currentLayoutPath = await prepareLayoutForCard(cardRepo, card);
      let finished = 0;
      if (progressId) {
        emitGradingProgress({ type: "start", batchId: progressId, finished, total: gradingFiles.length });
      }
      const rows = await mapWithConcurrency(gradingFiles, recognitionConcurrency(), async (file) => {
        try {
          const recognition = await recognizeObjectiveAnswers({
            imagePath: file.path,
            layoutPath: currentLayoutPath,
            pageNumber,
            dpi
          });
          return {
            ...gradeObjectiveRecognition(card, file.originalname || path14.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path),
            actualPath: file.path
          };
        } catch (error) {
          const recognition = {
            status: "failed",
            imagePath: file.path,
            pageNumber,
            message: error instanceof Error ? error.message : String(error),
            questions: []
          };
          return {
            ...gradeObjectiveRecognition(card, file.originalname || path14.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path),
            actualPath: file.path
          };
        } finally {
          finished++;
          if (progressId) {
            emitGradingProgress({ type: "progress", batchId: progressId, finished, total: gradingFiles.length });
          }
        }
      });
      if (progressId) {
        emitGradingProgress({ type: "done", batchId: progressId, finished, total: gradingFiles.length });
      }
      const result = {
        batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        cardId,
        rows
      };
      res.json(result);
    } catch (error) {
      if (progressId) {
        const snapshot = gradingProgressSnapshots.get(progressId);
        emitGradingProgress({
          type: "error",
          batchId: progressId,
          finished: snapshot?.finished ?? 0,
          total: snapshot?.total ?? 0
        });
      }
      next(error);
    }
  });
  app.post("/api/cards/:cardId/grading", recognitionUpload.array("files"), async (req, res, next) => {
    let progressId = "";
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      progressId = safeId(fieldValue(req.body.progressId));
      const card = await cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        res.status(400).json({ message: "\u6CA1\u6709\u6536\u5230\u7B54\u9898\u5361\u56FE\u7247" });
        return;
      }
      const backSidePattern = /B\.(jpg|jpeg|png|bmp|tiff|tif)$/i;
      const gradingFiles = card.sided === "single" ? files.filter((f) => !backSidePattern.test(f.originalname)) : files;
      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const currentLayoutPath = await prepareLayoutForCard(cardRepo, card);
      const examIdParam = fieldValue(req.body.examId);
      let finished = 0;
      if (progressId) {
        emitGradingProgress({ type: "start", batchId: progressId, finished, total: gradingFiles.length });
      }
      const rows = await mapWithConcurrency(gradingFiles, recognitionConcurrency(), async (file) => {
        try {
          const recognition = await recognizeAnswerCard({
            imagePath: file.path,
            layoutPath: currentLayoutPath,
            pageNumber,
            dpi
          });
          recognition.subjectiveQuestions = recognition.subjectiveQuestions ?? [];
          return {
            ...gradeCombinedRecognition(card, file.originalname || path14.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path),
            actualPath: file.path
          };
        } catch (error) {
          const recognition = {
            status: "failed",
            imagePath: file.path,
            pageNumber,
            message: error instanceof Error ? error.message : String(error),
            questions: [],
            subjectiveQuestions: []
          };
          return {
            ...gradeCombinedRecognition(card, file.originalname || path14.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path),
            actualPath: file.path
          };
        } finally {
          finished++;
          if (progressId) {
            emitGradingProgress({ type: "progress", batchId: progressId, finished, total: gradingFiles.length });
          }
        }
      });
      if (progressId) {
        emitGradingProgress({ type: "done", batchId: progressId, finished, total: gradingFiles.length });
      }
      const result = {
        batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        cardId,
        rows
      };
      res.json(result);
      if (examIdParam) {
        persistGradingResults(examIdParam, rows, req.user?.id).catch((err) => {
          console.error("[Grading] Persist failed:", err);
        });
      }
    } catch (error) {
      if (progressId) {
        const snapshot = gradingProgressSnapshots.get(progressId);
        emitGradingProgress({
          type: "error",
          batchId: progressId,
          finished: snapshot?.finished ?? 0,
          total: snapshot?.total ?? 0
        });
      }
      next(error);
    }
  });
  app.get("/api/cards/:cardId/grading/preview/:fileName", (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const fileName = path14.basename(paramValue(req.params.fileName));
      const targetPath = path14.join(dataDir, "recognition", "uploads", cardId, fileName);
      if (!existsSync11(targetPath)) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u56FE\u7247\u4E0D\u5B58\u5728" });
        return;
      }
      res.sendFile(targetPath);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/cards/:cardId/assets", upload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "\u6CA1\u6709\u6536\u5230\u56FE\u7247\u6587\u4EF6" });
        return;
      }
      res.status(201).json({
        assetId: req.file.filename,
        originalName: req.file.originalname,
        url: `/assets/${cardId}/${req.file.filename}`
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/cards/:cardId/pdf", async (req, res, next) => {
    try {
      const card = await cardRepo.findById(safeId(paramValue(req.params.cardId)));
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      const doc = createPdf(card);
      const filename = encodeURIComponent(`${card.title || card.id}.pdf`);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${filename}`);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      doc.pipe(res);
      doc.end();
    } catch (error) {
      next(error);
    }
  });
  app.delete("/api/cards/:cardId", async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      const examRepo = new ExamRepository();
      const exams = await examRepo.listExams();
      const referenced = exams.filter((e) => e.card_id === cardId);
      if (referenced.length > 0) {
        const body = req.body ?? {};
        const unlinkExams = requestFlag(body.unlinkExams);
        const deleteReferencedExams = requestFlag(body.deleteReferencedExams);
        if (!unlinkExams && !deleteReferencedExams) {
          res.status(409).json({
            message: `\u65E0\u6CD5\u76F4\u63A5\u5220\u9664\u7B54\u9898\u5361\uFF1A\u5DF2\u88AB ${referenced.length} \u4E2A\u8003\u8BD5\u5F15\u7528`,
            referencedExamCount: referenced.length,
            referencedExamNames: referenced.map((e) => e.name)
          });
          return;
        }
        const db3 = getMysqlDb();
        if (deleteReferencedExams) {
          await deleteExamRows(db3, referenced.map((e) => Number(e.id)));
        } else {
          await db3.run("UPDATE exams SET card_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE card_id = ?", cardId);
        }
        await cardRepo.deleteCard(cardId);
        await deleteCardFiles(cardId);
        res.json({
          ok: true,
          deleted: true,
          unlinkedExamCount: deleteReferencedExams ? 0 : referenced.length,
          deletedExamCount: deleteReferencedExams ? referenced.length : 0,
          referencedExamCount: referenced.length,
          referencedExamNames: referenced.map((e) => e.name)
        });
        return;
      }
      const deleted = await cardRepo.deleteCard(cardId);
      await deleteCardFiles(cardId);
      res.json({
        ok: true,
        deleted,
        referencedExamCount: referenced.length,
        referencedExamNames: referenced.map((e) => e.name)
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/cards/:cardId/export", async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "\u7B54\u9898\u5361\u4E0D\u5B58\u5728" });
        return;
      }
      const layout = buildLayout(card);
      const assetsMap = {};
      const assetsPath = cardAssetsDir(cardId);
      if (existsSync11(assetsPath)) {
        const { readdir: readdir3 } = await import("node:fs/promises");
        const files = await readdir3(assetsPath);
        for (const file of files) {
          try {
            const data = await readFile3(path14.join(assetsPath, file));
            assetsMap[file] = data.toString("base64");
          } catch {
          }
        }
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(card.title || cardId)}.projectx-card.json`
      );
      res.json({
        format: "projectx-card",
        version: 1,
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        card,
        layout,
        assets: assetsMap
      });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/cards/import", async (req, res, next) => {
    try {
      const imported = req.body;
      if (!imported || imported.format !== "projectx-card" || imported.version !== 1) {
        res.status(400).json({ message: "\u4E0D\u652F\u6301\u7684\u6587\u4EF6\u683C\u5F0F\uFF0C\u8BF7\u4F7F\u7528 .projectx-card.json \u5BFC\u51FA\u6587\u4EF6" });
        return;
      }
      if (!imported.card) {
        res.status(400).json({ message: "\u6587\u4EF6\u4E2D\u7F3A\u5C11\u7B54\u9898\u5361\u6570\u636E" });
        return;
      }
      const card = JSON.parse(JSON.stringify(imported.card));
      if (imported.overrideTitle) card.title = imported.overrideTitle;
      if (imported.overrideSubject != null) card.subject = imported.overrideSubject;
      if (imported.overrideSubjectLabel != null) card.subjectLabel = imported.overrideSubjectLabel;
      if (imported.overrideExamDate) card.examDate = imported.overrideExamDate;
      const importedExamDate = fieldValue(card.examDate).trim();
      if (importedExamDate && !isValidExamDate(importedExamDate)) {
        res.status(400).json({ message: `\u5BFC\u5165\u6587\u4EF6\u4E2D\u7684\u8003\u8BD5\u65F6\u95F4\u9700\u4E3A ${MIN_EXAM_YEAR}-${MAX_EXAM_YEAR} \u8303\u56F4\u5185\u7684\u6709\u6548\u65E5\u671F\uFF08YYYY-MM-DD\uFF09` });
        return;
      }
      if (card.bodyBlocks) {
        for (const block of card.bodyBlocks) {
          if (block.type === "subjective" && Array.isArray(block.questions)) {
            for (const q of block.questions) {
              if (q.score == null) q.score = 0;
              if (q.minHeightMm == null) q.minHeightMm = 68;
              if (q.maxScore == null) q.maxScore = 0;
            }
          }
          if (block.type === "objective") {
            if (block.scorePerQuestion == null) block.scorePerQuestion = 0;
            if (Array.isArray(block.questions)) {
              for (const q of block.questions) {
                if (q.score == null) q.score = 0;
              }
            }
          }
        }
      }
      const { randomUUID: randomUUID2 } = await import("node:crypto");
      const idMap = /* @__PURE__ */ new Map();
      if (card.bodyBlocks) {
        for (const block of card.bodyBlocks) {
          const oldId = block.id;
          const newBlockId = randomUUID2();
          idMap.set(oldId, newBlockId);
          block.id = newBlockId;
          if (block.type === "subjective" && Array.isArray(block.questions)) {
            for (const q of block.questions) {
              const oldQid = q.id;
              const newQid = randomUUID2();
              idMap.set(oldQid, newQid);
              q.id = newQid;
            }
          }
        }
      }
      const existingCard = await cardRepo.findByTitle(card.title);
      if (existingCard && existingCard.id !== card.id) {
        res.status(409).json({ message: `\u5DF2\u5B58\u5728\u540C\u540D\u7B54\u9898\u5361\u300C${card.title}\u300D\uFF08ID: ${existingCard.id}\uFF09\uFF0C\u8BF7\u4FEE\u6539\u540D\u79F0\u540E\u91CD\u8BD5` });
        return;
      }
      const subject = card.subject ?? "";
      let newId = generateCardId(subject || "imported");
      let retry = 0;
      const idConflict = await cardRepo.findById(imported.card.id ?? "");
      const conflictMsg = idConflict ? `\u539F\u5361\u7247ID ${imported.card.id} \u5DF2\u5B58\u5728\uFF0C\u5DF2\u5206\u914D\u65B0ID ${newId}` : "";
      while (await cardRepo.findById(newId) && retry < 100) {
        newId = generateCardId((subject || "imported") + "_" + String(retry++));
      }
      card.id = newId;
      card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      const saved = await saveCardWithLayout(cardRepo, card, req.user?.id);
      if (imported.assets && Object.keys(imported.assets).length > 0) {
        const assetsPath = cardAssetsDir(newId);
        await mkdir4(assetsPath, { recursive: true });
        for (const [filename, base64] of Object.entries(imported.assets)) {
          const safeFilename = path14.basename(filename);
          if (safeFilename && /^[a-zA-Z0-9_\-\.]+$/.test(safeFilename)) {
            try {
              const buffer = Buffer.from(base64, "base64");
              await writeFile3(path14.join(assetsPath, safeFilename), buffer);
            } catch {
            }
          }
        }
      }
      let createdExamId;
      let duplicateExamName;
      if (imported.examAction === "create") {
        const examRepo = new ExamRepository();
        const examName = imported.examName || saved.title;
        const existingExam = await examRepo.findExamByName(examName);
        if (existingExam) {
          duplicateExamName = examName;
        } else {
          const exam = await examRepo.createExam({
            name: examName,
            card_id: newId,
            subject: saved.subjectLabel || saved.subject || void 0,
            created_by: req.user?.id ?? void 0
          });
          createdExamId = exam.id;
        }
      } else if (imported.examAction === "link" && imported.linkExamId) {
        const { getMysqlDb: getMysqlDb2 } = await Promise.resolve().then(() => (init_db(), db_exports));
        const db3 = getMysqlDb2();
        await db3.run(
          "UPDATE exams SET card_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          newId,
          imported.linkExamId
        );
      }
      res.status(201).json({
        ...toCardSummary({ id: saved.id, title: saved.title, updatedAt: saved.updatedAt }),
        createdExamId,
        duplicateExamName: duplicateExamName || void 0,
        idConflictMsg: conflictMsg || void 0
      });
    } catch (error) {
      next(error);
    }
  });
  app.use("/api/exams", score_editing_default);
  app.get("/api/exams", async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const { grade_id, subject, academic_year, selection } = req.query;
      const visibleIds = await getVisibleExamIds(req.user);
      const scopeFilter = visibleIds !== null ? { examIds: visibleIds } : {};
      if (selection === "1") {
        if (visibleIds !== null && visibleIds.length === 0) {
          res.json([]);
          return;
        }
        const exams2 = await examRepo.listExamsForSelection({
          grade_id: grade_id ? Number(grade_id) : void 0,
          subject: subject || void 0,
          academic_year: academic_year || void 0,
          ...scopeFilter
        });
        res.json(exams2);
        return;
      }
      if (visibleIds !== null && visibleIds.length === 0) {
        res.json([]);
        return;
      }
      const exams = await examRepo.listExams({
        grade_id: grade_id ? Number(grade_id) : void 0,
        subject: subject || void 0,
        ...scopeFilter
      });
      res.json(exams);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/exams/filters", async (_req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      res.json({
        academicYears: await examRepo.getAcademicYears(),
        subjects: await examRepo.getSubjects()
      });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/exams", async (req, res, next) => {
    try {
      const { name, cardId, gradeId, classId, subject } = req.body;
      if (!name || !cardId) {
        res.status(400).json({ message: "\u7F3A\u5C11 name \u6216 cardId" });
        return;
      }
      const examRepo = new ExamRepository();
      const existing = await examRepo.findExamByName(String(name));
      if (existing) {
        res.status(409).json({ message: `\u5DF2\u5B58\u5728\u540C\u540D\u8003\u8BD5\u300C${name}\u300D\uFF08ID: ${existing.id}\uFF09\uFF0C\u8BF7\u4FEE\u6539\u540D\u79F0\u540E\u91CD\u8BD5` });
        return;
      }
      const exam = await examRepo.createExam({
        name: String(name),
        card_id: String(cardId),
        grade_id: gradeId ? Number(gradeId) : void 0,
        class_id: classId ? Number(classId) : void 0,
        subject: subject ? String(subject) : void 0,
        created_by: req.user?.id
      });
      res.status(201).json(exam);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/exams/:examId", requireExamAccess, async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const exam = await examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "\u8003\u8BD5\u4E0D\u5B58\u5728" });
        return;
      }
      const results = await examRepo.getExamResults(exam.id);
      res.json({ ...exam, results });
    } catch (error) {
      next(error);
    }
  });
  app.delete("/api/exams/:examId", requireExamAccess, async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const exam = await examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "\u8003\u8BD5\u4E0D\u5B58\u5728" });
        return;
      }
      const body = req.body ?? {};
      const deleteLinkedCard = requestFlag(body.deleteLinkedCard);
      const linkedCardId = exam.card_id ? safeId(exam.card_id) : null;
      const db3 = getMysqlDb();
      if (deleteLinkedCard && linkedCardId) {
        const referencedByOtherExams = (await examRepo.listExams()).filter((item) => item.card_id === linkedCardId && item.id !== exam.id);
        if (referencedByOtherExams.length > 0) {
          res.status(409).json({
            message: `\u65E0\u6CD5\u540C\u65F6\u5220\u9664\u7B54\u9898\u5361\uFF1A\u4ECD\u88AB ${referencedByOtherExams.length} \u4E2A\u5176\u5B83\u8003\u8BD5\u5F15\u7528`,
            referencedExamCount: referencedByOtherExams.length,
            referencedExamNames: referencedByOtherExams.map((item) => item.name)
          });
          return;
        }
      }
      await deleteExamRows(db3, [exam.id]);
      if (deleteLinkedCard && linkedCardId) {
        await cardRepo.deleteCard(linkedCardId);
      }
      if (deleteLinkedCard && linkedCardId) {
        await deleteCardFiles(linkedCardId);
      }
      res.json({ message: "\u5DF2\u5220\u9664", deletedLinkedCard: Boolean(deleteLinkedCard && linkedCardId) });
    } catch (error) {
      next(error);
    }
  });
  app.patch("/api/exams/:examId", requireExamAccess, async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const exam = await examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "\u8003\u8BD5\u4E0D\u5B58\u5728" });
        return;
      }
      const { cardId, name, subject } = req.body;
      const updates = { updated_at: (/* @__PURE__ */ new Date()).toISOString() };
      if (cardId !== void 0) updates.card_id = String(cardId);
      if (name !== void 0) updates.name = String(name);
      if (subject !== void 0) updates.subject = String(subject);
      const { getMysqlDb: getMysqlDb2 } = await Promise.resolve().then(() => (init_db(), db_exports));
      const db3 = getMysqlDb2();
      const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(updates);
      await db3.run(`UPDATE exams SET ${setClauses} WHERE id = ?`, ...values, exam.id);
      const updated = await examRepo.findExamById(exam.id);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/analysis/trends", async (req, res, next) => {
    try {
      const subject = typeof req.query.subject === "string" ? req.query.subject : "";
      const classId = req.query.classId ? Number(req.query.classId) : void 0;
      const analysisRepo = new AnalysisRepository();
      const trend = await analysisRepo.getScoreTrend(subject, classId);
      res.json(trend);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/analysis/cross-exam/groups", async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      res.json(await analysisRepo.listExamGroups(req.user?.id));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/analysis/cross-exam/groups", async (req, res, next) => {
    try {
      const { name, examIds, source, startDate, endDate } = req.body;
      const normalizedExamIds = numberArray(examIds);
      if (!name?.trim()) {
        res.status(400).json({ message: "\u8BF7\u8F93\u5165\u8003\u8BD5\u7EC4\u540D\u79F0" });
        return;
      }
      if (normalizedExamIds.length === 0) {
        res.status(400).json({ message: "\u8BF7\u9009\u62E9\u81F3\u5C11\u4E00\u573A\u8003\u8BD5" });
        return;
      }
      if (!await validateExamIdsAccess(req, res, normalizedExamIds)) return;
      const analysisRepo = new AnalysisRepository();
      const group = await analysisRepo.createExamGroup({
        name,
        examIds: normalizedExamIds,
        source: source === "week" ? "week" : "cross-manual",
        startDate,
        endDate,
        createdBy: req.user?.id ?? null
      });
      res.status(201).json(group);
    } catch (error) {
      next(error);
    }
  });
  app.delete("/api/analysis/cross-exam/groups/:groupId", async (req, res, next) => {
    try {
      const groupId = Number(req.params.groupId);
      if (!Number.isInteger(groupId) || groupId <= 0) {
        res.status(400).json({ message: "\u65E0\u6548\u7684\u8003\u8BD5\u7EC4 ID" });
        return;
      }
      const analysisRepo = new AnalysisRepository();
      const ok = await analysisRepo.deleteExamGroup(groupId, req.user?.id ?? 0, req.user?.role_name === "admin");
      if (!ok) {
        res.status(404).json({ message: "\u8003\u8BD5\u7EC4\u4E0D\u5B58\u5728\u6216\u65E0\u6743\u5220\u9664" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/analysis/cross-exam/total", async (req, res, next) => {
    try {
      const body = req.body;
      const mode = body.mode;
      if (mode !== "week" && mode !== "selected" && mode !== "group") {
        res.status(400).json({ message: "\u7EDF\u8BA1\u6A21\u5F0F\u65E0\u6548" });
        return;
      }
      const analysisRepo = new AnalysisRepository();
      let requestedExamIds = [];
      if (mode === "selected") {
        requestedExamIds = numberArray(body.examIds);
        if (requestedExamIds.length === 0) {
          res.status(400).json({ message: "\u8BF7\u9009\u62E9\u81F3\u5C11\u4E00\u573A\u8003\u8BD5" });
          return;
        }
      } else if (mode === "group") {
        const groupId = optionalPositiveNumber(body.groupId);
        if (!groupId) {
          res.status(400).json({ message: "\u8BF7\u9009\u62E9\u8003\u8BD5\u7EC4" });
          return;
        }
        const group = await analysisRepo.getExamGroup(groupId);
        if (!group) {
          res.status(404).json({ message: "\u8003\u8BD5\u7EC4\u4E0D\u5B58\u5728" });
          return;
        }
        requestedExamIds = group.examIds;
      }
      if (requestedExamIds.length > 0 && !await validateExamIdsAccess(req, res, requestedExamIds)) return;
      const data = await analysisRepo.getCrossExamTotal({
        mode,
        groupId: optionalPositiveNumber(body.groupId),
        examIds: requestedExamIds.length > 0 ? requestedExamIds : void 0,
        startDate: body.startDate,
        endDate: body.endDate,
        gradeId: optionalPositiveNumber(body.gradeId),
        classId: optionalPositiveNumber(body.classId),
        subject: typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : void 0,
        attendanceMode: body.attendanceMode === "full" ? "full" : "all"
      }, {
        visibleExamIds: await getVisibleExamIds(req.user)
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/analysis/exams/:examId/classes", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classes = await analysisRepo.getExamClasses(Number(req.params.examId));
      res.json(classes);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/analysis/exams/:examId/overview", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : void 0;
      const overview = await analysisRepo.getExamOverview(Number(req.params.examId), classId);
      res.json(overview);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/analysis/exams/:examId/students", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : void 0;
      const ranking = await analysisRepo.getStudentRanking(Number(req.params.examId), classId);
      res.json(ranking);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/analysis/exams/:examId/score-table", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : void 0;
      const displayMode = req.query.displayMode || "deviation";
      const data = await analysisRepo.getScoreTableData(
        Number(req.params.examId),
        classId,
        displayMode
      );
      res.json(data);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/analysis/exams/:examId/previous", requireExamAccess, async (_req, res, next) => {
    try {
      res.json({ message: "TODO: implement previous exam comparison" });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/users/me/settings", async (req, res, next) => {
    try {
      const db3 = getMysqlDb();
      const user = await db3.get(
        "SELECT score_display_mode, review_confidence_threshold, ai_api_key, background_opacity FROM users WHERE id = ?",
        req.user.id
      );
      res.json({
        scoreDisplayMode: user?.score_display_mode ?? "zscore",
        reviewConfidenceThreshold: user?.review_confidence_threshold ?? 0.12,
        aiApiKey: user?.ai_api_key ?? "",
        backgroundOpacity: user?.background_opacity ?? 0
      });
    } catch (error) {
      next(error);
    }
  });
  app.patch("/api/users/me/settings", async (req, res, next) => {
    try {
      const { scoreDisplayMode, reviewConfidenceThreshold, aiApiKey, backgroundOpacity } = req.body;
      const db3 = getMysqlDb();
      if (scoreDisplayMode && ["deviation", "zscore", "percentile"].includes(String(scoreDisplayMode))) {
        await db3.run(
          "UPDATE users SET score_display_mode = ? WHERE id = ?",
          String(scoreDisplayMode),
          req.user.id
        );
      }
      if (typeof reviewConfidenceThreshold === "number") {
        const t = Math.max(0, Math.min(1, reviewConfidenceThreshold));
        await db3.run(
          "UPDATE users SET review_confidence_threshold = ? WHERE id = ?",
          t,
          req.user.id
        );
      }
      if (aiApiKey !== void 0) {
        await db3.run(
          "UPDATE users SET ai_api_key = ? WHERE id = ?",
          typeof aiApiKey === "string" ? aiApiKey : null,
          req.user.id
        );
      }
      if (typeof backgroundOpacity === "number") {
        const o = Math.max(0, Math.min(1, backgroundOpacity));
        await db3.run(
          "UPDATE users SET background_opacity = ? WHERE id = ?",
          o,
          req.user.id
        );
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/analysis/exams/:examId/questions", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : void 0;
      const questions = await analysisRepo.getQuestionAnalysis(Number(req.params.examId), classId);
      res.json(questions);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/exams/:examId/assigned-formula", requireExamAccess, async (req, res, next) => {
    try {
      const service = new AssignedScoreService();
      const formula = service.getFormula(Number(req.params.examId));
      const presets = AssignedScoreService.getFormulaPresets();
      const exam = await new ExamRepository().findExamById(Number(req.params.examId));
      res.json({
        formula,
        isAssignedSubject: exam?.subject ? AssignedScoreService.isAssignedSubject(exam.subject) : false,
        presets
      });
    } catch (error) {
      next(error);
    }
  });
  app.put("/api/exams/:examId/assigned-formula", requireExamAccess, async (req, res, next) => {
    try {
      const { formula, recalculate } = req.body;
      const examId = Number(req.params.examId);
      const service = new AssignedScoreService();
      if (!formula || !formula.enabled) {
        service.disableFormula(examId);
        res.json({ ok: true, updated: 0 });
        return;
      }
      service.saveFormula(examId, formula);
      let result = { updated: 0, skipped: 0 };
      if (recalculate !== false) {
        result = service.recalculateAll(examId);
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/exams/:examId/recalculate-assigned", requireExamAccess, async (req, res, next) => {
    try {
      const service = new AssignedScoreService();
      const result = service.recalculateAll(Number(req.params.examId));
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/app/health", async (_req, res) => {
    const hc = await healthCheck();
    res.json({
      ok: hc.ok,
      variant: process.env.PROJECTX_VARIANT ?? null,
      scanner: process.env.PROJECTX_ENABLE_SCANNER === "1",
      db: { dialect: hc.dialect, latencyMs: hc.latencyMs, error: hc.error }
    });
  });
  const backgroundsDir = path14.join(dataDir, "backgrounds");
  app.get("/api/app/background", optionalAuth, (req, res) => {
    if (req.user) {
      const customBg = path14.join(backgroundsDir, `${req.user.id}.jpg`);
      if (existsSync11(customBg)) {
        res.setHeader("Cache-Control", "no-cache");
        res.sendFile(customBg);
        return;
      }
    }
    const bgPath = path14.join(rootDir2, "resources", "background.jpg");
    if (existsSync11(bgPath)) {
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.sendFile(bgPath);
    } else {
      res.status(404).json({ error: "background image not found" });
    }
  });
  const bgUpload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        await mkdir4(backgroundsDir, { recursive: true });
        cb(null, backgroundsDir);
      },
      filename: (_req, file, cb) => {
        const ext = path14.extname(file.originalname).toLowerCase() || ".jpg";
        cb(null, `upload_${Date.now()}${ext}`);
      }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith("image/")) {
        cb(null, true);
      } else {
        cb(new Error("\u4EC5\u652F\u6301\u56FE\u7247\u6587\u4EF6"));
      }
    }
  });
  app.post("/api/users/me/background", bgUpload.single("file"), async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "\u8BF7\u5148\u767B\u5F55" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "\u8BF7\u9009\u62E9\u56FE\u7247\u6587\u4EF6" });
        return;
      }
      const target = path14.join(backgroundsDir, `${req.user.id}.jpg`);
      await rename(req.file.path, target);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/analysis/ai/status", async (req, res) => {
    try {
      const response = await fetchLlmClient("/health", { method: "GET" }, 2500);
      const healthOk = response.ok;
      let llmStatus = {};
      if (healthOk) {
        llmStatus = await response.json();
      }
      const db3 = getMysqlDb();
      const providerRows = await db3.all(`
        SELECT id, name, provider_type, base_url, api_key, models, is_active
        FROM ai_providers
        WHERE user_id = ? AND is_active = 1
        ORDER BY sort_order, id
      `, req.user.id);
      const userProviders = providerRows.map((p) => ({
        id: p.id,
        name: p.name,
        providerType: p.provider_type,
        baseUrl: p.base_url,
        apiKey: p.api_key,
        models: p.models ? JSON.parse(p.models) : null,
        isActive: true
      }));
      const configuredModels = llmStatus.models ?? [];
      const hasAvailableModel = configuredModels.some((model) => model.available);
      const hasUserProvider = userProviders.length > 0;
      res.json({
        available: Boolean(healthOk && llmStatus.dbExists && hasAvailableModel || hasUserProvider),
        reason: !healthOk ? `LLM service returned ${response.status}` : !llmStatus.dbExists && !hasUserProvider ? "LLM service is running, but Project-X database was not found." : !hasAvailableModel && !hasUserProvider ? "LLM service is running, but no provider API key is configured." : void 0,
        defaultModel: llmStatus.defaultModel ?? (hasUserProvider ? "auto" : null),
        models: configuredModels,
        providers: userProviders
      });
    } catch (error) {
      try {
        const db3 = getMysqlDb();
        const providerRows = await db3.all(`
          SELECT id, name, provider_type, base_url, api_key, models, is_active
          FROM ai_providers
          WHERE user_id = ? AND is_active = 1
          ORDER BY sort_order, id
        `, req.user.id);
        const userProviders = providerRows.map((p) => ({
          id: p.id,
          name: p.name,
          providerType: p.provider_type,
          baseUrl: p.base_url,
          apiKey: p.api_key,
          models: p.models ? JSON.parse(p.models) : null,
          isActive: true
        }));
        res.json({
          available: userProviders.length > 0,
          reason: userProviders.length > 0 ? void 0 : "LLM service is not reachable and no local providers configured.",
          defaultModel: userProviders.length > 0 ? "auto" : null,
          models: [],
          providers: userProviders
        });
      } catch {
        res.json({
          available: false,
          reason: error instanceof Error ? error.message : "LLM service is not reachable.",
          defaultModel: null,
          models: [],
          providers: []
        });
      }
    }
  });
  app.post("/api/analysis/exams/:examId/ai-analysis", requireExamAccess, async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      if (!Number.isFinite(examId) || examId <= 0) {
        res.status(400).json({ message: "Invalid exam id" });
        return;
      }
      const analysisRepo = new AnalysisRepository();
      const exam = await analysisRepo.getExam(examId);
      if (!exam) {
        res.status(404).json({ message: "Exam not found" });
        return;
      }
      const classIdValue = req.body?.classId;
      const classId = classIdValue === void 0 || classIdValue === null || classIdValue === "" ? void 0 : Number(classIdValue);
      if (classId !== void 0 && !Number.isFinite(classId)) {
        res.status(400).json({ message: "Invalid class id" });
        return;
      }
      const providerId = req.body?.providerId ? Number(req.body.providerId) : void 0;
      let providerOverride;
      if (providerId && Number.isFinite(providerId)) {
        const db3 = getMysqlDb();
        const prov = await db3.get(
          "SELECT * FROM ai_providers WHERE id = ? AND user_id = ?",
          providerId,
          req.user.id
        );
        if (prov) {
          providerOverride = {
            provider_type: prov.provider_type,
            base_url: prov.base_url,
            api_key: prov.api_key
          };
        }
      }
      const response = await fetchLlmClient("/analysis/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examId,
          classId,
          model: typeof req.body?.model === "string" ? req.body.model : void 0,
          locale: "zh-CN",
          providerOverride: providerOverride ?? void 0
        })
      }, 12e4);
      if (!response.ok) {
        let message = `LLM service returned ${response.status}`;
        try {
          const body = await response.json();
          message = body.detail || body.message || message;
        } catch {
          const text = await response.text().catch(() => "");
          if (text) message = text;
        }
        if (message.includes("404") && providerOverride) {
          const urlHint = providerOverride.base_url ? ` (base_url: ${providerOverride.base_url})` : "";
          message = `\u81EA\u5B9A\u4E49\u670D\u52A1\u5546 API \u8FD4\u56DE 404${urlHint}\u3002\u8BF7\u68C0\u67E5 Base URL \u662F\u5426\u6B63\u786E \u2014 \u5B83\u5E94\u8BE5\u662F API \u7AEF\u70B9\u5730\u5740\uFF0C\u800C\u975E\u7F51\u7AD9\u9996\u9875\u3002\u786E\u4FDD Python llmclient \u5DF2\u542F\u52A8\u3002`;
        }
        res.status(response.status >= 400 && response.status < 500 ? response.status : 502).json({ message });
        return;
      }
      res.json(await response.json());
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        res.status(504).json({ message: "AI \u670D\u52A1\u8BF7\u6C42\u8D85\u65F6\u3002\u8BF7\u68C0\u67E5 llmclient \u662F\u5426\u6B63\u5E38\u8FD0\u884C\u3002" });
        return;
      }
      if (error instanceof Error && (error.message.includes("fetch") || error.message.includes("ECONNREFUSED"))) {
        res.status(503).json({ message: "\u65E0\u6CD5\u8FDE\u63A5\u5230 Python llmclient \u4E2D\u8F6C\u670D\u52A1\u3002\u8BF7\u5148\u542F\u52A8\uFF1Apy -m uvicorn llmclient.server:app --host 127.0.0.1 --port 8766" });
        return;
      }
      next(error);
    }
  });
  app.get("/api/analysis/exams/:examId/export-csv", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : void 0;
      const examId = Number(req.params.examId);
      const { students, questionHeaders } = await analysisRepo.getExportData(examId, classId);
      const header = ["\u73ED\u7EA7", "\u8003\u53F7", "\u59D3\u540D", "\u6210\u7EE9", "\u73ED\u7EA7\u6392\u540D", "\u5E74\u7EA7\u6392\u540D", "\u5BA2\u89C2\u9898", "\u4E3B\u89C2\u9898", ...questionHeaders];
      const data = students.map((s) => [
        s.className,
        s.studentNumber,
        s.name,
        s.totalScore,
        s.classRank,
        s.gradeRank,
        s.objectiveScore,
        s.subjectiveScore,
        ...s.questionScores
      ]);
      const XLSX4 = await import("xlsx");
      const ws = XLSX4.utils.aoa_to_sheet([header, ...data]);
      ws["!cols"] = [
        { wch: 10 },
        { wch: 12 },
        { wch: 10 },
        { wch: 8 },
        { wch: 10 },
        { wch: 10 },
        { wch: 12 },
        { wch: 12 }
      ];
      const wb = XLSX4.utils.book_new();
      XLSX4.utils.book_append_sheet(wb, ws, "\u6210\u7EE9\u8868");
      const buf = Buffer.from(XLSX4.write(wb, { type: "buffer", bookType: "xlsx" }));
      const exam = await analysisRepo.getExam(examId);
      const filename = `${exam?.name ?? "\u6210\u7EE9\u8868"}_${classId ? "\u73ED\u7EA7" : "\u5E74\u7EA7"}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
      res.send(buf);
    } catch (error) {
      next(error);
    }
  });
  if (scannerEnabled()) {
    app.use("/api/scanner", scannerGate, createScannerRouter());
  } else {
    app.use("/api/scanner", (_req, res) => {
      res.status(404).json({ message: "Scanner is disabled in this Project-X package." });
    });
  }
  const clientDist = process.env.ANSWER_CARD_CLIENT_DIST ? path14.resolve(process.env.ANSWER_CARD_CLIENT_DIST) : path14.join(rootDir2, "dist", "client");
  if (existsSync11(clientDist)) {
    app.use(
      express12.static(clientDist, {
        setHeaders: (res, filePath) => {
          const ext = path14.extname(filePath).toLowerCase();
          if (ext === ".html" || ext === ".js" || ext === ".mjs" || ext === ".css" || ext === ".json") {
            const type = res.getHeader("Content-Type");
            if (type && !type.toLowerCase().includes("charset")) {
              res.setHeader("Content-Type", `${type}; charset=utf-8`);
            }
          }
          if (ext === ".html" || ext === ".js" || ext === ".mjs" || ext === ".css") {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
          }
        }
      })
    );
    app.get("/{*splat}", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.sendFile(path14.join(clientDist, "index.html"));
    });
  }
  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ message: error instanceof Error ? error.message : "\u670D\u52A1\u5668\u9519\u8BEF" });
  });
  return app;
}
async function startServer(port = Number(process.env.PORT ?? 5174)) {
  const app = await createApp();
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      server.actualPort = actualPort;
      server.localUrl = `http://127.0.0.1:${actualPort}`;
      console.log(`Answer card designer API running at http://127.0.0.1:${actualPort}`);
      resolve(server);
    });
    server.listen(port, "127.0.0.1");
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL2(process.argv[1]).href) {
  await startServer();
}
export {
  createApp,
  startServer
};
