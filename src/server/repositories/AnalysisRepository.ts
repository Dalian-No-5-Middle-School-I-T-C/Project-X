import { getDatabase } from "../db";
import Database from "better-sqlite3";
import type {
  ClassScoreSummary,
  CrossExamAttendanceMode,
  CrossExamClassSummary,
  CrossExamGroup,
  CrossExamTotalExam,
  CrossExamTotalMode,
  CrossExamTotalRequest,
  CrossExamTotalResponse,
  CrossExamTotalRow,
  ErrorRateLevel,
  ExamFilterItem,
  ExamOverview,
  QuestionAnalysisItem,
  ScoreSummary,
  ScoreTrendPoint,
  StudentRankingItem
} from "../../shared/types";

export interface ExportRow {
  className: string;
  studentNumber: string;
  name: string;
  totalScore: number;
  classRank: number | "";
  gradeRank: number;
  objectiveScore: number;
  subjectiveScore: number;
  questionScores: (number | "")[];
}

export interface ExportData {
  students: ExportRow[];
  questionHeaders: string[];
}

function classFilter(classId?: number): { join: string; where: string; params: unknown[] } {
  if (classId === undefined) return { join: "", where: "", params: [] };
  if (classId === 0) return {
    join: "",
    where: "AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = ss.student_id)",
    params: []
  };
  return {
    join: "JOIN class_students cs ON cs.student_id = ss.student_id",
    where: "AND cs.class_id = ?",
    params: [classId]
  };
}

