# 扫描端「扫描后处理页」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.
>
> **开工前先读接手文档**：`docs/扫描端后处理页-施工接手文档.md`（工作区状态、决策红线、代码地图、施工协议、验证矩阵、DoD）。

**Goal:** 在扫描端新增「扫描后处理页」：扫完自动进入，右上角分段控件切「扫描结果 / 卡查看与改分 / 异常处理」三视图，收编重复卷、考号、缺页、低置信四类异常的队列式处理，并打通处理完自动补传。

**Architecture:** 纯前端重组 + 2 处服务端小扩展。数据总源是现有 `ScanBatchResponse`（本地 validate / 远端 results），编辑总源是现有 correction 文档（GET/PUT `.../groups/:gid/correction`）；新增两个 shared 纯函数模块（格选择逆运算、组/队列推导）承担全部可测逻辑；UI 全部取自 `components/ui/v2` 桶文件，视觉对齐 `design/demo/demo.html` 视图 8。

**Tech Stack:** React 18 + TypeScript、Tailwind v4 语义令牌、Radix（经 ui/v2）、Express（服务端扩展）、tsx 冒烟脚本。

**Spec:** `docs/superpowers/specs/2026-10-17-scanner-postprocess-design.md`（决策溯源 D1–D14、demo 对齐与偏差修正均在其中；本计划与说明书冲突时以说明书为准并回来修本文件）。

## Global Constraints

- 分支：`扫描端微调`；不切分支、不 push、不开 PR，除非用户另行要求。
- UI 组件只能 `import ... from "./ui/v2"`（桶文件）；禁止新建 CSS 文件、禁止手写业务 CSS；颜色只写语义类（`bg-background/bg-card/text-muted-foreground/border-border-subtle/ring-destructive/bg-warning-soft` 等），禁止 `--px-*` L1 原始令牌进业务代码。
- 图标只用 lucide-react；emoji 不得作功能图标；数字一律 `tabular-nums`。
- 扫描端已全局 `data-density="compact"`（`ScannerApp.tsx:51-54`），本页不另设密度。
- 一屏主按钮 ≤1（`Button variant="primary"`）；危险确认一律 `ConfirmDialog tone="danger"` 且文案说清代价。
- 纸面恒白：卡图容器 `bg-muted` 中性底 + 图片本身恒白（暗色下不变）。
- SQL 双方言：新增查询不得用单一数据库方言函数；本计划新增 SQL 仅一条普通 SELECT（见 Task 3）。
- 不提交运行数据/数据库/打包产物；`resources/native/**` 绝不改动。
- 每个 Task 结束跑 `npm run typecheck`；涉及扫描端构建的 Task 结束跑 `npm run build:scanner:full`。
- 提交信息风格沿用仓库（`feat(scanner): …` / `fix(scanner): …`，中文摘要可）。

## File Structure

| 操作 | 路径 | 职责 |
|------|------|------|
| Create | `src/shared/correctionCellSelect.ts` | correction 格选择的逆运算（下拉/输入 → 格 id 集合） |
| Create | `src/shared/scanPostprocess.ts` | 组视图模型 + 异常队列推导 + 删除护栏纯逻辑 |
| Create | `scripts/scanner-postprocess-smoke.ts` | 上述两模块的冒烟断言 |
| Modify | `src/apps/answer-card/server/scanner/index.ts` | 新增 `DELETE /session/:sessionId/groups`；`GET /scan/:sessionId` 响应追加 `examId` |
| Modify | `src/server/routes/scanner-upload.ts` | `GET /sessions/:sessionId/status` 响应追加 `examId` |
| Modify | `src/server/services/scannerSubmissions.ts` | 新增 `listActiveReceiptGroups()`（删除护栏的回执查询） |
| Create | `src/apps/answer-card/client/components/scanner-postprocess/CorrectionCanvas.tsx` | 从 CardCorrectionEditor 抽出的内联点选画布 |
| Modify | `src/apps/answer-card/client/components/CardCorrectionEditor.tsx` | 改用 CorrectionCanvas（行为不变） |
| Create | `src/apps/answer-card/client/components/scanner-postprocess/postprocessChannel.ts` | 本地通道适配 + 批结果拉取 + 按组补传（通道裁定：单一本地事实源，见 spec §5） |
| Create | `src/apps/answer-card/client/components/scanner-postprocess/PostprocessResultsView.tsx` | 视图 1 |
| Create | `src/apps/answer-card/client/components/scanner-postprocess/PostprocessCorrectionView.tsx` | 视图 2 |
| Create | `src/apps/answer-card/client/components/scanner-postprocess/PostprocessQueueView.tsx` | 视图 3（含五个面板） |
| Create | `src/apps/answer-card/client/components/ScannerPostprocessPage.tsx` | 页外壳 + 三视图装配 + 数据加载 |
| Modify | `src/apps/answer-card/client/components/ScannerWorkspace.tsx` | 新增 `onScansComplete` 透传 prop |
| Modify | `src/apps/answer-card/client/ScannerApp.tsx` | `Page` 增加 `postprocess`；扫完自动跳入 |
| Modify | `package.json` | 注册 `verify:scanner-postprocess` |
| Modify | `docs/扫描端后处理页-ui草案.html` | 补全为自包含（并入 v4 的视图 2 完整画法 + §6 偏差修正） |
| Modify | `readus/扫描端胶囊.md` | 增补「扫描后处理页」一节导航 |

---

### Task 1: shared 格选择逆运算

**Files:**
- Create: `src/shared/correctionCellSelect.ts`
- Test: `scripts/scanner-postprocess-smoke.ts`（本 Task 先建文件，Task 2 续写）

**Interfaces:**
- Produces: `selectObjectiveOptionCells(cells, questionNumber, options): string[] | null`、`selectStudentDigitCells(cells, digits): string[] | null`、`selectScoreCells(cells, questionId, blockId, score, maxScore): string[] | null`（`null` = 卡面上无法表示，调用方置输入 invalid）

- [x] **Step 1: 写冒烟脚本（先红）**

```ts
// scripts/scanner-postprocess-smoke.ts
import assert from "node:assert/strict";
import { evaluateScoreCells, type CorrectionCell } from "../src/shared/scanCorrection";
import { selectObjectiveOptionCells, selectScoreCells, selectStudentDigitCells } from "../src/shared/correctionCellSelect";
import { buildPostprocessGroups, buildPostprocessQueue, filterDeletableGroups, missingLayoutPages } from "../src/shared/scanPostprocess";
import type { ScanBatchResponse } from "../src/shared/scanPages";

function optionCell(questionNumber: number, option: string): CorrectionCell {
  return { type: "objective_option", id: `o${questionNumber}${option}`, questionNumber, option, rect: { x: 0, y: 0, width: 1, height: 1 } } as CorrectionCell;
}
function digitCell(digitIndex: number, digit: number): CorrectionCell {
  return { type: "student_digit", id: `d${digitIndex}-${digit}`, digitIndex, digit, rect: { x: 0, y: 0, width: 1, height: 1 } } as CorrectionCell;
}
function scoreCell(questionId: string, score: number, blockId?: string): CorrectionCell {
  return { type: "score_cell", id: `s${questionId}-${score}`, questionId, blockId, questionNumber: 21, score, rect: { x: 0, y: 0, width: 1, height: 1 } } as CorrectionCell;
}

// ── 客观题选项 ──
const opts = [optionCell(1, "A"), optionCell(1, "B"), optionCell(1, "C"), optionCell(1, "D")];
assert.deepEqual(selectObjectiveOptionCells(opts, 1, ["B"]), ["o1B"]);
assert.deepEqual(selectObjectiveOptionCells(opts, 1, ["A", "C"]), ["o1A", "o1C"]);
assert.equal(selectObjectiveOptionCells(opts, 1, ["E"]), null);
assert.equal(selectObjectiveOptionCells(opts, 2, ["A"]), null);

// ── 学号 ──
const digits = [0, 1, 2].flatMap(i => Array.from({ length: 10 }, (_, d) => digitCell(i, d)));
assert.equal(selectStudentDigitCells(digits, "12")!.length, 2);
assert.deepEqual(selectStudentDigitCells(digits, "012"), ["d0-0", "d1-1", "d2-2"]);
assert.equal(selectStudentDigitCells(digits, "1234"), null);
assert.equal(selectStudentDigitCells(digits, "1a2"), null);

// ── 主观题分数（evaluateScoreCells 的逆，往返一致）──
const small = Array.from({ length: 16 }, (_, i) => scoreCell("q", i));      // max<=16：base 位
const big = [ ...Array.from({ length: 10 }, (_, i) => scoreCell("q", i)),   // ones 0..9
              ...[10, 20, 30, 40, 50].map(v => scoreCell("q", v)),          // tens
              scoreCell("q", 0.5) ];                                        // fraction
function roundTrip(cells: CorrectionCell[], score: number, max: number) {
  const picked = selectScoreCells(cells, "q", undefined, score, max);
  assert.ok(picked, `score ${score}/${max} 应可表示`);
  const chosen = cells.filter(c => picked!.includes(c.id)) as Array<Extract<CorrectionCell, { type: "score_cell" }>>;
  const evaluated = evaluateScoreCells(chosen, max);
  assert.equal(evaluated.valid, true, `score ${score} 格组合必须合法`);
  assert.equal(evaluated.score, score, `往返分数必须等于 ${score}`);
}
for (const score of [0, 3, 7, 15, 16]) roundTrip(small, score, 16);
for (const score of [0, 9, 10, 25, 37, 40, 12.5, 35.5]) roundTrip(big, score, 50);
assert.equal(selectScoreCells(small, "q", undefined, 17, 16), null);
assert.equal(selectScoreCells(small, "q", undefined, 7.5, 16), null);
assert.equal(selectScoreCells(big, "q", undefined, 55, 50), null);

// ── 缺页计算 ──
assert.deepEqual(missingLayoutPages([{ layoutPage: 1 }], 2), [2]);
assert.deepEqual(missingLayoutPages([{ layoutPage: 1 }, { layoutPage: 2 }], 2), []);

// ── 组与队列推导 ──
const response: ScanBatchResponse = {
  results: [
    { groupId: "0", studentId: "20240101", totalScore: 82, maxScore: 100, objectiveScore: 50, objectiveMaxScore: 50, subjectiveScore: 32, subjectiveMaxScore: 50, needsReviewCount: 0, pageCount: 2, saved: false,
      pages: [{ recordId: "r1", pageNum: 1, side: "front", layoutPage: 1, objectiveScore: 50, subjectiveScore: 32, totalScore: 82, totalMaxScore: 100 },
              { recordId: "r2", pageNum: 1, side: "back", layoutPage: 2, objectiveScore: 0, subjectiveScore: 0, totalScore: 0, totalMaxScore: 0 }] },
    { groupId: "2", studentId: "20240103", totalScore: 65, maxScore: 100, objectiveScore: 40, objectiveMaxScore: 50, subjectiveScore: 25, subjectiveMaxScore: 50, needsReviewCount: 3, pageCount: 2, saved: false,
      pages: [{ recordId: "r5", pageNum: 3, side: "front", layoutPage: 1, objectiveScore: 40, subjectiveScore: 25, totalScore: 65, totalMaxScore: 100 },
              { recordId: "r6", pageNum: 3, side: "back", layoutPage: 2, objectiveScore: 0, subjectiveScore: 0, totalScore: 0, totalMaxScore: 0 }] },
  ],
  failures: [
    { groupId: "1", studentId: null, stage: "recognition", message: "Student ID recognition failed.", pages: [{ recordId: "r3", pageNum: 2, side: "front", layoutPage: 1 }, { recordId: "r4", pageNum: 2, side: "back", layoutPage: 2 }] },
    { groupId: "3", studentId: "20240107", stage: "saving", message: "考号重复", pages: [{ recordId: "r7", pageNum: 4, side: "front", layoutPage: 1 }],
      conflicts: [{ sessionId: "scan_a", groupId: "3", studentId: "20240107", previouslySaved: true, formalScoreRetained: true, totalScore: 61, pages: [{ recordId: "r8", pageNum: 9, side: "front", layoutPage: 1 }] },
                  { sessionId: "scan_a", groupId: "3", studentId: "20240107", previouslySaved: false, totalScore: 58, pages: [{ recordId: "r7", pageNum: 4, side: "front", layoutPage: 1 }] }] },
    { groupId: "4", studentId: "20240115", stage: "recognition", message: "缺页", pages: [{ recordId: "r9", pageNum: 5, side: "front", layoutPage: 1 }] },
  ],
  reviewCards: [],
};
const groups = buildPostprocessGroups(response, "scan_a", 2);
assert.equal(groups.length, 5);
const byId = new Map(groups.map(g => [g.groupId, g]));
assert.deepEqual(byId.get("0")!.issues, []);
assert.deepEqual(byId.get("1")!.issues, ["student_id"]);
assert.deepEqual(byId.get("2")!.issues, ["low_confidence"]);
assert.equal(byId.get("2")!.needsReviewCount, 3);
assert.deepEqual(byId.get("3")!.issues, ["duplicate"]);
assert.equal(byId.get("3")!.conflicts.length, 2);
assert.deepEqual(byId.get("4")!.issues, ["missing_page"]);
assert.deepEqual(byId.get("4")!.missingLayoutPages, [2]);
const queue = buildPostprocessQueue(groups);
assert.deepEqual(queue.map(q => q.kind), ["duplicate", "student_id", "missing_page", "low_confidence"]);
assert.equal(queue[0].groupId, "3");

// ── 删除护栏 ──
assert.deepEqual(filterDeletableGroups(["0", "3"], new Map([["3", true]]), false), { deletable: ["0"], blocked: ["3"] });
assert.deepEqual(filterDeletableGroups(["0", "3"], new Map([["3", true]]), true), { deletable: ["0", "3"], blocked: [] });
assert.deepEqual(filterDeletableGroups([], new Map(), false), { deletable: [], blocked: [] });

console.log("PASS scanner-postprocess-smoke");
```

