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
    track            TEXT,                    -- 文理分科：'arts' 文科 / 'science' 理科（仅学生，Issue #177）
    subject          TEXT,                    -- 任教科目（仅教师）
    initial_password TEXT,                    -- 初始明文密码（导出账密用）
    score_display_mode TEXT DEFAULT 'zscore',  -- deviation / zscore / percentile (v1.4.0)
    review_confidence_threshold REAL DEFAULT 0.12, -- 复核置信度阈值 (v1.4.0)
    ai_api_key       TEXT,                    -- AI API密钥 (v1.4.0)
    background_opacity REAL DEFAULT 0,          -- 背景图透明度 0~1, 0=关闭 (v1.5.0)
    email            TEXT,
    phone            TEXT,
    teacher_role     TEXT,                    -- subject_teacher / head_teacher / grade_leader（仅教师）
    password_change_required INTEGER DEFAULT 0, -- 1=必须先修改一次性/重置密码
    require_original_paper INTEGER DEFAULT 1, -- v1.8.0: 教师是否强制要求上传原卷
    highlight_missing_paper INTEGER DEFAULT 1, -- v1.8.0: 侧边栏高亮未上传原卷的考试
    is_active        INTEGER DEFAULT 1,      -- 0=禁用 1=启用
    show_tab_bar     INTEGER DEFAULT 0,      -- v1.9.0: 0=隐藏底部导航 1=显示
    theme_skin       TEXT DEFAULT 'paper-edge', -- v2.1.0: 前端皮肤 ID；v2.3.0 默认改为 'paper-edge'（纸锋；'flat'=明澈 可选）
    is_demo          INTEGER NOT NULL DEFAULT 0,  -- v1.9.6: 1=演示数据（clearDemoData 仅按此标记清理，避免误删真实账号）
    last_login_at    DATETIME,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- API 密钥表 (v1.6.0) — 供扫描客户端等服务端组件使用
CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,              -- 密钥名称（如 "扫描端1号"）
    api_key      TEXT NOT NULL UNIQUE,       -- 密钥值（sk-xxx）
    scope        TEXT NOT NULL DEFAULT 'scanner',  -- scanner / full
    is_active    INTEGER DEFAULT 1,          -- 0=停用 1=启用
    created_by   INTEGER REFERENCES users(id),
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 年级表
CREATE TABLE IF NOT EXISTS grades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,              -- 高一 / 高二 / 高三
    sort_order   INTEGER DEFAULT 0,         -- 排序
    is_demo      INTEGER NOT NULL DEFAULT 0, -- v1.9.6: 1=演示年级
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 班级表
CREATE TABLE IF NOT EXISTS classes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    grade_id     INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,              -- 1班 / 2班
    sort_order   INTEGER DEFAULT 0,
    is_demo      INTEGER NOT NULL DEFAULT 0, -- v1.9.6: 1=演示班级
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
    sided           TEXT DEFAULT 'double',              -- single / double
    layout_version   INTEGER DEFAULT 1,
    layout_data      TEXT,                                -- Deprecated: legacy cached LayoutDocument; generated from card tables on demand
    has_original_paper INTEGER DEFAULT 0,                  -- v1.8.0: 是否已上传原卷
    original_paper_filename TEXT,                          -- v1.8.0: 原卷文件名
    original_paper_path TEXT,                              -- v1.8.0: 原卷相对路径
    question_range   TEXT,                                 -- v1.8.0: 题目范围
    extra_notes      TEXT,                                 -- v1.8.0: 教师特别描述
    knowledge_points_text TEXT,                            -- v1.8.0: 知识点纯文本备份
    created_by       INTEGER REFERENCES users(id),
    is_demo          INTEGER NOT NULL DEFAULT 0,  -- v1.9.6: 1=演示答题卡（clearDemoData 仅按此标记清理）
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- v1.9.5: 原卷多页支持（一卡可有多页原卷）
CREATE TABLE IF NOT EXISTS original_paper_pages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id          TEXT NOT NULL,
    page_index       INTEGER NOT NULL,
    filename         TEXT NOT NULL,
    stored_path      TEXT NOT NULL,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(card_id, page_index)
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
    line_grid_json   TEXT,
    essay_grid_json  TEXT,
    score_grid_json  TEXT,
    annotation       TEXT,
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

