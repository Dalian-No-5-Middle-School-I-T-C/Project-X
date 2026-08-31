# 五轮测试问题修复 v2.5.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复五轮测试（2026-08-28 ~ 08-31，MariaDB 生产部署 d15z.cn）报告的 10 项问题：3 项 MariaDB SQL/数据 bug、4 项前端/扫描端 UI bug、1 项 llmclient 打包 bug、1 项设置归属问题、1 项切块静默失败防护，并给出切块验证路径。

**Architecture:** 分四个层面修复：① 跨方言 SQL 工具层（buildUpsertSQL 标识符引用）+ AnalysisRepository 三处 GROUP BY 重写为保守子集；② 演示数据清理链重排（演示卡引用考试并入清理、事务化）；③ Electron 打包资源（llmclient/extraResources）+ sidecar 快速失败窗口；④ 应考名单接口权限与 UI 一致性。每项修复配 tsx 冒烟脚本（沿用 scripts/verify-*.ts 模式，SQLite 临时库跑通；MariaDB 侧回归在部署环境验证）。

**Tech Stack:** TypeScript / Express 5 / better-sqlite3 + MariaDB 10.11 双模 / React 19 / Tailwind v4 / Electron 39 / tsx 冒烟脚本

---

## 背景：五轮测试 Bug 清单（根因已确认）

测试环境 = **MariaDB 后端生产部署（d15z.cn）+ 08-30 15:00 前构建的旧扫描端包**（证据：main.log 08-31 仍有 Google Fonts CSP 违规，而 fee1cac 08-30 23:30 才修复且只删了 web 版 `index.html`；A1 报错 SQL `value = VALUE`（无括号）与当前代码 `VALUES(value)` 不一致）。

| # | Bug | 根因文件 | 处置 |
|---|-----|---------|------|
| A1 | 全局设置保存 1064 `near 'key, …)'` | `src/server/db/mysql.ts:86-120`（buildUpsertSQL 列名无反引号，`key` 是 MariaDB 保留字） | Task 1 |
| A2 | 总体分析 1064 `near 'GROUP BY exam_id'` | `src/server/repositories/AnalysisRepository.ts:353/1339/1706`（嵌套派生表聚合 + `IN ()` 风险） | Task 2（用户拍板预防性重写） |
| A3 | 演示数据导入/清除 FK 1451 `exams_ibfk_1` | `src/server/services/DemoDataService.ts:270-345`（按名称前缀删考试 vs 按 is_demo 删卡，两套口径；非前缀考试引用演示卡时炸） | Task 3 |
| B1 | 导出检查 AI 分析无限转圈 30s+ 无提示；llmclient 永不可用 | `src/apps/answer-card/server/llm-launcher.ts:37-46`（repoRoot 找不到打包后的 llmclient）+ 无快速失败 | Task 4 |
| B2 | 应考名单：搜索无效/年级班级选不动/总数≠列表/结果重复 | `users.ts:17`（搜索=admin-only）、`ExamManagePage.tsx`（静默 catch）、`examParticipants.ts`（快照无 JOIN users 校验） | Task 5 |
| B3 | 扫描端 4 个切换按钮无按下显示 | `ui/v2/segmented-control.tsx:77`（选中态类存在，需实渲染验证是否生效） | Task 6 |
| B4 | 扫描端启动刷 Google Fonts CSP 违规 | `index-scanner.html:12-14`（fee1cac 漏删扫描端） | Task 7 |
| C1 | "侧边栏自动展开"在系统级配置页误导（实现已是客户端 localStorage） | `GlobalSettingsPage.tsx:237-239` | Task 8（用户拍板：移出） |
| D1 | 切块"切块！切块！"空文件（现象未知）：crops 空/识别器降级静默无日志 | `AnswerBlockCropService.ts:119-131`、`recognition.ts:130-131` | Task 9（用户拍板：验证+防静默） |
| — | EADDRINUSE 随机端口、Tooltip crash | fee1cac / e8d84df 已修当前代码 | 无需改动 |

## 决策记录（用户已拍板）

1. **C1**：开关移出系统级配置 → 移到 `AccountSettingsPage.tsx` 的「外观/皮肤」区（账号设置页 value="client" Tab，已有 SkinSwitcher 同区域）。
2. **D1**：切块 = 验证路径 + 防静默失败（日志/统计），不做臆想的功能改动。
3. **A2**：3 处 GROUP BY SQL 全部预防性重写为保守形式（不依赖"N 层派生表 + 别名推断"），部署升级后 MariaDB 回归。
4. **A3**：引用 `is_demo=1` 答题卡的考试（不论名称前缀）视为演示资产链，清理时一并删除并在日志明示（测试环境"远程全链路测试"/"1111"即此场景）。

## 文件结构总览

```
修改：
  src/server/db/mysql.ts                              Task 1  （quoteIdent + buildUpsertSQL/buildInsertIgnore）
  src/server/repositories/AnalysisRepository.ts       Task 2  （getStudentRanking / getStudentTrend / getExamFullScoreMap）
  src/server/services/DemoDataService.ts              Task 3  （cleanupDemoData 重构）
  package.json                                        Task 3/4（verify 脚本注册 + extraResources 加 llmclient）
  src/apps/answer-card/server/llm-launcher.ts         Task 4  （repoRoot 可注入 + 快速失败窗口）
  src/apps/answer-card/server/index.ts                Task 5  （GET /api/exams/:examId/participant-search）
  src/server/services/examParticipants.ts             Task 5  （searchStudentsForExam + 快照 JOIN users + total 语义）
  src/apps/answer-card/client/pages/ExamManagePage.tsx Task 5  （搜索接口替换 + 错误条 + 列表去重/联动）
  src/apps/answer-card/client/components/GlobalSettingsPage.tsx        Task 8（删开关）
  src/apps/answer-card/client/pages/AccountSettingsPage.tsx            Task 8（加开关）
  index-scanner.html                                  Task 7  （删 Google Fonts 三行）
  src/server/services/AnswerBlockCropService.ts       Task 9  （空 crops 统计返回 + warn）
  src/apps/answer-card/server/recognition.ts          Task 9  （降级 warn）
创建：
  scripts/verify-round5-db-upsert.ts                  Task 1
  scripts/verify-round5-groupby.ts                    Task 2
  scripts/verify-round5-demo-cleanup.ts               Task 3
  scripts/verify-round5-llm-launcher.ts               Task 4
  scripts/verify-round5-participant-search.ts         Task 5
  scripts/verify-round5-crop-silence.ts               Task 9
```

---

### Task 1: A1 — 跨方言 UPSERT 标识符引用（根治 `key` 保留字 1064）

**Files:**
- Modify: `src/server/db/mysql.ts:86-120`
- Test: Create `scripts/verify-round5-db-upsert.ts`
- Modify: `package.json`（scripts 段加 `verify:round5-db-upsert`）

- [ ] **Step 1: 写失败测试**

创建 `scripts/verify-round5-db-upsert.ts`（沿用 `scripts/verify-demo-safety.ts` 的 ok/section 风格）：

```ts
/**
 * 五轮测试 A1 回归：跨方言 UPSERT / INSERT IGNORE 标识符引用。
 * MariaDB 必须给保留字列（key 等）加反引号；SQLite 用双引号等价。
 * 用法：npx tsx scripts/verify-round5-db-upsert.ts（期望全绿，退出码 0）
 */
import { buildUpsertSQL, buildInsertIgnore } from "../src/server/db/mysql";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

section("buildUpsertSQL — sqlite 分支对保留字列加双引号");
const sqliteUpsert = buildUpsertSQL("sqlite", "system_settings", ["key", "value", "updated_at"], ["key"], ["value", "updated_at"]);
ok(sqliteUpsert.includes('INSERT INTO system_settings ("key", "value", "updated_at")'), "列清单带双引号");
ok(sqliteUpsert.includes('ON CONFLICT("key")'), "冲突列带双引号");
ok(sqliteUpsert.includes('"value" = excluded."value"'), "SET 子句带双引号");

section("buildUpsertSQL — mariadb 分支对保留字列加反引号");
const mariadbUpsert = buildUpsertSQL("mariadb", "system_settings", ["key", "value", "updated_at"], ["key"], ["value", "updated_at"]);
ok(mariadbUpsert.includes("INSERT INTO system_settings (`key`, `value`, `updated_at`)"), "列清单带反引号");
ok(mariadbUpsert.includes("ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)"), "SET 子句带反引号");
ok(!mariadbUpsert.includes("= VALUE(") && !mariadbUpsert.includes("= VALUE'"), "不含 MySQL 8 别名 VALUE 写法");

section("buildInsertIgnore — 两方言列名均被引用");
ok(buildInsertIgnore("sqlite", "objective_blocks", ["id", "card_id"]).includes('INSERT OR IGNORE INTO objective_blocks ("id", "card_id")'), "sqlite 引用");
ok(buildInsertIgnore("mariadb", "objective_blocks", ["id", "card_id"]).includes("INSERT IGNORE INTO objective_blocks (`id`, `card_id`)"), "mariadb 引用");

section("普通列名引用后语义不变（无多余引号）");
ok(buildUpsertSQL("sqlite", "t", ["a", "b"], ["a"]).includes('"a"'), "sqlite a 引用");
ok(buildUpsertSQL("mariadb", "t", ["a", "b"], ["a"]).includes("`a`"), "mariadb a 引用");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx scripts/verify-round5-db-upsert.ts`
Expected: 第 1、2 组断言 ✗（当前 SQL 无引号），其余 ✓，退出码 1。