- [x] **Step 2: 运行，确认失败**

Run: `npx tsx scripts/scanner-postprocess-smoke.ts`
Expected: FAIL（模块不存在，`Cannot find module`）

- [x] **Step 3: 实现 `src/shared/correctionCellSelect.ts`**

```ts
import type { CorrectionCell } from "./scanCorrection";

type DigitCell = Extract<CorrectionCell, { type: "student_digit" }>;
type OptionCell = Extract<CorrectionCell, { type: "objective_option" }>;
type ScoreCell = Extract<CorrectionCell, { type: "score_cell" }>;

const EPS = 1e-9;

/** 客观题「修改」列（选项字母）→ 该题应选中的 option 格 id；出现卡面没有的选项返回 null。 */
export function selectObjectiveOptionCells(cells: CorrectionCell[], questionNumber: number, options: string[]): string[] | null {
  const available = cells.filter((c): c is OptionCell => c.type === "objective_option" && c.questionNumber === questionNumber);
  if (!available.length) return null;
  const wanted = new Set(options);
  const picked = available.filter(c => wanted.has(c.option));
  return picked.length === wanted.size ? picked.map(c => c.id) : null;
}

/** 考号输入 → digit 格 id；位数与卡面不符或含非数字返回 null。 */
export function selectStudentDigitCells(cells: CorrectionCell[], digits: string): string[] | null {
  if (!/^\d+$/.test(digits)) return null;
  const digitCells = cells.filter((c): c is DigitCell => c.type === "student_digit");
  const indices = [...new Set(digitCells.map(c => c.digitIndex))].sort((a, b) => a - b);
  if (!indices.length || indices.length !== digits.length) return null;
  const picked: string[] = [];
  for (const [position, digitIndex] of indices.entries()) {
    const cell = digitCells.find(c => c.digitIndex === digitIndex && c.digit === Number(digits[position]));
    if (!cell) return null;
    picked.push(cell.id);
  }
  return picked;
}

/**
 * 主观题分数 → 分数格 id（`evaluateScoreCells` 的逆）。
 * 位规则与 scanCorrection.ts 的 place 判定一致：max<=16 单格 base；max>16 拆 tens/ones/fraction，每位至多一格。
 * 无法表示（超范围、非 0.5 步进、卡面无对应格）返回 null。
 */
export function selectScoreCells(
  cells: CorrectionCell[],
  questionId: string,
  blockId: string | undefined,
  score: number,
  maxScore: number,
): string[] | null {
  const available = cells.filter((c): c is ScoreCell => c.type === "score_cell" && c.questionId === questionId && (!blockId || c.blockId === blockId));
  if (!available.length) return null;
  if (score < -EPS || score > maxScore + EPS) return null;
  const fraction = Math.abs(score % 1 - 0.5) < EPS ? 0.5 : 0;
  if (Math.abs(score % 1 - fraction) > EPS) return null;
  const integer = Math.round(score - fraction);
  const pick = (value: number) => available.find(c => Math.abs(c.score - value) < EPS)?.id ?? null;
  if (maxScore <= 16) {
    const id = pick(score);
    return id ? [id] : null;
  }
  const tens = Math.floor(integer / 10) * 10;
  const ones = integer % 10;
  const picked: string[] = [];
  if (tens > 0) {
    const id = pick(tens);
    if (!id) return null;
    picked.push(id);
  }
  if (ones > 0 || (tens === 0 && fraction === 0)) {
    const id = pick(ones);
    if (!id) return null;
    picked.push(id);
  }
  if (fraction > 0) {
    const id = pick(fraction);
    if (!id) return null;
    picked.push(id);
  }
  return picked.length ? picked : null;
}
```

- [x] **Step 4: 运行冒烟（scanPostprocess 部分此时仍红，属预期）**

Run: `npx tsx scripts/scanner-postprocess-smoke.ts`
Expected: FAIL（`scanPostprocess` 不存在）——格选择断言本身已通过；若格选择断言失败，先修 Task 1 再继续。

- [x] **Step 5: Commit**

```bash
git add src/shared/correctionCellSelect.ts scripts/scanner-postprocess-smoke.ts
git commit -m "feat(scanner): 后处理页格选择逆运算（选项/考号/分数格）"
```

---

### Task 2: shared 组视图模型 + 队列推导 + 删除护栏

**Files:**
- Create: `src/shared/scanPostprocess.ts`
- Test: `scripts/scanner-postprocess-smoke.ts`（Task 1 已建）

**Interfaces:**
- Consumes: `ScanBatchResponse/ScanConflictCard`（`src/shared/scanPages.ts:87-140`）、`uniqueScanConflictCards`（同文件 :108）
- Produces: `PostprocessIssueKind`、`PostprocessGroup`、`PostprocessQueueItem`、`missingLayoutPages()`、`buildPostprocessGroups(response, sessionId, layoutPageCount)`、`buildPostprocessQueue(groups)`、`filterDeletableGroups(groupIds, hasActiveReceipt, force)`

- [x] **Step 1: 实现 `src/shared/scanPostprocess.ts`**

```ts
import { uniqueScanConflictCards, type ScanBatchResponse, type ScanConflictCard } from "./scanPages";

/** 队列四类（用户锁定）+ other 兜底（不丢异常，非业务新类型）。 */
export type PostprocessIssueKind = "duplicate" | "student_id" | "missing_page" | "low_confidence" | "other";

export const POSTPROCESS_ISSUE_ORDER: readonly PostprocessIssueKind[] = [
  "duplicate",
  "student_id",
  "missing_page",
  "low_confidence",
  "other",
];

export interface PostprocessGroup {
  sessionId: string;
  groupId: string;
  studentId: string | null;
  saved: boolean;
  totalScore: number;
  maxScore: number;
  objectiveScore: number;
  subjectiveScore: number;
  pageCount: number;
  missingLayoutPages: number[];
  needsReviewCount: number;
  conflicts: ScanConflictCard[];
  thumbRecordId: string | null;
  failureMessage?: string;
  issues: PostprocessIssueKind[];
}

export interface PostprocessQueueItem {
  id: string;
  kind: PostprocessIssueKind;
  sessionId: string;
  groupId: string;
  studentId: string | null;
  label: string;
  conflicts: ScanConflictCard[];
  missingLayoutPages: number[];
  needsReviewCount: number;
  failureMessage?: string;
}

/** 该组实际页相对卡面布局缺哪些 layoutPage（1 起）。 */
export function missingLayoutPages(pages: ReadonlyArray<{ layoutPage: number }>, layoutPageCount: number): number[] {
  const have = new Set(pages.map(p => p.layoutPage));
  const missing: number[] = [];
  for (let page = 1; page <= layoutPageCount; page++) if (!have.has(page)) missing.push(page);
  return missing;
}

/**
 * 把 ScanBatchResponse 摊平成「组」视图模型。分类只用结构化信号：
 * conflicts 非空 → duplicate；studentId 为 null → student_id；缺 layoutPage → missing_page；
 * needsReviewCount>0 → low_confidence；仅有 failure 且以上皆无 → other。不解析 message 文案。
 */
export function buildPostprocessGroups(response: ScanBatchResponse, sessionId: string, layoutPageCount: number): PostprocessGroup[] {
  const byKey = new Map<string, PostprocessGroup>();
  const ensure = (groupId: string): PostprocessGroup => {
    const existing = byKey.get(groupId);
    if (existing) return existing;
    const group: PostprocessGroup = {
      sessionId, groupId, studentId: null, saved: false, totalScore: 0, maxScore: 0,
      objectiveScore: 0, subjectiveScore: 0, pageCount: 0, missingLayoutPages: [],
      needsReviewCount: 0, conflicts: [], thumbRecordId: null, issues: [],
    };
    byKey.set(groupId, group);
    return group;
  };

  for (const result of response.results) {
    const group = ensure(result.groupId);
    group.studentId = result.studentId;
    group.saved = result.saved;
    group.totalScore = result.totalScore;
    group.maxScore = result.maxScore;
    group.objectiveScore = result.objectiveScore;
    group.subjectiveScore = result.subjectiveScore;
    group.pageCount = result.pageCount;
    group.needsReviewCount = result.needsReviewCount;
    group.missingLayoutPages = missingLayoutPages(result.pages, layoutPageCount);
    group.thumbRecordId = result.pages[0]?.recordId ?? null;
  }

  for (const failure of response.failures) {
    const group = ensure(failure.groupId);
    group.studentId = group.studentId ?? failure.studentId;
    group.pageCount = group.pageCount || failure.pages.length;
    group.thumbRecordId = group.thumbRecordId ?? failure.pages[0]?.recordId ?? null;
    group.missingLayoutPages = missingLayoutPages(failure.pages, layoutPageCount);
    group.failureMessage = failure.message;
    if (failure.conflicts?.length) group.conflicts = uniqueScanConflictCards([...group.conflicts, ...failure.conflicts]);
  }

  for (const card of response.reviewCards ?? []) {
    if (card.sessionId !== sessionId) continue; // 历史遗留卷不收编（范围边界）
    const group = ensure(card.groupId);
    group.studentId = group.studentId ?? card.studentId;
    group.pageCount = group.pageCount || card.pages.length;
    group.thumbRecordId = group.thumbRecordId ?? card.pages[0]?.recordId ?? null;
    group.totalScore = group.totalScore || card.totalScore || 0;
    group.conflicts = uniqueScanConflictCards([...group.conflicts, card]);
  }

  for (const group of byKey.values()) {
    const issues: PostprocessIssueKind[] = [];
    if (group.conflicts.length > 0) issues.push("duplicate");
    if (group.studentId === null) issues.push("student_id");
    if (group.missingLayoutPages.length > 0) issues.push("missing_page");
    if (group.needsReviewCount > 0) issues.push("low_confidence");
    if (!issues.length && group.failureMessage) issues.push("other");
    group.issues = issues;
  }

  return [...byKey.values()].sort((a, b) => Number(a.groupId) - Number(b.groupId));
}

/** 一组多异常 = 多条队列项；顺序 duplicate → student_id → missing_page → low_confidence → other，组内按 groupId 数值序。 */
export function buildPostprocessQueue(groups: ReadonlyArray<PostprocessGroup>): PostprocessQueueItem[] {
  const items: PostprocessQueueItem[] = [];
  for (const group of groups) {
    for (const kind of POSTPROCESS_ISSUE_ORDER) {
      if (!group.issues.includes(kind)) continue;
      items.push({
        id: `${kind}|${group.sessionId}|${group.groupId}`,
        kind,
        sessionId: group.sessionId,
        groupId: group.groupId,
        studentId: group.studentId,
        label: queueLabel(kind, group),
        conflicts: group.conflicts,
        missingLayoutPages: group.missingLayoutPages,
        needsReviewCount: group.needsReviewCount,
        failureMessage: group.failureMessage,
      });
    }
  }
  const rank = new Map(POSTPROCESS_ISSUE_ORDER.map((kind, index) => [kind, index]));
  return items.sort((a, b) => rank.get(a.kind)! - rank.get(b.kind)! || Number(a.groupId) - Number(b.groupId));
}

function queueLabel(kind: PostprocessIssueKind, group: PostprocessGroup): string {
  switch (kind) {
    case "duplicate": return `考号重复${group.studentId ? `（${group.studentId}）` : ""}`;
    case "student_id": return "考号未识别";
    case "missing_page": return `缺第 ${group.missingLayoutPages.join("、")} 页`;
    case "low_confidence": return `${group.needsReviewCount} 题存疑`;
    case "other": return group.failureMessage || "处理失败";
  }
}

/**
 * 删除护栏纯逻辑：组内存在非 discarded 回执（已上传/待确认/冲突保留）时，
 * 未 force 一律 blocked；force 时放行（客户端已二次确认代价）。
 */
export function filterDeletableGroups(
  groupIds: ReadonlyArray<string>,
  hasActiveReceipt: ReadonlyMap<string, boolean>,
  force: boolean,
): { deletable: string[]; blocked: string[] } {
  const deletable: string[] = [];
  const blocked: string[] = [];
  for (const groupId of groupIds) {
    if (!force && hasActiveReceipt.get(groupId)) blocked.push(groupId);
    else deletable.push(groupId);
  }
  return { deletable, blocked };
}
```

- [x] **Step 2: 运行冒烟**

Run: `npx tsx scripts/scanner-postprocess-smoke.ts`
Expected: `PASS scanner-postprocess-smoke`

- [x] **Step 3: 注册 verify 脚本**

