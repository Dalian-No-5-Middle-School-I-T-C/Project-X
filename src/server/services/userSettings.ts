import { getMysqlDb } from "../db";
import { OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD } from "../../shared/grading";

/** 读取用户配置的客观题复核置信度阈值；未登录或无效值时回落默认。 */
export async function resolveReviewConfidenceThreshold(userId: number | undefined): Promise<number> {
  if (!userId) return OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD;
  try {
    const row = await getMysqlDb().get(
      "SELECT review_confidence_threshold AS t FROM users WHERE id = ?",
      userId
    ) as { t: number | string | null } | undefined;
    const value = Number(row?.t);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  } catch {
    // 读取失败时使用默认阈值
  }
  return OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD;
}
