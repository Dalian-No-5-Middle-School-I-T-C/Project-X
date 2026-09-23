import type { DbAdapter } from "../db";
import { ApiError } from "../api-error";
import { ensureExamParticipants } from "./examParticipants";

/** Allow partial attendance/results; retain validation of existing score identities. */
export async function assertScoresPublishable(db: DbAdapter, exam: { id: number }): Promise<void> {
  const score = await db.get("SELECT 1 AS ok FROM student_scores WHERE exam_id = ? LIMIT 1", exam.id);
  if (!score) {
    throw Object.assign(new Error("该考试尚无成绩记录，无法公布成绩"), { status: 409, code: ApiError.INVALID_VALUE });
  }
  const snapshot = await ensureExamParticipants(db, exam.id);
  if (!snapshot.rosterKnown || snapshot.participantCount === 0) return;

  const outsider = await db.get(
    `SELECT ss.student_id FROM student_scores ss
     WHERE ss.exam_id = ? AND NOT EXISTS (
       SELECT 1 FROM exam_participants ep
       WHERE ep.exam_id = ss.exam_id AND ep.student_id = ss.student_id AND ep.source = ?
     ) LIMIT 1`,
    exam.id, snapshot.source,
  );
  if (outsider) {
    throw Object.assign(new Error("成绩中包含非应考学生，请核对学生身份后公布"), { status: 409, code: ApiError.INVALID_VALUE });
  }
}
