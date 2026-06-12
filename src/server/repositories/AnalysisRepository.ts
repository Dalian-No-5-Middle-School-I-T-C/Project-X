import { getDatabase } from "../db";
import Database from "better-sqlite3";
import type { ExamOverview, QuestionAnalysisItem, StudentRankingItem } from "../../shared/types";

function classFilter(classId?: number): { join: string; where: string; params: unknown[] } {
  if (!classId) return { join: "", where: "", params: [] };
  return {
    join: "JOIN class_students cs ON cs.student_id = ss.student_id",
    where: "AND cs.class_id = ?",
    params: [classId]
  };
}

function classFilterQs(classId?: number): { join: string; where: string; params: unknown[] } {
  if (!classId) return { join: "", where: "", params: [] };
  return {
    join: "JOIN class_students cs ON cs.student_id = qs.student_id",
    where: "AND cs.class_id = ?",
    params: [classId]
  };
}

export class AnalysisRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /** List classes that have students with scores for this exam */
  getExamClasses(examId: number): Array<{ classId: number; className: string }> {
    return this.db.prepare(`
      SELECT DISTINCT cs.class_id as classId, c.name as className
      FROM student_scores ss
      JOIN class_students cs ON cs.student_id = ss.student_id
      JOIN classes c ON c.id = cs.class_id
      WHERE ss.exam_id = ?
      ORDER BY c.sort_order, c.name
    `).all(examId) as Array<{ classId: number; className: string }>;
  }

  getExamOverview(examId: number, classId?: number): ExamOverview {
    const c = classFilter(classId);
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as gradedCount,
        ROUND(AVG(ss.total_score), 1) as avgScore,
        ROUND(MAX(ss.total_score), 1) as maxScore,
        ROUND(MIN(ss.total_score), 1) as minScore,
        SUM(CASE WHEN ss.total_score >= 60 THEN 1 ELSE 0 END) as passCount,
        SUM(CASE WHEN ss.total_score >= 85 THEN 1 ELSE 0 END) as excellentCount
      FROM student_scores ss
      ${c.join}
      WHERE ss.exam_id = ? ${c.where}
    `).get(examId, ...c.params) as {
      gradedCount: number; avgScore: number; maxScore: number; minScore: number;
      passCount: number; excellentCount: number;
    } | undefined;

    if (!stats || stats.gradedCount === 0) {
      return {
        totalStudents: 0, gradedCount: 0, avgScore: 0, maxScore: 0, minScore: 0,
        stdDev: 0, passRate: 0, excellentRate: 0, distribution: [], reviewCount: 0
      };
    }

    const stdDevRow = this.db.prepare(`
      SELECT ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as stdDev
      FROM student_scores ss
      ${c.join}
      WHERE ss.exam_id = ? ${c.where}
    `).get(stats.avgScore, stats.avgScore, examId, ...c.params) as { stdDev: number } | undefined;

    const ranges = [
      { range: "0-59", min: 0, max: 59 },
      { range: "60-69", min: 60, max: 69 },
      { range: "70-79", min: 70, max: 79 },
      { range: "80-89", min: 80, max: 89 },
      { range: "90-100", min: 90, max: 100 }
    ];
    const distribution = ranges.map((r) => {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM student_scores ss
        ${c.join}
        WHERE ss.exam_id = ? AND ss.total_score >= ? AND ss.total_score <= ? ${c.where}
      `).get(examId, r.min, r.max, ...c.params) as { cnt: number };
      return { ...r, count: row.cnt };
    });

    const reviewRow = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM question_scores qs
      ${classFilterQs(classId).join}
      WHERE qs.exam_id = ? AND (qs.score = 0 OR qs.score < qs.max_score * 0.5)
      ${classFilterQs(classId).where}
    `).get(examId, ...classFilterQs(classId).params) as { cnt: number };

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

  getStudentRanking(examId: number, classId?: number): StudentRankingItem[] {
    const c = classFilter(classId);
    const rows = this.db.prepare(`
      SELECT
        u.student_number,
        u.name,
        ss.total_score,
        ss.objective_score,
        ss.subjective_score,
        (SELECT COUNT(*) FROM question_scores qs
         WHERE qs.exam_id = ss.exam_id AND qs.student_id = ss.student_id
         AND (qs.score = 0 OR qs.score < qs.max_score * 0.5)) as review_count,
        (SELECT sr.file_path FROM scan_records sr
         JOIN scan_batches sb ON sb.id = sr.batch_id
         WHERE sb.exam_id = ss.exam_id AND sr.student_id = ss.student_id
         ORDER BY sr.created_at DESC LIMIT 1) as scan_path
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      ${c.join}
      WHERE ss.exam_id = ? ${c.where}
      ORDER BY ss.total_score DESC
    `).all(examId, ...c.params) as Array<{
      student_number: string; name: string; total_score: number;
      objective_score: number; subjective_score: number; review_count: number;
      scan_path: string | null;
    }>;

    return rows.map((row, idx) => ({
      rank: idx + 1,
      studentNumber: row.student_number,
      studentName: row.name,
      totalScore: row.total_score,
      objectiveScore: row.objective_score,
      subjectiveScore: row.subjective_score,
      needReview: row.review_count > 0,
      scanImagePath: row.scan_path ?? null
    }));
  }

  getQuestionAnalysis(examId: number, classId?: number): QuestionAnalysisItem[] {
    const c = classFilterQs(classId);
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
      ${c.join}
      WHERE qs.exam_id = ? ${c.where}
      GROUP BY qs.question_number, qs.score_type
      ORDER BY
        CASE WHEN MAX(qs.max_score) > 0 THEN AVG(qs.score) / MAX(qs.max_score) ELSE 1 END ASC
    `).all(examId, ...c.params) as Array<{
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
