/**
 * 每周考试审计服务 —— 周报告发布（成绩分析页「周报」板块后端）。
 *
 * 发布规则（按产品需求）：
 *  - 每周六上午 08:00 发布本周报告（周定义：服务器本地时区 周一~周日，
 *    报告覆盖刚结束工作日的本周；考试有效日期 = COALESCE(answer_cards.exam_date, exams.created_at)）。
 *  - 若本周还有 quiz 考试未完成（未出分 = 没有任何 student_scores，草稿除外），
 *    则推迟发布，每小时重试直至全部完成。
 *  - 发布动作本身幂等：按年级 ensure 周晨测组（source='week'）并 diff 同步成员。
 *  - 读取侧（getSummary）只读已发布组，不随访问自动建组 —— 未到发布门槛的周
 *    在前端显示「报告未发布」状态，避免出现半成品周报。
 *
 * 报告收录条件：exam_mode='quiz' 且有效日期落在该周 且 至少一条 student_scores。
 * 不动 getExamIdsForDatePackage（保持现有「按日期打包」语义）。
 */

import { getMysqlDb } from "../db";
import { AnalysisRepository } from "../repositories/AnalysisRepository";
import type {
  CrossExamTotalExam, CrossExamTotalRow, WeeklyAuditGradeInfo,
  WeeklyAuditResponse, WeeklyAuditSummary, WeeklyAuditWeakPoint,
  WeeklyAuditWeekOption
} from "../../shared/types";

interface WeekWindow {
  weekStart: string;
  weekEnd: string;
  label: string;
  rangeLabel: string;
  year: number;
  weekNumber: number;
}

interface ReadGradeGroup {
  gradeId: number;
  gradeName: string;
  groupId: number;
  examCount: number;
}

function round1(v: number): number { return Math.round(v * 10) / 10; }

function toDate(d: string): Date { return new Date(`${d}T00:00:00`); }

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: string, n: number): string {
  const dt = toDate(d);
  dt.setDate(dt.getDate() + n);
  return fmt(dt);
}

/** ISO 8601 周数（周一定义，与 getWeekWindow 一致） */
function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** 某日期所在周的周一~周日窗口（服务器本地时区），offset 为周偏移（0=该日期所在周） */
function weekWindowFor(ref: Date, offset = 0): WeekWindow {
  const day = (ref.getDay() + 6) % 7; // 周一=0
  const monday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - day + offset * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const weekStart = fmt(monday);
  const weekEnd = fmt(sunday);
  const weekNumber = isoWeekNumber(monday);
  return {
    weekStart, weekEnd,
    label: `${monday.getFullYear()}年第${weekNumber}周`,
    rangeLabel: `${weekStart.slice(5)} ~ ${weekEnd.slice(5)}`,
    year: monday.getFullYear(),
    weekNumber
  };
}

/** 计算某偏移周的周一/周日与「第 N 周」标签（0=本周，-1=上周） */
export function getWeekWindow(weekOffset: number): WeekWindow {
  return weekWindowFor(new Date(), weekOffset);
}

/** 某周报告的最早发布时刻 = 该周周六 08:00（服务器本地时区） */
export function weekPublishAt(weekStart: string): Date {
  const d = toDate(weekStart);
  d.setDate(d.getDate() + 5); // 周六（周一 +5）
  d.setHours(8, 0, 0, 0);
  return d;
}

/** 组内成员考试日期落在周一~周五的天数（统计基准 5 个工作日） */
function countCoverageDays(exams: CrossExamTotalExam[], weekStart: string): number {
  const weekEnd = addDays(weekStart, 6);
  const dates = new Set<string>();
  for (const exam of exams) {
    if (!exam.examDate || exam.examDate < weekStart || exam.examDate > weekEnd) continue;
    const idx = (toDate(exam.examDate).getDay() + 6) % 7;
    if (idx < 5) dates.add(exam.examDate);
  }
  return dates.size;
}

function buildClassSummaries(rows: CrossExamTotalRow[], totalFullScore: number): WeeklyAuditSummary["classSummaries"] {
  const byClass = new Map<number, { className: string; count: number; scoreRates: number[]; absent: number }>();
  for (const row of rows) {
    const cid = row.classId ?? 0;
    let item = byClass.get(cid);
    if (!item) {
      item = { className: row.className, count: 0, scoreRates: [], absent: 0 };
      byClass.set(cid, item);
    }
    item.count += 1;
    if (row.scoreRate != null) item.scoreRates.push(row.scoreRate);
    item.absent += row.absentCount;
  }
  return Array.from(byClass.entries())
    .map(([classId, item]) => ({
      classId,
      className: item.className,
      count: item.count,
      avgScoreRate: item.scoreRates.length > 0 ? round1(item.scoreRates.reduce((a, b) => a + b, 0) / item.scoreRates.length) : 0,
      absentCount: item.absent
    }))
    .sort((a, b) => a.className.localeCompare(b.className));
}