在 `package.json` 的 `scripts` 中、`verify:scanner-pending` 一行之后插入：

```json
"verify:scanner-postprocess": "tsx scripts/scanner-postprocess-smoke.ts",
```

- [x] **Step 4: 运行注册后的脚本**

Run: `npm run verify:scanner-postprocess`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/shared/scanPostprocess.ts scripts/scanner-postprocess-smoke.ts package.json
git commit -m "feat(scanner): 后处理页组视图模型、异常队列推导与删除护栏纯逻辑"
```

---

### Task 3: 服务端删除组端点 + 回执查询

**Files:**
- Modify: `src/server/services/scannerSubmissions.ts`（文件末尾追加导出函数）
- Modify: `src/apps/answer-card/server/scanner/index.ts`（在 `router.post("/session/:sessionId/groups/:groupId/discard", …)`（:560-570）之后插入）

**Interfaces:**
- Consumes: `deleteScanRecord`（`scan-store.ts:193-198`）、`mapScanPageToLayout`/`buildLayout`、`resolveScannerExam` 不需要（回执按 session_id+group_id 查）
- Produces: `DELETE /api/scanner/session/:sessionId/groups`，body `{groupIds:string[], force?:boolean}` → 200 `ScanBatchResponse`（validate 模式）/ 409 `{message, blocked:string[]}` / 400 / 404

- [x] **Step 1: 在 `src/server/services/scannerSubmissions.ts` 末尾追加**

```ts
/** 删除护栏数据源：这些组里哪些还存在非 discarded/superseded 的回执（已上传或待确认）。 */
export async function listActiveReceiptGroups(db: DbAdapter, sessionId: string, groupIds: readonly string[]): Promise<string[]> {
  if (!groupIds.length) return [];
  const placeholders = groupIds.map(() => "?").join(",");
  const rows = await db.all<{ group_id: string }>(
    `SELECT DISTINCT group_id FROM scanner_submissions WHERE session_id = ? AND group_id IN (${placeholders}) AND state NOT IN ('discarded','superseded')`,
    [sessionId, ...groupIds],
  );
  return rows.map(row => row.group_id);
}
```

- [x] **Step 2: 在 `scanner/index.ts` discard 路由之后插入删除路由**

```ts
  // 后处理页·视图 1 多选删除：只删本地扫描记录与识别结果，不动远端已上传成绩。
  // 有非 discarded 回执的组必须 force（客户端已二次确认），否则 409 列出 blocked。
  router.delete("/session/:sessionId/groups", async (req, res, next) => {
    try {
      const sessionId = safeId(req.params.sessionId);
      const body = (req.body ?? {}) as { groupIds?: unknown; force?: unknown };
      const groupIds = Array.isArray(body.groupIds)
        ? [...new Set(body.groupIds.filter((g): g is string => typeof g === "string" && g.length > 0))]
        : [];
      if (!groupIds.length) { res.status(400).json({ message: "groupIds 不能为空" }); return; }
      const session = await getSession(sessionId);
      if (!session) { res.status(404).json({ message: "扫描会话不存在" }); return; }
      const card = await findCardForLayout(session.card_id);
      if (!card) { res.status(404).json({ message: "答题卡不存在" }); return; }
      const layout = buildLayout(card);
      const records = await listScanRecords(sessionId);
      const recordIdsByGroup = new Map<string, string[]>();
      for (const record of records) {
        const mapping = mapScanPageToLayout(record.page_num, record.side, layout.pages.length, card.sided);
        const groupId = String(mapping.groupIndex);
        if (!groupIds.includes(groupId)) continue;
        recordIdsByGroup.set(groupId, [...(recordIdsByGroup.get(groupId) ?? []), record.id]);
      }
      const db = await getDb();
      const active = await listActiveReceiptGroups(db, sessionId, groupIds);
      const activeSet = new Map(active.map(groupId => [groupId, true]));
      const { deletable, blocked } = filterDeletableGroups(groupIds, activeSet, body.force === true);
      if (blocked.length) {
        res.status(409).json({ message: "所选卷包含已上传或待确认的回执，确认删除远端不受影响后请重试", blocked });
        return;
      }
      const missing = groupIds.filter(groupId => !recordIdsByGroup.has(groupId));
      await writeScannerSession(sessionId, async (tx) => {
        for (const groupId of deletable) {
          for (const recordId of recordIdsByGroup.get(groupId) ?? []) await tx.run(
            "DELETE FROM scan_correction_pages WHERE source_type = 'twain_scan_record' AND source_id = ?",
            [recordId],
          );
        }
        return null;
      });
      for (const groupId of deletable) {
        for (const recordId of recordIdsByGroup.get(groupId) ?? []) await deleteScanRecord(recordId);
      }
      const result = await processScannerSession(card, sessionId, "validate");
      res.json({ ...result, deletedGroups: deletable.length, missingGroups: missing });
    } catch (error) { next(error); }
  });
```

并在该文件顶部 import 区补齐（若缺失）：`buildLayout`（与 `session-results.ts` 同源 import 路径）、`mapScanPageToLayout`（`../../shared/scanPages` 或现有 import 行扩展）、`filterDeletableGroups`（`../../shared/scanPostprocess`）、`listActiveReceiptGroups`（`../../server/services/scannerSubmissions`）、`getDb`（沿用文件内现有数据库获取方式；若文件内用的是 `getMysqlDb()`，则用它并保持别名 `db`）。**执行时以文件现有 import 风格为准，只补缺失项。**

- [x] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 通过

- [x] **Step 4: 手工验证路由（隔离数据）**

```bash
npm run dev
# 另开终端：用现有扫描冒烟数据或真扫一小批后
curl -s -X POST http://localhost:5174/api/scanner/session/<sid>/validate -H "Content-Type: application/json" | head -c 400
curl -s -X DELETE http://localhost:5174/api/scanner/session/<sid>/groups -H "Content-Type: application/json" -d '{"groupIds":["0"]}' | head -c 400
# 期望：200 且返回 ScanBatchResponse；对已入库组（force 缺省）返回 409 + blocked
```

- [x] **Step 5: Commit**

```bash
git add src/server/services/scannerSubmissions.ts src/apps/answer-card/server/scanner/index.ts
git commit -m "feat(scanner): 后处理页多选删除端点（回执护栏 + force 二次确认）"
```

---

### Task 4: 读扩展 examId（花名册联想用）

**Files:**
- Modify: `src/apps/answer-card/server/scanner/index.ts:259-289`（`GET /scan/:sessionId`）
- Modify: `src/server/routes/scanner-upload.ts:721-754`（`GET /sessions/:sessionId/status`）

- [x] **Step 1: 本地路由追加字段**

在 `GET /scan/:sessionId` 的响应对象中追加 `examId`：

```ts
      const exam = await resolveScannerExam(session.card_id, sessionId).catch(() => null);
      res.json({ session, records, examId: exam?.examId ?? null });
```

（`resolveScannerExam` 的返回形状以 `src/server/services/scannerExam.ts` 为准；若其返回 `{ examId, … }` 之外的形状，取其中的考试 id 字段并保持 `examId: number | null`。）

- [x] **Step 2: 远端路由追加字段**

在 `GET /sessions/:sessionId/status` 的 `res.json({...})` 中追加同一字段（该文件已能拿到 session 行；`resolveScannerExam` 从 `../../server/services/scannerExam` import）。

- [x] **Step 3: 类型检查 + 回归**

Run: `npm run typecheck && npm run verify:scanner-upload-manager`
Expected: 通过

- [x] **Step 4: Commit**

```bash
git add src/apps/answer-card/server/scanner/index.ts src/server/routes/scanner-upload.ts
git commit -m "feat(scanner): 扫描会话读取接口追加 examId 供花名册联想"
```

---

### Task 5: 抽出 CorrectionCanvas 并回接 CardCorrectionEditor

**Files:**
- Create: `src/apps/answer-card/client/components/scanner-postprocess/CorrectionCanvas.tsx`
- Modify: `src/apps/answer-card/client/components/CardCorrectionEditor.tsx:114-125`

**Interfaces:**
- Produces: `CorrectionCanvas({ document, pageIndex, edit, images, zoom, busy, reviewQuestions, onToggle })`
- 行为必须与现编辑器内联 SVG 完全一致（含键盘可达、aria、stroke 语义），仅新增 `reviewQuestions` 存疑描边

- [x] **Step 1: 创建 `CorrectionCanvas.tsx`**

```tsx
import { correctionCells, correctionState, projectRect, type CorrectionDocument, type CorrectionEdit } from "../../../../../shared/scanCorrection";

export interface CorrectionCanvasProps {
  document: CorrectionDocument;
  pageIndex: number;
  edit: CorrectionEdit;
  images: Record<string, string>;
  zoom?: number;
  busy?: boolean;
  /** 存疑题号（confidence 低于阈值）：未选中时 amber 描边标记 */
  reviewQuestions?: ReadonlySet<number>;
  onToggle: (cellId: string) => void;
}

/** 答题卡点选画布（内联版）。从 CardCorrectionEditor 抽出，供后处理页视图 2 与整卡改分弹窗共用。 */
export function CorrectionCanvas({ document, pageIndex, edit, images, zoom = 1, busy = false, reviewQuestions, onToggle }: CorrectionCanvasProps) {
  const page = document.pages[pageIndex];
  if (!page) return null;
  const geometry = page.recognition.geometry;
  const state = correctionState(document.card, page, edit.selected, edit.touched);
  if (!geometry) return <img src={images[page.sourceId]} alt="待重新识别的完整原卷" className="block w-full" />;
  return (
    <svg viewBox={`0 0 ${geometry.imageWidth} ${geometry.imageHeight}`} width={`${zoom * 100}%`} className="block max-w-none" aria-label={`第 ${page.layout.pageNumber} 页答题卡`}>
      <image href={images[page.sourceId]} width={geometry.imageWidth} height={geometry.imageHeight} />
      {correctionCells(page.layout).map(cell => {
        const selected = edit.selected.includes(cell.id);
        const invalid = state.invalid.has(cell.id);
        const review = !selected && reviewQuestions?.has(cell.questionNumber) === true;
        const label = cell.type === "student_digit" ? `学号第 ${cell.digitIndex + 1} 位 ${cell.digit}`
          : cell.type === "objective_option" ? `第 ${cell.questionNumber} 题 ${cell.option}`
          : `第 ${cell.questionNumber} 题 ${cell.score} 分`;
        return (
          <polygon
            key={cell.id}
            points={projectRect(cell.rect, geometry.layoutToImage)}
            role="button"
            aria-label={`${label}${selected ? (invalid ? "，异常" : "，已选") : review ? "，存疑" : ""}`}
            aria-pressed={selected}
            tabIndex={busy ? -1 : 0}
            vectorEffect="non-scaling-stroke"
            strokeWidth={selected ? 2 : review ? 1 : 0}
            className={`cursor-pointer fill-transparent outline-none ${
              selected
                ? invalid ? "stroke-correction-error focus:stroke-3" : "stroke-correction-normal focus:stroke-3"
                : review
                  ? "stroke-warning hover:stroke-info hover:stroke-1 focus:stroke-info focus:stroke-1"
                  : "stroke-transparent hover:stroke-info hover:stroke-1 focus:stroke-info focus:stroke-1"
            }`}
            onClick={() => onToggle(cell.id)}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(cell.id); } }}
          >
            <title>{label}</title>
          </polygon>
        );
      })}
    </svg>
  );
}
```

- [x] **Step 2: 编辑器改用画布**

把 `CardCorrectionEditor.tsx:115-125` 的 `{page && geometry && <svg …>…</svg>}` 整块替换为：

```tsx
        {page && edit && <CorrectionCanvas document={document} pageIndex={pageIndex} edit={edit} images={images} zoom={zoom} busy={busy} onToggle={toggle} />}
```

并：删除编辑器内不再使用的 `correctionCells/projectRect` import 与 `geometry` 局部变量（`missing` 判断保留，改用 `document.pages.some(p => !p.recognition.geometry)`，现状 :63 已是）；文件顶部加 `import { CorrectionCanvas } from "./scanner-postprocess/CorrectionCanvas";`。

- [x] **Step 3: 验证**

Run: `npm run typecheck && npm run verify:scan-correction`
Expected: 通过（编辑器行为不变）

- [x] **Step 4: Commit**

```bash
git add src/apps/answer-card/client/components/scanner-postprocess/CorrectionCanvas.tsx src/apps/answer-card/client/components/CardCorrectionEditor.tsx
git commit -m "refactor(scanner): 抽出 CorrectionCanvas 供后处理页与整卡改分共用"
```

---

### Task 6: 本地通道适配与按组补传

**Files:**
- Create: `src/apps/answer-card/client/components/scanner-postprocess/postprocessChannel.ts`

**Interfaces:**
- Produces: `PostprocessChannel`、`localChannel()`、`loadSessionMeta(sessionId)`、`queueGroupUpload(meta, sessionId, result)`
- Consumes: `scannerUploadManager.startUpload`（`lib/scannerUploadManager.ts:688`）、`mediaUrl/authFetch`（`auth/api.ts`）

**通道裁定（必读）**：后处理页**只有本地通道**。远端模式不直接打 `/api/scanner/upload/...`——本页持有本地 TWAIN sessionId，上传端点认的是 `job.remoteSessionId`（`scannerUploadManager.ts:551-556`），且 `requestJob` 在 job 收尾后 reject「上传任务已关闭」（:897-899）。远端语义全部由 `queueGroupUpload`（startUpload 自建 remote session）承担，与 `ScannerPanel` 现状同构（spec §5）。

- [x] **Step 1: 创建文件**

```ts
import { authFetch, mediaUrl } from "../../auth/api";
import { scannerUploadManager } from "../../lib/scannerUploadManager";
import type { ScanBatchResponse, ScanBatchResult } from "../../../../../shared/scanPages";
import type { CorrectionDocument } from "../../../../../shared/scanCorrection";

