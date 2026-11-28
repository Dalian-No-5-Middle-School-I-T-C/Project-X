import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { essayReviewIssue, loadEssayReviews, reviewUnitPredicate } from "./essayReview";
import { cropQuestionNumbers, isInsideDir } from "./AnswerBlockCropService";
import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { getBlockConfig, loadHalfPointRule } from "./BlockGradingConfigService";
import type { ArbitratorCandidate, ReviewImage } from "../../shared/types";
import type { ArbitrationDisputeItem, ArbitrationQuestionRule } from "../../shared/arbitration";
import { objectiveQuestionDefinitions } from "../../shared/grading";
import type { ScanBatchPage } from "../../shared/scanPages";
import { CardRepository } from "../repositories/CardRepository";
import { dataDir } from "../../apps/answer-card/server/storage";

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

/** Capability is independent of whether any disputed crop currently exists. */
export async function canArbitrate(
  examId: number,
  userId: number,
  db: DbAdapter = getMysqlDb()
): Promise<boolean> {
  const row = await db.get(
    "SELECT 1 AS allowed FROM block_grading_config WHERE exam_id=? AND arbitrator_id=? AND block_id<>'__default__' LIMIT 1",
    examId, userId
  );
  return Boolean(row);
}

type ArbitrationCropRow = {
  id: string;
  card_id: string;
  exam_id: number;
  student_id: number;
  student_number: string | null;
  block_id: string;
  page_number: number;
  source_type: string;
  source_record_id: string;
};

