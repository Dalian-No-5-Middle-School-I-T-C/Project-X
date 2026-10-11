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
import { captureExamClasses } from "./examClassMemberships";

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
/**
 * 该扫描页是否已被一张 `state='saved'` 的回执认领（PR #312 复核 CR2）。
 *
 * `/complete` 只在**全部**分组入库成功时把会话与页面推到 `completed`；部分失败时它先 409 返回，
 * 那些已经保存成功的分组留下 `saved` 回执，但页面状态仍是 `uploaded`、会话仍是 `incomplete`。
 * 于是 R02 的「会话已完成/页面已入库」闸门对它们不生效，历史上传队列仍能把这一页的图片与
 * 识别结果换掉，再点一次提交就会覆盖已入库成绩。归属判据用回执，不用状态字段。
 */
export async function savedReceiptOwnerOfPage(sessionId: string,
  recordId: string): Promise<{ exam_id: number; group_id: string; student_number: string } | null> {
  const rows = await getMysqlDb().all<Receipt>(
    "SELECT * FROM scanner_submissions WHERE session_id = ? AND state = 'saved'", sessionId);
  for (const row of rows) {
    let pages: ScanBatchPage[] = [];
    try { pages = JSON.parse(row.pages_json) as ScanBatchPage[]; } catch { pages = []; }
    if (pages.some(page => page.recordId === recordId)) {
      return { exam_id: Number(row.exam_id), group_id: row.group_id, student_number: row.student_number };
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

/** 候选组的识别内容与已保存回执是否逐题一致（重扫判重依据）。
 *  只比较识别内容本身（客观题题号+选项、主观题题号+自报分），
 *  不含打分衍生的对错/得分字段——两侧 JSON 形状不同，直接比字符串永远不会相等。 */
async function candidateMatchesSavedResult(tx: DbAdapter, candidate: { pages: ScanBatchPage[] }, saved: CombinedStudentResult): Promise<boolean> {
  if (saved.pageCount !== candidate.pages.length) return false;
  const marks = candidate.pages.map(() => "?").join(",");
  const rows = await tx.all<{ objective_json: string | null; subjective_json: string | null }>(
    `SELECT objective_json, subjective_json FROM twain_recognition_results WHERE scan_record_id IN (${marks})`,
    ...candidate.pages.map(p => p.recordId));
  if (rows.length !== candidate.pages.length || rows.some(r => !r.objective_json || !r.subjective_json)) return false;
  type Item = Record<string, unknown>;
  const canonical = (items: Item[], pick: (item: Item) => Item) =>
    JSON.stringify(items.map(pick).sort((a, b) => String(a.questionNumber).localeCompare(String(b.questionNumber))));
  const objectiveOf = (q: Item) => ({ questionNumber: q.questionNumber, selectedOptions: q.selectedOptions });
  const subjectiveOf = (q: Item) => ({ questionId: q.questionId, questionNumber: q.questionNumber, score: q.score, maxScore: q.maxScore });
  return canonical(rows.flatMap(r => JSON.parse(r.objective_json!) as Item[]), objectiveOf)
      === canonical(saved.objectiveQuestions as unknown as Item[], objectiveOf)
    && canonical(rows.flatMap(r => JSON.parse(r.subjective_json!) as Item[]), subjectiveOf)
      === canonical(saved.subjectiveQuestions as unknown as Item[], subjectiveOf);
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
    // A withdrawn score invalidates completeness/publication as well as rankings.
    // 与撤回同事务写入 status + score_published，避免单写 status 后两字段永久错位
    // （「已公布」徽章仍在而分析页显示「阅卷中」）。score_published 置 0 与上面
    // markScoreMutated 的既有约定一致（成绩一有变动即视为未公布），这里同值重写只为成对落库。
    //
    // 这里**不能再开嵌套事务**：withdraw 收到的 db 恒为调用方 `db.transaction(tx => ...)`
    // 里传下来的事务适配器（invalidateScanRecognition / recoverLegacyScannerSubmission /
    // 重复卷处理都是这个形状）。SQLite 侧再执行 BEGIN 会抛
    // 「cannot start a transaction within a transaction」；MariaDB 侧会对 PoolConnection
    // 调用不存在的 getConnection()。两者都会让整条撤回链路 500，本应返回的 409 冲突也拿不到。
    // 原子性由外层事务保证，故合并成单条 UPDATE 直接写在传入的适配器上。
    await db.run("UPDATE exams SET status = 'grading', score_published = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", examId);
  }
  await db.run("UPDATE scanner_submissions SET state = 'conflict' WHERE exam_id = ? AND student_number = ? AND state != 'superseded'", examId, studentNumber);
}

/** Invalidate a page before retry; saved grades are withdrawn only through their owning receipt. */
export async function invalidateScanRecognition(sessionId: string, recordId: string): Promise<void> {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb();
    const changedExams = new Set<number>();
    await db.transaction(async tx => {
      const owned = await tx.all<Receipt>("SELECT * FROM scanner_submissions WHERE session_id = ? AND state != 'superseded'", sessionId);
      for (const receipt of owned) {
        if (!(JSON.parse(receipt.pages_json) as ScanBatchPage[]).some(p => p.recordId === recordId)) continue;
        await lockExam(tx, receipt.exam_id);
        if (receipt.state === "saved") {
          await withdraw(tx, receipt.exam_id, receipt.student_number, "scanner_retry");
          changedExams.add(receipt.exam_id);
        }
        await tx.run("UPDATE scanner_submissions SET state = 'pending', result_json = NULL, score_snapshot = NULL WHERE exam_id = ? AND session_id = ? AND group_id = ?",
          receipt.exam_id, sessionId, receipt.group_id);
      }
      await tx.run("UPDATE twain_scan_records SET identity_json = NULL, student_id = NULL, student_conf = NULL, ocr_status = 'processing', ocr_error = NULL WHERE id = ? AND session_id = ?", recordId, sessionId);
      await tx.run("DELETE FROM twain_recognition_results WHERE scan_record_id = ?", recordId);
      await tx.run("DELETE FROM answer_block_crops WHERE source_type = ? AND source_record_id = ?", "twain_scan_record", recordId);
      await tx.run("DELETE FROM twain_student_grading_results WHERE session_id = ?", sessionId);
    });
    for (const examId of changedExams) {
      analysisCache.invalidateExam(examId);
      await recomputeExamRankings(db, examId);
    }
  });
}

