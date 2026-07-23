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
  review_mode: number;
  has_half_point: number;
  auto_reassign_no_arb: number;
  workload_balance_threshold: number;
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
    reviewMode: row.review_mode as ReviewMode,
    hasHalfPoint: row.has_half_point ?? 0,
    autoReassignNoArb: row.auto_reassign_no_arb ?? 1,
    workloadBalanceThreshold: row.workload_balance_threshold ?? 4,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

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
    "SELECT * FROM block_grading_config WHERE exam_id = ? AND block_id = ?",
    examId,
    blockId
  ) as ConfigRow | undefined;

  if (row) return toConfig(row);

  // 不存在则返回默认值（不写入数据库）。v1.9.4 设置重构：优先采用本场考试的
  // 「网阅默认」模板（block_id='__default__'），让各考试可独立设定新建题块的默认策略。
  const def = await db.get(
    "SELECT * FROM block_grading_config WHERE exam_id = ? AND block_id = ?",
    examId,
    "__default__"
  ) as ConfigRow | undefined;

  const now = new Date().toISOString();
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
    createdAt: now,
    updatedAt: now
  };
}

/** 获取某考试所有题块配置 */
export async function getExamBlockConfigs(
  examId: number,
  db: DbAdapter = getMysqlDb()
): Promise<BlockGradingConfig[]> {
  const rows = await db.all(
    "SELECT * FROM block_grading_config WHERE exam_id = ? ORDER BY block_id",
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
  },
  db: DbAdapter = getMysqlDb()
): Promise<BlockGradingConfig> {
  const existing = await db.get(
    "SELECT id FROM block_grading_config WHERE exam_id = ? AND block_id = ?",
    examId,
    blockId
  ) as { id: number } | undefined;

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

    if (setClauses.length === 0) {
      const row = await db.get(
        "SELECT * FROM block_grading_config WHERE exam_id = ? AND block_id = ?",
        examId,
        blockId
      ) as ConfigRow;
      return toConfig(row);
    }

    setClauses.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(examId, blockId);

    await db.run(
      `UPDATE block_grading_config SET ${setClauses.join(", ")} WHERE exam_id = ? AND block_id = ?`,
      ...values
    );
  } else {
    await db.run(
      `INSERT INTO block_grading_config (exam_id, block_id, dispute_threshold, rounding, arbitrator_id, review_mode, has_half_point, auto_reassign_no_arb, workload_balance_threshold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      examId,
      blockId,
      updates.disputeThreshold ?? 2,
      updates.rounding ?? "ceil",
      updates.arbitratorId ?? null,
      updates.reviewMode ?? 1,
      updates.hasHalfPoint ?? 0,
      updates.autoReassignNoArb ?? 1,
      updates.workloadBalanceThreshold ?? 4
    );
  }

  const row = await db.get(
    "SELECT * FROM block_grading_config WHERE exam_id = ? AND block_id = ?",
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
  },
  db: DbAdapter = getMysqlDb()
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const blockId of blockIds) {
      await upsertBlockConfig(examId, blockId, updates, tx);
    }
  });
}
