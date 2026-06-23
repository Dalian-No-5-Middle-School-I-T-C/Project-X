-- ============================================================
-- Project-X SQLite 数据库完整建表 SQL
-- 保留期：30天（扫描原始数据）
-- 数据库配置建议：
--   PRAGMA journal_mode = WAL;
--   PRAGMA foreign_keys = ON;
--   PRAGMA synchronous = NORMAL;
-- ============================================================

-- ============================================================
-- 模块一：用户与权限
-- ============================================================

-- 角色表
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS roles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,       -- admin / teacher / student
    display_name TEXT NOT NULL,              -- 管理员 / 教师 / 学生
    permissions  TEXT,                       -- JSON 权限列表
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 用户表（管理员 + 教师 + 学生统一存储）
CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    username         TEXT NOT NULL UNIQUE,   -- 登录账号（学生=P+学号，教师=T+6位随机数）
    password_hash    TEXT NOT NULL,           -- bcrypt 哈希
    name             TEXT NOT NULL,           -- 真实姓名
    role_id          INTEGER NOT NULL REFERENCES roles(id),
    student_number   TEXT UNIQUE,            -- 学号/考号（仅学生有）
    subject          TEXT,                    -- 任教科目（仅教师）
    initial_password TEXT,                    -- 初始明文密码（导出账密用）
    score_display_mode TEXT DEFAULT 'zscore',  -- deviation / zscore / percentile (v1.4.0)
    review_confidence_threshold REAL DEFAULT 0.12, -- 复核置信度阈值 (v1.4.0)
    ai_api_key       TEXT,                    -- AI API密钥 (v1.4.0)
    background_opacity REAL DEFAULT 0,          -- 背景图透明度 0~1, 0=关闭 (v1.5.0)
    email            TEXT,
    phone            TEXT,
    teacher_role     TEXT,                    -- subject_teacher / head_teacher / grade_leader（仅教师）
    is_active        INTEGER DEFAULT 1,      -- 0=禁用 1=启用
    last_login_at    DATETIME,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 年级表
CREATE TABLE IF NOT EXISTS grades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,              -- 高一 / 高二 / 高三
    sort_order   INTEGER DEFAULT 0,         -- 排序
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 班级表
CREATE TABLE IF NOT EXISTS classes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    grade_id     INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,              -- 1班 / 2班
    sort_order   INTEGER DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 班级-学生关联
CREATE TABLE IF NOT EXISTS class_students (
    class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (class_id, student_id)
);

-- 教师-班级关联（任教关系）
CREATE TABLE IF NOT EXISTS teacher_classes (
    teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    subject     TEXT,                                    -- 可选：该教师在此班级的科目覆盖
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (teacher_id, class_id)
);

-- ============================================================
-- 模块二：答题卡设计
-- ============================================================