/** 后处理页唯一通道 = 本地（通道裁定见本 Task 开头与 spec §5）。 */
export interface PostprocessChannel {
  request(url: string, init?: RequestInit): Promise<Response>;
  results(sessionId: string): Promise<ScanBatchResponse>;
  correctionUrl(sessionId: string, groupId: string): string;
  imageUrl(recordId: string): string;
  discardUrl(sessionId: string, groupId: string): string;
  retryUrl(sessionId: string): string;
  deleteGroupsUrl(sessionId: string): string;
}

async function readJson(res: Response): Promise<any> {
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `请求失败（HTTP ${res.status}）`);
  return data;
}

export function localChannel(): PostprocessChannel {
  return {
    request: (url, init) => authFetch(url, init),
    // 与 ScannerPanel.readResults 的远端预览同口径：validate 只演算回执不落分
    results: sessionId => readJson(authFetch(`/api/scanner/session/${sessionId}/validate`, { method: "POST" })),
    correctionUrl: (sessionId, groupId) => `/api/scanner/session/${sessionId}/groups/${groupId}/correction`,
    imageUrl: recordId => mediaUrl(`/api/scanner/scan-image/${recordId}`),
    discardUrl: (sessionId, groupId) => `/api/scanner/session/${sessionId}/groups/${groupId}/discard`,
    retryUrl: sessionId => `/api/scanner/session/${sessionId}/retry`,
    deleteGroupsUrl: sessionId => `/api/scanner/session/${sessionId}/groups`,
  };
}

export interface SessionMeta {
  sessionId: string;
  examId: number | null;
  identityMode: "strict" | "legacy";
  dpi: number;
  paperSize: string;
}

/** 补传所需的会话元数据；本地读 GET /scan/:sid（Task 4 已追加 examId）。 */
export async function loadSessionMeta(sessionId: string): Promise<SessionMeta> {
  const data = await readJson(await authFetch(`/api/scanner/scan/${sessionId}`));
  const session = data.session as { identity_mode?: "strict" | "legacy"; dpi?: number; paper_size?: string };
  return {
    sessionId,
    examId: typeof data.examId === "number" ? data.examId : null,
    identityMode: session.identity_mode === "legacy" ? "legacy" : "strict",
    dpi: Number(session.dpi) || 300,
    paperSize: session.paper_size || "A4",
  };
}

export interface UploadMeta {
  cardId: string;
  cardVersion: string;
  identityMode: "strict" | "legacy";
  dpi: number;
  paperSize: string;
}

/**
 * 异常卷处理完后的按组补传（D12）。镜像 ScannerPanel.queueSuccessfulUploads 的 pages 构造，
 * 只入队指定组；已入队的组由 manager 内部跳过。返回 job id。
 */
export function queueGroupUpload(meta: UploadMeta, sessionId: string, result: ScanBatchResult): string {
  return scannerUploadManager.startUpload({
    identityMode: meta.identityMode,
    kind: "scan",
    cardId: meta.cardId,
    name: `扫描_${result.studentId}`,
    dpi: meta.dpi,
    paperSize: meta.paperSize,
    cardVersion: meta.cardVersion,
    pages: result.pages.map(page => ({
      pageNum: page.pageNum,
      side: page.side,
      groupId: result.groupId,
      layoutPage: page.layoutPage,
      studentId: result.studentId,
      getCorrection: async () => {
        const response = await authFetch(`/api/scanner/session/${sessionId}/groups/${result.groupId}/correction`);
        if (response.status === 409) return undefined; // 旧卷无坐标快照
        if (!response.ok) throw new Error("读取已保存的填涂订正失败");
        const document = (await response.json()) as CorrectionDocument;
        return document.pages.find(p => p.sourceId === page.recordId)?.recognition;
      },
      getBlob: async () => {
        const res = await authFetch(`/api/scanner/scan-image/${page.recordId}`);
        if (!res.ok) throw new Error(`读取本机扫描图失败（HTTP ${res.status}）`);
        return res.blob();
      },
    })),
  });
}
```

- [x] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 通过（`StartUploadInput.pages` 元素类型以 `scannerUploadManager.ts:25-34` 为准，若字段名有出入按该处修正）

- [x] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/components/scanner-postprocess/postprocessChannel.ts
git commit -m "feat(scanner): 后处理页本地/远端通道适配与按组补传"
```

---

### Task 7: 视图 1 · 扫描结果（网格/列表/多选删除）

**Files:**
- Create: `src/apps/answer-card/client/components/scanner-postprocess/PostprocessResultsView.tsx`

**Interfaces:**
- Consumes: `PostprocessGroup`、`PostprocessChannel`、ui/v2：`Badge, Button, Checkbox, ConfirmDialog, EmptyState, Input, SegmentedControl, Table 全家, Tip`
- Produces: `PostprocessResultsView({ groups, channel, scans, onDelete })`；`scans: Array<{ recordId: string; createdAt: string; scanQuality: number | null }>`（来自 `GET /api/scanner/card/:cardId/scans`）

- [x] **Step 1: 创建组件**

```tsx
import { useMemo, useState } from "react";
import { CheckSquare, ImageOff, Search, Trash2 } from "lucide-react";
import {
  Badge, Button, Checkbox, ConfirmDialog, EmptyState, Input, SegmentedControl,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableWrap,
} from "../ui/v2";
import type { PostprocessGroup } from "../../../../shared/scanPostprocess";
import type { PostprocessChannel } from "./postprocessChannel";

type Filter = "all" | "normal" | "issue";
type Layout = "grid" | "list";

export interface PostprocessResultsViewProps {
  groups: PostprocessGroup[];
  channel: PostprocessChannel;
  onDelete: (groupIds: string[], force: boolean) => Promise<void>;
  onOpen: (group: PostprocessGroup) => void;
}

function statusOf(group: PostprocessGroup): { tone: "success" | "warning" | "danger"; label: string } {
  if (group.issues.includes("duplicate") || group.issues.includes("student_id") || group.issues.includes("missing_page")) {
    return { tone: "danger", label: group.issues[0] === "duplicate" ? "考号重复" : group.issues[0] === "student_id" ? "考号未识别" : "缺页" };
  }
  if (group.issues.includes("low_confidence")) return { tone: "warning", label: `${group.needsReviewCount} 题存疑` };
  if (group.issues.includes("other")) return { tone: "danger", label: "失败" };
  return { tone: "success", label: group.saved ? "已入库" : "正常" };
}

export function PostprocessResultsView({ groups, channel, onDelete, onOpen }: PostprocessResultsViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [layout, setLayout] = useState<Layout>("grid");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [blockedNotice, setBlockedNotice] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .filter(g => (filter === "all" ? true : filter === "normal" ? g.issues.length === 0 : g.issues.length > 0))
      .filter(g => !q || (g.studentId ?? "").toLowerCase().includes(q))
      .sort((a, b) => (a.issues.length === b.issues.length ? Number(a.groupId) - Number(b.groupId) : b.issues.length - a.issues.length));
  }, [groups, query, filter]);

  const issueCount = groups.filter(g => g.issues.length > 0).length;
  const toggle = (groupId: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
    return next;
  });

  async function runDelete(force: boolean) {
    setDeleting(true);
    try {
      await onDelete([...selected], force);
      setSelected(new Set());
      setSelecting(false);
      setConfirmOpen(false);
      setBlockedNotice(null);
    } catch (error) {
      const err = error as { blocked?: string[]; message?: string };
      if (err?.blocked?.length) { setBlockedNotice(err.blocked); return; }
      throw error;
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle bg-card px-4 py-2">
        <div className="relative w-60">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索考号" className="pl-8" aria-label="搜索考号" />
        </div>
        <SegmentedControl
          aria-label="筛选"
          value={filter}
          onValueChange={setFilter}
          items={[
            { value: "all", label: `全部 ${groups.length}` },
            { value: "normal", label: `正常 ${groups.length - issueCount}` },
            { value: "issue", label: `异常 ${issueCount}` },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant={selecting ? "secondary" : "outline"}
            size="sm"
            icon={<CheckSquare />}
            onClick={() => { setSelecting(v => !v); setSelected(new Set()); }}
          >
            选择
          </Button>
          <SegmentedControl
            aria-label="视图"
            size="sm"
            value={layout}
            onValueChange={setLayout}
            items={[{ value: "grid", label: "方块" }, { value: "list", label: "列表" }]}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {visible.length === 0 ? (
          <EmptyState icon={<ImageOff />} title="没有符合条件的卷子" description="调整筛选或搜索词后重试" size="md" />
        ) : layout === "grid" ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))" }}>
            {visible.map(group => {
              const status = statusOf(group);
              const isSel = selected.has(group.groupId);
              return (
                <button
                  key={group.groupId}
                  type="button"
                  onClick={() => (selecting ? toggle(group.groupId) : onOpen(group))}
                  className={`flex flex-col gap-1 rounded-md border bg-card p-1.5 text-left transition-colors ${
                    group.issues.length ? "ring-2 ring-destructive" : "border-border-subtle"
                  } ${isSel ? "border-primary" : ""}`}
                >
                  <span className="relative block">
                    {selecting && (
                      <span className="absolute left-1 top-1 z-10">
                        <Checkbox checked={isSel} onCheckedChange={() => toggle(group.groupId)} aria-label={`选择 ${group.studentId ?? group.groupId}`} />
                      </span>
                    )}
                    {group.thumbRecordId ? (
                      <img src={channel.imageUrl(group.thumbRecordId)} alt={`第 ${group.groupId} 组答题卡`} className="aspect-[3/4] w-full rounded-xs border border-border bg-paper object-contain" />
                    ) : (
                      <span className="flex aspect-[3/4] w-full items-center justify-center rounded-xs border border-border bg-muted text-xs text-muted-foreground">无图</span>
                    )}
                  </span>
                  <span className="truncate text-xs font-medium tabular-nums">{group.studentId ?? "未识别"}</span>
                  <Badge tone={status.tone} dot className="h-[18px] px-1.5 text-[10.5px]">{status.label}</Badge>
                </button>
              );
            })}
          </div>
        ) : (
          <TableWrap>
            <Table>
              <TableHeader>
                <TableRow>
                  {selecting && <TableHead className="w-10" />}
                  <TableHead>考号</TableHead>
                  <TableHead className="r">页数</TableHead>
                  <TableHead className="r">客观</TableHead>
                  <TableHead className="r">主观</TableHead>
                  <TableHead className="r">总分</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(group => {
                  const status = statusOf(group);
                  const isSel = selected.has(group.groupId);
                  return (
                    <TableRow key={group.groupId} clickable onClick={() => (selecting ? toggle(group.groupId) : onOpen(group))}>
                      {selecting && <TableCell><Checkbox checked={isSel} onCheckedChange={() => toggle(group.groupId)} aria-label={`选择 ${group.studentId ?? group.groupId}`} /></TableCell>}
                      <TableCell className="font-medium tabular-nums">{group.studentId ?? "未识别"}</TableCell>
                      <TableCell className="r tabular-nums">{group.pageCount}</TableCell>
                      <TableCell className="r tabular-nums">{group.objectiveScore}</TableCell>
                      <TableCell className="r tabular-nums">{group.subjectiveScore}</TableCell>
                      <TableCell className="r font-semibold tabular-nums">{group.totalScore}<span className="text-muted-foreground">/{group.maxScore}</span></TableCell>
                      <TableCell><Badge tone={status.tone} dot>{status.label}</Badge></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableWrap>
        )}
      </div>

      {selecting && (
        <div className="flex items-center gap-3 border-t border-border-subtle bg-card px-4 py-2">
          <b className="text-sm tabular-nums">已选 {selected.size} 张</b>
          <span className="text-xs text-muted-foreground">删除 = 移除本地扫描记录与识别结果，不影响远端已上传成绩</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => { setSelecting(false); setSelected(new Set()); }}>取消</Button>
            <Button variant="destructive" size="sm" icon={<Trash2 />} disabled={!selected.size || deleting} loading={deleting} onClick={() => void runDelete(false)}>
              删除选中（{selected.size}）
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen || !!blockedNotice}
        onOpenChange={open => { if (!open) { setConfirmOpen(false); setBlockedNotice(null); } }}
        title={`删除 ${selected.size} 张扫描卡？`}
        description={blockedNotice
          ? `其中 ${blockedNotice.length} 张已上传或待确认（${blockedNotice.join("、")}）。删除只移除本地记录与识别结果，远端成绩保留且不可再补传；确认知晓后继续。`
          : "本地扫描记录与识别结果将被移除，不可恢复。已上传的远端成绩不受影响。"}
        confirmLabel={blockedNotice ? "知晓代价，仍删除" : "删除，不可恢复"}
        loading={deleting}
        onConfirm={() => void runDelete(!!blockedNotice)}
      />
    </div>
  );
}
```

