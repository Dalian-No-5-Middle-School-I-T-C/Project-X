/**
 * 成绩发布状态同步（评审 P1）：所有「修改成绩」的写分路径落库时必须先经此函数。
 *
 * 语义：已公布（score_published=1）的考试一旦成绩被修改（逐题改分 / 改答案重评 /
 * 仲裁提交 / 网阅评分 / 赋分重算），自动撤回公布（score_published=0）并写入
 * unpublish 审计事件 —— 学生读门只认 score_published=1，修改后成绩立即对学生
 * 不可见，审计不再显示「已公布但内容已变」的矛盾状态。
 *
 * 调用约定：必须在与成绩写入同一事务内调用（tx 传入），保证「撤回 + 审计」与
 * 分数修改原子提交；未公布（0/已撤回 2/NULL）时调用是零写入的 no-op。
 * 返回本次是否发生了撤回。
 */
import type { DbAdapter } from "../db";

export type ScoreMutationReason = "score_edit" | "answer_edit" | "arbitration" | "review_submit" | "assigned_recalc" | "assigned_disable";

const REASON_TEXT: Record<ScoreMutationReason, string> = {
  score_edit: "手动改分自动撤回",
  answer_edit: "修改答案自动撤回",
  arbitration: "仲裁提交自动撤回",
  review_submit: "网阅评分自动撤回",
  assigned_recalc: "赋分重算自动撤回",
  assigned_disable: "赋分禁用自动撤回"
};

export async function markScoreMutated(
  tx: DbAdapter,
  examId: number,
  actorId: number | null,
  reason: ScoreMutationReason
): Promise<boolean> {
  const result = await tx.run(
    "UPDATE exams SET score_published = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND score_published = 1",
    examId
  );
  if (result.changes !== 1) return false;
  await tx.run(
    "INSERT INTO exam_publish_events (exam_id, action, actor_id, reason) VALUES (?, 'unpublish', ?, ?)",
    examId, actorId ?? null, REASON_TEXT[reason]
  );
  return true;
}
