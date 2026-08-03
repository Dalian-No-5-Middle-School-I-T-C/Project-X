-- ============================================================
-- Project-X MariaDB 10.11 完整建表 SQL
-- 引擎：InnoDB  字符集：utf8mb4  排序：utf8mb4_unicode_ci
-- 兼容：MariaDB 10.11 LTS (支持 32位/64位)
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS roles (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(50) NOT NULL,
    permissions  TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    username         VARCHAR(100) NOT NULL UNIQUE,
    password_hash    VARCHAR(255) NOT NULL,
    name             VARCHAR(100) NOT NULL,
    role_id          INT NOT NULL,
    student_number   VARCHAR(50) UNIQUE,
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
    -- v9: 原卷偏好
    require_original_paper TINYINT DEFAULT 1,
    highlight_missing_paper TINYINT DEFAULT 1,
    is_active        TINYINT DEFAULT 1,
    show_tab_bar     TINYINT DEFAULT 0,             -- v1.9.0: 底部导航栏开关
    is_demo          TINYINT NOT NULL DEFAULT 0,     -- v1.9.6: 1=演示数据（clearDemoData 仅按此标记清理）
    last_login_at    DATETIME,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- API 密钥表 (v1.6.0) — 供扫描客户端等服务端组件使用
CREATE TABLE IF NOT EXISTS api_keys (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    api_key      VARCHAR(64) NOT NULL UNIQUE,
    scope        VARCHAR(20) NOT NULL DEFAULT 'scanner',
    is_active    TINYINT DEFAULT 1,
    created_by   INT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS grades (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(50) NOT NULL,
    sort_order   INT DEFAULT 0,
    is_demo      TINYINT NOT NULL DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS classes (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    grade_id     INT NOT NULL,
    name         VARCHAR(50) NOT NULL,
    sort_order   INT DEFAULT 0,
    is_demo      TINYINT NOT NULL DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS class_students (
    class_id    INT NOT NULL,
    student_id  INT NOT NULL,
    joined_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (class_id, student_id),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS teacher_classes (
    teacher_id  INT NOT NULL,
    class_id    INT NOT NULL,
    subject     VARCHAR(50),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (teacher_id, class_id),
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 教师数据可见性权限 (v16)
CREATE TABLE IF NOT EXISTS teacher_permissions (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    teacher_id         INT NOT NULL,
    grade_id           INT,
    can_view_scores    TINYINT DEFAULT 1,
    can_view_charts    TINYINT DEFAULT 1,
    can_view_students  TINYINT DEFAULT 1,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
    UNIQUE KEY uk_teacher_grade (teacher_id, grade_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_tp_teacher ON teacher_permissions(teacher_id);

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
    sided            VARCHAR(10) DEFAULT 'double',
    layout_version   INT DEFAULT 1,
    layout_data      TEXT,
    -- v9: 原卷关联
    has_original_paper TINYINT DEFAULT 0,
    original_paper_filename VARCHAR(255),
    original_paper_path VARCHAR(500),
    question_range   TEXT,
    extra_notes      TEXT,
    knowledge_points_text TEXT,
    created_by       INT,
    is_demo          TINYINT NOT NULL DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- v1.9.5: 原卷多页支持
CREATE TABLE IF NOT EXISTS original_paper_pages (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    card_id          VARCHAR(20) NOT NULL,
    page_index       INT NOT NULL,
    filename         VARCHAR(255) NOT NULL,
    stored_path      VARCHAR(500) NOT NULL,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_paper_pages (card_id, page_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS objective_answer_keys (
    block_id        VARCHAR(36) NOT NULL,
    question_number  INT NOT NULL,
    correct_options  TEXT NOT NULL,
    PRIMARY KEY (block_id, question_number),
    FOREIGN KEY (block_id) REFERENCES objective_blocks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS objective_multiple_scoring (
    block_id       VARCHAR(36) NOT NULL,
    correct_count   INT NOT NULL,
    score           DOUBLE NOT NULL,
    PRIMARY KEY (block_id, correct_count),
    FOREIGN KEY (block_id) REFERENCES objective_blocks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS subjective_blocks (
    id          VARCHAR(36) PRIMARY KEY,
    card_id     VARCHAR(20) NOT NULL,
    sort_order  INT DEFAULT 0,
    block_kind  VARCHAR(20) DEFAULT 'answer',
    title       VARCHAR(255),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES answer_cards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
    annotation       TEXT,
    sort_order       INT DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (block_id) REFERENCES subjective_blocks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- v9: 知识点字典表
CREATE TABLE IF NOT EXISTS knowledge_points (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    card_id         VARCHAR(20) NOT NULL,
    question_number INT NOT NULL,
    point_text      TEXT NOT NULL,
    category        VARCHAR(100),
    sort_order      INT DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_card_question_point (card_id, question_number, point_text(255)),
    FOREIGN KEY (card_id) REFERENCES answer_cards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
    review_mode    INT DEFAULT 1,           -- v1.9.0: 1=1P 2=2P 3=3P
    review_enabled TINYINT DEFAULT 0,       -- v1.9.0: 网阅开关
    created_by    INT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES answer_cards(id),
    FOREIGN KEY (grade_id) REFERENCES grades(id),
    FOREIGN KEY (class_id) REFERENCES classes(id),
    FOREIGN KEY (retention_policy_id) REFERENCES data_retention_policies(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS exam_group_members (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    group_id        INT NOT NULL,
    exam_id         INT NOT NULL,
    sort_order      INT DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_group_exam (group_id, exam_id),
    FOREIGN KEY (group_id) REFERENCES exam_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 扫描批次（阅卷工作流）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 单张扫描记录（阅卷工作流）
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
    image_uploaded TINYINT DEFAULT 0,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at     DATETIME,
    FOREIGN KEY (batch_id) REFERENCES scan_batches(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TWAIN 扫描仪表（从 scanner.db 合并）
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
    reviewer_id      INT,                           -- v1.9.0: 审阅人
    reviewed_at      DATETIME,                      -- v1.9.0: 审阅时间
    review_round     INT DEFAULT 1,                 -- v1.9.0: 第几轮审阅
    final_score      DOUBLE,                        -- v1.9.0: 最终分
    final_score_by   INT,                           -- v1.9.0: 最终分判定人
    score_breakdown  LONGTEXT,                      -- v1.9.0: 各轮评分明细 JSON
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_answer_block_crop_source (source_type, source_record_id, block_id, page_number, segment_index),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id),
    FOREIGN KEY (reviewer_id)   REFERENCES users(id),
    FOREIGN KEY (final_score_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS twain_scan_sessions (
    id          VARCHAR(36) PRIMARY KEY,
    card_id     VARCHAR(20) NOT NULL,
    name        VARCHAR(255) NOT NULL DEFAULT '',
    dpi         INT NOT NULL DEFAULT 300,
    duplex      TINYINT NOT NULL DEFAULT 1,
    color_mode  VARCHAR(20) NOT NULL DEFAULT 'gray',
    paper_size  VARCHAR(20) NOT NULL DEFAULT 'A4',
    page_count  INT NOT NULL DEFAULT 0,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    error_msg   TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS twain_scan_records (
    id              VARCHAR(36) PRIMARY KEY,
    session_id      VARCHAR(36) NOT NULL,
    card_id         VARCHAR(20) NOT NULL,
    student_id      VARCHAR(50),
    student_conf    DOUBLE,
    image_path      VARCHAR(500) NOT NULL,
    page_num        INT NOT NULL DEFAULT 1,
    side            VARCHAR(10) NOT NULL DEFAULT 'front',
    ocr_status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    scan_quality    DOUBLE,
    ocr_error       TEXT,
    uploaded        TINYINT DEFAULT 0,   -- v1.6.0: 是否已上传到远端
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    recognized_at   DATETIME,
    FOREIGN KEY (session_id) REFERENCES twain_scan_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS twain_recognition_results (
    id              VARCHAR(36) PRIMARY KEY,
    scan_record_id  VARCHAR(36) NOT NULL UNIQUE,
    objective_json  TEXT,
    subjective_json TEXT,
    total_score     DOUBLE,
    max_score       DOUBLE,
    grade_status    VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scan_record_id) REFERENCES twain_scan_records(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS twain_student_grading_results (
    session_id    VARCHAR(36) NOT NULL,
    student_id    VARCHAR(50) NOT NULL,
    objective_json  TEXT,
    subjective_json TEXT,
    total_score   DOUBLE,
    max_score     DOUBLE,
    page_count    INT NOT NULL DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, student_id),
    FOREIGN KEY (session_id) REFERENCES twain_scan_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 模块四：成绩统计
-- ============================================================

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- AI 服务商配置
-- ============================================================

-- ============================================================
-- System settings
-- ============================================================

CREATE TABLE IF NOT EXISTS system_settings (
    `key`      VARCHAR(100) PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- v1.9.0 网上阅卷系统重构 — 新增表
-- ============================================================

CREATE TABLE IF NOT EXISTS review_assignments (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    exam_id              INT NOT NULL,
    block_id             VARCHAR(36) NOT NULL,
    teacher_id           INT NOT NULL,
    student_count        INT DEFAULT 0,
    assigned_student_ids LONGTEXT,
    auto_assigned        TINYINT DEFAULT 0,
    created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ra_exam_block_teacher (exam_id, block_id, teacher_id),
    FOREIGN KEY (exam_id)    REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_ra_exam_block ON review_assignments(exam_id, block_id);
CREATE INDEX IF NOT EXISTS idx_ra_teacher ON review_assignments(teacher_id);

CREATE TABLE IF NOT EXISTS review_sessions (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_rs_teacher ON review_sessions(teacher_id);

CREATE TABLE IF NOT EXISTS review_annotations (
    id          VARCHAR(64) PRIMARY KEY,
    crop_id     VARCHAR(64) NOT NULL,
    reviewer_id INT NOT NULL,
    type        VARCHAR(16) NOT NULL,
    data_json   LONGTEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (crop_id)     REFERENCES answer_block_crops(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewer_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_rannot_crop ON review_annotations(crop_id);

CREATE TABLE IF NOT EXISTS block_grading_config (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    exam_id            INT NOT NULL,
    block_id           VARCHAR(36) NOT NULL,
    dispute_threshold  DOUBLE DEFAULT 2,
    rounding           VARCHAR(16) DEFAULT 'ceil',
    arbitrator_id      INT,
    review_mode        INT DEFAULT 1,
    scoring_mode       VARCHAR(16) NOT NULL DEFAULT 'block_total',
    score_distribution VARCHAR(16) NOT NULL DEFAULT 'proportional',
    has_half_point             TINYINT DEFAULT 0,
    auto_reassign_no_arb       TINYINT DEFAULT 1,
    workload_balance_threshold INT DEFAULT 4,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_bgc_exam_block (exam_id, block_id),
    FOREIGN KEY (exam_id)       REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (arbitrator_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_bgc_exam ON block_grading_config(exam_id);

-- ============================================================
-- 索引
-- ============================================================

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
CREATE INDEX IF NOT EXISTS idx_kp_card ON knowledge_points(card_id);
CREATE INDEX IF NOT EXISTS idx_kp_card_question ON knowledge_points(card_id, question_number);
CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_grade ON exams(grade_id);
CREATE INDEX IF NOT EXISTS idx_exam_group_members_group ON exam_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_exam_group_members_exam ON exam_group_members(exam_id);
CREATE INDEX IF NOT EXISTS idx_scan_records_batch ON scan_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_scan_records_student ON scan_records(student_id);
CREATE INDEX IF NOT EXISTS idx_scan_records_expires ON scan_records(expires_at);
CREATE INDEX IF NOT EXISTS idx_objective_recognitions_record ON objective_recognitions(record_id);
CREATE INDEX IF NOT EXISTS idx_objective_recognitions_expires ON objective_recognitions(expires_at);
CREATE INDEX IF NOT EXISTS idx_objective_grades_record ON objective_grades(record_id);
CREATE INDEX IF NOT EXISTS idx_subjective_grades_record ON subjective_grades(record_id);
CREATE INDEX IF NOT EXISTS idx_answer_block_crops_exam_student ON answer_block_crops(exam_id, student_id);
CREATE INDEX IF NOT EXISTS idx_answer_block_crops_source ON answer_block_crops(source_type, source_record_id);
CREATE INDEX IF NOT EXISTS idx_answer_block_crops_block ON answer_block_crops(card_id, block_id);
CREATE INDEX IF NOT EXISTS idx_student_scores_exam ON student_scores(exam_id);
CREATE INDEX IF NOT EXISTS idx_student_scores_student ON student_scores(student_id);
CREATE INDEX IF NOT EXISTS idx_question_scores_exam_student ON question_scores(exam_id, student_id);
-- 性能：成绩分析（排名/统计/概览）按 exam_id 过滤并按 total_score / assigned_score 排序
-- 对齐 SQLite v12 "analysis-performance-indexes" (PR133 版本号漂移导致原本缺失)
CREATE INDEX IF NOT EXISTS idx_student_scores_exam_total ON student_scores(exam_id, total_score);
CREATE INDEX IF NOT EXISTS idx_student_scores_exam_assigned ON student_scores(exam_id, assigned_score);
CREATE INDEX IF NOT EXISTS idx_student_scores_exam_student ON student_scores(exam_id, student_id);
CREATE INDEX IF NOT EXISTS idx_question_scores_exam_type ON question_scores(exam_id, score_type);
CREATE INDEX IF NOT EXISTS idx_exams_grade_class ON exams(grade_id, class_id);
CREATE INDEX IF NOT EXISTS idx_answer_overrides_exam ON answer_overrides(exam_id);
CREATE INDEX IF NOT EXISTS idx_export_templates_user ON export_templates(user_id, slot);
CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id, provider_type);
CREATE INDEX IF NOT EXISTS idx_twain_sessions_card ON twain_scan_sessions(card_id);
CREATE INDEX IF NOT EXISTS idx_twain_records_session ON twain_scan_records(session_id);
CREATE INDEX IF NOT EXISTS idx_twain_records_card ON twain_scan_records(card_id);
CREATE INDEX IF NOT EXISTS idx_twain_records_student ON twain_scan_records(student_id);
CREATE INDEX IF NOT EXISTS idx_twain_recognition_scan ON twain_recognition_results(scan_record_id);
CREATE INDEX IF NOT EXISTS idx_twain_sgr_session ON twain_student_grading_results(session_id);
CREATE INDEX IF NOT EXISTS idx_twain_sgr_student ON twain_student_grading_results(student_id);

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

INSERT IGNORE INTO system_settings (`key`, value) VALUES
    ('ladder_enabled', '1'),
    ('allow_half_point', '1'),
    ('default_dispute_threshold', '2'),
    ('default_rounding', 'ceil'),
    ('auto_reassign_policy', '1'),
    ('workload_balance_threshold', '4');