export class WeeklyAuditService {
  private repo: AnalysisRepository;

  constructor() { this.repo = new AnalysisRepository(); }

  /**
   * 发布门槛检查：该周（周一~周日）内的 quiz 考试是否全部完成。
   * 「完成」= 有出分（至少一条 student_scores）；草稿状态的考试不计入门槛
   * （视为尚未正式安排的考试）。
   */
  async checkWeekComplete(weekStart: string): Promise<{ complete: boolean; pendingExamNames: string[] }> {
    const db = getMysqlDb();
    const weekEnd = addDays(weekStart, 6);
    const rows = await db.all(`
      SELECT e.id, e.name, e.status,
             (SELECT COUNT(*) FROM student_scores ss WHERE ss.exam_id = e.id) AS score_count
      FROM exams e
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      WHERE e.exam_mode = 'quiz'
        AND date(COALESCE(ac.exam_date, e.created_at)) >= date(?)
        AND date(COALESCE(ac.exam_date, e.created_at)) <= date(?)
      ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC
    `, weekStart, weekEnd) as Array<{ id: number; name: string; status: string; score_count: number }>;
    const pending = rows
      .filter((r) => r.status !== "draft" && Number(r.score_count) === 0)
      .map((r) => r.name);
    return { complete: pending.length === 0, pendingExamNames: pending };
  }

  /**
   * 发布到点的周报告（幂等）：候选周 = 当前周 + 上周；
   * 仅当 已过该周周六 08:00 且 该周考试全部完成 时才 ensure 组（= 发布）。
   * 未完成则跳过，由定时器下轮重试（顺延到全部完成）。供定时任务与测试调用。
   */
  async publishDueWeeks(now: Date): Promise<{ published: string[] }> {
    const published: string[] = [];
    const candidates = [weekWindowFor(now, 0), weekWindowFor(now, -1)];
    for (const window of candidates) {
      if (now < weekPublishAt(window.weekStart)) continue; // 未到发布时刻
      const { complete } = await this.checkWeekComplete(window.weekStart);
      if (!complete) continue; // 顺延：等全部考试完成
      await this.ensureWeeklyQuizGroups(window.weekStart);
      published.push(window.label);
    }
    return { published };
  }

  /**
   * 幂等确保某周的每周晨测组（发布动作）：
   *  - 按年级查询本周有出分的 quiz 考试；
   *  - 按 source='week' + grade_id + start_date + end_date 查找现有组，无则创建，有则 diff 同步成员；
   *  - 空周（该年级无晨测）不建组。
   */
  async ensureWeeklyQuizGroups(weekStart: string): Promise<{ gradeId: number; gradeName: string; groupId: number }[]> {
    const db = getMysqlDb();
    const weekEnd = addDays(weekStart, 6);
    const rows = await db.all(`
      SELECT e.grade_id, g.name AS grade_name, g.sort_order, e.id AS exam_id
      FROM exams e
      JOIN grades g ON g.id = e.grade_id
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      WHERE e.exam_mode = 'quiz'
        AND date(COALESCE(ac.exam_date, e.created_at)) >= date(?)
        AND date(COALESCE(ac.exam_date, e.created_at)) <= date(?)
        AND EXISTS (SELECT 1 FROM student_scores ss WHERE ss.exam_id = e.id)
      ORDER BY date(COALESCE(ac.exam_date, e.created_at)) ASC, e.id ASC
    `, weekStart, weekEnd) as Array<{ grade_id: number | null; grade_name: string | null; sort_order: number | null; exam_id: number }>;

    const byGrade = new Map<number, { gradeName: string; sortOrder: number; examIds: number[] }>();
    for (const row of rows) {
      if (row.grade_id == null) continue; // 无年级的考试不参与按年级分组的周审计
      let item = byGrade.get(row.grade_id);
      if (!item) {
        item = { gradeName: row.grade_name ?? "", sortOrder: row.sort_order ?? 0, examIds: [] };
        byGrade.set(row.grade_id, item);
      }
      item.examIds.push(row.exam_id);
    }

    const groups: { gradeId: number; gradeName: string; groupId: number }[] = [];
    for (const [gradeId, info] of Array.from(byGrade.entries()).sort((a, b) => a[1].sortOrder - b[1].sortOrder || a[1].gradeName.localeCompare(b[1].gradeName))) {
      const groupId = await this.ensureGradeWeekGroup(weekStart, weekEnd, gradeId, info.gradeName, info.examIds);
      groups.push({ gradeId, gradeName: info.gradeName, groupId });
    }
    return groups;
  }

