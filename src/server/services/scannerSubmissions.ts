import { resolveScannerExam } from "./scannerExam";
import { getMysqlDb, buildUpsertSQL, type DbAdapter } from "../db";
import type { AnswerCard } from "../../shared/types";
import type { CombinedStudentResult } from "../../shared/grading";
import type { ScanBatchResponse, ScanConflictCard, ScanBatchPage } from "../../shared/scanPages";
import { validateSessionGroupStructure, collectSessionResults, gradeSessionGroup, groupSessionPages, legacySessionBlockReason } from "../../apps/answer-card/server/scanner/session-results";
import { listScanRecordsGroupedByStudent, type ScanRecordWithResult, type StudentGradingResultRow } from "../../apps/answer-card/server/database/scan-store";
import { persistScannerResultToMainDb } from "./scannerResultPersistence";
import { recomputeExamRankings } from "./rankingUpdate";
import { analysisCache } from "./analysisCache";
import { assertCorrectionPageProvenance } from "./scanCorrectionProvenance";
import { ensureExamParticipants, isExamParticipant } from "./examParticipants";
import { databaseTimestamp } from "../db/timestamp";
import { markScoreMutated } from "./examPublishEvents";
import { captureExamClasses } from "./examClassMemberships";
import { scannerDuplicateEvidence } from "./scannerDuplicateEvidence";

/** Resolve persisted receipt ownership, including retries after exam closure. */
export async function findSavedScannerOwners(db: DbAdapter, sessionId: string, groupId: string,
  studentNumber: string, cardId: string): Promise<Array<{ exam_id: number; student_id: number }>> {
  return db.all<{ exam_id: number; student_id: number }>(
    `SELECT s.exam_id, ss.student_id FROM scanner_submissions s
     JOIN exams e ON e.id = s.exam_id
     JOIN users u ON u.student_number = ?
     JOIN student_scores ss ON ss.exam_id = s.exam_id AND ss.student_id = u.id
     WHERE s.session_id = ? AND s.group_id = ? AND s.student_number = ? AND s.state = 'saved'
       AND e.card_id = ?
       AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)`,
    // Bind the same number to both columns. Older MariaDB installations can have
    // different collations on users and the later-created receipts table;
    // comparing those two columns directly fails before any row is returned.
    studentNumber, sessionId, groupId, studentNumber, cardId);
}

interface Receipt {
  exam_id: number; session_id: string; group_id: string; student_number: string;
  state: string; previously_saved: number; pages_json: string;
  result_json: string | null; score_snapshot: string | null;
}

/** Bind only the pages owned by a saved receipt, in the caller's save transaction. */
export async function linkSavedScannerCrops(db: DbAdapter, cardId: string, receipt: Receipt): Promise<void> {
  const owners = await findSavedScannerOwners(db, receipt.session_id, receipt.group_id, receipt.student_number, cardId);
  if (owners.length !== 1 || Number(owners[0].exam_id) !== Number(receipt.exam_id)) {
    throw new Error("扫描成绩回执归属缺失或不唯一，切图关联未完成");
  }
  const owner = owners[0];
  for (const page of JSON.parse(receipt.pages_json) as ScanBatchPage[]) {
    const record = await db.get<{ card_id: string; session_id: string; student_id: string | null }>(
      "SELECT card_id, session_id, student_id FROM twain_scan_records WHERE id = ?", page.recordId);
    if (!record || record.card_id !== cardId || record.session_id !== receipt.session_id || record.student_id !== receipt.student_number) {
      throw new Error("原卷与保存回执不匹配，切图关联未完成");
    }
    const crops = await db.all<{ card_id: string; exam_id: number | null; student_id: number | null }>(
      "SELECT card_id, exam_id, student_id FROM answer_block_crops WHERE source_type = 'twain_scan_record' AND source_record_id = ?"
        + (db.dialect === "mariadb" ? " FOR UPDATE" : ""), page.recordId);
    if (crops.some(crop => crop.card_id !== cardId
      || (crop.exam_id !== null && Number(crop.exam_id) !== Number(owner.exam_id))
      || (crop.student_id !== null && Number(crop.student_id) !== Number(owner.student_id)))) {
      throw new Error("原卷切图已属于其他成绩，无法关联");
    }
    await db.run(
      `UPDATE answer_block_crops SET exam_id = ?, student_id = ?
       WHERE source_type = 'twain_scan_record' AND source_record_id = ? AND card_id = ?`,
      owner.exam_id, owner.student_id, page.recordId, cardId);
  }
}
/**
 * 该扫描页是否已被一张 `state='saved'` 的回执认领（PR #312 复核 CR2）。
 *
 * `/complete` 只在**全部**分组入库成功时把会话与页面推到 `completed`；部分失败时它先 409 返回，
 * 那些已经保存成功的分组留下 `saved` 回执，但页面状态仍是 `uploaded`、会话仍是 `incomplete`。
 * 于是 R02 的「会话已完成/页面已入库」闸门对它们不生效，历史上传队列仍能把这一页的图片与
 * 识别结果换掉，再点一次提交就会覆盖已入库成绩。归属判据用回执，不用状态字段。
 */
