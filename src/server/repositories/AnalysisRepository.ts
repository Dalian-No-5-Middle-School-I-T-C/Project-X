import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { competitionRank } from "../../shared/ranking";
import { rankPercentile } from "../services/rankingUpdate";
import { getAnalysisThresholds, DEFAULT_ANALYSIS_THRESHOLDS } from "../services/analysisConfig";
import { CardRepository } from "./CardRepository";
import { objectiveQuestionDefinitions } from "../../shared/grading";
import type {
  ClassComparisonClassSummary, ClassComparisonOptionStat, ClassComparisonQuestionStat,
  ClassComparisonResponse, ClassScoreSummary, CrossExamAttendanceMode, CrossExamClassSummary,
  CrossExamGroup, CrossExamTotalExam, CrossExamTotalMode,
  CrossExamTotalRequest, CrossExamTotalResponse, CrossExamTotalRow,
  ErrorRateLevel, ExamFilterItem, ExamOverview, OptionAnalysisQuestion, OptionAnalysisResponse,
  OptionStat, QuestionAnalysisItem,
  PreviousExamComparison, ScoreSummary, ScoreTrendPoint, StudentRankingItem
} from "../../shared/types";

export interface ExportRow {
  className: string; studentNumber: string; name: string; totalScore: number;
  classRank: number | ""; gradeRank: number; objectiveScore: number; subjectiveScore: number;
  questionScores: (number | "")[];
}
export interface ExportData { students: ExportRow[]; questionHeaders: string[]; }