  /** 查/建某年级某周的晨测组（成员在事务内 diff 同步，sort_order 按考试日期） */
  private async ensureGradeWeekGroup(weekStart: string, weekEnd: string, gradeId: number, gradeName: string, examIds: number[]): Promise<number> {
    const db = getMysqlDb();
    const existing = await db.get(
      "SELECT id FROM exam_groups WHERE source = 'week' AND grade_id = ? AND start_date = ? AND end_date = ? LIMIT 1",
      gradeId, weekStart, weekEnd
    ) as { id: number } | null;
    if (existing) {
      await this.syncGroupMembers(existing.id, examIds);
      return existing.id;
    }
    const window = weekWindowFor(toDate(weekStart));
    const name = `${window.year}年第${window.weekNumber}周晨测包（${window.rangeLabel}）`;
    const group = await this.repo.createExamGroup({
      name,
      examIds,
      source: "week",
      startDate: weekStart,
      endDate: weekEnd,
      gradeId
    });
    return group.id;
  }

  /** diff 同步组成员：删除不在目标集合的、补齐缺失的、按考试日期重排 sort_order */
  private async syncGroupMembers(groupId: number, examIds: number[]): Promise<void> {
    const db = getMysqlDb();
    const desired = Array.from(new Set(examIds));
    const desiredSet = new Set(desired);
    await db.transaction(async (tx) => {
      const current = await tx.all<{ exam_id: number }>(
        "SELECT exam_id FROM exam_group_members WHERE group_id = ?",
        groupId
      );
      for (const row of current) {
        if (!desiredSet.has(Number(row.exam_id))) {
          await tx.run("DELETE FROM exam_group_members WHERE group_id = ? AND exam_id = ?", groupId, row.exam_id);
        }
      }
      for (const [index, examId] of desired.entries()) {
        const exists = current.some((r) => Number(r.exam_id) === examId);
        if (exists) {
          await tx.run("UPDATE exam_group_members SET sort_order = ? WHERE group_id = ? AND exam_id = ?", index, groupId, examId);
        } else {
          await tx.run("INSERT INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, ?)", groupId, examId, index);
        }
      }
    });
  }

  /** 只读已发布的周组（按周窗口定位，不创建） */
  private async readWeeklyQuizGroups(weekStart: string): Promise<ReadGradeGroup[]> {
    const db = getMysqlDb();
    const weekEnd = addDays(weekStart, 6);
    const rows = await db.all(`
      SELECT eg.id AS group_id, eg.grade_id, g.name AS grade_name,
             (SELECT COUNT(*) FROM exam_group_members egm WHERE egm.group_id = eg.id) AS exam_count
      FROM exam_groups eg
      JOIN grades g ON g.id = eg.grade_id
      WHERE eg.source = 'week' AND eg.start_date = ? AND eg.end_date = ?
      ORDER BY g.sort_order, g.name
    `, weekStart, weekEnd) as Array<{ group_id: number; grade_id: number; grade_name: string; exam_count: number }>;
    return rows.map((r) => ({
      gradeId: r.grade_id,
      gradeName: r.grade_name,
      groupId: r.group_id,
      examCount: Number(r.exam_count)
    }));
  }

  /** 单周单年级汇总（复用 getCrossExamTotal / getGroupQuestionAnalysis） */
  private async buildSummary(window: WeekWindow, group: ReadGradeGroup): Promise<WeeklyAuditSummary> {
    const cross = await this.repo.getCrossExamTotal({ mode: "group", groupId: group.groupId });
    const totalFullScore = cross.summary.totalFullScore;
    const avgScoreRate = totalFullScore > 0 ? round1((cross.summary.avgTotalScore / totalFullScore) * 100) : 0;
    const weakPoints = await this.getWeakPoints(group.groupId);
    return {
      weekStart: window.weekStart,
      weekEnd: window.weekEnd,
      weekLabel: window.label,
      gradeId: group.gradeId,
      gradeName: group.gradeName,
      groupId: group.groupId,
      examCount: cross.summary.examCount,
      participantCount: cross.summary.studentCount,
      avgScoreRate,
      attendedCount: cross.rows.reduce((s, r) => s + r.attendedCount, 0),
      fullAttendanceCount: cross.summary.fullAttendanceCount,
      coverageDays: countCoverageDays(cross.exams, window.weekStart),
      coverageTargetDays: 5,
      classSummaries: buildClassSummaries(cross.rows, totalFullScore),
      weakPoints,
      vsLastWeek: null
    };
  }