注意：`runDelete(false)` 前应 `setConfirmOpen(true)`——把删除按钮的 `onClick` 改为 `() => setConfirmOpen(true)`，`runDelete` 只在 ConfirmDialog 的 `onConfirm` 中调用。实现时按此修正（按钮不直接删）。

- [x] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 通过

- [x] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/components/scanner-postprocess/PostprocessResultsView.tsx
git commit -m "feat(scanner): 后处理页视图 1 扫描结果（网格/列表/多选删除）"
```

---

### Task 8: 视图 2 · 卡查看与改分

**Files:**
- Create: `src/apps/answer-card/client/components/scanner-postprocess/PostprocessCorrectionView.tsx`

**Interfaces:**
- Consumes: `CorrectionCanvas`、`correctionState/toggleCorrectionCell`、`selectObjectiveOptionCells/selectScoreCells`、`gradeCombinedRecognition`（`shared/grading.ts:334`）、`findObjectiveQuestion`、`isMultiSelectMode`（`shared/objectiveMode`）、ui/v2：`Button, Input, Select 全家, Table 全家, Badge, Spinner`
- Produces: `PostprocessCorrectionView({ channel, card, sessionId, groupId, highlightQuestion, onSaved })`

- [x] **Step 1: 创建组件**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Save } from "lucide-react";
import {
  Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Spinner, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableWrap,
} from "../ui/v2";
import { authFetch } from "../../auth/api";
import { CorrectionCanvas } from "./CorrectionCanvas";
import type { PostprocessChannel } from "./postprocessChannel";
import {
  correctionState, toggleCorrectionCell, type CorrectionDocument, type CorrectionEdit,
} from "../../../../../shared/scanCorrection";
import { selectObjectiveOptionCells, selectScoreCells } from "../../../../../shared/correctionCellSelect";
import {
  gradeCombinedRecognition, findObjectiveQuestion, OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD,
} from "../../../../../shared/grading";
import { isMultiSelectMode, objectiveModeLabel } from "../../../../../shared/objectiveMode";
import type { AnswerCard } from "../../../../../shared/types";

export interface PostprocessCorrectionViewProps {
  channel: PostprocessChannel;
  card: AnswerCard;
  sessionId: string;
  groupId: string;
  highlightQuestion?: number | null;
  onSaved: () => void | Promise<void>;
}

interface Row {
  questionNumber: number;
  kind: "objective" | "subjective";
  questionId?: string;
  blockId?: string;
  typeLabel: string;
  score: number;
  maxScore: number;
  recognized: string;
  reviewed: boolean;
  modified: boolean;
}

export function PostprocessCorrectionView({ channel, card, sessionId, groupId, highlightQuestion, onSaved }: PostprocessCorrectionViewProps) {
  const url = channel.correctionUrl(sessionId, groupId);
  const [document, setDocument] = useState<CorrectionDocument | null>(null);
  const [edits, setEdits] = useState<CorrectionEdit[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const blobs: string[] = [];
    setBusy(true);
    setDocument(null);
    void (async () => {
      try {
        const response = await channel.request(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "加载答题卡失败");
        const doc = data as CorrectionDocument;
        const loaded: Record<string, string> = {};
        for (const page of doc.pages) {
          const image = await channel.request(page.imageUrl);
          if (!image.ok) throw new Error("完整答题卡图片加载失败");
          const blob = URL.createObjectURL(await image.blob());
          if (!alive) { URL.revokeObjectURL(blob); return; }
          blobs.push(blob);
          loaded[page.sourceId] = blob;
        }
        if (!alive) return;
        setDocument(doc);
        setImages(loaded);
        setEdits(doc.pages.map(p => ({ sourceId: p.sourceId, revision: p.revision, selected: [...p.selected], touched: [] })));
        setPageIndex(0);
      } catch (error) {
        if (alive) setMessage(error instanceof Error ? error.message : "加载失败");
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; blobs.forEach(b => URL.revokeObjectURL(b)); };
  }, [url, channel]);

  const page = document?.pages[pageIndex];
  const edit = edits[pageIndex];
  const state = document && page && edit ? correctionState(document.card, page, edit.selected, edit.touched) : null;
  const reviewQuestions = useMemo(() => {
    const set = new Set<number>();
    if (!state) return set;
    for (const q of state.recognition.questions ?? []) if ((q.confidence ?? 0) < OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD) set.add(q.questionNumber);
    for (const q of state.recognition.subjectiveQuestions ?? []) if (q.status !== "ok") set.add(q.questionNumber);
    return set;
  }, [state]);

  const rows = useMemo<Row[]>(() => {
    if (!document || !state) return [];
    const graded = gradeCombinedRecognition(document.card, `group-${groupId}`, state.recognition, OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD);
    const original = page?.recognition;
    const objective: Row[] = graded.questions.map(q => {
      const definition = findObjectiveQuestion(document.card, q.questionNumber)?.definition;
      const origin = original?.questions?.find(o => o.questionNumber === q.questionNumber);
      const changed = origin && [...origin.selectedOptions].sort().join() !== [...q.selectedOptions].sort().join();
      return {
        questionNumber: q.questionNumber, kind: "objective", typeLabel: objectiveModeLabel(definition?.mode ?? "single"),
        score: q.score, maxScore: q.maxScore, recognized: (origin?.selectedOptions ?? []).join(",") || "—",
        reviewed: q.needsReview, modified: !!changed,
      };
    });
    const subjective: Row[] = graded.subjectiveQuestions.map(q => {
      const origin = original?.subjectiveQuestions?.find(o => o.questionId === q.questionId);
      return {
        questionNumber: q.questionNumber, kind: "subjective", questionId: q.questionId, blockId: q.blockId,
        typeLabel: "解答", score: q.score, maxScore: q.maxScore,
        recognized: origin ? String(origin.score) : "—", reviewed: q.status !== "ok" || q.needsReview,
        modified: origin ? origin.score !== q.score : false,
      };
    });
    return [...objective, ...subjective].sort((a, b) => a.questionNumber - b.questionNumber || (a.kind === b.kind ? 0 : a.kind === "objective" ? -1 : 1));
  }, [document, state, page, groupId]);

  const totals = useMemo(() => {
    const objective = rows.filter(r => r.kind === "objective").reduce((sum, r) => sum + r.score, 0);
    const subjective = rows.filter(r => r.kind === "subjective").reduce((sum, r) => sum + r.score, 0);
    const max = rows.reduce((sum, r) => sum + r.maxScore, 0);
    return { objective, subjective, total: objective + subjective, max };
  }, [rows]);

  const dirty = !!document && edits.some((e, i) => {
    const original = document.pages[i];
    return [...original.selected].sort().join() !== [...e.selected].sort().join() || !!e.touched?.length;
  });

  function applyCells(nextSelected: string[] | null, sourceId: string) {
    if (!nextSelected) { setMessage("该值在卡面上无法表示（缺少对应填涂格）"); return; }
    setMessage("");
    setEdits(current => current.map(e => e.sourceId === sourceId ? { ...e, selected: nextSelected } : e));
  }

  function setObjectiveAnswer(questionNumber: number, options: string[]) {
    if (!document || !page || !edit) return;
    const cells = document.pages.flatMap(p => p.layout.elements) as Parameters<typeof selectObjectiveOptionCells>[0];
    applyCells(selectObjectiveOptionCells(cells, questionNumber, options), page.sourceId);
  }

  function setSubjectiveScore(questionId: string, blockId: string | undefined, score: number) {
    if (!document || !page) return;
    const cells = document.pages.flatMap(p => p.layout.elements) as Parameters<typeof selectScoreCells>[0];
    const row = rows.find(r => r.questionId === questionId);
    applyCells(selectScoreCells(cells, questionId, blockId, score, row?.maxScore ?? 0), page.sourceId);
  }

  function toggle(cellId: string) {
    if (!document || !page || busy) return;
    setEdits(current => current.map(e => e.sourceId === page.sourceId
      ? { ...e, selected: toggleCorrectionCell(document.card, page, e.selected, cellId), touched: page.invalid.includes(cellId) ? [...new Set([...(e.touched ?? []), cellId])] : e.touched }
      : e));
    setMessage("");
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await channel.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages: edits }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "保存失败");
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (busy && !document) return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> 正在加载答题卡…</div>;
  if (!document || !page || !edit) return <div className="flex flex-1 items-center justify-center text-sm text-destructive-fg">{message || "加载失败"}</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle bg-card px-4 py-2 text-sm">
        <span className="tabular-nums">客观题 <b>{totals.objective}</b> · 主观题 <b>{totals.subjective}</b> · 总分 <b>{totals.total}</b><span className="text-muted-foreground">/{totals.max}</span></span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={pageIndex === 0} onClick={() => setPageIndex(i => i - 1)}>上一页</Button>
          <span className="tabular-nums">{pageIndex + 1} / {document.pages.length}</span>
          <Button size="sm" variant="outline" disabled={pageIndex === document.pages.length - 1} onClick={() => setPageIndex(i => i + 1)}>下一页</Button>
          <Button size="sm" variant="outline" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - 0.5))}>缩小</Button>
          <Button size="sm" variant="outline" disabled={zoom >= 4} onClick={() => setZoom(z => Math.min(4, z + 0.5))}>放大</Button>
          <Button variant="primary" size="sm" icon={<Save />} disabled={!dirty || saving} loading={saving} onClick={() => void save()}>保存修改</Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <div className="min-w-0 flex-1 overflow-auto rounded-md bg-muted p-3">
          <CorrectionCanvas document={document} pageIndex={pageIndex} edit={edit} images={images} zoom={zoom} busy={busy} reviewQuestions={reviewQuestions} onToggle={toggle} />
        </div>
        <div ref={tableRef} className="min-w-0 flex-1 overflow-auto">
          <TableWrap>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>题号</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead className="r">得分/满分</TableHead>
                  <TableHead>识别</TableHead>
                  <TableHead className="w-40">修改</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...rows].sort((a, b) => Number(b.reviewed) - Number(a.reviewed)).map(row => (
                  <TableRow key={`${row.kind}-${row.questionNumber}-${row.questionId ?? ""}`} selected={row.modified} className={row.reviewed ? "bg-warning-soft" : undefined}>
                    <TableCell className="font-medium tabular-nums">{row.questionNumber}</TableCell>
                    <TableCell>{row.typeLabel}</TableCell>
                    <TableCell className="r tabular-nums">{row.score}/{row.maxScore}</TableCell>
                    <TableCell className="tabular-nums">{row.recognized}{row.reviewed && <Badge tone="warning" dot className="ml-2">存疑</Badge>}</TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      {row.kind === "objective" ? (
                        isMultiSelectMode(findObjectiveQuestion(document.card, row.questionNumber)?.definition.mode ?? "single") ? (
                          <div className="flex flex-wrap gap-1">
                            {(findObjectiveQuestion(document.card, row.questionNumber)?.definition.optionCount ? Array.from({ length: findObjectiveQuestion(document.card, row.questionNumber)!.definition.optionCount! }, (_, i) => String.fromCharCode(65 + i)) : []).map(option => {
                              const current = rows.find(r => r.questionNumber === row.questionNumber && r.kind === "objective");
                              const on = state?.recognition.questions?.find(q => q.questionNumber === row.questionNumber)?.selectedOptions.includes(option) ?? false;
                              return (
                                <Button key={option} size="sm" variant={on ? "primary" : "outline"} className="h-6 px-2" aria-pressed={on}
                                  onClick={() => {
                                    const now = state?.recognition.questions?.find(q => q.questionNumber === row.questionNumber)?.selectedOptions ?? [];
                                    setObjectiveAnswer(row.questionNumber, on ? now.filter(o => o !== option) : [...now, option]);
                                  }}>
                                  {option}
                                </Button>
                              );
                            })}
                          </div>
                        ) : (
                          <Select
                            value={state?.recognition.questions?.find(q => q.questionNumber === row.questionNumber)?.selectedOptions[0] ?? ""}
                            onValueChange={value => setObjectiveAnswer(row.questionNumber, value ? [value] : [])}
                          >
                            <SelectTrigger className="h-8"><SelectValue placeholder="未答" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="">未答</SelectItem>
                              {(findObjectiveQuestion(document.card, row.questionNumber)?.definition.optionCount ? Array.from({ length: findObjectiveQuestion(document.card, row.questionNumber)!.definition.optionCount! }, (_, i) => String.fromCharCode(65 + i)) : []).map(option => (
                                <SelectItem key={option} value={option}>{option}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )
                      ) : (
                        <Input
                          type="number" min={0} max={row.maxScore} step={0.5} defaultValue={row.score} className="h-8 w-24 tabular-nums"
                          onBlur={e => {
                            const value = Number(e.target.value);
                            if (Number.isFinite(value)) setSubjectiveScore(row.questionId!, row.blockId, value);
                          }}
                          aria-label={`第 ${row.questionNumber} 题分数`}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        </div>
      </div>
      {message && <div role="status" className="border-t border-border-subtle bg-card px-4 py-2 text-sm text-destructive-fg">{message}</div>}
    </div>
  );
}
```