function classFilterQs(classId?: number): { join: string; where: string; params: unknown[] } {
  if (classId === undefined) return { join: "", where: "", params: [] };
  if (classId === 0) return {
    join: "",
    where: "AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = qs.student_id)",
    params: []
  };
  return {
    join: "JOIN class_students cs ON cs.student_id = qs.student_id",
    where: "AND cs.class_id = ?",
    params: [classId]
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 按 10 分一段动态生成分数段，末段截止于满分 */
function generateDistributionRanges(fullScore: number): Array<{ range: string; min: number; max: number }> {
  const step = 10;
  const ranges: Array<{ range: string; min: number; max: number }> = [];
  for (let min = 0; min < fullScore; min += step) {
    const max = Math.min(min + step - 1, fullScore);
    ranges.push({ range: `${min}-${max}`, min, max });
  }
  return ranges;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function errorRateLevel(rate: number): ErrorRateLevel {
  if (rate >= 70) return "high";
  if (rate >= 50) return "medium";
  if (rate >= 30) return "low";
  return "none";
}

function emptyErrorRateBuckets(): { low: number; medium: number; high: number } {
  return { low: 0, medium: 0, high: 0 };
}

function countErrorRateBuckets(questions: QuestionAnalysisItem[]): { low: number; medium: number; high: number } {
  return questions.reduce((buckets, question) => {
    if (question.errorRateLevel !== "none") {
      buckets[question.errorRateLevel] += 1;
    }
    return buckets;
  }, emptyErrorRateBuckets());
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

function normalizeExamIds(examIds: Array<number | string | null | undefined> | undefined): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const raw of examIds ?? []) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class AnalysisRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /** List classes that have students with scores for this exam */
  getExamClasses(examId: number): Array<{ classId: number; className: string; gradeName?: string }> {
    const classes = this.db.prepare(`
      SELECT DISTINCT cs.class_id as classId, c.name as className, g.name as gradeName
      FROM student_scores ss
      JOIN class_students cs ON cs.student_id = ss.student_id
      JOIN classes c ON c.id = cs.class_id
      LEFT JOIN grades g ON g.id = c.grade_id
      WHERE ss.exam_id = ?
      ORDER BY g.sort_order, c.sort_order, c.name
    `).all(examId) as Array<{ classId: number; className: string; gradeName: string | null }>;

    const unknown = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM student_scores ss
      WHERE ss.exam_id = ?
        AND NOT EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = ss.student_id)
    `).get(examId) as { count: number };

    const result = classes.map((c) => ({ ...c, gradeName: c.gradeName ?? undefined }));
    return unknown.count > 0 ? [...result, { classId: 0, className: "未分配班级", gradeName: "无年级" }] : result;
  }

  /** Get exam name for filename */
  getExam(examId: number): { name: string } | undefined {
    return this.db.prepare("SELECT name FROM exams WHERE id = ?").get(examId) as { name: string } | undefined;
  }

  getExamFilterItemsByIds(examIds: number[]): ExamFilterItem[] {
    const ids = normalizeExamIds(examIds);
    if (ids.length === 0) return [];
    return this.db.prepare(`
      SELECT
        e.id,
        e.name,
        e.subject,
        e.grade_id,
        g.name as grade_name,
        date(COALESCE(ac.exam_date, e.created_at)) as exam_date,
        e.status,
        COUNT(ss.id) as graded_count,
        ROUND(AVG(ss.total_score), 1) as avg_score,
        CASE WHEN e.assigned_formula IS NOT NULL AND e.assigned_formula != '' THEN 1 ELSE 0 END as has_assigned_score
      FROM exams e
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      LEFT JOIN grades g ON g.id = e.grade_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      WHERE e.id IN (${placeholders(ids)})
      GROUP BY e.id
      ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC
    `).all(...ids) as ExamFilterItem[];
  }

  listExamGroups(createdBy?: number): CrossExamGroup[] {
    const rows = createdBy == null
      ? this.db.prepare("SELECT * FROM exam_groups ORDER BY updated_at DESC, id DESC").all()
      : this.db.prepare("SELECT * FROM exam_groups WHERE created_by = ? ORDER BY updated_at DESC, id DESC").all(createdBy);
    return (rows as Array<{
      id: number; name: string; source: "manual" | "week"; start_date: string | null; end_date: string | null;
      created_at: string; updated_at: string;
    }>).map((row) => this.hydrateExamGroup(row));
  }

  getExamGroup(groupId: number): CrossExamGroup | null {
    const row = this.db.prepare("SELECT * FROM exam_groups WHERE id = ?").get(groupId) as {
      id: number; name: string; source: "manual" | "week"; start_date: string | null; end_date: string | null;
      created_at: string; updated_at: string;
    } | undefined;
    return row ? this.hydrateExamGroup(row) : null;
  }

  createExamGroup(params: {
    name: string;
    examIds: number[];
    source?: "manual" | "week";
    startDate?: string | null;
    endDate?: string | null;
    createdBy?: number | null;
  }): CrossExamGroup {
    const examIds = normalizeExamIds(params.examIds);
    if (examIds.length === 0) throw new Error("考试组至少需要一场考试");
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO exam_groups (name, source, start_date, end_date, created_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        params.name.trim(),
        params.source ?? "manual",
        params.startDate ?? null,
        params.endDate ?? null,
        params.createdBy ?? null
      );
      const groupId = Number(info.lastInsertRowid);
      const insertItem = this.db.prepare(`
        INSERT INTO exam_group_items (group_id, exam_id, sort_order)
        VALUES (?, ?, ?)
      `);
      examIds.forEach((examId, index) => insertItem.run(groupId, examId, index));
      return groupId;
    });
    return this.getExamGroup(tx())!;
  }

  deleteExamGroup(groupId: number, userId: number, isAdmin: boolean): boolean {
    const row = this.db.prepare("SELECT created_by FROM exam_groups WHERE id = ?").get(groupId) as { created_by: number | null } | undefined;
    if (!row) return false;
    if (!isAdmin && row.created_by !== userId) return false;
    this.db.prepare("DELETE FROM exam_groups WHERE id = ?").run(groupId);
    return true;
  }

  getExamIdsForDatePackage(params: {
    startDate?: string;
    endDate?: string;
    gradeId?: number;
    subject?: string;
    visibleExamIds?: number[] | null;
  }): number[] {
    const endDate = params.endDate || new Date().toISOString().slice(0, 10);
    const startDate = params.startDate || addDays(endDate, -6);
    if (params.visibleExamIds && params.visibleExamIds.length === 0) return [];

    let sql = `
      SELECT e.id
      FROM exams e
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      WHERE date(COALESCE(ac.exam_date, e.created_at)) >= date(?)
        AND date(COALESCE(ac.exam_date, e.created_at)) <= date(?)
    `;
    const queryParams: unknown[] = [startDate, endDate];
    if (params.gradeId) {
      sql += " AND e.grade_id = ?";
      queryParams.push(params.gradeId);
    }
    if (params.subject) {
      sql += " AND e.subject = ?";
      queryParams.push(params.subject);
    }
    if (params.visibleExamIds) {
      sql += ` AND e.id IN (${placeholders(params.visibleExamIds)})`;
      queryParams.push(...params.visibleExamIds);
    }
    sql += " ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC";
    return (this.db.prepare(sql).all(...queryParams) as Array<{ id: number }>).map((row) => row.id);
  }

  getCrossExamTotal(
    request: CrossExamTotalRequest,
    options?: { visibleExamIds?: number[] | null }
  ): CrossExamTotalResponse {
    const mode: CrossExamTotalMode = request.mode;
    const group = mode === "group" && request.groupId ? this.getExamGroup(request.groupId) : null;
    let examIds = mode === "week"
      ? this.getExamIdsForDatePackage({
        startDate: request.startDate,
        endDate: request.endDate,
        gradeId: request.gradeId,
        subject: request.subject,
        visibleExamIds: options?.visibleExamIds
      })
      : mode === "group"
        ? group?.examIds ?? []
        : normalizeExamIds(request.examIds);

    if (options?.visibleExamIds) {
      const visible = new Set(options.visibleExamIds);
      examIds = examIds.filter((id) => visible.has(id));
    }
    examIds = normalizeExamIds(examIds);

    if (examIds.length === 0) {
      return this.emptyCrossExamTotal(mode, group);
    }

    const exams = this.getCrossExamTotalExams(examIds);
    const examOrder = new Map(exams.map((exam, index) => [exam.id, index]));
    const totalFullScore = round1(exams.reduce((sum, exam) => sum + exam.fullScore, 0));
    const scores = this.getCrossExamScoreRows(examIds, request.gradeId, request.classId);
    const byStudent = new Map<number, CrossExamTotalRow>();

    for (const score of scores) {
      const existing = byStudent.get(score.student_id);
      const row = existing ?? {
        studentId: score.student_id,
        studentNumber: score.student_number ?? "",
        studentName: score.name ?? "",
        className: score.class_name ?? "未知班级",
        classId: score.class_id,
        gradeName: score.grade_name,
        totalScore: 0,
        totalFullScore,
        scoreRate: null,
        attendedCount: 0,
        absentCount: 0,
        gradeRank: 0,
        classRank: 0,
        scores: exams.map((exam) => ({ examId: exam.id, score: null, absent: true }))
      };
      const index = examOrder.get(score.exam_id);
      if (index != null) {
        const value = Number(score.total_score);
        row.scores[index] = { examId: score.exam_id, score: round1(value), absent: false };
      }
      byStudent.set(score.student_id, row);
    }

    let rows = Array.from(byStudent.values()).map((row) => {
      const attendedScores = row.scores.filter((cell) => !cell.absent && cell.score != null);
      const totalScore = round1(attendedScores.reduce((sum, cell) => sum + Number(cell.score), 0));
      const attendedCount = attendedScores.length;
      const absentCount = exams.length - attendedCount;
      return {
        ...row,
        totalScore,
        attendedCount,
        absentCount,
        scoreRate: totalFullScore > 0 ? round1((totalScore / totalFullScore) * 100) : null
      };
    });

    const attendanceMode: CrossExamAttendanceMode = request.attendanceMode ?? "all";
    if (attendanceMode === "full") {
      rows = rows.filter((row) => row.absentCount === 0);
    }

    rows.sort((a, b) => b.totalScore - a.totalScore || a.studentNumber.localeCompare(b.studentNumber));
    rows.forEach((row, index) => {
      row.gradeRank = index + 1;
    });

    const byClass = new Map<string, CrossExamTotalRow[]>();
    for (const row of rows) {
      const key = row.classId == null ? "__unknown__" : String(row.classId);
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key)!.push(row);
    }
    for (const classRows of byClass.values()) {
      classRows
        .sort((a, b) => b.totalScore - a.totalScore || a.studentNumber.localeCompare(b.studentNumber))
        .forEach((row, index) => {
          row.classRank = index + 1;
        });
    }
    rows.sort((a, b) => a.gradeRank - b.gradeRank);

    return {
      mode,
      group,
      exams,
      rows,
      classSummaries: this.buildCrossExamClassSummaries(rows),
      summary: this.buildCrossExamSummary(rows, exams.length, totalFullScore)
    };
  }

  getExamOverview(examId: number, classId?: number): ExamOverview {
    const c = classFilter(classId);

    // Get total max possible score for dynamic pass/excellent thresholds
    const totalMax = this.db.prepare(`
      SELECT SUM(max_score) as total FROM (
        SELECT DISTINCT question_number, score_type, max_score FROM question_scores WHERE exam_id = ?
      )
    `).get(examId) as { total: number } | undefined;
    const fullScore = totalMax?.total ?? 100;
    const passLine = fullScore * 0.6;
    const excellentLine = fullScore * 0.9;

    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as gradedCount,
        ROUND(AVG(ss.total_score), 1) as avgScore,
        ROUND(MAX(ss.total_score), 1) as maxScore,
        ROUND(MIN(ss.total_score), 1) as minScore,
        SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as passCount,
        SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as excellentCount
      FROM student_scores ss
      ${c.join}
      WHERE ss.exam_id = ? ${c.where}
    `).get(passLine, excellentLine, examId, ...c.params) as {
      gradedCount: number; avgScore: number; maxScore: number; minScore: number;
      passCount: number; excellentCount: number;
    } | undefined;

    if (!stats || stats.gradedCount === 0) {
      return {
        totalStudents: 0, gradedCount: 0, avgScore: 0, maxScore: 0, minScore: 0,
        stdDev: 0, passRate: 0, excellentRate: 0, distribution: [],
        scoreSummary: null,
        overallScoreSummary: this.getScoreSummary(examId),
        classSummaries: this.getClassScoreSummaries(examId),
        highErrorQuestionCount: 0,
        errorRateBuckets: emptyErrorRateBuckets()
      };
    }

    const stdDevRow = this.db.prepare(`
      SELECT ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as stdDev
      FROM student_scores ss
      ${c.join}
      WHERE ss.exam_id = ? ${c.where}
    `).get(stats.avgScore, stats.avgScore, examId, ...c.params) as { stdDev: number } | undefined;

    const ranges = generateDistributionRanges(fullScore);
    const distribution = ranges.map((r) => {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM student_scores ss
        ${c.join}
        WHERE ss.exam_id = ? AND ss.total_score >= ? AND ss.total_score <= ? ${c.where}
      `).get(examId, r.min, r.max, ...c.params) as { cnt: number };
      return { ...r, count: row.cnt };
    });

    const questionAnalysis = this.getQuestionAnalysis(examId, classId);
    const errorRateBuckets = countErrorRateBuckets(questionAnalysis);

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
      scoreSummary: this.getScoreSummary(examId, classId),
      overallScoreSummary: this.getScoreSummary(examId),
      classSummaries: this.getClassScoreSummaries(examId),
      highErrorQuestionCount: errorRateBuckets.low + errorRateBuckets.medium + errorRateBuckets.high,
      errorRateBuckets
    };
  }

  getClassScoreSummaries(examId: number): ClassScoreSummary[] {
    const classes = this.getExamClasses(examId);
    return classes.flatMap((item) => {
      const summary = this.getScoreSummary(examId, item.classId);
      return summary ? [{ ...item, summary }] : [];
    });
  }

  getScoreSummary(examId: number, classId?: number): ScoreSummary | null {
    const c = classFilter(classId);
    const rows = this.db.prepare(`
      SELECT ss.total_score as totalScore
      FROM student_scores ss
      ${c.join}
      WHERE ss.exam_id = ? ${c.where}
      ORDER BY ss.total_score ASC
    `).all(examId, ...c.params) as Array<{ totalScore: number }>;

    const scores = rows.map((row) => Number(row.totalScore)).filter((score) => Number.isFinite(score));
    if (scores.length === 0) return null;

    const sum = scores.reduce((total, score) => total + score, 0);
    return {
      min: round1(scores[0]),
      q1: round1(percentile(scores, 0.25)),
      median: round1(percentile(scores, 0.5)),
      q3: round1(percentile(scores, 0.75)),
      max: round1(scores[scores.length - 1]),
      avg: round1(sum / scores.length),
      count: scores.length
    };
  }

  getScoreTrend(subject: string, classId?: number): ScoreTrendPoint[] {
    const normalizedSubject = subject.trim();
    if (!normalizedSubject) return [];

    const gradeRows = this.db.prepare(`
      SELECT
        e.id as examId,
        e.name as examName,
        e.subject as subject,
        COALESCE(e.start_time, e.end_time, e.created_at) as examTime,
        ROUND(AVG(ss.total_score), 1) as gradeAvg,
        COUNT(*) as gradeCount
      FROM exams e
      JOIN student_scores ss ON ss.exam_id = e.id
      WHERE e.subject = ?
      GROUP BY e.id
      ORDER BY COALESCE(e.start_time, e.end_time, e.created_at) ASC, e.id ASC
    `).all(normalizedSubject) as Array<{
      examId: number;
      examName: string;
      subject: string;
      examTime: string;
      gradeAvg: number;
      gradeCount: number;
    }>;

    if (classId === undefined) {
      return gradeRows.map((row) => ({
        examId: row.examId,
        examName: row.examName,
        subject: row.subject,
        examTime: row.examTime,
        gradeAvg: row.gradeAvg,
        gradeCount: row.gradeCount
      }));
    }

    const classRows = classId === 0 ? this.db.prepare(`
      SELECT
        e.id as examId,
        ROUND(AVG(ss.total_score), 1) as classAvg,
        COUNT(*) as classCount
      FROM exams e
      JOIN student_scores ss ON ss.exam_id = e.id
      WHERE e.subject = ?
        AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = ss.student_id)
      GROUP BY e.id
    `).all(normalizedSubject) as Array<{ examId: number; classAvg: number; classCount: number }> : this.db.prepare(`
      SELECT
        e.id as examId,
        ROUND(AVG(ss.total_score), 1) as classAvg,
        COUNT(*) as classCount
      FROM exams e
      JOIN student_scores ss ON ss.exam_id = e.id
      JOIN class_students cs ON cs.student_id = ss.student_id
      WHERE e.subject = ? AND cs.class_id = ?
      GROUP BY e.id
    `).all(normalizedSubject, classId) as Array<{ examId: number; classAvg: number; classCount: number }>;

    const classByExam = new Map(classRows.map((row) => [row.examId, row]));
    return gradeRows.map((row) => {
      const classRow = classByExam.get(row.examId);
      return {
        examId: row.examId,
        examName: row.examName,
        subject: row.subject,
        examTime: row.examTime,
        gradeAvg: row.gradeAvg,
        gradeCount: row.gradeCount,
        classAvg: classRow?.classAvg ?? null,
        classCount: classRow?.classCount ?? 0
      };
    });
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
         AND qs.score < qs.max_score * 0.5) as low_score_count,
        (SELECT COUNT(*) FROM question_scores qs
         WHERE qs.exam_id = ss.exam_id AND qs.student_id = ss.student_id) as question_count
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      ${c.join}
      WHERE ss.exam_id = ? ${c.where}
      ORDER BY ss.total_score DESC
    `).all(examId, ...c.params) as Array<{
      student_number: string; name: string; total_score: number;
      objective_score: number; subjective_score: number; low_score_count: number; question_count: number;
    }>;

    return rows.map((row, idx) => {
      const questionCount = row.question_count ?? 0;
      const lowScoreCount = row.low_score_count ?? 0;
      const errorRate = questionCount > 0 ? Math.round((lowScoreCount / questionCount) * 100) : 0;
      return {
        rank: idx + 1,
        studentNumber: row.student_number,
        studentName: row.name,
        totalScore: row.total_score,
        objectiveScore: row.objective_score,
        subjectiveScore: row.subjective_score,
        lowScoreCount,
        questionCount,
        errorRate,
        errorRateLevel: errorRateLevel(errorRate)
      };
    });
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
        SUM(CASE WHEN qs.score < qs.max_score THEN 1 ELSE 0 END) as objectiveErrorCount,
        SUM(CASE WHEN qs.score < qs.max_score * 0.5 THEN 1 ELSE 0 END) as subjectiveLowScoreCount
      FROM question_scores qs
      ${c.join}
      WHERE qs.exam_id = ? ${c.where}
      GROUP BY qs.question_number, qs.score_type
      ORDER BY
        CASE WHEN MAX(qs.max_score) > 0 THEN AVG(qs.score) / MAX(qs.max_score) ELSE 1 END ASC
    `).all(examId, ...c.params) as Array<{
      question_number: number; question_type: string; avgScore: number;
      maxScore: number; totalCount: number; correctCount: number; objectiveErrorCount: number; subjectiveLowScoreCount: number;
    }>;

    return rows.map((r) => {
      const isObjective = r.question_type === "objective";
      const errorCount = isObjective ? r.objectiveErrorCount : r.subjectiveLowScoreCount;
      const errorRate = r.totalCount > 0 ? Math.round((errorCount / r.totalCount) * 100) : 0;
      return {
        questionNumber: String(r.question_number),
        questionType: isObjective ? "客观" : "主观",
        scoreRate: r.maxScore > 0 ? Math.round((r.avgScore / r.maxScore) * 100) : 0,
        correctRate: isObjective && r.totalCount > 0
          ? Math.round((r.correctCount / r.totalCount) * 100) : null,
        avgScore: r.avgScore,
        maxScore: r.maxScore,
        errorCount,
        errorRate,
        errorRateLevel: errorRateLevel(errorRate),
        totalCount: r.totalCount
      };
    });
  }

  /** Full data for CSV/XLS export — students + rankings + per-question scores */
  getExportData(examId: number, classId?: number): ExportData {
    type StudentRow = {
      student_id: number; student_number: string | null; name: string | null;
      total_score: number; objective_score: number; subjective_score: number;
      class_name: string | null; class_id: number | null;
    };

    // All students for grade ranking (unfiltered)
    const allStudents = this.db.prepare(`
      SELECT
        ss.student_id, u.student_number, u.name,
        ss.total_score, ss.objective_score, ss.subjective_score,
        c.name as class_name, c.id as class_id
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      LEFT JOIN class_students cs ON cs.student_id = ss.student_id
      LEFT JOIN classes c ON c.id = cs.class_id
      WHERE ss.exam_id = ?
      ORDER BY ss.total_score DESC
    `).all(examId) as StudentRow[];

    if (allStudents.length === 0) {
      return { students: [], questionHeaders: [] };
    }

    // Question list for dynamic headers
    const questionList = this.db.prepare(`
      SELECT question_number, score_type, MAX(max_score) as max_score
      FROM question_scores WHERE exam_id = ?
      GROUP BY question_number, score_type
      ORDER BY question_number
    `).all(examId) as Array<{ question_number: number; score_type: string; max_score: number }>;

    const questionHeaders = questionList.map((q) => {
      return `${q.question_number}`;
    });

    // All question scores for this exam (bulk fetch)
    const allQS = this.db.prepare(`
      SELECT student_id, question_number, score
      FROM question_scores WHERE exam_id = ?
    `).all(examId) as Array<{ student_id: number; question_number: number; score: number }>;

    // Build quick lookup: studentId -> questionNumber -> score
    const qsLookup = new Map<number, Map<number, number>>();
    for (const qs of allQS) {
      if (!qsLookup.has(qs.student_id)) qsLookup.set(qs.student_id, new Map());
      qsLookup.get(qs.student_id)!.set(qs.question_number, qs.score);
    }

    // Grade rank (already DESC by total_score)
    type RankedRow = StudentRow & { gradeRank: number; classRank: number | "" };
    const graded: RankedRow[] = allStudents.map((s, i) => ({
      ...s, gradeRank: i + 1, classRank: ""
    }));

    // Class rank: group by class, sort each group by total DESC
    const classGroups = new Map<string, RankedRow[]>();
    for (const s of graded) {
      const key = s.class_name ?? "__unassigned__";
      if (!classGroups.has(key)) classGroups.set(key, []);
      classGroups.get(key)!.push(s);
    }
    for (const group of classGroups.values()) {
      // already sorted by total_score DESC from the original query
      group.forEach((s, i) => (s.classRank = i + 1));
    }

    // Filter by classId if specified
    const filtered = classId === undefined
      ? graded
      : classId === 0
        ? graded.filter((s) => s.class_id == null)
        : graded.filter((s) => s.class_id === classId);

    // Build export rows
    const students: ExportRow[] = filtered.map((s) => ({
      className: s.class_name ?? "未知班级",
      studentNumber: s.student_number ?? "",
      name: s.name ?? "",
      totalScore: s.total_score,
      classRank: s.classRank,
      gradeRank: s.gradeRank,
      objectiveScore: s.objective_score,
      subjectiveScore: s.subjective_score,
      questionScores: questionList.map((q) => {
        const scoreMap = qsLookup.get(s.student_id);
        if (!scoreMap) return "";
        const score = scoreMap.get(q.question_number);
        return score !== undefined ? score : "";
      })
    }));

    return { students, questionHeaders };
  }

  /**
   * v1.4.0: 获取成绩表格数据（含排名变化和偏差值）
   */
  getScoreTableData(
    examId: number,
    classId?: number,
    displayMode: "deviation" | "zscore" | "percentile" = "deviation"
  ): {
    examName: string;
    subject: string | null;
    examDate: string | null;
    hasAssignedScore: boolean;
    rows: Array<{
      studentId: number;
      studentNumber: string;
      studentName: string;
      className: string;
      classId: number | null;
      gradeName: string | null;
      totalScore: number;
      assignedScore: number | null;
      gradeRank: number;
      classRank: number;
      rankChange: number | null;
      prevRank: number | null;
      prevExamName: string | null;
      displayValue: number | null;
      objectiveScore: number;
      subjectiveScore: number;
    }>;
    totalCount: number;
  } {
    // Exam info
    const exam = this.db.prepare(
      `SELECT e.name, e.subject, ac.exam_date, e.assigned_formula
       FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id
       WHERE e.id = ?`
    ).get(examId) as { name: string; subject: string | null; exam_date: string | null; assigned_formula: string | null } | undefined;

    if (!exam) throw new Error("考试不存在");

    const hasAssigned = !!(exam.assigned_formula && exam.assigned_formula !== "");

    // Get all students for grade ranking
    const allStudents = this.db.prepare(`
      SELECT
        ss.student_id, u.student_number, u.name, ss.total_score,
        ss.objective_score, ss.subjective_score, ss.assigned_score,
        c.name as class_name, c.id as class_id,
        g.name as grade_name
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      LEFT JOIN class_students cs ON cs.student_id = ss.student_id
      LEFT JOIN classes c ON c.id = cs.class_id
      LEFT JOIN grades g ON g.id = c.grade_id
      WHERE ss.exam_id = ?
      ORDER BY ss.total_score DESC
    `).all(examId) as Array<{
      student_id: number; student_number: string; name: string;
      total_score: number; objective_score: number; subjective_score: number;
      assigned_score: number | null; class_name: string | null; class_id: number | null;
      grade_name: string | null;
    }>;

    if (allStudents.length === 0) {
      return {
        examName: exam.name,
        subject: exam.subject,
        examDate: exam.exam_date,
        hasAssignedScore: hasAssigned,
        rows: [],
        totalCount: 0
      };
    }

    // Grade rank (already sorted DESC)
    const gradeRanked = allStudents.map((s, i) => ({ ...s, gradeRank: i + 1 }));

    // Class rank
    const classGroups = new Map<string, typeof gradeRanked>();
    for (const s of gradeRanked) {
      const key = s.class_name ?? "__unassigned__";
      if (!classGroups.has(key)) classGroups.set(key, []);
      classGroups.get(key)!.push(s);
    }
    for (const group of classGroups.values()) {
      group.forEach((s, i) => ((s as any).classRank = i + 1));
    }

    // Filter by class
    let filtered = gradeRanked;
    if (classId !== undefined) {
      if (classId === 0) {
        filtered = gradeRanked.filter((s) => s.class_id == null);
      } else {
        filtered = gradeRanked.filter((s) => s.class_id === classId);
      }
    }

    // Mean and std for deviation / zscore
    const scores = filtered.map((s) => s.total_score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);

    // Previous exam (same subject, same grade)
    const prevExam = this.db.prepare(`
      SELECT e.id, e.name
      FROM exams e
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      WHERE e.subject = ? AND e.grade_id = (SELECT grade_id FROM exams WHERE id = ?)
        AND e.id != ?
        AND (ac.exam_date IS NULL OR ac.exam_date < (SELECT ac2.exam_date FROM exams e2 LEFT JOIN answer_cards ac2 ON ac2.id = e2.card_id WHERE e2.id = ?))
      ORDER BY COALESCE(ac.exam_date, e.created_at) DESC
      LIMIT 1
    `).get(exam.subject, examId, examId, examId) as { id: number; name: string } | undefined;

    // Previous exam rankings
    let prevRankMap = new Map<number, number>();
    if (prevExam) {
      const prevStudents = this.db.prepare(`
        SELECT student_id, total_score
        FROM student_scores WHERE exam_id = ?
        ORDER BY total_score DESC
      `).all(prevExam.id) as Array<{ student_id: number; total_score: number }>;
      prevStudents.forEach((s, i) => prevRankMap.set(s.student_id, i + 1));
    }

    // Build rows
    const rows = filtered.map((s) => {
      const prevRank = prevRankMap.get(s.student_id) ?? null;
      const rankChange = prevRank != null ? prevRank - s.gradeRank : null;

      let displayValue: number | null = null;
      if (displayMode === "deviation") {
        displayValue = std > 0 ? Math.round((50 + 10 * (s.total_score - mean) / std) * 10) / 10 : 50;
      } else if (displayMode === "zscore") {
        displayValue = std > 0 ? Math.round(((s.total_score - mean) / std) * 100) / 100 : 0;
      } else if (displayMode === "percentile") {
        displayValue = Math.round((1 - (s.gradeRank - 1) / allStudents.length) * 1000) / 10;
      }

      return {
        studentId: s.student_id,
        studentNumber: s.student_number,
        studentName: s.name,
        className: s.class_name ?? "未知班级",
        classId: s.class_id,
        gradeName: s.grade_name ?? null,
        totalScore: s.total_score,
        assignedScore: s.assigned_score,
        gradeRank: s.gradeRank,
        classRank: (s as any).classRank ?? 0,
        rankChange,
        prevRank,
        prevExamName: prevExam?.name ?? null,
        displayValue,
        objectiveScore: s.objective_score,
        subjectiveScore: s.subjective_score
      };
    });

    // Sort: all grades by gradeRank, single class by classRank
    if (classId !== undefined && classId !== 0) {
      rows.sort((a, b) => a.classRank - b.classRank);
    } else {
      rows.sort((a, b) => a.gradeRank - b.gradeRank);
    }

    return {
      examName: exam.name,
      subject: exam.subject,
      examDate: exam.exam_date,
      hasAssignedScore: hasAssigned,
      rows,
      totalCount: rows.length
    };
  }

  private hydrateExamGroup(row: {
    id: number;
    name: string;
    source: "manual" | "week";
    start_date: string | null;
    end_date: string | null;
    created_at: string;
    updated_at: string;
  }): CrossExamGroup {
    const items = this.db.prepare(`
      SELECT exam_id FROM exam_group_items
      WHERE group_id = ?
      ORDER BY sort_order ASC, exam_id ASC
    `).all(row.id) as Array<{ exam_id: number }>;
    const examIds = items.map((item) => item.exam_id);
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      startDate: row.start_date,
      endDate: row.end_date,
      examIds,
      exams: this.getExamFilterItemsByIds(examIds),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private emptyCrossExamTotal(mode: CrossExamTotalMode, group: CrossExamGroup | null): CrossExamTotalResponse {
    return {
      mode,
      group,
      exams: [],
      rows: [],
      classSummaries: [],
      summary: {
        examCount: 0,
        studentCount: 0,
        totalFullScore: 0,
        avgTotalScore: 0,
        maxTotalScore: 0,
        minTotalScore: 0,
        fullAttendanceCount: 0
      }
    };
  }

  private getCrossExamTotalExams(examIds: number[]): CrossExamTotalExam[] {
    const fullScores = this.getExamFullScoreMap(examIds);
    const rows = this.db.prepare(`
      SELECT
        e.id,
        e.name,
        e.subject,
        g.name as gradeName,
        date(COALESCE(ac.exam_date, e.created_at)) as examDate,
        COUNT(ss.id) as gradedCount,
        ROUND(AVG(ss.total_score), 1) as avgScore
      FROM exams e
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      LEFT JOIN grades g ON g.id = e.grade_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      WHERE e.id IN (${placeholders(examIds)})
      GROUP BY e.id
      ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC
    `).all(...examIds) as Array<{
      id: number;
      name: string;
      subject: string | null;
      gradeName: string | null;
      examDate: string | null;
      gradedCount: number;
      avgScore: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      subject: row.subject,
      gradeName: row.gradeName,
      examDate: dateOnly(row.examDate),
      fullScore: round1(fullScores.get(row.id) ?? 0),
      gradedCount: row.gradedCount,
      avgScore: row.avgScore
    }));
  }

  private getExamFullScoreMap(examIds: number[]): Map<number, number> {
    const result = new Map<number, number>();
    const questionRows = this.db.prepare(`
      SELECT exam_id, SUM(max_score) as fullScore
      FROM (
        SELECT exam_id, question_number, score_type, MAX(max_score) as max_score
        FROM question_scores
        WHERE exam_id IN (${placeholders(examIds)})
        GROUP BY exam_id, question_number, score_type
      )
      GROUP BY exam_id
    `).all(...examIds) as Array<{ exam_id: number; fullScore: number | null }>;
    for (const row of questionRows) {
      if (row.fullScore != null && row.fullScore > 0) result.set(row.exam_id, Number(row.fullScore));
    }

    const missing = examIds.filter((examId) => !result.has(examId));
    if (missing.length > 0) {
      const fallbackRows = this.db.prepare(`
        SELECT exam_id, MAX(total_score) as fullScore
        FROM student_scores
        WHERE exam_id IN (${placeholders(missing)})
        GROUP BY exam_id
      `).all(...missing) as Array<{ exam_id: number; fullScore: number | null }>;
      for (const row of fallbackRows) {
        result.set(row.exam_id, Number(row.fullScore ?? 0));
      }
    }

    for (const examId of examIds) {
      if (!result.has(examId)) result.set(examId, 0);
    }
    return result;
  }

  private getCrossExamScoreRows(examIds: number[], gradeId?: number, classId?: number): Array<{
    exam_id: number;
    student_id: number;
    student_number: string | null;
    name: string | null;
    class_id: number | null;
    class_name: string | null;
    grade_name: string | null;
    total_score: number;
  }> {
    let sql = `
      SELECT
        ss.exam_id,
        ss.student_id,
        u.student_number,
        u.name,
        c.id as class_id,
        c.name as class_name,
        g.name as grade_name,
        ss.total_score
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      LEFT JOIN class_students cs ON cs.student_id = ss.student_id
      LEFT JOIN classes c ON c.id = cs.class_id
      LEFT JOIN grades g ON g.id = c.grade_id
      WHERE ss.exam_id IN (${placeholders(examIds)})
    `;
    const params: unknown[] = [...examIds];
    if (classId !== undefined) {
      if (classId === 0) {
        sql += " AND c.id IS NULL";
      } else {
        sql += " AND c.id = ?";
        params.push(classId);
      }
    } else if (gradeId) {
      sql += " AND g.id = ?";
      params.push(gradeId);
    }
    sql += " ORDER BY ss.exam_id ASC, ss.total_score DESC";
    return this.db.prepare(sql).all(...params) as Array<{
      exam_id: number;
      student_id: number;
      student_number: string | null;
      name: string | null;
      class_id: number | null;
      class_name: string | null;
      grade_name: string | null;
      total_score: number;
    }>;
  }

  private buildCrossExamSummary(rows: CrossExamTotalRow[], examCount: number, totalFullScore: number): CrossExamTotalResponse["summary"] {
    if (rows.length === 0) {
      return {
        examCount,
        studentCount: 0,
        totalFullScore,
        avgTotalScore: 0,
        maxTotalScore: 0,
        minTotalScore: 0,
        fullAttendanceCount: 0
      };
    }
    const totals = rows.map((row) => row.totalScore);
    const sum = totals.reduce((acc, score) => acc + score, 0);
    return {
      examCount,
      studentCount: rows.length,
      totalFullScore,
      avgTotalScore: round1(sum / rows.length),
      maxTotalScore: round1(Math.max(...totals)),
      minTotalScore: round1(Math.min(...totals)),
      fullAttendanceCount: rows.filter((row) => row.absentCount === 0).length
    };
  }

  private buildCrossExamClassSummaries(rows: CrossExamTotalRow[]): CrossExamClassSummary[] {
    const groups = new Map<string, CrossExamTotalRow[]>();
    for (const row of rows) {
      const key = row.classId == null ? "__unknown__" : String(row.classId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    return Array.from(groups.values())
      .map((classRows) => {
        const first = classRows[0];
        const totals = classRows.map((row) => row.totalScore);
        const sum = totals.reduce((acc, score) => acc + score, 0);
        return {
          classId: first.classId,
          className: first.className,
          gradeName: first.gradeName,
          count: classRows.length,
          avgScore: round1(sum / classRows.length),
          maxScore: round1(Math.max(...totals)),
          minScore: round1(Math.min(...totals))
        };
      })
      .sort((a, b) => (a.gradeName ?? "").localeCompare(b.gradeName ?? "") || a.className.localeCompare(b.className));
  }
}
