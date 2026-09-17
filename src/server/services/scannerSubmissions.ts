import { resolveScannerExam } from "./scannerExam";
import { getMysqlDb, buildUpsertSQL, type DbAdapter } from "../db";
import type { AnswerCard } from "../../shared/types";
import type { CombinedStudentResult } from "../../shared/grading";
import type { ScanBatchResponse, ScanConflictCard, ScanBatchPage } from "../../shared/scanPages";
import { collectSessionResults, groupSessionPages } from "../../apps/answer-card/server/scanner/session-results";
import { listScanRecordsGroupedByStudent, type StudentGradingResultRow } from "../../apps/answer-card/server/database/scan-store";
import { persistScannerResultToMainDb } from "./scannerResultPersistence";
import { recomputeExamRankings } from "./rankingUpdate";
import { analysisCache } from "./analysisCache";
import { ensureExamParticipants, isExamParticipant } from "./examParticipants";
import { databaseTimestamp } from "../db/timestamp";
import { markScoreMutated } from "./examPublishEvents";

interface Receipt {
  exam_id: number; session_id: string; group_id: string; student_number: string;
  state: string; previously_saved: number; pages_json: string;
  result_json: string | null; score_snapshot: string | null;
}
// SQLite uses one connection. MariaDB additionally locks the exam row, including across processes.
let writes: Promise<unknown> = Promise.resolve();
export function enqueueScannerSubmission<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work);
  writes = next.catch(() => undefined);
  return next;
}
async function lockExam(db: DbAdapter, examId: number) {
  await db.run("UPDATE exams SET id = id WHERE id = ?", examId);
}
async function receipts(db: DbAdapter, examId: number): Promise<Receipt[]> {
  return db.all<Receipt>("SELECT * FROM scanner_submissions WHERE exam_id = ? AND state != 'superseded'", examId);
}
function conflictCard(row: Receipt): ScanConflictCard {
  const result = row.result_json ? JSON.parse(row.result_json) as CombinedStudentResult : null;
  const snapshot = row.score_snapshot ? JSON.parse(row.score_snapshot) : null;
  return { sessionId: row.session_id, groupId: row.group_id, studentId: row.student_number,
    previouslySaved: Boolean(row.previously_saved), totalScore: snapshot?.score?.total_score ?? result?.totalScore,
    pages: JSON.parse(row.pages_json) as ScanBatchPage[] };
}
async function withdraw(db: DbAdapter, examId: number, studentNumber: string) {
  const user = await db.get<{ id: number }>("SELECT id FROM users WHERE student_number = ?", studentNumber);
  if (!user) return;
  const score = await db.get("SELECT * FROM student_scores WHERE exam_id = ? AND student_id = ?", examId, user.id);
  if (score) {
    await markScoreMutated(db, examId, null, "scanner_duplicate");
    const questions = await db.all("SELECT * FROM question_scores WHERE exam_id = ? AND student_id = ?", examId, user.id);
    await db.run("UPDATE scanner_submissions SET score_snapshot = ?, previously_saved = 1 WHERE exam_id = ? AND student_number = ? AND state = 'saved'",
      JSON.stringify({ score, questions }), examId, studentNumber);
    await db.run("DELETE FROM question_scores WHERE exam_id = ? AND student_id = ?", examId, user.id);
    await db.run("DELETE FROM student_scores WHERE exam_id = ? AND student_id = ?", examId, user.id);
    const sources = await db.all<Receipt>("SELECT * FROM scanner_submissions WHERE exam_id = ? AND student_number = ?", examId, studentNumber);
    for (const source of sources) for (const page of JSON.parse(source.pages_json) as ScanBatchPage[]) {
      await db.run("UPDATE answer_block_crops SET exam_id = NULL, student_id = NULL WHERE source_type = 'twain_scan_record' AND source_record_id = ? AND exam_id = ?", page.recordId, examId);
    }
    // A withdrawn score invalidates completeness/publication as well as rankings.
    await db.run("UPDATE exams SET status = 'grading', updated_at = CURRENT_TIMESTAMP WHERE id = ?", examId);
  }
  await db.run("UPDATE scanner_submissions SET state = 'conflict' WHERE exam_id = ? AND student_number = ? AND state != 'superseded'", examId, studentNumber);
}

