import { getDatabase } from "../db";
import Database from "better-sqlite3";
import type { AnswerCard } from "../../shared/types";
import { normalizeObjectiveQuestions } from "../../shared/grading";

export interface CardSummary {
  id: string;
  title: string;
  subject?: string;
  updated_at: string;
  created_by_name?: string;
}

export class CardRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * 创建答题卡记录
   */
  createCard(card: AnswerCard, createdBy?: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, layout_data, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      card.id,
      card.title,
      card.subject ?? null,
      (card as any).subjectLabel ?? null,
      (card as any).examDate ?? null,
      card.paper?.size ?? "A4",
      card.paper?.orientation ?? "portrait",
      JSON.stringify(card.studentInfo?.fields ?? []),
      card.studentInfo?.studentNumberDigits ?? 5,
      card.sided ?? "double",
      card.layoutVersion ?? 1,
      null,
      createdBy ?? null
    );
  }

  /**
   * 更新答题卡记录
   */
  updateCard(card: AnswerCard, layoutData?: unknown): void {
    const stmt = this.db.prepare(`
      UPDATE answer_cards
      SET title = ?, subject = ?, subject_label = ?, exam_date = ?, student_fields = ?, student_number_digits = ?, sided = ?, layout_version = ?, layout_data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(
      card.title,
      card.subject ?? null,
      (card as any).subjectLabel ?? null,
      (card as any).examDate ?? null,
      JSON.stringify(card.studentInfo?.fields ?? []),
      card.studentInfo?.studentNumberDigits ?? 5,
      card.sided ?? "double",
      card.layoutVersion ?? 1,
      layoutData ? JSON.stringify(layoutData) : null,
      card.id
    );

    // 先删除旧题块，再插入新的（简化方案）
    this.db.prepare("DELETE FROM objective_blocks WHERE card_id = ?").run(card.id);
    this.db.prepare("DELETE FROM subjective_blocks WHERE card_id = ?").run(card.id);

    // 插入客观题块
    if (card.bodyBlocks) {
      for (const block of card.bodyBlocks) {
        if (block.type === "objective") {
          this.insertObjectiveBlock(block as any, card.id);
        } else if (block.type === "subjective") {
          this.insertSubjectiveBlock(block as any, card.id);
        }
      }
    }
  }

  /**
   * 插入客观题块
   */
  private insertObjectiveBlock(block: any, cardId: string): void {
    const questions = normalizeObjectiveQuestions(block);
    const firstQuestion = questions[0];
    const stmt = this.db.prepare(`
      INSERT INTO objective_blocks (id, card_id, sort_order, title, question_start, question_count, option_count, mode, score_per_question, density, wrong_or_extra_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      block.id,
      cardId,
      0,
      block.title ?? "",
      firstQuestion?.questionNumber ?? block.questionStart ?? 1,
      questions.length || block.questionCount || 0,
      firstQuestion?.optionCount ?? block.optionCount ?? 4,
      firstQuestion?.mode ?? block.mode ?? "single",
      firstQuestion?.score ?? block.scorePerQuestion ?? 0,
      block.density ?? "compact",
      firstQuestion?.scoringRule?.wrongOrExtraScore ?? block.multipleScoring?.wrongOrExtraScore ?? 0
    );

    const keyStmt = this.db.prepare(
      "INSERT OR REPLACE INTO objective_answer_keys (block_id, question_number, correct_options) VALUES (?, ?, ?)"
    );
    const questionStmt = this.db.prepare(
      `INSERT OR REPLACE INTO objective_questions (block_id, question_number, sort_order, mode, option_count, score, scoring_rule_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    questions.forEach((question, index) => {
      questionStmt.run(
        block.id,
        question.questionNumber,
        index,
        question.mode,
        question.optionCount,
        question.score,
        question.scoringRule ? JSON.stringify(question.scoringRule) : null
      );
      if (question.answerKey && question.answerKey.length > 0) {
        keyStmt.run(block.id, question.questionNumber, JSON.stringify(question.answerKey));
      }
    });

    if (block.multipleScoring?.partialScores) {
      const scoreStmt = this.db.prepare(
        "INSERT OR REPLACE INTO objective_multiple_scoring (block_id, correct_count, score) VALUES (?, ?, ?)"
      );
      for (const [partialCount, score] of Object.entries(block.multipleScoring.partialScores)) {
        scoreStmt.run(block.id, Number(partialCount), score as number);
      }
    }
  }

  /**
   * 插入主观题块
   */
  private insertSubjectiveBlock(block: any, cardId: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO subjective_blocks (id, card_id, sort_order, title)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(block.id, cardId, 0, block.title ?? "");

    // 插入主观题
    if (block.questions) {
      const qStmt = this.db.prepare(`
        INSERT INTO subjective_questions (id, block_id, number, score, style, kind, min_height_mm, line_grid_enabled, line_spacing_mm, blanks_count, blanks_width_mm, blanks_height_mm)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const q of block.questions) {
        qStmt.run(
          q.id,
          block.id,
          q.number,
          q.score,
          q.style ?? "manual_score_grid",
          q.kind ?? "plain_box",
          q.minHeightMm ?? 68,
          q.lineGrid?.enabled ? 1 : 0,
          q.lineGrid?.lineSpacingMm ?? 8,
          q.blanks?.count,
          q.blanks?.widthMm,
          q.blanks?.heightMm
        );

        // 插入图片
        if (q.images) {
          const imgStmt = this.db.prepare(`
            INSERT INTO subjective_question_images (question_id, asset_id, original_name, width_mm, height_mm, align)
            VALUES (?, ?, ?, ?, ?, ?)
          `);
          for (const img of q.images) {
            imgStmt.run(q.id, img.assetId, img.originalName, img.widthMm, img.heightMm, img.align ?? "left");
          }
        }
      }
    }
  }

  /**
   * 获取答题卡列表
   */
  listCards(): CardSummary[] {
    const stmt = this.db.prepare(`
      SELECT c.id, c.title, c.subject, c.subject_label, c.updated_at, u.name as created_by_name
      FROM answer_cards c
      LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.updated_at DESC
    `);
    return stmt.all() as CardSummary[];
  }

  /**
   * 根据 ID 获取答题卡
   */
  findById(cardId: string): AnswerCard | null {
    // 先查主表
    const cardRow = this.db.prepare("SELECT * FROM answer_cards WHERE id = ?").get(cardId) as any;
    if (!cardRow) return null;

    // 构建 AnswerCard 对象
    const card: AnswerCard = {
      id: cardRow.id,
      title: cardRow.title,
      subject: cardRow.subject ?? undefined,
      subjectLabel: cardRow.subject_label ?? undefined,
      examDate: cardRow.exam_date ?? undefined,
      paper: { size: cardRow.paper_size, orientation: cardRow.orientation },
      studentInfo: {
        fields: JSON.parse(cardRow.student_fields ?? "[]"),
        studentNumberDigits: cardRow.student_number_digits
      },
      bodyBlocks: [],
      sided: (cardRow.sided as "single" | "double") ?? "double",
      layoutVersion: cardRow.layout_version,
      updatedAt: cardRow.updated_at
    };

    // 加载客观题块
    const objBlocks = this.db.prepare("SELECT * FROM objective_blocks WHERE card_id = ? ORDER BY sort_order").all(cardId) as any[];
    for (const b of objBlocks) {
      const answerKeys: Record<number, string[]> = {};
      const keys = this.db.prepare("SELECT * FROM objective_answer_keys WHERE block_id = ?").all(b.id) as any[];
      for (const k of keys) {
        answerKeys[k.question_number] = JSON.parse(k.correct_options);
      }

      const partialScores: Record<number, number> = {};
      const scores = this.db.prepare("SELECT * FROM objective_multiple_scoring WHERE block_id = ?").all(b.id) as any[];
      for (const s of scores) {
        partialScores[s.correct_count] = s.score;
      }

      const questionRows = this.db.prepare("SELECT * FROM objective_questions WHERE block_id = ? ORDER BY sort_order, question_number").all(b.id) as any[];
      const block = {
        id: b.id,
        type: "objective",
        title: b.title,
        questionStart: b.question_start,
        questionCount: b.question_count,
        optionCount: b.option_count,
        mode: b.mode,
        scorePerQuestion: b.score_per_question,
        density: b.density,
        answerKey: answerKeys,
        multipleScoring: {
          partialScores,
          wrongOrExtraScore: b.wrong_or_extra_score
        },
        questions: questionRows.length > 0
          ? questionRows.map((q) => ({
              questionNumber: q.question_number,
              mode: q.mode,
              optionCount: q.option_count,
              score: q.score,
              answerKey: answerKeys[q.question_number] ?? [],
              scoringRule: q.scoring_rule_json ? JSON.parse(q.scoring_rule_json) : undefined
            }))
          : undefined
      } as any;
      block.questions ??= normalizeObjectiveQuestions(block);
      card.bodyBlocks.push(block);
    }

    // 加载主观题块
    const subBlocks = this.db.prepare("SELECT * FROM subjective_blocks WHERE card_id = ? ORDER BY sort_order").all(cardId) as any[];
    for (const b of subBlocks) {
      const questions = this.db.prepare("SELECT * FROM subjective_questions WHERE block_id = ? ORDER BY sort_order").all(b.id) as any[];
      const questionsWithImages = questions.map((q: any) => {
        const images = this.db.prepare("SELECT * FROM subjective_question_images WHERE question_id = ? ORDER BY sort_order").all(q.id) as any[];
        return {
          id: q.id,
          number: q.number,
          score: q.score,
          style: q.style,
          kind: q.kind,
          minHeightMm: q.min_height_mm,
          lineGrid: { enabled: q.line_grid_enabled === 1, lineSpacingMm: q.line_spacing_mm },
          blanks: q.blanks_count ? { count: q.blanks_count, widthMm: q.blanks_width_mm, heightMm: q.blanks_height_mm } : undefined,
          images: images.map((img: any) => ({
            assetId: img.asset_id,
            originalName: img.original_name,
            widthMm: img.width_mm,
            heightMm: img.height_mm,
            align: img.align
          }))
        };
      });

      card.bodyBlocks.push({
        id: b.id,
        type: "subjective",
        title: b.title,
        questions: questionsWithImages
      } as any);
    }

    return card;
  }

  /**
   * 删除答题卡
   */
  deleteCard(cardId: string): boolean {
    const stmt = this.db.prepare("DELETE FROM answer_cards WHERE id = ?");
    const result = stmt.run(cardId);
    return result.changes > 0;
  }

  /**
   * 更新 layout_data
   */
  updateLayoutData(cardId: string, layoutData: unknown): void {
    this.db.prepare("UPDATE answer_cards SET layout_data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify(layoutData), cardId);
  }

  /**
   * 获取 layout_data
   */
  getLayoutData(cardId: string): unknown | null {
    const row = this.db.prepare("SELECT layout_data FROM answer_cards WHERE id = ?").get(cardId) as { layout_data: string | null } | undefined;
    if (!row || !row.layout_data) return null;
    return JSON.parse(row.layout_data);
  }
}
