import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import type { AnswerCard } from "../../shared/types";
import { normalizeObjectiveQuestions } from "../../shared/grading";

export interface CardSummary {
  id: string;
  title: string;
  subject?: string;
  subject_label?: string;
  updated_at: string;
  created_by_name?: string;
  has_original_paper?: boolean;
  original_paper_filename?: string;
}

function normalizeOptionLayout(value: unknown): "horizontal" | "vertical" {
  return value === "vertical" ? "vertical" : "horizontal";
}

export class CardRepository {
  private db: DbAdapter;

  constructor() {
    this.db = getMysqlDb();
  }

  async createCard(card: AnswerCard, createdBy?: number): Promise<void> {
    await this.db.run(
      `INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      card.id, card.title, card.subject ?? null, (card as any).subjectLabel ?? null,
      (card as any).examDate ?? null, card.paper?.size ?? "A4", card.paper?.orientation ?? "portrait",
      JSON.stringify(card.studentInfo?.fields ?? []), card.studentInfo?.studentNumberDigits ?? 5,
      card.sided ?? "double", card.layoutVersion ?? 1, createdBy ?? null
    );
  }

  async updateCard(card: AnswerCard): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run(
        `UPDATE answer_cards SET title = ?, subject = ?, subject_label = ?, exam_date = ?, paper_size = ?, orientation = ?, student_fields = ?, student_number_digits = ?, sided = ?, layout_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        card.title, card.subject ?? null, (card as any).subjectLabel ?? null, (card as any).examDate ?? null,
        card.paper?.size ?? "A4", card.paper?.orientation ?? "portrait",
        JSON.stringify(card.studentInfo?.fields ?? []), card.studentInfo?.studentNumberDigits ?? 5,
        card.sided ?? "double", card.layoutVersion ?? 1, card.id
      );

      await tx.run("DELETE FROM objective_blocks WHERE card_id = ?", card.id);
      await tx.run("DELETE FROM subjective_blocks WHERE card_id = ?", card.id);

      if (card.bodyBlocks) {
        for (const block of card.bodyBlocks) {
          if (block.type === "objective") await this.insertObjectiveBlock(block as any, card.id, tx);
          else if (block.type === "subjective") await this.insertSubjectiveBlock(block as any, card.id, tx);
        }
      }
    });
  }

  private async insertObjectiveBlock(block: any, cardId: string, tx: DbAdapter): Promise<void> {
    const questions = normalizeObjectiveQuestions(block);
    const firstQuestion = questions[0];
    const blockOptionLayout = normalizeOptionLayout(block.optionLayout);
    await tx.run(
      `INSERT INTO objective_blocks (id, card_id, sort_order, title, question_start, question_count, option_count, mode, score_per_question, density, option_layout, wrong_or_extra_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      block.id, cardId, 0, block.title ?? "", firstQuestion?.questionNumber ?? block.questionStart ?? 1,
      questions.length || block.questionCount || 0, firstQuestion?.optionCount ?? block.optionCount ?? 4,
      firstQuestion?.mode ?? block.mode ?? "single", firstQuestion?.score ?? block.scorePerQuestion ?? 0,
      block.density ?? "compact", blockOptionLayout, firstQuestion?.scoringRule?.wrongOrExtraScore ?? block.multipleScoring?.wrongOrExtraScore ?? 0
    );

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      await tx.run(
        `INSERT INTO objective_questions (block_id, question_number, sort_order, mode, option_count, score, option_layout, scoring_rule_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) -- note: upsert handled by DELETE-then-INSERT in updateCard()`,
        block.id, question.questionNumber, i, question.mode, question.optionCount, question.score,
        normalizeOptionLayout(question.optionLayout ?? blockOptionLayout),
        question.scoringRule ? JSON.stringify(question.scoringRule) : null
      );
      if (question.answerKey && question.answerKey.length > 0) {
        await tx.run(
          `INSERT INTO objective_answer_keys (block_id, question_number, correct_options)
           VALUES (?, ?, ?) -- note: upsert handled by DELETE-then-INSERT`,
          block.id, question.questionNumber, JSON.stringify(question.answerKey)
        );
      }
    }

    if (block.multipleScoring?.partialScores) {
      for (const [partialCount, score] of Object.entries(block.multipleScoring.partialScores)) {
        await tx.run(
          `INSERT INTO objective_multiple_scoring (block_id, correct_count, score)
           VALUES (?, ?, ?) -- note: upsert handled by DELETE-then-INSERT`,
          block.id, Number(partialCount), score as number
        );
      }
    }
  }

  private async insertSubjectiveBlock(block: any, cardId: string, tx: DbAdapter): Promise<void> {
    await tx.run(
      `INSERT INTO subjective_blocks (id, card_id, sort_order, block_kind, title) VALUES (?, ?, ?, ?, ?)`,
      block.id, cardId, 0, block.blockKind ?? (block.title?.includes("填空") ? "fill_blank" : "answer"), block.title ?? ""
    );

    if (block.questions) {
      for (const q of block.questions) {
        await tx.run(
          `INSERT INTO subjective_questions (id, block_id, number, score, style, kind, min_height_mm, line_grid_enabled, line_spacing_mm, blanks_count, blanks_width_mm, blanks_height_mm, blanks_label_style, blanks_items_json, line_grid_json, essay_grid_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          q.id, block.id, q.number, q.score, q.style ?? "manual_score_grid", q.kind ?? "plain_box",
          q.minHeightMm ?? 68, q.lineGrid?.enabled ? 1 : 0, q.lineGrid?.lineSpacingMm ?? 8,
          q.blanks?.count, q.blanks?.widthMm, q.blanks?.heightMm, q.blanks?.labelStyle,
          q.blanks?.items ? JSON.stringify(q.blanks.items) : undefined,
          q.lineGrid ? JSON.stringify(q.lineGrid) : undefined,
          q.essayGrid ? JSON.stringify(q.essayGrid) : undefined
        );

        if (q.images) {
          for (const img of q.images) {
            await tx.run(
              `INSERT INTO subjective_question_images (question_id, asset_id, original_name, width_mm, height_mm, align)
               VALUES (?, ?, ?, ?, ?, ?)`,
              q.id, img.assetId, img.originalName, img.widthMm, img.heightMm, img.align ?? "left"
            );
          }
        }
      }
    }
  }

  async listCards(): Promise<CardSummary[]> {
    return await this.db.all(`
      SELECT c.id, c.title, c.subject, c.subject_label, c.updated_at, u.name as created_by_name,
             c.has_original_paper, c.original_paper_filename
      FROM answer_cards c LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.updated_at DESC
    `);
  }

  async findById(cardId: string): Promise<AnswerCard | null> {
    const cardRow = await this.db.get("SELECT * FROM answer_cards WHERE id = ?", cardId);
    if (!cardRow) return null;

    const card: AnswerCard = {
      id: cardRow.id, title: cardRow.title,
      subject: cardRow.subject ?? undefined, subjectLabel: cardRow.subject_label ?? undefined,
      examDate: cardRow.exam_date ?? undefined,
      paper: { size: cardRow.paper_size, orientation: cardRow.orientation },
      studentInfo: { fields: JSON.parse(cardRow.student_fields ?? "[]"), studentNumberDigits: cardRow.student_number_digits },
      bodyBlocks: [], sided: (cardRow.sided as "single" | "double") ?? "double",
      layoutVersion: cardRow.layout_version === 2 ? 2 : 1, updatedAt: cardRow.updated_at
    };

    const objBlocks = await this.db.all("SELECT * FROM objective_blocks WHERE card_id = ? ORDER BY sort_order", cardId);
    for (const b of objBlocks) {
      const answerKeys: Record<number, string[]> = {};
      const keys = await this.db.all("SELECT * FROM objective_answer_keys WHERE block_id = ?", b.id);
      for (const k of keys) { answerKeys[k.question_number] = JSON.parse(k.correct_options); }

      const partialScores: Record<number, number> = {};
      const scores = await this.db.all("SELECT * FROM objective_multiple_scoring WHERE block_id = ?", b.id);
      for (const s of scores) { partialScores[s.correct_count] = s.score; }

      const questionRows = await this.db.all("SELECT * FROM objective_questions WHERE block_id = ? ORDER BY sort_order, question_number", b.id);
      const blockOptionLayout = normalizeOptionLayout(b.option_layout);
      const block: any = {
        id: b.id, type: "objective", title: b.title, questionStart: b.question_start,
        questionCount: b.question_count, optionCount: b.option_count, mode: b.mode,
        scorePerQuestion: b.score_per_question, density: b.density, optionLayout: blockOptionLayout,
        answerKey: answerKeys, multipleScoring: { partialScores, wrongOrExtraScore: b.wrong_or_extra_score },
        questions: questionRows.length > 0 ? questionRows.map((q) => ({
          questionNumber: q.question_number, mode: q.mode, optionCount: q.option_count, score: q.score,
          optionLayout: normalizeOptionLayout(q.option_layout ?? blockOptionLayout),
          answerKey: answerKeys[q.question_number] ?? [],
          scoringRule: q.scoring_rule_json ? JSON.parse(q.scoring_rule_json) : undefined
        })) : undefined
      };
      block.questions ??= normalizeObjectiveQuestions(block);
      card.bodyBlocks.push(block);
    }

    const subBlocks = await this.db.all("SELECT * FROM subjective_blocks WHERE card_id = ? ORDER BY sort_order", cardId);
    for (const b of subBlocks) {
      const questions = await this.db.all("SELECT * FROM subjective_questions WHERE block_id = ? ORDER BY sort_order", b.id);
      const questionsWithImages = await Promise.all(questions.map(async (q: any) => {
        const images = await this.db.all("SELECT * FROM subjective_question_images WHERE question_id = ? ORDER BY sort_order", q.id);
        let lineGrid = { enabled: q.line_grid_enabled === 1, lineSpacingMm: q.line_spacing_mm };
        if (q.line_grid_json) {
          try { lineGrid = { ...lineGrid, ...JSON.parse(q.line_grid_json) }; } catch { /* keep fallback */ }
        }
        let essayGrid: unknown;
        if (q.essay_grid_json) {
          try { essayGrid = JSON.parse(q.essay_grid_json); } catch { essayGrid = undefined; }
        }
        return {
          id: q.id, number: q.number, score: q.score, style: q.style, kind: q.kind,
          minHeightMm: q.min_height_mm, lineGrid, essayGrid,
          blanks: q.blanks_count ? { count: q.blanks_count, widthMm: q.blanks_width_mm, heightMm: q.blanks_height_mm, labelStyle: q.blanks_label_style ?? undefined, items: q.blanks_items_json ? JSON.parse(q.blanks_items_json) : undefined } : undefined,
          images: images.map((img: any) => ({ assetId: img.asset_id, originalName: img.original_name, widthMm: img.width_mm, heightMm: img.height_mm, align: img.align }))
        };
      }));
      card.bodyBlocks.push({ id: b.id, type: "subjective", blockKind: b.block_kind ?? (String(b.title ?? "").includes("填空") ? "fill_blank" : "answer"), title: b.title, questions: questionsWithImages } as any);
    }

    return card;
  }

  async findByTitle(title: string): Promise<{ id: string; title: string } | null> {
    return await this.db.get("SELECT id, title FROM answer_cards WHERE title = ?", title);
  }

  async deleteCard(cardId: string): Promise<boolean> {
    const result = await this.db.run("DELETE FROM answer_cards WHERE id = ?", cardId);
    return result.changes > 0;
  }
}
