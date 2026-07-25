/**
 * 客户端评分模式三态（PR #189 二次修复）
 *
 * 背景：OnlineReviewPanel 之前在配置加载失败时直接按 block_total 处理，
 * 这是「安全失败」策略——但与管理界面无法切换模式叠加，会形成硬锁死
 * （网络抖动一下，老师就再也提交不了分数）。
 *
 * 改法：把客户端可见的评分模式从二态（block_total/per_question）扩为三态：
 *   - "block_total"  → 配置明确读到 block_total，红色横幅 + 禁用提交
 *   - "per_question"  → 配置明确读到 per_question，正常提交
 *   - "unknown"       → 配置加载失败，黄色警告 + 保持提交可用（服务端兜底）
 *
 * "配置缺失但响应成功"和"配置缺失且响应失败"是两个完全不同的状态：
 *   - 前者是合法的"未配置"，回退到 block_total（与后端 getBlockConfig 行为一致）
 *   - 后者是异常，必须走 unknown 路径
 */

export type ClientScoringMode = "block_total" | "per_question" | "unknown";

export type ConfigFetchResult =
  | { kind: "ok"; scoringMode: string | undefined }
  | { kind: "config-missing" }       // HTTP 200 但 scoringMode 字段为空（合法未配置）
  | { kind: "fetch-failed"; error: string };  // 网络/服务异常

export interface ScoringModeResolution {
  mode: ClientScoringMode;
  /** 仅在 fetch-failed 时有值，用于 UI 显示具体原因 */
  configLoadError: string | null;
}

/**
 * 把后端响应 + fetch 结果归一为三态评分模式。
 */
export function resolveScoringMode(result: ConfigFetchResult): ScoringModeResolution {
  switch (result.kind) {
    case "ok":
      // 明确读到配置 → 严格按配置走；非法值回落 block_total（与 BlockGradingConfigService 行为一致）
      return {
        mode: result.scoringMode === "per_question" ? "per_question" : "block_total",
        configLoadError: null
      };
    case "config-missing":
      // 合法的"未配置" → 与后端 getBlockConfig 回退逻辑一致
      return { mode: "block_total", configLoadError: null };
    case "fetch-failed":
      // 异常 → unknown，让服务端校验兜底，避免前端硬锁死
      return { mode: "unknown", configLoadError: result.error };
  }
}

/**
 * 校验 block_total 模式下提交项的题号覆盖情况
 *
 * 设计背景：原 ReviewService 用 Set 检查题号覆盖，但没检查 params.scores 自身
 * 是否有重复题号。当客户端提交 [1,1,2] 时：
 *   - Set 检查认为 1、2 都覆盖 → 校验通过（错误）
 *   - submittedScores 数组保留两个 #1
 *   - totalScore 把第 1 题算两次（虚高）
 *   - scoreBreakdown.questionScores 去重后只保留一个 #1，
 *     与 scoreBreakdown.score 之和不一致 → 后续争议/排名计算全错
 *
 * 本函数要求「题号集合严格相等」，且每题只允许出现一次。
 */
export function validateBlockTotalCoverage(
  authoritativeNums: number[],
  submittedItems: { questionNumber: number }[]
): ScoringModeCheckResult {
  // 1) 空数组：必须至少提交一道题
  if (submittedItems.length === 0) {
    return {
      ok: false,
      error: "题块总分模式至少需要提交一道小题的分数项"
    };
  }

  const submittedNums = submittedItems.map((s) => s.questionNumber);
  const submittedSet = new Set(submittedNums);

  // 2) 重复题号：Set 大小 < 数组长度
  if (submittedSet.size !== submittedNums.length) {
    const seen = new Set<number>();
    const dups: number[] = [];
    for (const n of submittedNums) {
      if (seen.has(n) && !dups.includes(n)) dups.push(n);
      seen.add(n);
    }
    return {
      ok: false,
      error: `题块总分模式提交了重复题号：${dups.join("、")}（每题只允许出现一次）`
    };
  }

  // 3) 数量必须完全一致（先按数量筛，再按题号筛，错误信息更精准）
  if (submittedSet.size !== authoritativeNums.length) {
    return {
      ok: false,
      error: `题块总分模式提交项数（${submittedSet.size}）与本题块权威题数（${authoritativeNums.length}）不一致`
    };
  }

  // 4) 题号集合必须完全相等
  const authSet = new Set(authoritativeNums);
  for (const n of submittedSet) {
    if (!authSet.has(n)) {
      return {
        ok: false,
        error: `题块总分模式提交了不属于本题块的第${n}题`
      };
    }
  }
  for (const n of authSet) {
    if (!submittedSet.has(n)) {
      return {
        ok: false,
        error: `题块总分模式缺少第${n}题的分数项`
      };
    }
  }

  return { ok: true };
}

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
