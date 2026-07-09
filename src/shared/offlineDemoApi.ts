/**
 * Offline demo mock API — serves testdata/demo-exams payload through the same
 * fetchJson paths the main SPA uses, so UI/operation logic stays identical.
 */
import { buildStaticDemoPayload } from "../../testdata/demo-exams/demo-dataset";
import { competitionRank } from "./ranking";
import { OFFLINE_DEMO_TOKEN } from "./offlineDemo";
import type {
  CrossExamGroup,
  CrossExamTotalRequest,
  CrossExamTotalResponse,
  ExamFilterItem,
  ExamGroupFilterItem,
  ExamOverview,
  PreviousExamComparison,
  QuestionAnalysisItem,
  ScoreSummary,
  ScoreTableRow,
  StudentRankingItem
} from "./types";
export type OfflineDemoAuthUser = {
  id: number;
  username: string;
  name: string;
  role_id: number;
  role_name: string;
  role_display_name?: string;
  student_number: string | null;
  teacher_role?: string | null;
  subject?: string | null;
  permissions: string[];
};

export type OfflineDemoLoginResponse = {
  token: string;
  user: OfflineDemoAuthUser;
  permissions: string[];
  message?: string;
};

const DEMO_PERMISSIONS = [
  "card:read", "card:write",
  "exam:read", "exam:write",
  "grade:read", "grade:write",
  "score:read",
  "user:manage", "class:manage", "system:manage"
];

type DemoPayload = ReturnType<typeof buildStaticDemoPayload>;
type DemoExam = DemoPayload["exams"][number];
type DemoStudent = DemoPayload["students"][number];

const DEMO_GRADE_ID = 9001;
const DEMO_CLASS_IDS: Record<string, number> = {
  演示1班: 9101,
  演示2班: 9102
};

let cached: DemoPayload | null = null;

function data(): DemoPayload {
  if (!cached) cached = buildStaticDemoPayload();
  return cached;
}

function examNumericId(cardId: string): number {
  const n = Number(cardId);
  return Number.isFinite(n) ? n : 0;
}