export async function savedReceiptOwnerOfPage(sessionId: string,
  recordId: string, includeDiscarded = false, db = getMysqlDb()): Promise<{ exam_id: number; group_id: string; student_number: string; state: string } | null> {
  const rows = await db.all<Receipt>(
    "SELECT * FROM scanner_submissions WHERE session_id = ? AND (state = 'saved' OR (? = 1 AND state = 'discarded'))", sessionId, includeDiscarded ? 1 : 0);
  for (const row of rows) {
    let pages: ScanBatchPage[] = [];
    try { pages = JSON.parse(row.pages_json) as ScanBatchPage[]; } catch { pages = []; }
    if (pages.some(page => page.recordId === recordId)) {
      return { exam_id: Number(row.exam_id), group_id: row.group_id, student_number: row.student_number, state: row.state };
    }
  }
  return null;
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
/** Upload mutations share the grading queue and exam row locks through commit. */
export function writeScannerSession<T>(sessionId: string, work: (tx: DbAdapter) => Promise<T>): Promise<T> {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb();
    // Discover locks before BEGIN so MariaDB's first consistent read follows the locks.
    const exams = await db.all<{ id: number }>(
      "SELECT e.id FROM exams e JOIN twain_scan_sessions s ON s.card_id=e.card_id WHERE s.id=? ORDER BY e.id", sessionId);
    return db.transaction(async tx => {
      for (const exam of exams) await lockExam(tx, exam.id);
      return work(tx);
    });
  });
}
async function receipts(db: DbAdapter, examId: number): Promise<Receipt[]> {
  return db.all<Receipt>("SELECT * FROM scanner_submissions WHERE exam_id = ? AND state NOT IN ('superseded', 'discarded')", examId);
}
/** 重卡副本在被收成冲突前已经能独立判分。保留其中一份时，复核和分数必须跟这份卷走。 */
function localConflictCard(card: AnswerCard,
  groups: ReadonlyMap<string, Array<{ record: ScanRecordWithResult; page: ScanBatchPage }>>,
  sessionId: string, groupId: string, studentNumber: string, pages: ScanBatchPage[]): ScanConflictCard {
  const rows = groups.get(groupId);
  let graded: CombinedStudentResult | undefined;
  if (rows) {
    try { graded = gradeSessionGroup(card, rows, studentNumber); } catch { graded = undefined; }
  }
  return {
    sessionId, groupId, studentId: studentNumber, previouslySaved: false, pages,
    totalScore: graded?.totalScore, maxScore: graded?.totalMaxScore,
    objectiveScore: graded?.objectiveScore, subjectiveScore: graded?.subjectiveScore,
    needsReviewCount: graded?.needsReviewCount,
  };
}
function conflictCard(row: Receipt): ScanConflictCard {
  const result = row.result_json ? JSON.parse(row.result_json) as CombinedStudentResult : null;
  const snapshot = row.score_snapshot ? JSON.parse(row.score_snapshot) : null;
  return { sessionId: row.session_id, groupId: row.group_id, studentId: row.student_number,
    previouslySaved: Boolean(row.previously_saved), formalScoreRetained: row.state === "saved",
    totalScore: snapshot?.score?.total_score ?? result?.totalScore,
    maxScore: result?.totalMaxScore, objectiveScore: result?.objectiveScore, subjectiveScore: result?.subjectiveScore,
    needsReviewCount: result?.needsReviewCount,
    pages: JSON.parse(row.pages_json) as ScanBatchPage[] };
}
async function withdraw(db: DbAdapter, examId: number, studentNumber: string, reason: "scanner_duplicate" | "scanner_retry" = "scanner_duplicate") {
  const user = await db.get<{ id: number }>("SELECT id FROM users WHERE student_number = ?", studentNumber);
  if (!user) return;
  const score = await db.get("SELECT * FROM student_scores WHERE exam_id = ? AND student_id = ?", examId, user.id);
  if (score) {
    await markScoreMutated(db, examId, null, reason);
    const questions = await db.all("SELECT * FROM question_scores WHERE exam_id = ? AND student_id = ?", examId, user.id);
    await db.run("UPDATE scanner_submissions SET score_snapshot = ?, previously_saved = 1 WHERE exam_id = ? AND student_number = ? AND state = 'saved'",
      JSON.stringify({ score, questions }), examId, studentNumber);
    await db.run("DELETE FROM question_scores WHERE exam_id = ? AND student_id = ?", examId, user.id);
    await db.run("DELETE FROM student_scores WHERE exam_id = ? AND student_id = ?", examId, user.id);
    const sources = await db.all<Receipt>("SELECT * FROM scanner_submissions WHERE exam_id = ? AND student_number = ?", examId, studentNumber);
    for (const source of sources) for (const page of JSON.parse(source.pages_json) as ScanBatchPage[]) {
      await db.run("UPDATE answer_block_crops SET exam_id = NULL, student_id = NULL WHERE source_type = 'twain_scan_record' AND source_record_id = ? AND exam_id = ?", page.recordId, examId);
    }
    // 冲突成绩移除后回到阅卷阶段；公布状态由管理员策略决定。
    await db.run("UPDATE exams SET status = 'grading', updated_at = CURRENT_TIMESTAMP WHERE id = ?", examId);
  }
  await db.run("UPDATE scanner_submissions SET state = 'conflict' WHERE exam_id = ? AND student_number = ? AND state NOT IN ('superseded', 'discarded')", examId, studentNumber);
}

