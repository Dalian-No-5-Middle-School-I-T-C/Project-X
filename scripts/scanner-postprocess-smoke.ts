import assert from "node:assert/strict";
import { evaluateScoreCells, type CorrectionCell } from "../src/shared/scanCorrection";
import { selectObjectiveOptionCells, selectScoreCells, selectStudentDigitCells } from "../src/shared/correctionCellSelect";
import { buildPostprocessGroups, buildPostprocessQueue, filterDeletableGroups, missingLayoutPages } from "../src/shared/scanPostprocess";
import type { ScanBatchResponse } from "../src/shared/scanPages";

type OptionCell = Extract<CorrectionCell, { type: "objective_option" }>;
type DigitCell = Extract<CorrectionCell, { type: "student_digit" }>;
type ScoreCell = Extract<CorrectionCell, { type: "score_cell" }>;

function optionCell(questionNumber: number, option: string): OptionCell {
  return { type: "objective_option", id: `o${questionNumber}${option}`, blockId: "b1", questionNumber, option, rect: { x: 0, y: 0, width: 1, height: 1 } };
}
function digitCell(digitIndex: number, digit: number): DigitCell {
  return { type: "student_digit", id: `d${digitIndex}-${digit}`, digitIndex, digit, rect: { x: 0, y: 0, width: 1, height: 1 } };
}
function scoreCell(questionId: string, score: number, blockId = "b1"): ScoreCell {
  return { type: "score_cell", id: `s${questionId}-${score}`, questionId, blockId, questionNumber: 21, score, rect: { x: 0, y: 0, width: 1, height: 1 } };
}

// ── 客观题选项 ──
const opts: CorrectionCell[] = [optionCell(1, "A"), optionCell(1, "B"), optionCell(1, "C"), optionCell(1, "D")];
assert.deepEqual(selectObjectiveOptionCells(opts, 1, ["B"]), ["o1B"]);
assert.deepEqual(selectObjectiveOptionCells(opts, 1, ["A", "C"]), ["o1A", "o1C"]);
assert.equal(selectObjectiveOptionCells(opts, 1, ["E"]), null);
assert.equal(selectObjectiveOptionCells(opts, 2, ["A"]), null);

// ── 考号：位数必须与卡面列数一致（correctionState 要求每列恰好一个数字）──
const digits: CorrectionCell[] = [0, 1, 2].flatMap(i => Array.from({ length: 10 }, (_, d) => digitCell(i, d)));
assert.deepEqual(selectStudentDigitCells(digits, "012"), ["d0-0", "d1-1", "d2-2"]);
assert.equal(selectStudentDigitCells(digits, "12"), null);
assert.equal(selectStudentDigitCells(digits, "1234"), null);
assert.equal(selectStudentDigitCells(digits, "1a2"), null);