/** Teacher-directed recovery for pre-receipt grades; never infer a new owner from old images. */
export async function recoverLegacyScannerSubmission(examId: number, groupId: string, studentNumber?: string) {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb();
    await db.transaction(async tx => {
      await lockExam(tx, examId);
      if (!await tx.get("SELECT e.id FROM exams e WHERE e.id = ? AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)", examId)) throw new Error("考试不存在或已删除");
      const row = await tx.get<Receipt>("SELECT * FROM scanner_submissions WHERE exam_id = ? AND session_id = ? AND group_id = ?", examId, `legacy:${examId}`, groupId);
      if (!row?.score_snapshot) throw new Error("历史成绩快照不存在");
      if (studentNumber) {
        if (row.state === "saved") throw new Error("成绩已保存，请先处理重复冲突");
        const existingSources = await receipts(tx, examId);
        if (!existingSources.some(r => r.student_number === studentNumber && (r.result_json || r.score_snapshot))) {
          const otherScore = await tx.get<{ student_id: number }>("SELECT ss.* FROM student_scores ss JOIN users u ON u.id = ss.student_id WHERE ss.exam_id = ? AND u.student_number = ?", examId, studentNumber);
          if (otherScore) {
            const questions = await tx.all("SELECT * FROM question_scores WHERE exam_id = ? AND student_id = ?", examId, otherScore.student_id);
            await tx.run(buildUpsertSQL(tx.dialect, "scanner_submissions",
              ["exam_id", "session_id", "group_id", "student_number", "state", "previously_saved", "pages_json", "score_snapshot"], ["exam_id", "session_id", "group_id"]),
              examId, `legacy:${examId}`, String(otherScore.student_id), studentNumber, "saved", 1, "[]", JSON.stringify({ score: otherScore, questions }));
          }
        }
        await tx.run("UPDATE scanner_submissions SET student_number = ?, state = 'pending' WHERE exam_id = ? AND session_id = ? AND group_id = ?", studentNumber, examId, row.session_id, groupId);
        const current = await receipts(tx, examId);
        for (const number of new Set([row.student_number, studentNumber])) {
          if (current.filter(r => r.student_number === number).length > 1) await withdraw(tx, examId, number);
          else await tx.run("UPDATE scanner_submissions SET state = 'pending' WHERE exam_id = ? AND student_number = ? AND state = 'conflict'", examId, number);
        }
        return;
      }
      if ((await receipts(tx, examId)).filter(r => r.student_number === row.student_number).length > 1) throw new Error("重复学号尚未解决，历史成绩不能恢复");
      if (row.state === "saved") return;
      const user = await tx.get<{ id: number }>("SELECT id FROM users WHERE student_number = ?", row.student_number);
      if (!user) throw new Error("订正学号不在学生名单中");
      const roster = await ensureExamParticipants(tx, examId);
      if (roster.rosterKnown && roster.participantCount > 0 && !await isExamParticipant(tx, examId, user.id)) throw new Error("订正学号不在应考名单中");
      if (await tx.get("SELECT id FROM student_scores WHERE exam_id = ? AND student_id = ?", examId, user.id)) throw new Error("该学号已有其他成绩，不能覆盖");
      const snapshot = JSON.parse(row.score_snapshot) as { score: Record<string, unknown>; questions: Record<string, unknown>[] };
      const value = (record: Record<string, unknown>, column: string) => {
        const raw = record[column];
        return typeof raw === "string" && column.endsWith("_at") ? databaseTimestamp(raw, tx.dialect) : raw ?? null;
      };
      const scoreColumns = ["exam_id", "student_id", "objective_score", "subjective_score", "total_score", "graded_at", "manually_modified", "modified_by", "modified_at"];
      await tx.run(buildUpsertSQL(tx.dialect, "student_scores", scoreColumns, ["exam_id", "student_id"]),
        examId, user.id, ...scoreColumns.slice(2).map(c => value(snapshot.score, c)));
      const questionColumns = ["exam_id", "student_id", "question_number", "question_id", "block_id", "score", "max_score", "score_type", "selected_options", "manually_modified", "modified_by", "modified_at"];
      for (const question of snapshot.questions) await tx.run(buildUpsertSQL(tx.dialect, "question_scores", questionColumns, ["exam_id", "student_id", "question_number", "score_type"]),
        examId, user.id, ...questionColumns.slice(2).map(c => value(question, c)));
      await tx.run("UPDATE scanner_submissions SET state = 'saved' WHERE exam_id = ? AND session_id = ? AND group_id = ?", examId, row.session_id, groupId);
      await tx.run("UPDATE exams SET status = 'grading', score_published = 0 WHERE id = ?", examId);
    });
    analysisCache.invalidateExam(examId);
    await recomputeExamRankings(db, examId);
    return { ok: true };
  });
}

