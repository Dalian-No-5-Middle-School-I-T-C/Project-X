# 已知问题 (Known Issues)

> 基于 v1.9.0 全面代码审查（2026-07-19），以下为已识别但尚未修复的中等问题和设计缺陷。
> 致命（P0）和严重（P1）问题已全部修复并录入 CHANGELOG。

---

## 设计缺陷（3 项）

### D1: 网阅状态机缺失
**影响**：阅卷状态（ready → pending → reviewed → disputed → arbitrated）分散在多个文件的 if/else 判断中，无统一状态图。
- 新增状态时需要修改多处代码
- 状态转换约束（如 reviewed → disputed 可逆 vs 不可逆）未声明
- `answer_block_crops.status` 的合法值未集中定义

**建议**：集中定义阅卷状态枚举 + 状态转换表，在 `ReviewService.ts` 入口校验。

### D2: 事务边界不一致
**影响**：部分写操作（排名重算、student_scores 更新）在 DB 事务外执行，失败时无回滚保护。
- `ReviewService.submitReviewCropScores`：排名重算在事务外（已修复）
- `score-editing` 的两处：已修复
- `exam-groups` 的 ZIP 导出：文件打包与 DB 查询无事务关联
- 其他未审计的写路径仍可能存在同质问题

**建议**：对 API 层所有写路径做一次事务一致性审查。

### D3: 双数据库引用清理逻辑冲突
**影响**：SQLite 模式下 `CardRepository` 和 `server/index.ts` 各自持有独立的 DB 引用，资源生命周期不统一。
- `getMysqlDb()` 工厂返回单例，但 `new CardRepository()` 可能创建新的连接（取决于实现）
- FileWatcher、定时清理任务可能引用已关闭的 DB 连接

**建议**：确保所有 DB 访问通过单一的 `getMysqlDb()` / DI 容器，禁止模块内直接 new。

---

## 数据库层（8 项）

| 编号 | 问题 | 位置 | 风险 |
|------|------|------|------|
| DB-1 | SQLite `WAL` 模式下长时间不写入时 checkpoint 未主动触发 | `schema.sql` | 低：WAL 文件可能增长，但 SQLite 自动管理 |
| DB-2 | `migrations.ts` 与 `mysql.ts` 的增量迁移步骤编号不一一对应 | 双向 | 中：新增字段时容易遗漏一侧 |
| DB-3 | MariaDB `INSERT OR REPLACE` → 应使用 `ON DUPLICATE KEY UPDATE` | `mysql.ts` buildUpsertSQL | 低：MySQL/MariaDB 不支持 SQLite 语法，当前已正确适配 |
| DB-4 | `cleanup.ts` 文件删除失败时 DB 已标记 `file_path = NULL`，无法重试 | `cleanup.ts` | 低：next run 跳过（file_path 已为空） |
| DB-5 | `users.grade_id` 字段存在但部分查询未设索引 | `schema.sql` | 低：查询走全表扫描，数据量阈值 ~10K 前无感 |
| DB-6 | `exam_archives` 表标记 `is_deleted` 但无物理清理策略 | `cleanup.ts` | 低：仅日志提示，需手动操作 |
| DB-7 | MariaDB `ALTER TABLE ADD COLUMN` 无 `IF NOT EXISTS`（依赖 `try/catch`） | `mysql.ts` | 低：try/catch 已兜底，MariaDB 8.0+ 可改用原生 |
| DB-8 | `question_scores UNIQUE(exam_id, student_id, question_number, score_type)` 缺失，同一题目可能存在多条记录 | `schema.sql` / `migrations.ts` | 中：合并评分去重仅内存 Map 处理，DB 层无约束 |

---

## 网阅系统（8 项）

| 编号 | 问题 | 位置 | 风险 |
|------|------|------|------|
| REV-1 | 评审人受邀后无超时机制，长时间未审的题块无自动回收 | 无 | 中：任务可能永久阻塞 |
| REV-2 | 分配数量与实际提交数量无一致性校验 | `review_assignments` | 中：教师可能超出或未完成分配数量 |
| REV-3 | 批注（annotation）没有版本号/并发冲突检测 | `review-annotations.ts` | 低：两个教师同时对同一图批注可能互相覆盖 |
| REV-4 | `ReviewSession` 草稿分数仅持久化到内存，浏览器关闭后丢失 | `GradePanel.tsx` | 低：有 `review_sessions` 表但可能未全部同步 |
| REV-5 | `OnlineReviewPanel` 图片预加载无队列限制，同时打开大量图片可能耗尽带宽/内存 | `OnlineReviewPanel.tsx` | 低：需大量题块 + 低带宽才有感 |
| REV-6 | 仲裁人指派后若仲裁人离职/调岗，无交接机制 | `block_grading_config` | 低：需手动修改配置 |
| REV-7 | 阅卷统计 `pendingCount` 计算将 `pending` 和 `ready` 合并为"待批"，无法区分"还未有人接"和"有人接了但没批完" | `listReviewBlocks` | 低：精度问题，不影响核心功能 |
| REV-8 | `review_session` 保存后无冲突合并，退出再进入时可能存在草稿冲突 | `ReviewSessionService.ts` | 低：后保存的覆盖先保存的 |

