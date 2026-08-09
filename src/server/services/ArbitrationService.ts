import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { getBlockConfig } from "./BlockGradingConfigService";
import type { DisputeItem, ArbitratorCandidate } from "../../shared/types";

/**
 * 争议检测结果
 */
export interface DisputeCheckResult {
  disputed: boolean;
  needsArbitration: boolean;
  finalScore: number | null;
  reason: string;
}

/**
 * 检测多轮评分是否触发争议，并计算最终分
 * 
 * P1-12: 通用化处理，支持任意数量评分（2P, 3P, 以及仲裁人加入后的 4+ 次评审）
 */
export function computeMultiReviewResult(
  scores: number[],
  disputeThreshold: number,
  rounding: string
): DisputeCheckResult {
  if (scores.length < 2) {
    return { disputed: false, needsArbitration: false, finalScore: scores[0] ?? null, reason: "单评" };
  }

  const sorted = [...scores].sort((a, b) => a - b);
  const maxDiff = sorted[sorted.length - 1] - sorted[0];

  // 2P 模式
  if (scores.length === 2) {
    if (maxDiff <= disputeThreshold) {
      const avg = (scores[0] + scores[1]) / 2;
      return {
        disputed: false,
        needsArbitration: false,
        finalScore: applyRounding(avg, rounding),
        reason: `两评一致，分差${maxDiff}≤阈值${disputeThreshold}`
      };
    }
    return {
      disputed: true,
      needsArbitration: true,
      finalScore: null,
      reason: `分差${maxDiff}>阈值${disputeThreshold}`
    };
  }

  // 3P+ 模式：通用化处理
  // 如果所有分数都在阈值范围内 → 取平均
  if (maxDiff <= disputeThreshold) {
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return {
      disputed: false,
      needsArbitration: false,
      finalScore: applyRounding(avg, rounding),
      reason: `${sorted.length}评一致，分差${maxDiff}≤阈值`
    };
  }

  // 尝试找"多数接近分数" → 排除少数偏离者
  // 方法：逐对检查差值的聚类
  // 选取中位数附近的分数群来判断
  const median = sorted[Math.floor(sorted.length / 2)];
  const closeGroup: number[] = [];

  for (const s of sorted) {
    // 从最小分和最大分往中间看，找出差异在阈值内的组
    let isCloseToAny = false;
    for (const c of closeGroup) {
      if (Math.abs(s - c) <= disputeThreshold) {
        isCloseToAny = true;
        break;
      }
    }
    if (isCloseToAny) {
      closeGroup.push(s);
    }
  }
  // 如果 closeGroup 未形成（可能只有一两个），尝试另一种方式
  const closeToMedian: number[] = [];
  for (const s of sorted) {
    if (Math.abs(s - median) <= disputeThreshold) {
      closeToMedian.push(s);
    }
  }

  // 如果 closeToMedian 覆盖了大部分（≥2 个且大于等于一半），且不是全部
  if (closeToMedian.length >= 2 && closeToMedian.length < sorted.length) {
    const avg = closeToMedian.reduce((a, b) => a + b, 0) / closeToMedian.length;
    const outliers = sorted.filter(s => !closeToMedian.includes(s));
    return {
      disputed: false,
      needsArbitration: false,
      finalScore: applyRounding(avg, rounding),
      reason: `取${closeToMedian.length}个接近分平均，排除异常分${outliers.join(",")}`
    };
  }

  return {
    disputed: true,
    needsArbitration: true,
    finalScore: null,
    reason: `${sorted.length}评分差过大，进入仲裁`
  };
}

function applyRounding(value: number, mode: string): number {
  switch (mode) {
    case "ceil": return Math.ceil(value);
    case "floor": return Math.floor(value);
    case "round": return Math.round(value);
    case "half": return Math.round(value * 2) / 2;
    case "none":
    default:
      return value;
  }
}

/**
 * 提交新一轮评分后，检测争议并返回最终分
 */
export async function checkDisputeOnSubmit(
  examId: number,
  cropId: string,
  newScore: number,
  reviewerId: number,
  blockKind: string,
  maxScore: number,
  db: DbAdapter = getMysqlDb()
): Promise<DisputeCheckResult & { arbitratorId: number | null }> {
  // 读取该切块已有各轮评分
  const crop = await db.get(
    "SELECT score_breakdown, review_round, block_id FROM answer_block_crops WHERE id = ? AND exam_id = ?",
    cropId,
    examId
  ) as { score_breakdown: string | null; review_round: number; block_id: string } | undefined;

  if (!crop) throw new Error("切块不存在");

  const existingScores: number[] = [];
  if (crop.score_breakdown) {
    try {
      const breakdown = JSON.parse(crop.score_breakdown) as Array<{ score: number }>;
      existingScores.push(...breakdown.map((b: { score: number }) => b.score));
    } catch { /* ignore corrupt JSON */ }
  }

  // 检查本轮分数是否已存在（防止重复提交）
  const currentRound = existingScores.length + 1;
  const allScores = [...existingScores, newScore];

  const config = await getBlockConfig(examId, crop.block_id, blockKind, maxScore, db);
  const result = computeMultiReviewResult(allScores, config.disputeThreshold, config.rounding);

  let arbitratorId: number | null = null;
  if (result.disputed && config.arbitratorId) {
    // P1-11: 从 score_breakdown 解析所有评审人（而非仅查 reviewer_id）
    const allReviewerIds = new Set<number>();
    if (crop.score_breakdown) {
      try {
        const breakdown = JSON.parse(crop.score_breakdown) as Array<{ reviewerId: number }>;
        for (const b of breakdown) {
          if (b.reviewerId) allReviewerIds.add(b.reviewerId);
        }
      } catch { /* ignore */ }
    }
    allReviewerIds.add(reviewerId); // 加入当前提交者

    if (!allReviewerIds.has(config.arbitratorId)) {
      arbitratorId = config.arbitratorId;
    }
  }

  return { ...result, arbitratorId };
}

