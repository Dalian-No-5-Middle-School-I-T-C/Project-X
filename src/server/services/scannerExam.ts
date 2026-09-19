import { getMysqlDb } from "../db";

/** Authorization and persistence must resolve exactly the same exam, including closed retries. */
export async function resolveScannerExam(cardId: string, sessionId: string) {
  const db = getMysqlDb();
  const exams = await db.all<{ id: number; status: string }>(
    "SELECT e.id, e.status FROM exams e WHERE e.card_id = ? AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)", cardId);
  const bound = await db.all<{ exam_id: number }>("SELECT DISTINCT exam_id FROM scanner_submissions WHERE session_id = ?", sessionId);
  const active = exams.filter(e => e.status !== "closed");
  const exam = bound.length > 0
    ? bound.length === 1 ? exams.find(e => e.id === bound[0].exam_id) : undefined
    : active.length === 1 ? active[0] : active.length === 0 && exams.length === 1 ? exams[0] : undefined;
  return { exams, exam };
}