---

## 成绩分析（8 项）

| 编号 | 问题 | 位置 | 风险 |
|------|------|------|------|
| ANL-1 | `getScoreTrend` 使用 SQL `AVG`，班级筛选后的趋势可能存在辛普森悖论 | `AnalysisRepository.ts` | 低：仅展示用 |
| ANL-2 | `getQuestionAnalysis` 错误率计算：客观题用 `score < max_score`，主观题用 `score < max_score * 0.5`，定义不一致 | `AnalysisRepository.ts` | 低：主观题 "低分" 定义为 <50%，偏严格 |
| ANL-3 | 跨考总分对比 (`getCrossExamTotal`) 无标准分转换，不同考试难度不同直接比总分 | `AnalysisRepository.ts` | 中：跨考排名可能失真 |
| ANL-4 | `question_scores` 的 `score_type` 可能为 `null` 或空字符串，重算时 `else` 分支将所有非 obj 当主观 | `ReviewService.ts:recomputeStudentTotals` | 中：部分数据可能归类错误 |
| ANL-5 | 赋分公式 (`assigned_formula`) 校验不完整，非法 JSON 静默失败 | `AssignedScoreService.ts` | 低：可能导致赋分全空 |
| ANL-6 | `competitionRank` 全局函数使用 `var` 声明，存在变量提升风险 | `AnalysisRepository.ts` | 极低：正确性已验证 |
| ANL-7 | `rankPercentile` 使用 `allStudents.length` 而非 `graded.length` 作为分母 | `AnalysisRepository.ts:getScoreTableData` | 低：包含未参考学生导致百分位偏高 |
| ANL-8 | 一个学生属于多个班级时，`class_students LEFT JOIN` 会产生重复行（已去重？） | 多处 | 中：数据模型只允许一个班级，若出现多班数据则口径不准 |

---

## 前端组件（7 项）

| 编号 | 问题 | 位置 | 风险 |
|------|------|------|------|
| UI-1 | `OnlineReviewPanel` 未限制提交频率，用户可连续快速点击提交 | `OnlineReviewPanel.tsx` | 中：后端 CAS 保护兜底，但前端无节流 |
| UI-2 | `ScorePad` 按钮无 loading 状态，提交过程中按钮仍可点击 | `ScorePad.tsx` | 低：后端错误可兜底 |
| UI-3 | `ExportModal` 导出大考试时无进度条，浏览器可能卡死 | `ExportModal.tsx` | 中：大考试（500+学生）体验差 |
| UI-4 | `CropImageViewer` 批注浮层 `z-index` 未统一管理，可能与其他模态框冲突 | `CropImageViewer.tsx` | 低：仅在叠加使用时有感 |
| UI-5 | `ScannerPanel` 扫描进度 SSE 断连后无自动重连 | `ScannerPanel.tsx` | 中：网络波动时需手动刷新 |
| UI-6 | `ScoreDetailPage` 的 `manually_modified` 标记在总分行和子题行可能存在不一致 | `ScoreDetailPage.tsx` | 低：只是展示布尔值 |
| UI-7 | `AccountMenu` 背景透明度滑块无防抖，每次拖动都发 API 请求 | `AccountMenu.tsx` | 低：单次请求很轻，高频拖拽会刷多次 |

---

## 其他已知问题

- ~~**express-rate-limit** 包未安装（auth.ts 登录限流中间件未生效）~~ **已修复（v1.9.2）**：`express-rate-limit@^8.6.0` 已安装，`src/server/routes/auth.ts` 已 `import rateLimit` 并启用登录限速中间件。
- 系统无端到端测试，所有验证依赖手动回归
- 扫描仪原生桥接模块 (`native/ScannerBridge`) 仅 Windows 可用，无 Linux/macOS 适配

---

_最后更新：2026-07-19 | 发现版本：v1.9.0_