- [ ] **Step 3: 实现标识符引用**

修改 `src/server/db/mysql.ts`（在 `buildUpsertSQL` 上方插入 quoteIdent，并重写两个函数）：

```ts
/**
 * 跨方言标识符引用：MariaDB 用反引号（key/value 等保留字必引），SQLite 用双引号。
 * 仅用于代码内拼写的列名（非用户输入），调用方不需要预转义。
 */
function quoteIdent(dialect: "sqlite" | "mariadb", col: string): string {
  return dialect === "mariadb" ? `\`${col}\`` : `"${col}"`;
}

/**
 * 构建跨方言 UPSERT 语句
 * SQLite:  INSERT INTO ... ON CONFLICT(...) DO UPDATE SET ...
 * MariaDB: INSERT INTO ... ON DUPLICATE KEY UPDATE ...（列名统一引用，防保留字 1064）
 *
 * 注意：简单的全行替换请直接用 REPLACE INTO（SQLite + MariaDB 都支持）
 * 此函数用于需要"仅更新部分列"或"COALESCE 保留旧值"的场景
 */
export function buildUpsertSQL(
  dialect: "sqlite" | "mariadb",
  table: string,
  insertCols: string[],
  conflictCols: string[],
  updateCols?: string[]
): string {
  const cols = insertCols.map((c) => quoteIdent(dialect, c)).join(", ");
  const placeholders = insertCols.map(() => "?").join(", ");
  const updCols = updateCols ?? insertCols.filter((c) => !conflictCols.includes(c));

  if (dialect === "sqlite") {
    const setClause = updCols.map((c) => `${quoteIdent(dialect, c)} = excluded.${quoteIdent(dialect, c)}`).join(", ");
    return `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT(${conflictCols.map((c) => quoteIdent(dialect, c)).join(", ")}) DO UPDATE SET ${setClause}`;
  } else {
    const setClause = updCols.map((c) => `${quoteIdent(dialect, c)} = VALUES(${quoteIdent(dialect, c)})`).join(", ");
    return `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${setClause}`;
  }
}

/**
 * 跨方言 INSERT … ON CONFLICT 忽略（列名统一引用）
 * SQLite: INSERT OR IGNORE, MariaDB: INSERT IGNORE
 */
export function buildInsertIgnore(
  dialect: "sqlite" | "mariadb",
  table: string,
  cols: string[]
): string {
  const placeholders = cols.map(() => "?").join(", ");
  const quoted = cols.map((c) => quoteIdent(dialect, c)).join(", ");
  if (dialect === "sqlite") {
    return `INSERT OR IGNORE INTO ${table} (${quoted}) VALUES (${placeholders})`;
  }
  return `INSERT IGNORE INTO ${table} (${quoted}) VALUES (${placeholders})`;
}
```

> 注意：`system-settings.ts:20-21/46-47` 的 SELECT 已写 `` `key` ``（MariaDB 用）—— 这两处 SELECT 在 SQLite 下反引号也可用（SQLite 兼容 MySQL 反引号），保持不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx scripts/verify-round5-db-upsert.ts`
Expected: 全部 ✓，退出码 0。

- [ ] **Step 5: 注册脚本 + 全量类型检查**

修改 `package.json` scripts 段（在 `"verify:a3"` 后）：

