/**
 * scoringMode 双向一致性校验
 *
 * 设计背景：PR #189 引入 block_total / per_question 两种题块评分模式。
 * 同一题块必须严格遵守配置意图——两种模式的提交结构互斥：
 *   - block_total  : 前端必须提交 blockTotalScore（题块合计分），后端拆分到各小题
 *   - per_question : 前端必须按题提交逐题分数，禁止同时提交 blockTotalScore
 *
 * 历史问题：原实现只校验 per_question 方向，反方向漏检导致：
 *   "配置为 block_total 却只提交逐题分数" 也能通过，
 *   同一题块在不同阅卷入口走不同评分语义，配置无法可靠表达业务规则。
 *
 * 本函数为纯函数（不依赖 db / config），便于单元测试与复用。
 */

export type ScoringMode = "block_total" | "per_question";

export type ScoringModeCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * 检查提交结构与题块配置的评分模式是否一致。
 *
 * @param scoringMode        题块配置的评分模式（已归一化为两个取值之一）
 * @param hasBlockTotalScore 前端是否提交了 blockTotalScore（有限数视为已提交，含 0；null/undefined/NaN 视为未提交）
 * @returns                  一致 → { ok: true }；不一致 → { ok: false, error: 用户可读的错误信息 }
 */
export function validateScoringModeConsistency(
  scoringMode: ScoringMode,
  hasBlockTotalScore: boolean
): ScoringModeCheckResult {
  // per_question 模式：禁止提交 blockTotalScore
  if (scoringMode === "per_question" && hasBlockTotalScore) {
    return {
      ok: false,
      error:
        "该题块配置为「逐题评分」模式，前端不应提交题块总分；请改用在线阅卷逐题输入，或将该题块评分模式改为「题块总分」"
    };
  }
  // block_total 模式：必须提交 blockTotalScore
  if (scoringMode === "block_total" && !hasBlockTotalScore) {
    return {
      ok: false,
      error:
        "该题块配置为「题块总分」模式，前端必须提交 blockTotalScore；请使用阅卷面板（GradePanel）输入合计分，或将该题块评分模式改为「逐题评分」"
    };
  }
  return { ok: true };
}
