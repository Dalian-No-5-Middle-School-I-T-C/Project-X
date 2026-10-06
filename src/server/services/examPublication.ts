import type { DbAdapter } from "../db";
import { ApiError } from "../api-error";
import { ensureExamParticipants, listMissingParticipants } from "./examParticipants";

/**
 * 成绩公布完整性校验（评审 P1-1 / P1-2；单场与批量公布共用同一谓词）。
 *
 * 口径来自 #248 发布说明 §3.3：
 * - 应考名单来源：管理员显式名单（`exam_participants.source='explicit'`）优先；
 *   否则按考试 `class_id`/`grade_id` 从 `class_students` **固化名册快照**（`source='roster'`），
 *   之后调班/转学不影响该场考试的口径。
 * - 名单可知且非空 → 做集合校验「**应考集合 ⊆ 已评分集合**」，缺任何一名应考学生即 409。
 *   快照之外的多余成绩（外班学生、误识别）**不阻断**发布，也不会被并进快照（单向校验）。
 * - 名单不可知（既无年级/班级范围，也没有显式名单）→ 409 拒绝公布：
 *   v48 起就删掉的「仅校验非空」退路不再恢复，否则无范围考试可以拿部分成绩当全量发布。
 * - 名单为空（班级暂无学生 / 显式名单被清空）→ 409。
 *
 * 缺考学生（确实不出分的）走显式名单：把缺考者从应考名单中剔除后再公布。
 *
 * 抛出 `{ status: 409 }` 由路由统一映射为 409 响应。
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

  const snapshot = await ensureExamParticipants(db, exam.id);
  if (!snapshot.rosterKnown) {
    throw Object.assign(
      new Error("【完整性校验】该考试未确定应考范围（未指定年级/班级且未设置应考名单），无法公布成绩；请先在考试管理中设置应考范围或应考名单"),
      { status: 409, code: ApiError.INVALID_VALUE }
    );
  }
  if (snapshot.participantCount === 0) {
    throw Object.assign(
      new Error("【完整性校验】该考试应考名单为空（班级暂无学生或应考名单未添加学生），无法公布成绩；请先录入学生或设置应考名单"),
      { status: 409, code: ApiError.INVALID_VALUE }
    );
  }

  const missing = await listMissingParticipants(db, exam.id);
  if (missing.length > 0) {
    // 安全（PR #312 评审 B6，与 CR12 同一口径）：错误消息**只给人数，不给姓名/学号**。
    // 公布校验的 409 会原样出现在前端提示里，而晨测这类高频场景下教师一次要公布很多场，
    // 拼进「张三(20250101)」名单等于把未出分学生的身份明细批量外送到调用方的屏幕上——
    // 而这些学生恰恰是「本场没有成绩」的人，他们的姓名本身就是一种可读结果。
    // 服务端日志同样只记人数：不在这里另开一个 PII 汇聚点。
    throw Object.assign(
      new Error(
        `该考试成绩记录不完整（应考 ${snapshot.participantCount} 人，缺 ${missing.length} 名应考学生成绩），`
        + `无法公布成绩；请在「考试管理 → 应考名单」中核对应考范围，把缺考学生从名单中剔除后再公布`
      ),
      { status: 409, code: ApiError.INVALID_VALUE, missingCount: missing.length }
    );
  }
}