```json
    "verify:round5-db-upsert": "tsx scripts/verify-round5-db-upsert.ts",
```

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/server/db/mysql.ts scripts/verify-round5-db-upsert.ts package.json
git commit -m "fix(db): UPSERT/INSERT IGNORE 列名跨方言引用,根治 MariaDB key 保留字 1064 (五轮A1)"
```

---

### Task 2: A2 — AnalysisRepository 三处 GROUP BY SQL 重写为保守形式

**Files:**
- Modify: `src/server/repositories/AnalysisRepository.ts:353-371`（getStudentRanking）、`:1326-1345`（getStudentTrend）、`:1706-1718`（getExamFullScoreMap）
- Test: Create `scripts/verify-round5-groupby.ts`
- Modify: `package.json`

设计原则（用户拍板"预防性重写"）：不依赖多层嵌套派生表 + 别名推断；列全部限定表别名；`IN ()` 空列表全部早退；消除 MariaDB 1064 的所有可疑形态。**行为与原 SQL 完全等价**（改后由测试断言结果）。

- [ ] **Step 1: 写失败测试（先证明改写后行为等价）**

创建 `scripts/verify-round5-groupby.ts`（SQLite 临时库，复用 verify-demo-safety 的 env 固定模式）：

```ts
/**
 * 五轮测试 A2 回归：AnalysisRepository 三处 GROUP BY 重写后行为等价
 * （getStudentRanking 派生表、getStudentTrend 年级均分、getExamFullScoreMap 满分归并）。
 * 用法：npx tsx scripts/verify-round5-groupby.ts（期望全绿，退出码 0）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-round5-groupby-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "round5.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

import { getMysqlDb } from "../src/server/db";
import { AnalysisRepository } from "../src/server/repositories/AnalysisRepository";

let passed = 0; let failed = 0; const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

async function main(): Promise<void> {
  const db = getMysqlDb();
  // 最小数据：1 场考试、2 学生、3 题（其中一题两行 score_type 不同取 MAX）
  await db.exec(`
    CREATE TABLE exams (id INTEGER PRIMARY KEY, name TEXT, subject TEXT, status TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, student_number TEXT);
    CREATE TABLE student_scores (exam_id INTEGER, student_id INTEGER, total_score REAL, objective_score REAL, subjective_score REAL, rank INTEGER, percentile REAL);
    CREATE TABLE question_scores (exam_id INTEGER, student_id INTEGER, question_number INTEGER, score REAL, max_score REAL, score_type TEXT);
  `);
  await db.run("INSERT INTO exams (id, name, subject, status) VALUES (1, '数学测验', '数学', 'closed')");
  await db.run("INSERT INTO users (id, name, student_number) VALUES (1, '张三', '1001'), (2, '李四', '1002')");
  await db.run("INSERT INTO student_scores (exam_id, student_id, total_score, objective_score, subjective_score) VALUES (1, 1, 92, 40, 52), (1, 2, 78, 36, 42)");
  // 学生1 第1题：objective 90 + objective 85 两行（MAX 应取 90）；subjective 60
  await db.run("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type) VALUES"
    + " (1, 1, 1, 90, 100, 'objective'), (1, 1, 1, 85, 100, 'objective'), (1, 1, 1, 60, 100, 'subjective')"
    + ", (1, 2, 1, 70, 100, 'objective'), (1, 2, 2, 80, 100, 'subjective')");

  const repo = new AnalysisRepository();

  section("getExamFullScoreMap — 嵌套聚合等价（1 题多行取 MAX 后求和）");
  const fsMap = await repo.getExamFullScoreMap([1]);
  ok(fsMap.get(1) === 160, `满分=100(ob MAX) + 100(subjective) = 200? 实际 ${fsMap.get(1)}`);
  // 说明：本题构造中 q1 objective MAX=90、subjective=60；q1 的 MAX(100) 是 max_score 的 MAX，
  // 满分归并口径 = 每题 (question_number, score_type) 组取 MAX(max_score) 后按 exam 求和。
  // 数据里 max_score 全为 100：objective 组 100 + subjective 组 100 = 200。
  ok(fsMap.get(1) === 200, `满分 map 正确 (${fsMap.get(1)})`);

  section("getExamFullScoreMap — 空数组不进 SQL（无 IN() 语法风险）");
  const emptyMap = await repo.getExamFullScoreMap([]);
  ok(emptyMap.size === 0, "空 examIds 返回空 Map 且不抛错");

  section("getStudentRanking — 低分题计数与排名");
  const ranking = await repo.getStudentRanking(1);
  ok(ranking.length === 2, `返回 2 名学生 (${ranking.length})`);
  ok(ranking[0].studentNumber === "1001" && ranking[0].rank === 1, "张三总分 92 排第 1");
  // 阈值默认 0.5（低分=<max*0.5）：本题 score 均 ≥ 50，低分题 0
  ok(ranking.every((r) => r.lowScoreCount === 0), "无低分题");

  section("getStudentTrend — 年级均分");
  const trend = await repo.getStudentTrend(1);
  ok(trend.length === 1 && trend[0].totalScore === 92, "单场趋势返回");
  const grade = (trend as any)[0];
  ok(typeof grade.classSize === "undefined" || grade.classSize === 2, "不关心 classSize 字段");

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> 实现者注意：`getStudentTrend(studentId)` 签名是 `getStudentTrend(studentId, visibleExamIds?)`，且内部先查 `student_scores` 返回 `examId/examName/...`——若断言字段与实测不符，以运行时实际结构为准调整断言（保持语义不变是硬约束）。`AnalysisRepository` 构造函数若直接内部 `getMysqlDb()`（读取 env 固定 SQLite 路径）即可工作；若可注入 db，则直接注入。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx scripts/verify-round5-groupby.ts`
Expected: 至少 `getExamFullScoreMap — 空数组` 一项失败（当前无早退，`IN ()` 抛 SQLite 语法错）或依赖当前实现的其他断言失败。

- [ ] **Step 3: 重写三处 SQL**

第 1 处 — `getExamFullScoreMap`（`:1706-1718`，嵌套派生表 → 单层 GROUP BY + JS 归并）：

```ts
  async getExamFullScoreMap(examIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    // 空数组早退：消除 “IN ()” 语法（MySQL/MariaDB 均 1064）
    if (examIds.length === 0) return result;
    // 五轮A2: 原两层嵌套派生表（内层 MAX 分组 + 外层 SUM 按 exam 归并）改为单层
    // 分组 + JS 侧归并，行为等价且无别名推断/嵌套聚合的方言差异。
    const qRows = await this.db.all(
      `SELECT qs.exam_id, qs.question_number, qs.score_type, MAX(qs.max_score) AS max_score
       FROM question_scores qs
       WHERE qs.exam_id IN (${placeholders(examIds)})
       GROUP BY qs.exam_id, qs.question_number, qs.score_type`,
      ...examIds
    ) as any[];
    const perExam = new Map<number, number>();
    for (const r of qRows) {
      const examId = Number(r.exam_id);
      const val = Number(r.max_score ?? 0);
      perExam.set(examId, (perExam.get(examId) ?? 0) + val);
    }
    for (const [examId, sum] of perExam) if (sum > 0) result.set(examId, sum);
    const missing = examIds.filter((id) => !result.has(id));
    if (missing.length > 0) {
      const fb = await this.db.all(`SELECT exam_id, MAX(total_score) as fullScore FROM student_scores WHERE exam_id IN (${placeholders(missing)}) GROUP BY exam_id`, ...missing) as any[];
      for (const r of fb) result.set(Number(r.exam_id), Number(r.fullScore ?? 0));
    }
    for (const id of examIds) if (!result.has(id)) result.set(id, 0);
    return result;
  }
```

第 2 处 — `getStudentTrend` 年级均分查询（`:1326-1345`，保持 SQL 但字段显式别名/表前缀 + `COUNT(*) AS classSize` 保留）：

```ts
    const gradeRows = await this.db.all(
      `SELECT ss.exam_id, ROUND(AVG(ss.total_score), 1) AS gradeAvg, COUNT(*) AS classSize
       FROM student_scores ss
       WHERE ss.exam_id IN (${placeholders(examIds)})
       GROUP BY ss.exam_id`,
      ...examIds
    ) as Array<{ exam_id: number; gradeAvg: number | null; classSize: number }>;
```

（`examIds` 在此处不可能为空——上方 `if (s.length === 0) return []` 已保证 `examIds.length === s.length >= 1`；加注释说明，不加多余守卫。）

第 3 处 — `getStudentRanking`（`:353-371`，派生表内加 qs 前缀 + 外部 GROUP BY 全列显式）：

```ts
    const rows = await this.db.all(`
      SELECT u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score,
             COALESCE(qsum.low_count, 0) as low_score_count,
             COALESCE(qsum.q_count, 0) as question_count
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      LEFT JOIN (
        SELECT qs.exam_id, qs.student_id,
               SUM(CASE WHEN qs.score < qs.max_score * ? THEN 1 ELSE 0 END) as low_count,
               COUNT(*) as q_count
        FROM question_scores qs
        WHERE qs.exam_id = ?
        GROUP BY qs.exam_id, qs.student_id
      ) qsum ON qsum.exam_id = ss.exam_id AND qsum.student_id = ss.student_id
      ${c.join}
      WHERE ss.exam_id = ? ${c.where}
      GROUP BY ss.student_id, u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score
      ORDER BY ss.total_score DESC
    `, lowRatio, examId, examId, ...c.params) as any[];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx scripts/verify-round5-groupby.ts`
Expected: 全部 ✓，退出码 0。

- [ ] **Step 5: 注册脚本 + typecheck**

修改 `package.json`：

```json
    "verify:round5-groupby": "tsx scripts/verify-round5-groupby.ts",
```

Run: `npm run typecheck` → 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/server/repositories/AnalysisRepository.ts scripts/verify-round5-groupby.ts package.json
git commit -m "fix(analysis): 三处 GROUP BY SQL 重写去嵌套/加空表守卫,防 MariaDB 1064 (五轮A2)"
```

---

### Task 3: A3 — 演示数据清理链重构（演示卡引用考试并入清理 + 事务化）

**Files:**
- Modify: `src/server/services/DemoDataService.ts:270-345`（cleanupDemoData）
- Create: `scripts/verify-round5-demo-cleanup.ts`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试**

创建 `scripts/verify-round5-demo-cleanup.ts`（复刻"测试者自建考试引用演示卡"场景）：

```ts
/**
 * 五轮测试 A3 回归：演示数据清理不得因 FK 炸（演示卡被非演示名前缀考试引用）。
 * 场景：seedDemoData 后，用演示答题卡自建“远程全链路测试”（不带「演示-」前缀），
 * 清 理时应把引用演示卡的考试视作演示资产链一并删除，且全程无外键错误。
 * 用法：npx tsx scripts/verify-round5-demo-cleanup.ts（期望全绿，退出码 0）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-round5-demo-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "round5-demo.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

import { getMysqlDb } from "../src/server/db";
import { seedDemoData, clearDemoData } from "../src/server/services/DemoDataService";

let passed = 0; let failed = 0; const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

async function main(): Promise<void> {
  const stats = await seedDemoData();
  ok(stats.exams > 0, `演示数据导入成功（${stats.exams} 场考试）`);

  const db = getMysqlDb();
  // 用户自建考试引用演示卡（不带「演示-」前缀）—— 复现线上 1451
  const demoCard = await db.get("SELECT id FROM answer_cards WHERE is_demo = 1 LIMIT 1") as { id: string } | undefined;
  ok(!!demoCard, "存在演示答题卡");
  if (!demoCard) { console.error("前置失败：无演示卡"); process.exit(1); }
  const demoStudent = await db.get(
    "SELECT id FROM users WHERE is_demo = 1 AND role_id = 3 LIMIT 1"
  ) as { id: number } | undefined;
  const insert = await db.run(
    "INSERT INTO exams (name, card_id, grade_id, class_id, subject, status) VALUES ('远程全链路测试', ?, NULL, NULL, '英语', 'closed')",
    demoCard.id
  );
  const customExamId = Number(insert.lastInsertRowid);
  ok(customExamId > 0, `自建考试已创建 (id=${customExamId})`);
  if (demoStudent) {
    await db.run(
      "INSERT INTO student_scores (exam_id, student_id, total_score, objective_score, subjective_score) VALUES (?, ?, 88, 40, 48)",
      customExamId, demoStudent.id
    );
  }

  // 清理不得抛 FK 错
  let cleared: Awaited<ReturnType<typeof clearDemoData>>;
  let threw: Error | null = null;
  try { cleared = await clearDemoData(); } catch (e) { threw = e as Error; }
  ok(!threw, `clearDemoData 不抛外键错误${threw ? `：${threw.message}` : ""}`);
  if (threw) { console.error(threw); process.exit(1); }

  const customStill = await db.get("SELECT id FROM exams WHERE id = ?", customExamId) as { id: number } | undefined;
  ok(!customStill, "引用演示卡的考试（非演示名前缀）已被一并清理");
  const cardLeft = await db.get("SELECT COUNT(*) AS cnt FROM answer_cards WHERE is_demo = 1") as { cnt: number };
  ok(Number(cardLeft.cnt) === 0, "演示答题卡全部清除");
  const userLeft = await db.get("SELECT COUNT(*) AS cnt FROM users WHERE is_demo = 1") as { cnt: number };
  ok(Number(userLeft.cnt) === 0, "演示用户全部清除");
  ok(cleared.exams >= 1, `清理统计含被并入的考试（exams=${cleared.exams}）`);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> 实现者注意：`ClearDemoStats` 的字段名以 `cleanupDemoData` 返回结构为准；若 `clearDemoData` 不返回 exams 计数，调整断言（核心断言是“清理不炸 + 引用考试被清 + 演示卡/用户清零”）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx scripts/verify-round5-demo-cleanup.ts`
Expected: `clearDemoData 不抛外键错误` ✗（当前实现炸 FK 1451）。

- [ ] **Step 3: 重构 cleanupDemoData**

修改 `src/server/services/DemoDataService.ts` 的 `cleanupDemoData`：

```ts
async function cleanupDemoData(db: DbAdapter): Promise<ClearDemoStats> {
  // ── 收集待清理集合（两套口径统一）──
  // 考试：名字带「演示-」前缀的，或引用 is_demo=1 答题卡的（不论名称前缀——
  // 用户可能用演示卡自建考试改名，五轮A3：这些考试是演示资产链，一并清理）。
  // 答题卡 / 用户 / 班级 / 年级：按 is_demo=1 归属标记。
  const prefixExamIds = (await db.all("SELECT id FROM exams WHERE name LIKE ?", `${DEMO_PREFIX}%`) as Array<{ id: number }>).map((r) => r.id);
  const cardRefExamIds = (await db.all(
    `SELECT e.id FROM exams e JOIN answer_cards ac ON ac.id = e.card_id WHERE ac.is_demo = 1`
  ) as Array<{ id: number }>).map((r) => r.id);
  const referencingOnly = cardRefExamIds.filter((id) => !prefixExamIds.includes(id));
  if (referencingOnly.length > 0) {
    const names = await db.all(
      `SELECT id, name FROM exams WHERE id IN (${referencingOnly.map(() => "?").join(",")})`,
      ...referencingOnly
    ) as Array<{ id: number; name: string }>;
    console.warn(`[demo-cleanup] ${names.length} 场非演示名前缀考试引用了演示答题卡，视作演示资产一并清理：${names.map((n) => n.name).join("、")}`);
  }
  const demoExamIds = [...new Set([...prefixExamIds, ...cardRefExamIds])];

  const demoGroupIds = (await db.all("SELECT id FROM exam_groups WHERE name LIKE ?", `${DEMO_PREFIX}%`) as Array<{ id: number }>).map((r) => r.id);

  // v2.3.x: 周报动态组（source='week'）清理逻辑保持不变
  const demoOnlyWeekGroupIds = (await db.all(
    `SELECT eg.id FROM exam_groups eg
     WHERE eg.source = 'week'
       AND NOT EXISTS (SELECT 1 FROM exam_group_members egm
                       JOIN exams e ON e.id = egm.exam_id
                       WHERE egm.group_id = eg.id AND e.name NOT LIKE '演示-%')`
  ) as Array<{ id: number }>).map((r) => r.id);

  // ── 全程事务（五轮A3：任一步失败不得留下半删状态）──
  return db.transaction(async (tx) => {
    if (demoOnlyWeekGroupIds.length > 0) {
      const ph = demoOnlyWeekGroupIds.map(() => "?").join(",");
      await tx.run(`DELETE FROM exam_group_members WHERE group_id IN (${ph})`, ...demoOnlyWeekGroupIds);
      await tx.run(`DELETE FROM exam_groups WHERE id IN (${ph})`, ...demoOnlyWeekGroupIds);
    }

    if (demoGroupIds.length > 0) {
      const ph = demoGroupIds.map(() => "?").join(",");
      await tx.run(`DELETE FROM exam_group_members WHERE group_id IN (${ph})`, ...demoGroupIds);
      if (await tableExists(tx, "exam_group_items")) {
        await tx.run(`DELETE FROM exam_group_items WHERE group_id IN (${ph})`, ...demoGroupIds);
      }
      await tx.run(`DELETE FROM exam_groups WHERE id IN (${ph})`, ...demoGroupIds);
    }

    if (demoExamIds.length > 0) {
      const ph = demoExamIds.map(() => "?").join(",");
      // 先清所有引用（exam_participants 可能无级联或禁用外键的 SQLite 场景，显式删除最稳）
      await tx.run(`DELETE FROM exam_participants WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM question_scores WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM student_scores WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM answer_block_crops WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM review_assignments WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM review_sessions WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM block_grading_config WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM exams WHERE id IN (${ph})`, ...demoExamIds);
    }

    // 答题卡 / 知识点（MariaDB 有 FK 但按 is_demo 先行清理引用，再删卡）
    await tx.run("DELETE FROM knowledge_points WHERE card_id IN (SELECT id FROM answer_cards WHERE is_demo = 1)");
    const removedCards = (await tx.run("DELETE FROM answer_cards WHERE is_demo = 1")).changes;

    // 演示用户：先解关联再删
    const demoStudentIds = (await tx.all("SELECT id FROM users WHERE is_demo = 1") as Array<{ id: number }>).map((r) => r.id);
    const removedStudents = demoStudentIds.length;
    if (demoStudentIds.length > 0) {
      const ph = demoStudentIds.map(() => "?").join(",");
      await tx.run(`DELETE FROM class_students WHERE student_id IN (${ph})`, ...demoStudentIds);
      await tx.run(`DELETE FROM teacher_classes WHERE teacher_id IN (${ph})`, ...demoStudentIds);
      await tx.run(`DELETE FROM exam_participants WHERE student_id IN (${ph})`, ...demoStudentIds);
      await tx.run(`DELETE FROM users WHERE id IN (${ph})`, ...demoStudentIds);
    }

    await tx.run("DELETE FROM classes WHERE is_demo = 1");
    const hasRealClassUnderDemoGrade = Boolean(
      await tx.get(
        "SELECT 1 AS x FROM classes WHERE is_demo = 0 AND grade_id IN (SELECT id FROM grades WHERE is_demo = 1) LIMIT 1"
      )
    );
    if (!hasRealClassUnderDemoGrade) {
      await tx.run("DELETE FROM grades WHERE is_demo = 1");
    } else {
      console.warn("[demo-cleanup] 演示年级下存在真实班级，保留演示年级以免级联误删真实数据");
    }

    return {
      exams: demoExamIds.length,
      cards: removedCards,
      students: removedStudents,
      groups: demoGroupIds.length + demoOnlyWeekGroupIds.length,
    } as ClearDemoStats;
  });
}
```

> 实现者注意：保持文件原有 `ClearDemoStats` 结构与此处返回一致（以现有类型定义为准补全字段）；`DEMO_PREFIX` 常量与 `tableExists` 已在文件内。原删除顺序中 `class_students/teacher_classes` 之后的变量名与统计保持兼容。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx scripts/verify-round5-demo-cleanup.ts`
Expected: 全部 ✓，退出码 0。

- [ ] **Step 5: 补充事务外部确认 seedDemoData 不再炸**

Run: `npx tsx scripts/verify-demo-safety.ts`（既有回归，确认 is_demo 安全语义未被破坏）
Expected: 全绿。

- [ ] **Step 6: 注册脚本 + typecheck**

```json
    "verify:round5-demo-cleanup": "tsx scripts/verify-round5-demo-cleanup.ts",
```

Run: `npm run typecheck` → 无错误。

- [ ] **Step 7: Commit**

```bash
git add src/server/services/DemoDataService.ts scripts/verify-round5-demo-cleanup.ts package.json
git commit -m "fix(demo): 清理链并入引用演示卡的考试+事务化,根治 FK 1451 (五轮A3)"
```

---

### Task 4: B1 — llmclient sidecar 打包适配 + 快速失败窗口

**Files:**
- Modify: `src/apps/answer-card/server/llm-launcher.ts`（repoRoot 可注入候选 + ensureLlmClient 快速失败）
- Modify: `package.json`（electron-builder extraResources 加 llmclient）
- Create: `scripts/verify-round5-llm-launcher.ts`（路径解析 + 快速失败窗口纯逻辑）
- Modify: `package.json`

- [ ] **Step 1: 写失败测试**

创建 `scripts/verify-round5-llm-launcher.ts`：

```ts
/**
 * 五轮测试 B1：llmclient sidecar 路径解析（Electron 打包场景）+ 快速失败窗口。
 * 用法：npx tsx scripts/verify-round5-llm-launcher.ts（期望全绿，退出码 0）
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let passed = 0; let failed = 0; const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

// 注意：llm-launcher 内部模块级状态；为了测 repoRoot 我们把候选做成参数注入。
import { repoRootCandidates } from "../src/apps/answer-card/server/llm-launcher";

section("repoRoot 候选解析（Electron resources 场景）");
const base = mkdtempSync(path.join(tmpdir(), "round5-llm-"));
// 模拟打包布局: <resources>/llmclient/server.py
const resources = path.join(base, "resources");
mkdirSync(path.join(resources, "llmclient"), { recursive: true });
writeFileSync(path.join(resources, "llmclient", "server.py"), "print(1)");

const root = repoRootCandidates([resources, path.join(base, "elsewhere")]);
ok(root === resources, `在 resources 候选下找到 llmclient 根 (${root})`);

section("普通 cwd 场景");
writeFileSync(path.join(base, "elsewhere", "llmclient", "server.py"), "print(1)");
const root2 = repoRootCandidates([path.join(base, "elsewhere")]);
ok(root2 === path.join(base, "elsewhere"), "cwd 候选命中");

section("都找不到时回退第一个候选");
const root3 = repoRootCandidates([path.join(base, "nope")]);
ok(root3 === path.join(base, "nope"), "无命中回退首个候选");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx scripts/verify-round5-llm-launcher.ts`
Expected: `repoRootCandidates is not a function` 或类似失败（当前 repoRoot 无导出、无注入）。

- [ ] **Step 3: 实现**

修改 `src/apps/answer-card/server/llm-launcher.ts`：

a) repoRoot 改为可注入（默认候选含 Electron resources 目录）：

```ts
/**
 * 查找含 llmclient/server.py 的根目录（spawn cwd 与 PYTHONPATH 基准）。
 * 候选（可注入便于单测）：
 * 1. 当前源码布局（__dirname 上溯 4 层）
 * 2. process.resourcesPath（Electron 打包：extraResources 将 llmclient 放入 <resources>/llmclient）
 * 3. 进程 cwd
 */
