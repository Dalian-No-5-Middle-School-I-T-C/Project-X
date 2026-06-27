import type Database from "better-sqlite3";

type ColumnInfo = { name: string; notnull?: number; dflt_value?: unknown };
type Migration = {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
};

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  ).get(tableName);
  return Boolean(row);
}

function tableColumns(db: Database.Database, tableName: string): ColumnInfo[] {
  if (!hasTable(db, tableName)) return [];
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnInfo[];
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  return tableColumns(db, tableName).some((column) => column.name === columnName);
}

function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  definition: string
): void {
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function createObjectiveQuestionsIfMissing(db: Database.Database): void {
  if (hasTable(db, "objective_questions")) return;
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
    CREATE INDEX IF NOT EXISTS idx_objective_questions_block ON objective_questions(block_id);
  `);
}

function makeExamCardIdNullable(db: Database.Database): void {
  const examColumns = tableColumns(db, "exams");
  const examCardCol = examColumns.find((column) => column.name === "card_id");
  if (!examCardCol || examCardCol.notnull !== 1) return;
  const hasAssignedFormula = examColumns.some((column) => column.name === "assigned_formula");
  const assignedFormulaSelect = hasAssignedFormula ? "assigned_formula" : "NULL";

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

function createTeacherClassesIfMissing(db: Database.Database): void {
  if (hasTable(db, "teacher_classes")) return;
  db.exec(`
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

function createExportTemplatesIfMissing(db: Database.Database): void {
  if (hasTable(db, "export_templates")) return;
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
    CREATE INDEX IF NOT EXISTS idx_export_templates_user ON export_templates(user_id, slot);
  `);
}

function createAiProvidersIfMissing(db: Database.Database): void {
  if (hasTable(db, "ai_providers")) return;
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
    CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id, provider_type);
  `);
}


function createAnswerOverridesIfMissing(db: Database.Database): void {
  if (hasTable(db, "answer_overrides")) return;
  db.exec(`
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

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "answer-card-metadata",
    up(db) {
      addColumnIfMissing(db, "answer_cards", "sided", "TEXT DEFAULT 'double'");
      addColumnIfMissing(db, "answer_cards", "subject", "TEXT");
      addColumnIfMissing(db, "answer_cards", "subject_label", "TEXT");
      addColumnIfMissing(db, "answer_cards", "exam_date", "TEXT");
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
    up(db) {
      createObjectiveQuestionsIfMissing(db);
      addColumnIfMissing(db, "objective_blocks", "option_layout", "TEXT DEFAULT 'horizontal'");
      addColumnIfMissing(db, "objective_questions", "option_layout", "TEXT");
      addColumnIfMissing(db, "subjective_blocks", "block_kind", "TEXT DEFAULT 'answer'");
      addColumnIfMissing(db, "subjective_questions", "blanks_label_style", "TEXT");
      addColumnIfMissing(db, "subjective_questions", "blanks_items_json", "TEXT");
    }
  },
  {
    version: 4,
    name: "teacher-classes",
    up(db) {
      addColumnIfMissing(db, "users", "teacher_role", "TEXT DEFAULT NULL");
      addColumnIfMissing(db, "users", "subject", "TEXT");
      addColumnIfMissing(db, "users", "initial_password", "TEXT");
      createTeacherClassesIfMissing(db);
    }
  },
  {
    version: 5,
    name: "assigned-score-and-ai",
    up(db) {
      addColumnIfMissing(db, "student_scores", "assigned_score", "REAL");
      addColumnIfMissing(db, "exams", "assigned_formula", "TEXT");
      addColumnIfMissing(db, "users", "score_display_mode", "TEXT DEFAULT 'zscore'");
      addColumnIfMissing(db, "users", "review_confidence_threshold", "REAL DEFAULT 0.12");
      addColumnIfMissing(db, "users", "ai_api_key", "TEXT");
      createExportTemplatesIfMissing(db);
      createAiProvidersIfMissing(db);
    }
  },
  {
    version: 6,
    name: "score-editing-audit",
    up(db) {
      addColumnIfMissing(db, "student_scores", "manually_modified", "INTEGER DEFAULT 0");
      addColumnIfMissing(db, "student_scores", "modified_by", "INTEGER REFERENCES users(id)");
      addColumnIfMissing(db, "student_scores", "modified_at", "DATETIME");
      addColumnIfMissing(db, "question_scores", "manually_modified", "INTEGER DEFAULT 0");
      addColumnIfMissing(db, "question_scores", "modified_by", "INTEGER REFERENCES users(id)");
      addColumnIfMissing(db, "question_scores", "modified_at", "DATETIME");
      createAnswerOverridesIfMissing(db);
    }
  },
  {
    version: 7,
    name: "background-opacity",
    up(db) {
      if (hasColumn(db, "users", "background_opacity")) return;
      db.exec("ALTER TABLE users ADD COLUMN background_opacity REAL DEFAULT 0");
      if (hasColumn(db, "users", "show_background")) {
        db.exec("UPDATE users SET background_opacity = CASE WHEN show_background = 1 THEN 0.12 ELSE 0 END");
      }
    }
  },
  {
    version: 8,
    name: "exam-groups",
    up(db) {
      if (!hasTable(db, "exam_groups")) {
        db.exec(`
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
        // Ensure all columns exist (compat with main's simpler version)
        addColumnIfMissing(db, "exam_groups", "description", "TEXT");
        addColumnIfMissing(db, "exam_groups", "source", "TEXT DEFAULT 'manual'");
        addColumnIfMissing(db, "exam_groups", "start_date", "TEXT");
        addColumnIfMissing(db, "exam_groups", "end_date", "TEXT");
        addColumnIfMissing(db, "exam_groups", "grade_id", "INTEGER REFERENCES grades(id)");
        addColumnIfMissing(db, "exam_groups", "tag", "TEXT");
        addColumnIfMissing(db, "exam_groups", "status", "TEXT DEFAULT 'active'");
        addColumnIfMissing(db, "exam_groups", "is_official", "INTEGER DEFAULT 0");
        addColumnIfMissing(db, "exam_groups", "total_score_mode", "TEXT DEFAULT 'raw'");
        addColumnIfMissing(db, "exam_groups", "only_full_participants", "INTEGER DEFAULT 0");
      }
      if (!hasTable(db, "exam_group_members")) {
        db.exec(`
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
    up(db) {
      // answer_cards 新增原卷相关列
      addColumnIfMissing(db, "answer_cards", "has_original_paper", "INTEGER DEFAULT 0");
      addColumnIfMissing(db, "answer_cards", "original_paper_filename", "TEXT");
      addColumnIfMissing(db, "answer_cards", "original_paper_path", "TEXT");
      addColumnIfMissing(db, "answer_cards", "question_range", "TEXT");
      addColumnIfMissing(db, "answer_cards", "extra_notes", "TEXT");
      addColumnIfMissing(db, "answer_cards", "knowledge_points_text", "TEXT");

      // users 新增教师个人设置
      addColumnIfMissing(db, "users", "require_original_paper", "INTEGER DEFAULT 1");
      addColumnIfMissing(db, "users", "highlight_missing_paper", "INTEGER DEFAULT 1");

      // 新建知识点字典表（与成绩联动）
      if (!hasTable(db, "knowledge_points")) {
        db.exec(`
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
    up(db) {
      if (!hasTable(db, "twain_scan_sessions")) {
        db.exec(`
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
      // Migrate old scanner.db data if it exists (one-time)
      // Handled separately by migrate-to-mariadb.ts
    }
  }
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>)
      .map((row) => row.version)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    migration.up(db);
    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(migration.version, migration.name);
    console.log(`[DB] Migration ${migration.version}: ${migration.name}`);
  }
}