export async function invalidateScanRecognitionInTransaction(tx: DbAdapter, sessionId: string, recordId: string): Promise<Set<number>> {
  const changedExams = new Set<number>();
  const owned = await tx.all<Receipt>("SELECT * FROM scanner_submissions WHERE session_id = ? AND state NOT IN ('superseded', 'discarded')", sessionId);
  for (const receipt of owned) {
    if (!(JSON.parse(receipt.pages_json) as ScanBatchPage[]).some(p => p.recordId === recordId)) continue;
    await lockExam(tx, receipt.exam_id);
    if (receipt.state === "saved") {
      if (await tx.get("SELECT id FROM exams WHERE id=? AND (score_published=1 OR EXISTS (SELECT 1 FROM exam_publish_events p WHERE p.exam_id=exams.id))",receipt.exam_id)) throw new Error("已公布的正式原卷不能重新识别覆盖，请上传新卷并由老师确认");
      await withdraw(tx, receipt.exam_id, receipt.student_number, "scanner_retry");
      changedExams.add(receipt.exam_id);
    }
    await tx.run("UPDATE scanner_submissions SET state = ?, result_json = NULL, score_snapshot = NULL WHERE exam_id = ? AND session_id = ? AND group_id = ?",
      receipt.previously_saved || receipt.state === "pending" ? "pending" : "correction", receipt.exam_id, sessionId, receipt.group_id);
  }
  await tx.run("UPDATE twain_scan_records SET identity_json = NULL, student_id = NULL, student_conf = NULL, ocr_status = 'processing', ocr_error = NULL WHERE id = ? AND session_id = ?", recordId, sessionId);
  await tx.run("DELETE FROM twain_recognition_results WHERE scan_record_id = ?", recordId);
  await tx.run("DELETE FROM scan_correction_pages WHERE source_type = 'twain_scan_record' AND source_id = ?", recordId);
  await tx.run("DELETE FROM answer_block_crops WHERE source_type = ? AND source_record_id = ?", "twain_scan_record", recordId);
  await tx.run("DELETE FROM twain_student_grading_results WHERE session_id = ?", sessionId);
  return changedExams;
}

/** Invalidate a page before retry; saved grades are withdrawn only through their owning receipt. */
export async function invalidateScanRecognition(sessionId: string, recordId: string): Promise<void> {
  return enqueueScannerSubmission(() => invalidateScanRecognitionInQueue(sessionId, recordId));
}

/** Caller owns the scanner queue for the entire recognition-and-write sequence. */
export async function invalidateScanRecognitionInQueue(sessionId: string, recordId: string): Promise<void> {
  const db = getMysqlDb();
  const changedExams = new Set<number>();
  await db.transaction(async tx => {
    for (const id of await invalidateScanRecognitionInTransaction(tx, sessionId, recordId)) changedExams.add(id);
  });
  for (const examId of changedExams) {
    analysisCache.invalidateExam(examId);
    await recomputeExamRankings(db, examId);
  }
}

