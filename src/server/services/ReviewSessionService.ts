import { getMysqlDb, buildUpsertSQL } from "../db";
import type { DbAdapter } from "../db";
import type { ReviewSession } from "../../shared/types";

type SessionRow = {
  id: number;
  teacher_id: number;
  exam_id: number;
  block_id: string;
  current_index: number;
  position_json: string | null;
  draft_scores: string | null;
  updated_at: string;
};

function toSession(row: SessionRow): ReviewSession {
  return {
    id: row.id,
    teacherId: row.teacher_id,
    examId: row.exam_id,
    blockId: row.block_id,
    currentIndex: row.current_index,
    positionJson: row.position_json ? JSON.parse(row.position_json) : null,
    draftScores: row.draft_scores ? JSON.parse(row.draft_scores) : null,
    updatedAt: row.updated_at
  };
}

/** 读取会话 */
export async function getSession(
  teacherId: number,
  examId: number,
  blockId: string,
  db: DbAdapter = getMysqlDb()
): Promise<ReviewSession | null> {
  const row = await db.get(
    "SELECT * FROM review_sessions WHERE teacher_id = ? AND exam_id = ? AND block_id = ?",
    teacherId,
    examId,
    blockId
  ) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

/** 保存/更新会话 */
export async function saveSession(
  teacherId: number,
  examId: number,
  blockId: string,
  currentIndex: number,
  positionJson: Record<string, unknown> | null,
  draftScores: Record<number, number> | null,
  db: DbAdapter = getMysqlDb()
): Promise<void> {
  const now = new Date().toISOString();
  const posStr = positionJson ? JSON.stringify(positionJson) : null;
  const draftStr = draftScores ? JSON.stringify(draftScores) : null;

  const upsertCols = ["teacher_id", "exam_id", "block_id", "current_index", "position_json", "draft_scores", "updated_at"];
  const conflictCols = ["teacher_id", "exam_id", "block_id"];
  const updateCols = ["current_index", "position_json", "draft_scores", "updated_at"];
  const upsertSQL = buildUpsertSQL(db.dialect, "review_sessions", upsertCols, conflictCols, updateCols);

  await db.run(upsertSQL, teacherId, examId, blockId, currentIndex, posStr, draftStr, now);
}

/** 清除会话 */
export async function clearSession(
  teacherId: number,
  examId: number,
  blockId: string,
  db: DbAdapter = getMysqlDb()
): Promise<void> {
  await db.run(
    "DELETE FROM review_sessions WHERE teacher_id = ? AND exam_id = ? AND block_id = ?",
    teacherId,
    examId,
    blockId
  );
}

/** 获取教师所有未完成的阅卷会话 */
export async function getUnfinishedSessions(
  teacherId: number,
  db: DbAdapter = getMysqlDb()
): Promise<ReviewSession[]> {
  const rows = await db.all(
    "SELECT * FROM review_sessions WHERE teacher_id = ? ORDER BY updated_at DESC",
    teacherId
  ) as SessionRow[];
  return rows.map(toSession);
}