-- 知识点字典（与成绩分析联动，v1.8.0）
CREATE TABLE IF NOT EXISTS knowledge_points (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id         TEXT NOT NULL REFERENCES answer_cards(id) ON DELETE CASCADE,
    question_number INTEGER NOT NULL,
    point_text      TEXT NOT NULL,
    category        TEXT,
    sort_order      INTEGER DEFAULT 0,
    track_type      TEXT NOT NULL DEFAULT 'common', -- 文理分科科目归属：common 共同 / arts 文科 / science 理科（Issue #177）
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(card_id, question_number, point_text)
);
CREATE INDEX IF NOT EXISTS idx_kp_card ON knowledge_points(card_id);
CREATE INDEX IF NOT EXISTS idx_kp_card_question ON knowledge_points(card_id, question_number);

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
    closed_at     DATETIME,                    -- 结考/出分时间 (v35)
    assigned_formula TEXT,                     -- JSON: 赋分公式配置 (v1.4.0)
    retention_policy_id INTEGER REFERENCES data_retention_policies(id),
    review_mode    INTEGER DEFAULT 1,            -- v1.9.0: 1=1P 2=2P 3=3P
    review_enabled INTEGER DEFAULT 0,            -- v1.9.0: 0=未开启网阅 1=已开启
    exam_mode      TEXT NOT NULL DEFAULT 'formal', -- v34: quiz=晨测(全量权限) formal=大考(精细权限，默认)
    created_by    INTEGER REFERENCES users(id),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 跨考试组（用于一周考试包 / 手动合并考试 / 大考合集）
CREATE TABLE IF NOT EXISTS exam_groups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT,
    source          TEXT DEFAULT 'manual',        -- manual / week
    start_date      TEXT,
    end_date        TEXT,
    grade_id        INTEGER REFERENCES grades(id),
    tag             TEXT,                         -- 月考/期中/期末/模考/统考
    status          TEXT DEFAULT 'active',
    is_official     INTEGER DEFAULT 0,
    total_score_mode TEXT DEFAULT 'raw',          -- raw / assigned
    only_full_participants INTEGER DEFAULT 0,
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exam_group_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id        INTEGER NOT NULL REFERENCES exam_groups(id) ON DELETE CASCADE,
    exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    sort_order      INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, exam_id)
);
CREATE INDEX IF NOT EXISTS idx_exam_group_members_group ON exam_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_exam_group_members_exam ON exam_group_members(exam_id);

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
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    error_summary TEXT,
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
-- TWAIN 扫描仪表（v1.6.0 从 scanner.db 合并）
-- ============================================================

CREATE TABLE IF NOT EXISTS answer_block_crops (
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
    reviewer_id      INTEGER REFERENCES users(id),
    reviewed_at      DATETIME,
    review_round     INTEGER DEFAULT 0,
    final_score      REAL,
    final_score_by   INTEGER REFERENCES users(id),
    score_breakdown  TEXT,
    claimed_by       INTEGER REFERENCES users(id),
    claimed_at       DATETIME,
    claim_count      INTEGER NOT NULL DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_type, source_record_id, block_id, page_number, segment_index)
);