/** Archive only a verified conflict copy; retain all source evidence for review. */
export async function discardScannerGroup(card: AnswerCard, sessionId: string, groupId: string): Promise<void> {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb();
    await db.transaction(async tx => {
      const receipt = await tx.get<Receipt>(
        "SELECT * FROM scanner_submissions WHERE session_id = ? AND group_id = ? AND state NOT IN ('superseded','discarded')", sessionId, groupId);
      if (!receipt) throw new Error("该分组没有可作废的回执，请刷新结果");
      await lockExam(tx, receipt.exam_id);
      if (!await tx.get("SELECT id FROM exams WHERE id = ? AND card_id = ?", receipt.exam_id, card.id)) throw new Error("答题卡与考试不匹配");
      const current = (await receipts(tx, receipt.exam_id)).find(r => r.session_id === sessionId && r.group_id === groupId);
      if (!current) throw new Error("此卷不构成重复学号冲突，不能作废");
      if (current.previously_saved || current.score_snapshot || current.state === "saved") throw new Error("原已入库卷及成绩快照不能作废，请核对其它副本");
      if (current.state !== "conflict") throw new Error("此卷不构成重复学号冲突，不能作废");
      if ((await receipts(tx, receipt.exam_id)).filter(r => r.student_number === current.student_number).length < 2) throw new Error("该学号只有一份有效回执，不能作废");
      await tx.run("UPDATE scanner_submissions SET state = 'discarded' WHERE exam_id = ? AND session_id = ? AND group_id = ?", receipt.exam_id, sessionId, groupId);
      if ((await receipts(tx, receipt.exam_id)).filter(r => r.student_number === current.student_number).length === 1) {
        await tx.run("UPDATE scanner_submissions SET state = CASE WHEN previously_saved=1 THEN 'pending' ELSE 'correction' END WHERE exam_id = ? AND student_number = ? AND state = 'conflict'", receipt.exam_id, current.student_number);
      }
    });
  });
}

async function restoreScoreSnapshot(tx: DbAdapter, row: Receipt): Promise<void> {
  const examId = row.exam_id;
  const user = await tx.get<{ id: number }>("SELECT id FROM users WHERE student_number = ?", row.student_number);
  if (!user) throw new Error("订正学号不在学生名单中");
  const roster = await ensureExamParticipants(tx, examId);
  if (roster.rosterKnown && roster.participantCount > 0 && !await isExamParticipant(tx, examId, user.id)) throw new Error("订正学号不在应考名单中");
  if (await tx.get("SELECT id FROM student_scores WHERE exam_id = ? AND student_id = ?", examId, user.id)) throw new Error("该学号已有其他成绩，不能覆盖");
  if (!row.score_snapshot) throw new Error("历史成绩快照不存在");
  const snapshot = JSON.parse(row.score_snapshot) as { score: Record<string, unknown>; questions: Record<string, unknown>[] };
  const value = (record: Record<string, unknown>, column: string) => {
    const raw = record[column];
    return typeof raw === "string" && column.endsWith("_at") ? databaseTimestamp(raw, tx.dialect) : raw ?? null;
  };
  if (!row.session_id.startsWith("legacy:")) {
    for (const page of JSON.parse(row.pages_json) as ScanBatchPage[]) {
      if (await tx.get("SELECT id FROM answer_block_crops WHERE source_type = 'twain_scan_record' AND source_record_id = ? AND exam_id IS NOT NULL AND (exam_id <> ? OR (student_id IS NOT NULL AND student_id <> ?))",
        page.recordId, examId, user.id)) throw new Error("原卷切图已属于其他成绩，无法恢复");
      await tx.run("UPDATE answer_block_crops SET exam_id = ?, student_id = ? WHERE source_type = 'twain_scan_record' AND source_record_id = ?",
        examId, user.id, page.recordId);
    }
  }
  const scoreColumns = ["exam_id", "student_id", "objective_score", "subjective_score", "total_score", "assigned_score", "graded_at", "manually_modified", "modified_by", "modified_at"];
  await markScoreMutated(tx, examId, null, "scanner_save");
  await captureExamClasses(tx, examId, user.id);
  await tx.run(buildUpsertSQL(tx.dialect, "student_scores", scoreColumns, ["exam_id", "student_id"]),
    examId, user.id, ...scoreColumns.slice(2).map(c => value(snapshot.score, c)));
  const questionColumns = ["exam_id", "student_id", "question_number", "question_id", "block_id", "score", "max_score", "score_type", "selected_options", "manually_modified", "modified_by", "modified_at"];
  for (const question of snapshot.questions) await tx.run(buildUpsertSQL(tx.dialect, "question_scores", questionColumns, ["exam_id", "student_id", "question_number", "score_type"]),
    examId, user.id, ...questionColumns.slice(2).map(c => value(question, c)));
}

/** Teacher-directed recovery for pre-receipt grades; never infer a new owner from old images. */
export function recoverLegacyScannerSubmission(examId: number, groupId: string, studentNumber?: string) {
  return recoverScannerSubmissionSnapshot(examId, `legacy:${examId}`, groupId, studentNumber);
}