实现注意（执行模型必读）：
- `objectiveModeLabel` 若不在 `shared/objectiveMode` 导出（Web 端 `ScoreFixPage.tsx:488` 有引用，按其 import 路径对齐）。
- 多选客观题的 `current` 变量未使用，删除之；`on` 的取值统一用 `state.recognition.questions`。
- `highlightQuestion` 传入时，挂载后滚动表格到该行（`tableRef` + `data-question` 属性 + `scrollIntoView({block:"center"})`），并在画布上由 `reviewQuestions`/选中态自然体现。
- `layout.elements` 的类型即 `CorrectionCell[]` 的超集，`as` 断言仅为收敛联合；若 typecheck 报不适配，改用 `correctionCells(page.layout)` 逐页 concat。

- [x] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 通过

- [x] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/components/scanner-postprocess/PostprocessCorrectionView.tsx
git commit -m "feat(scanner): 后处理页视图 2 卡查看与改分（点选+按题并存）"
```

---

### Task 9: 视图 3 · 异常队列与五面板

**Files:**
- Create: `src/apps/answer-card/client/components/scanner-postprocess/PostprocessQueueView.tsx`

**Interfaces:**
- Consumes: `PostprocessQueueItem`、`PostprocessChannel`、`CorrectionCanvas`、`selectStudentDigitCells`、`uniqueScanConflictCards`、ui/v2：`Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Progress, Tip`
- Produces: `PostprocessQueueView({ queue, channel, card, examId, scans, onResolved, onJumpToCorrection })`

- [x] **Step 1: 创建组件（队列外壳 + 五面板）**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, SkipForward, TriangleAlert } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Progress } from "../ui/v2";
import { notify } from "../ui/v2";
import { CorrectionCanvas } from "./CorrectionCanvas";
import type { PostprocessChannel } from "./postprocessChannel";
import type { PostprocessQueueItem } from "../../../../shared/scanPostprocess";
import { selectStudentDigitCells } from "../../../../shared/correctionCellSelect";
import { uniqueScanConflictCards, type ScanConflictCard } from "../../../../shared/scanPages";
import type { CorrectionDocument, CorrectionEdit } from "../../../../shared/scanCorrection";
import type { AnswerCard } from "../../../../shared/types";

export interface ScanMeta { recordId: string; createdAt: string; scanQuality: number | null; }

export interface PostprocessQueueViewProps {
  queue: PostprocessQueueItem[];
  channel: PostprocessChannel;
  card: AnswerCard;
  examId: number | null;
  scans: ScanMeta[];
  onResolved: () => void | Promise<void>;
  onJumpToCorrection: (groupId: string, questionNumber?: number) => void;
}

export function PostprocessQueueView({ queue, channel, card, examId, scans, onResolved, onJumpToCorrection }: PostprocessQueueViewProps) {
  const [cursor, setCursor] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const remaining = queue.filter(item => !skipped.has(item.id));
  const current = remaining[Math.min(cursor, Math.max(0, remaining.length - 1))];
  const doneCount = queue.length - remaining.length;

  useEffect(() => { setCursor(0); setSkipped(new Set()); }, [queue.length === 0]);

  if (!current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <Badge tone="success" dot>队列已清零</Badge>
        <p className="text-sm text-muted-foreground">本批 {queue.length} 条异常全部处理完成；正常卷与已处理卷将按现有流程上传。</p>
      </div>
    );
  }

  const advance = () => setSkipped(prev => new Set(prev)); // no-op guard
  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4">
      <Card className="flex w-[260px] shrink-0 flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-baseline justify-between text-base">
            异常队列 <span className="text-xs font-normal tabular-nums text-muted-foreground">第 {Math.min(cursor, remaining.length - 1) + 1} / {remaining.length} 条</span>
          </CardTitle>
          <Progress value={queue.length ? Math.round((doneCount / queue.length) * 100) : 0} size="sm" />
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
          {queue.map(item => {
            const isDone = skipped.has(item.id) ? false : !remaining.includes(item);
            const isCurrent = item.id === current.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setCursor(remaining.findIndex(r => r.id === item.id))}
                className={`rounded-md border px-2 py-1.5 text-left text-xs ${isCurrent ? "border-primary bg-accent-soft" : "border-border-subtle bg-card"} ${isDone ? "line-through opacity-60" : ""}`}
              >
                <span className="flex items-center gap-2">
                  <Badge tone={item.kind === "duplicate" || item.kind === "student_id" ? "danger" : item.kind === "missing_page" ? "danger" : item.kind === "low_confidence" ? "warning" : "neutral"} dot>
                    {item.kind === "duplicate" ? "考号重复" : item.kind === "student_id" ? "考号问题" : item.kind === "missing_page" ? "缺页" : item.kind === "low_confidence" ? "存疑" : "其他"}
                  </Badge>
                  <span className="truncate tabular-nums">{item.studentId ?? `组 ${item.groupId}`}</span>
                </span>
                <span className="mt-0.5 block truncate text-muted-foreground">{item.label}</span>
              </button>
            );
          })}
        </CardContent>
        <CardContent className="flex gap-2 border-t border-border-subtle pt-2">
          <Button variant="outline" size="sm" className="flex-1" icon={<SkipForward />} onClick={() => { setSkipped(prev => new Set(prev).add(current.id)); }}>暂时跳过</Button>
          <Button variant="secondary" size="sm" className="flex-1" icon={<ArrowDown />} disabled={cursor >= remaining.length - 1} onClick={() => setCursor(c => c + 1)}>下一条</Button>
        </CardContent>
      </Card>

      <div className="min-w-0 flex-1 overflow-auto">
        {current.kind === "student_id" && <StudentIdPanel item={current} channel={channel} card={card} examId={examId} onResolved={onResolved} />}
        {current.kind === "duplicate" && <DuplicatePanel item={current} channel={channel} scans={scans} onResolved={onResolved} onFixStudentId={onJumpToCorrection} />}
        {current.kind === "missing_page" && <MissingPagePanel item={current} channel={channel} onResolved={onResolved} />}
        {current.kind === "low_confidence" && <LowConfidencePanel item={current} channel={channel} onJump={onJumpToCorrection} />}
        {current.kind === "other" && <OtherPanel item={current} channel={channel} onResolved={onResolved} />}
      </div>
    </div>
  );
}
```

- [x] **Step 2: 同文件追加五面板**

`StudentIdPanel`（考号修正，D10）：左列 = 考号区裁图（`CorrectionCanvas` zoom=3 外套 `overflow-auto` 容器，挂载后对第一个 `student_digit` polygon `scrollIntoView`）+ 整卡缩略图；右列 = `Input` 考号 + 联想列表（`examId` 非空时 `GET /api/exams/:examId/participant-search?q=`，300ms 防抖，显示 `考号 姓名`；为空则只允许手输）+ `Button primary`「确认考号·重新匹配学生」+ 不在名单时 `Badge tone="danger"`「该考号不在应考名单」仍可确认。确认流程：

```ts
async function confirmStudentId(digits: string) {
  setBusy(true);
  try {
    const response = await channel.request(channel.correctionUrl(item.sessionId, item.groupId));
    const doc = (await response.json()) as CorrectionDocument;
    const cells = doc.pages.flatMap(p => correctionCells(p.layout));
    const picked = selectStudentDigitCells(cells, digits);
    if (!picked) { notify.error("考号位数与卡面不符"); return; }
    const pickedSet = new Set(picked);
    const digitIds = new Set(cells.filter(c => c.type === "student_digit").map(c => c.id));
    const pages: CorrectionEdit[] = doc.pages.map(p => {
      const pageDigitIds = new Set(correctionCells(p.layout).filter(c => c.type === "student_digit").map(c => c.id));
      const kept = p.selected.filter(id => !digitIds.has(id) || !pageDigitIds.has(id));
      const added = picked.filter(id => pageDigitIds.has(id));
      return { sourceId: p.sourceId, revision: p.revision, selected: [...kept, ...added], touched: [] };
    });
    const put = await channel.request(channel.correctionUrl(item.sessionId, item.groupId), {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages }),
    });
    const result = await put.json();
    if (!put.ok) throw new Error(result.message || "保存考号失败");
    notify.success(`考号已改为 ${digits}`);
    await onResolved();
  } catch (error) {
    notify.error(error instanceof Error ? error.message : "保存考号失败");
  } finally { setBusy(false); }
}
```

`DuplicatePanel`（D11）：`cards = uniqueScanConflictCards(item.conflicts)` 并排 `Card`（`grid grid-cols-2 gap-4`）：首页图（`channel.imageUrl(card.pages[0].recordId)`，`bg-muted p-2 rounded-md` 恒白托底）、考号/总分（等宽）、扫描时间与清晰度（`scans` 按 recordId 关联，`createdAt` 取组内最早、`scanQuality` 取均值，保留 1 位小数）、`Badge`（`previouslySaved` → 「已入库」neutral；`formalScoreRetained` → 「正式成绩保留」warning）。倾向提示：两卡 `totalScore` 相等且页数相等 → 「总分与页数一致，倾向同一张卡重扫」，否则「差异较大，倾向考号撞车，请看图确认」（`Badge tone="info"`）。操作：每卡 `Button outline`「保留这份」→ 对**另一张** `POST channel.discardUrl(other.sessionId, other.groupId)`（`other.previouslySaved` 时禁用 + `Tip`「已入库卷不能作废，请改考号」）；`Button ghost`「不是同一人 → 改考号」→ `onFixStudentId(card.groupId)`。成功后 `onResolved()`。

`MissingPagePanel`：期望页 `1..card 布局页数` 与实际 `layoutPage` 对照表（缺的红色 `Badge danger`）、已有页缩略图行、`Button outline`「重新识别此卡」→ `POST channel.retryUrl(sessionId)` body `{groupId}`（远端通道无 retry 时隐藏该按钮并提示去 Windows 端）、`CardCorrectionButton url=correctionUrl`、`Button ghost`「删除该组」→ 复用视图 1 的删除护栏（`DELETE` 端点，force 流程同 Task 7）。

`LowConfidencePanel`：拉 correction 文档，列 `confidence < OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD` 的客观题与 `status !== "ok"` 的主观题（题号 + 置信度两位小数 + 识别值），每行 `Button outline sm`「去改这题」→ `onJump(groupId, questionNumber)`。

`OtherPanel`：`TriangleAlert` + `item.failureMessage` + `CardCorrectionButton` + 「重新识别此卡」（同 MissingPagePanel 门控）。

- [x] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 通过

- [x] **Step 4: Commit**

```bash
git add src/apps/answer-card/client/components/scanner-postprocess/PostprocessQueueView.tsx
git commit -m "feat(scanner): 后处理页视图 3 异常队列（考号/重卡/缺页/存疑/兜底五面板）"
```

---

### Task 10: 页外壳 + ScannerApp 接线

**Files:**
- Create: `src/apps/answer-card/client/components/ScannerPostprocessPage.tsx`
- Modify: `src/apps/answer-card/client/components/ScannerWorkspace.tsx:51-60, 227-235`
- Modify: `src/apps/answer-card/client/ScannerApp.tsx:23, 30-34, 119-130`

