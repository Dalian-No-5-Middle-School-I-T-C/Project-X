import { databaseTimestamp } from "../db/timestamp";
import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import type { BlockGradingConfig, RoundingMode, ReviewMode } from "../../shared/types";

type ConfigRow = {
  id: number;
  exam_id: number;
  block_id: string;
  dispute_threshold: number;
  rounding: string;
  arbitrator_id: number | null;
  arbitrator_name?: string | null;
  review_mode: number;
  has_half_point: number;
  auto_reassign_no_arb: number;
  workload_balance_threshold: number;
  scoring_mode: string;
  score_distribution: string;
  created_at: string;
  updated_at: string;
};

function toConfig(row: ConfigRow): BlockGradingConfig {
  return {
    id: row.id,
    examId: row.exam_id,
    blockId: row.block_id,
    disputeThreshold: row.dispute_threshold,
    rounding: row.rounding as RoundingMode,
    arbitratorId: row.arbitrator_id,
    arbitratorName: row.arbitrator_name ?? null,
    reviewMode: row.review_mode as ReviewMode,
    hasHalfPoint: row.has_half_point ?? 0,
    autoReassignNoArb: row.auto_reassign_no_arb ?? 1,
    workloadBalanceThreshold: row.workload_balance_threshold ?? 4,
    scoringMode: row.scoring_mode ?? "block_total",
    scoreDistribution: row.score_distribution ?? "proportional",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const CONFIG_SELECT = `SELECT bgc.*, arb.name AS arbitrator_name
  FROM block_grading_config bgc
  LEFT JOIN users arb ON arb.id = bgc.arbitrator_id`;

/** 根据题块类型和满分推导默认分差阈值 */
export function defaultDisputeThreshold(blockKind: string, maxScore: number): number {
  if (blockKind === "essay") return 3;
  if (maxScore >= 10) return 2;
  return 1;
}

/** 根据题块类型推导默认取整方式 */
export function defaultRoundingMode(blockKind: string): RoundingMode {
  return blockKind === "essay" ? "half" : "ceil";
}

/** 获取或初始化题块配置 */
export async function getBlockConfig(
  examId: number,
  blockId: string,
  blockKind: string = "answer",
  maxScore: number = 0,
  db: DbAdapter = getMysqlDb()
): Promise<BlockGradingConfig> {
  const row = await db.get(
    `${CONFIG_SELECT} WHERE bgc.exam_id = ? AND bgc.block_id = ?`,
    examId,
    blockId
  ) as ConfigRow | undefined;

  if (row) return toConfig(row);

  // 不存在则返回默认值（不写入数据库）。v1.9.4 设置重构：优先采用本场考试的
  // 「网阅默认」模板（block_id='__default__'），让各考试可独立设定新建题块的默认策略。
  const def = await db.get(
    `${CONFIG_SELECT} WHERE bgc.exam_id = ? AND bgc.block_id = ?`,
    examId,
    "__default__"
  ) as ConfigRow | undefined;

  const now = databaseTimestamp();
  return {
    id: 0,
    examId,
    blockId,
    disputeThreshold: def ? def.dispute_threshold : defaultDisputeThreshold(blockKind, maxScore),
    rounding: def ? (def.rounding as RoundingMode) : defaultRoundingMode(blockKind),
    arbitratorId: null,
    reviewMode: def ? (def.review_mode as ReviewMode) ?? 1 : 1,
    hasHalfPoint: def ? def.has_half_point ?? 0 : 0,
    autoReassignNoArb: def ? def.auto_reassign_no_arb ?? 1 : 1,
    workloadBalanceThreshold: def ? def.workload_balance_threshold ?? 4 : 4,
    scoringMode: def ? def.scoring_mode ?? "block_total" : "block_total",
    scoreDistribution: def ? def.score_distribution ?? "proportional" : "proportional",
    createdAt: now,
    updatedAt: now
  };
}

/** Resolve the score pad's half-point setting for multiple blocks in one query. */
export async function loadHalfPointRule(examId: number, db: DbAdapter): Promise<(blockId: string) => number> {
  const rows = await db.all<{ block_id: string; has_half_point: number | null }>(
    "SELECT block_id, has_half_point FROM block_grading_config WHERE exam_id=?", examId);
  const values = new Map(rows.map(row => [row.block_id, Number(row.has_half_point ?? 0)]));
  const examDefault = values.get("__default__") ?? 0;
  return blockId => values.get(blockId) ?? examDefault;
}

/** 获取某考试所有题块配置 */
export async function getExamBlockConfigs(
  examId: number,
  db: DbAdapter = getMysqlDb()
): Promise<BlockGradingConfig[]> {
  const rows = await db.all(
    `${CONFIG_SELECT} WHERE bgc.exam_id = ? ORDER BY bgc.block_id`,
    examId
  ) as ConfigRow[];
  return rows.map(toConfig);
}

/** 更新单题块配置 */
export async function upsertBlockConfig(
  examId: number,
  blockId: string,
  updates: {
    disputeThreshold?: number;
    rounding?: RoundingMode;
    arbitratorId?: number | null;
    reviewMode?: ReviewMode;
    /** 本题块是否允许 0.5 小数（0/1） */
    hasHalfPoint?: number;
    /** 未设仲裁人时是否自动工作量均衡再分配（0/1） */
    autoReassignNoArb?: number;
    /** 工作量均衡阈值（份数差上限） */
    workloadBalanceThreshold?: number;
    /** 题块评分模式 block_total / per_question */
    scoringMode?: string;
    /** 题块总分拆分策略 proportional / equal */
    scoreDistribution?: string;
  },
  db: DbAdapter = getMysqlDb()
): Promise<BlockGradingConfig> {
  const existing = await db.get(
    "SELECT id FROM block_grading_config WHERE exam_id = ? AND block_id = ?",
    examId,
    blockId
  ) as { id: number } | undefined;

  // 校验评分模式 / 拆分策略枚举，避免写入非法值
  if (
    updates.scoringMode !== undefined &&
    updates.scoringMode !== "block_total" &&
    updates.scoringMode !== "per_question"
  ) {
    throw new Error(`scoringMode 取值非法：${updates.scoringMode}（仅允许 block_total / per_question）`);
  }
  if (
    updates.scoreDistribution !== undefined &&
    updates.scoreDistribution !== "proportional" &&
    updates.scoreDistribution !== "equal"
  ) {
    throw new Error(`scoreDistribution 取值非法：${updates.scoreDistribution}（仅允许 proportional / equal）`);
  }
  if (
    updates.disputeThreshold !== undefined &&
    (!Number.isFinite(updates.disputeThreshold) || updates.disputeThreshold < 0)
  ) {
    throw new Error(`disputeThreshold 取值非法：${updates.disputeThreshold}（须为不小于 0 的数字）`);
  }

  if (existing) {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.disputeThreshold !== undefined) {
      setClauses.push("dispute_threshold = ?");
      values.push(updates.disputeThreshold);
    }
    if (updates.rounding !== undefined) {
      setClauses.push("rounding = ?");
      values.push(updates.rounding);
    }
    if (updates.arbitratorId !== undefined) {
      setClauses.push("arbitrator_id = ?");
      values.push(updates.arbitratorId);
    }
    if (updates.reviewMode !== undefined) {
      setClauses.push("review_mode = ?");
      values.push(updates.reviewMode);
    }
    if (updates.hasHalfPoint !== undefined) {
      setClauses.push("has_half_point = ?");
      values.push(updates.hasHalfPoint);
    }
    if (updates.autoReassignNoArb !== undefined) {
      setClauses.push("auto_reassign_no_arb = ?");
      values.push(updates.autoReassignNoArb);
    }
    if (updates.workloadBalanceThreshold !== undefined) {
      setClauses.push("workload_balance_threshold = ?");
      values.push(updates.workloadBalanceThreshold);
    }
    if (updates.scoringMode !== undefined) {
      setClauses.push("scoring_mode = ?");
      values.push(updates.scoringMode);
    }
    if (updates.scoreDistribution !== undefined) {
      setClauses.push("score_distribution = ?");
      values.push(updates.scoreDistribution);
    }

    if (setClauses.length === 0) {
      const row = await db.get(
        `${CONFIG_SELECT} WHERE bgc.exam_id = ? AND bgc.block_id = ?`,
        examId,
        blockId
      ) as ConfigRow;
      return toConfig(row);
    }

    setClauses.push("updated_at = ?");
    values.push(databaseTimestamp());
    values.push(examId, blockId);

    await db.run(
      `UPDATE block_grading_config SET ${setClauses.join(", ")} WHERE exam_id = ? AND block_id = ?`,
      ...values
    );
  } else {
    // 未建行时先取本场「网阅默认」：批量修改只提交被改字段，其余字段必须继承
    // __default__，不能被写死成 2 / ceil / 1 / 0 这类常量而悄悄破坏考试默认配置。
    const def = blockId === "__default__"
      ? undefined
      : await db.get(
        `${CONFIG_SELECT} WHERE bgc.exam_id = ? AND bgc.block_id = ?`,
        examId,
        "__default__"
      ) as ConfigRow | undefined;
    await db.run(
      `INSERT INTO block_grading_config (exam_id, block_id, dispute_threshold, rounding, arbitrator_id, review_mode, has_half_point, auto_reassign_no_arb, workload_balance_threshold, scoring_mode, score_distribution)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      examId,
      blockId,
      updates.disputeThreshold ?? def?.dispute_threshold ?? 2,
      updates.rounding ?? (def?.rounding as RoundingMode | undefined) ?? "ceil",
      updates.arbitratorId !== undefined ? updates.arbitratorId : null,
      updates.reviewMode ?? (def?.review_mode as ReviewMode | undefined) ?? 1,
      updates.hasHalfPoint ?? def?.has_half_point ?? 0,
      updates.autoReassignNoArb ?? def?.auto_reassign_no_arb ?? 1,
      updates.workloadBalanceThreshold ?? def?.workload_balance_threshold ?? 4,
      updates.scoringMode ?? def?.scoring_mode ?? "block_total",
      updates.scoreDistribution ?? def?.score_distribution ?? "proportional"
    );
  }

  const row = await db.get(
    `${CONFIG_SELECT} WHERE bgc.exam_id = ? AND bgc.block_id = ?`,
    examId,
    blockId
  ) as ConfigRow;
  return toConfig(row);
}

/** 批量更新题块配置 */
export async function batchUpdateConfigs(
  examId: number,
  blockIds: string[],
  updates: {
    disputeThreshold?: number;
    rounding?: RoundingMode;
    arbitratorId?: number | null;
    reviewMode?: ReviewMode;
    hasHalfPoint?: number;
    autoReassignNoArb?: number;
    workloadBalanceThreshold?: number;
    scoringMode?: string;
    scoreDistribution?: string;
  },
  db: DbAdapter = getMysqlDb()
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const blockId of blockIds) {
      await upsertBlockConfig(examId, blockId, updates, tx);
    }
  });
}