/** Restore the full withdrawn score, including human marks, without regrading it. */
export async function recoverScannerSubmissionSnapshot(examId: number, sessionId: string, groupId: string, studentNumber?: string) {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb();
    await db.transaction(async tx => {
      await lockExam(tx, examId);
      if (!await tx.get("SELECT e.id FROM exams e WHERE e.id = ? AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)", examId)) throw new Error("考试不存在或已删除");
      const row = await tx.get<Receipt>("SELECT * FROM scanner_submissions WHERE exam_id = ? AND session_id = ? AND group_id = ?", examId, sessionId, groupId);
      if (!row?.score_snapshot || row.state === "discarded" || row.state === "superseded") throw new Error("历史成绩快照不存在或已撤销");
      if (studentNumber) {
        if (sessionId !== `legacy:${examId}`) throw new Error("扫描原卷请通过会话订正学号");
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
          else await tx.run("UPDATE scanner_submissions SET state = CASE WHEN previously_saved=1 THEN 'pending' ELSE 'correction' END WHERE exam_id = ? AND student_number = ? AND state = 'conflict'", examId, number);
        }
        return;
      }
      if ((await receipts(tx, examId)).filter(r => r.student_number === row.student_number).length > 1) throw new Error("重复学号尚未解决，历史成绩不能恢复");
      if (row.state === "saved") return;
      await restoreScoreSnapshot(tx, row);
      await tx.run("UPDATE scanner_submissions SET state = 'saved' WHERE exam_id = ? AND session_id = ? AND group_id = ?", examId, row.session_id, groupId);
      await tx.run("UPDATE exams SET status = 'grading', updated_at = CURRENT_TIMESTAMP WHERE id = ?", examId);
    });
    analysisCache.invalidateExam(examId);
    await recomputeExamRankings(db, examId);
    return { ok: true };
  });
}

/** Both paths consume Windows recognition records; this service never runs OMR. */
export async function processScannerSession(card: AnswerCard, sessionId: string,
  mode: "preview" | "validate" | "save" = "preview", saveGroupId?: string, saveGroupIds?: ReadonlySet<string>,
  blockUnreviewed = false): Promise<ScanBatchResponse> {
  return enqueueScannerSubmission(() => processScannerSessionInQueue(card, sessionId, mode, saveGroupId, saveGroupIds, blockUnreviewed));
}