- [x] **Step 1: 创建 `ScannerPostprocessPage.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge, Button, SegmentedControl, Spinner, notify } from "./ui/v2";
import { authFetch } from "./auth/api";
import { fetchCardDetailSynced } from "./lib/scannerSync";
import { cardFingerprint } from "../../../shared/cardVersion";
import { buildLayout } from "../../../shared/layout";
import { buildPostprocessGroups, buildPostprocessQueue, filterDeletableGroups, type PostprocessGroup } from "../../../shared/scanPostprocess";
import type { ScanBatchResponse } from "../../../shared/scanPages";
import type { AnswerCard } from "../../../shared/types";
import { localChannel, loadSessionMeta, queueGroupUpload, type PostprocessChannel, type SessionMeta } from "./scanner-postprocess/postprocessChannel";
import { PostprocessResultsView } from "./scanner-postprocess/PostprocessResultsView";
import { PostprocessCorrectionView } from "./scanner-postprocess/PostprocessCorrectionView";
import { PostprocessQueueView, type ScanMeta } from "./scanner-postprocess/PostprocessQueueView";
import { getScannerMode, isRemoteServerConfigured } from "./lib/scannerMode";
import { scannerUploadManager } from "./lib/scannerUploadManager";

type View = "results" | "correction" | "queue";

export interface ScannerPostprocessPageProps {
  cardId: string;
  cardTitle: string;
  sessions: Array<{ sessionId: string; pageCount: number }>;
  onBack: () => void;
  skin?: string;
  onSkinChange?: (skin: string) => void;
}

export function ScannerPostprocessPage({ cardId, cardTitle, sessions, onBack }: ScannerPostprocessPageProps) {
  const [view, setView] = useState<View>("results");
  const [card, setCard] = useState<AnswerCard | null>(null);
  const [batches, setBatches] = useState<Record<string, ScanBatchResponse>>({});
  const [metas, setMetas] = useState<Record<string, SessionMeta>>({});
  const [scans, setScans] = useState<ScanMeta[]>([]);
  const [active, setActive] = useState<PostprocessGroup | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const remoteConfigured = getScannerMode() === "remote" && isRemoteServerConfigured();
  // 通道裁定（spec §5）：后处理页单一本地事实源；远端语义只经 queueGroupUpload 补传承担
  const channel: PostprocessChannel = useMemo(() => localChannel(), []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { card: loaded } = await fetchCardDetailSynced(cardId);
      if (!loaded) throw new Error("答题卡不存在");
      setCard(loaded as AnswerCard);
      const nextBatches: Record<string, ScanBatchResponse> = {};
      const nextMetas: Record<string, SessionMeta> = {};
      for (const { sessionId } of sessions) {
        nextBatches[sessionId] = await channel.results(sessionId);
        nextMetas[sessionId] = await loadSessionMeta(sessionId);
      }
      setBatches(nextBatches);
      setMetas(nextMetas);
      // 补传护栏基线：已有 job 覆盖的组 + 加载时已 saved 的组 = 「已上传/已入库」，handleSaved 不重传
      const covered = new Set<string>();
      for (const job of scannerUploadManager.getState().jobs) {
        if (job.cardId !== cardId) continue;
        for (const p of job.pages) if (p.input.groupId) covered.add(p.input.groupId);
      }
      for (const batch of Object.values(nextBatches)) for (const r of batch.results) if (r.saved) covered.add(r.groupId);
      uploadedAtLoad.current = covered;
      const scanList = await authFetch(`/api/scanner/card/${cardId}/scans`);
      if (scanList.ok) {
        const rows = (await scanList.json()) as Array<{ recordId: string; createdAt: string; scanQuality: number | null }>;
        setScans(rows);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [cardId, sessions, channel]);

  useEffect(() => { void reload(); }, [reload]);

  const layoutPageCount = card ? buildLayout(card).pages.length : 0;
  const groups = useMemo(() => {
    if (!card) return [];
    return sessions.flatMap(({ sessionId }) => buildPostprocessGroups(batches[sessionId] ?? { results: [], failures: [] }, sessionId, layoutPageCount));
  }, [batches, sessions, layoutPageCount, card]);
  const queue = useMemo(() => buildPostprocessQueue(groups), [groups]);
  const issueCount = queue.length;
  const uploaded = useMemo(() => Object.values(batches).flatMap(b => b.results).filter(r => r.saved).length, [batches]);

  async function handleDelete(groupIds: string[], force: boolean) {
    const sessionId = sessions[sessions.length - 1]?.sessionId;
    const url = channel.deleteGroupsUrl(sessionId);
    if (!url) { notify.error("远端模式不支持删除扫描记录"); return; }
    const res = await channel.request(url, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupIds, force }) });
    const data = await res.json();
    if (res.status === 409) throw Object.assign(new Error(data.message || "存在已上传回执"), { blocked: data.blocked ?? [] });
    if (!res.ok) throw new Error(data.message || "删除失败");
    notify.success(`已删除 ${data.deletedGroups ?? groupIds.length} 组扫描记录`);
    await reload();
  }

  /** 加载时记录「已上传/已入库」组与已有 job 覆盖的组，供补传护栏使用 */
  const uploadedAtLoad = useRef<Set<string>>(new Set());

  /**
   * 补传护栏（D12 + 防重复回执撤正式成绩，spec §5）：
   * 重复学号二次回执到服务端会 conflict → withdraw() 删 student_scores/question_scores
   * （scannerSubmissions.ts:121-141、:515），故已上传的组绝不重传。
   * 判定顺序：本地模式不上传 → 已有 job 则复用（失败页 retryFailed）→ 加载时已上传则提示走 Web 成绩修改 → 其余首传。
   */
  async function handleSaved(sessionId: string, groupId: string) {
    const wasUploaded = uploadedAtLoad.current.has(groupId);
    const job = scannerUploadManager.getState().jobs.find(j => j.cardId === cardId && j.pages.some(p => p.input.groupId === groupId));
    await reload();
    if (!remoteConfigured) return; // 本地模式：保存即本地入库，无上传动作（与现状一致）
    if (job) {
      if (job.status === "error" && job.pages.some(p => p.failed)) {
        scannerUploadManager.retryFailed(job.id);
        notify.info("已按原上传任务重试失败页，不新建会话");
      } else {
        notify.info("该卷已有上传任务，进度见右上角上传卡");
      }
      return;
    }
    if (wasUploaded) {
      notify.info("该卷已上传入库；服务器成绩修改请走 Web 成绩修改，本页仅改本地留档");
      return;
    }
    const batch = batches[sessionId];
    const result = batch?.results.find(r => r.groupId === groupId);
    const meta = metas[sessionId];
    if (result && meta && card) {
      queueGroupUpload({ cardId: card.id, cardVersion: cardFingerprint(card), identityMode: meta.identityMode, dpi: meta.dpi, paperSize: meta.paperSize }, sessionId, result);
      notify.info("已加入上传队列，图片后台续传");
    }
  }

  if (loading && !card) return <div className="flex h-[100dvh] items-center justify-center bg-background"><Spinner size={24} /></div>;
  if (!card) return <div className="flex h-[100dvh] items-center justify-center bg-background text-sm text-destructive-fg">{error}</div>;

  return (
    <main className="flex h-[100dvh] min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex h-page-header shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-5">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="返回扫描"><ArrowLeft size={18} /></Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-base font-semibold">{cardTitle} · 扫描结果</strong>
          <span className="truncate text-xs text-muted-foreground tabular-nums">
            已扫 {groups.length} 组 · 正常 {groups.length - new Set(queue.map(q => q.groupId)).size} · 异常 {new Set(queue.map(q => q.groupId)).size} · 已入库 {uploaded}
          </span>
        </div>
        <SegmentedControl
          aria-label="后处理视图"
          value={view}
          onValueChange={setView}
          items={[
            { value: "results", label: "扫描结果" },
            { value: "correction", label: "卡查看与改分" },
            { value: "queue", label: <span className="flex items-center gap-1.5">异常处理{issueCount > 0 && <Badge tone="danger" className="h-[18px] px-1.5 text-[10.5px] tabular-nums">{issueCount}</Badge>}</span> },
          ]}
        />
      </header>
      {view === "results" && (
        <PostprocessResultsView
          groups={groups}
          channel={channel}
          onDelete={handleDelete}
          onOpen={group => { setActive(group); setView(group.issues.length ? "queue" : "correction"); }}
        />
      )}
      {view === "correction" && active && (
        <PostprocessCorrectionView
          channel={channel}
          card={card}
          sessionId={active.sessionId}
          groupId={active.groupId}
          highlightQuestion={highlight}
          onSaved={() => handleSaved(active.sessionId, active.groupId)}
        />
      )}
      {view === "correction" && !active && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">先在「扫描结果」里选一张卷子</div>
      )}
      {view === "queue" && (
        <PostprocessQueueView
          queue={queue}
          channel={channel}
          card={card}
          examId={Object.values(metas)[0]?.examId ?? null}
          scans={scans}
          onResolved={reload}
          onJumpToCorrection={(groupId, questionNumber) => {
            const group = groups.find(g => g.groupId === groupId) ?? null;
            setActive(group);
            setHighlight(questionNumber ?? null);
            setView("correction");
          }}
        />
      )}
    </main>
  );
}
```

实现注意：
- 通道唯一为 `localChannel()`；**不要** reintroduce `remoteChannel`（sessionId 与 `job.remoteSessionId` 不通、`requestJob` 对已收尾 job 直接 reject，见 spec §5 通道裁定）。
- `handleSaved` 的补传护栏顺序不可调换；`uploadedAtLoad` 必须在 `reload()` 内、`setBatches` 之后同步刷新，否则续扫第二批后护栏基线过期。
- `job.pages[].input.groupId` 形状见 `scannerUploadManager.ts` 的 `UploadPageInput`（:25-34）与 `getFailedPageBlobs`（:868）的用法。

- [x] **Step 2: ScannerWorkspace 透传**

`Props`（:51-60）追加 `onScansComplete?: (sessionId: string, pageCount: number) => void;`；:230-233 回调改为：

```tsx
                onScansComplete={(sid, pageCount) => {
                  // v2.5.1: 保持面板挂在 done 视图；v2.7.2: 同时上抛给 ScannerApp 自动跳后处理页
                  setStatus(`扫描完成：${pageCount} 张`);
                  onScansComplete?.(sid, pageCount);
                }}
```

- [x] **Step 3: ScannerApp 接线**

- :23 改为 `type Page = "select" | "workspace" | "postprocess";`
- :34 之后追加 `const [postSessions, setPostSessions] = useState<Array<{ sessionId: string; pageCount: number }>>([]);`
- :119-130 的 workspace 分支传入 `onScansComplete={(sid, pageCount) => { setPostSessions(prev => [...prev.filter(p => p.sessionId !== sid), { sessionId: sid, pageCount }]); setPage("postprocess"); }}`
- 在该分支**之前**插入：

```tsx
  if (page === "postprocess" && selectedCardId && postSessions.length) {
    return (
      <ScannerPostprocessPage
        cardId={selectedCardId}
        cardTitle={selectedCardTitle}
        sessions={postSessions}
        onBack={() => setPage("workspace")}
        skin={skin}
        onSkinChange={setSkin}
      />
    );
  }
```

并 import `ScannerPostprocessPage`。

- [x] **Step 4: 构建验证**

Run: `npm run typecheck && npm run build:scanner:full`
Expected: 通过

- [x] **Step 5: Commit**

```bash
git add src/apps/answer-card/client/components/ScannerPostprocessPage.tsx src/apps/answer-card/client/components/ScannerWorkspace.tsx src/apps/answer-card/client/ScannerApp.tsx
git commit -m "feat(scanner): 扫描后处理页外壳与扫完自动跳入接线"
```

---

### Task 11: 草案自包含 + 文档导航 + 全量回归

**Files:**
- Modify: `docs/扫描端后处理页-ui草案.html`
- Modify: `readus/扫描端胶囊.md`

- [x] **Step 1: 核对草案自包含（v6 已定稿，无需重画）**

`docs/扫描端后处理页-ui草案.html` 已于 2026-10-17 定为 v6 自包含版（视图 2 完整画法已并入、网格/缩略图/红描边/ConfirmDialog 标注已按说明书 §6 修正）。本步仅核对：文件头 subtitle 含「v6 · 自包含定稿」、视图 2 块含五列表格与汇总条、视图 1 网格为 `repeat(auto-fill,minmax(128px,1fr))`。若缺失才按 `.superpowers/brainstorm/1700-1792230517/content/scan-post-processing-v4.html` 的视图 2 块补入。

- [x] **Step 2: 胶囊增补**

在 `readus/扫描端胶囊.md` 的界面/入口章节追加一节「扫描后处理页（v2.7.2+）」：入口（扫完自动跳 / 返回扫描）、三视图职责、复用端点表（指向说明书 §5）、新增端点 `DELETE /api/scanner/session/:sid/groups`、验证命令 `npm run verify:scanner-postprocess`。

- [x] **Step 3: 全量回归**

Run:
```bash
npm run typecheck
npm run verify:scanner-postprocess
npm run verify:scan-correction
npm run verify:scanner-batch-results
npm run verify:scanner-pending
npm run verify:scanner-upload-manager
npm run verify:scanner-review-fixes
npm run build:scanner:full
```
Expected: 全绿；任何一条红先修再继续。

- [x] **Step 4: 手工验收（隔离数据）**

1. `npm run dev` 后以扫描端登录，真扫或导入一小批（含 1 张重复考号、1 张缺页、1 张低置信）；
2. 扫完自动进入后处理页；三 Tab 切换、网格/列表、搜索/筛选、多选删除（含 409 二次确认路径）逐一点过；
3. 视图 2：点卡上涂块与表格下拉/分数输入双向同步，保存后总分即时变化；
4. 视图 3：四类异常各处理一条，确认自动跳下一条与补传入队（右上角 UploadProgressCard 出现任务）；
5. 亮/暗主题 + flat/paper-edge 双皮肤截图比对 demo 视图 8；眯眼测试品牌红仅主按钮/选中态/异常强调。

- [x] **Step 5: Commit**

```bash
git add docs/扫描端后处理页-ui草案.html readus/扫描端胶囊.md
git commit -m "docs(scanner): 后处理页草案自包含定稿与胶囊导航增补"
```

---

## Self-Review 记录（写毕自查）

- 说明书 D1–D14 每条均有对应 Task：D1/D3/D4→Task 7；D2→Task 7；D5/D6/D7→Task 8；D8/D9/D10/D11→Task 9；D12→Task 6+8；D13→Task 10；D14→Task 7-10 全局约束 + Task 11 验收。
- 占位符扫描：无 TBD/TODO；所有代码步给出完整代码；Task 8/9/10 的「实现注意」是已知偏差的显式声明而非占位。
- 类型一致性：`PostprocessGroup/PostprocessQueueItem/ScanMeta/PostprocessChannel/SessionMeta/UploadMeta` 在定义与消费处同名同形；`filterDeletableGroups` 签名 Task 2 定义、Task 3 消费一致；`queueGroupUpload(meta, sessionId, result)` Task 6 定义、Task 10 消费一致。
- 已知未覆盖：真机 TWAIN 验收、远端 Linux 服务端联调（需用户环境）；per-user 置信度阈值在客户端重算时用默认常量（说明书 §4.2 已声明）。