  /** 得分率最低 Top 5 薄弱题（跨学科合并） */
  private async getWeakPoints(groupId: number): Promise<WeeklyAuditWeakPoint[]> {
    const qa = await this.repo.getGroupQuestionAnalysis(groupId);
    const points: WeeklyAuditWeakPoint[] = [];
    for (const subject of qa.subjects) {
      for (const question of subject.questions) {
        points.push({
          examId: subject.examId,
          examName: subject.examName,
          subject: subject.subject,
          questionNumber: String(question.questionNumber),
          scoreRate: question.scoreRate,
          knowledgePoint: question.knowledgePoint ?? null
        });
      }
    }
    points.sort((a, b) => a.scoreRate - b.scoreRate);
    return points.slice(0, 5);
  }

  /** 较上周变化：上周同年级组不存在或为空时返回 null */
  private async buildVsLastWeek(window: WeekWindow, gradeId: number, current: WeeklyAuditSummary): Promise<WeeklyAuditSummary["vsLastWeek"]> {
    const prevWindow = weekWindowFor(toDate(window.weekStart), -1);
    const prevGrades = await this.readWeeklyQuizGroups(prevWindow.weekStart);
    const prevGroup = prevGrades.find((g) => g.gradeId === gradeId);
    if (!prevGroup) return null;
    const prevSummary = await this.buildSummary(prevWindow, prevGroup);
    if (prevSummary.examCount === 0) return null;
    return {
      avgScoreRateChange: round1(current.avgScoreRate - prevSummary.avgScoreRate),
      participantChange: current.participantCount - prevSummary.participantCount,
      examCountChange: current.examCount - prevSummary.examCount
    };
  }

  /**
   * 成绩分析页汇总（只读已发布报告）：近 5 周选项（含发布状态）+
   * 指定周的年级列表 + 选中（周 + 年级）的已发布汇总。
   * week 缺省 = 本周；gradeId 缺省 = 该周第一个年级（按年级排序）。
   */
  async getSummary(weekParam?: string, gradeId?: number, now: Date = new Date()): Promise<WeeklyAuditResponse> {
    const weeks = [0, -1, -2, -3, -4].map((offset) => getWeekWindow(offset));
    let selected = weeks[0];
    if (weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
      const match = weeks.find((w) => w.weekStart === weekParam);
      if (match) selected = match;
    }

    const completions = await Promise.all(weeks.map((w) => this.checkWeekComplete(w.weekStart)));
    const weekOptions: WeeklyAuditWeekOption[] = weeks.map((w, i) => {
      const publishAt = weekPublishAt(w.weekStart);
      const due = now >= publishAt;
      return {
        weekStart: w.weekStart,
        weekEnd: w.weekEnd,
        label: w.label,
        rangeLabel: w.rangeLabel,
        published: due && completions[i].complete,
        publishAt: publishAt.toISOString(),
        publishAtLabel: `${fmt(publishAt)} ${String(publishAt.getHours()).padStart(2, "0")}:${String(publishAt.getMinutes()).padStart(2, "0")}`,
        pendingExamNames: due ? completions[i].pendingExamNames : []
      };
    });

    const grades = await this.readWeeklyQuizGroups(selected.weekStart);
    const gradeInfos: WeeklyAuditGradeInfo[] = grades.map((g) => ({
      gradeId: g.gradeId,
      gradeName: g.gradeName,
      groupId: g.groupId,
      examCount: g.examCount
    }));
    const target = gradeId != null && gradeId > 0
      ? grades.find((g) => g.gradeId === gradeId) ?? grades[0] ?? null
      : grades[0] ?? null;

    let active: WeeklyAuditSummary | null = null;
    if (target) {
      const summary = await this.buildSummary(selected, target);
      summary.vsLastWeek = await this.buildVsLastWeek(selected, target.gradeId, summary);
      active = summary;
    }
    return { weeks: weekOptions, grades: gradeInfos, active };
  }
}

/**
 * 每周六 08:00 发布周报告；若该周考试未全部完成则顺延（每小时重试直至完成）。
 * setInterval + unref，不阻塞进程退出。
 */
export function scheduleWeeklyAuditRefresh(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void new WeeklyAuditService()
      .publishDueWeeks(new Date())
      .then((r) => {
        if (r.published.length > 0) {
          console.log(`[WeeklyAudit] 周报告已发布: ${r.published.join("、")}`);
        }
      })
      .catch((err) => console.error("[WeeklyAudit] 周报告发布失败:", err instanceof Error ? err.message : err));
  }, 3600_000);
  timer.unref();
  return timer;
}