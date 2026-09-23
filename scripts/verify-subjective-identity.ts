import assert from "node:assert/strict";
import { createDefaultCard } from "../src/shared/defaultCard";
import { gradeCombinedRecognition, gradeSessionStudentResults } from "../src/shared/grading";
import type { CombinedRecognitionResult } from "../src/shared/types";

const card = createDefaultCard("subjective-identity");
card.bodyBlocks = [{ id: "block", type: "subjective", title: "解答题", blockKind: "answer",
  questions: [{ id: "real", number: 1, score: 10, style: "manual_score_grid", kind: "answer", minHeightMm: 20 }] }];
const recognition: CombinedRecognitionResult = {
  status: "ok", studentId: { status: "ok", value: "123456" }, questions: [],
  subjectiveQuestions: [
    { questionId: "real", questionNumber: 999, score: 8, maxScore: 999, status: "ok", confidence: 1, validCells: [], invalidCells: [] },
    { questionId: "unknown", questionNumber: 1, score: 999, maxScore: 999, status: "ok", confidence: 1, validCells: [], invalidCells: [] },
  ],
};
for (const result of [
  gradeCombinedRecognition(card, "test.png", recognition),
  gradeSessionStudentResults(card, [{ recordId: "1", pageNum: 1, side: "front", imagePath: "test.png", ocrStatus: "done", recognition }]),
]) {
  assert.deepEqual(result.subjectiveQuestions.map(q => [q.questionId, q.questionNumber, q.score, q.maxScore]), [["real", 1, 8, 10]]);
  assert.equal(result.subjectiveScore, 8);
  assert.equal(result.subjectiveMaxScore, 10);
}
console.log("PASS subjective identity: unknown IDs discarded; card question numbers authoritative");
