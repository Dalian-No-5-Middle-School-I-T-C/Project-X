-- ============================================================
-- Project-X MySQL 完整建表 SQL
-- 引擎：InnoDB，字符集：utf8mb4
-- ============================================================

CREATE DATABASE IF NOT EXISTS projectx
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE projectx;

-- ============================================================
-- 模块一：用户与权限
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INT PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS roles (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(50) NOT NULL,
    permissions  TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    username         VARCHAR(100) NOT NULL UNIQUE,
    password_hash    VARCHAR(255) NOT NULL,
    name             VARCHAR(100) NOT NULL,
    role_id          INT NOT NULL,
    student_number   VARCHAR(50) UNIQUE,
    track            VARCHAR(20),                 -- 文理分科：arts 文科 / science 理科（仅学生，Issue #177）
    subject          VARCHAR(50),
    initial_password VARCHAR(255),
    score_display_mode VARCHAR(20) DEFAULT 'zscore',
    review_confidence_threshold DOUBLE DEFAULT 0.12,
    ai_api_key       TEXT,
    background_opacity DOUBLE DEFAULT 0,
    email            VARCHAR(255),
    phone            VARCHAR(50),
    teacher_role     VARCHAR(50),
    password_change_required TINYINT DEFAULT 0,
    require_original_paper TINYINT DEFAULT 1,  -- v1.8.0
    highlight_missing_paper TINYINT DEFAULT 1, -- v1.8.0
    is_active        TINYINT DEFAULT 1,
    show_tab_bar     TINYINT DEFAULT 0,             -- v1.9.0: 底部导航栏开关（MySQL 版此前缺失，与 mariadb 对齐补录）
    theme_skin       VARCHAR(32) DEFAULT 'paper-edge', -- v2.1.0: 前端皮肤 ID；v2.3.0 默认改为 'paper-edge'（纸锋；'flat'=明澈 可选）
    ui_style         VARCHAR(16) DEFAULT 'paper_edge', -- v37: 皮肤风格 clarity/paper_edge（与 theme_skin 并存过渡）
    color_scheme     VARCHAR(8)  DEFAULT 'light',     -- v37: 明暗 light/dark，账号级持久化
    last_login_at    DATETIME,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_demo          TINYINT NOT NULL DEFAULT 0,  -- v1.9.6: 1=演示数据
    FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS grades (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(50) NOT NULL,
    sort_order   INT DEFAULT 0,
    is_demo      TINYINT NOT NULL DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS classes (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    grade_id     INT NOT NULL,
    name         VARCHAR(50) NOT NULL,
    sort_order   INT DEFAULT 0,
    is_demo      TINYINT NOT NULL DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS class_students (
    class_id    INT NOT NULL,
    student_id  INT NOT NULL,
    joined_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (class_id, student_id),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS teacher_classes (
    teacher_id  INT NOT NULL,
    class_id    INT NOT NULL,
    subject     VARCHAR(50),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (teacher_id, class_id),
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS teacher_permissions (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    teacher_id         INT NOT NULL,
    grade_id           INT,
    can_view_scores    TINYINT DEFAULT 1,
    can_view_charts    TINYINT DEFAULT 1,
    can_view_students  TINYINT DEFAULT 1,
    subject            VARCHAR(50),                -- v37: 学科维度（NULL=不限）
    class_id           INT,                         -- v37: 班级维度（NULL=不限）
    block_id           VARCHAR(64),                 -- v37: 题块/阅卷任务维度（NULL=不限）
    can_grade          TINYINT DEFAULT 1,           -- v37: 是否可阅卷操作
    can_assign         TINYINT DEFAULT 1,           -- v37: 是否可被分配/分配阅卷任务
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
    UNIQUE KEY uk_teacher_grade (teacher_id, grade_id)
) ENGINE=InnoDB;

-- ============================================================
-- 模块二：答题卡设计
-- ============================================================

CREATE TABLE IF NOT EXISTS answer_cards (
    id               VARCHAR(20) PRIMARY KEY,
    title            VARCHAR(255) NOT NULL,
    subject          VARCHAR(50),
    subject_label    VARCHAR(50),
    exam_date        VARCHAR(20),
    paper_size       VARCHAR(10) DEFAULT 'A4',
    orientation      VARCHAR(10) DEFAULT 'portrait',
    student_fields   TEXT,
    student_number_digits INT DEFAULT 5,
    sided           VARCHAR(10) DEFAULT 'single',
    layout_version   INT DEFAULT 1,
    layout_data      TEXT,
    has_original_paper TINYINT DEFAULT 0,                  -- v1.8.0
    original_paper_filename VARCHAR(255),                  -- v1.8.0
    original_paper_path VARCHAR(500),                    -- v1.8.0
    question_range   TEXT,                                 -- v1.8.0
    extra_notes      TEXT,                               -- v1.8.0
    knowledge_points_text TEXT,                            -- v1.8.0
    created_by       INT,
    is_demo          TINYINT NOT NULL DEFAULT 0,  -- v1.9.6: 1=演示答题卡
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- v1.9.5: 原卷多页支持
CREATE TABLE IF NOT EXISTS original_paper_pages (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    card_id          VARCHAR(20) NOT NULL,
    page_index       INT NOT NULL,
    filename         VARCHAR(255) NOT NULL,
    stored_path      VARCHAR(500) NOT NULL,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_paper_pages (card_id, page_index)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS objective_blocks (
    id               VARCHAR(36) PRIMARY KEY,
    card_id          VARCHAR(20) NOT NULL,
    sort_order       INT DEFAULT 0,
    title            VARCHAR(255),
    question_start   INT NOT NULL,
    question_count   INT NOT NULL,
    option_count     INT NOT NULL,
    mode             VARCHAR(20) NOT NULL,
    score_per_question DOUBLE NOT NULL,
    density          VARCHAR(20) DEFAULT 'compact',
    option_layout    VARCHAR(20) DEFAULT 'horizontal',
    wrong_or_extra_score DOUBLE DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES answer_cards(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS objective_answer_keys (
    block_id        VARCHAR(36) NOT NULL,
    question_number  INT NOT NULL,
    correct_options  TEXT NOT NULL,
    PRIMARY KEY (block_id, question_number),
    FOREIGN KEY (block_id) REFERENCES objective_blocks(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS objective_questions (
    block_id        VARCHAR(36) NOT NULL,
    question_number INT NOT NULL,
    sort_order      INT DEFAULT 0,
    mode            VARCHAR(20) NOT NULL,
    option_count    INT NOT NULL,
    score           DOUBLE NOT NULL,
    option_layout   VARCHAR(20),
    scoring_rule_json TEXT,
    PRIMARY KEY (block_id, question_number),
    FOREIGN KEY (block_id) REFERENCES objective_blocks(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS objective_multiple_scoring (
    block_id       VARCHAR(36) NOT NULL,
    correct_count   INT NOT NULL,
    score           DOUBLE NOT NULL,
    PRIMARY KEY (block_id, correct_count),
    FOREIGN KEY (block_id) REFERENCES objective_blocks(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subjective_blocks (
    id          VARCHAR(36) PRIMARY KEY,
    card_id     VARCHAR(20) NOT NULL,
    sort_order  INT DEFAULT 0,
    block_kind  VARCHAR(20) DEFAULT 'answer',
    title       VARCHAR(255),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES answer_cards(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subjective_questions (
    id               VARCHAR(36) PRIMARY KEY,
    block_id         VARCHAR(36) NOT NULL,
    number           INT NOT NULL,
    score            DOUBLE NOT NULL,
    style            VARCHAR(30) NOT NULL,
    kind             VARCHAR(30) NOT NULL,
    min_height_mm    DOUBLE DEFAULT 68,
    line_grid_enabled TINYINT DEFAULT 0,
    line_spacing_mm  DOUBLE DEFAULT 8,
    blanks_count     INT,
    blanks_width_mm  DOUBLE,
    blanks_height_mm DOUBLE,
    blanks_label_style VARCHAR(50),
    blanks_items_json TEXT,
    line_grid_json   TEXT,
    essay_grid_json  TEXT,
    score_grid_json  TEXT,
    sort_order       INT DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (block_id) REFERENCES subjective_blocks(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subjective_question_images (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    question_id    VARCHAR(36) NOT NULL,
    asset_id       VARCHAR(255) NOT NULL,
    original_name  VARCHAR(255),
    width_mm       DOUBLE,
    height_mm      DOUBLE,
    align          VARCHAR(20) DEFAULT 'left',
    sort_order     INT DEFAULT 0,
    FOREIGN KEY (question_id) REFERENCES subjective_questions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS card_assets (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    card_id         VARCHAR(20) NOT NULL,
    asset_id        VARCHAR(255) NOT NULL,
    original_name   VARCHAR(255),
    file_path       VARCHAR(500) NOT NULL,
    file_size       INT,
    mime_type       VARCHAR(100),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES answer_cards(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 知识点字典（与成绩分析联动，v1.8.0）
CREATE TABLE IF NOT EXISTS knowledge_points (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    card_id         VARCHAR(20) NOT NULL,
    question_number INT NOT NULL,
    point_text      VARCHAR(50) NOT NULL,
    category        VARCHAR(50),
    sort_order      INT DEFAULT 0,
    track_type      VARCHAR(20) NOT NULL DEFAULT 'common', -- 文理分科科目归属：common 共同 / arts 文科 / science 理科（Issue #177）
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_card_question_point (card_id, question_number, point_text),
    FOREIGN KEY (card_id) REFERENCES answer_cards(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE INDEX idx_kp_card ON knowledge_points(card_id);
CREATE INDEX idx_kp_card_question ON knowledge_points(card_id, question_number);

-- ============================================================
-- 模块三：考试与扫描
-- ============================================================

CREATE TABLE IF NOT EXISTS data_retention_policies (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    retain_days     INT DEFAULT 30,
    auto_archive    TINYINT DEFAULT 1,
    auto_delete     TINYINT DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exams (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    card_id       VARCHAR(20),
    grade_id      INT,
    class_id      INT,
    subject       VARCHAR(50),
    start_time    DATETIME,
    end_time      DATETIME,
    status        VARCHAR(20) DEFAULT 'draft',
    assigned_formula TEXT,
    retention_policy_id INT,
    exam_mode      VARCHAR(20) NOT NULL DEFAULT 'formal',  -- v34: quiz=晨测 formal=大考(默认)
    created_by    INT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES answer_cards(id),
    FOREIGN KEY (grade_id) REFERENCES grades(id),
    FOREIGN KEY (class_id) REFERENCES classes(id),
    FOREIGN KEY (retention_policy_id) REFERENCES data_retention_policies(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exam_groups (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    source          VARCHAR(50) DEFAULT 'manual',
    start_date      VARCHAR(20),
    end_date        VARCHAR(20),
    grade_id        INT,
    tag             VARCHAR(50),
    status          VARCHAR(20) DEFAULT 'active',
    is_official     TINYINT DEFAULT 0,
    total_score_mode VARCHAR(20) DEFAULT 'raw',
    only_full_participants TINYINT DEFAULT 0,
    created_by      INT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_id) REFERENCES grades(id),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exam_group_members (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    group_id        INT NOT NULL,
    exam_id         INT NOT NULL,
    sort_order      INT DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_group_exam (group_id, exam_id),
    FOREIGN KEY (group_id) REFERENCES exam_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exam_archives (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    exam_id        INT NOT NULL,
    archived_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    archive_path   VARCHAR(500),
    scan_count     INT,
    data_size_mb   DOUBLE,
    is_deleted     TINYINT DEFAULT 0,
    deleted_at     DATETIME,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS scan_batches (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    exam_id     INT NOT NULL,
    name        VARCHAR(255),
    status      VARCHAR(20) DEFAULT 'pending',
    file_count  INT DEFAULT 0,
    success_count INT DEFAULT 0,
    failure_count INT DEFAULT 0,
    error_summary LONGTEXT,
    created_by  INT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS scan_records (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    batch_id       INT NOT NULL,
    file_path      VARCHAR(500),
    file_name      VARCHAR(255),
    student_number VARCHAR(50),
    student_id     INT,
    status         VARCHAR(20) DEFAULT 'pending',
    recognized_at  DATETIME,
    graded_at      DATETIME,
    error_msg      TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at     DATETIME,
    FOREIGN KEY (batch_id) REFERENCES scan_batches(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS objective_recognitions (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    record_id       INT NOT NULL,
    block_id        VARCHAR(36) NOT NULL,
    question_number INT NOT NULL,
    selected_options TEXT,
    confidence      DOUBLE,
    raw_data        TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at      DATETIME,
    FOREIGN KEY (record_id) REFERENCES scan_records(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS objective_grades (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    record_id       INT NOT NULL,
    question_number INT NOT NULL,
    block_id        VARCHAR(36) NOT NULL,
    score           DOUBLE,
    max_score       DOUBLE,
    is_correct      TINYINT,
    graded_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (record_id) REFERENCES scan_records(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subjective_grades (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    record_id      INT NOT NULL,
    question_id    VARCHAR(36) NOT NULL,
    score          DOUBLE,
    graded_by      INT,
    graded_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    comment        TEXT,
    FOREIGN KEY (record_id) REFERENCES scan_records(id) ON DELETE CASCADE,
    FOREIGN KEY (graded_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============================================================
-- 模块四：成绩统计
-- ============================================================

CREATE TABLE IF NOT EXISTS answer_block_crops (
    id               VARCHAR(64) PRIMARY KEY,
    card_id          VARCHAR(36) NOT NULL,
    exam_id          INT,
    student_id       INT,
    student_number   VARCHAR(64),
    source_type      VARCHAR(32) NOT NULL,
    source_record_id VARCHAR(64) NOT NULL,
    block_id         VARCHAR(36) NOT NULL,
    block_title      VARCHAR(255),
    block_type       VARCHAR(32) NOT NULL,
    page_number      INT NOT NULL,
    segment_index    INT NOT NULL,
    question_numbers JSON NOT NULL,
    rect_json        JSON NOT NULL,
    image_path       TEXT NOT NULL,
    width_px         INT NOT NULL,
    height_px        INT NOT NULL,
    dpi              INT NOT NULL,
    status           VARCHAR(32) DEFAULT 'ready',
    claimed_by       INT,
    claimed_at       DATETIME,
    claim_count      INT NOT NULL DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_answer_block_crop_source (source_type, source_record_id, block_id, page_number, segment_index),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id),
    FOREIGN KEY (claimed_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS student_scores (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    exam_id         INT NOT NULL,
    student_id      INT NOT NULL,
    objective_score DOUBLE DEFAULT 0,
    subjective_score DOUBLE DEFAULT 0,
    total_score     DOUBLE,
    assigned_score  DOUBLE,
    `rank`          INT,
    percentile      DOUBLE,
    graded_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    manually_modified TINYINT DEFAULT 0,
    modified_by     INT,
    modified_at     DATETIME,
    UNIQUE KEY uq_exam_student (exam_id, student_id),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id),
    FOREIGN KEY (modified_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS question_scores (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    exam_id         INT NOT NULL,
    student_id      INT NOT NULL,
    question_number INT,
    question_id     VARCHAR(36),
    block_id        VARCHAR(36),
    score           DOUBLE,
    max_score       DOUBLE,
    score_type      VARCHAR(20),
    selected_options TEXT,
    manually_modified TINYINT DEFAULT 0,
    modified_by     INT,
    modified_at     DATETIME,
    UNIQUE KEY uq_exam_student_q (exam_id, student_id, question_number, score_type),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id),
    FOREIGN KEY (modified_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS answer_overrides (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    exam_id         INT NOT NULL,
    card_id         VARCHAR(20) NOT NULL,
    question_number INT,
    question_id     VARCHAR(36),
    block_id        VARCHAR(36),
    score_type      VARCHAR(20) NOT NULL,
    override_type   VARCHAR(20) NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    created_by      INT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============================================================
-- 模块五：导出模板
-- ============================================================

CREATE TABLE IF NOT EXISTS export_templates (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    user_id       INT NOT NULL,
    slot          INT NOT NULL CHECK(slot BETWEEN 1 AND 4),
    name          VARCHAR(100) NOT NULL DEFAULT '未命名',
    columns       TEXT NOT NULL,
    side_table_n  INT DEFAULT 0,
    gap_cols      INT DEFAULT 3,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_slot (user_id, slot),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- AI 服务商配置
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_providers (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    user_id         INT NOT NULL,
    name            VARCHAR(100) NOT NULL,
    provider_type   VARCHAR(50) NOT NULL,
    base_url        VARCHAR(500) NOT NULL DEFAULT '',
    api_key         VARCHAR(500) NOT NULL,
    models          TEXT,
    is_system       TINYINT DEFAULT 0,           -- v1.8.0: 1=系统级(全校统一), 0=个人
    is_active       TINYINT DEFAULT 1,
    sort_order      INT DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 索引
-- ============================================================

CREATE INDEX idx_users_student_number ON users(student_number);
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_is_active ON users(is_active);
CREATE INDEX idx_class_students_student ON class_students(student_id);
CREATE INDEX idx_teacher_classes_teacher ON teacher_classes(teacher_id);
CREATE INDEX idx_answer_cards_created_by ON answer_cards(created_by);
CREATE INDEX idx_objective_blocks_card ON objective_blocks(card_id);
CREATE INDEX idx_objective_questions_block ON objective_questions(block_id);
CREATE INDEX idx_subjective_blocks_card ON subjective_blocks(card_id);
CREATE INDEX idx_subjective_questions_block ON subjective_questions(block_id);
CREATE INDEX idx_exams_status ON exams(status);
CREATE INDEX idx_exams_grade ON exams(grade_id);
CREATE INDEX idx_exam_group_members_group ON exam_group_members(group_id);
CREATE INDEX idx_exam_group_members_exam ON exam_group_members(exam_id);
CREATE INDEX idx_scan_records_batch ON scan_records(batch_id);
CREATE INDEX idx_scan_records_student ON scan_records(student_id);
CREATE INDEX idx_scan_records_expires ON scan_records(expires_at);
CREATE INDEX idx_objective_recognitions_record ON objective_recognitions(record_id);
CREATE INDEX idx_objective_grades_record ON objective_grades(record_id);
CREATE INDEX idx_subjective_grades_record ON subjective_grades(record_id);
CREATE INDEX idx_answer_block_crops_exam_student ON answer_block_crops(exam_id, student_id);
CREATE INDEX idx_answer_block_crops_source ON answer_block_crops(source_type, source_record_id);
CREATE INDEX idx_answer_block_crops_block ON answer_block_crops(card_id, block_id);
CREATE INDEX idx_student_scores_exam ON student_scores(exam_id);
CREATE INDEX idx_student_scores_student ON student_scores(student_id);
CREATE INDEX idx_question_scores_exam_student ON question_scores(exam_id, student_id);
CREATE INDEX idx_answer_overrides_exam ON answer_overrides(exam_id);
CREATE INDEX idx_export_templates_user ON export_templates(user_id, slot);
CREATE INDEX idx_ai_providers_user ON ai_providers(user_id, provider_type);

-- ============================================================
-- 初始数据
-- ============================================================

INSERT IGNORE INTO roles (id, name, display_name, permissions) VALUES
    (1, 'admin', '管理员', '["*"]'),
    (2, 'teacher', '教师', '["card:read","card:write","exam:read","exam:write","grade:read","grade:write"]'),
    (3, 'student', '学生', '["score:read"]');

INSERT IGNORE INTO data_retention_policies (id, name, retain_days, auto_archive, auto_delete) VALUES
    (1, '周测', 30, 1, 0),
    (2, '月考', 90, 1, 0),
    (3, '期中期末', 0, 1, 0);

-- ============================================================
-- 模块补充：控制台可观测性 + 教师权限细粒度地基 (v37)
-- ============================================================

-- 主题切换审计
CREATE TABLE IF NOT EXISTS theme_change_events (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT,
    from_style  VARCHAR(32),
    to_style    VARCHAR(32),
    from_scheme VARCHAR(8),
    to_scheme   VARCHAR(8),
    changed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- AI 调用观测：逻辑任务层
CREATE TABLE IF NOT EXISTS ai_analysis_runs (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- AI 调用观测：实际模型调用层
CREATE TABLE IF NOT EXISTS ai_provider_calls (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 实体生命周期事件：历史累计统计
CREATE TABLE IF NOT EXISTS entity_lifecycle_events (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    entity_type VARCHAR(30) NOT NULL,
    entity_id   VARCHAR(64) NOT NULL,
    action      VARCHAR(20) NOT NULL,
    actor_id    INT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
