import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { EXAM_NOT_SOFT_DELETED_SQL, GROUP_MEMBER_NOT_SOFT_DELETED_SQL } from "../../apps/answer-card/server/middleware";
import { competitionRank } from "../../shared/ranking";
import { rankPercentile } from "../services/rankingUpdate";
import { getAnalysisThresholds, DEFAULT_ANALYSIS_THRESHOLDS } from "../services/analysisConfig";
import { analysisCache } from "../services/analysisCache";
import { coefficientOfVariation, cronbachAlpha, discriminationByExtremeGroup, difficulty, histogram, kr20, mean, stdDev, normality, qqPlot } from "../../shared/stats";
import { CardRepository } from "./CardRepository";
import { objectiveQuestionDefinitions } from "../../shared/grading";
import type {
  BorderlineLineKind, BorderlineResponse, BorderlineStudentItem, ClassComparisonClassSummary,
  ClassComparisonOptionStat, ClassComparisonQuestionStat, ClassComparisonResponse, ClassKnowledgeResponse,
  ClassScoreSummary, ComparableExamItem, ComparableResponse, CrossExamAttendanceMode, CrossExamClassSummary,
  CrossExamGroup, CrossExamTotalExam, CrossExamTotalMode,
  CrossExamTotalRequest, CrossExamTotalResponse, CrossExamTotalRow,
  DistributionResult, ExamMetrics, ErrorRateLevel, ExamFilterItem, ExamOverview,
  GroupClassComparisonResponse, GroupMetrics, GroupQuestionAnalysisResponse,
  GroupSubjectMetric, OptionAnalysisQuestion, OptionAnalysisResponse,
  OptionStat, QuestionAnalysisItem, QuestionStudentScore,
  PreviousExamComparison, ScoreSummary, ScoreTrendPoint, StudentRankingItem, StudentTrendPoint,
  SubjectDeviationItem, SubjectDeviationResponse, SubjectQualityPoint, SubjectQualityResponse, WrongQuestionRow
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
  for (let min = 0; min < fullScore; min += step) {
    const upperExclusive = min + step;
    const isLast = upperExclusive >= fullScore;
    const max = isLast ? fullScore : Math.min(upperExclusive - 1, fullScore);
    const range = isLast ? `${min}-${fullScore}` : `${min}-<${upperExclusive}`;
    r.push({ range, min, max });
  }
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

  async createExamGroup(params: { name: string; examIds: number[]; source?: string; startDate?: string | null; endDate?: string | null; gradeId?: number | null; createdBy?: number | null }): Promise<CrossExamGroup> {
    const examIds = normalizeExamIds(params.examIds);
    if (examIds.length === 0) throw new Error("考试组至少需要一场考试");
    const groupId = await this.db.transaction(async (tx) => {
      const info = await tx.run("INSERT INTO exam_groups (name, source, start_date, end_date, grade_id, created_by) VALUES (?, ?, ?, ?, ?, ?)", params.name.trim(), params.source ?? "manual", params.startDate ?? null, params.endDate ?? null, params.gradeId ?? null, params.createdBy ?? null);
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
    // #246 auto_delete：软删除考试不进入周包/跨考统计
    let sql = `SELECT e.id FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id WHERE date(COALESCE(ac.exam_date, e.created_at)) >= date(?) AND date(COALESCE(ac.exam_date, e.created_at)) <= date(?) AND ${EXAM_NOT_SOFT_DELETED_SQL}`;
    const q: unknown[] = [startDate, endDate];
    if (params.gradeId) { sql += " AND e.grade_id = ?"; q.push(params.gradeId); }
    if (params.subject) { sql += " AND e.subject = ?"; q.push(params.subject); }
    if (params.visibleExamIds) { sql += ` AND e.id IN (${placeholders(params.visibleExamIds)})`; q.push(...params.visibleExamIds); }
    sql += " ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC";
    return (await this.db.all(sql, ...q) as Array<{ id: number }>).map(r => r.id);
  }

  async getCrossExamTotal(request: CrossExamTotalRequest, options?: { visibleExamIds?: number[] | null; onlyPublished?: boolean }): Promise<CrossExamTotalResponse> {
    const mode = request.mode;
    const group = mode === "group" && request.groupId ? await this.getExamGroup(request.groupId) : null;
    let examIds = mode === "week"
      ? await this.getExamIdsForDatePackage({ startDate: request.startDate, endDate: request.endDate, gradeId: request.gradeId, subject: request.subject, visibleExamIds: options?.visibleExamIds })
      : mode === "group" ? group?.examIds ?? []
      : normalizeExamIds(request.examIds);
    if (options?.visibleExamIds) { const v = new Set(options.visibleExamIds); examIds = examIds.filter(id => v.has(id)); }
    // PR #256（v41）：学生端跨考聚合仅统计已公布考试（教师端不受限），在考试集合解析后统一过滤
    if (options?.onlyPublished) { examIds = await this.filterPublishedExamIds(examIds); }
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

  /** 概览走内存 LRU 缓存（建议 6），写入口（改分/扫描/阈值/标注）负责失效。 */
  async getExamOverview(examId: number, classId?: number): Promise<ExamOverview> {
    const cacheKey = `overview:${examId}:${classId ?? "all"}`;
    const cached = analysisCache.get<ExamOverview>(cacheKey);
    if (cached) return cached;
    const ov = await this.computeExamOverview(examId, classId);
    analysisCache.set(cacheKey, ov);
    return ov;
  }

  private async computeExamOverview(examId: number, classId?: number): Promise<ExamOverview> {
    const c = classFilter(classId);
    const thresholds = await getAnalysisThresholds();
    // Bugfix: 使用 GROUP BY + MAX 代替 DISTINCT，避免同一题 max_score 不一致时 fullScore 膨胀
    const fullScore = await this.resolveExamFullScore(examId);
    const passLine = fullScore * thresholds.passRate, excellentLine = fullScore * thresholds.excellentRate;
    const stats = await this.db.get(`SELECT COUNT(*) as gradedCount, ROUND(AVG(ss.total_score), 1) as avgScore, AVG(ss.total_score) as avgScoreRaw, ROUND(MAX(ss.total_score), 1) as maxScore, ROUND(MIN(ss.total_score), 1) as minScore, SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as passCount, SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as excellentCount FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where}`, passLine, excellentLine, examId, ...c.params) as any;
    // N+1 收敛：分布/整体分位数/各班汇总一次取分后 JS 分桶，替代逐段 COUNT 与逐班 getScoreSummary
    const filteredScores = await this.fetchExamScores(examId, c);
    const overallScores = classId === undefined ? filteredScores : await this.fetchExamScores(examId, classFilter(undefined));
    const classSummaries = await this.getClassScoreSummaries(examId);
    if (!stats || stats.gradedCount === 0) {
      return { totalStudents: 0, gradedCount: 0, avgScore: 0, maxScore: 0, minScore: 0, stdDev: 0, passRate: 0, excellentRate: 0, passScore: round1(passLine), excellentScore: round1(excellentLine), distribution: [], scoreSummary: null, overallScoreSummary: this.buildScoreSummary(overallScores), classSummaries, highErrorQuestionCount: 0, errorRateBuckets: emptyErrorRateBuckets() };
    }
    // 标准差减数用未四舍五入的真实均值，避免 0.1 舍入对小样本方差的系统性偏差
    const meanBase = stats.avgScoreRaw ?? stats.avgScore;
    const stdDevRow = await this.db.get(`SELECT ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as stdDev FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where}`, meanBase, meanBase, examId, ...c.params) as any;
    // 分桶统一走 histogram 的半开区间语义（floor(v/step)），与分布接口口径一致，避免 59.5 这类小数落段错位
    const distribution = histogram(filteredScores, fullScore, thresholds.segmentSize);
    const qa = await this.getQuestionAnalysis(examId, classId);
    const eb = countErrorRateBuckets(qa);
    return { totalStudents: stats.gradedCount, gradedCount: stats.gradedCount, avgScore: stats.avgScore, maxScore: stats.maxScore, minScore: stats.minScore, stdDev: stdDevRow?.stdDev ?? 0, passRate: Math.round((stats.passCount / stats.gradedCount) * 100), excellentRate: Math.round((stats.excellentCount / stats.gradedCount) * 100), passScore: round1(passLine), excellentScore: round1(excellentLine), distribution, scoreSummary: this.buildScoreSummary(filteredScores), overallScoreSummary: this.buildScoreSummary(overallScores), classSummaries, highErrorQuestionCount: eb.high, errorRateBuckets: eb };
  }

  async getClassScoreSummaries(examId: number): Promise<ClassScoreSummary[]> {
    const classes = await this.getExamClasses(examId);
    // N+1 收敛：一次 LEFT JOIN 拉全部成绩并按 class_id 分桶（classId=null 即无班级记录 → 未知班级）
    const rows = await this.db.all(
      `SELECT ss.total_score as totalScore, cs.class_id as classId
       FROM student_scores ss
       LEFT JOIN class_students cs ON cs.student_id = ss.student_id
       WHERE ss.exam_id = ?`,
      examId
    ) as Array<{ totalScore: number; classId: number | null }>;
    const byClass = new Map<number | null, number[]>();
    for (const r of rows) {
      const list = byClass.get(r.classId) ?? [];
      list.push(Number(r.totalScore));
      byClass.set(r.classId, list);
    }
    const results: ClassScoreSummary[] = [];
    const seen = new Set<number>();
    for (const item of classes) {
      if (seen.has(item.classId)) continue;
      seen.add(item.classId);
      const bucket = byClass.get(item.classId === 0 ? null : item.classId);
      if (!bucket) continue;
      // 与旧 getScoreSummary 一致：无该班成绩时跳过，其余排序后算分位数
      const summary = this.buildScoreSummary(bucket.filter(Number.isFinite).sort((a, b) => a - b));
      if (summary) results.push({ ...item, summary });
    }
    return results;
  }

  /** 拉取某场考试（按班级过滤）的全部 total_score 升序列表，供分布/分位数复用，避免逐段 COUNT。 */
  private async fetchExamScores(examId: number, c: { join: string; where: string; params: unknown[] }): Promise<number[]> {
    const rows = await this.db.all(`SELECT ss.total_score as totalScore FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where} ORDER BY ss.total_score ASC`, examId, ...c.params) as Array<{ totalScore: number }>;
    return rows.map(r => Number(r.totalScore)).filter(s => Number.isFinite(s));
  }

  /** 由升序分数列表构建分位数汇总（与旧 getScoreSummary 行为一致）。 */
  private buildScoreSummary(scores: number[]): ScoreSummary | null {
    if (scores.length === 0) return null;
    const sum = scores.reduce((a, b) => a + b, 0);
    return { min: round1(scores[0]), q1: round1(percentile(scores, 0.25)), median: round1(percentile(scores, 0.5)), q3: round1(percentile(scores, 0.75)), max: round1(scores[scores.length - 1]), avg: round1(sum / scores.length), count: scores.length };
  }

  async getScoreSummary(examId: number, classId?: number): Promise<ScoreSummary | null> {
    return this.buildScoreSummary(await this.fetchExamScores(examId, classFilter(classId)));
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
         AND COALESCE(e.grade_id, -1) = COALESCE(current_exam.grade_id, -1)
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

  async getScoreTrend(subject: string, classId?: number, visibleExamIds?: number[] | null): Promise<ScoreTrendPoint[]> {
    const s = subject.trim(); if (!s) return [];
    // 可见范围：null=全部；空数组=无可见考试；非空=白名单
    if (visibleExamIds != null && visibleExamIds.length === 0) return [];
    const scopeSql = visibleExamIds == null
      ? ""
      : ` AND e.id IN (${visibleExamIds.map(() => "?").join(",")})`;
    const scopeParams = visibleExamIds ?? [];
    const gradeRows = await this.db.all(`SELECT e.id as examId, e.name as examName, e.subject as subject, COALESCE(e.start_time, e.end_time, e.created_at) as examTime, ROUND(AVG(ss.total_score), 1) as gradeAvg, COUNT(*) as gradeCount FROM exams e JOIN student_scores ss ON ss.exam_id = e.id WHERE e.subject = ? AND ${EXAM_NOT_SOFT_DELETED_SQL}${scopeSql} GROUP BY e.id ORDER BY COALESCE(e.start_time, e.end_time, e.created_at) ASC, e.id ASC`, s, ...scopeParams) as any[];
    if (classId === undefined) return gradeRows.map(r => ({ examId: r.examId, examName: r.examName, subject: r.subject, examTime: r.examTime, gradeAvg: r.gradeAvg, gradeCount: r.gradeCount }));
    const classRows = classId === 0
      ? await this.db.all(`SELECT e.id as examId, ROUND(AVG(ss.total_score), 1) as classAvg, COUNT(*) as classCount FROM exams e JOIN student_scores ss ON ss.exam_id = e.id WHERE e.subject = ? AND ${EXAM_NOT_SOFT_DELETED_SQL}${scopeSql} AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = ss.student_id) GROUP BY e.id`, s, ...scopeParams) as any[]
      : await this.db.all(`SELECT e.id as examId, ROUND(AVG(ss.total_score), 1) as classAvg, COUNT(*) as classCount FROM exams e JOIN student_scores ss ON ss.exam_id = e.id JOIN class_students cs ON cs.student_id = ss.student_id WHERE e.subject = ? AND ${EXAM_NOT_SOFT_DELETED_SQL}${scopeSql} AND cs.class_id = ? GROUP BY e.id`, s, ...scopeParams, classId) as any[];
    const m = new Map(classRows.map(r => [r.examId, r]));
    return gradeRows.map(r => ({ ...r, classAvg: m.get(r.examId)?.classAvg ?? null, classCount: m.get(r.examId)?.classCount ?? 0 }));
  }

  async getStudentRanking(examId: number, classId?: number): Promise<StudentRankingItem[]> {
    const c = classFilter(classId);
    const thresholds = await getAnalysisThresholds();
    const tiers = thresholds.errorTiers;
    const lowRatio = thresholds.subjectiveLowScoreRatio;
    // N+1 收敛：把逐行 2 个相关子查询改为「每题聚合派生表 LEFT JOIN + 主查询 GROUP BY」。
    // 派生表按 (exam_id, student_id) 每生一行，避免因 class_students 多班级行导致误乘计数。
    const rows = await this.db.all(`
      SELECT u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score,
             COALESCE(MAX(qsum.low_count), 0) as low_score_count,
             COALESCE(MAX(qsum.q_count), 0) as question_count
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      LEFT JOIN (
        SELECT qs.exam_id, qs.student_id,
               SUM(CASE WHEN qs.score < qs.max_score * ? THEN 1 ELSE 0 END) as low_count,
               COUNT(*) as q_count
        FROM question_scores qs
        WHERE qs.exam_id = ?
        GROUP BY qs.exam_id, qs.student_id
      ) qsum ON qsum.exam_id = ss.exam_id AND qsum.student_id = ss.student_id
      ${c.join}
      WHERE ss.exam_id = ? ${c.where}
      GROUP BY ss.student_id, u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score
      ORDER BY ss.total_score DESC
    `, lowRatio, examId, examId, ...c.params) as any[];
    const items = rows.map((r: any) => ({ rank: 0, studentNumber: r.student_number, studentName: r.name, totalScore: r.total_score, objectiveScore: r.objective_score, subjectiveScore: r.subjective_score, lowScoreCount: r.low_score_count ?? 0, questionCount: r.question_count ?? 0, errorRate: (r.question_count ?? 0) > 0 ? Math.round((r.low_score_count ?? 0) / (r.question_count ?? 1) * 100) : 0, errorRateLevel: errorRateLevel((r.question_count ?? 0) > 0 ? Math.round((r.low_score_count ?? 0) / (r.question_count ?? 1) * 100) : 0, tiers) }));
    competitionRank(items, r => r.totalScore, (r, rank) => { r.rank = rank; });
    return items;
  }

  async getQuestionAnalysis(examId: number, classId?: number): Promise<QuestionAnalysisItem[]> {
    const c = classFilterQs(classId);
    // 总分映射基于 student_scores（ss 别名），必须使用 classFilter（其 JOIN 引用 ss.student_id）；
    // 若误用 classFilterQs（JOIN 引用 qs.student_id）会在带 classId 的查询里报“no such column: qs.student_id”。
    const totals = await this.getExamTotalsMap(examId, classFilter(classId));
    return this.computeQuestionAnalysis(examId, c, totals);
  }

  private async getExamTotalsMap(examId: number, c: { join: string; where: string; params: unknown[] }): Promise<Map<number, number>> {
    const rows = await this.db.all(`SELECT ss.student_id, ss.total_score FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where}`, examId, ...c.params) as Array<{ student_id: number; total_score: number }>;
    const m = new Map<number, number>();
    for (const r of rows) m.set(r.student_id, Number(r.total_score));
    return m;
  }

  private async getKnowledgePointsMap(examId: number): Promise<Map<number, string>> {
    const exam = await this.db.get(`SELECT card_id FROM exams WHERE id = ?`, examId) as { card_id: string | null } | undefined;
    const m = new Map<number, string>();
    if (!exam?.card_id) return m;
    const rows = await this.db.all(`SELECT question_number, point_text FROM knowledge_points WHERE card_id = ? ORDER BY question_number, sort_order`, exam.card_id) as Array<{ question_number: number; point_text: string }>;
    for (const r of rows) {
      const q = Number(r.question_number);
      m.set(q, (m.get(q) ? m.get(q) + "；" : "") + (r.point_text ?? ""));
    }
    return m;
  }

  /** 计算逐题分析（含难度 P 与区分度 D），D 的分组基准由 totalsMap 决定 */
  private async computeQuestionAnalysis(examId: number, c: { join: string; where: string; params: unknown[] }, totalsMap: Map<number, number>): Promise<QuestionAnalysisItem[]> {
    const thresholds = await getAnalysisThresholds();
    const tiers = thresholds.errorTiers;
    const lowRatio = thresholds.subjectiveLowScoreRatio;
    const rows = await this.db.all(`SELECT qs.question_number, qs.score_type as question_type, ROUND(AVG(qs.score), 1) as avgScore, MAX(qs.max_score) as maxScore, COUNT(*) as totalCount, SUM(CASE WHEN qs.score >= qs.max_score THEN 1 ELSE 0 END) as correctCount, SUM(CASE WHEN qs.score < qs.max_score THEN 1 ELSE 0 END) as objectiveErrorCount, SUM(CASE WHEN qs.score < qs.max_score * ? THEN 1 ELSE 0 END) as subjectiveLowScoreCount FROM question_scores qs ${c.join} WHERE qs.exam_id = ? ${c.where} GROUP BY qs.question_number, qs.score_type ORDER BY CASE WHEN MAX(qs.max_score) > 0 THEN AVG(qs.score) / MAX(qs.max_score) ELSE 1 END ASC`, lowRatio, examId, ...c.params) as any[];
    // 逐学生小题得分（用于区分度极端组法）
    const qsRows = await this.db.all(`SELECT qs.student_id, qs.question_number, qs.score_type, qs.score FROM question_scores qs ${c.join} WHERE qs.exam_id = ? ${c.where}`, examId, ...c.params) as Array<{ student_id: number; question_number: number; score_type: string; score: number }>;
    const byQuestion = new Map<string, { studentIds: number[]; scores: Map<number, number> }>();
    for (const r of qsRows) {
      const key = `${r.question_number}:${r.score_type}`;
      let g = byQuestion.get(key);
      if (!g) { g = { studentIds: [], scores: new Map() }; byQuestion.set(key, g); }
      g.studentIds.push(r.student_id);
      g.scores.set(r.student_id, Number(r.score));
    }
    const knowledgePoints = await this.getKnowledgePointsMap(examId);
    return rows.map((r: any) => {
      const isObj = r.question_type === "objective";
      const errCnt = isObj ? r.objectiveErrorCount : r.subjectiveLowScoreCount;
      const errRate = r.totalCount > 0 ? Math.round((errCnt / r.totalCount) * 100) : 0;
      const key = `${r.question_number}:${r.question_type}`;
      const g = byQuestion.get(key);
      let disc = 0;
      if (g && g.studentIds.length > 0) {
        const itemScores: number[] = [];
        const tot: number[] = [];
        for (const sid of g.studentIds) {
          const t = totalsMap.get(sid);
          if (t == null) continue;
          itemScores.push(g.scores.get(sid)!);
          tot.push(t);
        }
        disc = discriminationByExtremeGroup(itemScores, tot, r.maxScore);
      }
      return {
        questionNumber: String(r.question_number),
        questionType: isObj ? "客观" : "主观",
        scoreRate: r.maxScore > 0 ? Math.round((r.avgScore / r.maxScore) * 100) : 0,
        correctRate: isObj && r.totalCount > 0 ? Math.round((r.correctCount / r.totalCount) * 100) : null,
        avgScore: r.avgScore,
        maxScore: r.maxScore,
        errorCount: errCnt,
        errorRate: errRate,
        errorRateLevel: errorRateLevel(errRate, tiers),
        totalCount: r.totalCount,
        difficulty: r.maxScore > 0 ? Math.round((r.avgScore / r.maxScore) * 1000) / 1000 : 0,
        discrimination: disc,
        knowledgePoint: knowledgePoints.get(Number(r.question_number)) ?? null
      };
    });
  }

  /** 普通考试整体难度/区分度指标（D = 逐题区分度均值） */
  async getExamMetrics(examId: number, classId?: number): Promise<ExamMetrics> {
    const ov = await this.getExamOverview(examId, classId);
    const fullScore = await this.resolveExamFullScore(examId);
    const qa = await this.getQuestionAnalysis(examId, classId);
    const disc = qa.length > 0 ? qa.reduce((s, q) => s + (q.discrimination ?? 0), 0) / qa.length : 0;
    // 信度样本与参考人数/逐题区分度同口径：带班级筛选时按该班 student_scores 参与者集合过滤
    const reliabilityParticipants = classId === undefined
      ? undefined
      : Array.from((await this.getExamTotalsMap(examId, classFilter(classId))).keys());
    return {
      difficulty: fullScore > 0 ? Math.round((ov.avgScore / fullScore) * 1000) / 1000 : 0,
      discrimination: Math.round(disc * 1000) / 1000,
      fullScore,
      avgScore: ov.avgScore,
      gradedCount: ov.gradedCount,
      reliability: await this.getExamReliability(examId, reliabilityParticipants),
      cv: coefficientOfVariation(ov.stdDev, ov.avgScore)
    };
  }

  /** 单场考试信度：纯客观卷用 KR-20（二分计分），含主观题用 Cronbach α（原始得分）。
   * 剔除作答不完整的学生；题数 <2 或有效样本 <2 时返回 null（无法评估）。
   * participantIds：可选参与者集合（班级筛选/大考逐科按 totals 口径），缺省为全部作答学生。 */
  private async getExamReliability(examId: number, participantIds?: Iterable<number>): Promise<number | null> {
    const ids = participantIds === undefined ? undefined : Array.from(participantIds);
    if (ids !== undefined && ids.length === 0) return null;
    const idClause = ids !== undefined ? `AND qs.student_id IN (${placeholders(ids)})` : "";
    const rows = await this.db.all(
      `SELECT qs.student_id, qs.question_number, qs.score_type, qs.score, qs.max_score
       FROM question_scores qs
       WHERE qs.exam_id = ? ${idClause}`, examId, ...(ids ?? [])
    ) as Array<{ student_id: number; question_number: number; score_type: string; score: number; max_score: number }>;
    if (rows.length === 0) return null;
    const qKeys = Array.from(new Set(rows.map((r) => String(r.question_number)))).sort((a, b) => Number(a) - Number(b));
    if (qKeys.length < 2) return null;
    const byStudent = new Map<number, Map<string, { score: number; maxScore: number; isObjective: boolean }>>();
    let hasSubjective = false;
    for (const r of rows) {
      if (r.score_type !== "objective") hasSubjective = true;
      const m = byStudent.get(Number(r.student_id)) ?? new Map();
      if (!m.has(String(r.question_number))) {
        m.set(String(r.question_number), { score: Number(r.score), maxScore: Number(r.max_score), isObjective: r.score_type === "objective" });
      }
      byStudent.set(Number(r.student_id), m);
    }
    const matrix: number[][] = [];
    for (const m of byStudent.values()) {
      if (m.size !== qKeys.length) continue; // 作答不完整的学生剔除
      const row: number[] = [];
      let complete = true;
      for (const key of qKeys) {
        const qv = m.get(key);
        if (!qv) { complete = false; break; }
        row.push(hasSubjective ? qv.score : (qv.maxScore > 0 && qv.score >= qv.maxScore ? 1 : 0));
      }
      if (complete) matrix.push(row);
    }
    if (matrix.length < 2) return null;
    return hasSubjective ? cronbachAlpha(matrix) : kr20(matrix);
  }

  /** 大考总体信度：以「各科总分为题目、参与者为样本」的 Cronbach α（须 ≥2 科、≥2 生） */
  private async getGroupReliability(examIds: number[], participantIds: number[], track: "all" | "arts" | "science" = "all"): Promise<number | null> {
    if (examIds.length < 2 || participantIds.length < 2) return null;
    const trackClause = track === "all" ? "" : "AND u.track = ?";
    const rows = await this.db.all(
      `SELECT ss.student_id, ss.exam_id, ss.total_score
       FROM student_scores ss
       JOIN users u ON u.id = ss.student_id
       WHERE ss.exam_id IN (${placeholders(examIds)}) AND ss.student_id IN (${placeholders(participantIds)}) ${trackClause}`,
      ...examIds, ...participantIds, ...(track !== "all" ? [track] : [])
    ) as Array<{ student_id: number; exam_id: number; total_score: number }>;
    const byStudent = new Map<number, Map<number, number>>();
    for (const r of rows) {
      const m = byStudent.get(Number(r.student_id)) ?? new Map();
      m.set(Number(r.exam_id), Number(r.total_score));
      byStudent.set(Number(r.student_id), m);
    }
    const matrix: number[][] = [];
    for (const m of byStudent.values()) {
      if (m.size !== examIds.length) continue; // 缺科学生剔除（与 only_full 口径一致）
      matrix.push(examIds.map((id) => m.get(id) ?? 0));
    }
    if (matrix.length < 2) return null;
    return cronbachAlpha(matrix);
  }

  /** 逐题下钻：全班每人得分（联表 users/classes/knowledge_points） */
  async getQuestionStudentScores(examId: number, questionNumber: string | number, classId?: number): Promise<QuestionStudentScore[]> {
    const classScope = classId === undefined
      ? { where: "", params: [] as unknown[] }
      : classId === 0
        ? { where: "AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = qs.student_id)", params: [] as unknown[] }
        : { where: "AND EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = qs.student_id AND cs_scope.class_id = ?)", params: [classId] as unknown[] };
    const displayClassConstraint = classId !== undefined && classId > 0 ? "AND cs_display.class_id = ?" : "";
    const displayClassParams = displayClassConstraint ? [classId] : [];
    const rows = await this.db.all(`
      SELECT qs.student_id, qs.score, qs.max_score, u.student_number, u.name,
             (SELECT c.name FROM class_students cs_display JOIN classes c ON c.id = cs_display.class_id
              WHERE cs_display.student_id = qs.student_id ${displayClassConstraint}
              ORDER BY cs_display.joined_at DESC, cs_display.class_id DESC LIMIT 1) as class_name
      FROM question_scores qs
      JOIN users u ON u.id = qs.student_id
      WHERE qs.exam_id = ? AND qs.question_number = ? ${classScope.where}
      ORDER BY qs.score DESC
    `, ...displayClassParams, examId, questionNumber, ...classScope.params) as any[];
    const kpMap = await this.getKnowledgePointsMap(examId);
    return rows.map((r: any) => {
      const maxScore = Number(r.max_score);
      const score = Number(r.score);
      return {
        studentId: r.student_id,
        studentNumber: r.student_number ?? "",
        name: r.name ?? "",
        className: r.class_name ?? null,
        score,
        maxScore,
        scoreRate: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0,
        isFull: maxScore > 0 && score >= maxScore,
        knowledgePoint: kpMap.get(Number(questionNumber)) ?? null
      };
    });
  }

  /** 普通考试分布（subject=全卷；class=各班） */
  async getExamDistribution(examId: number, mode: "subject" | "class"): Promise<DistributionResult[]> {
    const thresholds = await getAnalysisThresholds();
    const fullScore = await this.resolveExamFullScore(examId);
    if (mode === "subject") {
      const rows = await this.db.all(`SELECT total_score FROM student_scores WHERE exam_id = ? ORDER BY total_score ASC`, examId) as any[];
      const scores = rows.map((r: any) => Number(r.total_score)).filter(Number.isFinite);
      const qa = await this.getQuestionAnalysis(examId);
      const disc = qa.length > 0 ? qa.reduce((s, q) => s + (q.discrimination ?? 0), 0) / qa.length : 0;
      return [this.buildDistribution("subject", "total", "全卷分布", fullScore, thresholds.segmentSize, scores, disc)];
    }
    const classes = await this.getExamClasses(examId);
    const results: DistributionResult[] = [];
    for (const cls of classes) {
      const c = classFilter(cls.classId);
      const rows = await this.db.all(`SELECT ss.total_score as totalScore FROM student_scores ss ${c.join} WHERE ss.exam_id = ? ${c.where} ORDER BY ss.total_score ASC`, examId, ...c.params) as any[];
      const scores = rows.map((r: any) => Number(r.totalScore)).filter(Number.isFinite);
      const qa = await this.getQuestionAnalysis(examId, cls.classId);
      const disc = qa.length > 0 ? qa.reduce((s, q) => s + (q.discrimination ?? 0), 0) / qa.length : 0;
      results.push(this.buildDistribution("class", String(cls.classId), cls.className, fullScore, thresholds.segmentSize, scores, disc));
    }
    return results;
  }

  private buildDistribution(scope: "subject" | "total" | "class", scopeId: string, label: string, fullScore: number, segmentSize: number, scores: number[], discrimination: number): DistributionResult {
    const bins = histogram(scores, fullScore, segmentSize);
    const m = mean(scores);
    const sd = stdDev(scores);
    const norm = normality(scores);
    const P = scores.length > 0 ? difficulty(m, fullScore) : 0;
    return {
      scope, scopeId, label, fullScore, segmentSize,
      bins,
      mean: round1(m),
      stdDev: round1(sd),
      normality: norm,
      difficulty: P,
      discrimination: Math.round(discrimination * 1000) / 1000,
      sampleSize: scores.length,
      assignedAvailable: false,
      qq: scores.length >= 3 ? qqPlot(scores, m, sd) : []
    };
  }

  // ── 大考聚合 ─────────────────────────────────────

  /** 大考整体 + 逐科难度/区分度 */
  /** 文理分科（Issue #177）：考试组内科目归属映射 */
  private async getGroupMemberTrackMap(groupId: number): Promise<Map<number, string>> {
    // #246 auto_delete：软删除成员考试不参与大考组全部统计（该方法是组指标的成员唯一入口）
    const rows = await this.db.all<{ exam_id: number; track_type: string | null }>(
      `SELECT egm.exam_id, egm.track_type FROM exam_group_members egm
       WHERE egm.group_id = ? AND ${GROUP_MEMBER_NOT_SOFT_DELETED_SQL}`,
      groupId
    );
    const map = new Map<number, string>();
    for (const row of rows) map.set(Number(row.exam_id), row.track_type || "common");
    return map;
  }

  /** 文理分科（Issue #177）：按筛选返回应纳入统计的科目 id 列表 */
  private groupMemberIdsForTrack(members: Map<number, string>, track: "all" | "arts" | "science"): number[] {
    if (track === "all") return Array.from(members.keys());
    return Array.from(members.entries())
      .filter(([, trackType]) => trackType === "common" || trackType === track)
      .map(([examId]) => examId);
  }

  async getGroupMetrics(groupId: number, track: "all" | "arts" | "science" = "all"): Promise<GroupMetrics> {
    const group = await this.getExamGroup(groupId);
    if (!group) return { difficulty: 0, discrimination: 0, totalFullScore: 0, totalAvg: 0, memberCount: 0, participantCount: 0, reliability: null, cv: null, subjects: [] };
    const memberMap = await this.getGroupMemberTrackMap(groupId);
    const examIds = this.groupMemberIdsForTrack(memberMap, track);
    if (examIds.length === 0) return { difficulty: 0, discrimination: 0, totalFullScore: 0, totalAvg: 0, memberCount: 0, participantCount: 0, reliability: null, cv: null, subjects: [] };
    const qa = await this.getGroupQuestionAnalysis(groupId, track);
    const fullScores = await this.getExamFullScoreMap(examIds);
    const totalFullScore = examIds.reduce((s, id) => s + (fullScores.get(id) ?? 0), 0);
    const totals = await this.getGroupTotalsMap(groupId, track);
    const totalAvg = totals.size > 0 ? mean(Array.from(totals.values())) : 0;
    const totalScores = Array.from(totals.values());
    // 逐科参数：复用各科的统计（按大考参与者口径），不再硬编码为 0
    const thresholds = await getAnalysisThresholds();
    const subjects: GroupSubjectMetric[] = [];
    for (const s of qa.subjects) {
      const fullScore = s.fullScore;
      // 科的及格/优秀线 = 该科满分 × 全局阈值（与 getGroupClassComparison 对总分用 totalFull × 阈值口径一致）
      const passLine = Math.round(fullScore * thresholds.passRate * 10) / 10;
      const excellentLine = Math.round(fullScore * thresholds.excellentRate * 10) / 10;
      const c = classFilterQs(undefined);
      // B6：stdDev 用 E[X²]−E[X]² 总体σ公式（与单科「减真实均值」结果一致）。
      // 不用 STDDEV_POP：SQLite 无此聚合函数（仅 MariaDB 有），会导致大考 metrics 接口在默认 SQLite 部署下报错。
      const stat = await this.db.get(
        `SELECT COUNT(*) AS gradedCount, ROUND(AVG(ss.total_score), 1) AS avgScore, ROUND(MAX(ss.total_score), 1) AS maxScore, ROUND(MIN(ss.total_score), 1) AS minScore, ROUND(SQRT(AVG(ss.total_score * ss.total_score) - AVG(ss.total_score) * AVG(ss.total_score)), 1) AS stdDev,
                ROUND(SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) AS passRate,
                ROUND(SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) AS excellentRate
         FROM student_scores ss ${c.join}
         WHERE ss.exam_id = ? AND ss.student_id IN (${totals.size > 0 ? Array.from(totals.keys()).map(() => "?").join(",") : "SELECT 0 WHERE 0"}) ${c.where}`,
        passLine, excellentLine, s.examId, ...Array.from(totals.keys()), ...c.params
      ) as any;
      subjects.push({
        examId: s.examId, examName: s.examName, subject: s.subject,
        gradedCount: stat?.gradedCount ?? 0,
        avgScore: stat?.avgScore ?? s.avgScore,
        maxScore: stat?.maxScore ?? 0,
        minScore: stat?.minScore ?? 0,
        stdDev: stat?.stdDev ?? 0,
        passRate: stat?.passRate ?? 0, excellentRate: stat?.excellentRate ?? 0,
        fullScore, hasAssignedScore: false,
        difficulty: s.difficulty, discrimination: s.discrimination,
        reliability: await this.getExamReliability(s.examId, totals.keys()),
        cv: coefficientOfVariation(stat?.stdDev ?? 0, stat?.avgScore ?? 0)
      });
    }
    const disc = subjects.length > 0 ? subjects.reduce((s, x) => s + (x.discrimination ?? 0), 0) / subjects.length : 0;
    const overallStd = stdDev(totalScores);
    return {
      difficulty: totalFullScore > 0 ? Math.round((totalAvg / totalFullScore) * 1000) / 1000 : 0,
      discrimination: Math.round(disc * 1000) / 1000,
      totalFullScore: Math.round(totalFullScore * 10) / 10,
      totalAvg: Math.round(totalAvg * 10) / 10,
      memberCount: examIds.length,
      participantCount: totals.size,
      reliability: await this.getGroupReliability(examIds, Array.from(totals.keys()), track),
      cv: coefficientOfVariation(overallStd, totalAvg),
      subjects
    };
  }

  /** 大考逐题分析（整体 + 逐科），D 分组基准=大考总分 */
  async getGroupQuestionAnalysis(groupId: number, track: "all" | "arts" | "science" = "all"): Promise<GroupQuestionAnalysisResponse> {
    const group = await this.getExamGroup(groupId);
    const empty: GroupQuestionAnalysisResponse = { overall: { difficulty: 0, discrimination: 0, sampleSize: 0 }, subjects: [] };
    if (!group) return empty;
    const memberMap = await this.getGroupMemberTrackMap(groupId);
    const examIds = this.groupMemberIdsForTrack(memberMap, track);
    if (examIds.length === 0) return empty;
    const totals = await this.getGroupTotalsMap(groupId, track);
    const participantIds = Array.from(totals.keys());
    const participantFilter = participantIds.length > 0
      ? { join: "", where: `AND qs.student_id IN (${participantIds.map(() => "?").join(",")})`, params: participantIds }
      : { join: "", where: "AND 1=0", params: [] };
    // N+1 收敛：满分与考试元信息一次性批量取（缺题分数据时按统一兜底口径，见 getExamFullScoreMap）
    const fullByExam = await this.getExamFullScoreMap(examIds);
    const examRows = await this.db.all(
      `SELECT id, name, subject FROM exams WHERE id IN (${placeholders(examIds)})`,
      ...examIds
    ) as Array<{ id: number; name: string; subject: string | null }>;
    const examById = new Map<number, { name: string; subject: string | null }>(
      examRows.map((r) => [Number(r.id), { name: r.name, subject: r.subject }])
    );
    const avgRows = participantIds.length > 0
      ? await this.db.all(
          `SELECT ss.exam_id, COUNT(*) AS sampleSize, ROUND(AVG(ss.total_score), 1) AS avg
           FROM student_scores ss
           WHERE ss.exam_id IN (${placeholders(examIds)})
             AND ss.student_id IN (${placeholders(participantIds)})
           GROUP BY ss.exam_id`,
          ...examIds,
          ...participantIds
        ) as Array<{ exam_id: number; sampleSize: number; avg: number | null }>
      : [];
    const avgByExam = new Map<number, { sampleSize: number; avg: number }>(
      avgRows.map((r) => [Number(r.exam_id), { sampleSize: Number(r.sampleSize), avg: r.avg ?? 0 }])
    );
    const subjects: GroupQuestionAnalysisResponse["subjects"] = [];
    let discSum = 0;
    // ponytail: 逐题的 computeQuestionAnalysis 仍按考试逐个跑（每题要查知识库/极端组）。
    // 年级规模无碍；若一场大考科目数变多且出现慢查询，再把 qs 聚合按 exam_id 批量化。
    for (const examId of examIds) {
      const items = await this.computeQuestionAnalysis(examId, participantFilter, totals);
      const fullScore = fullByExam.get(examId) ?? 0;
      const avgRow = avgByExam.get(examId) ?? { sampleSize: 0, avg: 0 };
      const avgScore = avgRow.avg;
      const subjectSampleSize = avgRow.sampleSize;
      const disc = items.length > 0 ? items.reduce((s, q) => s + (q.discrimination ?? 0), 0) / items.length : 0;
      const exam = examById.get(examId);
      discSum += disc;
      subjects.push({
        examId, subject: exam?.subject ?? "", examName: exam?.name ?? String(examId),
        fullScore, avgScore, difficulty: fullScore > 0 ? Math.round((avgScore / fullScore) * 1000) / 1000 : 0,
        discrimination: Math.round(disc * 1000) / 1000, sampleSize: subjectSampleSize, questions: items
      });
    }
    const overallDisc = subjects.length > 0 ? discSum / subjects.length : 0;
    const totalFullScore = subjects.reduce((s, x) => s + x.fullScore, 0);
    const totalAvg = subjects.reduce((s, x) => s + x.avgScore, 0);
    return {
      overall: {
        difficulty: totalFullScore > 0 ? Math.round((totalAvg / totalFullScore) * 1000) / 1000 : 0,
        discrimination: Math.round(overallDisc * 1000) / 1000,
        sampleSize: totals.size
      },
      subjects
    };
  }

  /** 大考总分（逐学生跨成员考试合计）
   *
   * 遵守 exam_groups 表的两个核心策略：
   * - `only_full_participants = 1`：只统计参加全部成员考试的学生（用 `COUNT(DISTINCT exam_id) = member_count` 过滤）；
   *   即缺一科即被排除，避免被当「低分」拉低均分与难度系数。
   * - `total_score_mode = 'assigned'`：当该成员考试设置了 `assigned_formula`（赋分公式）时，
   *   使用 `assigned_score`；否则回退到 `total_score`。这样大考总分按业务策略口径汇总。 */
  private async getGroupTotalsMap(groupId: number, track: "all" | "arts" | "science" = "all"): Promise<Map<number, number>> {
    const m = new Map<number, number>();
    const memberMap = await this.getGroupMemberTrackMap(groupId);
    const examIds = this.groupMemberIdsForTrack(memberMap, track);
    if (examIds.length === 0) return m;
    const cfg = await this.db.get(
      `SELECT COALESCE(only_full_participants, 0) AS only_full, COALESCE(total_score_mode, 'raw') AS mode FROM exam_groups WHERE id = ?`,
      groupId
    ) as { only_full: number; mode: string } | undefined;
    const onlyFull = !!(cfg && cfg.only_full);
    const useAssigned = !!(cfg && cfg.mode === "assigned");
    const scoreExpr = useAssigned
      ? `CASE WHEN e.assigned_formula IS NOT NULL AND e.assigned_formula != '' 
              THEN COALESCE(ss.assigned_score, ss.total_score) 
              ELSE ss.total_score END`
      : `ss.total_score`;
    const trackClause = track === "all" ? "" : "AND u.track = ?";
    let sql = `
      SELECT ss.student_id, SUM(${scoreExpr}) AS total
      FROM student_scores ss
      JOIN exams e ON e.id = ss.exam_id
      JOIN users u ON u.id = ss.student_id
      WHERE ss.exam_id IN (${examIds.map(() => "?").join(",")}) ${trackClause}
      GROUP BY ss.student_id
    `;
    if (onlyFull) sql += ` HAVING COUNT(DISTINCT ss.exam_id) = ${examIds.length}`;
    const params: unknown[] = [...examIds];
    if (track !== "all") params.push(track);
    const rows = await this.db.all(sql, ...params) as Array<{ student_id: number; total: number }>;
    for (const r of rows) m.set(r.student_id, Number(r.total));
    return m;
  }

  /** 大考参与者集合：与 getGroupTotalsMap 保持同一口径（用于 getGroupDistribution/ClassComparison
   * 与 exam-groups-analysis 路由的概览/班级查询按参与者过滤）。 */
  async getGroupParticipantIds(groupId: number, track: "all" | "arts" | "science" = "all"): Promise<Set<number>> {
    const totals = await this.getGroupTotalsMap(groupId, track);
    return new Set(totals.keys());
  }

  /** 大考分布（subject=各科；total=总分；class=各班总分）
   * 所有模式按 getGroupTotalsMap 的参与者口径过滤，保持与总指标一致。 */
  async getGroupDistribution(groupId: number, mode: "subject" | "total" | "class", track: "all" | "arts" | "science" = "all"): Promise<DistributionResult[]> {
    const group = await this.getExamGroup(groupId);
    if (!group) return [];
    const memberMap = await this.getGroupMemberTrackMap(groupId);
    const examIds = this.groupMemberIdsForTrack(memberMap, track);
    if (examIds.length === 0) return [];
    const thresholds = await getAnalysisThresholds();
    const totals = await this.getGroupTotalsMap(groupId, track);
    const participants = Array.from(totals.keys());
    const participantClause = participants.length > 0
      ? `AND ss.student_id IN (${participants.map(() => "?").join(",")})`
      : `AND 1=0`;
    const results: DistributionResult[] = [];
    if (mode === "total" || mode === "class") {
      const classRows = await this.db.all(`
        SELECT ss.student_id, c.id as class_id, c.name as class_name
        FROM student_scores ss
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id IN (${examIds.map(() => "?").join(",")}) ${participantClause}
        ORDER BY c.id IS NULL ASC, c.id ASC
      `, ...examIds, ...participants) as Array<{ student_id: number; class_id: number | null; class_name: string | null }>;
      // B11：多班学生归班统一口径——按 class_id 升序取首个（等价 MIN(class_id)，与偏科/临界生查询的 MIN 口径一致）
      const classOf = new Map<number, { classId: number; className: string }>();
      for (const r of classRows) if (!classOf.has(r.student_id)) classOf.set(r.student_id, { classId: r.class_id ?? 0, className: r.class_name ?? "未知班级" });
      const fullScoreMap = await this.getExamFullScoreMap(examIds);
      const totalFull = examIds.reduce((s, id) => s + (fullScoreMap.get(id) ?? 0), 0);
      // B9：赋分可用性——模式为 assigned 且存在「带赋分公式并已落库 assigned_score」的成员考试才算点亮
      const assignedCfg = await this.db.get(
        `SELECT COALESCE(total_score_mode, 'raw') AS mode FROM exam_groups WHERE id = ?`, groupId
      ) as { mode: string } | undefined;
      let assignedAvailable = false;
      if (assignedCfg?.mode === "assigned" && totals.size > 0) {
        const hasAssigned = await this.db.get(
          `SELECT 1 FROM exam_group_members egm
           JOIN exams e ON e.id = egm.exam_id
           WHERE egm.group_id = ? AND e.assigned_formula IS NOT NULL AND e.assigned_formula != ''
             AND EXISTS (SELECT 1 FROM student_scores ss2 WHERE ss2.exam_id = e.id AND ss2.assigned_score IS NOT NULL)
             AND ${GROUP_MEMBER_NOT_SOFT_DELETED_SQL}
           LIMIT 1`, groupId
        ) as any;
        assignedAvailable = !!hasAssigned;
      }
      if (mode === "total") {
        const scores = Array.from(totals.values());
        const disc = await this.groupOverallDiscrimination(groupId, track);
        const res = this.buildDistribution("total", "total", "大考总分分布", totalFull, thresholds.segmentSize, scores, disc);
        if (assignedAvailable) {
          // 赋分模式下 bins 已为赋分后总分（getGroupTotalsMap 口径）；附原始分分布作对照
          const rawRows = await this.db.all(`
            SELECT ss.student_id, SUM(ss.total_score) AS total
            FROM student_scores ss
            JOIN users u ON u.id = ss.student_id
            WHERE ss.exam_id IN (${placeholders(examIds)}) AND ss.student_id IN (${participants.map(() => "?").join(",")})
            ${track === "all" ? "" : "AND u.track = ?"}
            GROUP BY ss.student_id
          `, ...examIds, ...participants, ...(track !== "all" ? [track] : [])) as Array<{ student_id: number; total: number }>;
          res.assignedAvailable = true;
          res.assignedBins = histogram(rawRows.map((r) => Number(r.total)), totalFull, thresholds.segmentSize);
        }
        results.push(res);
      } else {
        // B8：班级分布纳入真实区分度——与 subject/total 模式一致，使用大考整体区分度（原硬编码 0）
        const classDisc = await this.groupOverallDiscrimination(groupId, track);
        const byClass = new Map<number, { className: string; scores: number[] }>();
        for (const [sid, t] of totals) {
          const cls = classOf.get(sid) ?? { classId: 0, className: "未知班级" };
          if (!byClass.has(cls.classId)) byClass.set(cls.classId, { className: cls.className, scores: [] });
          byClass.get(cls.classId)!.scores.push(t);
        }
        for (const [classId, info] of byClass) {
          const classRes = this.buildDistribution("class", String(classId), info.className, totalFull, thresholds.segmentSize, info.scores, classDisc);
          classRes.assignedAvailable = assignedAvailable;
          results.push(classRes);
        }
      }
      return results;
    }
    // N+1 收敛：逐题区分度只需算一次（原实现每个科目都重跑整组题目分析，O(n²)）；
    // 成绩行与考试元信息也批量取出后在内存按科目分组，顺序语义与逐科查询一致。
    const qa = await this.getGroupQuestionAnalysis(groupId, track);
    const scoreRows = participants.length > 0
      ? await this.db.all(
          `SELECT ss.exam_id, ss.total_score FROM student_scores ss
           WHERE ss.exam_id IN (${placeholders(examIds)}) ${participantClause}
           ORDER BY ss.exam_id ASC, ss.total_score ASC`,
          ...examIds,
          ...participants
        ) as Array<{ exam_id: number; total_score: number }>
      : [];
    const scoresByExam = new Map<number, number[]>();
    for (const r of scoreRows) {
      const list = scoresByExam.get(Number(r.exam_id)) ?? [];
      list.push(Number(r.total_score));
      scoresByExam.set(Number(r.exam_id), list);
    }
    const fullByExam = await this.getExamFullScoreMap(examIds);
    const examRows = await this.db.all(
      `SELECT id, name, subject FROM exams WHERE id IN (${placeholders(examIds)})`,
      ...examIds
    ) as Array<{ id: number; name: string; subject: string | null }>;
    const examById = new Map<number, { name: string; subject: string | null }>(
      examRows.map((r) => [Number(r.id), { name: r.name, subject: r.subject }])
    );
    for (const examId of examIds) {
      const scores = (scoresByExam.get(examId) ?? []).filter(Number.isFinite);
      const fullScore = fullByExam.get(examId) ?? 0;
      const exam = examById.get(examId);
      const disc = qa.subjects.find((s) => s.examId === examId)?.discrimination ?? 0;
      results.push(this.buildDistribution("subject", String(examId), exam?.subject ?? exam?.name ?? String(examId), fullScore, thresholds.segmentSize, scores, disc));
    }
    return results;
  }

  private async groupOverallDiscrimination(groupId: number, track: "all" | "arts" | "science" = "all"): Promise<number> {
    const qa = await this.getGroupQuestionAnalysis(groupId, track);
    return qa.overall.discrimination;
  }

  /** 大考班级对比（班级总分统计 + 逐科班级均分对比） */
  async getGroupClassComparison(groupId: number, track: "all" | "arts" | "science" = "all"): Promise<GroupClassComparisonResponse> {
    const group = await this.getExamGroup(groupId);
    const empty: GroupClassComparisonResponse = { classes: [], subjectClassSummaries: [] };
    if (!group) return empty;
    const memberMap = await this.getGroupMemberTrackMap(groupId);
    const examIds = this.groupMemberIdsForTrack(memberMap, track);
    if (examIds.length === 0) return empty;
    const thresholds = await getAnalysisThresholds();
    const totals = await this.getGroupTotalsMap(groupId, track);
    const fullScoreMap = await this.getExamFullScoreMap(examIds);
    const totalFull = examIds.reduce((s, id) => s + (fullScoreMap.get(id) ?? 0), 0);
    const classRows = await this.db.all(`
      SELECT ss.student_id, c.id as class_id, c.name as class_name, g.name as grade_name
      FROM student_scores ss
      LEFT JOIN class_students cs ON cs.student_id = ss.student_id
      LEFT JOIN classes c ON c.id = cs.class_id
      LEFT JOIN grades g ON g.id = c.grade_id
      WHERE ss.exam_id IN (${examIds.map(() => "?").join(",")})
      ORDER BY c.id IS NULL ASC, c.id ASC
    `, ...examIds) as Array<{ student_id: number; class_id: number | null; class_name: string | null; grade_name: string | null }>;
    const classMeta = new Map<number, { className: string; gradeName?: string }>();
    for (const r of classRows) classMeta.set(r.class_id ?? 0, { className: r.class_name ?? "未知班级", gradeName: r.grade_name ?? undefined });
    // B11：多班学生归班统一口径——按 class_id 升序取首个（等价 MIN(class_id)，与偏科/临界生查询的 MIN 口径一致）
    const classOf = new Map<number, number>();
    for (const r of classRows) if (!classOf.has(r.student_id)) classOf.set(r.student_id, r.class_id ?? 0);

    const byClass = new Map<number, number[]>();
    for (const [sid, t] of totals) {
      const cid = classOf.get(sid) ?? 0;
      if (!byClass.has(cid)) byClass.set(cid, []);
      byClass.get(cid)!.push(t);
    }
    const classes: GroupClassComparisonResponse["classes"] = [];
    for (const [classId, scores] of byClass) {
      if (scores.length === 0) continue;
      const sArr = scores.slice().sort((a, b) => a - b);
      const sum = sArr.reduce((a, b) => a + b, 0);
      const avg = sum / sArr.length;
      const variance = sArr.reduce((a, b) => a + (b - avg) ** 2, 0) / sArr.length;
      const bins = histogram(sArr, totalFull, thresholds.segmentSize);
      const meta = classMeta.get(classId) ?? { className: "未知班级" };
      classes.push({
        classId, className: meta.className, gradeName: meta.gradeName,
        count: sArr.length,
        avgScore: round1(avg),
        maxScore: round1(sArr[sArr.length - 1]),
        minScore: round1(sArr[0]),
        median: round1(percentile(sArr, 0.5)),
        stdDev: round1(Math.sqrt(variance)),
        // Bugfix: 遵守 getAnalysisThresholds() 配置，不再硬编码 0.6 / 0.9
        passRate: Math.round((sArr.filter((x) => x >= totalFull * thresholds.passRate).length / sArr.length) * 100),
        excellentRate: Math.round((sArr.filter((x) => x >= totalFull * thresholds.excellentRate).length / sArr.length) * 100),
        distribution: bins
      });
    }
    const participantIds = Array.from(totals.keys());
    const participantClause = participantIds.length > 0
      ? `AND ss.student_id IN (${participantIds.map(() => "?").join(",")})`
      : `AND 1=0`;
    const subjectClassSummaries: GroupClassComparisonResponse["subjectClassSummaries"] = [];
    // N+1 收敛：逐科成绩行 / 满分 / 考试名批量查询，内存按科分组；结果与逐科查询一致。
    const fullByExam = await this.getExamFullScoreMap(examIds);
    const examRows = await this.db.all(
      `SELECT id, name, subject FROM exams WHERE id IN (${placeholders(examIds)})`,
      ...examIds
    ) as Array<{ id: number; name: string; subject: string | null }>;
    const examById = new Map<number, { name: string; subject: string | null }>(
      examRows.map((r) => [Number(r.id), { name: r.name, subject: r.subject }])
    );
    const subjectRows = participantIds.length > 0
      ? await this.db.all(
          `SELECT ss.exam_id, ss.student_id, ss.total_score, c.id as class_id
           FROM student_scores ss
           LEFT JOIN class_students cs ON cs.student_id = ss.student_id
           LEFT JOIN classes c ON c.id = cs.class_id
           WHERE ss.exam_id IN (${placeholders(examIds)}) ${participantClause}`,
          ...examIds,
          ...participantIds
        ) as Array<{ exam_id: number; student_id: number; total_score: number; class_id: number | null }>
      : [];
    const subjectRowsByExam = new Map<number, Array<{ student_id: number; total_score: number; class_id: number | null }>>();
    for (const r of subjectRows) {
      const list = subjectRowsByExam.get(Number(r.exam_id)) ?? [];
      list.push({ student_id: r.student_id, total_score: r.total_score, class_id: r.class_id });
      subjectRowsByExam.set(Number(r.exam_id), list);
    }
    for (const examId of examIds) {
      const fullScore = fullByExam.get(examId) ?? 0;
      const exam = examById.get(examId);
      const rows = subjectRowsByExam.get(examId) ?? [];
      const byCls = new Map<number, number[]>();
      for (const r of rows) {
        const cid = r.class_id ?? 0;
        if (!byCls.has(cid)) byCls.set(cid, []);
        byCls.get(cid)!.push(Number(r.total_score));
      }
      const byClass = Array.from(byCls.entries()).map(([cid, sc]) => ({
        classId: cid,
        avgScore: round1(sc.reduce((a, b) => a + b, 0) / sc.length),
        scoreRate: fullScore > 0 ? Math.round((sc.reduce((a, b) => a + b, 0) / sc.length / fullScore) * 100) : 0
      }));
      subjectClassSummaries.push({ examId, subject: exam?.subject ?? exam?.name ?? String(examId), byClass });
    }
    return { classes, subjectClassSummaries };
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
    const fullScore = await this.resolveExamFullScore(examId);
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
      // Issue #175: 每班难度/区分度（与 getExamMetrics 口径一致：D = 逐题区分度均值）
      const qa = await this.getQuestionAnalysis(examId, cls.classId);
      const disc = qa.length > 0 ? qa.reduce((s, q) => s + (q.discrimination ?? 0), 0) / qa.length : 0;
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
        difficulty: fullScore > 0 ? Math.round((avg / fullScore) * 1000) / 1000 : 0,
        discrimination: Math.round(disc * 1000) / 1000,
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

    return { fullScore, classes, questionStats, ...(optionStats ? { optionStats } : {}) };
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

  // ── 建议 3：学生个人跨考试成长曲线 ──────────────────
  // 一次拉该生全部历史成绩 + 每场考试的年级/班级统计（批量化，避免循环查询）；
  // 排名优先复用 rankingUpdate 已落库的 rank/percentile，缺失时现场按总分排。
  // visibleExamIds 非空时仅统计调用者可见考试内的数据（越权防护，见 /students/:id/trend）。
  // null 表示不过滤；空数组表示无任何可见考试 → 直接返回空。
  async getStudentTrend(studentId: number, visibleExamIds: number[] | null = null): Promise<StudentTrendPoint[]> {
    if (visibleExamIds !== null && visibleExamIds.length === 0) return [];
    const filterVisible = visibleExamIds !== null;
    const params: Array<number | string> = [studentId];
    const visibleClause = filterVisible ? ` AND ss.exam_id IN (${placeholders(visibleExamIds!)})` : "";
    if (filterVisible) params.push(...visibleExamIds!);
    const s = await this.db.all(
      `SELECT ss.exam_id as examId, e.name as examName, e.subject,
              COALESCE(e.start_time, e.end_time, e.created_at) as examTime,
              ss.total_score as totalScore, ss.rank as rankStored, ss.percentile as pctStored
       FROM student_scores ss JOIN exams e ON e.id = ss.exam_id
       WHERE ss.student_id = ?${visibleClause}
       ORDER BY COALESCE(e.start_time, e.end_time, e.created_at) ASC, e.id ASC`,
      ...params
    ) as Array<{ examId: number; examName: string; subject: string | null; examTime: string; totalScore: number; rankStored: number | null; pctStored: number | null }>;
    if (s.length === 0) return [];
    const examIds = s.map((r) => r.examId);

    const gradeRows = await this.db.all(
      `SELECT ss.exam_id, ROUND(AVG(ss.total_score), 1) as gradeAvg, COUNT(*) as classSize
       FROM student_scores ss
       WHERE ss.exam_id IN (${placeholders(examIds)}) GROUP BY ss.exam_id`,
      ...examIds
    ) as Array<{ exam_id: number; gradeAvg: number | null; classSize: number }>;
    const gradeByExam = new Map<number, { gradeAvg: number; classSize: number }>();
    for (const r of gradeRows) gradeByExam.set(Number(r.exam_id), { gradeAvg: r.gradeAvg ?? 0, classSize: r.classSize });

    const classRow = await this.db.get("SELECT MIN(class_id) as class_id FROM class_students WHERE student_id = ?", studentId) as { class_id: number | null } | undefined;
    const classId = classRow?.class_id ?? null;
    const classAvgByExam = new Map<number, number>();
    if (classId != null) {
      const rows = await this.db.all(
        `SELECT ss.exam_id, ROUND(AVG(ss.total_score), 1) as classAvg
         FROM student_scores ss
         JOIN class_students cs ON cs.student_id = ss.student_id AND cs.class_id = ?
         WHERE ss.exam_id IN (${placeholders(examIds)}) GROUP BY ss.exam_id`,
        classId, ...examIds
      ) as Array<{ exam_id: number; classAvg: number | null }>;
      for (const r of rows) classAvgByExam.set(Number(r.exam_id), r.classAvg ?? 0);
    }

    // 排名兜底：未落库 rank 时按每场总分 competitionRank 现算
    const rankByExam = new Map<number, number>();
    const missingIds = [...new Set(s.filter((r) => r.rankStored == null).map((r) => r.examId))];
    if (missingIds.length > 0) {
      const scoreRows = await this.db.all(
        `SELECT exam_id, student_id, total_score FROM student_scores
         WHERE exam_id IN (${placeholders(missingIds)}) ORDER BY exam_id ASC, total_score DESC`,
        ...missingIds
      ) as Array<{ exam_id: number; student_id: number; total_score: number }>;
      const byExam = new Map<number, Array<{ student_id: number; total_score: number; rank: number }>>();
      for (const r of scoreRows) {
        const list = byExam.get(Number(r.exam_id)) ?? [];
        list.push({ student_id: r.student_id, total_score: r.total_score, rank: 0 });
        byExam.set(Number(r.exam_id), list);
      }
      for (const [eid, list] of byExam) {
        competitionRank(list, (r) => r.total_score, (r, rank) => { r.rank = rank; });
        const self = list.find((r) => r.student_id === studentId);
        if (self) rankByExam.set(eid, self.rank);
      }
    }

    const fullScores = await this.getExamFullScoreMap(examIds);
    return s.map((r) => {
      const grade = gradeByExam.get(r.examId) ?? { gradeAvg: 0, classSize: 0 };
      const rank = r.rankStored ?? rankByExam.get(r.examId) ?? 1;
      const pct = r.pctStored != null ? r.pctStored : rankPercentile(rank, grade.classSize);
      const fullScore = fullScores.get(r.examId) ?? 0;
      const total = Number(r.totalScore);
      return {
        examId: r.examId, examName: r.examName, subject: r.subject ?? "",
        examTime: r.examTime, totalScore: total,
        classAvg: classAvgByExam.get(r.examId) ?? 0, gradeAvg: grade.gradeAvg,
        classSize: grade.classSize, rank, percentile: Math.round(pct * 10) / 10,
        fullScore, scoreRate: fullScore > 0 ? Math.round((total / fullScore) * 1000) / 10 : 0,
      };
    });
  }

  // ── 建议 4：临界生（踩线生）名单 ────────────────────
  async getBorderlineStudents(
    examId: number,
    options: { classId?: number; lineKind?: BorderlineLineKind; lineValue?: number; margin?: number } = {}
  ): Promise<BorderlineResponse> {
    const fullScore = await this.resolveExamFullScore(examId);
    const thresholds = await getAnalysisThresholds();
    const lineKind: BorderlineLineKind = options.lineKind ?? "pass";
    const rawLine = options.lineValue ?? 60;
    let line: number;
    let lineLabel: string;
    switch (lineKind) {
      case "excellent":
        line = fullScore * thresholds.excellentRate; lineLabel = "优秀线";
        break;
      case "custom":
        line = rawLine; lineLabel = `自定义 ${rawLine} 分`;
        break;
      case "percent":
        line = fullScore * (Math.min(100, Math.max(0, rawLine)) / 100); lineLabel = `总分 ${rawLine}% 线`;
        break;
      default:
        line = fullScore * thresholds.passRate; lineLabel = "及格线";
    }
    const margin = options.margin ?? Math.max(1, Math.round(line * 0.05));

    const classId = options.classId;
    // 班级显示用「每生一行」的 csm（MIN class），过滤用 EXISTS 归属语义（多班级学生可命中任一所属班）
    const csmJoin = `LEFT JOIN (SELECT student_id, MIN(class_id) AS class_id FROM class_students GROUP BY student_id) csm ON csm.student_id = ss.student_id`;
    const clsWhere = classId === 0
      ? "AND NOT EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = ss.student_id)"
      : classId != null
        ? "AND EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = ss.student_id AND cs.class_id = ?)"
        : "";
    const clsParams = classId != null && classId > 0 ? [classId] : [];
    const rows = await this.db.all(
      `SELECT ss.student_id, ss.total_score, u.student_number, u.name, csm.class_id, c.name as class_name
       FROM student_scores ss
       JOIN users u ON u.id = ss.student_id
       ${csmJoin}
       LEFT JOIN classes c ON c.id = csm.class_id
       WHERE ss.exam_id = ? ${clsWhere}
       ORDER BY ss.total_score DESC`,
      examId, ...clsParams
    ) as Array<{ student_id: number; total_score: number; student_number: string; name: string; class_id: number | null; class_name: string | null }>;
    const ranked = rows.map((r) => ({ ...r, rank: 0 }));
    competitionRank(ranked, (r) => r.total_score, (r, rank) => { r.rank = rank; });
    const items: BorderlineStudentItem[] = [];
    for (const r of ranked) {
      const totalScore = Number(r.total_score);
      if (Math.abs(totalScore - line) > margin) continue;
      items.push({
        rank: r.rank, studentId: r.student_id, studentNumber: r.student_number ?? "",
        studentName: r.name ?? "", className: r.class_name ?? "未知班级", classId: r.class_id ?? null,
        totalScore, line: Math.round(line * 10) / 10, distance: Math.round(Math.abs(totalScore - line) * 10) / 10,
        distanceAbove: Math.round((totalScore - line) * 10) / 10,
        side: totalScore >= line ? "above" : "below",
      });
    }
    items.sort((a, b) => a.distance - b.distance || a.totalScore - b.totalScore);
    return { examId, lineKind, lineLabel, line: Math.round(line * 10) / 10, margin, fullScore, items };
  }

  // ── 建议 7：偏科预警（Z 分，跨科比较）───────────────
  async getSubjectDeviation(examIds: number[], options: { classId?: number; threshold?: number } = {}): Promise<SubjectDeviationResponse> {
    const ids = normalizeExamIds(examIds);
    const threshold = options.threshold ?? 0.8;
    if (ids.length === 0) return { examIds: [], threshold, items: [] };
    const exams = await this.db.all(`SELECT id, subject FROM exams WHERE id IN (${placeholders(ids)})`, ...ids) as Array<{ id: number; subject: string | null }>;
    const subjectOf = new Map(exams.map((e) => [Number(e.id), e.subject ?? String(e.id)]));
    const scoreRows = await this.db.all(
      `SELECT ss.exam_id, ss.student_id, ss.total_score, u.student_number, u.name,
              csm.class_id, c.name as class_name
       FROM student_scores ss
       JOIN users u ON u.id = ss.student_id
       LEFT JOIN (SELECT student_id, MIN(class_id) AS class_id FROM class_students GROUP BY student_id) csm ON csm.student_id = ss.student_id
       LEFT JOIN classes c ON c.id = csm.class_id
       WHERE ss.exam_id IN (${placeholders(ids)})`,
      ...ids
    ) as Array<{ exam_id: number; student_id: number; total_score: number; student_number: string; name: string; class_id: number | null; class_name: string | null }>;
    // 年级均分/标准差：Z 基准为年级全体，classId 只过滤输出学生
    const scoresByExam = new Map<number, number[]>();
    for (const r of scoreRows) {
      const list = scoresByExam.get(Number(r.exam_id)) ?? [];
      list.push(Number(r.total_score));
      scoresByExam.set(Number(r.exam_id), list);
    }
    const statsByExam = new Map<number, { mean: number; std: number }>();
    for (const [eid, list] of scoresByExam) statsByExam.set(eid, { mean: mean(list), std: stdDev(list) });

    const classFilter = options.classId;
    const byStudent = new Map<number, SubjectDeviationItem>();
    for (const r of scoreRows) {
      if (classFilter != null) {
        if (classFilter === 0 && r.class_id != null) continue;
        if (classFilter > 0 && Number(r.class_id) !== classFilter) continue;
      }
      let entry = byStudent.get(r.student_id);
      if (!entry) {
        entry = { studentId: r.student_id, studentNumber: r.student_number ?? "", studentName: r.name ?? "", className: r.class_name ?? "未知班级", subjects: [], lowestZ: 0, lowestSubject: "", flagged: false };
        byStudent.set(r.student_id, entry);
      }
      const st = statsByExam.get(Number(r.exam_id)) ?? { mean: 0, std: 0 };
      const score = Number(r.total_score);
      const z = st.std > 0 ? (score - st.mean) / st.std : 0;
      entry.subjects.push({
        examId: Number(r.exam_id), subject: subjectOf.get(Number(r.exam_id)) ?? "",
        score, gradeAvg: Math.round(st.mean * 10) / 10, gradeStd: Math.round(st.std * 10) / 10,
        z: Math.round(z * 100) / 100,
      });
    }
    const items = Array.from(byStudent.values()).map((e) => {
      const lowest = e.subjects.reduce((a, b) => (b.z < a.z ? b : a), e.subjects[0]);
      return { ...e, lowestZ: lowest.z, lowestSubject: lowest.subject, flagged: lowest.z < -threshold };
    });
    items.sort((a, b) => Number(b.flagged) - Number(a.flagged) || a.lowestZ - b.lowestZ);
    return { examIds: ids, threshold, items };
  }

  // ── 建议 10：班级知识点掌握对比 ────────────────────
  async getClassKnowledgeStats(examId: number, classIds?: number[]): Promise<ClassKnowledgeResponse> {
    // 覆盖率基准：不带班级连接统计「已标注题目作答」——避免多班级学生（class_students 多行）翻倍计数
    const taggedRow = await this.db.get(
      `SELECT COUNT(*) as cnt FROM question_scores qs
       JOIN exams e ON e.id = qs.exam_id
       JOIN knowledge_points kp ON kp.card_id = e.card_id AND kp.question_number = qs.question_number
       WHERE qs.exam_id = ?`,
      examId
    ) as { cnt: number } | undefined;
    const taggedTotal = taggedRow?.cnt ?? 0;
    const allRow = await this.db.get(`SELECT COUNT(*) as cnt FROM question_scores WHERE exam_id = ?`, examId) as { cnt: number };
    const coverageRate = allRow.cnt > 0 ? Math.round((taggedTotal / allRow.cnt) * 100) : (taggedTotal > 0 ? 100 : 0);
    const empty = taggedTotal === 0;

    const classFilterClause = classIds && classIds.length > 0
      ? `AND cs.class_id IN (${placeholders(classIds)})`
      : "";
    const params: unknown[] = [examId];
    if (classIds && classIds.length > 0) params.push(...classIds);
    const rows = await this.db.all(
      `SELECT qs.student_id, qs.question_number, qs.score, qs.max_score,
              cs.class_id, c.name as class_name, kp.point_text
       FROM question_scores qs
       JOIN exams e ON e.id = qs.exam_id
       JOIN knowledge_points kp ON kp.card_id = e.card_id AND kp.question_number = qs.question_number
       LEFT JOIN class_students cs ON cs.student_id = qs.student_id
       LEFT JOIN classes c ON c.id = cs.class_id
       WHERE qs.exam_id = ? ${classFilterClause}`,
      ...params
    ) as Array<{ student_id: number; question_number: number; score: number; max_score: number; class_id: number | null; class_name: string | null; point_text: string }>;

    interface PointAgg { byClass: Map<number, { sum: number; max: number; className: string; questions: Set<number> }> }
    const points = new Map<string, PointAgg>();
    const classes = new Map<number, string>();
    for (const r of rows) {
      const cid = Number(r.class_id);
      if (cid > 0 && !classes.has(cid)) classes.set(cid, r.class_name ?? `班级${cid}`);
      const key = r.point_text ?? "";
      let agg = points.get(key);
      if (!agg) { agg = { byClass: new Map() }; points.set(key, agg); }
      const a = agg.byClass.get(cid) ?? { sum: 0, max: 0, className: r.class_name ?? "", questions: new Set<number>() };
      a.sum += Number(r.score); a.max += Number(r.max_score); a.questions.add(Number(r.question_number));
      agg.byClass.set(cid, a);
    }
    const knowledgePoints = Array.from(points.keys()).sort((a, b) => a.localeCompare(b, "zh"));
    const classEntries = Array.from(classes.entries()).map(([classId, className]) => ({ classId, className }));
    const matrix = knowledgePoints.map((point) => {
      const agg = points.get(point)!;
      return {
        knowledgePoint: point,
        byClass: classEntries.map((c) => {
          const a = agg.byClass.get(c.classId);
          return {
            classId: c.classId,
            scoreRate: a && a.max > 0 ? Math.round((a.sum / a.max) * 1000) / 10 : null,
            questionCount: a ? a.questions.size : 0,
          };
        }),
      };
    });
    return { examId, knowledgePoints, classes: classEntries, matrix, coverageRate, empty };
  }

  // ── 建议 14：年级间同类考试对比（同答题卡模板）──────
  async getComparableExams(examId: number): Promise<ComparableResponse> {
    const exam = await this.db.get(
      `SELECT e.card_id, ac.title, e.subject FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id WHERE e.id = ?`,
      examId
    ) as { card_id: string | null; title: string | null } | undefined;
    if (!exam?.card_id) return { cardId: null, cardTitle: "", currentExamId: examId, exams: [] };
    const rows = await this.db.all(
      `SELECT e.id, e.name, g.name as grade_name, date(COALESCE(ac.exam_date, e.created_at)) as exam_date
       FROM exams e
       LEFT JOIN answer_cards ac ON ac.id = e.card_id
       LEFT JOIN grades g ON g.id = e.grade_id
       WHERE e.card_id = ?
       ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC`,
      exam.card_id
    ) as Array<{ id: number; name: string; grade_name: string | null; exam_date: string | null }>;
    const examsOut: ComparableExamItem[] = [];
    for (const r of rows.slice(0, 20)) {
      const metrics = await this.getExamMetrics(Number(r.id));
      const ov = await this.getExamOverview(Number(r.id));
      examsOut.push({
        examId: Number(r.id), examName: r.name, gradeName: r.grade_name,
        examDate: dateOnly(r.exam_date), gradedCount: metrics.gradedCount,
        avgScore: metrics.avgScore, stdDev: ov.stdDev,
        difficulty: metrics.difficulty, discrimination: metrics.discrimination, fullScore: metrics.fullScore,
      });
    }
    return { cardId: exam.card_id, cardTitle: exam.title ?? "", currentExamId: examId, exams: examsOut };
  }

  // ── 建议 15：学科命题质量趋势追踪（历次 P/D）────────
  async getSubjectQuality(subject?: string, examIds?: number[] | null): Promise<SubjectQualityResponse> {
    const s = (subject ?? "").trim();
    if (!s) return { subject: "", points: [] };
    // #246：EXAM_NOT_SOFT_DELETED 排除软删除考试；examIds 为教师可见范围（null = 不限）
    let sql = `SELECT e.id, e.name, date(COALESCE(ac.exam_date, e.created_at)) as exam_date,
              (SELECT COUNT(*) FROM student_scores ss WHERE ss.exam_id = e.id) as graded_count
       FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id
       WHERE e.subject = ? AND (SELECT COUNT(*) FROM student_scores ss WHERE ss.exam_id = e.id) > 0
         AND ${EXAM_NOT_SOFT_DELETED_SQL}`;
    const params: unknown[] = [s];
    if (examIds != null) {
      if (examIds.length === 0) return { subject: s, points: [] };
      sql += ` AND e.id IN (${examIds.map(() => "?").join(",")})`;
      params.push(...examIds);
    }
    sql += ` ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC LIMIT 60`;
    const rows = await this.db.all(sql, ...params) as Array<{ id: number; name: string; exam_date: string | null; graded_count: number }>;
    const points: SubjectQualityPoint[] = [];
    for (const r of rows) {
      const metrics = await this.getExamMetrics(Number(r.id));
      points.push({
        examId: Number(r.id), examName: r.name, examDate: dateOnly(r.exam_date),
        difficulty: metrics.difficulty, discrimination: metrics.discrimination,
        avgScore: metrics.avgScore, fullScore: metrics.fullScore, gradedCount: Number(r.graded_count),
      });
    }
    return { subject: s, points };
  }

  // ── 建议 11：错题本数据行（score < max_score × threshold）──
  async getWrongQuestionRows(examId: number, options: { classId?: number; threshold?: number } = {}): Promise<WrongQuestionRow[]> {
    const threshold = Math.min(0.99, Math.max(0, options.threshold ?? 0.6));
    const classId = options.classId;
    // 班级显示用 csm（每生一行），过滤用 EXISTS 归属语义
    const clsWhere = classId === 0
      ? "AND NOT EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = ss.student_id)"
      : classId != null
        ? "AND EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = ss.student_id AND cs.class_id = ?)"
        : "";
    const clsParams = classId != null && classId > 0 ? [classId] : [];
    const rows = await this.db.all(
      `SELECT ss.student_id, u.student_number, u.name, c.name as class_name, ss.total_score,
              qs.question_number, qs.max_score, qs.score
       FROM question_scores qs
       JOIN student_scores ss ON ss.exam_id = qs.exam_id AND ss.student_id = qs.student_id
       JOIN users u ON u.id = ss.student_id
       LEFT JOIN (SELECT student_id, MIN(class_id) AS class_id FROM class_students GROUP BY student_id) csm ON csm.student_id = ss.student_id
       LEFT JOIN classes c ON c.id = csm.class_id
       WHERE qs.exam_id = ? AND qs.max_score > 0 AND qs.score < qs.max_score * ${threshold} ${clsWhere}
       ORDER BY ss.total_score DESC, u.student_number, qs.question_number`,
      examId, ...clsParams
    ) as Array<{ student_id: number; student_number: string; name: string; class_name: string | null; total_score: number; question_number: number; max_score: number; score: number }>;
    return rows.map((r) => ({
      studentId: r.student_id, studentNumber: r.student_number ?? "", studentName: r.name ?? "",
      className: r.class_name ?? "未知班级", totalScore: Number(r.total_score), wrongCount: 1,
      questionNumber: Number(r.question_number), maxScore: Number(r.max_score), score: Number(r.score),
      scoreRate: Number(r.max_score) > 0 ? Math.round((Number(r.score) / Number(r.max_score)) * 100) : 0,
    }));
  }

  private async hydrateExamGroup(row: any): Promise<CrossExamGroup> {
    // #246 auto_delete：软删除考试不进跨场对比组的成员列表
    const items = await this.db.all(`SELECT exam_id FROM exam_group_members egm WHERE egm.group_id = ? AND ${GROUP_MEMBER_NOT_SOFT_DELETED_SQL} ORDER BY egm.sort_order ASC, egm.exam_id ASC`, row.id) as Array<{ exam_id: number }>;
    const examIds = items.map(i => i.exam_id);
    return { id: row.id, name: row.name, source: row.source, startDate: row.start_date, endDate: row.end_date, gradeId: row.grade_id ?? null, examIds, exams: await this.getExamFilterItemsByIds(examIds), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private emptyCrossExamTotal(mode: CrossExamTotalMode, group: CrossExamGroup | null): CrossExamTotalResponse {
    return { mode, group, exams: [], rows: [], classSummaries: [], summary: { examCount: 0, studentCount: 0, totalFullScore: 0, avgTotalScore: 0, maxTotalScore: 0, minTotalScore: 0, fullAttendanceCount: 0 } };
  }

  /** PR #256（v41）：仅保留已公布（score_published=1）考试，保持原顺序；供学生端聚合过滤。 */
  async filterPublishedExamIds(examIds: number[]): Promise<number[]> {
    if (examIds.length === 0) return [];
    const rows = await this.db.all<{ id: number }>(
      `SELECT id FROM exams WHERE id IN (${placeholders(examIds)}) AND score_published = 1`,
      ...examIds
    );
    const pub = new Set(rows.map((r) => Number(r.id)));
    return examIds.filter((id) => pub.has(id));
  }

  private async getCrossExamTotalExams(examIds: number[]): Promise<CrossExamTotalExam[]> {
    const fullScores = await this.getExamFullScoreMap(examIds);
    // #246：软删除考试不进跨考聚合（selected 模式可经构造 examIds 触达，此处为统一收口）
    const rows = await this.db.all(`SELECT e.id, e.name, e.subject, g.name as gradeName, date(COALESCE(ac.exam_date, e.created_at)) as examDate, COUNT(ss.exam_id) as gradedCount, ROUND(AVG(ss.total_score), 1) as avgScore FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id LEFT JOIN grades g ON g.id = e.grade_id LEFT JOIN student_scores ss ON ss.exam_id = e.id WHERE e.id IN (${placeholders(examIds)}) AND ${EXAM_NOT_SOFT_DELETED_SQL} GROUP BY e.id ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC`, ...examIds) as any[];
    return rows.map((r: any) => ({ id: r.id, name: r.name, subject: r.subject, gradeName: r.gradeName, examDate: dateOnly(r.examDate), fullScore: round1(fullScores.get(r.id) ?? 0), gradedCount: r.gradedCount, avgScore: r.avgScore }));
  }

  /** 单场满分统一解析：question_scores 合计 → 缺失时 MAX(total_score) → 0（B7，与批量 Map 同一兜底口径，消除虚构 100） */
  private async resolveExamFullScore(examId: number): Promise<number> {
    return (await this.getExamFullScoreMap([examId])).get(examId) ?? 0;
  }

  async getExamFullScoreMap(examIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    // 空数组早退：IN () 空表在 MySQL/MariaDB 均 1064（五轮A2 加固）
    if (examIds.length === 0) return result;
    // 五轮A2: 原两层嵌套派生表（内层 MAX 分组 + 外层 SUM 按 exam 归并）改为单层
    // 分组 + JS 侧归并，行为等价且无嵌套聚合的方言差异。
    const qRows = await this.db.all(
      `SELECT qs.exam_id, qs.question_number, qs.score_type, MAX(qs.max_score) AS max_score
       FROM question_scores qs
       WHERE qs.exam_id IN (${placeholders(examIds)})
       GROUP BY qs.exam_id, qs.question_number, qs.score_type`,
      ...examIds
    ) as any[];
    const perExam = new Map<number, number>();
    for (const r of qRows) {
      const examId = Number(r.exam_id);
      const val = Number(r.max_score ?? 0);
      perExam.set(examId, (perExam.get(examId) ?? 0) + val);
    }
    for (const [examId, sum] of perExam) if (sum > 0) result.set(examId, sum);
    const missing = examIds.filter((id) => !result.has(id));
    if (missing.length > 0) {
      const fb = await this.db.all(`SELECT exam_id, MAX(total_score) as fullScore FROM student_scores WHERE exam_id IN (${placeholders(missing)}) GROUP BY exam_id`, ...missing) as any[];
      for (const r of fb) result.set(Number(r.exam_id), Number(r.fullScore ?? 0));
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
