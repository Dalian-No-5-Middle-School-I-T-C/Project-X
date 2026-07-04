import type { DbAdapter } from "../db/mysql";
import { getMysqlDb } from "../db/mysql";

export interface KnowledgePointRow {
  id: number;
  card_id: string;
  question_number: number;
  point_text: string;
  category: string | null;
  sort_order: number;
  created_at: string;
}

export interface KnowledgePointInput {
  question_number: number;
  point_text: string;
  category?: string;
  sort_order?: number;
}

export class KnowledgePointRepository {
  private db: DbAdapter;

  constructor() {
    this.db = getMysqlDb();
  }

  async findByCardId(cardId: string): Promise<KnowledgePointRow[]> {
    return await this.db.all(
      "SELECT * FROM knowledge_points WHERE card_id = ? ORDER BY question_number, sort_order",
      cardId
    );
  }

  async findByCardIdGrouped(cardId: string): Promise<Array<{ question_number: number; points: string[] }>> {
    const rows = await this.findByCardId(cardId);
    const map = new Map<number, string[]>();
    for (const row of rows) {
      const list = map.get(row.question_number) || [];
      list.push(row.point_text);
      map.set(row.question_number, list);
    }
    return Array.from(map.entries()).map(([question_number, points]) => ({ question_number, points }));
  }

  async replaceAll(cardId: string, points: KnowledgePointInput[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run("DELETE FROM knowledge_points WHERE card_id = ?", cardId);
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        await tx.run(
          "INSERT INTO knowledge_points (card_id, question_number, point_text, category, sort_order) VALUES (?, ?, ?, ?, ?)",
          cardId, p.question_number, p.point_text, p.category || null, p.sort_order ?? i
        );
      }
    });
  }

  async deleteByCardId(cardId: string): Promise<void> {
    await this.db.run("DELETE FROM knowledge_points WHERE card_id = ?", cardId);
  }

  async getWeaknessesForExam(examId: number, classId?: number | null): Promise<Array<{
    point_text: string;
    question_numbers: string;
    avg_rate: number;
    student_count: number;
    total_questions: number;
  }>> {
    let sql = `
      SELECT kp.point_text,
             GROUP_CONCAT(DISTINCT kp.question_number ORDER BY kp.question_number) AS question_numbers,
             ROUND(AVG(qs.score * 100.0 / NULLIF(qs.max_score, 0)), 1) AS avg_rate,
             COUNT(DISTINCT qs.student_id) AS student_count,
             COUNT(DISTINCT qs.question_number) AS total_questions
      FROM question_scores qs
      JOIN exams e ON qs.exam_id = e.id
      JOIN knowledge_points kp ON kp.card_id = e.card_id AND kp.question_number = qs.question_number
      WHERE qs.exam_id = ?
    `;
    const params: any[] = [examId];

    if (classId) {
      sql += " AND qs.student_id IN (SELECT student_id FROM class_students WHERE class_id = ?)";
      params.push(classId);
    }

    sql += " GROUP BY kp.point_text ORDER BY avg_rate ASC";
    return await this.db.all(sql, ...params);
  }

  async getWeaknessesForStudent(examId: number, studentId: number): Promise<Array<{
    point_text: string;
    question_numbers: string;
    scored: number;
    max_score: number;
    rate: number;
  }>> {
    return await this.db.all(
      `SELECT kp.point_text,
              GROUP_CONCAT(DISTINCT kp.question_number ORDER BY kp.question_number) AS question_numbers,
              SUM(qs.score) AS scored,
              SUM(qs.max_score) AS max_score,
              ROUND(SUM(qs.score) * 100.0 / NULLIF(SUM(qs.max_score), 0), 1) AS rate
       FROM question_scores qs
       JOIN exams e ON qs.exam_id = e.id
       JOIN knowledge_points kp ON kp.card_id = e.card_id AND kp.question_number = qs.question_number
       WHERE qs.exam_id = ? AND qs.student_id = ?
       GROUP BY kp.point_text
       ORDER BY rate ASC`,
      examId, studentId
    );
  }
}