-- 答题卡主表
CREATE TABLE IF NOT EXISTS answer_cards (
    id               TEXT PRIMARY KEY,                    -- 与现有 JSON 一致，8位数字字符串
    title            TEXT NOT NULL,
    subject          TEXT,                                -- 科目拼音 key，如 wuli/shuxue/yingyu
    subject_label    TEXT,                                -- 科目中文名，如 物理/数字/英语
    exam_date        TEXT,                                -- 考试日期 ISO 格式 YYYY-MM-DD（可选）
    paper_size       TEXT DEFAULT 'A4',
    orientation      TEXT DEFAULT 'portrait',
    student_fields   TEXT,                                -- JSON: ["姓名","班级"]
    student_number_digits INTEGER DEFAULT 5,
    sided           TEXT DEFAULT 'single',              -- single / double
    layout_version   INTEGER DEFAULT 1,
    layout_data      TEXT,                                -- Deprecated: legacy cached LayoutDocument; generated from card tables on demand
    created_by       INTEGER REFERENCES users(id),
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 客观题块
CREATE TABLE IF NOT EXISTS objective_blocks (
    id               TEXT PRIMARY KEY,
    card_id          TEXT NOT NULL REFERENCES answer_cards(id) ON DELETE CASCADE,
    sort_order       INTEGER DEFAULT 0,
    title            TEXT,
    question_start   INTEGER NOT NULL,
    question_count   INTEGER NOT NULL,
    option_count     INTEGER NOT NULL,
    mode             TEXT NOT NULL,                -- single / multiple / indeterminate
    score_per_question REAL NOT NULL,
    density          TEXT DEFAULT 'compact',       -- loose / normal / compact / dense
    option_layout    TEXT DEFAULT 'horizontal',    -- horizontal / vertical
    wrong_or_extra_score REAL DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 客观题标准答案
CREATE TABLE IF NOT EXISTS objective_answer_keys (
    block_id        TEXT NOT NULL REFERENCES objective_blocks(id) ON DELETE CASCADE,
    question_number  INTEGER NOT NULL,
    correct_options  TEXT NOT NULL,              -- JSON: ["A","B"]
    PRIMARY KEY (block_id, question_number)
);

CREATE TABLE IF NOT EXISTS objective_questions (
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

-- 多选题部分得分规则
CREATE TABLE IF NOT EXISTS objective_multiple_scoring (
    block_id       TEXT NOT NULL REFERENCES objective_blocks(id) ON DELETE CASCADE,
    correct_count   INTEGER NOT NULL,             -- 答对几题
    score           REAL NOT NULL,
    PRIMARY KEY (block_id, correct_count)
);

-- 主观题块
CREATE TABLE IF NOT EXISTS subjective_blocks (
    id          TEXT PRIMARY KEY,
    card_id     TEXT NOT NULL REFERENCES answer_cards(id) ON DELETE CASCADE,
    sort_order  INTEGER DEFAULT 0,
    block_kind  TEXT DEFAULT 'answer',           -- fill_blank / answer
    title       TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 主观题详情
CREATE TABLE IF NOT EXISTS subjective_questions (
    id               TEXT PRIMARY KEY,
    block_id         TEXT NOT NULL REFERENCES subjective_blocks(id) ON DELETE CASCADE,
    number           INTEGER NOT NULL,
    score            REAL NOT NULL,
    style            TEXT NOT NULL,              -- manual_score_grid / plain_box
    kind             TEXT NOT NULL,              -- plain_box / lined_answer / blank
    min_height_mm    REAL DEFAULT 68,
    line_grid_enabled INTEGER DEFAULT 0,
    line_spacing_mm  REAL DEFAULT 8,
    blanks_count     INTEGER,
    blanks_width_mm  REAL,
    blanks_height_mm REAL,
    blanks_label_style TEXT,
    blanks_items_json TEXT,
    sort_order       INTEGER DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 主观题图片
CREATE TABLE IF NOT EXISTS subjective_question_images (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id    TEXT NOT NULL REFERENCES subjective_questions(id) ON DELETE CASCADE,
    asset_id       TEXT NOT NULL,
    original_name  TEXT,
    width_mm       REAL,
    height_mm      REAL,
    align          TEXT DEFAULT 'left',         -- left / center / right
    sort_order     INTEGER DEFAULT 0
);

-- 答题卡资源文件
CREATE TABLE IF NOT EXISTS card_assets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id         TEXT NOT NULL REFERENCES answer_cards(id) ON DELETE CASCADE,
    asset_id        TEXT NOT NULL,
    original_name   TEXT,
    file_path       TEXT NOT NULL,
    file_size       INTEGER,
    mime_type       TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 模块三：考试与扫描
-- ============================================================

-- 数据保留策略
CREATE TABLE IF NOT EXISTS data_retention_policies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,              -- 周测 / 月考 / 期中期末
    retain_days     INTEGER DEFAULT 30,        -- 保留天数，0=永久保留
    auto_archive    INTEGER DEFAULT 1,         -- 到期是否自动归档
    auto_delete     INTEGER DEFAULT 0,         -- 到期是否自动删除（危险）
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 考试表
CREATE TABLE IF NOT EXISTS exams (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,                -- 2026上学期期中考试
    card_id       TEXT REFERENCES answer_cards(id),
    grade_id      INTEGER REFERENCES grades(id),
    class_id      INTEGER REFERENCES classes(id),
    subject       TEXT,                        -- 物理 / 数学
    start_time    DATETIME,
    end_time      DATETIME,
    status        TEXT DEFAULT 'draft',        -- draft / active / grading / closed
    assigned_formula TEXT,                     -- JSON: 赋分公式配置 (v1.4.0)
    retention_policy_id INTEGER REFERENCES data_retention_policies(id),
    created_by    INTEGER REFERENCES users(id),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 考试归档记录
CREATE TABLE IF NOT EXISTS exam_archives (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id        INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    archived_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    archive_path   TEXT,                      -- 归档文件路径（导出为压缩包）
    scan_count     INTEGER,                    -- 归档时扫描数量
    data_size_mb   REAL,                      -- 数据大小(MB)
    is_deleted     INTEGER DEFAULT 0,          -- 归档后是否已从主库删除
    deleted_at     DATETIME
);

-- 扫描批次
CREATE TABLE IF NOT EXISTS scan_batches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    name        TEXT,                         -- 高一1班第一次扫描
    status      TEXT DEFAULT 'pending',       -- pending / processing / done / error
    file_count  INTEGER DEFAULT 0,
    created_by  INTEGER REFERENCES users(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
);

-- 单张扫描记录
CREATE TABLE IF NOT EXISTS scan_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id       INTEGER NOT NULL REFERENCES scan_batches(id) ON DELETE CASCADE,
    file_path      TEXT,                      -- 原始图片路径
    file_name      TEXT,                      -- 原始文件名
    student_number TEXT,                      -- 识别出的学号
    student_id     INTEGER REFERENCES users(id),
    status         TEXT DEFAULT 'pending',    -- pending / recognized / graded / error
    recognized_at  DATETIME,
    graded_at      DATETIME,
    error_msg      TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- 30天保留期字段
    expires_at     DATETIME                   -- 超过此日期可被清理
);

-- 客观题识别结果
CREATE TABLE IF NOT EXISTS objective_recognitions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id       INTEGER NOT NULL REFERENCES scan_records(id) ON DELETE CASCADE,
    block_id        TEXT NOT NULL,
    question_number INTEGER NOT NULL,
    selected_options TEXT,                    -- JSON: ["A","C"]
    confidence      REAL,                     -- 识别置信度
    raw_data        TEXT,                     -- 原始识别数据
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at      DATETIME                  -- 超过此日期可被清理
);

-- 客观题自动评分
CREATE TABLE IF NOT EXISTS objective_grades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id       INTEGER NOT NULL REFERENCES scan_records(id) ON DELETE CASCADE,
    question_number INTEGER NOT NULL,
    block_id        TEXT NOT NULL,
    score           REAL,
    max_score       REAL,
    is_correct      INTEGER,                  -- 0=错 1=对
    graded_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 主观题评分（预留）
CREATE TABLE IF NOT EXISTS subjective_grades (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id      INTEGER NOT NULL REFERENCES scan_records(id) ON DELETE CASCADE,
    question_id    TEXT NOT NULL,
    score          REAL,
    graded_by      INTEGER REFERENCES users(id),
    graded_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    comment        TEXT
);

-- ============================================================
-- 模块四：成绩统计
-- ============================================================

-- 学生总分
CREATE TABLE IF NOT EXISTS student_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    student_id      INTEGER NOT NULL REFERENCES users(id),
    objective_score REAL DEFAULT 0,
    subjective_score REAL DEFAULT 0,
    total_score     REAL,
    assigned_score  REAL,                     -- 赋分（v1.4.0）
    rank            INTEGER,                  -- 排名
    percentile      REAL,                    -- 百分位
    graded_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    manually_modified INTEGER DEFAULT 0,       -- v1.4.1: 手动改分标记
    modified_by     INTEGER REFERENCES users(id), -- v1.4.1
    modified_at     DATETIME,                   -- v1.4.1
    UNIQUE(exam_id, student_id)
);

-- 各题得分明细
CREATE TABLE IF NOT EXISTS question_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    student_id      INTEGER NOT NULL REFERENCES users(id),
    question_number INTEGER,
    question_id     TEXT,
    block_id        TEXT,
    score           REAL,
    max_score       REAL,
    score_type      TEXT,                    -- objective / subjective
    manually_modified INTEGER DEFAULT 0,       -- v1.4.1: 手动改分标记
    modified_by     INTEGER REFERENCES users(id), -- v1.4.1
    modified_at     DATETIME,                   -- v1.4.1
    UNIQUE(exam_id, student_id, question_number, score_type)
);

-- 成绩手动修改记录（v1.4.1）
CREATE TABLE IF NOT EXISTS answer_overrides (
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

-- ============================================================
-- 模块五：导出模板（v1.4.0）
-- ============================================================

CREATE TABLE IF NOT EXISTS export_templates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot          INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 4),
    name          TEXT NOT NULL DEFAULT '未命名',
    columns       TEXT NOT NULL,             -- JSON: 列ID数组，含顺序
    side_table_n  INTEGER DEFAULT 0,         -- 0=不附加侧表, N=前N名
    gap_cols      INTEGER DEFAULT 3,         -- 主表与侧表间隙列数
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_export_templates_user ON export_templates(user_id, slot);

-- ============================================================
-- 模块六：大考组（v1.4.8）
-- ============================================================

-- 大考组（考试合集，如"2026高考摸底大考"包含语数英物化生）
CREATE TABLE IF NOT EXISTS exam_groups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,                    -- "2026高考摸底大考"
    description     TEXT,                             -- 可选描述
    grade_id        INTEGER REFERENCES grades(id),   -- 年级
    tag             TEXT,                             -- 标签：月考/期中/期末/模考/统考
    status          TEXT DEFAULT 'active',            -- active / archived
    is_official     INTEGER DEFAULT 0,                -- 是否官方统考
    total_score_mode TEXT DEFAULT 'raw',              -- raw / assigned（总分按原始分还是赋分算）
    only_full_participants INTEGER DEFAULT 0,        -- 仅统计全科参加的学生
    created_by      INTEGER REFERENCES users(id),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 大考组成员考试关联
CREATE TABLE IF NOT EXISTS exam_group_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id        INTEGER NOT NULL REFERENCES exam_groups(id) ON DELETE CASCADE,
    exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    sort_order      INTEGER DEFAULT 0,               -- 排序（语数英物化生等）
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, exam_id)
);
CREATE INDEX IF NOT EXISTS idx_exam_group_members_group ON exam_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_exam_group_members_exam ON exam_group_members(exam_id);