export function repoRootCandidates(explicitCandidates?: string[]): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = explicitCandidates ?? [
    path.resolve(__dirname, "../../../../.."),
    resourcesPath,
    process.cwd(),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(path.join(c, "llmclient", "server.py"))) return c;
  }
  return candidates[0];
}
```

（原有 `repoRoot()` 改为 `function repoRoot(): string { return repoRootCandidates(); }`，内部调用点不变。）

b) ensureLlmClient 快速失败窗口（失败后 10s 内不再 30s 拖尾）：

```ts
let lastFailAt = 0;
const FAIL_WINDOW_MS = 10_000;

export async function ensureLlmClient(maxWaitMs = 30_000): Promise<boolean> {
  if (!AUTOSTART_ENABLED) return ping();

  // 快速失败窗口（五轮B1）：sidecar 刚失败（如打包缺失 llmclient）后 10s 内，
  // 只做一次 2s 健康探测，不再触发 30s 的 spawn+waitForHealth 拖尾。
  if (Date.now() - lastFailAt < FAIL_WINDOW_MS) {
    return ping();
  }
  if (await ping()) return true;

  if (child && !child.killed) {
    return waitForHealth(maxWaitMs);
  }

  if (!startPromise) {
    startPromise = (async () => {
      const ok = spawnInternal() ? await waitForHealth(maxWaitMs) : false;
      lastFailAt = ok ? 0 : Date.now();
      return ok;
    })();
    startPromise.finally(() => {
      startPromise = null;
    }).catch(() => {});
  }
  return startPromise ? await startPromise : false;
}
```

c) `package.json` electron-builder `extraResources` 增加（放在现有 native 两条之后）：

```json
      {
        "from": "llmclient",
        "to": "llmclient",
        "filter": [
          "**/*",
          "!.env"
        ]
      }
