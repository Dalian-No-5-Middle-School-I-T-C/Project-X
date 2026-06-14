import { getDatabase } from "../db";
import Database from "better-sqlite3";

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

/**
 * 成绩查询的数据访问层。
 * 主要服务于学生自助查分（只能查自己），以及教师/管理员代查某学生成绩。
 * 排名采用查询时即时计算，避免依赖 student_scores.rank 是否落库。
 */
export class ScoreRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * 获取某学生参加过的所有考试成绩（含即时排名）。
   */
  getStudentScores(studentId: number): StudentExamScore[] {
    const rows = this.db
      .prepare(`
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
      `)
      .all(studentId) as Array<Omit<StudentExamScore, "percentile">>;

    return rows.map((r) => ({
      ...r,
      percentile:
        r.class_size > 1 && r.rank != null
          ? Math.round(((r.class_size - r.rank) / (r.class_size - 1)) * 1000) / 10
          : null
    }));
  }

  /**
   * 获取某学生某场考试的逐题得分明细。
   */
  getStudentQuestionScores(studentId: number, examId: number): StudentQuestionScore[] {
    return this.db
      .prepare(`
        SELECT question_number, question_id, block_id, score, max_score, score_type
        FROM question_scores
        WHERE student_id = ? AND exam_id = ?
        ORDER BY score_type ASC, question_number ASC
      `)
      .all(studentId, examId) as StudentQuestionScore[];
  }

  /**
   * 校验某场考试是否存在该学生的成绩（用于权限/404 判断）。
   */
  hasScore(studentId: number, examId: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM student_scores WHERE student_id = ? AND exam_id = ? LIMIT 1")
      .get(studentId, examId);
    return Boolean(row);
  }
}
