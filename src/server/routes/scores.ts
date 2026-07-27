import express from "express";
import type { Request, Response } from "express";
import { getMysqlDb } from "../db";
import { ScoreRepository } from "../repositories/ScoreRepository";
import { UserRepository } from "../repositories/UserRepository";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS } from "../auth/permissions";
import { getVisibleExamIds } from "../../apps/answer-card/server/middleware";
import type { SubjectWeaknessItem, StudentTrendPoint } from "../../shared/types";

/**
 * 成绩查询 API
 * 挂载点：/api/scores
 *
 * - /me*              ：任何已登录用户查询自己的成绩（学生自助查分核心）
 * - /me/trends        ：带班级/年级均分对比的趋势数据
 * - /me/subject-comparison ：学科横向对比（含薄弱学科标注）
 * - /me/ai-analysis   ：学生个人 AI 整体分析
 * - /students/*       ：教师/管理员代查（要求 grade:read 权限 + 任教班级校验）
 */
const router = express.Router();
const scoreRepo = new ScoreRepository();
const userRepo = new UserRepository();

router.use(authMiddleware);

type AccessibleError = { status: number; message: string };

/** 校验请求者是否有权访问目标学生的成绩数据 */
async function assertStudentAccessible(
  studentId: number,
  user: NonNullable<express.Request["user"]>
): Promise<AccessibleError | null> {
  if (!Number.isFinite(studentId) || studentId <= 0) return { status: 400, message: "无效的学生 ID" };
  if (user.role_name === "admin") return null;
  if (user.role_name === "student") {
    if (user.id !== studentId) return { status: 403, message: "只能查询自己的成绩" };
    return null;
  }
  if (user.role_name === "teacher") {
    // 与 getVisibleExamIds 保持一致：教师仅能访问“与目标学生共享至少一场可见考试”的学生。
    // admin / grade_leader / 普通教师(back-compat) 经 getVisibleExamIds 返回 null（全部可见）→ 直接放行。
    const visible = await getVisibleExamIds(user);
    if (visible === null) return null;
    if (visible.length === 0) return { status: 403, message: "无权访问该学生：当前无可访问的考试" };
    const scores = await scoreRepo.getStudentScores(studentId);
    const visibleSet = new Set(visible);
    if (!scores.some((s) => visibleSet.has(s.exam_id))) {
      return { status: 403, message: "无权访问该学生：未共享任何可见考试" };
    }
    return null;
  }
  return { status: 403, message: "权限不足" };
}

/** 解析学生的主班级 ID（用于 AI 分析上下文） */
async function resolveStudentPrimaryClassId(studentId: number): Promise<number | null> {
  const db = getMysqlDb();
  const row = await db.get<{ class_id: number }>(
    `SELECT cs.class_id AS class_id
     FROM class_students cs
     JOIN classes c ON c.id = cs.class_id
     WHERE cs.student_id = ?
     ORDER BY cs.joined_at ASC, c.sort_order ASC, cs.class_id ASC
     LIMIT 1`,
    studentId
  );
  return row ? row.class_id : null;
}

/** GET /api/scores/me — 当前登录用户（学生）的全部考试成绩 */
router.get("/me", async (req: Request, res: Response) => {
  const scores = await scoreRepo.getStudentScores(req.user!.id);
  res.json({ studentId: req.user!.id, name: req.user!.name, scores });
});

/** GET /api/scores/me/exams/:examId — 当前用户某场考试的逐题明细 */
router.get("/me/exams/:examId", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  if (!(await scoreRepo.hasScore(req.user!.id, examId))) {
    res.status(404).json({ message: "未找到你在该场考试的成绩" });
    return;
  }
  res.json({
    examId,
    questions: await scoreRepo.getStudentQuestionScores(req.user!.id, examId)
  });
});

/** GET /api/scores/me/trends — 当前用户的成绩趋势数据（含班级/年级均分） */
router.get("/me/trends", async (req: Request, res: Response) => {
  const subject = typeof req.query.subject === "string" ? req.query.subject : undefined;
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  let trends: StudentTrendPoint[] = await scoreRepo.getStudentTrendData(req.user!.id);
  if (subject) trends = trends.filter((t) => t.subject === subject);
  if (limit && limit > 0) trends = trends.slice(-limit);
  res.json(trends);
});

/** GET /api/scores/me/semester-comparison — 本学期 vs 上学期历史成绩对比 */
router.get("/me/semester-comparison", async (req: Request, res: Response) => {
  const comparison = await scoreRepo.getStudentSemesterComparison(req.user!.id);
  res.json(comparison);
});