function classFilter(classId?: number): { join: string; where: string; params: unknown[] } {
  if (classId === undefined) return { join: "", where: "", params: [] };
  if (classId === 0) return { join: "", where: "AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = ss.student_id)", params: [] };
  return { join: "JOIN class_students cs ON cs.student_id = ss.student_id", where: "AND cs.class_id = ?", params: [classId] };
}
function classFilterQs(classId?: number): { join: string; where: string; params: unknown[] } {
  if (classId === undefined) return { join: "", where: "", params: [] };
  if (classId === 0) return { join: "", where: "AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = qs.student_id)", params: [] };
  return { join: "JOIN class_students cs ON cs.student_id = qs.student_id", where: "AND cs.class_id = ?", params: [classId] };
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0; if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p; const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function errorRateLevel(rate: number, tiers: [number, number, number] = DEFAULT_ANALYSIS_THRESHOLDS.errorTiers): ErrorRateLevel {
  if (rate >= tiers[0]) return "high"; if (rate >= tiers[1]) return "medium"; if (rate >= tiers[2]) return "low"; return "none";
}
function emptyErrorRateBuckets() { return { low: 0, medium: 0, high: 0 }; }
function countErrorRateBuckets(qs: QuestionAnalysisItem[]) {
  return qs.reduce((b, q) => { if (q.errorRateLevel !== "none") b[q.errorRateLevel]++; return b; }, emptyErrorRateBuckets());
}
function placeholders(v: unknown[]): string { return v.map(() => "?").join(","); }
function normalizeExamIds(v: Array<number | string | null | undefined> | undefined): number[] {
  const s = new Set<number>(); const r: number[] = [];
  for (const raw of v ?? []) { const id = Number(raw); if (Number.isInteger(id) && id > 0 && !s.has(id)) { s.add(id); r.push(id); } }
  return r;
}
function dateOnly(v: string | null | undefined): string | null { if (!v) return null; return String(v).slice(0, 10); }
function addDays(d: string, n: number): string { return new Date(new Date(`${d}T00:00:00.000Z`).getTime() + n * 86400000).toISOString().slice(0, 10); }
function generateDistributionRanges(fullScore: number, segmentSize: number = DEFAULT_ANALYSIS_THRESHOLDS.segmentSize) {
  const step = Math.max(1, Math.round(segmentSize));
  const r: Array<{ range: string; min: number; max: number }> = [];
  for (let min = 0; min < fullScore; min += step) r.push({ range: `${min}-${Math.min(min + step - 1, fullScore)}`, min, max: Math.min(min + step - 1, fullScore) });
  return r;
}

const OPTION_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type ObjectiveDef = { mode: string; optionCount: number; maxScore: number; answerKey: string[] };

export class AnalysisRepository {
  private db: DbAdapter;
  private cardRepo: CardRepository;
  constructor() { this.db = getMysqlDb(); this.cardRepo = new CardRepository(); }

  async getExamClasses(examId: number): Promise<Array<{ classId: number; className: string; gradeName?: string }>> {
    const classes = await this.db.all(`SELECT DISTINCT cs.class_id as classId, c.name as className, g.name as gradeName FROM student_scores ss JOIN class_students cs ON cs.student_id = ss.student_id JOIN classes c ON c.id = cs.class_id LEFT JOIN grades g ON g.id = c.grade_id WHERE ss.exam_id = ? ORDER BY g.sort_order, c.sort_order, c.name`, examId);
    const unknown = await this.db.get(`SELECT COUNT(*) as count FROM student_scores ss WHERE ss.exam_id = ? AND NOT EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = ss.student_id)`, examId) as { count: number };
    const result = classes.map((c: any) => ({ ...c, gradeName: c.gradeName ?? undefined }));
    return unknown.count > 0 ? [...result, { classId: 0, className: "未知班级", gradeName: "无年级" }] : result;
  }

  async getExam(examId: number): Promise<{ name: string } | undefined> {
    return await this.db.get("SELECT name FROM exams WHERE id = ?", examId) ?? undefined;
  }

  async getExamFilterItemsByIds(examIds: number[]): Promise<ExamFilterItem[]> {
    const ids = normalizeExamIds(examIds);
    if (ids.length === 0) return [];
    return await this.db.all(`SELECT e.id, e.name, e.subject, e.grade_id, g.name as grade_name, date(COALESCE(ac.exam_date, e.created_at)) as exam_date, e.status, COUNT(ss.exam_id) as graded_count, ROUND(AVG(ss.total_score), 1) as avg_score, CASE WHEN e.assigned_formula IS NOT NULL AND e.assigned_formula != '' THEN 1 ELSE 0 END as has_assigned_score FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id LEFT JOIN grades g ON g.id = e.grade_id LEFT JOIN student_scores ss ON ss.exam_id = e.id WHERE e.id IN (${placeholders(ids)}) GROUP BY e.id ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC`, ...ids);
  }

  async listExamGroups(createdBy?: number): Promise<CrossExamGroup[]> {
    const rows = createdBy == null
      ? await this.db.all("SELECT * FROM exam_groups WHERE source IN ('cross-manual', 'week') ORDER BY updated_at DESC, id DESC")
      : await this.db.all("SELECT * FROM exam_groups WHERE created_by = ? AND source IN ('cross-manual', 'week') ORDER BY updated_at DESC, id DESC", createdBy);
    const results: CrossExamGroup[] = [];
    for (const row of rows as any[]) results.push(await this.hydrateExamGroup(row));
    return results;
  }

  async getExamGroup(groupId: number): Promise<CrossExamGroup | null> {
    const row = await this.db.get("SELECT * FROM exam_groups WHERE id = ?", groupId);
    return row ? await this.hydrateExamGroup(row) : null;
  }

  async createExamGroup(params: { name: string; examIds: number[]; source?: string; startDate?: string | null; endDate?: string | null; createdBy?: number | null }): Promise<CrossExamGroup> {
    const examIds = normalizeExamIds(params.examIds);
    if (examIds.length === 0) throw new Error("考试组至少需要一场考试");
    const groupId = await this.db.transaction(async (tx) => {
      const info = await tx.run("INSERT INTO exam_groups (name, source, start_date, end_date, created_by) VALUES (?, ?, ?, ?, ?)", params.name.trim(), params.source ?? "manual", params.startDate ?? null, params.endDate ?? null, params.createdBy ?? null);
      const gid = info.lastInsertRowid;
      for (let i = 0; i < examIds.length; i++) {
        await tx.run("INSERT INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, ?)", gid, examIds[i], i);
      }
      return gid;
    });
    return (await this.getExamGroup(groupId))!;
  }

  async deleteExamGroup(groupId: number, userId: number, isAdmin: boolean): Promise<boolean> {
    const row = await this.db.get("SELECT created_by FROM exam_groups WHERE id = ?", groupId) as any;
    if (!row) return false;
    if (!isAdmin && row.created_by !== userId) return false;
    await this.db.run("DELETE FROM exam_groups WHERE id = ?", groupId);
    return true;
  }

  async getExamIdsForDatePackage(params: { startDate?: string; endDate?: string; gradeId?: number; subject?: string; visibleExamIds?: number[] | null }): Promise<number[]> {
    const endDate = params.endDate || new Date().toISOString().slice(0, 10);
    const startDate = params.startDate || addDays(endDate, -6);
    if (params.visibleExamIds && params.visibleExamIds.length === 0) return [];
    let sql = `SELECT e.id FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id WHERE date(COALESCE(ac.exam_date, e.created_at)) >= date(?) AND date(COALESCE(ac.exam_date, e.created_at)) <= date(?)`;
    const q: unknown[] = [startDate, endDate];
    if (params.gradeId) { sql += " AND e.grade_id = ?"; q.push(params.gradeId); }
    if (params.subject) { sql += " AND e.subject = ?"; q.push(params.subject); }
    if (params.visibleExamIds) { sql += ` AND e.id IN (${placeholders(params.visibleExamIds)})`; q.push(...params.visibleExamIds); }
    sql += " ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC";
    return (await this.db.all(sql, ...q) as Array<{ id: number }>).map(r => r.id);
  }

  async getCrossExamTotal(request: CrossExamTotalRequest, options?: { visibleExamIds?: number[] | null }): Promise<CrossExamTotalResponse> {
    const mode = request.mode;
    const group = mode === "group" && request.groupId ? await this.getExamGroup(request.groupId) : null;
    let examIds = mode === "week"
      ? await this.getExamIdsForDatePackage({ startDate: request.startDate, endDate: request.endDate, gradeId: request.gradeId, subject: request.subject, visibleExamIds: options?.visibleExamIds })
      : mode === "group" ? group?.examIds ?? []
      : normalizeExamIds(request.examIds);
    if (options?.visibleExamIds) { const v = new Set(options.visibleExamIds); examIds = examIds.filter(id => v.has(id)); }
    examIds = normalizeExamIds(examIds);
    if (examIds.length === 0) return this.emptyCrossExamTotal(mode, group);
    const exams = await this.getCrossExamTotalExams(examIds);
    const examOrder = new Map(exams.map((e, i) => [e.id, i]));
    const totalFullScore = round1(exams.reduce((s, e) => s + e.fullScore, 0));
    const scores = await this.getCrossExamScoreRows(examIds, request.gradeId, request.classId);
    const byStudent = new Map<number, CrossExamTotalRow>();
    for (const score of scores) {
      const existing = byStudent.get(score.student_id);
      const row = existing ?? { studentId: score.student_id, studentNumber: score.student_number ?? "", studentName: score.name ?? "", className: score.class_name ?? "未知班级", classId: score.class_id, gradeName: score.grade_name, totalScore: 0, totalFullScore, scoreRate: null, attendedCount: 0, absentCount: 0, gradeRank: 0, classRank: 0, scores: exams.map(e => ({ examId: e.id, score: null, absent: true })) };
      const idx = examOrder.get(score.exam_id);
      if (idx != null) { row.scores[idx] = { examId: score.exam_id, score: round1(Number(score.total_score)), absent: false }; }
      byStudent.set(score.student_id, row);
    }
    let rows = Array.from(byStudent.values()).map(row => {
      const att = row.scores.filter(c => !c.absent && c.score != null);
      return { ...row, totalScore: round1(att.reduce((s, c) => s + Number(c.score), 0)), attendedCount: att.length, absentCount: exams.length - att.length, scoreRate: totalFullScore > 0 ? round1((round1(att.reduce((s, c) => s + Number(c.score), 0)) / totalFullScore) * 100) : null };
    });
    if ((request.attendanceMode ?? "all") === "full") rows = rows.filter(r => r.absentCount === 0);
    rows.sort((a, b) => b.totalScore - a.totalScore || a.studentNumber.localeCompare(b.studentNumber));
    competitionRank(rows, r => r.totalScore, (r, rank) => { r.gradeRank = rank; });
    const byClass = new Map<string, CrossExamTotalRow[]>();
    for (const row of rows) { const k = row.classId == null ? "__unknown__" : String(row.classId); if (!byClass.has(k)) byClass.set(k, []); byClass.get(k)!.push(row); }
    for (const cr of byClass.values()) { cr.sort((a, b) => b.totalScore - a.totalScore); competitionRank(cr, r => r.totalScore, (r, rank) => { r.classRank = rank; }); }
    rows.sort((a, b) => a.gradeRank - b.gradeRank);
    return { mode, group, exams, rows, classSummaries: this.buildCrossExamClassSummaries(rows), summary: this.buildCrossExamSummary(rows, exams.length, totalFullScore) };
  }

  async getExamOverview(examId: number, classId?: number): Promise<ExamOverview> {
    const c = classFilter(classId);
    const thresholds = await getAnalysisThresholds();
    // Bugfix: 使用 GROUP BY + MAX 代替 DISTINCT，避免同一题 max_score 不一致时 fullScore 膨胀
    const totalMax = await this.db.get(`SELECT SUM(max_score) as total FROM (SELECT question_number, score_type, MAX(max_score) as max_score FROM question_scores WHERE exam_id = ? GROUP BY question_number, score_type)`, examId) as any;
    const fullScore = totalMax?.total ?? 100;
    const passLine = fullScore * thresholds.passRate, excellentLine = fullScore * thresholds.excellentRate;
    const stats = await this.db.get(`SELECT COUNT(*) as gradedCount, ROUND(AVG(ss.total_score), 1) as avgScore, ROUND(MAX(ss.total_score), 1) as maxScore, ROUND(MIN(ss.total_score), 1) as minScore, SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as passCount, SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as excellentCount FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where}`, passLine, excellentLine, examId, ...c.params) as any;
    if (!stats || stats.gradedCount === 0) {
      return { totalStudents: 0, gradedCount: 0, avgScore: 0, maxScore: 0, minScore: 0, stdDev: 0, passRate: 0, excellentRate: 0, passScore: round1(passLine), excellentScore: round1(excellentLine), distribution: [], scoreSummary: null, overallScoreSummary: await this.getScoreSummary(examId), classSummaries: await this.getClassScoreSummaries(examId), highErrorQuestionCount: 0, errorRateBuckets: emptyErrorRateBuckets() };
    }
    const stdDevRow = await this.db.get(`SELECT ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as stdDev FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where}`, stats.avgScore, stats.avgScore, examId, ...c.params) as any;
    const ranges = generateDistributionRanges(fullScore, thresholds.segmentSize);
    const distribution = await Promise.all(ranges.map(async (r) => {
      const row = await this.db.get(`SELECT COUNT(*) as cnt FROM student_scores ss ${c.join} WHERE ss.exam_id = ? AND ss.total_score >= ? AND ss.total_score <= ? ${c.where}`, examId, r.min, r.max, ...c.params) as any;
      return { ...r, count: row.cnt };
    }));
    const qa = await this.getQuestionAnalysis(examId, classId);
    const eb = countErrorRateBuckets(qa);
    return { totalStudents: stats.gradedCount, gradedCount: stats.gradedCount, avgScore: stats.avgScore, maxScore: stats.maxScore, minScore: stats.minScore, stdDev: stdDevRow?.stdDev ?? 0, passRate: Math.round((stats.passCount / stats.gradedCount) * 100), excellentRate: Math.round((stats.excellentCount / stats.gradedCount) * 100), passScore: round1(passLine), excellentScore: round1(excellentLine), distribution, scoreSummary: await this.getScoreSummary(examId, classId), overallScoreSummary: await this.getScoreSummary(examId), classSummaries: await this.getClassScoreSummaries(examId), highErrorQuestionCount: eb.low + eb.medium + eb.high, errorRateBuckets: eb };
  }

  async getClassScoreSummaries(examId: number): Promise<ClassScoreSummary[]> {
    const classes = await this.getExamClasses(examId);
    const results: ClassScoreSummary[] = [];
    for (const item of classes) {
      const summary = await this.getScoreSummary(examId, item.classId);
      if (summary) results.push({ ...item, summary });
    }
    return results;
  }

  async getScoreSummary(examId: number, classId?: number): Promise<ScoreSummary | null> {
    const c = classFilter(classId);
    const rows = await this.db.all(`SELECT ss.total_score as totalScore FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where} ORDER BY ss.total_score ASC`, examId, ...c.params) as Array<{ totalScore: number }>;
    const scores = rows.map(r => Number(r.totalScore)).filter(s => Number.isFinite(s));
    if (scores.length === 0) return null;
    const sum = scores.reduce((a, b) => a + b, 0);
    return { min: round1(scores[0]), q1: round1(percentile(scores, 0.25)), median: round1(percentile(scores, 0.5)), q3: round1(percentile(scores, 0.75)), max: round1(scores[scores.length - 1]), avg: round1(sum / scores.length), count: scores.length };
  }

  async findPreviousExam(examId: number): Promise<{ id: number; name: string } | null> {
    const row = await this.db.get(
      `SELECT e.id, e.name
       FROM exams e
       LEFT JOIN answer_cards ac ON ac.id = e.card_id
       CROSS JOIN exams current_exam
       LEFT JOIN answer_cards current_card ON current_card.id = current_exam.card_id
       WHERE current_exam.id = ?
         AND e.subject = current_exam.subject
         AND IFNULL(e.grade_id, -1) = IFNULL(current_exam.grade_id, -1)
         AND e.id != current_exam.id
         AND COALESCE(ac.exam_date, e.start_time, e.end_time, e.created_at)
             < COALESCE(current_card.exam_date, current_exam.start_time, current_exam.end_time, current_exam.created_at)
       ORDER BY COALESCE(ac.exam_date, e.start_time, e.end_time, e.created_at) DESC
       LIMIT 1`,
      examId
    ) as { id: number; name: string } | undefined;
    return row ?? null;
  }

  async getPreviousExamComparison(examId: number, classId?: number): Promise<PreviousExamComparison> {
    const empty: PreviousExamComparison = {
      prevExamId: null,
      prevExamName: null,
      prevAvgScore: null,
      prevPassRate: null,
      avgScoreChange: null,
      passRateChange: null
    };
    const prevExam = await this.findPreviousExam(examId);
    if (!prevExam) return empty;

    const [current, previous] = await Promise.all([
      this.getExamOverview(examId, classId),
      this.getExamOverview(prevExam.id, classId)
    ]);
    if (current.gradedCount === 0 || previous.gradedCount === 0) {
      return {
        ...empty,
        prevExamId: prevExam.id,
        prevExamName: prevExam.name,
        prevAvgScore: previous.gradedCount > 0 ? previous.avgScore : null,
        prevPassRate: previous.gradedCount > 0 ? previous.passRate : null
      };
    }

    return {
      prevExamId: prevExam.id,
      prevExamName: prevExam.name,
      prevAvgScore: previous.avgScore,
      prevPassRate: previous.passRate,
      avgScoreChange: round1(current.avgScore - previous.avgScore),
      passRateChange: current.passRate - previous.passRate
    };
  }

  async getScoreTrend(subject: string, classId?: number): Promise<ScoreTrendPoint[]> {
    const s = subject.trim(); if (!s) return [];
    const gradeRows = await this.db.all(`SELECT e.id as examId, e.name as examName, e.subject as subject, COALESCE(e.start_time, e.end_time, e.created_at) as examTime, ROUND(AVG(ss.total_score), 1) as gradeAvg, COUNT(*) as gradeCount FROM exams e JOIN student_scores ss ON ss.exam_id = e.id WHERE e.subject = ? GROUP BY e.id ORDER BY COALESCE(e.start_time, e.end_time, e.created_at) ASC, e.id ASC`, s) as any[];
    if (classId === undefined) return gradeRows.map(r => ({ examId: r.examId, examName: r.examName, subject: r.subject, examTime: r.examTime, gradeAvg: r.gradeAvg, gradeCount: r.gradeCount }));
    const classRows = classId === 0
      ? await this.db.all(`SELECT e.id as examId, ROUND(AVG(ss.total_score), 1) as classAvg, COUNT(*) as classCount FROM exams e JOIN student_scores ss ON ss.exam_id = e.id WHERE e.subject = ? AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = ss.student_id) GROUP BY e.id`, s) as any[]
      : await this.db.all(`SELECT e.id as examId, ROUND(AVG(ss.total_score), 1) as classAvg, COUNT(*) as classCount FROM exams e JOIN student_scores ss ON ss.exam_id = e.id JOIN class_students cs ON cs.student_id = ss.student_id WHERE e.subject = ? AND cs.class_id = ? GROUP BY e.id`, s, classId) as any[];
    const m = new Map(classRows.map(r => [r.examId, r]));
    return gradeRows.map(r => ({ ...r, classAvg: m.get(r.examId)?.classAvg ?? null, classCount: m.get(r.examId)?.classCount ?? 0 }));
  }

  async getStudentRanking(examId: number, classId?: number): Promise<StudentRankingItem[]> {
    const c = classFilter(classId);
    const tiers = (await getAnalysisThresholds()).errorTiers;
    const rows = await this.db.all(`SELECT u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score, (SELECT COUNT(*) FROM question_scores qs WHERE qs.exam_id = ss.exam_id AND qs.student_id = ss.student_id AND qs.score < qs.max_score * 0.5) as low_score_count, (SELECT COUNT(*) FROM question_scores qs WHERE qs.exam_id = ss.exam_id AND qs.student_id = ss.student_id) as question_count FROM student_scores ss JOIN users u ON u.id = ss.student_id ${c.join} WHERE ss.exam_id = ? ${c.where} ORDER BY ss.total_score DESC`, examId, ...c.params) as any[];
    const items = rows.map((r: any) => ({ rank: 0, studentNumber: r.student_number, studentName: r.name, totalScore: r.total_score, objectiveScore: r.objective_score, subjectiveScore: r.subjective_score, lowScoreCount: r.low_score_count ?? 0, questionCount: r.question_count ?? 0, errorRate: (r.question_count ?? 0) > 0 ? Math.round((r.low_score_count ?? 0) / (r.question_count ?? 1) * 100) : 0, errorRateLevel: errorRateLevel((r.question_count ?? 0) > 0 ? Math.round((r.low_score_count ?? 0) / (r.question_count ?? 1) * 100) : 0, tiers) }));
    competitionRank(items, r => r.totalScore, (r, rank) => { r.rank = rank; });
    return items;
  }

  async getQuestionAnalysis(examId: number, classId?: number): Promise<QuestionAnalysisItem[]> {
    const c = classFilterQs(classId);
    const tiers = (await getAnalysisThresholds()).errorTiers;
    const rows = await this.db.all(`SELECT qs.question_number, qs.score_type as question_type, ROUND(AVG(qs.score), 1) as avgScore, MAX(qs.max_score) as maxScore, COUNT(*) as totalCount, SUM(CASE WHEN qs.score >= qs.max_score THEN 1 ELSE 0 END) as correctCount, SUM(CASE WHEN qs.score < qs.max_score THEN 1 ELSE 0 END) as objectiveErrorCount, SUM(CASE WHEN qs.score < qs.max_score * 0.5 THEN 1 ELSE 0 END) as subjectiveLowScoreCount FROM question_scores qs ${c.join} WHERE qs.exam_id = ? ${c.where} GROUP BY qs.question_number, qs.score_type ORDER BY CASE WHEN MAX(qs.max_score) > 0 THEN AVG(qs.score) / MAX(qs.max_score) ELSE 1 END ASC`, examId, ...c.params) as any[];
    return rows.map((r: any) => {
      const isObj = r.question_type === "objective", errCnt = isObj ? r.objectiveErrorCount : r.subjectiveLowScoreCount, errRate = r.totalCount > 0 ? Math.round((errCnt / r.totalCount) * 100) : 0;
      return { questionNumber: String(r.question_number), questionType: isObj ? "客观" : "主观", scoreRate: r.maxScore > 0 ? Math.round((r.avgScore / r.maxScore) * 100) : 0, correctRate: isObj && r.totalCount > 0 ? Math.round((r.correctCount / r.totalCount) * 100) : null, avgScore: r.avgScore, maxScore: r.maxScore, errorCount: errCnt, errorRate: errRate, errorRateLevel: errorRateLevel(errRate, tiers), totalCount: r.totalCount };
    });
  }

  /** 从答题卡解析客观题元数据（题号 → 模式/选项数/满分/标准答案） */
  private async getObjectiveDefs(examId: number): Promise<Map<number, ObjectiveDef>> {
    const defs = new Map<number, ObjectiveDef>();
    const exam = await this.db.get("SELECT card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
    if (!exam?.card_id) return defs;
    const card = await this.cardRepo.findById(exam.card_id);
    if (!card) return defs;
    for (const block of card.bodyBlocks) {
      if (block.type !== "objective") continue;
      for (const def of objectiveQuestionDefinitions(block)) {
        defs.set(def.questionNumber, {
          mode: def.mode, optionCount: def.optionCount,
          maxScore: def.score, answerKey: def.answerKey ?? []
        });
      }
    }
    return defs;
  }

  /** B2: 逐题选项分析 — 每道客观题各选项的选择人数/比例、未答人数、满分率 */
  async getOptionAnalysis(examId: number, classId?: number): Promise<OptionAnalysisResponse> {
    const empty: OptionAnalysisResponse = { hasOptionData: false, questions: [] };
    const defs = await this.getObjectiveDefs(examId);
    if (defs.size === 0) return empty;

    const c = classFilterQs(classId);
    const rows = await this.db.all(`
      SELECT qs.question_number, qs.selected_options, qs.score, qs.max_score
      FROM question_scores qs ${c.join}
      WHERE qs.exam_id = ? AND qs.score_type = 'objective' AND qs.selected_options IS NOT NULL ${c.where}
    `, examId, ...c.params) as Array<{ question_number: number; selected_options: string | null; score: number; max_score: number }>;
    if (rows.length === 0) return empty;

    type Agg = { total: number; unanswered: number; fullScore: number; counts: Map<string, number> };
    const byQuestion = new Map<number, Agg>();
    for (const r of rows) {
      let agg = byQuestion.get(r.question_number);
      if (!agg) { agg = { total: 0, unanswered: 0, fullScore: 0, counts: new Map() }; byQuestion.set(r.question_number, agg); }
      agg.total++;
      if (r.max_score > 0 && r.score >= r.max_score) agg.fullScore++;
      let opts: string[] = [];
      try { opts = r.selected_options ? JSON.parse(r.selected_options) : []; } catch { opts = []; }
      if (opts.length === 0) { agg.unanswered++; continue; }
      for (const o of opts) agg.counts.set(o, (agg.counts.get(o) ?? 0) + 1);
    }

    const questions: OptionAnalysisQuestion[] = [];
    for (const [qNum, def] of Array.from(defs.entries()).sort((a, b) => a[0] - b[0])) {
      const agg = byQuestion.get(qNum);
      const options: OptionStat[] = OPTION_LABELS.slice(0, def.optionCount).map((label) => {
        const count = agg?.counts.get(label) ?? 0;
        return {
          option: label, count,
          rate: agg && agg.total > 0 ? Math.round((count / agg.total) * 100) : 0,
          isCorrect: def.answerKey.includes(label)
        };
      });
      questions.push({
        questionNumber: qNum,
        mode: def.mode,
        optionCount: def.optionCount,
        maxScore: def.maxScore,
        answerKey: def.answerKey,
        correctRate: agg && agg.total > 0 ? Math.round((agg.fullScore / agg.total) * 100) : null,
        answeredCount: agg ? agg.total - agg.unanswered : 0,
        unansweredCount: agg?.unanswered ?? 0,
        options
      });
    }
    return { hasOptionData: true, questions };
  }

  /** B3: 跨班对比 — 总分统计/分段分布/逐题得分率/（可选）逐题选项，按所选班级拆分 */
  async getClassComparison(examId: number, classIds: number[], includeOptions: boolean): Promise<ClassComparisonResponse> {
    const thresholds = await getAnalysisThresholds();
    // Bugfix: 使用 GROUP BY + MAX 代替 DISTINCT，避免同一题 max_score 不一致时 fullScore 膨胀
    const totalMax = await this.db.get(`SELECT SUM(max_score) as total FROM (SELECT question_number, score_type, MAX(max_score) as max_score FROM question_scores WHERE exam_id = ? GROUP BY question_number, score_type)`, examId) as any;
    const fullScore = totalMax?.total ?? 100;
    const passLine = fullScore * thresholds.passRate, excellentLine = fullScore * thresholds.excellentRate;
    const ranges = generateDistributionRanges(fullScore, thresholds.segmentSize);

    const examClasses = await this.getExamClasses(examId);
    const selected = examClasses.filter((cls) => classIds.includes(cls.classId));

    // ① 各班总分统计 + 分段分布
    const classes: ClassComparisonClassSummary[] = [];
    for (const cls of selected) {
      const c = classFilter(cls.classId);
      const rows = await this.db.all(
        `SELECT ss.total_score as totalScore FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where} ORDER BY ss.total_score ASC`,
        examId, ...c.params
      ) as Array<{ totalScore: number }>;
      const scores = rows.map((r) => Number(r.totalScore)).filter((s) => Number.isFinite(s));
      if (scores.length === 0) continue;
      const sum = scores.reduce((a, b) => a + b, 0);
      const avg = sum / scores.length;
      const variance = scores.reduce((a, b) => a + (b - avg) ** 2, 0) / scores.length;
      const distribution = ranges.map((r) => ({
        ...r, count: scores.filter((s) => s >= r.min && s <= r.max).length
      }));
      classes.push({
        classId: cls.classId, className: cls.className, gradeName: cls.gradeName,
        count: scores.length,
        avgScore: round1(avg),
        maxScore: round1(scores[scores.length - 1]),
        minScore: round1(scores[0]),
        median: round1(percentile(scores, 0.5)),
        stdDev: round1(Math.sqrt(variance)),
        passRate: Math.round((scores.filter((s) => s >= passLine).length / scores.length) * 100),
        excellentRate: Math.round((scores.filter((s) => s >= excellentLine).length / scores.length) * 100),
        distribution
      });
    }

    // ② 逐题 × 逐班得分率（客观题含正确率）
    const qMap = new Map<string, ClassComparisonQuestionStat>();
    for (const cls of selected) {
      const c = classFilterQs(cls.classId);
      const rows = await this.db.all(`
        SELECT qs.question_number, qs.score_type, ROUND(AVG(qs.score), 1) as avgScore, MAX(qs.max_score) as maxScore,
               SUM(CASE WHEN qs.score >= qs.max_score THEN 1 ELSE 0 END) as correctCount, COUNT(*) as cnt
        FROM question_scores qs ${c.join}
        WHERE qs.exam_id = ? ${c.where}
        GROUP BY qs.question_number, qs.score_type
      `, examId, ...c.params) as any[];
      for (const r of rows) {
        const key = `${r.question_number}:${r.score_type}`;
        let item = qMap.get(key);
        if (!item) {
          item = { questionNumber: r.question_number, scoreType: r.score_type, maxScore: r.maxScore, byClass: [] };
          qMap.set(key, item);
        }
        item.byClass.push({
          classId: cls.classId,
          scoreRate: r.maxScore > 0 ? Math.round((r.avgScore / r.maxScore) * 100) : 0,
          correctRate: r.score_type === "objective" && r.cnt > 0 ? Math.round((r.correctCount / r.cnt) * 100) : null
        });
      }
    }
    const questionStats = Array.from(qMap.values()).sort((a, b) => a.questionNumber - b.questionNumber);

    // ③ （可选）逐题 × 逐班 × 选项选择率
    let optionStats: ClassComparisonOptionStat[] | undefined;
    if (includeOptions) {
      const defs = await this.getObjectiveDefs(examId);
      if (defs.size > 0) {
        // per class: 题号 → (选项 → 人次)，及每题总行数（rate 基数）
        const perClass: Array<{ classId: number; totals: Map<number, number>; counts: Map<number, Map<string, number>> }> = [];
        let anyRows = 0;
        for (const cls of selected) {
          const c = classFilterQs(cls.classId);
          const rows = await this.db.all(`
            SELECT qs.question_number, qs.selected_options
            FROM question_scores qs ${c.join}
            WHERE qs.exam_id = ? AND qs.score_type = 'objective' AND qs.selected_options IS NOT NULL ${c.where}
          `, examId, ...c.params) as Array<{ question_number: number; selected_options: string | null }>;
          anyRows += rows.length;
          const totals = new Map<number, number>();
          const counts = new Map<number, Map<string, number>>();
          for (const r of rows) {
            totals.set(r.question_number, (totals.get(r.question_number) ?? 0) + 1);
            let opts: string[] = [];
            try { opts = r.selected_options ? JSON.parse(r.selected_options) : []; } catch { opts = []; }
            if (opts.length === 0) continue;
            let m = counts.get(r.question_number);
            if (!m) { m = new Map(); counts.set(r.question_number, m); }
            for (const o of opts) m.set(o, (m.get(o) ?? 0) + 1);
          }
          perClass.push({ classId: cls.classId, totals, counts });
        }
        if (anyRows > 0) {
          optionStats = [];
          for (const [qNum, def] of Array.from(defs.entries()).sort((a, b) => a[0] - b[0])) {
            optionStats.push({
              questionNumber: qNum,
              answerKey: def.answerKey,
              byClass: perClass.map((pc) => {
                const total = pc.totals.get(qNum) ?? 0;
                const counts = pc.counts.get(qNum);
                return {
                  classId: pc.classId,
                  options: OPTION_LABELS.slice(0, def.optionCount).map((label) => {
                    const count = counts?.get(label) ?? 0;
                    return {
                      option: label, count,
                      rate: total > 0 ? Math.round((count / total) * 100) : 0,
                      isCorrect: def.answerKey.includes(label)
                    } as OptionStat;
                  })
                };
              })
            });
          }
        }
      }
    }

    return { classes, questionStats, ...(optionStats ? { optionStats } : {}) };
  }

  async getExportData(examId: number, classId?: number): Promise<ExportData> {
    const allStudents = await this.db.all(`SELECT ss.student_id, u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score, c.name as class_name, c.id as class_id FROM student_scores ss JOIN users u ON u.id = ss.student_id LEFT JOIN class_students cs ON cs.student_id = ss.student_id LEFT JOIN classes c ON c.id = cs.class_id WHERE ss.exam_id = ? ORDER BY ss.total_score DESC`, examId) as any[];
    if (allStudents.length === 0) return { students: [], questionHeaders: [] };
    const questionList = await this.db.all(`SELECT question_number, score_type, MAX(max_score) as max_score FROM question_scores WHERE exam_id = ? GROUP BY question_number, score_type ORDER BY question_number`, examId) as any[];
    const qHeaders = questionList.map((q: any) => String(q.question_number));
    const allQS = await this.db.all(`SELECT student_id, question_number, score FROM question_scores WHERE exam_id = ?`, examId) as any[];
    const qsLookup = new Map<number, Map<number, number>>();
    for (const qs of allQS) { if (!qsLookup.has(qs.student_id)) qsLookup.set(qs.student_id, new Map()); qsLookup.get(qs.student_id)!.set(qs.question_number, qs.score); }
    type R = any;
    const graded: R[] = allStudents.map((s: any) => ({ ...s, gradeRank: 0, classRank: "" }));
    competitionRank(graded, (r: R) => r.total_score, (r: R, rank: number) => { r.gradeRank = rank; });
    const cg = new Map<string, R[]>();
    for (const s of graded) { const k = s.class_name ?? "__unassigned__"; if (!cg.has(k)) cg.set(k, []); cg.get(k)!.push(s); }
    for (const g of cg.values()) competitionRank(g, (r: R) => r.total_score, (r: R, rank: number) => { r.classRank = rank; });
    const filtered = classId === undefined ? graded : classId === 0 ? graded.filter((s: any) => s.class_id == null) : graded.filter((s: any) => s.class_id === classId);
    return { students: filtered.map((s: any) => ({ className: s.class_name ?? "未知班级", studentNumber: s.student_number ?? "", name: s.name ?? "", totalScore: s.total_score, classRank: s.classRank, gradeRank: s.gradeRank, objectiveScore: s.objective_score, subjectiveScore: s.subjective_score, questionScores: questionList.map((q: any) => { const m = qsLookup.get(s.student_id); if (!m) return ""; const sc = m.get(q.question_number); return sc !== undefined ? sc : ""; }) })), questionHeaders: qHeaders };
  }

  async getScoreTableData(examId: number, classId?: number, displayMode: "deviation" | "zscore" | "percentile" = "deviation"): Promise<any> {
    const exam = await this.db.get(`SELECT e.name, e.subject, ac.exam_date, e.assigned_formula FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id WHERE e.id = ?`, examId) as any;
    if (!exam) throw new Error("考试不存在");
    const hasAssigned = !!(exam.assigned_formula && exam.assigned_formula !== "");
    const allStudents = await this.db.all(`SELECT ss.student_id, u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score, ss.assigned_score, c.name as class_name, c.id as class_id, g.name as grade_name FROM student_scores ss JOIN users u ON u.id = ss.student_id LEFT JOIN class_students cs ON cs.student_id = ss.student_id LEFT JOIN classes c ON c.id = cs.class_id LEFT JOIN grades g ON g.id = c.grade_id WHERE ss.exam_id = ? ORDER BY ss.total_score DESC`, examId) as any[];
    if (allStudents.length === 0) return { examName: exam.name, subject: exam.subject, examDate: exam.exam_date, hasAssignedScore: hasAssigned, rows: [], totalCount: 0 };
    const gradeRanked = allStudents.map((s: any) => ({ ...s, gradeRank: 0, classRank: 0 }));
    competitionRank(gradeRanked, (r: any) => r.total_score, (r: any, rank: number) => { r.gradeRank = rank; });
    const cg = new Map<string, any[]>();
    for (const s of gradeRanked) { const k = s.class_name ?? "__unassigned__"; if (!cg.has(k)) cg.set(k, []); cg.get(k)!.push(s); }
    for (const g of cg.values()) competitionRank(g, (r: any) => r.total_score, (r: any, rank: number) => { r.classRank = rank; });
    let filtered = gradeRanked;
    if (classId === 0) filtered = gradeRanked.filter((s: any) => s.class_id == null);
    else if (classId !== undefined) filtered = gradeRanked.filter((s: any) => s.class_id === classId);
    // P1-6: 偏差值/Z值的均值与标准差应基于全体考生，而非筛选后的班级
    const allScores = gradeRanked.map((s: any) => s.total_score);
    const populationMean = allScores.reduce((a: number, b: number) => a + b, 0) / allScores.length;
    const populationVariance = allScores.reduce((a: number, b: number) => a + (b - populationMean) ** 2, 0) / allScores.length;
    const populationStd = Math.sqrt(populationVariance);
    const prevExam = await this.findPreviousExam(examId);
    let prevRankMap = new Map<number, number>();
    if (prevExam) {
      const prevStudents = await this.db.all(`SELECT student_id, total_score FROM student_scores WHERE exam_id = ? ORDER BY total_score DESC`, prevExam.id) as any[];
      competitionRank(prevStudents, (r: any) => r.total_score, (r: any, rank: number) => prevRankMap.set(r.student_id, rank));
    }
    const rows = filtered.map((s: any) => {
      const prevRank = prevRankMap.get(s.student_id) ?? null;
      const rankChange = prevRank != null ? prevRank - s.gradeRank : null;
      let dv: number | null = null;
      if (displayMode === "deviation") dv = populationStd > 0 ? Math.round((50 + 10 * (s.total_score - populationMean) / populationStd) * 10) / 10 : 50;
      else if (displayMode === "zscore") dv = populationStd > 0 ? Math.round(((s.total_score - populationMean) / populationStd) * 100) / 100 : 0;
      else if (displayMode === "percentile") dv = rankPercentile(s.gradeRank, allStudents.length);
      return { studentId: s.student_id, studentNumber: s.student_number, studentName: s.name, className: s.class_name ?? "未知班级", classId: s.class_id, gradeName: s.grade_name ?? null, totalScore: s.total_score, assignedScore: s.assigned_score, gradeRank: s.gradeRank, classRank: s.classRank ?? 0, rankChange, prevRank, prevExamName: prevExam?.name ?? null, displayValue: dv, objectiveScore: s.objective_score, subjectiveScore: s.subjective_score };
    });
    if (classId !== undefined && classId !== 0) rows.sort((a, b) => a.classRank - b.classRank);
    else rows.sort((a, b) => a.gradeRank - b.gradeRank);
    return { examName: exam.name, subject: exam.subject, examDate: exam.exam_date, hasAssignedScore: hasAssigned, rows, totalCount: rows.length };
  }

  private async hydrateExamGroup(row: any): Promise<CrossExamGroup> {
    const items = await this.db.all("SELECT exam_id FROM exam_group_members WHERE group_id = ? ORDER BY sort_order ASC, exam_id ASC", row.id) as Array<{ exam_id: number }>;
    const examIds = items.map(i => i.exam_id);
    return { id: row.id, name: row.name, source: row.source, startDate: row.start_date, endDate: row.end_date, examIds, exams: await this.getExamFilterItemsByIds(examIds), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private emptyCrossExamTotal(mode: CrossExamTotalMode, group: CrossExamGroup | null): CrossExamTotalResponse {
    return { mode, group, exams: [], rows: [], classSummaries: [], summary: { examCount: 0, studentCount: 0, totalFullScore: 0, avgTotalScore: 0, maxTotalScore: 0, minTotalScore: 0, fullAttendanceCount: 0 } };
  }

  private async getCrossExamTotalExams(examIds: number[]): Promise<CrossExamTotalExam[]> {
    const fullScores = await this.getExamFullScoreMap(examIds);
    const rows = await this.db.all(`SELECT e.id, e.name, e.subject, g.name as gradeName, date(COALESCE(ac.exam_date, e.created_at)) as examDate, COUNT(ss.exam_id) as gradedCount, ROUND(AVG(ss.total_score), 1) as avgScore FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id LEFT JOIN grades g ON g.id = e.grade_id LEFT JOIN student_scores ss ON ss.exam_id = e.id WHERE e.id IN (${placeholders(examIds)}) GROUP BY e.id ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC`, ...examIds) as any[];
    return rows.map((r: any) => ({ id: r.id, name: r.name, subject: r.subject, gradeName: r.gradeName, examDate: dateOnly(r.examDate), fullScore: round1(fullScores.get(r.id) ?? 0), gradedCount: r.gradedCount, avgScore: r.avgScore }));
  }

  private async getExamFullScoreMap(examIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    const qRows = await this.db.all(`SELECT exam_id, SUM(max_score) as fullScore FROM (SELECT exam_id, question_number, score_type, MAX(max_score) as max_score FROM question_scores WHERE exam_id IN (${placeholders(examIds)}) GROUP BY exam_id, question_number, score_type) GROUP BY exam_id`, ...examIds) as any[];
    for (const r of qRows) if (r.fullScore != null && r.fullScore > 0) result.set(r.exam_id, Number(r.fullScore));
    const missing = examIds.filter(id => !result.has(id));
    if (missing.length > 0) {
      const fb = await this.db.all(`SELECT exam_id, MAX(total_score) as fullScore FROM student_scores WHERE exam_id IN (${placeholders(missing)}) GROUP BY exam_id`, ...missing) as any[];
      for (const r of fb) result.set(r.exam_id, Number(r.fullScore ?? 0));
    }
    for (const id of examIds) if (!result.has(id)) result.set(id, 0);
    return result;
  }

  private async getCrossExamScoreRows(examIds: number[], gradeId?: number, classId?: number): Promise<Array<any>> {
    let sql = `SELECT ss.exam_id, ss.student_id, u.student_number, u.name, c.id as class_id, c.name as class_name, g.name as grade_name, ss.total_score FROM student_scores ss JOIN users u ON u.id = ss.student_id LEFT JOIN class_students cs ON cs.student_id = ss.student_id LEFT JOIN classes c ON c.id = cs.class_id LEFT JOIN grades g ON g.id = c.grade_id WHERE ss.exam_id IN (${placeholders(examIds)})`;
    const params: unknown[] = [...examIds];
    if (classId === 0) sql += " AND c.id IS NULL";
    else if (classId !== undefined) { sql += " AND c.id = ?"; params.push(classId); }
    else if (gradeId) { sql += " AND g.id = ?"; params.push(gradeId); }
    sql += " ORDER BY ss.exam_id ASC, ss.total_score DESC";
    return await this.db.all(sql, ...params) as any[];
  }

  private buildCrossExamSummary(rows: CrossExamTotalRow[], examCount: number, totalFullScore: number): any {
    if (rows.length === 0) return { examCount, studentCount: 0, totalFullScore, avgTotalScore: 0, maxTotalScore: 0, minTotalScore: 0, fullAttendanceCount: 0 };
    const totals = rows.map(r => r.totalScore), sum = totals.reduce((a, b) => a + b, 0);
    return { examCount, studentCount: rows.length, totalFullScore, avgTotalScore: round1(sum / rows.length), maxTotalScore: round1(Math.max(...totals)), minTotalScore: round1(Math.min(...totals)), fullAttendanceCount: rows.filter(r => r.absentCount === 0).length };
  }

  private buildCrossExamClassSummaries(rows: CrossExamTotalRow[]): CrossExamClassSummary[] {
    const groups = new Map<string, CrossExamTotalRow[]>();
    for (const r of rows) { const k = r.classId == null ? "__unknown__" : String(r.classId); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
    return Array.from(groups.values()).map(cr => {
      const first = cr[0], totals = cr.map(r => r.totalScore), sum = totals.reduce((a, b) => a + b, 0);
      return { classId: first.classId, className: first.className, gradeName: first.gradeName, count: cr.length, avgScore: round1(sum / cr.length), maxScore: round1(Math.max(...totals)), minScore: round1(Math.min(...totals)) };
    }).sort((a, b) => (a.gradeName ?? "").localeCompare(b.gradeName ?? "") || a.className.localeCompare(b.className));
  }
}
