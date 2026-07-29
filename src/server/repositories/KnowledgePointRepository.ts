import type { DbAdapter } from "../db/mysql";
import { getMysqlDb } from "../db/mysql";
import { getAnalysisThresholds } from "../services/analysisConfig";

export type KnowledgeSeverity = "common_weak" | "weak" | "ok";

export interface KnowledgeWeaknessItem {
  point_text: string;
  question_numbers: string;
  /** 该知识点全部关联题的得分率（按学生作答人次加权平均，0-100） */
  avg_rate: number;
  /** 覆盖学生人次 */
  student_count: number;
  total_questions: number;
  /** v29 P0-4 轻量版：薄弱分层
   *  - common_weak: 得分率低于预警线（默认 60%）且覆盖人次多 → 共性薄弱
   *  - weak: 得分率低于预警线但覆盖人次较少 → 一般薄弱
   *  - ok: 达到预警线
   */
  severity: KnowledgeSeverity;
  /** 该知识点覆盖的学生人次占该考试作答总人次的比例（0-100） */
  coverage_rate: number;
}

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
    let sql = `
      SELECT kp.point_text,
             kp.question_number,
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

    sql += " GROUP BY kp.point_text, kp.question_number ORDER BY kp.point_text, kp.question_number";
    const rows = await this.db.all(sql, ...params);

    // 考试作答总人次（用作覆盖率基准）：取该范围学生 × 题数的最大可能人次
    const totalAttemptsRow = await this.db.all(
      `SELECT COUNT(*) AS cnt
       FROM question_scores qs
       JOIN exams e ON qs.exam_id = e.id
       WHERE qs.exam_id = ?
       ${classId ? " AND qs.student_id IN (SELECT student_id FROM class_students WHERE class_id = ?)" : ""}`,
      ...(classId ? [examId, classId] : [examId])
    ) as Array<{ cnt: number }>;
    const totalAttempts = totalAttemptsRow[0]?.cnt ?? 0;

    // v29 修正：按作答人次加权平均聚合每题得分率到知识点层级，
    // 取代原先"保留首行 rate"的粗糙做法（注释自承）
    const map = new Map<string, {
      point_text: string;
      sumRate: number;     // 加权分子：每题 avg_rate × 该题作答人次
      totalWeight: number; // 作答人次之和
      maxStudentCount: number;
      total_questions: number;
      question_numbers: number[];
    }>();
    for (const row of rows as Array<any>) {
      const pointText = row.point_text;
      // 为加权聚合，单独取每题作答人次
      const attRow = await this.db.all(
        `SELECT COUNT(*) AS cnt FROM question_scores qs
         JOIN exams e ON qs.exam_id = e.id
         WHERE qs.exam_id = ? AND qs.question_number = ?
         ${classId ? " AND qs.student_id IN (SELECT student_id FROM class_students WHERE class_id = ?)" : ""}`,
        ...(classId ? [examId, row.question_number, classId] : [examId, row.question_number])
      ) as Array<{ cnt: number }>;
      const weight = attRow[0]?.cnt ?? row.student_count ?? 0;
      let entry = map.get(pointText);
      if (!entry) {
        entry = {
          point_text: pointText, sumRate: 0, totalWeight: 0,
          maxStudentCount: 0, total_questions: 0, question_numbers: []
        };
        map.set(pointText, entry);
      }
      entry.sumRate += (row.avg_rate ?? 0) * weight;
      entry.totalWeight += weight;
      if (row.student_count > entry.maxStudentCount) entry.maxStudentCount = row.student_count;
      entry.total_questions += 1;
      if (!entry.question_numbers.includes(row.question_number)) entry.question_numbers.push(row.question_number);
    }

    const { passRate } = await getAnalysisThresholds();
    // 知识点预警线沿用及格线比例（×100 得分率阈值），覆盖人次占比阈值取 50%
    const weakRateThreshold = Math.round(passRate * 100);
    const coverageThreshold = 50;

    const result: Array<KnowledgeWeaknessItem> = Array.from(map.values()).map((entry) => {
      entry.question_numbers.sort((a, b) => a - b);
      const avgRate = entry.totalWeight > 0 ? Math.round((entry.sumRate / entry.totalWeight) * 10) / 10 : 0;
      const coverageRate = totalAttempts > 0
        ? Math.round((entry.totalWeight / totalAttempts) * 100)
        : (entry.maxStudentCount > 0 ? 100 : 0);
      let severity: KnowledgeSeverity = "ok";
      if (avgRate < weakRateThreshold) {
        severity = coverageRate >= coverageThreshold ? "common_weak" : "weak";
      }
      return {
        point_text: entry.point_text,
        question_numbers: entry.question_numbers.join(","),
        avg_rate: avgRate,
        student_count: entry.maxStudentCount,
        total_questions: entry.total_questions,
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
