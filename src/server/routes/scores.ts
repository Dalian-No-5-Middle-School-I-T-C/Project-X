import express from "express";
import type { Request, Response } from "express";
import { ScoreRepository } from "../repositories/ScoreRepository";
import { UserRepository } from "../repositories/UserRepository";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS } from "../auth/permissions";
import type { SubjectWeaknessItem, StudentTrendPoint } from "../../shared/types";

/**
 * 成绩查询 API
 * 挂载点：/api/scores
 *
 * - /me*              ：任何已登录用户查询自己的成绩（学生自助查分核心）
 * - /me/trends        ：带班级/年级均分对比的趋势数据
 * - /me/subject-comparison ：学科横向对比（含薄弱学科标注）
 * - /me/ai-analysis   ：学生个人 AI 整体分析
 * - /students/*       ：教师/管理员代查（要求 grade:read 权限）
 */
const router = express.Router();
const scoreRepo = new ScoreRepository();
const userRepo = new UserRepository();

router.use(authMiddleware);

/** GET /api/scores/me — 当前登录用户（学生）的全部考试成绩 */
router.get("/me", (req: Request, res: Response) => {
  const scores = scoreRepo.getStudentScores(req.user!.id);
  res.json({ studentId: req.user!.id, name: req.user!.name, scores });
});

/** GET /api/scores/me/exams/:examId — 当前用户某场考试的逐题明细 */
router.get("/me/exams/:examId", (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  if (!scoreRepo.hasScore(req.user!.id, examId)) {
    res.status(404).json({ message: "未找到你在该场考试的成绩" });
    return;
  }
  res.json({
    examId,
    questions: scoreRepo.getStudentQuestionScores(req.user!.id, examId)
  });
});

/** GET /api/scores/me/trends — 当前用户的成绩趋势数据（含班级/年级均分） */
router.get("/me/trends", (req: Request, res: Response) => {
  const subject = typeof req.query.subject === "string" ? req.query.subject : undefined;
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  let trends: StudentTrendPoint[] = scoreRepo.getStudentTrendData(req.user!.id);
  if (subject) trends = trends.filter((t) => t.subject === subject);
  if (limit && limit > 0) trends = trends.slice(-limit);
  res.json(trends);
});

/** GET /api/scores/me/subject-comparison — 学科横向对比（薄弱分析） */
router.get("/me/subject-comparison", (req: Request, res: Response) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 0;
  const trends: StudentTrendPoint[] = scoreRepo.getStudentTrendData(req.user!.id);

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

// ── 学生个人 AI 整体分析 ──

/** POST /api/scores/me/ai-analysis — 学生整体成绩分析 */
router.post("/me/ai-analysis", async (req: Request, res: Response) => {
  const trends = scoreRepo.getStudentTrendData(req.user!.id);
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
router.get("/students/:studentId", canQueryOthers, (req: Request, res: Response) => {
  const studentId = Number(req.params.studentId);
  const student = userRepo.findByIdIncludingInactive(studentId);
  if (!student || student.role_id !== ROLE_IDS.STUDENT) {
    res.status(404).json({ message: "学生不存在" });
    return;
  }
  res.json({
    studentId,
    name: student.name,
    student_number: student.student_number,
    scores: scoreRepo.getStudentScores(studentId)
  });
});

/** GET /api/scores/students/:studentId/exams/:examId — 代查逐题明细 */
router.get("/students/:studentId/exams/:examId", canQueryOthers, (req: Request, res: Response) => {
  const studentId = Number(req.params.studentId);
  const examId = Number(req.params.examId);
  res.json({
    studentId,
    examId,
    questions: scoreRepo.getStudentQuestionScores(studentId, examId)
  });
});

export default router;
