import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import type { StudentTrendPoint, StudentSemesterComparison, SemesterSummary } from "../../shared/types";

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

  /**
   * 学生全部考试成绩。
   * @param options.publishedOnly 默认 true（学生自助查分：仅已公布考试）；
   *   教师/管理员代查传 false —— 公布门是学生端读门，不应误伤教师端（评审 P2）。
   */
  async getStudentScores(studentId: number, options: { publishedOnly?: boolean } = {}): Promise<StudentExamScore[]> {
    const publishedOnly = options.publishedOnly ?? true;
    // 公布门是学生端读门：代查模式（教师/管理员）不受 score_published 限制（评审 P2）
    const whereParts = [
      "ss.student_id = ?",
      "-- #246 auto_delete：软删除考试的成绩不再对学生可见",
      "AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)",
    ];
    if (publishedOnly) {
      whereParts.push(
        "-- PR #256（v41）：成绩默认不公布，学生端仅见已公布考试",
        "AND e.score_published = 1",
      );
    }
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
      WHERE ${whereParts.join("\n        ")}
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
        -- #246 auto_delete：软删除考试不进入成长曲线
        AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)
        -- PR #256（v41）：未公布考试不进入成长曲线
        AND e.score_published = 1
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

  private buildSemesterSummary(label: string, points: StudentTrendPoint[]): SemesterSummary {
    const dates = points.map((p) => p.examTime.slice(0, 10)).sort();
    const scores = points.map((p) => p.totalScore);
    const bySubject = new Map<string, StudentTrendPoint[]>();
    for (const point of points) {
      if (!point.subject) continue;
      if (!bySubject.has(point.subject)) bySubject.set(point.subject, []);
      bySubject.get(point.subject)!.push(point);
    }

    return {
      label,
      startDate: dates[0] ?? "",
      endDate: dates[dates.length - 1] ?? "",
      examCount: points.length,
      avgScore: Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10,
      subjects: Array.from(bySubject.entries())
        .map(([subject, subjectPoints]) => {
          const subjectScores = subjectPoints.map((p) => p.totalScore);
          const avgScore = Math.round((subjectScores.reduce((sum, score) => sum + score, 0) / subjectScores.length) * 10) / 10;
          const avgClassGap = Math.round(
            (subjectPoints.reduce((sum, point) => sum + (point.totalScore - point.classAvg), 0) / subjectPoints.length) * 10
          ) / 10;
          return {
            subject,
            examCount: subjectPoints.length,
            avgScore,
            bestScore: Math.max(...subjectScores),
            avgClassGap
          };
        })
        .sort((a, b) => a.subject.localeCompare(b.subject, "zh"))
    };
  }

  async getStudentSemesterComparison(studentId: number): Promise<StudentSemesterComparison> {
    const trends = await this.getStudentTrendData(studentId);
    if (trends.length === 0) {
      return {
        current: null,
        previous: null,
        avgScoreChange: null,
        improvedSubjects: [],
        declinedSubjects: []
      };
    }

    const grouped = new Map<string, { label: string; order: number; points: StudentTrendPoint[] }>();
    for (const point of trends) {
      const date = point.examTime.slice(0, 10);
      const month = Number(date.slice(5, 7));
      const year = Number(date.slice(0, 4));
      const academicStartYear = month >= 8 ? year : year - 1;
      const semesterNum = month >= 8 || month <= 1 ? 1 : 2;
      const key = `${academicStartYear}-${semesterNum}`;
      const label = `${academicStartYear}-${academicStartYear + 1} 第${semesterNum === 1 ? "一" : "二"}学期`;
      const order = academicStartYear * 10 + semesterNum;
      if (!grouped.has(key)) grouped.set(key, { label, order, points: [] });
      grouped.get(key)!.points.push(point);
    }

    const semesters = Array.from(grouped.values()).sort((a, b) => a.order - b.order);
    const currentEntry = semesters[semesters.length - 1];
    const previousEntry = semesters.length >= 2 ? semesters[semesters.length - 2] : null;
    const current = this.buildSemesterSummary(currentEntry.label, currentEntry.points);
    const previous = previousEntry
      ? this.buildSemesterSummary(previousEntry.label, previousEntry.points)
      : null;

    const avgScoreChange = previous
      ? Math.round((current.avgScore - previous.avgScore) * 10) / 10
      : null;

    const improvedSubjects: string[] = [];
    const declinedSubjects: string[] = [];
    if (previous) {
      const prevBySubject = new Map(previous.subjects.map((item) => [item.subject, item.avgScore]));
      for (const subject of current.subjects) {
        const prevAvg = prevBySubject.get(subject.subject);
        if (prevAvg == null) continue;
        const delta = Math.round((subject.avgScore - prevAvg) * 10) / 10;
        if (delta >= 3) improvedSubjects.push(subject.subject);
        else if (delta <= -3) declinedSubjects.push(subject.subject);
      }
    }

    return {
      current,
      previous,
      avgScoreChange,
      improvedSubjects,
      declinedSubjects
    };
  }

  async hasScore(studentId: number, examId: number): Promise<boolean> {
    const row = await this.db.get("SELECT 1 FROM student_scores WHERE student_id = ? AND exam_id = ? LIMIT 1", studentId, examId);
    return Boolean(row);
  }

  /** 成绩是否已公布（v41）：学生自助查分前必须为已公布。 */
  async isExamScorePublished(examId: number): Promise<boolean> {
    const row = await this.db.get("SELECT score_published FROM exams WHERE id = ?", examId) as { score_published?: number } | undefined;
    return row?.score_published === 1;
  }
}