CREATE TABLE IF NOT EXISTS twain_scan_sessions (
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

CREATE TABLE IF NOT EXISTS twain_scan_records (
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
            uploaded        INTEGER DEFAULT 0,   -- v1.6.0: 是否已上传到远端
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    recognized_at   DATETIME
);

CREATE TABLE IF NOT EXISTS twain_recognition_results (
    id              TEXT PRIMARY KEY,
    scan_record_id  TEXT UNIQUE NOT NULL REFERENCES twain_scan_records(id) ON DELETE CASCADE,
    objective_json  TEXT,
    subjective_json TEXT,
    total_score     REAL,
    max_score       REAL,
    grade_status    TEXT NOT NULL DEFAULT 'pending',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS twain_student_grading_results (
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
    selected_options TEXT,                   -- v29: 客观题学生所选选项 JSON 数组，如 ["A","C"]
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
    is_system       INTEGER DEFAULT 0,          -- v1.8.0: 1=系统级(全校统一), 0=个人
    is_active       INTEGER DEFAULT 1,
    sort_order      INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id, provider_type);

-- ============================================================
-- v1.9.0 网上阅卷系统重构 — 新增表
-- ============================================================

-- 阅卷任务分配
CREATE TABLE IF NOT EXISTS review_assignments (
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

-- 阅卷会话（断点续批）
CREATE TABLE IF NOT EXISTS review_sessions (
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

-- 阅卷批注
CREATE TABLE IF NOT EXISTS review_annotations (
    id          TEXT PRIMARY KEY,
    crop_id     TEXT NOT NULL REFERENCES answer_block_crops(id) ON DELETE CASCADE,
    reviewer_id INTEGER NOT NULL REFERENCES users(id),
    type        TEXT NOT NULL CHECK(type IN ('text', 'drawing')),
    data_json   TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rannot_crop ON review_annotations(crop_id);

-- 逐题块网阅设置
CREATE TABLE IF NOT EXISTS block_grading_config (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id            INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    block_id           TEXT NOT NULL,
    dispute_threshold  REAL DEFAULT 2,
    rounding           TEXT DEFAULT 'ceil',
    arbitrator_id      INTEGER REFERENCES users(id),
    review_mode        INTEGER DEFAULT 1,
    scoring_mode       TEXT NOT NULL DEFAULT 'block_total',
    score_distribution TEXT NOT NULL DEFAULT 'proportional',
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(exam_id, block_id)
);
CREATE INDEX IF NOT EXISTS idx_bgc_exam ON block_grading_config(exam_id);

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
CREATE INDEX IF NOT EXISTS idx_answer_block_crops_exam_student ON answer_block_crops(exam_id, student_id);
  CREATE INDEX IF NOT EXISTS idx_answer_block_crops_source ON answer_block_crops(source_type, source_record_id);
  CREATE INDEX IF NOT EXISTS idx_answer_block_crops_block ON answer_block_crops(card_id, block_id);
  -- 注：idx_answer_block_crops_pool 由 v32 迁移创建（其列 claimed_by 为 v32 新增，
  --     写在 schema.sql 会导致存量库（列未就绪）启动崩溃）
CREATE INDEX IF NOT EXISTS idx_student_scores_exam ON student_scores(exam_id);
CREATE INDEX IF NOT EXISTS idx_student_scores_student ON student_scores(student_id);
-- 性能：成绩分析（排名/统计/概览）按 exam_id 过滤并按 total_score / assigned_score 排序
CREATE INDEX IF NOT EXISTS idx_student_scores_exam_total ON student_scores(exam_id, total_score);
CREATE INDEX IF NOT EXISTS idx_student_scores_exam_assigned ON student_scores(exam_id, assigned_score);
CREATE INDEX IF NOT EXISTS idx_student_scores_exam_student ON student_scores(exam_id, student_id);
CREATE INDEX IF NOT EXISTS idx_question_scores_exam_student ON question_scores(exam_id, student_id);
CREATE INDEX IF NOT EXISTS idx_question_scores_exam_type ON question_scores(exam_id, score_type);
CREATE INDEX IF NOT EXISTS idx_exams_grade_class ON exams(grade_id, class_id);

-- ============================================================
-- 初始数据
-- ============================================================

-- 插入默认角色
INSERT OR IGNORE INTO roles (id, name, display_name, permissions) VALUES
    (1, 'admin', '管理员', '["*"]'),
    (2, 'teacher', '教师', '["card:read","card:write","exam:read","exam:write","grade:read","grade:write"]'),
    (3, 'student', '学生', '["score:read"]');

-- 注意：默认管理员账号由应用程序在启动时通过 ensureDefaultAdmin() 自动创建
-- 账号: admin / 随机一次性密码（写入数据库旁的 bootstrap-admin.txt，权限 0600，首次登录强制改密）

-- 插入默认数据保留策略
INSERT OR IGNORE INTO data_retention_policies (id, name, retain_days, auto_archive, auto_delete) VALUES
    (1, '周测', 30, 1, 0),
    (2, '月考', 90, 1, 0),
    (3, '期中期末', 0, 1, 0);