// ── 主观题分数（evaluateScoreCells 的逆，往返一致）──
const small: CorrectionCell[] = Array.from({ length: 16 }, (_, i) => scoreCell("q", i)); // max<=16：base 位 0..15
const big: CorrectionCell[] = [
  ...Array.from({ length: 10 }, (_, i) => scoreCell("q", i)),
  ...[10, 20, 30, 40, 50].map(v => scoreCell("q", v)),
  scoreCell("q", 0.5),
];
function roundTrip(cells: CorrectionCell[], score: number, max: number) {
  const picked = selectScoreCells(cells, "q", undefined, score, max);
  assert.ok(picked, `score ${score}/${max} 应可表示`);
  const chosen = cells.filter((c): c is ScoreCell => picked!.includes(c.id));
  const evaluated = evaluateScoreCells(chosen, max);
  assert.equal(evaluated.valid, true, `score ${score} 格组合必须合法`);
  assert.equal(evaluated.score, score, `往返分数必须等于 ${score}`);
}
for (const score of [0, 3, 7, 15]) roundTrip(small, score, 16);
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
    { groupId: "0", studentId: "20241001", totalScore: 82, maxScore: 100, objectiveScore: 50, objectiveMaxScore: 50, subjectiveScore: 32, subjectiveMaxScore: 50, needsReviewCount: 0, pageCount: 2, saved: false,
      pages: [{ recordId: "r1", pageNum: 1, side: "front", layoutPage: 1, objectiveScore: 50, subjectiveScore: 32, totalScore: 82, totalMaxScore: 100 },
              { recordId: "r2", pageNum: 1, side: "back", layoutPage: 2, objectiveScore: 0, subjectiveScore: 0, totalScore: 0, totalMaxScore: 0 }] },
    { groupId: "2", studentId: "20241003", totalScore: 65, maxScore: 100, objectiveScore: 40, objectiveMaxScore: 50, subjectiveScore: 25, subjectiveMaxScore: 50, needsReviewCount: 3, pageCount: 2, saved: false,
      pages: [{ recordId: "r5", pageNum: 3, side: "front", layoutPage: 1, objectiveScore: 40, subjectiveScore: 25, totalScore: 65, totalMaxScore: 100 },
              { recordId: "r6", pageNum: 3, side: "back", layoutPage: 2, objectiveScore: 0, subjectiveScore: 0, totalScore: 0, totalMaxScore: 0 }] },
  ],
  failures: [
    { groupId: "1", studentId: null, stage: "recognition", message: "Student ID recognition failed.", pages: [{ recordId: "r3", pageNum: 2, side: "front", layoutPage: 1 }, { recordId: "r4", pageNum: 2, side: "back", layoutPage: 2 }] },
    { groupId: "3", studentId: "20241007", stage: "saving", message: "重复学号：新旧答题卡均需核对订正，已保存成绩撤出后才可重新保存",
      pages: [{ recordId: "r7", pageNum: 4, side: "front", layoutPage: 1 }, { recordId: "r10", pageNum: 4, side: "back", layoutPage: 2 }],
      conflicts: [{ sessionId: "scan_old", groupId: "5", studentId: "20241007", previouslySaved: true, formalScoreRetained: true, totalScore: 61, pages: [{ recordId: "r8", pageNum: 9, side: "front", layoutPage: 1 }] },
                  { sessionId: "scan_a", groupId: "3", studentId: "20241007", previouslySaved: false, totalScore: 58, pages: [{ recordId: "r7", pageNum: 4, side: "front", layoutPage: 1 }, { recordId: "r10", pageNum: 4, side: "back", layoutPage: 2 }] }] },
    { groupId: "4", studentId: "20241015", stage: "recognition", message: "缺页", pages: [{ recordId: "r9", pageNum: 5, side: "front", layoutPage: 1 }] },
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

// ── 历史遗留卷（其他会话的 reviewCards）不收编 ──
const withForeignReviewCard: ScanBatchResponse = {
  ...response,
  reviewCards: [{ sessionId: "scan_b", groupId: "7", studentId: "20241099", previouslySaved: true, pages: [{ recordId: "r11", pageNum: 7, side: "front", layoutPage: 1 }] }],
};
assert.equal(buildPostprocessGroups(withForeignReviewCard, "scan_a", 2).length, 5);
const withOwnReviewCard: ScanBatchResponse = {
  ...response,
  reviewCards: [{ sessionId: "scan_a", groupId: "8", studentId: "20241008", previouslySaved: true, pages: [{ recordId: "r12", pageNum: 8, side: "front", layoutPage: 1 }] }],
};
const withOwn = buildPostprocessGroups(withOwnReviewCard, "scan_a", 2);
assert.equal(withOwn.length, 6);
assert.deepEqual(byId.get("0")!.thumbRecordId, "r1");
assert.equal(withOwn.find(g => g.groupId === "8")!.issues.join(), "duplicate");

// ── 删除护栏 ──
assert.deepEqual(filterDeletableGroups(["0", "3"], new Map([["3", true]]), false), { deletable: ["0"], blocked: ["3"] });
assert.deepEqual(filterDeletableGroups(["0", "3"], new Map([["3", true]]), true), { deletable: ["0", "3"], blocked: [] });
assert.deepEqual(filterDeletableGroups([], new Map(), false), { deletable: [], blocked: [] });

console.log("PASS scanner-postprocess-smoke");