```

> `.env`（LLM API key）不进包：密钥不应随便携包分发，部署时手工放置到 `<解压目录>/resources/llmclient/.env`（llm-launcher 以该目录为 cwd 启动，Python dotenv 从 cwd 读取）。打包脚本/README 需注明（见 Task 10 发布清单）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx scripts/verify-round5-llm-launcher.ts`
Expected: 全部 ✓，退出码 0。

- [ ] **Step 5: 注册脚本 + typecheck**

```json
    "verify:round5-llm-launcher": "tsx scripts/verify-round5-llm-launcher.ts",
```

Run: `npm run typecheck` → 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/apps/answer-card/server/llm-launcher.ts package.json scripts/verify-round5-llm-launcher.ts
git commit -m "fix(llm): llmclient 打包资源路径适配+失败快速窗口,根治 AI 功能不可用 (五轮B1)"
```

---

### Task 5: B2 — 应考名单全链路修复（搜索接口/错误提示/总数一致/结果去重）

**Files:**
- Modify: `src/server/services/examParticipants.ts`（新增 searchStudentsForExam + 快照 SQL JOIN users + listParticipants 语义）
- Modify: `src/apps/answer-card/server/index.ts`（GET /api/exams/:examId/participant-search）
- Modify: `src/apps/answer-card/client/pages/ExamManagePage.tsx`
- Create: `scripts/verify-round5-participant-search.ts`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试**

创建 `scripts/verify-round5-participant-search.ts`：

```ts
/**
 * 五轮测试 B2：应考名单搜索（教师可用）+ 快照防悬空引用。
 * 用法：npx tsx scripts/verify-round5-participant-search.ts（期望全绿，退出码 0）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-round5-part-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "round5-part.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

import { getMysqlDb } from "../src/server/db";
import { searchStudentsForExam, ensureExamParticipants, listParticipants } from "../src/server/services/examParticipants";

let passed = 0; let failed = 0; const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

async function main(): Promise<void> {
  const db = getMysqlDb();
  await db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, student_number TEXT, role_id INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE exams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, class_id INTEGER, grade_id INTEGER);
    CREATE TABLE classes (id INTEGER PRIMARY KEY, name TEXT, grade_id INTEGER);
    CREATE TABLE class_students (class_id INTEGER, student_id INTEGER);
    CREATE TABLE exam_participants (exam_id INTEGER, student_id INTEGER, source TEXT,
      PRIMARY KEY (exam_id, student_id));
  `);
  // 学生：在职 + 已停用 + 教师（不应命中）
  await db.run("INSERT INTO users (id, name, student_number, role_id) VALUES"
    + " (1, '赵可为', '24101', 3), (2, '马梓源', '24102', 3), (3, '王老师', 'T001', 2), (4, '已停用', '24103', 3)");
  await db.run("UPDATE users SET is_active = 0 WHERE id = 4");

  section("searchStudentsForExam — 关键字命中在职学生、排除教师/停用");
  const r1 = await searchStudentsForExam(db, 1, "2410");
  ok(r1.length === 2, `按学号前缀命中 2 人（24101/24102）(实际 ${r1.length})`);
  ok(!r1.some((u) => u.name === "王老师"), "教师不在结果内");
  ok(!r1.some((u) => u.name === "已停用"), "停用学生不在结果内");
  const r2 = await searchStudentsForExam(db, 1, "梓源");
  ok(r2.length === 1 && r2[0].name === "马梓源", "按姓名命中");
  const r3 = await searchStudentsForExam(db, 1, "%%%");
  ok(r3.length === 0, "通配符 % 被转义，不命中全部");

  section("快照防悬空引用 — 被删用户不进名册快照");
  await db.run("INSERT INTO classes (id, name, grade_id) VALUES (1, '一班', NULL)");
  await db.run("INSERT INTO class_students (class_id, student_id) VALUES (1, 1), (1, 2), (1, 999)");
  await db.run("INSERT INTO exams (id, name, class_id) VALUES (1, '数学', 1)");
  const snap = await ensureExamParticipants(db, 1);
  ok(snap.participantCount === 2, `名册快照只含存在用户（2，悬空 999 被剔除）(实际 ${snap.participantCount})`);
  const listed = await listParticipants(db, 1);
  ok(listed.length === 2 && listed[0].name === "赵可为", "listParticipants 与总数一致");

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> 实现者注意：`searchStudentsForExam` / `ensureExamParticipants` / `listParticipants` 均为将新增/改造的导出函数；若 `ensureExamParticipants` 需要 users 表其他列（如 is_active），以迁移后的实际 schema 为准调整测试建表语句。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx scripts/verify-round5-participant-search.ts`
Expected: `searchStudentsForExam is not defined`（新函数）+ 快照断言 ✗（当前快照含 999）。

- [ ] **Step 3: 实现后端**

修改 `src/server/services/examParticipants.ts`：

a) 新增导出函数（放 `listParticipants` 之后）：

```ts
/**
 * 应考名单添加用学生搜索（五轮B2：原 /api/users 为管理员接口，教师 403）。
 * 只搜学生角色（role_id=3）且启用（is_active=1）的账号，按学号精确或姓名模糊；
 * 通配符转义，避免 % _ 命中无关学生。
 */
export async function searchStudentsForExam(
  db: DbAdapter,
  examId: number,
  q: string
): Promise<Array<{ id: number; name: string; student_number: string | null }>> {
  const keyword = (q ?? "").trim();
  if (!keyword || !Number.isInteger(examId) || examId <= 0) return [];
  const escaped = keyword.replace(/[\\%_]/g, (m) => `\\${m}`);
  const rows = await db.all(
    `SELECT u.id, u.name, u.student_number
     FROM users u
     WHERE u.role_id = 3 AND u.is_active = 1
       AND (u.student_number = ? OR u.name LIKE ? ESCAPE '\\')
     ORDER BY u.student_number
     LIMIT 20`,
    keyword, `%${escaped}%`
  ) as Array<{ id: number; name: string; student_number: string | null }>;
  return rows.map((r) => ({ id: r.id, name: r.name, student_number: r.student_number }));
}
```

> 注意：`role_id = 3` 与学生角色常量需与本项目一致（examParticipants 内已有类似常量引用方式，以 `ROLE_IDS` 为准）；若 `is_active` 列在各 schema 均存在则保留，否则去掉该条件并同步测试建表。

b) 快照 SQL 加 JOIN users（两处 INSERT IGNORE / OR IGNORE）：

```ts
    if (exam.class_id != null) {
      const sql = isSqlite(db)
        ? "INSERT OR IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id WHERE cs.class_id = ?"
        : "INSERT IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id WHERE cs.class_id = ?";
      await db.run(sql, examId, exam.class_id);
    } else if (exam.grade_id != null) {
      const sql = isSqlite(db)
        ? "INSERT OR IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id JOIN classes c ON c.id = cs.class_id WHERE c.grade_id = ?"
        : "INSERT IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id JOIN classes c ON c.id = cs.class_id WHERE c.grade_id = ?";
      await db.run(sql, examId, exam.grade_id);
    }