/** Caller retains scanner queue ownership through correction and admission. */
export async function processScannerSessionInQueue(card: AnswerCard, sessionId: string,
  mode: "preview" | "validate" | "save" = "preview", saveGroupId?: string, saveGroupIds?: ReadonlySet<string>,
  blockUnreviewed = false): Promise<ScanBatchResponse> {
    const db = getMysqlDb();
    const records = (await listScanRecordsGroupedByStudent(sessionId)).flatMap(g => g.records);
    const { groups, pageCount } = groupSessionPages(card, records);
    const invalidGroups = new Set<string>();
    const repeatedGroups = new Set<string>();
    for (const [groupId, rows] of groups) {
      try {
        validateSessionGroupStructure(card, rows, pageCount);
        gradeSessionGroup(card, rows, rows.find(row => row.record.student_id)?.record.student_id ?? "");
      }
      catch (error) {
        invalidGroups.add(groupId);
        // A corrupted already-saved original must still be withdrawn through
        // its own receipt; a new invalid paper cannot claim someone else's grade.
        if (error instanceof Error && error.message.includes("缺页或重复页")
          && new Set(rows.map(row => row.page.layoutPage)).size < rows.length) repeatedGroups.add(groupId);
      }
    }
    const legacyBlock = legacySessionBlockReason({ pageCount, sided: card.sided, records, groups });
    // Keep every raw page for stable group IDs. Discarded retries stay archived,
    // and cannot recreate an active receipt when an old upload queue retries.
    const discarded = new Set((await db.all<{ group_id: string }>(
      "SELECT group_id FROM scanner_submissions WHERE session_id = ? AND state = 'discarded'", sessionId)).map(r => r.group_id));
    const visible = (response: ScanBatchResponse) => {
      response.discardedGroups = discarded.size;
      response.results = response.results.filter(r => !discarded.has(r.groupId));
      response.failures = response.failures.filter(r => !discarded.has(r.groupId));
      // A group-scoped save reports only the selected paper. Other groups stay
      // queued and must not turn the selected paper's successful save into a 409.
      if (saveGroupId !== undefined) {
        response.results = response.results.filter(r => r.groupId === saveGroupId);
        response.failures = response.failures.filter(r => r.groupId === saveGroupId);
      }
      return response;
    };
    const candidates = [...groups].filter(([groupId]) => !discarded.has(groupId) && !invalidGroups.has(groupId) && !legacyBlock).flatMap(([groupId, rows]) => {
      const ids = [...new Set(rows.map(r => r.record.student_id).filter((id): id is string => Boolean(id)))];
      return ids.length === 1 ? [{ groupId, studentNumber: ids[0], pages: rows.map(r => r.page) }] : [];
    });
    const { exams, exam } = await resolveScannerExam(card.id, sessionId);
    if (!exam) {
      return visible(await collectSessionResults(card, records, [], mode === "save" ? async () => {
        throw new Error(exams.length === 0 ? "答题卡未关联可阅卷的考试，成绩未入库" : "答题卡关联多个考试，无法确定成绩归属");
      } : undefined));
    }
    let receiptMutated = false;
    if (mode !== "preview" && (candidates.length > 0 || repeatedGroups.size > 0)) {
      await db.transaction(async tx => {
        await lockExam(tx, exam.id);
        const old = await receipts(tx, exam.id);
        // A single-card correction must scope every write, not just final grading.
        // Include the target's old ID so changing its ID can resolve that conflict,
        // and include matching local papers so a real duplicate cannot slip through.
        const targetNumbers = new Set<string>();
        if (saveGroupId !== undefined) {
          const target = candidates.find(c => c.groupId === saveGroupId);
          const prior = old.find(r => r.session_id === sessionId && r.group_id === saveGroupId);
          if (target) targetNumbers.add(target.studentNumber);
          if (prior) targetNumbers.add(prior.student_number);
        }
        // 点名保存只碰这些组。未点名的组连回执都不重写，避免「只入库正常卷」时把待复核组卷进冲突处理。
        const namedCandidates = saveGroupIds
          ? candidates.filter(candidate => saveGroupIds.has(candidate.groupId))
          : candidates;
        const scopedCandidates = saveGroupId === undefined ? namedCandidates : namedCandidates.filter(c =>
          c.groupId === saveGroupId || targetNumbers.has(c.studentNumber));
        for (const groupId of repeatedGroups) {
          if (discarded.has(groupId)) continue;
          if (saveGroupIds && !saveGroupIds.has(groupId)) continue;
          const owner = old.find(row => row.session_id === sessionId && row.group_id === groupId && row.state === "saved");
          if (saveGroupId !== undefined && groupId !== saveGroupId && (!owner || !targetNumbers.has(owner.student_number))) continue;
          if (owner) {
            await withdraw(tx, exam.id, owner.student_number, "scanner_retry");
            receiptMutated = true;
          }
        }
        const affectedStudents = new Set(scopedCandidates.map(c => c.studentNumber));
        for (const candidate of scopedCandidates) {
          receiptMutated = true;
          const prior = old.find(r => r.session_id === sessionId && r.group_id === candidate.groupId);
          if (prior && prior.student_number !== candidate.studentNumber) {
            if (prior.state === "saved") throw new Error("已入库卷不能通过上传修改归属，请由老师处理");
            affectedStudents.add(prior.student_number);
            // Corrections invalidate a previous receipt, never silently move a saved grade.
            await withdraw(tx, exam.id, prior.student_number);
            await tx.run("UPDATE scanner_submissions SET state = 'superseded', group_id = ? WHERE exam_id = ? AND session_id = ? AND group_id = ?",
              `${candidate.groupId}:old:${Date.now()}`, exam.id, sessionId, candidate.groupId);
          }
          const cols = ["exam_id", "session_id", "group_id", "student_number", "pages_json"];
          await tx.run(buildUpsertSQL(tx.dialect, "scanner_submissions", cols, ["exam_id", "session_id", "group_id"], ["pages_json"]),
            exam.id, sessionId, candidate.groupId, candidate.studentNumber, JSON.stringify(candidate.pages));
          const student = await tx.get<{id:number}>("SELECT id FROM users WHERE student_number=? AND role_id=3",candidate.studentNumber);
          const roster = await ensureExamParticipants(tx,exam.id);
          const outside = !student || (roster.rosterKnown && !await isExamParticipant(tx,exam.id,student.id));
          if (outside || (prior && ["held","roster","conflict","correction"].includes(prior.state))) {
            await tx.run("UPDATE scanner_submissions SET state=? WHERE exam_id=? AND session_id=? AND group_id=? AND state<>'saved'",
              outside ? "roster" : prior?.previously_saved ? "pending" : "correction",exam.id,sessionId,candidate.groupId);
          }
          if (prior && prior.student_number !== candidate.studentNumber && prior.previously_saved) {
            await tx.run("UPDATE scanner_submissions SET previously_saved = 1 WHERE exam_id = ? AND session_id = ? AND group_id = ?", exam.id, sessionId, candidate.groupId);
          }
        }
        // Legacy scores have no reliable receipt. Keep their full score snapshot and any
        // matching old scanner pages as evidence instead of treating a cache as proof of saving.
        for (const studentNumber of new Set(scopedCandidates.map(c => c.studentNumber))) {
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
        for (const studentNumber of affectedStudents) {
          const related = all.filter(r => r.student_number === studentNumber);
          let remaining = related;
          const local = scopedCandidates.filter(c => c.studentNumber === studentNumber);
          // Re-upload proof requires the original image and recognition evidence.
          // Multiple papers in one batch and legacy snapshots still need a teacher.
          if (related.length > 1 && local.length === 1) {
            const candidate = local[0];
            const copy = related.find(r => r.session_id === sessionId && r.group_id === candidate.groupId);
            const original = related.find(r => r.state === "saved" && r.result_json
              && !(r.session_id === sessionId && r.group_id === candidate.groupId));
            if (original && copy && copy.state !== "held" && copy.state !== "roster" && copy.state !== "correction" && !copy.previously_saved && !copy.score_snapshot && copy.state !== "saved") {
              const oldEvidence = await scannerDuplicateEvidence(tx, original.session_id, studentNumber, JSON.parse(original.pages_json));
              const newEvidence = await scannerDuplicateEvidence(tx, sessionId, studentNumber, candidate.pages);
              if (oldEvidence && newEvidence && JSON.stringify(oldEvidence) === JSON.stringify(newEvidence)) {
                await tx.run("UPDATE scanner_submissions SET state = 'discarded' WHERE exam_id = ? AND session_id = ? AND group_id = ?", exam.id, sessionId, candidate.groupId);
                discarded.add(candidate.groupId);
                remaining = related.filter(r => r !== copy);
              }
            }
          }
          if (remaining.length > 1) await withdraw(tx, exam.id, studentNumber);
          // Resolved attempts stay in the review queue until the teacher explicitly saves them.
          else await tx.run("UPDATE scanner_submissions SET state = CASE WHEN previously_saved=1 THEN 'pending' ELSE 'correction' END WHERE exam_id = ? AND student_number = ? AND state = 'conflict'", exam.id, studentNumber);
        }
      });
      if (receiptMutated) {
        analysisCache.invalidateExam(exam.id);
        await recomputeExamRankings(db, exam.id);
      }
    }
    let all = await receipts(db, exam.id);
    const cached: StudentGradingResultRow[] = [];
    for (const row of all.filter(r => r.session_id === sessionId && r.state === "saved" && r.result_json
      && candidates.some(candidate => candidate.groupId === r.group_id))) {
      const exists = await db.get("SELECT ss.id FROM student_scores ss JOIN users u ON u.id = ss.student_id WHERE ss.exam_id = ? AND u.student_number = ?", exam.id, row.student_number);
      if (!exists) continue;
      // Historical partial saves can have grades and receipts but unbound crops.
      // Replay repairs their ownership without rewriting scores or publication.
      if (mode === "save" && (saveGroupId === undefined || row.group_id === saveGroupId) && (!saveGroupIds || saveGroupIds.has(row.group_id))) await db.transaction(async tx => {
        await lockExam(tx, exam.id);
        await linkSavedScannerCrops(tx, card.id, row);
      });
      const result = JSON.parse(row.result_json!) as CombinedStudentResult;
      cached.push({ student_id: row.student_number, objective_json: JSON.stringify(result.objectiveQuestions),
        subjective_json: JSON.stringify(result.subjectiveQuestions), total_score: result.totalScore,
        max_score: result.totalMaxScore, page_count: result.pageCount } as StudentGradingResultRow);
    }
    const activeRecords = [...groups].filter(([groupId]) => !discarded.has(groupId)).flatMap(([, rows]) => rows.map(row => row.record));
    const response = await collectSessionResults(card, activeRecords, cached, mode === "save" ? async result => {
      const candidate = candidates.find(c => c.pages.some(p => p.recordId === result.pages[0]?.recordId));
      if (!candidate || discarded.has(candidate.groupId) || (saveGroupId !== undefined && candidate.groupId !== saveGroupId)) return false;
      if (saveGroupIds && !saveGroupIds.has(candidate.groupId)) return false;
      // 存疑题不拦入库（issue #352 维护者口径）：带低置信度标记的成绩照常写正式成绩，
      // 复核在异常卷队列与 Web 成绩修改里继续做。只有调用方显式打开 blockUnreviewed
      // 时才拦住入库，作为可选的保守入口保留。
      if (blockUnreviewed && result.needsReviewCount > 0) return false;
      await db.transaction(async tx => {
        await lockExam(tx, exam.id);
        const current = await receipts(tx, exam.id);
        if (current.filter(r => r.student_number === result.studentId).length > 1) throw new Error("重复学号：所有相关答题卡需订正后重新保存");
        const receipt = current.find(r => r.session_id === sessionId && r.group_id === candidate.groupId);
        if (!receipt) throw new Error("扫描成绩回执缺失，无法保存");
        // Completion retries are automatic; resolved duplicates still require a named teacher save.
        const explicitlySelected = saveGroupId === candidate.groupId || saveGroupIds?.has(candidate.groupId);
        if (receipt.state === "correction" && !explicitlySelected) throw new Error("此卷待核对，请在整卡改分或异常卷列表中显式保存此卷");
        if (receipt.state === "held" || receipt.state === "roster") throw new Error("此卷待老师确认，已有正式成绩保持不变，请在考试或成绩分析页面处理");
        for (const page of candidate.pages) await assertCorrectionPageProvenance(tx, card, page.recordId);
        if (receipt?.score_snapshot && receipt.previously_saved && receipt.state !== "saved") {
          await restoreScoreSnapshot(tx, receipt);
        } else {
          await persistScannerResultToMainDb(card.id, result, true, { db: tx, examId: exam.id });
        }
        await tx.run("UPDATE scanner_submissions SET state = 'saved', previously_saved = 1, result_json = ? WHERE exam_id = ? AND session_id = ? AND group_id = ?",
          JSON.stringify(result), exam.id, sessionId, candidate.groupId);
        await linkSavedScannerCrops(tx, card.id, {
          ...receipt, state: "saved", pages_json: JSON.stringify(candidate.pages)
        });
        await tx.run(buildUpsertSQL(tx.dialect, "twain_student_grading_results",
          ["session_id", "student_id", "objective_json", "subjective_json", "total_score", "max_score", "page_count"], ["session_id", "student_id"]),
          sessionId, result.studentId, JSON.stringify(result.objectiveQuestions), JSON.stringify(result.subjectiveQuestions), result.totalScore, result.totalMaxScore, result.pageCount);
      });
    } : undefined);
    all = await receipts(db, exam.id);
    for (const candidate of candidates) {
      if (discarded.has(candidate.groupId)) continue;
      const own = all.find(r => r.session_id===sessionId && r.group_id===candidate.groupId);
      if (own?.state === "saved" && all.some(r => r.student_number===candidate.studentNumber && ["held","roster"].includes(r.state))) continue;
      const others = all.filter(r => r.student_number === candidate.studentNumber && !(r.session_id === sessionId && r.group_id === candidate.groupId));
      const localDuplicates = candidates.filter(c => c.studentNumber === candidate.studentNumber);
      if (others.length === 0 && localDuplicates.length < 2) continue;
      response.results = response.results.filter(r => r.groupId !== candidate.groupId);
      response.failures = response.failures.filter(r => r.groupId !== candidate.groupId);
      const related = all.filter(r => r.student_number === candidate.studentNumber).map(conflictCard);
      for (const local of localDuplicates) if (!related.some(r => r.sessionId === sessionId && r.groupId === local.groupId)) {
        related.push(localConflictCard(card, groups, sessionId, local.groupId, candidate.studentNumber, local.pages));
      }
      response.failures.push({ groupId: candidate.groupId, studentId: candidate.studentNumber, stage: "recognition", pages: candidate.pages,
        message: all.some(r => r.student_number===candidate.studentNumber && ["held","roster"].includes(r.state)) ? "重复上传待老师确认，已有正式成绩保持不变，请在考试或成绩分析页面处理" : "重复学号：新旧答题卡均需核对订正，已保存成绩撤出后才可重新保存", conflicts: related });
    }
    if (mode === "save" && receiptMutated) {
      analysisCache.invalidateExam(exam.id);
      await recomputeExamRankings(db, exam.id);
    }
    response.reviewCards = all.filter(r => r.state === "correction" || (r.state === "pending" && r.previously_saved)).map(conflictCard);
    return visible(response);
}

/**
 * 删除护栏数据源：这些组里哪些回执已经「定论或待老师确认」。
 * saved/held/conflict/roster/correction 均需确认；validate 阶段给每份卷写的 pending 回执
 * 是本机判分常态，把它也算进来会让每次本地删除都弹「已上传」的假警告。
 * 参数走 DbAdapter 的 varargs；整体绑数组在 MariaDB 上是占位符与实参数量不匹配。
 */
export async function listActiveReceiptGroups(db: DbAdapter, sessionId: string, groupIds: readonly string[]): Promise<string[]> {
  if (!groupIds.length) return [];
  const placeholders = groupIds.map(() => "?").join(",");
  const rows = await db.all<{ group_id: string }>(
    `SELECT DISTINCT group_id FROM scanner_submissions WHERE session_id = ? AND group_id IN (${placeholders}) AND state IN ('saved','held','conflict','roster','correction')`,
    sessionId, ...groupIds,
  );
  return rows.map(row => row.group_id);
}