async function originalPageRows(db: DbAdapter, cropId: string): Promise<ArbitrationCropRow[]> {
  const crop = await db.get<ArbitrationCropRow>(
    "SELECT id,card_id,exam_id,student_id,student_number,block_id,page_number,source_type,source_record_id FROM answer_block_crops WHERE id=?",
    cropId
  );
  if (!crop || crop.exam_id == null || crop.student_id == null) return [];
  const block = await db.get<{ block_kind: string }>(
    "SELECT block_kind FROM subjective_blocks WHERE card_id=? AND id=?", crop.card_id, crop.block_id
  );
  if (block?.block_kind !== "essay") return [crop];
  const essays = await loadEssayReviews(db, Number(crop.exam_id), crop.block_id, Number(crop.student_id));
  const unit = essays.get(cropId);
  if (!unit || essayReviewIssue(unit, cropId)) return [];
  const ids = unit.images.map(image => image.id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.all<ArbitrationCropRow>(
    `SELECT id,card_id,exam_id,student_id,student_number,block_id,page_number,source_type,source_record_id
     FROM answer_block_crops WHERE id IN (${placeholders}) AND exam_id=? AND student_id=? AND card_id=? AND block_id=?`,
    ...ids, crop.exam_id, crop.student_id, crop.card_id, crop.block_id
  );
  return rows;
}

function safeOriginalFile(filePath: string | null): string | null {
  if (!filePath || !/\.(jpe?g|png|webp|bmp)$/i.test(filePath)) return null;
  const resolved = path.resolve(filePath);
  if (!isInsideDir(path.resolve(dataDir), resolved) || !existsSync(resolved)) return null;
  try {
    const realPath = realpathSync(resolved);
    return isInsideDir(path.resolve(dataDir), realPath) ? realPath : null;
  } catch {
    return null;
  }
}

/** Revalidate the crop's persisted exam/student binding and the exact source page. */
async function resolveOriginalPageFile(db: DbAdapter, crop: ArbitrationCropRow): Promise<string | null> {
  if (crop.source_type === "scan_record") {
    const row = await db.get<{ file_path: string | null }>(
      `SELECT r.file_path FROM scan_records r JOIN scan_batches b ON b.id=r.batch_id
       WHERE r.id=? AND r.student_id=? AND b.exam_id=? AND b.status IN ('done','partial')`,
      crop.source_record_id, crop.student_id, crop.exam_id
    );
    return row ? safeOriginalFile(row.file_path) : null;
  }
  if (crop.source_type !== "twain_scan_record") return null;
  const record = await db.get<{ id: string; card_id: string; session_id: string; student_id: string | null; page_num: number }>(
    "SELECT id,card_id,session_id,student_id,page_num FROM twain_scan_records WHERE id=?",
    crop.source_record_id
  );
  if (!record || record.card_id !== crop.card_id || record.student_id !== crop.student_number) return null;
  const receipts = await db.all<{ pages_json: string }>(
    "SELECT pages_json FROM scanner_submissions WHERE exam_id=? AND session_id=? AND student_number=? AND state='saved'",
    crop.exam_id, record.session_id, crop.student_number
  );
  const owned = receipts.some(receipt => {
    let pages: ScanBatchPage[] = [];
    try { pages = JSON.parse(receipt.pages_json) as ScanBatchPage[]; } catch { return false; }
    return pages.some(page => page.recordId === record.id
      && Number(page.layoutPage) === Number(crop.page_number)
      && Number(page.pageNum) === Number(record.page_num));
  });
  if (!owned) return null;
  const row = await db.get<{ image_path: string }>(
    "SELECT image_path FROM twain_scan_records WHERE id=? AND card_id=? AND session_id=? AND student_id=?",
    crop.source_record_id, record.card_id, record.session_id, record.student_id
  );
  return row ? safeOriginalFile(row.image_path) : null;
}

/** Return only source-verified page references; no record IDs or filesystem paths escape. */
export async function getArbitrationOriginalPages(
  db: DbAdapter,
  cropId: string
): Promise<Array<{ pageNumber: number; imageUrl: string }>> {
  const rows = await originalPageRows(db, cropId);
  const byPage = new Map<number, string | null>();
  for (const crop of rows) {
    const page = Number(crop.page_number);
    if (!Number.isInteger(page) || page < 1 || byPage.has(page)) continue;
    byPage.set(page, await resolveOriginalPageFile(db, crop));
  }
  return [...byPage.entries()]
    .filter((entry): entry is [number, string] => Boolean(entry[1]))
    .sort((a, b) => a[0] - b[0])
    .map(([pageNumber]) => ({
      pageNumber,
      imageUrl: `/api/review-arbitration/crops/${encodeURIComponent(cropId)}/original-pages/${pageNumber}/image`,
    }));
}

/** Resolve one page for the route; the caller still performs actor/arbitrator checks. */
export async function getArbitrationOriginalPageFile(
  db: DbAdapter,
  cropId: string,
  pageNumber: number
): Promise<string | null> {
  const rows = await originalPageRows(db, cropId);
  const crop = rows.find(row => Number(row.page_number) === pageNumber);
  return crop ? resolveOriginalPageFile(db, crop) : null;
}

/** 获取争议列表。调用方必须传入当前用户，不能由角色豁免指定仲裁人限制。 */
export async function getDisputes(
  examId: number,
  blockId: string | undefined,
  db: DbAdapter = getMysqlDb(),
  arbitratorId?: number
): Promise<ArbitrationDisputeItem[]> {
  let query = `
    SELECT abc.id AS crop_id, abc.card_id, abc.student_id, abc.student_number, u.name AS student_name,
           abc.block_id, abc.block_title, abc.page_number, abc.image_path, abc.status, abc.score_breakdown, abc.question_numbers,
           bgc.dispute_threshold, bgc.arbitrator_id,
           arb.name AS arbitrator_name
    FROM answer_block_crops abc
    JOIN users u ON u.id = abc.student_id
    LEFT JOIN block_grading_config bgc ON bgc.exam_id = abc.exam_id AND bgc.block_id = abc.block_id
    LEFT JOIN users arb ON arb.id = bgc.arbitrator_id
    WHERE abc.exam_id = ? AND abc.status = 'disputed' AND ${reviewUnitPredicate("abc")}
  `;
  const params: unknown[] = [examId];

  if (blockId) {
    query += " AND abc.block_id = ?";
    params.push(blockId);
  }
  if (arbitratorId != null) {
    query += " AND bgc.arbitrator_id = ?";
    params.push(arbitratorId);
  }
  query += " ORDER BY abc.student_number, abc.id";
  const rows = await db.all(query, ...params) as Array<{
    crop_id: string;
    card_id: string;
    question_numbers: string | Array<number | string>;
    student_id: number;
    student_number: string | null;
    student_name: string;
    block_id: string;
    block_title: string | null;
    page_number: number;
    image_path: string | null;
    status: string;
    score_breakdown: string | null;
    dispute_threshold: number | null;
    arbitrator_name: string | null;
  }>;
  if (!rows.length) return [];

  const essays = await loadEssayReviews(db, examId, blockId);
  const halfPointRule = await loadHalfPointRule(examId, db);
  const reviewerIds = new Set<number>();
  const breakdowns = new Map<string, Array<{ reviewerId?: number; reviewerName?: string; score: number }>>();
  for (const row of rows) {
    const breakdown: Array<{ reviewerId?: number; reviewerName?: string; score: number }> = [];
    if (row.score_breakdown) {
      try { breakdown.push(...JSON.parse(row.score_breakdown)); } catch { /* ignore corrupt JSON */ }
    }
    for (const entry of breakdown) if (entry.reviewerId != null) reviewerIds.add(entry.reviewerId);
    breakdowns.set(row.crop_id, breakdown);
  }
  const reviewerNames = new Map<number, string>();
  if (reviewerIds.size) {
    const ids = [...reviewerIds];
    const users = await db.all<{ id: number; name: string }>(
      `SELECT id,name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids
    );
    for (const user of users) reviewerNames.set(user.id, user.name || "评阅人");
  }

  const cards = new Map<string, Map<number, number>>();
  for (const cardId of new Set(rows.map(row => row.card_id))) {
    const card = await new CardRepository(db).findById(cardId);
    const definitions = new Map<number, number>();
    if (card) for (const block of card.bodyBlocks) {
      if (block.type === "objective") {
        for (const question of objectiveQuestionDefinitions(block)) definitions.set(question.questionNumber, question.score);
      } else {
        for (const question of block.questions) definitions.set(Number(question.number), question.score);
      }
    }
    cards.set(cardId, definitions);
  }
  const studentIds = [...new Set(rows.map(row => Number(row.student_id)))];
  const questionNumbers = [...new Set(rows.flatMap(row => cropQuestionNumbers(row.question_numbers)))];
  const previousMax = new Map<string, number>();
  if (studentIds.length && questionNumbers.length) {
    const marks = await db.all<{ student_id: number; question_number: number; max_score: number }>(
      `SELECT student_id,question_number,max_score FROM question_scores WHERE exam_id=? AND student_id IN (${studentIds.map(() => "?").join(",")})
       AND question_number IN (${questionNumbers.map(() => "?").join(",")})`,
      examId, ...studentIds, ...questionNumbers
    );
    for (const mark of marks) previousMax.set(`${Number(mark.student_id)}:${Number(mark.question_number)}`, Number(mark.max_score));
  }

  return Promise.all(rows.map(async row => {
    const essay = essays.get(row.crop_id);
    const issue = essayReviewIssue(essay, row.crop_id);
    const breakdown = breakdowns.get(row.crop_id) ?? [];
    const scores = breakdown.map(entry => ({
      reviewerName: entry.reviewerId != null
        ? reviewerNames.get(entry.reviewerId) ?? "评阅人"
        : entry.reviewerName?.trim() || "评阅人",
      score: Number(entry.score),
    }));
    const scoreDiff = scores.length >= 2 ? Math.max(...scores.map(s => s.score)) - Math.min(...scores.map(s => s.score)) : 0;
    const numbers = cropQuestionNumbers(row.question_numbers);
    const step = halfPointRule(row.block_id) ? 0.5 : 1;
    const definitions = cards.get(row.card_id) ?? new Map<number, number>();
    const questions: ArbitrationQuestionRule[] = numbers.map(number => ({
      number,
      maxScore: definitions.get(number) ?? previousMax.get(`${Number(row.student_id)}:${number}`) ?? 0,
      step,
    }));
    const originalPages = await getArbitrationOriginalPages(db, row.crop_id);
    const cropIssue = !issue && (!row.image_path || !existsSync(row.image_path)) ? "作答切图文件缺失，请恢复原图后再仲裁" : issue;
    const images: ReviewImage[] | undefined = essay && !issue ? essay.images : undefined;
    return {
      cropId: row.crop_id,
      cropImageUrl: `/api/answer-block-crops/${encodeURIComponent(row.crop_id)}/image`,
      reviewImages: images,
      reviewIssue: cropIssue,
      questionNumbers: numbers,
      questions,
      originalPages,
      studentName: row.student_name,
      studentNumber: row.student_number ?? "",
      blockId: row.block_id,
      blockTitle: row.block_title ?? row.block_id,
      scores,
      scoreDiff,
      threshold: row.dispute_threshold ?? 2,
      status: row.status === "disputed" ? "pending" as const : "arbitrated" as const,
      arbitratorName: row.arbitrator_name,
    };
  }));
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