/** GET /api/scores/me/subject-comparison — 学科横向对比（薄弱分析） */
router.get("/me/subject-comparison", async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 0;
  const trends: StudentTrendPoint[] = await scoreRepo.getStudentTrendData(req.user!.id);

  // 按学科分组聚合
  const bySubject = new Map<string, StudentTrendPoint[]>();
  for (const t of trends) {
    if (!t.subject) continue;
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject)!.push(t);
  }

  const subjects: SubjectWeaknessItem[] = [];
  for (const [subject, points] of bySubject) {
    const scores = points.map((p) => p.totalScore);
    const avgScore = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
    const avgClassAvg = Math.round((points.reduce((a, p) => a + p.classAvg, 0) / points.length) * 10) / 10;
    const gapToClass = Math.round((avgScore - avgClassAvg) * 10) / 10;
    const bestScore = Math.max(...scores);
    const worstScore = Math.min(...scores);
    // 趋势判断：最近两次考试
    const sorted = [...points].sort((a, b) => a.examTime.localeCompare(b.examTime));
    let trend: "up" | "down" | "stable" = "stable";
    if (sorted.length >= 2) {
      const last = sorted[sorted.length - 1].totalScore;
      const prev = sorted[sorted.length - 2].totalScore;
      if (last - prev > 3) trend = "up";
      else if (prev - last > 3) trend = "down";
    }

    subjects.push({ subject, examCount: points.length, avgScore, avgClassAvg, gapToClass, bestScore, worstScore, trend });
  }

  // 按薄弱程度排序（低于班级均分最多的排最前）
  subjects.sort((a, b) => a.gapToClass - b.gapToClass);
  const weakSubject = subjects.length > 0 ? subjects[0].subject : null;

  res.json({
    subjects: limit > 0 ? subjects.slice(0, limit) : subjects,
    weakSubject,
    totalExams: trends.length
  });
});

// ── 学生每场考试 AI 分析 ──

const LLM_CLIENT_BASE = process.env.LLM_CLIENT_URL || "http://127.0.0.1:8766";
const LLM_INTERNAL_KEY = process.env.LLM_INTERNAL_KEY || "";