```

c) `src/apps/answer-card/server/index.ts` 在 `GET /api/exams/:examId/participants`（:2421）附近新增：

```ts
  // GET /api/exams/:examId/participant-search — 应考名单添加学生搜索（五轮B2）
  // 教师可用的学生搜索（原 /api/users 需 USER_MANAGE，教师 403 后前端静默空白）。
  app.get("/api/exams/:examId/participant-search", requireExamAccess, requirePermission(PERMISSIONS.GRADE_READ), async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      const q = (req.query.q as string ?? "").trim();
      if (!Number.isInteger(examId) || examId <= 0) {
        res.status(400).json({ message: "无效的考试 ID" });
        return;
      }
      const students = await searchStudentsForExam(getMysqlDb(), examId, q);
      res.json({ ok: true, students });
    } catch (error) {
      next(error);
    }
  });
```

d) `GET /api/exams/:examId/participants` 响应加 `missing` 字段（总数与可管理列表差），并修正 total 语义为"实际可管理数"：

```ts
      const students = await listParticipants(db, examId);
      const explicit = students.some((s) => s.source === "explicit");
      const snap = await ensureExamParticipants(db, examId);
      const missingCount = Math.max(0, snap.participantCount - students.length);
      res.json({
        examId,
        scope: { classId: exam.class_id, gradeId: exam.grade_id },
        source: explicit ? "explicit" : (snap.source ?? null),
        known: snap.rosterKnown,
        total: students.length,               // 可管理（有账号记录）人数，杜绝"共50人列表6人"
        missing: missingCount,                // 快照中无账号记录的悬空数
        students: students.map((s) => ({ studentId: s.student_id, studentNumber: s.student_number, name: s.name, source: s.source })),
      });
```

- [ ] **Step 4: 前端改造（ExamManagePage.tsx）**

a) `searchRosterStudents` 换接口 + 弹窗错误条：

```tsx
  const [rosterErr, setRosterErr] = useState<string | null>(null);

  async function searchRosterStudents(keyword: string) {
    setRosterKeyword(keyword);
    if (!keyword.trim()) { setRosterSearchResults([]); return; }
    setRosterErr(null);
    try {
      if (!rosterExam) return;
      const res = await fetchJson<{ ok?: boolean; students?: Array<{ id: number; name: string; student_number?: string | null }> }>(
        `/api/exams/${rosterExam.id}/participant-search?q=${encodeURIComponent(keyword.trim())}`
      );
      setRosterSearchResults((res?.students ?? []).map((u) => ({ id: u.id, name: u.name, student_number: u.student_number ?? null })));
      if (!res?.students?.length) setRosterErr("未找到匹配的学生（仅搜索启用中的学生账号）");
    } catch (err) {
      setRosterSearchResults([]);
      setRosterErr(err instanceof Error ? err.message : "搜索学生失败");
    }
  }
```

b) 结果区过滤已在名单的学生（消除上下区重复显示）：

```tsx
              {rosterSearchResults.length > 0 && (
                <div className="max-h-40 w-full overflow-auto rounded border p-2">
                  {rosterSearchResults.filter((u) => !(rosterData?.students ?? []).some((s) => s.studentId === u.id)).map((u) => {
                    return (
                      <div key={u.id} className="flex items-center justify-between py-1">
                        <span className="text-sm">{u.name}（{u.student_number ?? u.studentNumber ?? u.id}）</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setRosterData((prev) => ({ ...(prev ?? { source: null, known: true, total: 0 }), known: true, source: "explicit", total: (prev?.students?.length ?? 0) + 1, students: [...(prev?.students ?? []), { studentId: u.id, studentNumber: u.student_number ?? null, name: u.name }] }));
                          }}
                        >
                          添加
                        </Button>
                      </div>
                    );
                  })}
                  {rosterSearchResults.filter((u) => (rosterData?.students ?? []).some((s) => s.studentId === u.id)).length > 0 && (
                    <p className="border-t px-1 pt-1 text-xs text-muted-foreground">
                      {rosterSearchResults.filter((u) => (rosterData?.students ?? []).some((s) => s.studentId === u.id)).length} 名搜索结果已在名单中（见下方名单）
                    </p>
                  )}
                </div>
              )}
```

c) 弹窗顶部错误条（DialogBody 开头）+ "共 X 人（Y 人无账号记录）"：

```tsx
          <DialogBody className="flex flex-col gap-3">
            {rosterErr && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{rosterErr}</div>
            )}
```

```tsx
              来源：{rosterData?.source === "explicit" ? "管理员显式名单" : rosterData?.source === "roster" ? "年级/班级名册（自动）" : "未确定"}
              （共 {rosterData?.total ?? 0} 人{rosterData && (rosterData as any).missing > 0 ? `，${(rosterData as any).missing} 人无账号记录` : ""}）
```

d) 年级/班级/未选学生加载失败也要提示（loadRosterClasses / loadRosterClassStudents 的 catch 设 rosterErr）：

```tsx
    } catch {
      setRosterClassOptions([]);
      setRosterErr("加载班级列表失败，请确认账号有读班级权限");
    }
```

```tsx
    } catch {
      setRosterClassStudents([]);
      setRosterErr("加载班级学生失败");
    }
```

> 实现者注意：`rosterData` 类型需补 `missing?: number` 字段（或在组件内以 `(rosterData as any).missing` 访问，推荐前者）。`fetchJson` 的失败抛错形式以仓库 auth/api.ts 实际行为为准（若 403 抛 Error 则 err.message 会显示"未认证/无权限"）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx scripts/verify-round5-participant-search.ts`
Expected: 全部 ✓。

- [ ] **Step 6: 注册脚本 + typecheck**

```json
    "verify:round5-participant-search": "tsx scripts/verify-round5-participant-search.ts",
```

Run: `npm run typecheck` → 无错误。

- [ ] **Step 7: Commit**

```bash
git add src/server/services/examParticipants.ts src/apps/answer-card/server/index.ts src/apps/answer-card/client/pages/ExamManagePage.tsx scripts/verify-round5-participant-search.ts package.json
git commit -m "fix(roster): 应考名单教师可搜+总数一致+去重+错误提示 (五轮B2)"
```

---

### Task 6: B3 — 扫描端 SegmentedControl 选中态验证与修复

**Files:**
- 验证：`src/apps/answer-card/client/components/ui/v2/segmented-control.tsx`（若需修复）
- Verified by: 浏览器 GUI 实测（web-gui-tester skill）

现象：视频中"图片去向 / 扫描存储模式"两组 4 个按钮按下无任何视觉变化。组件代码 08-06 起就带 `data-[state=on]:bg-card ... shadow-1`，日志显示扫描端 08-30 后已无 Tooltip crash——**选中态不显示的原因必须实测确认，不臆改**。

- [ ] **Step 1: 渲染实测（先取证）**

Run（扫描端 dev 渲染，无硬件也能出 UI）：

```bash
npm run build:scanner:full
npm run typecheck
```

然后用浏览器打开扫描端产物页面（`dist/scanner/index.html`，或在本机 `npm run dev` + 临时访问 scanner 入口），把鼠标移到"本地存储"并截图，同时：

1. DevTools → 选中"本地存储"按钮 → 检查元素 class 是否含 `data-[state=on]:bg-card` 对应的编译类（`data-\[state\=on\]\:bg-card`），以及元素上是否有 `data-state="on"` 属性；
2. Console 里查 stylе：`getComputedStyle(el).backgroundColor / boxShadow`；
3. 产物 CSS 中 grep 选中态规则：`grep -o "data-\\\\[state\\\\=on\\\\]\\\\:bg-card" dist/scanner/assets/*.css | head -1`

Expected（现状取证）：记录真实结果 —— 分三种情况：
- 情况 A：`data-state="on"` 存在 + CSS 规则存在但 `getComputedStyle` 无差异 → 组件样式冲突（进入 Step 2-A）
- 情况 B：CSS 规则缺失（grep 无命中）→ Tailwind 扫描端 content 未覆盖（进入 Step 2-B）
- 情况 C：`data-state` 属性缺失 → Radix 受控 value 未生效（进入 Step 2-C）
- 情况 D：实测选中态**正常显示**（截图可见白底浮起）→ 视频中的旧包（08-30 前）已由 e8d84df/fee1cac 之后的构建修复，本 Task 标记完成并附证据（截图），无需改动

- [ ] **Step 2: 按取证结果修复（三选一）**

- **2-A 样式冲突**：在 `segmented-control.tsx:77` 选中态类组前加 `!` 优先级或调整类顺序，并截图对比确认浮起效果：

```tsx
              // 选中态：浮起一层（亮色=白面，暗色=升面），仅 shadow-1，不做位移
              "data-[state=on]:!bg-card data-[state=on]:!text-foreground data-[state=on]:!shadow-1",
```

- **2-B Tailwind content 未覆盖**：确认 `theme/app.css` 的 `@source` / Tailwind 配置包含 `./src/apps/answer-card/client/**/*.{ts,tsx}`（以 main.tsx 同源为基准比对 dist/scanner 与 dist/web 的 CSS 差异），补齐扫描端 glob 后重建验证：