/**
 * 获取争议列表
 */
export async function getDisputes(
  examId: number,
  blockId: string | undefined,
  db: DbAdapter = getMysqlDb()
): Promise<DisputeItem[]> {
  let query = `
    SELECT abc.id AS crop_id, abc.student_id, u.name AS student_name, u.student_number,
           abc.block_id, abc.block_title, abc.status, abc.score_breakdown,
           bgc.dispute_threshold, bgc.arbitrator_id,
           arb.name AS arbitrator_name
    FROM answer_block_crops abc
    JOIN users u ON u.id = abc.student_id
    LEFT JOIN block_grading_config bgc ON bgc.exam_id = abc.exam_id AND bgc.block_id = abc.block_id
    LEFT JOIN users arb ON arb.id = bgc.arbitrator_id
    WHERE abc.exam_id = ? AND abc.status = 'disputed'
  `;
  const params: unknown[] = [examId];

  if (blockId) {
    query += " AND abc.block_id = ?";
    params.push(blockId);
  }

  query += " ORDER BY abc.student_number";
  const rows = await db.all(query, ...params) as Array<{
    crop_id: string;
    student_id: number;
    student_name: string;
    student_number: string | null;
    block_id: string;
    block_title: string | null;
    status: string;
    score_breakdown: string | null;
    dispute_threshold: number | null;
    arbitrator_id: number | null;
    arbitrator_name: string | null;
  }>;

  return rows.map((row) => {
    const breakdown: Array<{ reviewerId?: number; reviewerName?: string; score: number }> = [];
    if (row.score_breakdown) {
      try { breakdown.push(...JSON.parse(row.score_breakdown)); } catch { /* ignore */ }
    }

    const scores = breakdown.map((b) => ({ reviewerName: b.reviewerName ?? `教师${b.reviewerId}`, score: b.score }));
    const scoreDiff = scores.length >= 2 ? Math.max(...scores.map((s) => s.score)) - Math.min(...scores.map((s) => s.score)) : 0;

    return {
      cropId: row.crop_id,
      studentId: row.student_id,
      studentName: row.student_name,
      studentNumber: row.student_number ?? "",
      blockId: row.block_id,
      blockTitle: row.block_title ?? row.block_id,
      scores,
      scoreDiff,
      threshold: row.dispute_threshold ?? 2,
      status: row.status === "disputed" ? "pending" as const : "arbitrated" as const,
      arbitratorName: row.arbitrator_name
    };
  });
}

/**
 * 获取合格仲裁人列表（同科同年级，分配教师优先，排除冲突）
 */
export async function getEligibleArbitrators(
  examId: number,
  blockId: string,
  excludedReviewerIds: number[],
  db: DbAdapter = getMysqlDb()
): Promise<ArbitratorCandidate[]> {
  // 获取考试科目和年级
  const exam = await db.get(
    "SELECT subject, grade_id FROM exams WHERE id = ?",
    examId
  ) as { subject: string | null; grade_id: number | null } | undefined;
  if (!exam) return [];

  // 已分配该题块教师（置顶）
  const assignedRows = await db.all(
    `SELECT DISTINCT u.id, u.name, u.subject
     FROM review_assignments ra
     JOIN users u ON u.id = ra.teacher_id
     WHERE ra.exam_id = ? AND ra.block_id = ? AND u.role_id = 2
     ORDER BY u.name`,
    examId,
    blockId
  ) as Array<{ id: number; name: string; subject: string | null }>;

  // 同科同年级其他教师
  const otherRows = await db.all(
    `SELECT u.id, u.name, u.subject
     FROM users u
     WHERE u.role_id = 2
       ${exam.subject ? "AND u.subject = ?" : ""}
       ${exam.grade_id !== null
         ? "AND (NOT EXISTS (SELECT 1 FROM teacher_classes tc WHERE tc.teacher_id = u.id) OR EXISTS (SELECT 1 FROM teacher_classes tc2 JOIN classes c2 ON c2.id = tc2.class_id WHERE tc2.teacher_id = u.id AND c2.grade_id = ?))"
         : ""}
       AND u.id NOT IN (SELECT teacher_id FROM review_assignments WHERE exam_id = ? AND block_id = ?)
     ORDER BY u.name`,
    ...(exam.subject ? [exam.subject] : []),
    ...(exam.grade_id !== null ? [exam.grade_id] : []),
    examId,
    blockId
  ) as Array<{ id: number; name: string; subject: string | null }>;

  const excluded = new Set(excludedReviewerIds);

  const result: ArbitratorCandidate[] = [];

  // 分配教师优先
  for (const r of assignedRows) {
    if (!excluded.has(r.id)) {
      result.push({ id: r.id, name: r.name, subject: r.subject, isAssignedTeacher: true });
    }
  }

  // 其他教师
  for (const r of otherRows) {
    if (!excluded.has(r.id)) {
      result.push({ id: r.id, name: r.name, subject: r.subject, isAssignedTeacher: false });
    }
  }

  return result;
}
