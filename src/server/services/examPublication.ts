import type { DbAdapter } from "../db";
import { ApiError } from "../api-error";

/**
 * 单场与批量公布均发布当前已有成绩，不以应考名单齐全为前提。
 * 缺考、未入库异常卷或未设置名单不能阻塞其他学生查分，也不应为发布删除应考学生。
 * 名单继续用于入库身份校验与缺考统计；公布不会为未出分学生补造零分。
 * 业务回归必须覆盖部分成绩可公布，不能恢复旧的全员出分门槛。
 */
export async function assertScoresPublishable(db: DbAdapter, exam: { id: number }): Promise<void> {
  const scoredRow = await db.get<{ n: number }>(
    "SELECT COUNT(DISTINCT student_id) AS n FROM student_scores WHERE exam_id = ?",
    exam.id
  );
  const scoredCount = Number(scoredRow?.n ?? 0);
  if (scoredCount === 0) {
    throw Object.assign(
      new Error("该考试尚无成绩记录（批改未完成），无法公布成绩"),
      { status: 409, code: ApiError.INVALID_VALUE }
    );
  }

}
