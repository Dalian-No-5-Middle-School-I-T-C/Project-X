import { essayReviewIssue, loadEssayReviews } from "../services/essayReview";
import { databaseTimestamp } from "../db/timestamp";
/**
 * 争议仲裁 API
 * 挂载点: /api/review-arbitration
 */
import { Router } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess, getVisibleExamIds, isExamSoftDeleted } from "../../apps/answer-card/server/middleware";
import {
  canArbitrate,
  getArbitrationOriginalPageFile,
  getDisputes,
  getEligibleArbitrators,
} from "../services/ArbitrationService";
import { getMysqlDb, buildUpsertSQL } from "../db";
import { recomputeExamRankings, roundScore } from "../services/rankingUpdate";
import { getBlockConfig, loadHalfPointRule } from "../services/BlockGradingConfigService";
import { markScoreMutated } from "../services/examPublishEvents";

import { cropQuestionNumbers } from "../services/AnswerBlockCropService";
import { CardRepository } from "../repositories/CardRepository";
import { objectiveQuestionDefinitions } from "../../shared/grading";
import { validateArbitrationScores } from "../../shared/arbitration";

const router = Router();
class ArbitrationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// GET /api/review-arbitration/exams/:examId/disputes — 争议列表
router.get(
  "/exams/:examId/disputes",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const blockId = typeof req.query.blockId === "string" ? req.query.blockId : undefined;
      const db = getMysqlDb();
      const [disputes, allowed] = await Promise.all([
        getDisputes(examId, blockId, db, req.user!.id),
        canArbitrate(examId, req.user!.id, db),
      ]);
      res.json({ ok: true, data: disputes, canArbitrate: allowed });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// GET /api/review-arbitration/crops/:cropId/original-pages/:pageNumber/image
// This is a page-specific dispute view, not a whole-paper reader or a wholePaperRead bypass.
router.get(
  "/crops/:cropId/original-pages/:pageNumber/image",
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const db = getMysqlDb();
      const cropId = String(req.params.cropId ?? "");
      const pageNumber = Number(req.params.pageNumber);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new ArbitrationError(400, "原卷页码无效");
      const crop = await db.get<{ exam_id: number; block_id: string; status: string }>(
        "SELECT exam_id,block_id,status FROM answer_block_crops WHERE id=?", cropId
      );
      if (!crop || await isExamSoftDeleted(Number(crop.exam_id))) throw new ArbitrationError(404, "争议卷不存在");
      const visibleExamIds = await getVisibleExamIds(req.user);
      if (visibleExamIds !== null && !visibleExamIds.includes(Number(crop.exam_id))) {
        throw new ArbitrationError(403, "权限不足：无权访问此考试");
      }
      if (crop.status !== "disputed") throw new ArbitrationError(409, "该争议已处理，请刷新列表");
      const config = await getBlockConfig(Number(crop.exam_id), crop.block_id, "subjective", 0, db);
      if (config.arbitratorId !== req.user!.id) {
        throw new ArbitrationError(403, "仅当前争议的指定仲裁人可查看对应原卷页");
      }
      const imagePath = await getArbitrationOriginalPageFile(db, cropId, pageNumber);
      if (!imagePath) throw new ArbitrationError(404, "该争议未绑定此原卷页");
      res.setHeader("Cache-Control", "private, no-store");
      res.sendFile(imagePath);
    } catch (err: any) {
      if (res.headersSent) return;
      res.status(err instanceof ArbitrationError ? err.status : 500).json({ ok: false, error: err.message });
    }
  }
);

