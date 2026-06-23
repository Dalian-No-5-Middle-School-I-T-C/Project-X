import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
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
  if (!cols.some((c) => c.name === "subject")) {
    db.exec("ALTER TABLE answer_cards ADD COLUMN subject TEXT");
    console.log("[DB] Migration: added subject column to answer_cards");
  }
  if (!cols.some((c) => c.name === "subject_label")) {
    db.exec("ALTER TABLE answer_cards ADD COLUMN subject_label TEXT");
    console.log("[DB] Migration: added subject_label column to answer_cards");
  }
  if (!cols.some((c) => c.name === "exam_date")) {
    db.exec("ALTER TABLE answer_cards ADD COLUMN exam_date TEXT");
    console.log("[DB] Migration: added exam_date column to answer_cards");
  }

  const examCols = db.prepare("PRAGMA table_info(exams)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
  const examCardCol = examCols.find((c) => c.name === "card_id");
  if (examCardCol?.notnull === 1) {
    db.exec(`
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
        retention_policy_id INTEGER REFERENCES data_retention_policies(id),
        created_by    INTEGER REFERENCES users(id),
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO exams_new (
        id, name, card_id, grade_id, class_id, subject, start_time, end_time,
        status, retention_policy_id, created_by, created_at, updated_at
      )
      SELECT
        id, name, card_id, grade_id, class_id, subject, start_time, end_time,
        status, retention_policy_id, created_by, created_at, updated_at
      FROM exams;
      DROP TABLE exams;
      ALTER TABLE exams_new RENAME TO exams;
      CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);
      CREATE INDEX IF NOT EXISTS idx_exams_grade ON exams(grade_id);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    console.log("[DB] Migration: made exams.card_id nullable");
  }

  const hasObjectiveQuestions = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='objective_questions'").get() as { cnt: number };
  if (hasObjectiveQuestions.cnt === 0) {
    db.exec(`
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
      CREATE INDEX idx_objective_questions_block ON objective_questions(block_id);
    `);
    console.log("[DB] Migration: created objective_questions table");
  }

  const objectiveBlockCols = db.prepare("PRAGMA table_info(objective_blocks)").all() as Array<{ name: string }>;
  if (!objectiveBlockCols.some((c) => c.name === "option_layout")) {
    db.exec("ALTER TABLE objective_blocks ADD COLUMN option_layout TEXT DEFAULT 'horizontal'");
    console.log("[DB] Migration: added option_layout column to objective_blocks");
  }

  const objectiveQuestionCols = db.prepare("PRAGMA table_info(objective_questions)").all() as Array<{ name: string }>;
  if (!objectiveQuestionCols.some((c) => c.name === "option_layout")) {
    db.exec("ALTER TABLE objective_questions ADD COLUMN option_layout TEXT");
    console.log("[DB] Migration: added option_layout column to objective_questions");
  }

  const subjectiveBlockCols = db.prepare("PRAGMA table_info(subjective_blocks)").all() as Array<{ name: string }>;
  if (!subjectiveBlockCols.some((c) => c.name === "block_kind")) {
    db.exec("ALTER TABLE subjective_blocks ADD COLUMN block_kind TEXT DEFAULT 'answer'");
    console.log("[DB] Migration: added block_kind column to subjective_blocks");
  }

  const subjectiveQuestionCols = db.prepare("PRAGMA table_info(subjective_questions)").all() as Array<{ name: string }>;
  if (!subjectiveQuestionCols.some((c) => c.name === "blanks_label_style")) {
    db.exec("ALTER TABLE subjective_questions ADD COLUMN blanks_label_style TEXT");
    console.log("[DB] Migration: added blanks_label_style column to subjective_questions");
  }
  if (!subjectiveQuestionCols.some((c) => c.name === "blanks_items_json")) {
    db.exec("ALTER TABLE subjective_questions ADD COLUMN blanks_items_json TEXT");
    console.log("[DB] Migration: added blanks_items_json column to subjective_questions");
  }

  // teacher_role migration
  const userColsTmp = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColsTmp.some((c) => c.name === "teacher_role")) {
    db.exec("ALTER TABLE users ADD COLUMN teacher_role TEXT DEFAULT NULL");
    console.log("[DB] Migration: added teacher_role column to users");
  }

  // v1.1.0 migrations: users + teacher_classes
  const userCols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === "subject")) {
    db.exec("ALTER TABLE users ADD COLUMN subject TEXT");
    console.log("[DB] Migration (v1.1): added subject column to users");
  }
  if (!userCols.some((c) => c.name === "initial_password")) {
    db.exec("ALTER TABLE users ADD COLUMN initial_password TEXT");
    console.log("[DB] Migration (v1.1): added initial_password column to users");
  }

  const hasTc = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='teacher_classes'").get() as { cnt: number };
  if (hasTc.cnt === 0) {
    db.exec(`
      CREATE TABLE teacher_classes (
        teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        subject     TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (teacher_id, class_id)
      );
      CREATE INDEX idx_teacher_classes_teacher ON teacher_classes(teacher_id);
      CREATE INDEX idx_teacher_classes_class ON teacher_classes(class_id);
    `);
    console.log("[DB] Migration (v1.1): created teacher_classes table");
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

  // v1.4.0 migrations: assigned_score, assigned_formula, score_display_mode, review threshold, export_templates
  const studentScoreCols = db.prepare("PRAGMA table_info(student_scores)").all() as Array<{ name: string }>;
  if (!studentScoreCols.some((c) => c.name === "assigned_score")) {
    db.exec("ALTER TABLE student_scores ADD COLUMN assigned_score REAL");
    console.log("[DB] Migration (v1.4): added assigned_score column to student_scores");
  }

  const examColsV2 = db.prepare("PRAGMA table_info(exams)").all() as Array<{ name: string }>;
  if (!examColsV2.some((c) => c.name === "assigned_formula")) {
    db.exec("ALTER TABLE exams ADD COLUMN assigned_formula TEXT");
    console.log("[DB] Migration (v1.4): added assigned_formula column to exams");
  }

  const userColsV2 = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColsV2.some((c) => c.name === "score_display_mode")) {
    db.exec("ALTER TABLE users ADD COLUMN score_display_mode TEXT DEFAULT 'deviation'");
    console.log("[DB] Migration (v1.4): added score_display_mode column to users");
  }
  if (!userColsV2.some((c) => c.name === "review_confidence_threshold")) {
    db.exec("ALTER TABLE users ADD COLUMN review_confidence_threshold REAL DEFAULT 0.12");
    console.log("[DB] Migration (v1.4): added review_confidence_threshold column to users");
  }
  if (!userColsV2.some((c) => c.name === "ai_api_key")) {
    db.exec("ALTER TABLE users ADD COLUMN ai_api_key TEXT");
    console.log("[DB] Migration (v1.4): added ai_api_key column to users");
  }

  const hasExportTemplates = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='export_templates'").get() as { cnt: number };
  if (hasExportTemplates.cnt === 0) {
    db.exec(`
      CREATE TABLE export_templates (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slot          INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 4),
        name          TEXT NOT NULL DEFAULT '未命名',
        columns       TEXT NOT NULL,
        side_table_n  INTEGER DEFAULT 0,
        gap_cols      INTEGER DEFAULT 3,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, slot)
      );
      CREATE INDEX idx_export_templates_user ON export_templates(user_id, slot);
    `);
    console.log("[DB] Migration (v1.4): created export_templates table");
  }

  // v1.4.0 多服务商：ai_providers 表
  const hasAiProviders = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='ai_providers'").get() as { cnt: number };
  if (hasAiProviders.cnt === 0) {
    db.exec(`
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
      CREATE INDEX idx_ai_providers_user ON ai_providers(user_id, provider_type);
    `);
    console.log("[DB] Migration (v1.4): created ai_providers table");
  }

  const hasExamGroups = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='exam_groups'").get() as { cnt: number };
  if (hasExamGroups.cnt === 0) {
    db.exec(`
      CREATE TABLE exam_groups (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        source        TEXT DEFAULT 'manual',
        start_date    TEXT,
        end_date      TEXT,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE exam_group_items (
        group_id      INTEGER NOT NULL REFERENCES exam_groups(id) ON DELETE CASCADE,
        exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        sort_order    INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, exam_id)
      );
      CREATE INDEX idx_exam_groups_user ON exam_groups(created_by, updated_at);
      CREATE INDEX idx_exam_group_items_exam ON exam_group_items(exam_id);
    `);
    console.log("[DB] Migration: created exam_groups tables");
  }

  // v1.4.1 migrations: grade modification tracking (2026-06-19)
  // Add manual modification columns to student_scores
  const ssCols = db.prepare("PRAGMA table_info(student_scores)").all() as Array<{ name: string }>;
  if (!ssCols.some((c) => c.name === "manually_modified")) {
    db.exec("ALTER TABLE student_scores ADD COLUMN manually_modified INTEGER DEFAULT 0");
    console.log("[DB] Migration (v1.4.1): added manually_modified to student_scores");
  }
  if (!ssCols.some((c) => c.name === "modified_by")) {
    db.exec("ALTER TABLE student_scores ADD COLUMN modified_by INTEGER REFERENCES users(id)");
  }
  if (!ssCols.some((c) => c.name === "modified_at")) {
    db.exec("ALTER TABLE student_scores ADD COLUMN modified_at DATETIME");
  }

  // Add manual modification columns to question_scores
  const qsCols = db.prepare("PRAGMA table_info(question_scores)").all() as Array<{ name: string }>;
  if (!qsCols.some((c) => c.name === "manually_modified")) {
    db.exec("ALTER TABLE question_scores ADD COLUMN manually_modified INTEGER DEFAULT 0");
    console.log("[DB] Migration (v1.4.1): added manually_modified to question_scores");
  }
  if (!qsCols.some((c) => c.name === "modified_by")) {
    db.exec("ALTER TABLE question_scores ADD COLUMN modified_by INTEGER REFERENCES users(id)");
  }
  if (!qsCols.some((c) => c.name === "modified_at")) {
    db.exec("ALTER TABLE question_scores ADD COLUMN modified_at DATETIME");
  }

  // answer_overrides table tracks all manual grade/answer changes
  const hasAnswerOverrides = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='answer_overrides'"
  ).get() as { cnt: number };
  if (hasAnswerOverrides.cnt === 0) {
    db.exec(`
      CREATE TABLE answer_overrides (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        card_id         TEXT NOT NULL,
        question_number INTEGER,
        question_id     TEXT,
        block_id        TEXT,
        score_type      TEXT NOT NULL,           -- objective / subjective
        override_type   TEXT NOT NULL,           -- score / answer
        old_value       TEXT,                    -- JSON
        new_value       TEXT,                    -- JSON
        created_by      INTEGER REFERENCES users(id),
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_answer_overrides_exam ON answer_overrides(exam_id);
    `);
    console.log("[DB] Migration (v1.4.1): created answer_overrides table");
  }

  // v1.5.0 migrations: background_opacity column on users (replaces show_background)
  const userColsV3 = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColsV3.some((c) => c.name === "background_opacity")) {
    // If old show_background column exists, migrate its value
    if (userColsV3.some((c) => c.name === "show_background")) {
      db.exec("ALTER TABLE users ADD COLUMN background_opacity REAL DEFAULT 0");
      db.exec("UPDATE users SET background_opacity = CASE WHEN show_background = 1 THEN 0.12 ELSE 0 END");
      console.log("[DB] Migration (v1.5): added background_opacity column (migrated from show_background)");
    } else {
      db.exec("ALTER TABLE users ADD COLUMN background_opacity REAL DEFAULT 0");
      console.log("[DB] Migration (v1.5): added background_opacity column to users");
    }
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