-- ============================================================
-- AI 服务商配置（v1.4.0 多服务商扩展）
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_providers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,              -- 用户命名，如 "我的GPT" / "Gemini 学生"
    provider_type   TEXT NOT NULL,              -- openai / deepseek / gemini
    base_url        TEXT NOT NULL DEFAULT '',   -- API 基础地址 (Gemini 留空)
    api_key         TEXT NOT NULL,              -- API Key
    models          TEXT,                       -- JSON 模型列表，空=自动获取
    is_active       INTEGER DEFAULT 1,
    sort_order      INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id, provider_type);

CREATE INDEX IF NOT EXISTS idx_users_student_number ON users(student_number);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_class_students_student ON class_students(student_id);
CREATE INDEX IF NOT EXISTS idx_class_students_class ON class_students(class_id);
CREATE INDEX IF NOT EXISTS idx_teacher_classes_teacher ON teacher_classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_classes_class ON teacher_classes(class_id);
CREATE INDEX IF NOT EXISTS idx_answer_cards_created_by ON answer_cards(created_by);
CREATE INDEX IF NOT EXISTS idx_answer_cards_updated_at ON answer_cards(updated_at);
CREATE INDEX IF NOT EXISTS idx_objective_blocks_card ON objective_blocks(card_id);
CREATE INDEX IF NOT EXISTS idx_objective_questions_block ON objective_questions(block_id);
CREATE INDEX IF NOT EXISTS idx_subjective_blocks_card ON subjective_blocks(card_id);
CREATE INDEX IF NOT EXISTS idx_subjective_questions_block ON subjective_questions(block_id);
CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_grade ON exams(grade_id);
CREATE INDEX IF NOT EXISTS idx_scan_records_batch ON scan_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_scan_records_student ON scan_records(student_id);
CREATE INDEX IF NOT EXISTS idx_scan_records_expires ON scan_records(expires_at);
CREATE INDEX IF NOT EXISTS idx_objective_recognitions_record ON objective_recognitions(record_id);
CREATE INDEX IF NOT EXISTS idx_objective_recognitions_expires ON objective_recognitions(expires_at);
CREATE INDEX IF NOT EXISTS idx_objective_grades_record ON objective_grades(record_id);
CREATE INDEX IF NOT EXISTS idx_subjective_grades_record ON subjective_grades(record_id);
CREATE INDEX IF NOT EXISTS idx_student_scores_exam ON student_scores(exam_id);
CREATE INDEX IF NOT EXISTS idx_student_scores_student ON student_scores(student_id);
CREATE INDEX IF NOT EXISTS idx_question_scores_exam_student ON question_scores(exam_id, student_id);

-- ============================================================
-- 初始数据
-- ============================================================

-- 插入默认角色
INSERT OR IGNORE INTO roles (id, name, display_name, permissions) VALUES
    (1, 'admin', '管理员', '["*"]'),
    (2, 'teacher', '教师', '["card:read","card:write","exam:read","exam:write","grade:read","grade:write"]'),
    (3, 'student', '学生', '["score:read"]');

-- 注意：默认管理员账号由应用程序在启动时通过 ensureDefaultAdmin() 自动创建
-- 账号: admin / 密码: admin123（首次登录后必须修改）

-- 插入默认数据保留策略
INSERT OR IGNORE INTO data_retention_policies (id, name, retain_days, auto_archive, auto_delete) VALUES
    (1, '周测', 30, 1, 0),
    (2, '月考', 90, 1, 0),
    (3, '期中期末', 0, 1, 0);