// GET /api/review-arbitration/exams/:examId/blocks/:blockId/arbitrators — 合格仲裁人列表
router.get(
  "/exams/:examId/blocks/:blockId/arbitrators",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const excludedIds = req.query.excludedReviewerIds
        ? String(req.query.excludedReviewerIds).split(",").map(Number)
        : [];

      const candidates = await getEligibleArbitrators(examId, String(req.params.blockId ?? ""), excludedIds);
      res.json({ ok: true, data: candidates });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// POST /api/review-arbitration/crops/:cropId/resolve — 仲裁人提交最终分
router.post(
  "/crops/:cropId/resolve",
  requirePermission(PERMISSIONS.GRADE_WRITE),
  async (req, res) => {
    try {
      const db = getMysqlDb();
      const cropId = String(req.params.cropId ?? "");
      const { score, questionScores } = req.body ?? {};
      const userId = req.user!.id;

      const now = databaseTimestamp();

      // P0-3: 全部操作在事务内执行，含 CAS 并发保护
      const outcome = await db.transaction(async (tx) => {
        // Acquire the same exam lock as scanner/correction before the first snapshot read.
        await tx.run(`UPDATE exams SET id=id WHERE id=(
          SELECT a.exam_id FROM answer_block_crops a JOIN subjective_blocks b
          ON b.card_id=a.card_id AND b.id=a.block_id AND b.block_kind='essay' WHERE a.id=?
        )`, cropId);
        const crop = await tx.get(
          "SELECT * FROM answer_block_crops WHERE id = ?",
          cropId
        ) as any;
        if (!crop) throw new ArbitrationError(404, "切块不存在");
        if (await isExamSoftDeleted(Number(crop.exam_id))) throw new ArbitrationError(404, "切块不存在");

        // cropId 路由没有 examId 参数，必须在此补上考试可见性校验，避免跨考试仲裁。
        const visibleExamIds = await getVisibleExamIds(req.user);
        if (visibleExamIds !== null && !visibleExamIds.includes(Number(crop.exam_id))) {
          throw new ArbitrationError(403, "权限不足：无权访问此考试");
        }

        const config = await getBlockConfig(
          Number(crop.exam_id), String(crop.block_id ?? ""), String(crop.block_type ?? "subjective"), 0, tx
        );
        if (config.arbitratorId == null) throw new ArbitrationError(409, "该题块未指定仲裁人，不能直接仲裁");
        if (config.arbitratorId !== userId) throw new ArbitrationError(403, "仅指定仲裁人可以提交最终分");
        // Resolve the terminal state before parsing a new ballot so retries remain a 409.
        if (crop.status !== "disputed") throw new ArbitrationError(409, "该切块已被其他仲裁人处理，请刷新后重试");

        const questionNumbers = cropQuestionNumbers(crop.question_numbers);
        const card = await new CardRepository(tx).findById(crop.card_id);
        const block = card?.bodyBlocks.find(item => item.id === crop.block_id);
        if (block?.type === "subjective" && block.blockKind === "essay") {
          const essays = await loadEssayReviews(tx, crop.exam_id, crop.block_id, crop.student_id);
          const unit = essays.get(cropId);
          const issue = unit ? essayReviewIssue(unit, cropId) : "作文切图归属已变更";
          if (issue) throw new ArbitrationError(409, issue);
        }
        const definitions = new Map<number, number>();
        if (block?.type === "objective") {
          for (const q of objectiveQuestionDefinitions(block)) definitions.set(q.questionNumber, q.score);
        } else if (block?.type === "subjective") {
          for (const q of block.questions) definitions.set(Number(q.number), q.score);
        }
        const halfPointRule = await loadHalfPointRule(Number(crop.exam_id), tx);
        const entries: Array<{ number: number; max: number; type: string; options: string | null; value: number }> = [];
        const rules = [];
        for (const number of questionNumbers) {
          const previous = await tx.get<{ max_score: number; score_type: string; selected_options: string | null }>(
            "SELECT max_score, score_type, selected_options FROM question_scores WHERE exam_id=? AND student_id=? AND question_number=?",
            crop.exam_id, crop.student_id, number
          );
          // Current card definitions are authoritative; the old mark is only a
          // compatibility fallback for legacy crops whose block was removed.
          const max = definitions.get(number) ?? previous?.max_score;
          if (max == null || !Number.isFinite(Number(max)) || Number(max) < 0) {
            throw new ArbitrationError(400, `无法确认第${number}题的权威满分`);
          }
          rules.push({ number, maxScore: Number(max), step: halfPointRule(String(crop.block_id)) ? 0.5 : 1 });
          entries.push({
            number,
            value: 0,
            max: Number(max),
            type: previous?.score_type ?? (block?.type === "objective" ? "objective" : "subjective"),
            options: previous?.selected_options ?? null,
          });
        }
        if (questionScores != null && score != null) {
          throw new ArbitrationError(400, "questionScores 与单一 score 不能同时提交");
        }
        const inputScores = questionScores != null
          ? questionScores
          : questionNumbers.length === 1 ? { [String(questionNumbers[0])]: Number(score) } : null;
        const validated = validateArbitrationScores(questionNumbers, rules, inputScores);
        if (!validated.ok) throw new ArbitrationError(400, validated.error);
        for (const entry of entries) entry.value = validated.values[String(entry.number)];
        const total = roundScore(entries.reduce((sum, entry) => sum + entry.value, 0));

        // CAS 保护: 使用 status + review_round 作为乐观锁
        const currentReviewRound = crop.review_round ?? 0;

        // 检查仲裁人是否已参与该卷评审
        const existingBreakdown = crop.score_breakdown ? JSON.parse(crop.score_breakdown) : [];
        const reviewerIds = new Set(existingBreakdown.map((b: any) => b.reviewerId));
        if (reviewerIds.has(userId)) {
          throw new ArbitrationError(409, "仲裁人已是该卷评审人之一，无法仲裁");
        }

        // 记录仲裁分数
        existingBreakdown.push({
          round: existingBreakdown.length + 1,
          reviewerId: userId,
          score: total,
          questionScores: Object.fromEntries(entries.map(entry => [entry.number, entry.value])),
          reviewedAt: now
        });

        // CAS 更新 answer_block_crops
        const casResult = await tx.run(
          `UPDATE answer_block_crops
           SET status = 'reviewed', final_score = ?, final_score_by = ?, review_round = ?,
               score_breakdown = ?, reviewed_at = ?
           WHERE id = ? AND review_round = ? AND status = 'disputed'`,
          total,
          userId,
          existingBreakdown.length,
          JSON.stringify(existingBreakdown),
          now,
          cropId,
          currentReviewRound
        );

        if (casResult.changes === 0) {
          throw new ArbitrationError(409, "该切块已被其他仲裁人处理，请刷新后重试");
        }

        // 同时写入 question_scores（使用正确的 max_score）
        // Bugfix: 使用 buildUpsertSQL 保证跨平台兼容（SQLite + MariaDB）；
        //         保留 selected_options 列避免仲裁覆写时丢失选项数据。
        const upsertQsSQL = buildUpsertSQL(
          db.dialect, "question_scores",
          ["exam_id", "student_id", "question_number", "score", "max_score", "score_type", "selected_options", "manually_modified", "modified_by", "modified_at"],
          ["exam_id", "student_id", "question_number", "score_type"],
          ["score", "max_score", "selected_options", "manually_modified", "modified_by", "modified_at"]
        );
        for (const entry of entries) {
          await tx.run(upsertQsSQL, crop.exam_id, crop.student_id, entry.number, entry.value,
            entry.max, entry.type, entry.options, 1, userId, now);
        }

        // Bugfix: 仲裁后必须重算学生总分（之前仅重算排名，总分仍为旧值）
        const scoreRows = await tx.all(
          "SELECT score, score_type FROM question_scores WHERE exam_id = ? AND student_id = ?",
          crop.exam_id, crop.student_id
        ) as Array<{ score: number; score_type: string }>;
        let totalObj = 0, totalSubj = 0;
        for (const s of scoreRows) {
          if (s.score_type === "objective") totalObj += Number(s.score);
          else totalSubj += Number(s.score);
        }
        totalObj = roundScore(totalObj);
        totalSubj = roundScore(totalSubj);
        const newTotal = roundScore(totalObj + totalSubj);
        await tx.run(
          `UPDATE student_scores SET objective_score = ?, subjective_score = ?, total_score = ?,
            manually_modified = 1, modified_by = ?, modified_at = ?
           WHERE exam_id = ? AND student_id = ?`,
          totalObj, totalSubj, newTotal, userId, now, crop.exam_id, crop.student_id
        );
        // 评审 P1：仲裁写入最终分属于成绩变更 → 同一事务内按管理员策略处理公布状态
        await markScoreMutated(tx, Number(crop.exam_id), userId, "arbitration");
        return { examId: Number(crop.exam_id), total };
      });

      await recomputeExamRankings(db, outcome.examId);
      res.json({ ok: true, cropId, finalScore: outcome.total });
    } catch (err: any) {
      res.status(err instanceof ArbitrationError ? err.status : 500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
