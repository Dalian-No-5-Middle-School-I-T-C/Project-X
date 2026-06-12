import { getDatabase } from "../db";
import Database from "better-sqlite3";
import type { ExamOverview, QuestionAnalysisItem, StudentRankingItem } from "../../shared/types";

export class AnalysisRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  getExamOverview(examId: number): ExamOverview {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as gradedCount,
        ROUND(AVG(total_score), 1) as avgScore,
        ROUND(MAX(total_score), 1) as maxScore,
        ROUND(MIN(total_score), 1) as minScore,
        SUM(CASE WHEN total_score >= 60 THEN 1 ELSE 0 END) as passCount,
        SUM(CASE WHEN total_score >= 85 THEN 1 ELSE 0 END) as excellentCount
      FROM student_scores WHERE exam_id = ?
    `).get(examId) as {
      gradedCount: number; avgScore: number; maxScore: number; minScore: number;
      passCount: number; excellentCount: number;
    } | undefined;

    if (!stats || stats.gradedCount === 0) {
      return {
        totalStudents: 0, gradedCount: 0, avgScore: 0, maxScore: 0, minScore: 0,
        stdDev: 0, passRate: 0, excellentRate: 0, distribution: [], reviewCount: 0
      };
    }

    // StdDev
    const stdDevRow = this.db.prepare(`
      SELECT ROUND(SQRT(AVG((total_score - ?) * (total_score - ?))), 1) as stdDev
      FROM student_scores WHERE exam_id = ?
    `).get(stats.avgScore, stats.avgScore, examId) as { stdDev: number } | undefined;

    // Distribution
    const ranges = [
      { range: "0-59", min: 0, max: 59 },
      { range: "60-69", min: 60, max: 69 },
      { range: "70-79", min: 70, max: 79 },
      { range: "80-89", min: 80, max: 89 },
      { range: "90-100", min: 90, max: 100 }
    ];
    const distribution = ranges.map((r) => {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM student_scores
        WHERE exam_id = ? AND total_score >= ? AND total_score <= ?
      `).get(examId, r.min, r.max) as { cnt: number };
      return { ...r, count: row.cnt };
    });

    // Review count
    const reviewRow = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM question_scores
      WHERE exam_id = ? AND (score = 0 OR score < max_score * 0.5)
    `).get(examId) as { cnt: number };

    return {
      totalStudents: stats.gradedCount,
      gradedCount: stats.gradedCount,
      avgScore: stats.avgScore,
      maxScore: stats.maxScore,
      minScore: stats.minScore,
      stdDev: stdDevRow?.stdDev ?? 0,
      passRate: Math.round((stats.passCount / stats.gradedCount) * 100),
      excellentRate: Math.round((stats.excellentCount / stats.gradedCount) * 100),
      distribution,
      reviewCount: reviewRow?.cnt ?? 0
    };
  }

  getStudentRanking(examId: number): StudentRankingItem[] {
    const rows = this.db.prepare(`
      SELECT
        u.student_number,
        u.name,
        ss.total_score,
        ss.objective_score,
        ss.subjective_score,
        (SELECT COUNT(*) FROM question_scores qs
         WHERE qs.exam_id = ss.exam_id AND qs.student_id = ss.student_id
         AND (qs.score = 0 OR qs.score < qs.max_score * 0.5)) as review_count
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      WHERE ss.exam_id = ?
      ORDER BY ss.total_score DESC
    `).all(examId) as Array<{
      student_number: string; name: string; total_score: number;
      objective_score: number; subjective_score: number; review_count: number;
    }>;

    return rows.map((row, idx) => ({
      rank: idx + 1,
      studentNumber: row.student_number,
      studentName: row.name,
      totalScore: row.total_score,
      objectiveScore: row.objective_score,
      subjectiveScore: row.subjective_score,
      needReview: row.review_count > 0
    }));
  }

  getQuestionAnalysis(examId: number): QuestionAnalysisItem[] {
    const rows = this.db.prepare(`
      SELECT
        qs.question_number,
        qs.score_type as question_type,
        ROUND(AVG(qs.score), 1) as avgScore,
        MAX(qs.max_score) as maxScore,
        COUNT(*) as totalCount,
        SUM(CASE WHEN qs.score >= qs.max_score THEN 1 ELSE 0 END) as correctCount,
        SUM(CASE WHEN qs.score = 0 OR qs.score < qs.max_score * 0.5 THEN 1 ELSE 0 END) as reviewCount
      FROM question_scores qs
      WHERE qs.exam_id = ?
      GROUP BY qs.question_number, qs.score_type
      ORDER BY
        CASE WHEN MAX(qs.max_score) > 0 THEN AVG(qs.score) / MAX(qs.max_score) ELSE 1 END ASC
    `).all(examId) as Array<{
      question_number: number; question_type: string; avgScore: number;
      maxScore: number; totalCount: number; correctCount: number; reviewCount: number;
    }>;

    return rows.map((r) => ({
      questionNumber: String(r.question_number),
      questionType: r.question_type === "objective" ? "客观" : "主观",
      scoreRate: r.maxScore > 0 ? Math.round((r.avgScore / r.maxScore) * 100) : 0,
      correctRate: r.question_type === "objective" && r.totalCount > 0
        ? Math.round((r.correctCount / r.totalCount) * 100) : null,
      avgScore: r.avgScore,
      maxScore: r.maxScore,
      reviewCount: r.reviewCount,
      totalCount: r.totalCount
    }));
  }
}
