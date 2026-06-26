import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import type { StudentTrendPoint } from "../../shared/types";

export interface StudentExamScore {
  exam_id: number;
  exam_name: string;
  subject: string | null;
  objective_score: number;
  subjective_score: number;
  total_score: number;
  rank: number | null;
  percentile: number | null;
  class_size: number;
  graded_at: string;
}

export interface StudentQuestionScore {
  question_number: number | null;
  question_id: string | null;
  block_id: string | null;
  score: number;
  max_score: number;
  score_type: string;
}

export class ScoreRepository {
  private db: DbAdapter;

  constructor() {
    this.db = getMysqlDb();
  }

  async getStudentScores(studentId: number): Promise<StudentExamScore[]> {
    const rows = await this.db.all(`
      SELECT
        ss.exam_id,
        e.name AS exam_name,
        e.subject,
        ss.objective_score,
        ss.subjective_score,
        ss.total_score,
        ss.graded_at,
        (
          SELECT COUNT(*) + 1 FROM student_scores s2
          WHERE s2.exam_id = ss.exam_id AND s2.total_score > ss.total_score
        ) AS rank,
        (
          SELECT COUNT(*) FROM student_scores s3 WHERE s3.exam_id = ss.exam_id
        ) AS class_size
      FROM student_scores ss
      JOIN exams e ON e.id = ss.exam_id
      WHERE ss.student_id = ?
      ORDER BY ss.graded_at DESC
    `, studentId) as Array<Omit<StudentExamScore, "percentile">>;

    return rows.map((r) => ({
      ...r,
      percentile:
        r.class_size > 1 && r.rank != null
          ? Math.round(((r.class_size - r.rank) / (r.class_size - 1)) * 1000) / 10
          : null
    }));
  }

  async getStudentQuestionScores(studentId: number, examId: number): Promise<StudentQuestionScore[]> {
    return await this.db.all(`
      SELECT question_number, question_id, block_id, score, max_score, score_type
      FROM question_scores
      WHERE student_id = ? AND exam_id = ?
      ORDER BY score_type ASC, question_number ASC
    `, studentId, examId);
  }

  async getStudentTrendData(studentId: number): Promise<StudentTrendPoint[]> {
    const rows = await this.db.all(`
      SELECT
        ss.exam_id AS examId,
        e.name AS examName,
        e.subject,
        COALESCE(e.start_time, e.end_time, e.created_at) AS examTime,
        ss.total_score AS totalScore,
        ROUND(
          (SELECT AVG(s2.total_score) FROM student_scores s2
           WHERE s2.exam_id = ss.exam_id
             AND cs.class_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM class_students cs2
               WHERE cs2.student_id = s2.student_id AND cs2.class_id = cs.class_id
             )),
          1
        ) AS classAvg,
        ROUND(
          (SELECT AVG(s3.total_score) FROM student_scores s3 WHERE s3.exam_id = ss.exam_id),
          1
        ) AS gradeAvg,
        (SELECT COUNT(*) FROM student_scores s4 WHERE s4.exam_id = ss.exam_id) AS classSize,
        (
          SELECT COUNT(*) + 1 FROM student_scores s5
          WHERE s5.exam_id = ss.exam_id AND s5.total_score > ss.total_score
        ) AS rank
      FROM student_scores ss
      JOIN exams e ON e.id = ss.exam_id
      LEFT JOIN (
        SELECT student_id, MIN(class_id) AS class_id FROM class_students GROUP BY student_id
      ) cs ON cs.student_id = ss.student_id
      WHERE ss.student_id = ?
      ORDER BY COALESCE(e.start_time, e.end_time, e.created_at) ASC
    `, studentId) as Array<Omit<StudentTrendPoint, "percentile">>;

    return rows.map((r) => ({
      ...r,
      percentile:
        r.classSize > 1 && r.rank != null
          ? Math.round(((r.classSize - r.rank) / (r.classSize - 1)) * 1000) / 10
          : null as unknown as number
    })) as StudentTrendPoint[];
  }

  async hasScore(studentId: number, examId: number): Promise<boolean> {
    const row = await this.db.get("SELECT 1 FROM student_scores WHERE student_id = ? AND exam_id = ? LIMIT 1", studentId, examId);
    return Boolean(row);
  }
}
