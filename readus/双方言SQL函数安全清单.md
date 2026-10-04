# 双方言 SQL 函数安全清单（SQLite / MariaDB）

> 来源：成绩分析系统优化建议清单 · 建议 9「索引补齐与双方言函数审计」
> 审计范围：`src/server/repositories/AnalysisRepository.ts`、`src/server/routes/exam-groups-analysis.ts`、`src/server/repositories/KnowledgePointRepository.ts`、`src/server/repositories/ScoreRepository.ts`、`src/apps/answer-card/server/routes/analysis.ts`
> 审计日期：2026-08-19 · 结论：分析链当前 SQL 在两种方言下均安全，仅完成一处风格统一（`IFNULL` → `COALESCE`）。

## ✅ 安全（双方言语义一致，可放心使用）

| 函数/写法 | SQLite | MariaDB | 备注 |
|---|---|---|---|
| `COALESCE(a, b, …)` | ✅ | ✅ | 统一入口，替代 `IFNULL`（仅两参数语义相同，建议统一用 COALESCE） |
| `date(...)` | ✅ | ✅ | 取日期部分；入参为 `'YYYY-MM-DD'` 或 `'YYYY-MM-DD HH:MM:SS'` 均安全 |
| `CURRENT_TIMESTAMP` | ✅ | ✅ | 写 `created_at/updated_at` 用 |
| `ROUND` / `SQRT` / `AVG` / `SUM` / `COUNT` / `MIN` / `MAX` | ✅ | ✅ | 常用于统计 |
| `CASE WHEN … THEN … ELSE … END` | ✅ | ✅ | |
| `BETWEEN` / `IN (...)` / `LIKE` / `IS NULL` / `LIMIT` | ✅ | ✅ | `IN (...)` 的占位符列表**必须自己挡空数组**：`IN ()` 在两种方言里都是语法错误，见下方禁止项 |
| 子查询 / 派生表 / `GROUP BY … HAVING` | ✅ | ✅ | 仅限**非相关**派生表；派生表在 MariaDB 必须带别名，见下方禁止项 |
| `CREATE INDEX IF NOT EXISTS` | ✅ | ✅ | MariaDB 10.1.2+ 支持（本仓迁移已大量使用） |
| `INSERT … ON CONFLICT ` / `ON DUPLICATE KEY UPDATE` | — | — | 一律走 `buildUpsertSQL`，不要手写 |
| `INSERT OR IGNORE` / `INSERT IGNORE` | — | — | 一律走 `buildInsertIgnore` |

## ⚠️ 禁止 / 需分支（方言分叉，勿混用）

| 函数/写法 | 问题 |
|---|---|
| `STRFTIME` | 仅 SQLite 有；MariaDB 无。时间格式化请用 JS date 处理 |
| `TIMESTAMPDIFF` / `DATE_ADD` / `DATE_SUB` / `INTERVAL` | 仅 MariaDB（或 SQLite 需 `datetime('now','+1 day')`），语义/语法不同 |
| SQL 字符串拼接 `\|\|` / `CONCAT(...)` | SQLite 用 `\|\|`，MariaDB 默认把 `\|\|` 当逻辑或；拼接业务请回 JS 处理 |
| `datetime('now')` | 仅 SQLite。已有先例见 `demo/reviewDemo.ts`（按 `db.dialect` 分支 `NOW()`） |
| `json_extract(...)` | SQLite 有、MariaDB 有但函数名/返回类型略异；JSON 解析尽量在 JS 层做 |
| **相关子查询里再套派生表**（`WHERE x IN (SELECT … FROM (SELECT … WHERE outer.col = …) )`） | MariaDB 的普通派生表**看不到外层表列**（`ERROR 1054 Unknown column 'abc.exam_id'`），去掉别名又在 MariaDB 报 `ERROR 1064`，SQLite 反过来不要求别名——同一句 SQL 无法两方言通吃。改为「独立的非相关聚合查询 + JS 侧按 key 合并」 |
| `IN (${[]})`（空数组拼出的 `IN ()`） | 两方言都 `ERROR` 语法错误。任何按权限集合动态拼占位符的地方，先判空再拼（空集合的语义通常是「什么都看不到」，直接返回空结果） |

## 🐛 真实事故（保留作为回归依据）

**2026-10-04 · 题块列表 500（第三批权限整改中发现的存量缺陷）**

`ReviewService.listReviewBlocks` 计算「题块满分」时写成
`COALESCE((SELECT SUM(mx) FROM (SELECT MAX(qs2.max_score) AS mx FROM question_scores qs2 WHERE qs2.exam_id = abc.exam_id AND qs2.block_id = abc.block_id GROUP BY qs2.question_number)), 0)`：
派生表内引用外层 `abc.*`，MariaDB 直接拒绝（无别名 1064，加别名 1054），SQLite 却能跑，所以只在线上 MariaDB 部署上炸。
现改为 `loadBlockMaxScores()` 独立查询（按 `block_id, question_number` 聚合，外层再 `SUM`），两种方言同一句 SQL。
回归位置：`scripts/verify-mariadb.ts` 的「review block listing」段 + `scripts/verify-permission-scope.ts` 的 R03 满分汇总断言。

## 📋 审计结论

1. 分析链无上述⚠️项使用：`STRFTIME`/`TIMESTAMPDIFF`/`DATE_ADD`/`DATE_SUB`/`CONCAT` 均未出现；`\|\|` 全是 JS 逻辑、不在 SQL 字符串内。
2. 已统一：`findPreviousExam` 中孤立的两处 `IFNULL(e.grade_id, -1)` → `COALESCE(e.grade_id, -1)`，与全仓一致。
3. 新增索引后，`question_scores` 上覆盖 analysis 高频过滤路径的索引为：
   - `idx_question_scores_exam_question_type (exam_id, question_number, score_type)` ← 本批新增
   - `idx_question_scores_exam_type (exam_id, score_type)`
   - `idx_question_scores_exam_student (exam_id, student_id)`
   - 见 `migrations.ts` v37 与 `mysql.ts` v37（SQLite 增量迁移 + MariaDB 增量迁移同步）。