/** POST /api/scores/me/exams/:examId/ai-analysis — 学生单场考试 AI 分析（绕过教师端 analysisGate） */
router.post("/me/exams/:examId/ai-analysis", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  if (!Number.isFinite(examId) || examId <= 0) {
    res.status(400).json({ message: "无效的考试 ID" });
    return;
  }
  if (!(await scoreRepo.hasScore(req.user!.id, examId))) {
    res.status(403).json({ message: "你未参加该考试" });
    return;
  }

  const classId = await resolveStudentPrimaryClassId(req.user!.id);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(`${LLM_CLIENT_BASE}/analysis/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LLM_INTERNAL_KEY ? { Authorization: `Bearer ${LLM_INTERNAL_KEY}` } : {}),
      },
      body: JSON.stringify({
        examId,
        classId,
        callerRole: "student",
        studentId: req.user!.id,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        locale: "zh-CN",
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      let message = `LLM service returned ${response.status}`;
      try {
        const body = await response.json() as { detail?: string; message?: string };
        message = body.detail || body.message || message;
      } catch {
        const text = await response.text().catch(() => "");
        if (text) message = text;
      }
      res.status(response.status >= 400 && response.status < 500 ? response.status : 502).json({ message });
      return;
    }

    res.json(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      res.status(504).json({ message: "AI 服务请求超时。" });
      return;
    }
    res.status(503).json({ message: `AI 服务不可用: ${error instanceof Error ? error.message : String(error)}` });
  }
});

// ── 学生个人 AI 整体分析 ──

/** POST /api/scores/me/ai-analysis — 学生整体成绩分析 */
router.post("/me/ai-analysis", async (req: Request, res: Response) => {
  const trends = await scoreRepo.getStudentTrendData(req.user!.id);
  if (trends.length === 0) {
    res.status(400).json({ message: "暂无成绩数据可分析" });
    return;
  }

  // Build student overview data
  const bySubject = new Map<string, typeof trends>();
  for (const t of trends) {
    if (!t.subject) continue;
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject)!.push(t);
  }

  const subjectSummaries = Array.from(bySubject.entries()).map(([subject, points]) => {
    const scores = points.map((p) => p.totalScore);
    const avg = Math.round(scores.reduce((s, p) => s + p, 0) / points.length * 10) / 10;
    const classAvg = Math.round(points.reduce((s, p) => s + p.classAvg, 0) / points.length * 10) / 10;
    const gap = Math.round((avg - classAvg) * 10) / 10;
    const best = Math.max(...scores);
    const worst = Math.min(...scores);
    const sorted = [...points].sort((a, b) => a.examTime.localeCompare(b.examTime));
    let trend: "up" | "down" | "stable" = "stable";
    if (sorted.length >= 2) {
      const last = sorted[sorted.length - 1].totalScore;
      const prev = sorted[sorted.length - 2].totalScore;
      if (last - prev > 3) trend = "up";
      else if (prev - last > 3) trend = "down";
    }
    return { subject, examCount: points.length, avgScore: avg, avgClassAvg: classAvg, gapToClass: gap, bestScore: best, worstScore: worst, trend };
  });

  // Sort by weakness (lowest gap first)
  subjectSummaries.sort((a, b) => a.gapToClass - b.gapToClass);
  const weakSubject = subjectSummaries.length > 0 ? subjectSummaries[0].subject : null;

  // Build analysis text from the data (no LLM call — llmclient doesn't support student-scoped analysis yet)
  const strongSubjects = subjectSummaries.filter((s) => s.gapToClass > 0).map((s) => s.subject);
  const weakSubjects = subjectSummaries.filter((s) => s.gapToClass < 0).map((s) => `${s.subject}（低于均分 ${Math.abs(s.gapToClass)} 分）`);
  const improvingSubjects = subjectSummaries.filter((s) => s.trend === "up").map((s) => s.subject);
  const decliningSubjects = subjectSummaries.filter((s) => s.trend === "down").map((s) => s.subject);

  const weakPoints: string[] = [];
  const suggestions: string[] = [];
  const caveats: string[] = [];

  if (weakSubjects.length > 0) {
    weakPoints.push(`薄弱学科：${weakSubjects.join("、")}。建议在这些科目上投入更多复习时间。`);
    suggestions.push(`重点提升 ${weakSubjects[0].split("（")[0]}，可针对性做专项练习。`);
  }
  if (decliningSubjects.length > 0) {
    weakPoints.push(`成绩下滑学科：${decliningSubjects.join("、")}。最近一次考试分数有所下降，需要关注。`);
    suggestions.push(`回顾 ${decliningSubjects.join("、")} 近期错题，分析失分原因。`);
  }
  if (strongSubjects.length > 0) {
    suggestions.push(`保持 ${strongSubjects.join("、")} 的优势，继续巩固练习。`);
  }
  if (subjectSummaries.length > 0) {
    const avgAll = Math.round(subjectSummaries.reduce((s, x) => s + x.avgScore, 0) / subjectSummaries.length * 10) / 10;
    const avgGap = Math.round(subjectSummaries.reduce((s, x) => s + x.gapToClass, 0) / subjectSummaries.length * 10) / 10;
    const overall = avgGap >= 0
      ? `整体表现良好，各科平均 ${avgAll} 分，高于班级均分 ${avgGap} 分。`
      : `整体需要加油，各科平均 ${avgAll} 分，低于班级均分 ${Math.abs(avgGap)} 分。`;
    caveats.push(overall);
  }
  caveats.push(`共参与 ${trends.length} 场考试，涵盖 ${subjectSummaries.length} 个学科。`);
  caveats.push("本报告为系统基于成绩数据自动生成，仅供参考。若需更深入的分析，请配置个人 AI 服务商 API Key 后使用。");

  res.json({
    generatedAt: new Date().toISOString(),
    model: "server-side-v1",
    report: {
      overallJudgement: weakSubject
        ? `需重点关注 ${weakSubject}，这是当前最薄弱学科`
        : "各科成绩较为均衡",
      distributionInsight: `基于最近 ${trends.length} 场考试的成绩数据统计。`,
      weakPoints,
      reviewRisks: [],
      teachingSuggestions: suggestions,
      nextActions: [],
      questionActions: [],
      caveats,
    },
    toolCalls: [],
  });
});

// ── 教师/管理员代查 ──────────────────────────────────────

const canQueryOthers = requirePermission(PERMISSIONS.GRADE_READ);

/** GET /api/scores/students/:studentId — 代查某学生全部成绩 */
router.get("/students/:studentId", canQueryOthers, async (req: Request, res: Response) => {
  const studentId = Number(req.params.studentId);
  const accessError = await assertStudentAccessible(studentId, req.user!);
  if (accessError) {
    res.status(accessError.status).json({ message: accessError.message });
    return;
  }
  const student = await userRepo.findByIdIncludingInactive(studentId);
  if (!student || student.role_id !== ROLE_IDS.STUDENT) {
    res.status(404).json({ message: "学生不存在" });
    return;
  }
  let scores = await scoreRepo.getStudentScores(studentId);
  // 教师仅可见其任教范围内的考试成绩
  if (req.user!.role_name === "teacher") {
    const visibleIds = await getVisibleExamIds(req.user);
    if (visibleIds !== null) {
      const visible = new Set(visibleIds);
      scores = scores.filter((s) => visible.has(s.exam_id));
    }
  }
  res.json({
    studentId,
    name: student.name,
    student_number: student.student_number,
    scores
  });
});

/** GET /api/scores/students/:studentId/exams/:examId — 代查逐题明细 */
router.get(
  "/students/:studentId/exams/:examId",
  canQueryOthers,
  async (req: Request, res: Response) => {
    const studentId = Number(req.params.studentId);
    const examId = Number(req.params.examId);
    const accessError = await assertStudentAccessible(studentId, req.user!);
    if (accessError) {
      res.status(accessError.status).json({ message: accessError.message });
      return;
    }
    if (req.user!.role_name === "teacher") {
      const visible = await getVisibleExamIds(req.user);
      if (visible !== null && !visible.includes(examId)) {
        res.status(403).json({ message: "无权访问此考试" });
        return;
      }
    }
    if (req.user!.role_name === "student" && !(await scoreRepo.hasScore(studentId, examId))) {
      res.status(403).json({ message: "该学生未参加该考试" });
      return;
    }
    res.json({
      studentId,
      examId,
      questions: await scoreRepo.getStudentQuestionScores(studentId, examId)
    });
  }
);

export default router;