function findExamById(examId: number): DemoExam | undefined {
  return data().exams.find((e) => examNumericId(e.cardId) === examId);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function rankPercentile(rank: number, total: number): number {
  if (total <= 1) return 100;
  const raw = ((total - rank) / (total - 1)) * 100;
  return Math.max(0, Math.round(raw * 10) / 10);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function scoreSummary(scores: number[]): ScoreSummary | null {
  if (!scores.length) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: round1(sorted[0]),
    q1: round1(percentile(sorted, 0.25)),
    median: round1(percentile(sorted, 0.5)),
    q3: round1(percentile(sorted, 0.75)),
    max: round1(sorted[sorted.length - 1]),
    avg: round1(sum / sorted.length),
    count: sorted.length
  };
}

function parseClassId(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

function classNameFromId(classId?: number): string | null {
  if (classId == null) return null;
  for (const [name, id] of Object.entries(DEMO_CLASS_IDS)) {
    if (id === classId) return name;
  }
  return null;
}

function studentsInScope(classId?: number): DemoStudent[] {
  const name = classNameFromId(classId);
  if (!name) return data().students;
  return data().students.filter((s) => s.className === name);
}

function getScore(exam: DemoExam, studentNo: string): number | null {
  const v = exam.scores[studentNo];
  return v === undefined ? null : v;
}

function academicYearFromDate(date: string | null | undefined): string {
  if (!date) return "2025-2026";
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (m >= 8) return `${y}-${y + 1}`;
  return `${y - 1}-${y}`;
}

function toExamFilterItem(exam: DemoExam): ExamFilterItem {
  const scores = Object.values(exam.scores);
  const avg = scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  return {
    id: examNumericId(exam.cardId),
    name: exam.name,
    subject: exam.subject,
    grade_id: DEMO_GRADE_ID,
    grade_name: data().grade,
    exam_date: exam.examDate,
    status: "closed",
    graded_count: scores.length,
    avg_score: avg,
    has_assigned_score: 0
  };
}

function computeOverview(exam: DemoExam, classId?: number): ExamOverview {
  const students = studentsInScope(classId);
  const scores = students
    .map((s) => getScore(exam, s.studentNo))
    .filter((v): v is number => v !== null);
  const full = exam.fullScore || 100;
  const passLine = full * 0.6;
  const excellentLine = full * 0.9;
  const summary = scoreSummary(scores);
  const avg = summary?.avg ?? 0;
  const variance =
    scores.length > 0 ? scores.reduce((a, s) => a + (s - avg) ** 2, 0) / scores.length : 0;
  const ranges: Array<{ range: string; min: number; max: number; count: number }> = [];
  for (let min = 0; min < full; min += 10) {
    const max = Math.min(min + 9, full);
    ranges.push({
      range: `${min}-${max}`,
      min,
      max,
      count: scores.filter((s) => s >= min && s <= max).length
    });
  }
  const classSummaries = data().classes.map((className) => {
    const clsScores = data().students
      .filter((s) => s.className === className)
      .map((s) => getScore(exam, s.studentNo))
      .filter((v): v is number => v !== null);
    return {
      classId: DEMO_CLASS_IDS[className],
      className,
      gradeName: data().grade,
      summary: scoreSummary(clsScores)!
    };
  }).filter((c) => c.summary);

  const questions = computeQuestions(exam, classId);
  const buckets = { low: 0, medium: 0, high: 0 };
  for (const q of questions) {
    if (q.errorRateLevel !== "none") buckets[q.errorRateLevel]++;
  }

  return {
    totalStudents: scores.length,
    gradedCount: scores.length,
    avgScore: avg,
    maxScore: summary?.max ?? 0,
    minScore: summary?.min ?? 0,
    stdDev: round1(Math.sqrt(variance)),
    passRate: scores.length ? Math.round((scores.filter((s) => s >= passLine).length / scores.length) * 100) : 0,
    excellentRate: scores.length ? Math.round((scores.filter((s) => s >= excellentLine).length / scores.length) * 100) : 0,
    distribution: ranges,
    scoreSummary: summary,
    overallScoreSummary: scoreSummary(
      data().students.map((s) => getScore(exam, s.studentNo)).filter((v): v is number => v !== null)
    ),
    classSummaries,
    highErrorQuestionCount: buckets.low + buckets.medium + buckets.high,
    errorRateBuckets: buckets
  };
}

function computeRanking(exam: DemoExam, classId?: number): StudentRankingItem[] {
  const students = studentsInScope(classId);
  const rows = students
    .map((s) => {
      const score = getScore(exam, s.studentNo);
      if (score === null) return null;
      const parts = exam.questionScores?.[s.studentNo] ?? [];
      const low = parts.filter((p) => p.score < p.max * 0.5).length;
      return {
        rank: 0,
        studentNumber: s.studentNo,
        studentName: s.name,
        totalScore: score,
        objectiveScore: parts.reduce((a, p) => a + p.score, 0) || score,
        subjectiveScore: 0,
        lowScoreCount: low,
        questionCount: parts.length || 1,
        errorRate: parts.length ? Math.round((low / parts.length) * 100) : 0,
        errorRateLevel: "none" as const
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => b.totalScore - a.totalScore);

  competitionRank(rows, (r) => r.totalScore, (r, rank) => { r.rank = rank; });
  return rows.map((r) => ({
    ...r,
    errorRateLevel:
      r.errorRate >= 70 ? "high" : r.errorRate >= 50 ? "medium" : r.errorRate >= 30 ? "low" : "none"
  }));
}

function computeQuestions(exam: DemoExam, classId?: number): QuestionAnalysisItem[] {
  const qs = exam.questionScores;
  if (!qs) return [];
  const students = studentsInScope(classId);
  const byQ = new Map<number, { scores: number[]; max: number }>();
  for (const s of students) {
    const parts = qs[s.studentNo];
    if (!parts) continue;
    for (const p of parts) {
      if (!byQ.has(p.q)) byQ.set(p.q, { scores: [], max: p.max });
      byQ.get(p.q)!.scores.push(p.score);
    }
  }
  return Array.from(byQ.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([q, info]) => {
      const avg = info.scores.reduce((a, b) => a + b, 0) / Math.max(1, info.scores.length);
      const scoreRate = info.max > 0 ? Math.round((avg / info.max) * 100) : 0;
      const errorCount = info.scores.filter((s) => s < info.max).length;
      const errorRate = info.scores.length ? Math.round((errorCount / info.scores.length) * 100) : 0;
      return {
        questionNumber: String(q),
        questionType: "客观",
        scoreRate,
        correctRate: info.scores.length
          ? Math.round((info.scores.filter((s) => s >= info.max).length / info.scores.length) * 100)
          : null,
        avgScore: round1(avg),
        maxScore: info.max,
        errorCount,
        errorRate,
        errorRateLevel:
          errorRate >= 70 ? "high" : errorRate >= 50 ? "medium" : errorRate >= 30 ? "low" : "none",
        totalCount: info.scores.length
      };
    });
}

function computeScoreTable(exam: DemoExam, classId?: number, displayMode = "zscore"): {
  examName: string;
  subject: string;
  examDate: string;
  hasAssignedScore: boolean;
  rows: ScoreTableRow[];
  totalCount: number;
} {
  const ranking = computeRanking(exam, undefined);
  const gradeRankMap = new Map(ranking.map((r) => [r.studentNumber, r.rank]));
  const scoped = computeRanking(exam, classId);
  const scores = scoped.map((r) => r.totalScore);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const variance =
    scores.length ? scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length : 0;
  const std = Math.sqrt(variance);
  const prior = data().exams.find((e) => e.name === "演示-数学月考");
  const priorRanks = prior ? computeRanking(prior, undefined) : [];
  const priorMap = new Map(priorRanks.map((r) => [r.studentNumber, r.rank]));

  const rows: ScoreTableRow[] = scoped.map((r) => {
    const gradeRank = gradeRankMap.get(r.studentNumber) ?? r.rank;
    const prevRank = priorMap.get(r.studentNumber) ?? null;
    const rankChange = prevRank != null ? prevRank - gradeRank : null;
    let displayValue: number | null = null;
    if (displayMode === "deviation") {
      displayValue = std > 0 ? round1(50 + (10 * (r.totalScore - mean)) / std) : 50;
    } else if (displayMode === "zscore") {
      displayValue = std > 0 ? Math.round(((r.totalScore - mean) / std) * 100) / 100 : 0;
    } else {
      displayValue = rankPercentile(gradeRank, ranking.length);
    }
    const stu = data().students.find((s) => s.studentNo === r.studentNumber)!;
    return {
      studentId: Number(r.studentNumber),
      studentNumber: r.studentNumber,
      studentName: r.studentName,
      className: stu.className,
      classId: DEMO_CLASS_IDS[stu.className],
      gradeName: data().grade,
      totalScore: r.totalScore,
      assignedScore: null,
      gradeRank,
      classRank: r.rank,
      rank: gradeRank,
      rankChange,
      prevRank,
      prevExamName: prior?.name ?? null,
      displayValue,
      objectiveScore: r.objectiveScore,
      subjectiveScore: r.subjectiveScore,
      needsReview: false
    };
  });

  return {
    examName: exam.name,
    subject: exam.subject,
    examDate: exam.examDate,
    hasAssignedScore: false,
    rows,
    totalCount: rows.length
  };
}

function buildCrossExamTotal(body: CrossExamTotalRequest): CrossExamTotalResponse {
  const payload = data();
  let exams = payload.exams.filter((e) => payload.crossExamGroup.examCardIds.includes(e.cardId));
  if (body.mode === "selected" && body.examIds?.length) {
    const set = new Set(body.examIds);
    exams = payload.exams.filter((e) => set.has(examNumericId(e.cardId)));
  }
  if (body.mode === "week" && body.startDate && body.endDate) {
    exams = payload.exams.filter(
      (e) => e.examDate >= body.startDate! && e.examDate <= body.endDate!
    );
  }
  const totalFullScore = round1(exams.reduce((a, e) => a + e.fullScore, 0));
  const rows = payload.students.map((s) => {
    const scores = exams.map((e) => {
      const sc = getScore(e, s.studentNo);
      return { examId: examNumericId(e.cardId), score: sc, absent: sc === null };
    });
    const attended = scores.filter((c) => !c.absent);
    const totalScore = round1(attended.reduce((a, c) => a + Number(c.score), 0));
    return {
      studentId: Number(s.studentNo),
      studentNumber: s.studentNo,
      studentName: s.name,
      className: s.className,
      classId: DEMO_CLASS_IDS[s.className],
      gradeName: payload.grade,
      totalScore,
      totalFullScore,
      scoreRate: totalFullScore > 0 ? round1((totalScore / totalFullScore) * 100) : null,
      attendedCount: attended.length,
      absentCount: exams.length - attended.length,
      gradeRank: 0,
      classRank: 0,
      scores
    };
  });
  let filtered = rows;
  if ((body.attendanceMode ?? "all") === "full") {
    filtered = rows.filter((r) => r.absentCount === 0);
  }
  if (body.classId) {
    filtered = filtered.filter((r) => r.classId === body.classId);
  }
  filtered.sort((a, b) => b.totalScore - a.totalScore);
  competitionRank(filtered, (r) => r.totalScore, (r, rank) => { r.gradeRank = rank; });
  const byClass = new Map<number, typeof filtered>();
  for (const r of filtered) {
    const k = r.classId ?? 0;
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k)!.push(r);
  }
  for (const list of byClass.values()) {
    competitionRank(list, (r) => r.totalScore, (r, rank) => { r.classRank = rank; });
  }
  const classSummaries = Array.from(byClass.values()).map((list) => {
    const first = list[0];
    const totals = list.map((r) => r.totalScore);
    return {
      classId: first.classId,
      className: first.className,
      gradeName: first.gradeName,
      count: list.length,
      avgScore: round1(totals.reduce((a, b) => a + b, 0) / list.length),
      maxScore: round1(Math.max(...totals)),
      minScore: round1(Math.min(...totals))
    };
  });
  return {
    mode: body.mode,
    group: body.mode === "group"
      ? {
          id: 9201,
          name: payload.crossExamGroup.name,
          source: "week",
          startDate: payload.crossExamGroup.startDate,
          endDate: payload.crossExamGroup.endDate,
          examIds: exams.map((e) => examNumericId(e.cardId)),
          exams: exams.map(toExamFilterItem),
          createdAt: "2026-06-22",
          updatedAt: "2026-06-22"
        }
      : null,
    exams: exams.map((e) => ({
      id: examNumericId(e.cardId),
      name: e.name,
      subject: e.subject,
      gradeName: payload.grade,
      examDate: e.examDate,
      fullScore: e.fullScore,
      gradedCount: Object.keys(e.scores).length,
      avgScore: round1(
        Object.values(e.scores).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(e.scores).length)
      )
    })),
    rows: filtered,
    classSummaries,
    summary: {
      examCount: exams.length,
      studentCount: filtered.length,
      totalFullScore,
      avgTotalScore: filtered.length
        ? round1(filtered.reduce((a, r) => a + r.totalScore, 0) / filtered.length)
        : 0,
      maxTotalScore: filtered.length ? round1(Math.max(...filtered.map((r) => r.totalScore))) : 0,
      minTotalScore: filtered.length ? round1(Math.min(...filtered.map((r) => r.totalScore))) : 0,
      fullAttendanceCount: rows.filter((r) => r.absentCount === 0).length
    }
  };
}

function demoTeacherUser(): OfflineDemoAuthUser {
  return {
    id: 8001,
    username: "offline-demo",
    name: "离线演示教师",
    role_id: 2,
    role_name: "teacher",
    role_display_name: "教师",
    student_number: null,
    teacher_role: "grade_leader",
    subject: "数学",
    permissions: [...DEMO_PERMISSIONS]
  };
}

function parseUrl(url: string): { pathname: string; searchParams: URLSearchParams } {
  const u = new URL(url, "http://demo.local");
  return { pathname: u.pathname, searchParams: u.searchParams };
}

export function tryHandleOfflineDemoRequest(
  url: string,
  options?: RequestInit
): unknown | undefined {
  const method = (options?.method ?? "GET").toUpperCase();
  const { pathname, searchParams } = parseUrl(url);
  const payload = data();

  if (pathname === "/api/auth/login" && method === "POST") {
    return undefined; // handled in AuthContext before fetch
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    return demoTeacherUser();
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    return { ok: true };
  }

  if (pathname === "/api/users/me/settings") {
    if (method === "GET") {
      return {
        scoreDisplayMode: "zscore",
        reviewConfidenceThreshold: 0.12,
        requireOriginalPaper: 0
      };
    }
    if (method === "PATCH") return { ok: true };
  }

  if (pathname === "/api/exams/filters") {
    const years = new Set(payload.exams.map((e) => academicYearFromDate(e.examDate)));
    const subjects = [...new Set(payload.exams.map((e) => e.subject))];
    return { academicYears: [...years], subjects };
  }

  if (pathname === "/api/classes/grades") {
    return [{ id: DEMO_GRADE_ID, name: payload.grade }];
  }

  if (pathname === "/api/classes") {
    return payload.classes.map((name) => ({
      id: DEMO_CLASS_IDS[name],
      name,
      grade_id: DEMO_GRADE_ID,
      grade_name: payload.grade
    }));
  }

  if (pathname === "/api/exams" && method === "GET") {
    let exams = payload.exams.map(toExamFilterItem);
    const subject = searchParams.get("subject");
    const gradeId = searchParams.get("grade_id");
    const academicYear = searchParams.get("academic_year");
    if (subject) exams = exams.filter((e) => e.subject === subject);
    if (gradeId) exams = exams.filter((e) => String(e.grade_id) === gradeId);
    if (academicYear) {
      exams = exams.filter((e) => academicYearFromDate(e.exam_date) === academicYear);
    }
    // Also support plain ExamRecord[] consumers (App loadExams)
    if (!searchParams.has("selection")) {
      return exams.map((e) => ({
        id: e.id,
        name: e.name,
        card_id: String(e.id),
        grade_id: e.grade_id,
        class_id: null,
        subject: e.subject,
        start_time: e.exam_date,
        end_time: e.exam_date,
        status: e.status,
        assigned_formula: null,
        created_at: e.exam_date ?? "2026-06-01"
      }));
    }
    return exams;
  }

  if (pathname === "/api/exam-groups" && method === "GET") {
    const item: ExamGroupFilterItem = {
      id: 9202,
      name: payload.examGroup.name,
      description: payload.examGroup.description,
      tag: "演示",
      grade_id: DEMO_GRADE_ID,
      grade_name: payload.grade,
      status: "closed",
      member_count: payload.examGroup.examCardIds.length,
      has_results: 1,
      created_at: "2026-06-22"
    };
    return [item];
  }

  if (pathname === "/api/analysis/cross-exam/groups") {
    if (method === "GET") {
      const group: CrossExamGroup = {
        id: 9201,
        name: payload.crossExamGroup.name,
        source: "week",
        startDate: payload.crossExamGroup.startDate,
        endDate: payload.crossExamGroup.endDate,
        examIds: payload.crossExamGroup.examCardIds.map(examNumericId),
        exams: payload.exams
          .filter((e) => payload.crossExamGroup.examCardIds.includes(e.cardId))
          .map(toExamFilterItem),
        createdAt: "2026-06-22",
        updatedAt: "2026-06-22"
      };
      return [group];
    }
    if (method === "POST") {
      return {
        id: 9299,
        name: "演示-已存组",
        source: "cross-manual",
        startDate: null,
        endDate: null,
        examIds: [],
        exams: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } satisfies CrossExamGroup;
    }
  }

  if (pathname.startsWith("/api/analysis/cross-exam/groups/") && method === "DELETE") {
    return { ok: true };
  }

  if (pathname === "/api/analysis/cross-exam/total" && method === "POST") {
    let body: CrossExamTotalRequest = { mode: "week" };
    try {
      body = JSON.parse(String(options?.body ?? "{}")) as CrossExamTotalRequest;
    } catch {
      /* ignore */
    }
    return buildCrossExamTotal(body);
  }

  const examMatch = pathname.match(/^\/api\/analysis\/exams\/(\d+)\/(overview|students|questions|classes|previous|score-table|class-compare)$/);
  if (examMatch && method === "GET") {
    const examId = Number(examMatch[1]);
    const action = examMatch[2];
    const exam = findExamById(examId);
    if (!exam) throw Object.assign(new Error("考试不存在"), { status: 404 });
    const classId = parseClassId(searchParams.get("classId"));

    if (action === "classes") {
      return payload.classes.map((name) => ({
        classId: DEMO_CLASS_IDS[name],
        className: name,
        gradeName: payload.grade
      }));
    }
    if (action === "overview") return computeOverview(exam, classId);
    if (action === "students") return computeRanking(exam, classId);
    if (action === "questions") return computeQuestions(exam, classId);
    if (action === "score-table") {
      return computeScoreTable(exam, classId, searchParams.get("displayMode") || "zscore");
    }
    if (action === "previous") {
      const prior = payload.exams.find((e) => e.name === "演示-数学月考");
      if (!prior || exam.name !== "演示-数学") {
        return {
          prevExamId: null,
          prevExamName: null,
          prevAvgScore: null,
          prevPassRate: null,
          avgScoreChange: null,
          passRateChange: null
        } satisfies PreviousExamComparison;
      }
      const cur = computeOverview(exam, classId);
      const prev = computeOverview(prior, classId);
      return {
        prevExamId: examNumericId(prior.cardId),
        prevExamName: prior.name,
        prevAvgScore: prev.avgScore,
        prevPassRate: prev.passRate,
        avgScoreChange: round1(cur.avgScore - prev.avgScore),
        passRateChange: cur.passRate - prev.passRate
      } satisfies PreviousExamComparison;
    }
    if (action === "class-compare") {
      // Lightweight offline shape matching AnalysisClassCompare expectations when present
      const classes = payload.classes.map((className) => {
        const cid = DEMO_CLASS_IDS[className];
        const overview = computeOverview(exam, cid);
        const questions = computeQuestions(exam, cid);
        const points = ((payload as { knowledgePoints?: Record<string, Array<{ pointText: string; questionNumbers: number[] }>> }).knowledgePoints?.[exam.cardId] ?? []) as Array<{ pointText: string; questionNumbers: number[] }>;
        const knowledgeWeaknesses: Array<{
          pointText: string;
          questionNumbers: string;
          avgRate: number;
          studentCount: number;
          totalQuestions: number;
        }> = points.map((kp) => {
          const rates = questions.filter((q) => kp.questionNumbers.map(String).includes(q.questionNumber));
          const avgRate = rates.length
            ? round1(rates.reduce((a, q) => a + q.scoreRate, 0) / rates.length)
            : 0;
          return {
            pointText: kp.pointText,
            questionNumbers: kp.questionNumbers.join(","),
            avgRate,
            studentCount: overview.gradedCount,
            totalQuestions: kp.questionNumbers.length
          };
        });
        return {
          classId: cid,
          className,
          gradeName: payload.grade,
          gradedCount: overview.gradedCount,
          avgScore: overview.avgScore,
          maxScore: overview.maxScore,
          minScore: overview.minScore,
          stdDev: overview.stdDev,
          passRate: overview.passRate,
          excellentRate: overview.excellentRate,
          scoreSummary: overview.scoreSummary,
          distribution: overview.distribution,
          questions,
          knowledgeWeaknesses
        };
      });
      const questionNumbers = new Set<string>();
      for (const c of classes) for (const q of c.questions) questionNumbers.add(q.questionNumber);
      const questionMatrix = [...questionNumbers].sort((a, b) => Number(a) - Number(b)).map((qn) => {
        const sample = classes.flatMap((c) => c.questions).find((q) => q.questionNumber === qn)!;
        const byClass: Record<string, { scoreRate: number; avgScore: number; errorRate: number }> = {};
        for (const c of classes) {
          const q = c.questions.find((item) => item.questionNumber === qn);
          if (q) byClass[String(c.classId)] = { scoreRate: q.scoreRate, avgScore: q.avgScore, errorRate: q.errorRate };
        }
        return {
          questionNumber: qn,
          questionType: sample.questionType,
          maxScore: sample.maxScore,
          byClass
        };
      });
      const knowledgeKeys = new Map<string, string>();
      for (const c of classes) {
        for (const k of c.knowledgeWeaknesses) knowledgeKeys.set(k.pointText, k.questionNumbers);
      }
      const knowledgeMatrix = [...knowledgeKeys.entries()].map(([pointText, questionNumbers]) => {
        const byClass: Record<string, { avgRate: number; studentCount: number }> = {};
        for (const c of classes) {
          const k = c.knowledgeWeaknesses.find((item) => item.pointText === pointText);
          if (k) byClass[String(c.classId)] = { avgRate: k.avgRate, studentCount: k.studentCount };
        }
        return { pointText, questionNumbers, byClass };
      });
      const baselineRaw = searchParams.get("baselineClassId");
      const baselineClassId =
        baselineRaw != null && baselineRaw !== "" && classes.some((c) => String(c.classId) === baselineRaw)
          ? Number(baselineRaw)
          : null;
      return {
        examId,
        examName: exam.name,
        baselineClassId,
        classes,
        questionMatrix,
        knowledgeMatrix
      };
    }
  }

  // Soft-fail common endpoints so demo UI doesn't crash on unused tabs
  if (pathname.startsWith("/api/analysis/ai") || pathname.includes("/ai-analysis")) {
    return { available: false, reason: "离线演示不支持 AI 分析", defaultModel: null, models: [], providers: [] };
  }
  if (pathname.startsWith("/api/analysis/trends")) return [];
  if (pathname.startsWith("/api/analysis/knowledge-points/")) return { weaknesses: [] };
  if (pathname.startsWith("/api/cards") || pathname.startsWith("/api/answer-cards")) return [];
  if (pathname === "/api/app/health") return { ok: true, demo: true };

  // Unknown write ops: pretend success to keep UI calm
  if (method !== "GET") {
    return { ok: true, demo: true, message: "离线演示：写操作已忽略" };
  }

  throw Object.assign(new Error(`离线演示未实现接口：${pathname}`), { status: 501 });
}

export function createOfflineDemoLoginResponse(): OfflineDemoLoginResponse {
  const user = demoTeacherUser();
  return {
    token: OFFLINE_DEMO_TOKEN,
    user,
    permissions: user.permissions,
    message: "已进入离线演示模式"
  };
}
