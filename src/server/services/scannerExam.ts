import { getMysqlDb } from "../db";

/**
 * Authorization and persistence must resolve exactly the same exam, including closed retries.
 *
 * `exams` 只含未归档的考试（既有语义），但中间件还需要知道「这张卡到底绑过考试没有」：
 * 只看 `exams` 会把「绑定的考试全部被软删除」当成「本机扫描、尚未绑定」而放行，
 * 于是软删除反而绕开了范围校验（PR #312 复核 CR4）。这里一次性查出带归档标记的集合。
 */
export async function resolveScannerExam(cardId: string, sessionId: string) {
  const db = getMysqlDb();
  const rows = await db.all<{ id: number; status: string; archived: number | string }>(
    `SELECT e.id, e.status,
            CASE WHEN EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)
                 THEN 1 ELSE 0 END AS archived
       FROM exams e WHERE e.card_id = ?`, cardId);
  const exams = rows.filter(e => !Number(e.archived)).map(e => ({ id: Number(e.id), status: e.status }));
  const bound = await db.all<{ exam_id: number }>("SELECT DISTINCT exam_id FROM scanner_submissions WHERE session_id = ?", sessionId);
  const active = exams.filter(e => e.status !== "closed");
  const exam = bound.length > 0
    ? bound.length === 1 ? exams.find(e => e.id === bound[0].exam_id) : undefined
    : active.length === 1 ? active[0] : active.length === 0 && exams.length === 1 ? exams[0] : undefined;
  return { exams, exam, allExamIds: rows.map(e => Number(e.id)), boundExamIds: bound.map(row => Number(row.exam_id)) };
}

export type ScannerExamResolution = Awaited<ReturnType<typeof resolveScannerExam>>;

/**
 * 「这场扫描真正可能属于谁」：会话已经绑定过仍在用的考试时只认这些绑定；从未提交过才退回
 * 同卡的全部在用考试。订正文档、原图与结果读取必须共用同一份候选，否则订正能打开、
 * 文档里的原图却因另一场无关复用考试被拒（issue #352 评审 P2）。
 */
export function scannerAuthorizationCandidates(resolved: ScannerExamResolution): number[] {
  const active = new Set(resolved.exams.map(exam => Number(exam.id)));
  const boundActive = resolved.boundExamIds.map(Number).filter(examId => active.has(examId));
  return boundActive.length > 0 ? boundActive : Array.from(active);
}
