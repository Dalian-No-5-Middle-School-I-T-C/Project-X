/**
 * 所有写分路径在成绩事务内读取管理员策略。默认保持公布，学生读取最新成绩；
 * 开启 auto_unpublish_on_score_change 后才自动撤回整场并记录审计。
 * 统计缓存失效和排名重算由写分调用方在数据变更后执行，与是否撤回无关。
 */
import type { DbAdapter } from "../db";

export type ScoreMutationReason = "score_edit" | "answer_edit" | "arbitration" | "review_submit" | "assigned_recalc" | "assigned_disable" | "scanner_duplicate" | "scanner_retry" | "scanner_save" | "grading_save";

const REASON_TEXT: Record<ScoreMutationReason, string> = {
  score_edit: "手动改分自动撤回",
  answer_edit: "修改答案自动撤回",
  arbitration: "仲裁提交自动撤回",
  review_submit: "网阅评分自动撤回",
  assigned_recalc: "赋分重算自动撤回",
  assigned_disable: "赋分禁用自动撤回",
  scanner_duplicate: "扫描重复学号自动撤回",
  scanner_retry: "扫描重新识别自动撤回",
  scanner_save: "扫描成绩入库自动撤回",
  grading_save: "批量成绩入库自动撤回"
};

export async function markScoreMutated(
  tx: DbAdapter,
  examId: number,
  actorId: number | null,
  reason: ScoreMutationReason
): Promise<boolean> {
  const policy = await tx.get<{ value: string }>(
    "SELECT value FROM system_settings WHERE `key` = ?", "auto_unpublish_on_score_change"
  );
  if (policy?.value !== "1") return false;
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