/** 教师作废一张重复卷：回执置 superseded、页面标记作废。已入库（saved 且有成绩）的卷拒绝作废。 */
export async function discardScannerGroup(card: AnswerCard, sessionId: string, groupId: string): Promise<void> {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb();
    await db.transaction(async tx => {
      const records = (await listScanRecordsGroupedByStudent(sessionId)).flatMap(g => g.records);
      const group = groupSessionPages(card, records).groups.get(groupId);
      if (!group) throw new Error("答题卡分组不存在");
      const receipt = await tx.get<{ state: string; result_json: string | null; student_number: string; exam_id: number }>(
        "SELECT state, result_json, student_number, exam_id FROM scanner_submissions WHERE session_id = ? AND group_id = ? AND state != 'superseded'", sessionId, groupId);
      // 作废是破坏性动作（删除识别结果与切图），必须确属「重复学号冲突」才允许：
      // 没有回执（未提交/已作废）或该学号只有一份回执时拒绝，避免任意或过期请求
      // 把一张有效答题卡作废掉（与订正路由不同，这里此前缺少冲突前置校验）。
      if (!receipt) throw new Error("该分组没有可作废的回执（未提交或已作废），不能作废");
      if (receipt.state === "saved" && receipt.result_json) {
        throw new Error("该卷成绩已入库，不能作废；请作废其它重复副本");
      }
      const dup = await tx.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM scanner_submissions WHERE exam_id = ? AND student_number = ? AND state != 'superseded'",
        receipt.exam_id, receipt.student_number);
      if (Number(dup?.n ?? 0) < 2) {
        throw new Error("该学号当前只有一份回执，不构成重复学号冲突，不能作废");
      }
      await tx.run("UPDATE scanner_submissions SET state = 'superseded', group_id = ? WHERE session_id = ? AND group_id = ? AND state != 'superseded'",
        `${groupId}:discarded:${Date.now()}`, sessionId, groupId);
      for (const { record } of group) {
        await tx.run("UPDATE twain_scan_records SET student_id = NULL, ocr_status = 'failed', ocr_error = '重复卷已由教师作废' WHERE id = ? AND session_id = ?", record.id, sessionId);
        await tx.run("DELETE FROM twain_recognition_results WHERE scan_record_id = ?", record.id);
        await tx.run("DELETE FROM answer_block_crops WHERE source_type = 'twain_scan_record' AND source_record_id = ?", record.id);
      }
      await tx.run("DELETE FROM twain_student_grading_results WHERE session_id = ?", sessionId);
    });
  });
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
      await captureExamClasses(tx, examId, user.id);
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
    // P1 重扫判重：与已保存回执内容一致的本次会话分组，tx 内置 superseded 后置此集合，
    // 函数级声明是因为冲突后置循环在 tx 块外（rescannedGroups 在两处都要用）。
    const rescannedGroups = new Set<string>();
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
          const withNumber = all.filter(r => r.student_number === studentNumber);
          if (withNumber.length > 1) {
            // P1 重扫判重：同学生、识别内容逐题一致 ⇒ 同一物理卡的重扫副本。
            // 作废多余副本并保留成绩——绝不能按「新 vs 旧」撤回（线上一张卡反复重传，
            // 每次都把上一次已保存的成绩撤掉，成绩永远存不住、冲突卡越滚越多）。
            const saved = withNumber.find(r => r.state === "saved" && r.result_json);
            const localCandidates = candidates.filter(c => c.studentNumber === studentNumber);
            // 仅当本次会话对该学号只有一份候选（=同一物理卡重扫重传）才做内容级判重；
            // 一次会话内同学号出现多份是本地重复（真冲突），必须保留人工核对，不能自动消化。
            if (saved && localCandidates.length === 1) {
              const candidate = localCandidates[0];
              const savedResult = JSON.parse(saved.result_json!) as CombinedStudentResult;
              if (await candidateMatchesSavedResult(tx, candidate, savedResult)) {
                await tx.run("UPDATE scanner_submissions SET state = 'superseded', group_id = ? WHERE exam_id = ? AND session_id = ? AND group_id = ?",
                  `${candidate.groupId}:rescan:${Date.now()}`, exam.id, sessionId, candidate.groupId);
                rescannedGroups.add(candidate.groupId);
              }
            }
          }
          const remaining = (await receipts(tx, exam.id)).filter(r => r.student_number === studentNumber);
          if (remaining.length > 1) await withdraw(tx, exam.id, studentNumber);
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
      if (rescannedGroups.has(candidate.groupId)) continue;   // 重扫副本已自动消化，不再报冲突
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