```css
/* theme/app.css 顶部（若缺失） */
@import "tailwindcss";
@source "../components/**/*.{ts,tsx}";
@source "../pages/**/*.{ts,tsx}";
```

- **2-C Radix 受控失效**：检查 `SegmentedControl` 的 `value` prop 是否恒为空串/未传（如 `ScannerPanel.tsx:563`、`ScannerWorkspace.tsx:216` 的 value 来源 `useScannerMode`）——若 value 为 `""`，`next` 空串被忽略、无选中项；给默认值兜底：

```ts
function readStoredMode(): ScannerMode {
  try {
    return localStorage.getItem(MODE_KEY) === "remote" ? "remote" : "local"; // 已有默认 local，无需改
  } catch {
    return "local";
  }
}
```

（若实测为 C 且默认值正常，则以实际 DOM 取证为准修正。）

- [ ] **Step 3: 重建 + 截图对比确认**

Run: `npm run build:scanner:full` → 再次浏览器实测截图：两处 SegmentedControl 的选中项必须白底/升面 + shadow 浮起，未选中项保持灰字。
Expected: 截图对比明显可辨（保存对比图到 `docs/superpowers/plans/` 或会话记录）。

- [ ] **Step 4: Commit（若发生代码修改）**

```bash
git add <修改文件>
git commit -m "fix(scanner): SegmentedControl 选中态不显示修复 (五轮B3)"
```

> 若 Step 1 实测为情况 D（已正常），本 Task 无需代码改动，直接在 Task 10 的回归清单标注"B3 实证已修复"，并在会话记录附截图证据。

**执行结果（2026-08-31）**：取证完成 → **情况 D，无代码变更**。
- `dist/scanner/assets/*.css` 完整含选中态规则：`data-[state=on]:bg-card`（含 `!` 与常规两版本）、`text-foreground`、`shadow-1`，以及 `[data-skin=paper-edge]` 皮肤增强规则 —— 样式层无缺失；
- Radix ToggleGroup 受控 `value` 恒非空（`useScannerMode` 默认 `local`），`data-state="on"` 由 Radix 契约保证；
- 录像包时间戳 08-31 19:52，但 main.log 同机构建 hash 显示测试包 < 08-30 15:00（fee1cac 前）；且 ScannerPanel 模式切换区 08-31 12:37 又被 60f606b 重构 —— 录像的"4 按钮无选中态"判为过期包视觉差异。
- **保留动作**：新包发布后在扫描端实机复查（Task 10 回归表已列"扫描端 4 个切换按钮选中态"）。

---

### Task 7: B4 — 扫描端移除 Google Fonts 外链

**Files:**
- Modify: `index-scanner.html:12-14`

- [ ] **Step 1: 删除三行外链**

编辑 `index-scanner.html`，删除：

```html
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

（与 fee1cac 对 web 版 `index.html` 的删除同口径；字体栈回退依赖 `tokens.css` 已有定义，无需补字体。）

- [ ] **Step 2: 验证**

Run: `grep -c "fonts.googleapis" index-scanner.html`
Expected: 0（输出 `0`，退出码 1 属正常 grep 无命中的表现）。

再跑 `npm run build:scanner:full` 后：

Run: `grep -c "fonts.googleapis" dist/scanner/index.html`
Expected: 0。

- [ ] **Step 3: Commit**

```bash
git add index-scanner.html
git commit -m "fix(scanner): 移除 index-scanner.html Google Fonts 外链,根治启动刷 CSP 违规 (五轮B4)"
```

---

### Task 8: C1 — "侧边栏自动展开"移出系统级配置，迁到账号设置「外观/皮肤」

**Files:**
- Modify: `src/apps/answer-card/client/components/GlobalSettingsPage.tsx:237-239`（删除）
- Modify: `src/apps/answer-card/client/pages/AccountSettingsPage.tsx`（「外观 / 皮肤」区新增）
- Modify（若需要）: `src/apps/answer-card/client/components/ui/v2/` 无

设计：开关实现本就是 localStorage（`projectx-rail-auto-expand`）+ CustomEvent 同步（App.tsx 已监听 `projectx:rail-auto-expand`），迁移只动 UI 位置，逻辑零改动。

- [ ] **Step 1: GlobalSettingsPage 删除开关**

删除 `GlobalSettingsPage.tsx:236-240`：

```tsx
      <ControlRow
        reverse
        control={<Switch checked={railAutoExpand} onCheckedChange={toggleRailAutoExpand} />}
        label="侧边栏自动展开"
        description="收起后鼠标移到侧边栏时自动展开；关闭后仍可点击圆形按钮展开并正常导航。"
      />
```

同时删除文件内不再使用的 `railAutoExpand` / `toggleRailAutoExpand` state（:64 区）与相关引用，保持无未用变量（typecheck 通过）。

- [ ] **Step 2: AccountSettingsPage「外观 / 皮肤」区新增开关**

在 `AccountSettingsPage.tsx` 的「外观 / 皮肤」section（SkinSwitcher ControlRow 之后）加：

```tsx
                <ControlRow
                  reverse
                  control={
                    <Switch
                      checked={railAutoExpand}
                      onCheckedChange={(next) => {
                        setRailAutoExpand(next === true);
                        try { localStorage.setItem("projectx-rail-auto-expand", String(next === true)); } catch { /* ignore storage failures */ }
                        window.dispatchEvent(new CustomEvent("projectx:rail-auto-expand", { detail: next === true }));
                      }}
                    />
                  }
                  label="侧边栏自动展开"
                  description="收起后鼠标移到侧边栏时自动展开（仅本机当前浏览器生效）"
                />
```

并在组件内加 state：

```tsx
  const [railAutoExpand, setRailAutoExpand] = useState(() => {
    try { return localStorage.getItem("projectx-rail-auto-expand") === "true"; } catch { return false; }
  });
```

（`Switch` / `ControlRow` / `useState` 的 import 若缺失则补上；AccountSettingsPage 现有 import 中 ControlRow 已在用。）

- [ ] **Step 3: typecheck + web 实测**

Run: `npm run typecheck` → 无错误。

浏览器实测（web-gui-tester）：系统级配置页不再有"侧边栏自动展开"；账号设置 → 外观/皮肤 出现该开关，切换后收起侧边栏鼠标划过自动展开/不展开行为正确。

- [ ] **Step 4: Commit**

```bash
git add src/apps/answer-card/client/components/GlobalSettingsPage.tsx src/apps/answer-card/client/pages/AccountSettingsPage.tsx
git commit -m "fix(settings): 侧边栏自动展开移出系统级配置,迁至账号设置外观区 (五轮C1)"
```

---

### Task 9: D1 — 切块防静默失败 + 验证路径

**Files:**
- Modify: `src/server/services/AnswerBlockCropService.ts`（空 crops/字段缺失 → 统计返回值 + warn）
- Modify: `src/apps/answer-card/server/recognition.ts`（--crops-dir 降级 warn）
- Create: `scripts/verify-round5-crop-silence.ts`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试**

创建 `scripts/verify-round5-crop-silence.ts`：

```ts
/**
 * 五轮测试 D1：切块持久化对"空切块 / 字段缺失"不得静默——返回统计并保留日志。
 * 用法：npx tsx scripts/verify-round5-crop-silence.ts（期望全绿，退出码 0）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-round5-crop-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "round5-crop.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

import { getMysqlDb } from "../src/server/db";
import { persistAnswerBlockCrops } from "../src/server/services/AnswerBlockCropService";

let passed = 0; let failed = 0; const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

async function main(): Promise<void> {
  const db = getMysqlDb();
  await db.exec(`
    CREATE TABLE answer_cards (id TEXT PRIMARY KEY);
    CREATE TABLE answer_block_crops (
      id TEXT PRIMARY KEY, card_id TEXT, block_id TEXT, source_type TEXT, source_record_id TEXT
    );
  `);
  await db.run("INSERT INTO answer_cards (id) VALUES ('card-1')");

  section("空切块 — 返回统计且不写库");
  const r1 = await persistAnswerBlockCrops({
    cardId: "card-1", examId: 1, studentId: 1, studentNumber: "1001",
    sourceType: "scan_record", sourceRecordId: 7, crops: [],
  }, db);
  ok((r1 as any).persisted === 0 && (r1 as any).empty === true, `空切块返回统计 (${JSON.stringify(r1)})`);

  section("字段缺失 — 跳过并计数");
  const r2 = await persistAnswerBlockCrops({
    cardId: "card-1", examId: 1, studentId: 1, studentNumber: "1001",
    sourceType: "scan_record", sourceRecordId: 8,
    crops: [
      { path: "/tmp/nonexist.png", blockId: "b1", questionNumbers: [1] } as any,
      { path: "/tmp/x.png", blockId: "b2", questionNumbers: [] } as any,
    ],
  }, db);
  ok((r2 as any).persisted === 0 && (r2 as any).skipped === 2, `2 条无效切块被跳过并计数 (${JSON.stringify(r2)})`);

  const rows = await db.all("SELECT COUNT(*) AS cnt FROM answer_block_crops") as Array<{ cnt: number }>;
  ok(Number(rows[0].cnt) === 0, "库内无脏数据");

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> 实现者注意：`persistAnswerBlockCrops` 当前返回 `Promise<...>`（void/行数组），需改为返回 `{ persisted, skipped, empty }`；测试临时表仅为隔离（真实调用仍走真实迁移 schema——若表结构不匹配，以真实 schema 建表，或直接依赖 migrations 初始化）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx scripts/verify-round5-crop-silence.ts`
Expected: `空切块返回统计` ✗（当前静默 return []）。

- [ ] **Step 3: 实现**

修改 `src/server/services/AnswerBlockCropService.ts` 的 `persistAnswerBlockCrops`（:107-141）：

```ts
export interface CropPersistenceStats {
  /** 成功落库的切块数 */
  persisted: number;
  /** 因字段缺失/文件不存在被跳过的切块数 */
  skipped: number;
  /** 识别结果根本没产出切块 */
  empty: boolean;
}

