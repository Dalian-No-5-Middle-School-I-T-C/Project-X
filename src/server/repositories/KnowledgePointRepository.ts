import type { DbAdapter } from "../db/mysql";
import { getMysqlDb } from "../db/mysql";
import { getAnalysisThresholds } from "../services/analysisConfig";
import { discriminationByExtremeGroup } from "../../shared/stats";
import type { KnowledgeSeverity, KnowledgeWeaknessItem } from "../../shared/types";

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

  async getWeaknessesForExam(examId: number, classId?: number | null): Promise<Array<KnowledgeWeaknessItem>> {
    // #176：单次查询取回知识点 × 题目 × 学生的原始小题分，避免逐题 N+1 查询。
    // 同一查询既算得分率（难度 P），也能用极端组法算区分度 D。
    let sql = `
      SELECT kp.point_text,
             kp.question_number,
             qs.student_id,
             qs.score,
             qs.max_score
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

    sql += " ORDER BY kp.point_text, kp.question_number, qs.student_id";
    const rows = await this.db.all(sql, ...params);

    // 分组基准：学生总分（用于极端组法区分度）
    const totalRows = await this.db.all(
      `SELECT student_id, total_score FROM student_scores
       WHERE exam_id = ?
       ${classId ? " AND student_id IN (SELECT student_id FROM class_students WHERE class_id = ?)" : ""}`,
      ...(classId ? [examId, classId] : [examId])
    ) as Array<{ student_id: number; total_score: number }>;
    const totalsMap = new Map(totalRows.map((r) => [r.student_id, r.total_score]));

    // 按知识点聚合：point_text → 题目号 → 学生小题分数组
    const map = new Map<string, {
      point_text: string;
      questions: Map<number, Array<{ student_id: number; score: number; max_score: number }>>;
      studentIds: Set<number>;
    }>();
    for (const row of rows as Array<{ point_text: string; question_number: number; student_id: number; score: number; max_score: number }>) {
      let entry = map.get(row.point_text);
      if (!entry) {
        entry = { point_text: row.point_text, questions: new Map(), studentIds: new Set() };
        map.set(row.point_text, entry);
      }
      const list = entry.questions.get(row.question_number) ?? [];
      list.push({ student_id: row.student_id, score: row.score, max_score: row.max_score });
      entry.questions.set(row.question_number, list);
      entry.studentIds.add(row.student_id);
    }

    const totalAttempts = rows.length;
    const { passRate } = await getAnalysisThresholds();
    // 知识点预警线沿用及格线比例（×100 得分率阈值），覆盖人次占比阈值取 50%
    const weakRateThreshold = Math.round(passRate * 100);
    const coverageThreshold = 50;

    const result: Array<KnowledgeWeaknessItem> = Array.from(map.values()).map((entry) => {
      const questionNumbers = Array.from(entry.questions.keys()).sort((a, b) => a - b);
      let sumRate = 0;
      let totalWeight = 0;
      const discValues: number[] = [];
      for (const qn of questionNumbers) {
        const attempts = entry.questions.get(qn)!;
        const weight = attempts.length;
        const avgRateQ = attempts.reduce((s, a) => s + (a.max_score > 0 ? (a.score / a.max_score) * 100 : 0), 0) / Math.max(1, weight);
        sumRate += avgRateQ * weight;
        totalWeight += weight;
        const maxScore = attempts[0]?.max_score ?? 0;
        const paired = attempts
          .filter((a) => totalsMap.has(a.student_id))
          .map((a) => ({ score: a.score, total: totalsMap.get(a.student_id)! }));
        if (paired.length > 0 && maxScore > 0) {
          discValues.push(discriminationByExtremeGroup(
            paired.map((p) => p.score),
            paired.map((p) => p.total),
            maxScore
          ));
        }
      }
      const avgRate = totalWeight > 0 ? Math.round((sumRate / totalWeight) * 10) / 10 : 0;
      const discrimination = discValues.length > 0
        ? Math.round((discValues.reduce((s, d) => s + d, 0) / discValues.length) * 1000) / 1000
        : 0;
      const coverageRate = totalAttempts > 0
        ? Math.round((totalWeight / totalAttempts) * 100)
        : (entry.studentIds.size > 0 ? 100 : 0);
      let severity: KnowledgeSeverity = "ok";
      if (avgRate < weakRateThreshold) {
        severity = coverageRate >= coverageThreshold ? "common_weak" : "weak";
      }
      return {
        point_text: entry.point_text,
        question_numbers: questionNumbers.join(","),
        avg_rate: avgRate,
        difficulty: Math.round((avgRate / 100) * 1000) / 1000,
        discrimination,
        student_count: entry.studentIds.size,
        total_questions: questionNumbers.length,
        severity,
        coverage_rate: coverageRate
      };
    });
    // 按 severity 严重度 → 得分率升序 排序，薄弱项在前
    const sevOrder: Record<KnowledgeSeverity, number> = { common_weak: 0, weak: 1, ok: 2 };
    result.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.avg_rate - b.avg_rate);
    return result;
  }

  async getWeaknessesForStudent(examId: number, studentId: number): Promise<Array<{
    point_text: string;
    question_numbers: string;
    scored: number;
    max_score: number;
    rate: number;
  }>> {
    const rows = await this.db.all(
      `SELECT kp.point_text,
              kp.question_number,
              SUM(qs.score) AS scored,
              SUM(qs.max_score) AS max_score,
              ROUND(SUM(qs.score) * 100.0 / NULLIF(SUM(qs.max_score), 0), 1) AS rate
       FROM question_scores qs
       JOIN exams e ON qs.exam_id = e.id
       JOIN knowledge_points kp ON kp.card_id = e.card_id AND kp.question_number = qs.question_number
       WHERE qs.exam_id = ? AND qs.student_id = ?
       GROUP BY kp.point_text, kp.question_number
       ORDER BY kp.point_text, kp.question_number`,
      examId, studentId
    );

    const map = new Map<string, { point_text: string; scored: number; max_score: number; rate: number; question_numbers: number[] }>();
    for (const row of rows) {
      const pointText = (row as any).point_text;
      if (!map.has(pointText)) {
        map.set(pointText, {
          point_text: pointText,
          scored: (row as any).scored,
          max_score: (row as any).max_score,
          rate: (row as any).rate,
          question_numbers: []
        });
      }
      const entry = map.get(pointText)!;
      const qn = (row as any).question_number;
      if (!entry.question_numbers.includes(qn)) {
        entry.question_numbers.push(qn);
      }
    }

    return Array.from(map.values()).map((entry) => {
      entry.question_numbers.sort((a, b) => a - b);
      return {
        point_text: entry.point_text,
        question_numbers: entry.question_numbers.join(","),
        scored: entry.scored,
        max_score: entry.max_score,
        rate: entry.rate,
      };
    });
  }
}
