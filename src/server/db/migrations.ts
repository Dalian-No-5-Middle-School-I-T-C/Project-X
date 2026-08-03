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
  },
  {
    version: 11,
    name: "api-keys",
    up(db) {
      if (!hasTable(db, "api_keys")) {
        db.exec(`
          CREATE TABLE api_keys (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT NOT NULL,
            api_key      TEXT NOT NULL UNIQUE,
            scope        TEXT NOT NULL DEFAULT 'scanner',
            is_active    INTEGER DEFAULT 1,
            created_by   INTEGER REFERENCES users(id),
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);
      }
      // v1.6.0: 为 twain_scan_records 添加 uploaded 字段
      if (hasTable(db, "twain_scan_records") && !hasColumn(db, "twain_scan_records", "uploaded")) {
        db.exec("ALTER TABLE twain_scan_records ADD COLUMN uploaded INTEGER DEFAULT 0");
      }
    }
  },
  {
    // 性能优化：成绩分析高频查询复合索引 (CREATE INDEX IF NOT EXISTS 幂等)
    version: 12,
    name: "analysis-performance-indexes",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_student_scores_exam_total
          ON student_scores(exam_id, total_score);
        CREATE INDEX IF NOT EXISTS idx_student_scores_exam_assigned
          ON student_scores(exam_id, assigned_score);
        CREATE INDEX IF NOT EXISTS idx_student_scores_exam_student
          ON student_scores(exam_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_question_scores_exam_type
          ON question_scores(exam_id, score_type);
        CREATE INDEX IF NOT EXISTS idx_exams_grade_class
          ON exams(grade_id, class_id);
      `);
    }
  },
  {
    version: 13,
    name: "system-settings",
    up(db) {
      if (hasTable(db, "system_settings")) return;
      db.exec(`
        CREATE TABLE system_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      db.prepare("INSERT INTO system_settings (key, value) VALUES (?, ?)")
        .run("ladder_enabled", "1");
    }
  },
  {
    version: 14,
    name: "answer-block-crops",
    up(db) {
      if (!hasTable(db, "answer_block_crops")) {
        db.exec(`
          CREATE TABLE answer_block_crops (
            id               TEXT PRIMARY KEY,
            card_id          TEXT NOT NULL,
            exam_id          INTEGER REFERENCES exams(id) ON DELETE CASCADE,
            student_id       INTEGER REFERENCES users(id),
            student_number   TEXT,
            source_type      TEXT NOT NULL,
            source_record_id TEXT NOT NULL,
            block_id         TEXT NOT NULL,
            block_title      TEXT,
            block_type       TEXT NOT NULL,
            page_number      INTEGER NOT NULL,
            segment_index    INTEGER NOT NULL,
            question_numbers TEXT NOT NULL,
            rect_json        TEXT NOT NULL,
            image_path       TEXT NOT NULL,
            width_px         INTEGER NOT NULL,
            height_px        INTEGER NOT NULL,
            dpi              INTEGER NOT NULL,
            status           TEXT DEFAULT 'ready',
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(source_type, source_record_id, block_id, page_number, segment_index)
          );
        `);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_answer_block_crops_exam_student
          ON answer_block_crops(exam_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_answer_block_crops_source
          ON answer_block_crops(source_type, source_record_id);
        CREATE INDEX IF NOT EXISTS idx_answer_block_crops_block
          ON answer_block_crops(card_id, block_id);
      `);
    }
  },
  {
    version: 15,
    name: "exam-groups-source-fix",
    up(db) {
      // 修复：老数据库 exam_groups 表缺少 source 等列（migration v8 早期版本未包含这些列）
      if (hasTable(db, "exam_groups")) {
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
    }
  },
  {
    version: 16,
    name: "teacher-permissions",
    up(db) {
      if (!hasTable(db, "teacher_permissions")) {
        db.exec(`
          CREATE TABLE teacher_permissions (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            grade_id           INTEGER REFERENCES grades(id),
            can_view_scores    INTEGER DEFAULT 1,
            can_view_charts    INTEGER DEFAULT 1,
            can_view_students  INTEGER DEFAULT 1,
            created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(teacher_id, grade_id)
          );
          CREATE INDEX IF NOT EXISTS idx_tp_teacher ON teacher_permissions(teacher_id);
        `);
      }
    }
  },
  {
    version: 18,
    name: "system-ai-provider",
    up(db) {
      // ai_providers 新增 is_system 标记（v1.8.0 系统级 AI 配置）
      addColumnIfMissing(db, "ai_providers", "is_system", "INTEGER DEFAULT 0");
    }
  },
  {
    version: 19,
    name: "online-review-v2",
    up(db) {
      // 1. review_assignments — 阅卷任务分配
      if (!hasTable(db, "review_assignments")) {
        db.exec(`
          CREATE TABLE review_assignments (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id              INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
            block_id             TEXT NOT NULL,
            teacher_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            student_count        INTEGER DEFAULT 0,
            assigned_student_ids TEXT,
            created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(exam_id, block_id, teacher_id)
          );
          CREATE INDEX IF NOT EXISTS idx_ra_exam_block ON review_assignments(exam_id, block_id);
          CREATE INDEX IF NOT EXISTS idx_ra_teacher ON review_assignments(teacher_id);
        `);
      }

      // 2. review_sessions — 断点续批
      if (!hasTable(db, "review_sessions")) {
        db.exec(`
          CREATE TABLE review_sessions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
            block_id      TEXT NOT NULL,
            current_index INTEGER DEFAULT 0,
            position_json TEXT,
            draft_scores  TEXT,
            updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(teacher_id, exam_id, block_id)
          );
          CREATE INDEX IF NOT EXISTS idx_rs_teacher ON review_sessions(teacher_id);
        `);
      }

      // 3. review_annotations — 批注
      if (!hasTable(db, "review_annotations")) {
        db.exec(`
          CREATE TABLE review_annotations (
            id          TEXT PRIMARY KEY,
            crop_id     TEXT NOT NULL REFERENCES answer_block_crops(id) ON DELETE CASCADE,
            reviewer_id INTEGER NOT NULL REFERENCES users(id),
            type        TEXT NOT NULL CHECK(type IN ('text', 'drawing')),
            data_json   TEXT NOT NULL,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_rannot_crop ON review_annotations(crop_id);
        `);
      }

      // 4. block_grading_config — 逐题块网阅设置
      if (!hasTable(db, "block_grading_config")) {
        db.exec(`
          CREATE TABLE block_grading_config (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id            INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
            block_id           TEXT NOT NULL,
            dispute_threshold  REAL DEFAULT 2,
            rounding           TEXT DEFAULT 'ceil',
            arbitrator_id      INTEGER REFERENCES users(id),
            review_mode        INTEGER DEFAULT 1,
            created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(exam_id, block_id)
          );
          CREATE INDEX IF NOT EXISTS idx_bgc_exam ON block_grading_config(exam_id);
        `);
      }

      // 5. answer_block_crops — 加阅卷溯源字段
      addColumnIfMissing(db, "answer_block_crops", "reviewer_id",     "INTEGER REFERENCES users(id)");
      addColumnIfMissing(db, "answer_block_crops", "reviewed_at",     "DATETIME");
      addColumnIfMissing(db, "answer_block_crops", "review_round",    "INTEGER DEFAULT 1");
      addColumnIfMissing(db, "answer_block_crops", "final_score",     "REAL");
      addColumnIfMissing(db, "answer_block_crops", "final_score_by",  "INTEGER REFERENCES users(id)");
      addColumnIfMissing(db, "answer_block_crops", "score_breakdown", "TEXT");

      // 6. users — Tab 栏开关
      addColumnIfMissing(db, "users", "show_tab_bar", "INTEGER DEFAULT 0");

      // 7. exams — 阅卷模式
      addColumnIfMissing(db, "exams", "review_mode",    "INTEGER DEFAULT 1");
      addColumnIfMissing(db, "exams", "review_enabled", "INTEGER DEFAULT 0");
    }
  },
  {
    version: 20,
    name: "subjective-grid-json",
    up(db) {
      addColumnIfMissing(db, "subjective_questions", "line_grid_json", "TEXT");
      addColumnIfMissing(db, "subjective_questions", "essay_grid_json", "TEXT");
    }
  },
  {
    version: 21,
    name: "subjective-score-grid-json",
    up(db) {
      addColumnIfMissing(db, "subjective_questions", "score_grid_json", "TEXT");
    }
  },
  // v22: 性能复合索引对齐 — 幂等空操作 (SQLite v12 已创建,这里保持与 MariaDB v22 版本号一致)
  // 注: SQLite v17 被跳过是 PR133 合并时的有意设计 — v9 已等价覆盖 "original-paper-and-knowledge-points"
  {
    version: 22,
    name: "analysis-performance-indexes-parity",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_student_scores_exam_total
          ON student_scores(exam_id, total_score);
        CREATE INDEX IF NOT EXISTS idx_student_scores_exam_assigned
          ON student_scores(exam_id, assigned_score);
        CREATE INDEX IF NOT EXISTS idx_student_scores_exam_student
          ON student_scores(exam_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_question_scores_exam_type
          ON question_scores(exam_id, score_type);
        CREATE INDEX IF NOT EXISTS idx_exams_grade_class
          ON exams(grade_id, class_id);
      `);
    }
  },
  // v23 (origin/main, #184): 安全引导 + 扫描批次状态
  {
    version: 23,
    name: "security-bootstrap-and-grading-status",
    up(db) {
      addColumnIfMissing(db, "users", "password_change_required", "INTEGER DEFAULT 0");
      addColumnIfMissing(db, "scan_batches", "success_count", "INTEGER DEFAULT 0");
      addColumnIfMissing(db, "scan_batches", "failure_count", "INTEGER DEFAULT 0");
      addColumnIfMissing(db, "scan_batches", "error_summary", "TEXT");
    }
  },
  // v24 (v1.9.4 分支): 网阅打分与分配增强
  {
    version: 24,
    name: "online-review-grading-enhancements-1.9.4",
    up(db) {
      // 1. block_grading_config 新列
      addColumnIfMissing(db, "block_grading_config", "has_half_point", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "block_grading_config", "auto_reassign_no_arb", "INTEGER NOT NULL DEFAULT 1");
      addColumnIfMissing(db, "block_grading_config", "workload_balance_threshold", "INTEGER NOT NULL DEFAULT 4");

      // 2. review_assignments 新列
      addColumnIfMissing(db, "review_assignments", "auto_assigned", "INTEGER NOT NULL DEFAULT 0");

      // 3. system_settings 补齐 updated_at（与 MariaDB 表结构 parity）
      addColumnIfMissing(db, "system_settings", "updated_at", "TEXT");

      // 4. system_settings 默认键（可重复执行）
      const ensureSetting = db.prepare(
        "INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)"
      );
      const defaults: Array<[string, string]> = [
        ["allow_half_point", "1"],
        ["default_dispute_threshold", "2"],
        ["default_rounding", "ceil"],
        ["auto_reassign_policy", "1"],
        ["workload_balance_threshold", "4"],
      ];
      for (const [key, value] of defaults) {
        ensureSetting.run(key, value);
      }
    }
  },
  // v25 (v1.9.4 修复): 补齐 security-bootstrap(v23) 因迁移重编号被跳过而缺失的列
  // 背景：合并前 online-review-grading-enhancements 曾占用 v23 并已被记入 schema_migrations；
  // 合并后把它重编号为 v24、把 security-bootstrap 放到 v23，导致执行器按版本号判重而跳过了
  // v23，password_change_required 等列永久缺失，ensureDefaultAdmin() 启动即崩。本迁移幂等补回。
  {
    version: 25,
    name: "backfill-security-bootstrap-columns",
    up(db) {
      addColumnIfMissing(db, "users", "password_change_required", "INTEGER DEFAULT 0");
      addColumnIfMissing(db, "scan_batches", "success_count", "INTEGER DEFAULT 0");
      addColumnIfMissing(db, "scan_batches", "failure_count", "INTEGER DEFAULT 0");
      addColumnIfMissing(db, "scan_batches", "error_summary", "TEXT");
    }
  },
  // v26 (v1.9.4 设置重构): 原卷两开关提升为纯全局 + 清理误放全局的网阅死键
  // - users.require_original_paper / highlight_missing_paper 个人列标记废弃（保留数据，不再读取）；
  //   改由 system_settings 统一控制，管理员在全局设置页设定，全平台遵从。
  // - 清理 v1.9.4 误放在全局设置页的 5 个网阅键（后端从未消费），改归各考试「网阅设置」默认模板。
  {
    version: 26,
    name: "global-original-paper-and-cleanup-review-defaults",
    up(db) {
      const ensureSetting = db.prepare(
        "INSERT OR IGNORE INTO system_settings (`key`, value) VALUES (?, ?)"
      );
      ensureSetting.run("require_original_paper", "1");
      ensureSetting.run("highlight_missing_paper", "1");

      const dropDead = db.prepare(
        "DELETE FROM system_settings WHERE `key` IN (?, ?, ?, ?, ?)"
      );
      dropDead.run(
        "allow_half_point",
        "default_dispute_threshold",
        "default_rounding",
        "auto_reassign_policy",
        "workload_balance_threshold"
      );
    }
  },
  // v27 (1.9.5): 题块总分评分模式 — 新增评分模式与拆分策略字段
  {
    version: 27,
    name: "block-grading-scoring-mode",
    up(db) {
      addColumnIfMissing(db, "block_grading_config", "scoring_mode", "TEXT NOT NULL DEFAULT 'block_total'");
      addColumnIfMissing(db, "block_grading_config", "score_distribution", "TEXT NOT NULL DEFAULT 'proportional'");
    }
  },
  // v28 (1.9.6): 演示数据归属标记 — 给 users/answer_cards/classes/grades 增加 is_demo 列，
  // 使 clearDemoData() 不再依赖硬编码学号/用户名/班级名/答题卡 ID 判断，避免误删真实数据。
  {
    version: 28,
    name: "demo-data-source-flag",
    up(db) {
      addColumnIfMissing(db, "users", "is_demo", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "answer_cards", "is_demo", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "classes", "is_demo", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "grades", "is_demo", "INTEGER NOT NULL DEFAULT 0");
    }
  },
  // v29: 成绩分析增强 — question_scores 记录学生所选选项（JSON 数组），
  // 使逐题选项分析/跨班选项对比可用；同时写入成绩分析阈值全局默认配置。
  {
    version: 29,
    name: "selected-options-and-analysis-thresholds",
    up(db) {
      addColumnIfMissing(db, "question_scores", "selected_options", "TEXT");
      if (hasTable(db, "system_settings")) {
        const ensureSetting = db.prepare(
          "INSERT OR IGNORE INTO system_settings (`key`, value) VALUES (?, ?)"
        );
        ensureSetting.run("analysis_pass_rate", "0.6");
        ensureSetting.run("analysis_excellent_rate", "0.9");
        ensureSetting.run("analysis_segment_size", "10");
        ensureSetting.run("analysis_error_tiers", "70,50,30");
      }
    }
  },
  // v31 (Issue #177): 大考合集文理分科 —— 升 v31 以避让 main 已占用的 v30 (subjective-question-annotation)
  // - users.track：学生文/理属性（'arts' 文科 / 'science' 理科）
  // - exam_group_members.track_type：考试组内科目归属（common 共同 / arts 文科 / science 理科）
  {
    version: 31,
    name: "exam-group-arts-science-track",
    up(db) {
      addColumnIfMissing(db, "users", "track", "TEXT");
      addColumnIfMissing(db, "exam_group_members", "track_type", "TEXT NOT NULL DEFAULT 'common'");
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