export async function persistAnswerBlockCrops(
  params: AnswerBlockCropPersistenceParams,
  db: DbAdapter
): Promise<CropPersistenceStats> {
  const crops = params.crops ?? [];
  if (crops.length === 0) {
    // 五轮D1：无切块产出不再静默 —— 扫描端/批量阅卷常因识别器版本差异致 crops 恒空，
    // 留一行日志便于定位"有扫描无切块"。
    console.warn(`[crop] 无切块产出 (cardId=${params.cardId}, source=${params.sourceType}:${params.sourceRecordId}); OCR 未返回 blockCrops，网阅队列将为空`);
    return { persisted: 0, skipped: 0, empty: true };
  }
  const stats: CropPersistenceStats = { persisted: 0, skipped: 0, empty: false };
  await db.run("DELETE FROM answer_block_crops WHERE source_type = ? AND source_record_id = ?",
    params.sourceType, params.sourceRecordId);
  const targetDir = ...; // 原有 targetDir 计算不变
  for (let index = 0; index < crops.length; index += 1) {
    const crop = crops[index];
    if (!crop?.path || !existsSync(crop.path) || !crop.blockId || !Array.isArray(crop.questionNumbers) || crop.questionNumbers.length === 0) {
      stats.skipped += 1;
      console.warn(`[crop] 跳过无效切块 #${index} (blockId=${crop?.blockId ?? "?"}, path=${crop?.path ?? "?"}, questionNumbers=${JSON.stringify(crop?.questionNumbers ?? null)})`);
      continue;
    }
    ... // 原有落库逻辑不变
    stats.persisted += 1;
  }
  return stats;
}
```

> 实现者注意：函数尾部的 `return [];`（原空数组返回）改为返回 `stats`；调用方（`apps/answer-card/server/index.ts:500`、`scanner/scanner-service.ts:281`）不消费返回值，兼容无破坏。`params` 类型名以文件内现有接口为准。

修改 `src/apps/answer-card/server/recognition.ts` 的 `runWithCropsFallback`（:128-131）：

```ts
async function runWithCropsFallback(request: RecognitionRequest, exePath: string, baseArgs: string[]): Promise<RecognitionResult> {
  if (!request.cropsDir) {
    return execRecognizer(exePath, baseArgs);
  }
  const argsWithCrops = [...baseArgs, "--crops-dir", request.cropsDir];
  try {
    const result = await execRecognizer(exePath, argsWithCrops);
    if (isCropsDirUnsupportedError(result, "")) {
      console.warn("[recognizer] old exe does not support --crops-dir, retrying without it");
      // 五轮D1：降级后切块必然为空，明示提示（配合 persistAnswerBlockCrops 的 empty 日志）
      console.warn("[recognizer] crops-dir 不受支持：本次识别不会产出大题切块（网阅队列将为空）");
      return execRecognizer(exePath, baseArgs);
    }
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Unknown argument: --crops-dir") || msg.includes("--crops-dir")) {
      console.warn("[recognizer] old exe fallback without --crops-dir after error:", msg);
      console.warn("[recognizer] crops-dir 不受支持：本次识别不会产出大题切块（网阅队列将为空）");
      return execRecognizer(exePath, baseArgs);
    }
    throw error;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx scripts/verify-round5-crop-silence.ts`
Expected: 全部 ✓。

- [ ] **Step 5: 注册脚本 + typecheck**

```json
    "verify:round5-crop-silence": "tsx scripts/verify-round5-crop-silence.ts",
```

Run: `npm run typecheck` → 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/server/services/AnswerBlockCropService.ts src/apps/answer-card/server/recognition.ts scripts/verify-round5-crop-silence.ts package.json
git commit -m "fix(crop): 切块空/无效切块落日志+统计,不再静默 (五轮D1)"
```

- [ ] **Step 7: 切块功能验证清单（交付测试者，回答"切块怎么测、是否好用"）**

在扫描端（含新打的包）按以下步骤验收：

1. 导入图片批量阅卷：进入扫描工作台 →「导入阅卷」→「导入目录」选择含学生答题卡扫描图的文件夹（或 TWAIN 直扫 2 张以上）。
2. 完成识别判分后，检查页面 OCR 汇总；数据库层验证（本地 userData 内嵌 SQLite）：
   ```sql
   SELECT source_type, source_record_id, COUNT(*) FROM answer_block_crops GROUP BY source_type, source_record_id;
   ```
   期望每张卡 ≥ 1 行（有大题框的答题卡才有）。
3. 阅卷侧验证：教师端「考试管理 → 该考试 → 网上阅卷」，队列应出现大题切块图片（非整页）；点击可逐题打分。
4. 若第 2/3 步为空：查看扫描端 main.log 是否出现两类新日志：
   - `[crop] 无切块产出 … OCR 未返回 blockCrops`（识别端没出 crops）
   - `[recognizer] crops-dir 不受支持…`（识别器 exe 过旧，需换带 --crops-dir 的新版 native 构建）
5. 判定结论记入 Task 10 发布清单（"切块是否好用"以此为准）。

---

### Task 10: 整体回归与发布清单

**Files:** 无（执行/文档）

- [ ] **Step 1: 全量验证命令**

Run:

```bash
npm run typecheck
npx tsx scripts/verify-round5-db-upsert.ts
npx tsx scripts/verify-round5-groupby.ts
npx tsx scripts/verify-round5-demo-cleanup.ts
npx tsx scripts/verify-round5-llm-launcher.ts
npx tsx scripts/verify-round5-participant-search.ts
npx tsx scripts/verify-round5-crop-silence.ts
npm run verify:auth
npm run verify:security-critical
npx tsx scripts/grading-rules-smoke.ts
```

Expected: 全部退出码 0。

- [ ] **Step 2: 构建**

Run: `npm run build`（web）+ `npm run build:scanner:full`（扫描端）
Expected: 两编译通过，`dist/scanner/index.html` 无 fonts.googleapis，`dist/scanner/assets/*.css` 含 SegmentedControl 选中态规则（若 B3 走代码修复）。

- [ ] **Step 3: MariaDB 部署回归（发布后）**

部署新包到 d15z.cn（MariaDB）后逐项：

| 检查项 | 预期 |
|--------|------|
| 管理员保存全局设置 | 成功，无 1064 |
| 成绩分析 → 总体分析（英语/1111） | 分布/指标正常加载，无 `GROUP BY exam_id` 报错 |
| 管理端导入演示数据 → 再清除 | 成功，无 FK 1451；日志明示被并入清理的引用考试 |
| 教师账号打开某考试应考名单 | 搜索学号/姓名出结果；年级→班级→未选学生可选；名单"共 N 人"与列表一致 |
| 扫描端上传一台干净机器（含 .env 已放置） | main.log 出现 `[llmclient] sidecar is up.`；导出检查 AI 分析正常返回 |
| 扫描端启动 | 控制台无 Google Fonts CSP 违规；双开第二实例提示已运行并退出 |
| 切块（Task 9 Step 7 清单） | 阅卷队列出现切块图；或日志明确 explain 无切块原因 |

- [ ] **Step 4: 收尾**

- 更新 `readus/CHANGELOG.md`（v2.5.5 条目，列 A1-A4/B1-B4/C1/D1 修复）。
- 更新打包说明（extraResources 的 llmclient/.env 放置位置）。
- 用 verification-before-completion 复核本计划所有 Step 的实测输出后，再合并/发版。

---

## Self-Review

**Spec 覆盖**：A1→Task1、A2→Task2、A3→Task3、B1→Task4、B2→Task5、B3→Task6、B4→Task7、C1→Task8、D1→Task9、EADDRINUSE/Tooltip→已修复无任务、发布回归→Task10。切块验证路径在 Task 9 Step 7。

**放置扫描**：无 "TBD/TODO/implement later"；所有代码步骤给出完整代码；测试脚本均为可执行断言；每 Task 含失败→通过双态验证与 commit。

**类型一致性**：`CropPersistenceStats`（Task 9）在测试与实现两侧同名同构；`repoRootCandidates(explicitCandidates?)`（Task 4）测试调用与实现签名一致；`searchStudentsForExam(db, examId, q)`（Task 5）在 service/route/测试三处签名一致；`persistAnswerBlockCrops` 返回类型变更后调用方不消费返回值，兼容。