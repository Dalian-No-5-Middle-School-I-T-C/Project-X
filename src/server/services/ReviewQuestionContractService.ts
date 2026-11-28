import type { DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { objectiveQuestionDefinitions } from "../../shared/grading";
import type { ReviewQuestionContract } from "../../shared/types";

export type ReviewBlockQuestionContract = {
  questions: ReviewQuestionContract[];
  /** 卡内存在但满分为零的小空不参与网阅提交校验。 */
  zeroQuestionNumbers: Set<number>;
  maxScore: number;
};

/**
 * 生成网阅唯一的逐题满分契约。
 *
 * 答题卡是首选事实源；只有卡内题块没有任何正满分小题时，才回退到已落库的
 * question_scores。所有调用方共享同一次批量读取，避免汇总、队列和提交各写一套规则。
 */
export async function loadReviewQuestionContracts(
  examId: number,
  db: DbAdapter,
  blockIds?: string[] | null
): Promise<Map<string, ReviewBlockQuestionContract>> {
  const exam = await db.get<{ card_id: string | null }>(
    "SELECT card_id FROM exams WHERE id = ?",
    examId
  );
  const card = exam?.card_id ? await new CardRepository(db).findById(exam.card_id) : null;
  const requested = blockIds && blockIds.length > 0 ? new Set(blockIds) : null;

  const dbRows = await db.all<{ block_id: string | null; question_number: number; max_score: number | null }>(
    `SELECT block_id, question_number, MAX(max_score) AS max_score
     FROM question_scores
     WHERE exam_id = ?
     GROUP BY block_id, question_number`,
    examId
  );
  const dbMaxByBlock = new Map<string, Map<number, number>>();
  for (const row of dbRows) {
    if (row.block_id == null) continue;
    const qNum = Number(row.question_number);
    const max = Number(row.max_score ?? 0);
    if (!Number.isFinite(qNum) || !Number.isFinite(max) || max <= 0) continue;
    let byQuestion = dbMaxByBlock.get(row.block_id);
    if (!byQuestion) {
      byQuestion = new Map<number, number>();
      dbMaxByBlock.set(row.block_id, byQuestion);
    }
    byQuestion.set(qNum, max);
  }

  const result = new Map<string, ReviewBlockQuestionContract>();
  const addBlock = (blockId: string, positive: Map<number, number>, zero: Set<number>) => {
    if (requested && !requested.has(blockId)) return;
    let questions = Array.from(positive, ([questionNumber, maxScore]) => ({ questionNumber, maxScore }))
      .sort((a, b) => a.questionNumber - b.questionNumber);
    if (questions.length === 0) {
      const fallback = dbMaxByBlock.get(blockId);
      if (fallback && fallback.size > 0) {
        questions = Array.from(fallback, ([questionNumber, maxScore]) => ({ questionNumber, maxScore }))
          .sort((a, b) => a.questionNumber - b.questionNumber);
      }
    }
    result.set(blockId, {
      questions,
      zeroQuestionNumbers: zero,
      maxScore: questions.reduce((sum, question) => sum + question.maxScore, 0)
    });
  };

  for (const block of card?.bodyBlocks ?? []) {
    const positive = new Map<number, number>();
    const zero = new Set<number>();
    if (block.type === "objective") {
      for (const definition of objectiveQuestionDefinitions(block)) {
        const qNum = Number(definition.questionNumber);
        const max = Number(definition.score ?? 0);
        if (!Number.isFinite(qNum)) continue;
        if (max > 0) positive.set(qNum, max);
        else zero.add(qNum);
      }
    } else if (block.type === "subjective") {
      for (const question of block.questions ?? []) {
        const qNum = Number(question.number);
        const max = Number(question.score ?? 0);
        if (!Number.isFinite(qNum)) continue;
        if (max > 0) positive.set(qNum, max);
        else zero.add(qNum);
      }
    }
    addBlock(block.id, positive, zero);
  }

  // 演示数据或旧卡可能没有对应 bodyBlock，仍保留 question_scores 的可评分契约。
  for (const blockId of dbMaxByBlock.keys()) addBlock(blockId, new Map(), new Set());
  return result;
}