---

## 施工偏差记录（2026-10-18，执行模型回改）

图例：⚠=plan 原写法在现有代码下不成立，已按 spec/用户裁定修正；＋=新增的必要支撑改动。

1. ⚠ **通道唯一为本地**（Task 6/10）：`remoteChannel` 删除。本页持本地 TWAIN sessionId，`/api/scanner/upload/*` 认 `job.remoteSessionId`（`scannerUploadManager.ts:551-556`），`requestJob("")` 直接 reject「上传任务已关闭」（:897-899）；ScannerPanel 现状在远端模式下读的也是本地 `results?previewOnly=1`、订正也走本地 correction。用户 2026-10-17 确认。
2. ⚠ **补传范围收窄**（Task 10）：只补传从未上传的组；同组已有 job 走 `retryFailed` 复用；加载时已上传/已入库的组**不重传**——`startUpload` 每次新建远端会话，同考号第二份回执会触发服务端 conflict → `withdraw()` 删 `student_scores`/`question_scores`（`scannerSubmissions.ts:121-141`）。用户 2026-10-17 确认。＋ 上传任务快照新增 `groupIds` 供按组判定。
3. ⚠ **cardVersion 用 `cardFingerprint(card)`**，不是 `shortCardVersion`：上传端按 24 位全量指纹核验，12 位短版本必判 `CARD_VERSION_MISMATCH`（`ScannerPanel.tsx:557` 同口径）。
4. ⚠ **视图 2 行数据源改为各页 recognition 合并**：plan 用当前页 `correctionState`，两页卡只会显示半张表、汇总也缺另一页的分。主观行取 `graded.subjectiveQuestions` 的分数/状态，`blockId` 从合并后的 recognition 取（`SubjectiveQuestionGrade` 没有 blockId 字段）。
5. ⚠ **表格改一题不得整页覆盖 `selected`**：plan 的 `applyCells` 会把同页学号与其他题的填涂一起抹掉。改为新增 shared 纯函数 `replaceScopedSelection()`（只替换该题作用域内的格，跨页按格所属页归位），冒烟已覆盖三条用例。
6. ⚠ **Task 1 冒烟用例与同 Task 实现自相矛盾**：`selectStudentDigitCells(digits,"12")!.length === 2` 对三位卡面返回 null（实现要求位数与卡面逐列对齐），会在运行时 TypeError；spec §4.3 的报错文案「考号位数与卡面不符」也只有严格位数才成立（`correctionState` 要求每列恰好一个数字）→ 用例改断言 `null`。
7. ⚠ **Task 1 夹具两处失真**：① 组 3 的 `failure.pages` 只给 layoutPage 1，按实现会同时判成 `missing_page`，与同段 `issues=["duplicate"]`、队列四条互斥断言冲突 → 补第 2 页（真实重卡本就是整份双面卷）；② 两份冲突副本写成同一 `(sessionId, groupId)`，被 `uniqueScanConflictCards` 合理去重成 1 条 → 已入库那份改为来自更早的会话（服务端 `conflictCard()` 的实际形状）。
8. ⚠ **Task 1 往返用例**：`small` 只有 0..15 的格，却断言 16 分可表示 → 改测 15。
9. ⚠ **不存在的样式类**：`className="r"` 无此工具类（`Table` 原语用 `numeric` 属性）；`bg-accent-soft` 无对应 `--color-*` 令牌（用 `bg-accent`）；网格 `style={{gridTemplateColumns}}` 改 `grid-cols-[repeat(auto-fill,minmax(128px,1fr))]` 工具类（仓库既有写法），避免内联业务样式。
10. ⚠ **Task 3 路由复用既有实现**：组→页映射用 `groupSessionPages()`（与 retry/results 同一函数，含 `unusedSide` 收窄），单条删除用 `deleteScanRecord()`（其事务已含 `scan_correction_pages` 清理，识别结果随外键级联）→ 删掉 plan 里与之重复的 `writeScannerSession` 预删事务。＋ 补 `session.status === "scanning"` 闸门，对齐 correction PUT。
11. ⚠ **Task 4 只做本地读扩展**：`GET /api/scanner/scan/:sessionId` 追加 `examId`；不再给 `GET /api/scanner/upload/sessions/:sid/status` 加同字段（通道裁定后该响应在本页无消费者）。
12. ⚠ **CorrectionCanvas 类型收窄**：`student_digit` 格没有 `questionNumber`，存疑判定加 `cell.type !== "student_digit"`；`reviewQuestions` 由 `Set<number>` 放宽为 `Set<SubjectiveQuestionNumber>`（主观题号可为字符串）。＋ polygon 带 `data-cell-id/data-cell-type`，供考号区裁图定位与测试选择。
13. ⚠ **补传时机两处修正**：`syncAfterFix` 不能读渲染闭包里的 `batches`（`reload()` 之后新变干净的组看不见 → 该补传的没补）→ `reload()` 返回当轮快照；「图片去向」改为调用时读取，避免渲染后切档位仍按旧值判定。
14. ⚠ **视图 3 队列进度重写**：plan 的 `isDone` 恒 false、`advance` 是空操作 → 改为「条目从队列消失即已处理」并计入进度与「第 x/N 条」；`onJumpToCorrection`/`onResolved` 均带 sessionId（多批次累加后 groupId 不再唯一）；＋ `focus` 让从扫描结果点开的异常定位到该组，而不是永远从队首开始；改考号面板可跨会话定位到冲突副本自己的 session。
15. ⚠ **未答选项用 `__none__` 哨兵**：Radix `SelectItem` 拒绝空串 value（仓库既有做法：`ClassManagement.tsx:28` 等）。
16. ⚠ **Task 7 删除按钮不得直接删**：按 plan 自带注记改为先进 `ConfirmDialog`；`Checkbox` 不再嵌在 `<button>` 内（按钮套按钮，键盘无法退出），选择态下整卡即勾选目标并带 `aria-pressed`；列表模式的 Checkbox 单元格局部 `stopPropagation`，避免与行点击互相抵消。
17. ＋ **新增 `verify:scanner-postprocess-delete` / `-ui` 并接进 CI**（`verify:scanner-postprocess-all`）：plan 的 Task 3 Step 4 与 Task 11 Step 4 都要求手工 curl / 真扫验收，本环境无扫描仪与远端服务器，改为隔离 DB 的 HTTP 冒烟 + jsdom 真实挂载断言，可重复且进 CI。

### 独立复核后的二次返修（2026-10-18，两轮子代理审核）

审核结论先行：plan 原文另有一批缺陷未在上述 17 条内，且第一次施工版（含偏差 2、10）自身有 4 个 P1/P2 问题，已修正并有回归覆盖。

18. ⚠ **P1 跨会话删除拿错 session**（推翻偏差 14 的部分修法）：`handleDelete` 原用 `sessions[last].sessionId` 下发全部 groupIds，续扫后第一批的「组 3」会删掉第二批的「组 3」。现按 `DeleteTarget[]`（sessionId + groupIds）逐会话下发；视图 1 的选择集与 React key 改 `sessionId/groupId`。覆盖：UI 冒烟断言删除 URL 命中 `scan-1`，且勾选第一批组 1 不会连带第二批同名组（已用变异测试验证该断言会红）。
19. ⚠ **P1 补传护栏在远端模式下形同虚设**：原基线 = 内存任务列表 + `result.saved`；远端模式走 `previewOnly` 根本不写本机回执（saved 恒 false），任务被 `dismissJob` 移除或重启后基线归零 → 已上传组会被再次 `queueGroupUpload` → 服务端同学号第二份回执 → `withdraw()` 撤正式成绩。改为「本页亲眼见过该组异常」`abnormalSeen` + `queuedByPage` 双判据；偏差 2 里借用的上传快照 `groupIds` 字段随之撤销（无消费者即删，不留抽象）。覆盖：UI 冒烟断言正常组改分保存后 `startUpload` 调用数不变（变异测试确认可红）。
20. ⚠ **P1 `listActiveReceiptGroups` 的 SQL 参数在 MariaDB 上必错**：`db.all(sql, [sessionId, ...groupIds])` 把数组当单个实参绑定；`DbAdapter.all(sql, ...params)` 是变参接口（`src/server/db/mysql.ts:69`），better-sqlite3 恰好会摊平所以 SQLite 冒烟看不出来。改 `sessionId, ...groupIds`，并把该冒烟接进 CI 的 `mariadb-test`（新建 `projectx_scanner_postprocess_ci`，`SCANNER_POSTPROCESS_MARIADB=1`）。
21. ⚠ **P2 删除护栏把 pending 也算成「已上传」**：`NOT IN ('discarded','superseded')` 包含 validate 每次写的 pending 回执，于是仅本地模式下**任何**删除都要 force，弹窗还在说「服务器成绩保留」。按 spec §4.1 收敛为 `IN ('saved','held','conflict','roster')`；端点冒烟相应改为「pending 可直删 / 置 saved 后 409 / force 放行」三段式。
22. ⚠ **P2 删除非原子**：逐条 `deleteScanRecord` 不在提交队列里，中途失败留下半删的组（validate 随即报成新缺页）。新增 `deleteScanRecordInTransaction`，整批在 `writeScannerSession` 的同一事务内删完；`deletedGroups` 不再把「无页面的组」计成已删。
23. ⚠ **P2 视图 2 保存后 revision 变陈旧**：PUT 成功服务端 revision +1，组件仍持旧文档 → 状态条还说「修改尚未保存」，再点保存必被「答题卡已更新」拒绝。改为保存成功后 `loadTick` 自增重拉文档（整卡改分弹窗是靠关闭弹窗规避的）。
24. ⚠ **P2 主观题行按 questionId 反查 blockId**：`SubjectiveQuestionGrade` 不带 blockId，而 `blockId?` 可选、同一 questionId 可落在多个题块上，反查会把两块的分数格混为一谈（React key 撞车、改分改到别的块、汇总重复计分）。改为逐条遍历合并后的 `subjectiveQuestions` 并用 `gradeSubjectiveRecognition` 就地判分，key 带 blockId。
25. P3：`applyCells` 改函数式 `setEdits`（同批两次改表会丢第一次）；删掉视图 2 里未被读取却每次深拷贝整份 recognition 的 `state`；队列面板的异步按钮补 `loading`（重新识别/保留这份）；多选 chips 去掉写死的 `h-6`（compact 密度红线）；列表行补 `tabIndex`+Enter/Space（与 `ScannerWorkspace` 的可点行一致）。
26. 审核确认通过、无需改动的项：`CorrectionCanvas` 抽取未改变整卡改分弹窗行为（逐属性比对 base `68f348b`，未传 reviewQuestions 时描边/aria 与原来逐字一致）；两页卡按题改分不会抹掉他页/学号格；DELETE 路由确实在 `requireScannerExamScope` 前缀挂载覆盖内且非 GET 还要整卷判分权限；`src/shared/**` 改动纯新增，Web 侧无消费者受影响；`src/shared` 里没有 `<button>` 套交互控件。

### 外部复核返修（PR #338，chuh2006 中文审核 4 条，全部核实为真）

27. ⚠ **P1 自动跳页吃掉了仅本地模式的入库入口**（plan Task 10 只写「透传 onScansComplete」，没考虑 ScannerPanel done 视图被卸载）：`POST validate` 只演算不落库，正常卷因此从未写进 `student_scores`。修法：视图 1 工具条补「保存成绩入库」→ `POST /api/scanner/session/:sid/results`（与原 `saveSuccessful` 同端点），仅本地模式显示。
28. ⚠ **P1 重卡「保留这份」的后续同步指向了被作废的那份**（plan Task 9 的 `onResolved()` 没带身份）：队列项是被作废组时，重拉后 results 里查不到 → 真正保留的那份永远不补传。修 `onResolved(card.sessionId, card.groupId)`；并把 `failures[].conflicts` 的副本一起计入「本页见过的异常」，否则保留份只出现在 conflicts 时仍然不补传。
29. ⚠ **P2 考号画布与输入框是两份状态**：点格改完，确认仍按输入框旧文本重算全部 digit 格（屏幕已改、提交旧号）。改为 digit 格选是唯一真值：打字写格、点格回写显示，两者不一致时禁用确认。plan Task 9 Step 2 原文「Input 考号 + 联想 + 确认」没规定这一层。
30. ⚠ **P2 修正 revision 不足以支持连续保存**：`saveSessionCorrection` 在 PUT 末尾以 `mode="save"` 接纳该组，第二次 PUT 被 `scanCorrection.ts:189` 明确拒绝（`此卷已入库…请从成绩修改进入整卡改分`）。偏差 23 的 revision 重拉只修了乐观锁那一层。现在保存返回 `saved` 即锁界面并指向 Web 成绩修改；已入库卷打开时同样锁（`initialSaved`）。
- 复核方式说明：上述 4 条各自有断言，且逐条做变异测试确认可红（审核指出原冒烟把 PUT 固定模拟成成功，盖不到服务端状态转换，这条批评成立）。