/** Both paths consume Windows recognition records; this service never runs OMR. */
export async function processScannerSession(card: AnswerCard, sessionId: string,
  mode: "preview" | "validate" | "save" = "preview"): Promise<ScanBatchResponse> {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb();
    const records = (await listScanRecordsGroupedByStudent(sessionId)).flatMap(g => g.records);
    const { groups } = groupSessionPages(card, records);
    const candidates = [...groups].flatMap(([groupId, rows]) => {
      const ids = [...new Set(rows.map(r => r.record.student_id).filter((id): id is string => Boolean(id)))];
      return ids.length === 1 ? [{ groupId, studentNumber: ids[0], pages: rows.map(r => r.page) }] : [];
    });
    const { exams, exam } = await resolveScannerExam(card.id, sessionId);
    if (!exam) {
      return collectSessionResults(card, records, [], mode === "save" ? async () => {
        throw new Error(exams.length === 0 ? "答题卡未关联可阅卷的考试，成绩未入库" : "答题卡关联多个考试，无法确定成绩归属");
      } : undefined);
    }
    if (mode !== "preview") {
      await db.transaction(async tx => {
        await lockExam(tx, exam.id);
        const old = await receipts(tx, exam.id);
        for (const candidate of candidates) {
          const prior = old.find(r => r.session_id === sessionId && r.group_id === candidate.groupId);
          if (prior && prior.student_number !== candidate.studentNumber) {
            // Corrections invalidate a previous receipt, never silently move a saved grade.
            await withdraw(tx, exam.id, prior.student_number);
            await tx.run("UPDATE scanner_submissions SET state = 'superseded', group_id = ? WHERE exam_id = ? AND session_id = ? AND group_id = ?",
              `${candidate.groupId}:old:${Date.now()}`, exam.id, sessionId, candidate.groupId);
          }
          const cols = ["exam_id", "session_id", "group_id", "student_number", "pages_json"];
          await tx.run(buildUpsertSQL(tx.dialect, "scanner_submissions", cols, ["exam_id", "session_id", "group_id"], ["pages_json"]),
            exam.id, sessionId, candidate.groupId, candidate.studentNumber, JSON.stringify(candidate.pages));
          if (prior && prior.student_number !== candidate.studentNumber && prior.previously_saved) {
            await tx.run("UPDATE scanner_submissions SET previously_saved = 1 WHERE exam_id = ? AND session_id = ? AND group_id = ?", exam.id, sessionId, candidate.groupId);
          }
          if (new Set(candidate.pages.map(p => p.layoutPage)).size !== candidate.pages.length) {
            await withdraw(tx, exam.id, candidate.studentNumber);
          }
        }
        // Legacy scores have no reliable receipt. Keep their full score snapshot and any
        // matching old scanner pages as evidence instead of treating a cache as proof of saving.
        for (const studentNumber of new Set(candidates.map(c => c.studentNumber))) {
          const all = await receipts(tx, exam.id);
          if (all.some(r => r.student_number === studentNumber && (r.result_json || r.score_snapshot))) continue;
          const score = await tx.get<{ student_id: number; total_score: number; objective_score: number; subjective_score: number }>("SELECT ss.* FROM student_scores ss JOIN users u ON u.id = ss.student_id WHERE ss.exam_id = ? AND u.student_number = ?", exam.id, studentNumber);
          if (!score) continue;
          const questions = await tx.all<{ question_number: number; question_id: string; score_type: string; score: number; max_score: number; selected_options: string | null }>("SELECT * FROM question_scores WHERE exam_id = ? AND student_id = ?", exam.id, score.student_id);
          const oldCaches = await tx.all<StudentGradingResultRow & { session_id: string }>(
            "SELECT g.* FROM twain_student_grading_results g JOIN twain_scan_sessions s ON s.id = g.session_id WHERE s.card_id = ? AND g.student_id = ?", card.id, studentNumber);
          // Upgrade an unambiguous, fully matching old receipt in place. A retry of that
          // original is not a second attempt; a bare/misleading cache still proves nothing.
          if (oldCaches.length === 1) {
            const oldCache = oldCaches[0];
            const oldRecords = (await listScanRecordsGroupedByStudent(oldCache.session_id)).flatMap(g => g.records);
            let verified: CombinedStudentResult | undefined;
            await collectSessionResults(card, oldRecords, [], async result => {
              if (result.studentId !== studentNumber || oldCache.objective_json !== JSON.stringify(result.objectiveQuestions)
                || oldCache.subjective_json !== JSON.stringify(result.subjectiveQuestions) || Number(oldCache.page_count) !== result.pageCount
                || Number(score.total_score) !== result.totalScore || Number(score.objective_score) !== result.objectiveScore || Number(score.subjective_score) !== result.subjectiveScore) return;
              const expected = [...result.objectiveQuestions.map(q => ({ number: q.questionNumber, type: "objective", score: q.score, max: q.maxScore, options: q.selectedOptions })),
                ...result.subjectiveQuestions.map(q => ({ number: q.questionNumber, type: "subjective", score: q.score, max: q.maxScore, options: undefined }))];
              if (questions.length === expected.length && expected.every(q => questions.some(actual => String(actual.question_number) === String(q.number)
                && actual.score_type === q.type && Number(actual.score) === q.score && Number(actual.max_score) === q.max
                && (!q.options || actual.selected_options === JSON.stringify(q.options))))) verified = result;
            });
            if (verified) {
              const originalGroup = [...groupSessionPages(card, oldRecords).groups].find(([, rows]) => rows.some(r => r.record.id === verified!.pages[0].recordId))!;
              await tx.run(buildUpsertSQL(tx.dialect, "scanner_submissions",
                ["exam_id", "session_id", "group_id", "student_number", "state", "previously_saved", "pages_json", "result_json"], ["exam_id", "session_id", "group_id"]),
                exam.id, oldCache.session_id, originalGroup[0], studentNumber, "saved", 1, JSON.stringify(originalGroup[1].map(r => r.page)), JSON.stringify(verified));
              continue;
            }
          }
          const priorPages = await tx.all<{ id: string; page_num: number; side: "front" | "back" }>(
            "SELECT r.id, r.page_num, r.side FROM twain_scan_records r JOIN twain_student_grading_results g ON g.session_id = r.session_id AND g.student_id = r.student_id WHERE r.card_id = ? AND r.student_id = ?", card.id, studentNumber);
          const legacyPages = priorPages.map(r => ({ recordId: r.id, pageNum: r.page_num, side: r.side, layoutPage: 1 }));
          await tx.run(buildUpsertSQL(tx.dialect, "scanner_submissions",
            ["exam_id", "session_id", "group_id", "student_number", "state", "previously_saved", "pages_json", "score_snapshot"], ["exam_id", "session_id", "group_id"]),
          exam.id, `legacy:${exam.id}`, String(score.student_id), studentNumber, "saved", 1, JSON.stringify(legacyPages), JSON.stringify({ score, questions }));
        }
        const all = await receipts(tx, exam.id);
        for (const studentNumber of new Set(all.map(r => r.student_number))) {
          if (all.filter(r => r.student_number === studentNumber).length > 1) await withdraw(tx, exam.id, studentNumber);
          // Resolved attempts remain pending until the teacher explicitly saves them.
          else await tx.run("UPDATE scanner_submissions SET state = 'pending' WHERE exam_id = ? AND student_number = ? AND state = 'conflict'", exam.id, studentNumber);
        }
      });
      analysisCache.invalidateExam(exam.id);
      await recomputeExamRankings(db, exam.id);
    }
    let all = await receipts(db, exam.id);
    const cached: StudentGradingResultRow[] = [];
    for (const row of all.filter(r => r.session_id === sessionId && r.state === "saved" && r.result_json)) {
      const exists = await db.get("SELECT ss.id FROM student_scores ss JOIN users u ON u.id = ss.student_id WHERE ss.exam_id = ? AND u.student_number = ?", exam.id, row.student_number);
      if (!exists) continue;
      const result = JSON.parse(row.result_json!) as CombinedStudentResult;
      cached.push({ student_id: row.student_number, objective_json: JSON.stringify(result.objectiveQuestions),
        subjective_json: JSON.stringify(result.subjectiveQuestions), total_score: result.totalScore,
        max_score: result.totalMaxScore, page_count: result.pageCount } as StudentGradingResultRow);
    }
    const response = await collectSessionResults(card, records, cached, mode === "save" ? async result => {
      const candidate = candidates.find(c => c.pages.some(p => p.recordId === result.pages[0]?.recordId))!;
      await db.transaction(async tx => {
        await lockExam(tx, exam.id);
        const current = await receipts(tx, exam.id);
        if (current.filter(r => r.student_number === result.studentId).length > 1) throw new Error("重复学号：所有相关答题卡需订正后重新保存");
        await persistScannerResultToMainDb(card.id, result, true, { db: tx, examId: exam.id });
        await tx.run("UPDATE scanner_submissions SET state = 'saved', previously_saved = 1, result_json = ? WHERE exam_id = ? AND session_id = ? AND group_id = ?",
          JSON.stringify(result), exam.id, sessionId, candidate.groupId);
        await tx.run(buildUpsertSQL(tx.dialect, "twain_student_grading_results",
          ["session_id", "student_id", "objective_json", "subjective_json", "total_score", "max_score", "page_count"], ["session_id", "student_id"]),
          sessionId, result.studentId, JSON.stringify(result.objectiveQuestions), JSON.stringify(result.subjectiveQuestions), result.totalScore, result.totalMaxScore, result.pageCount);
      });
    } : undefined);
    all = await receipts(db, exam.id);
    for (const candidate of candidates) {
      const others = all.filter(r => r.student_number === candidate.studentNumber && !(r.session_id === sessionId && r.group_id === candidate.groupId));
      const localDuplicates = candidates.filter(c => c.studentNumber === candidate.studentNumber);
      if (others.length === 0 && localDuplicates.length < 2) continue;
      response.results = response.results.filter(r => r.groupId !== candidate.groupId);
      response.failures = response.failures.filter(r => r.groupId !== candidate.groupId);
      const related = all.filter(r => r.student_number === candidate.studentNumber).map(conflictCard);
      for (const local of localDuplicates) if (!related.some(r => r.sessionId === sessionId && r.groupId === local.groupId)) {
        related.push({ sessionId, groupId: local.groupId, studentId: candidate.studentNumber, previouslySaved: false, pages: local.pages });
      }
      response.failures.push({ groupId: candidate.groupId, studentId: candidate.studentNumber, stage: "recognition", pages: candidate.pages,
        message: "重复学号：新旧答题卡均需核对订正，已保存成绩撤出后才可重新保存", conflicts: related });
    }
    if (mode === "save") {
      analysisCache.invalidateExam(exam.id);
      await recomputeExamRankings(db, exam.id);
    }
    response.reviewCards = all.filter(r => r.state === "pending" && r.previously_saved).map(conflictCard);
    return response;
  });
}
