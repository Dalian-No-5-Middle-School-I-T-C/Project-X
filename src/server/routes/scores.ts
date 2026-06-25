import express from "express";
import type { Request, Response } from "express";
import { ScoreRepository } from "../repositories/ScoreRepository";
import { UserRepository } from "../repositories/UserRepository";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS } from "../auth/permissions";
import { getDatabase } from "../db";
import type { SubjectWeaknessItem, StudentTrendPoint, AiAnalysisResponse } from "../../shared/types";

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

const LLM_CLIENT_BASE = process.env.LLM_CLIENT_URL || "http://127.0.0.1:8766";
const LLM_INTERNAL_KEY = process.env.LLM_INTERNAL_KEY || "";

/** POST /api/scores/me/ai-analysis — 学生整体成绩 AI 分析 */
router.post("/me/ai-analysis", async (req: Request, res: Response) => {
  const trends = scoreRepo.getStudentTrendData(req.user!.id);
  if (trends.length === 0) {
    res.status(400).json({ message: "暂无成绩数据可分析" });
    return;
  }

  // Build provider override from user config if provided
  const providerId = req.body?.providerId ? Number(req.body.providerId) : undefined;
  let providerOverride: Record<string, unknown> | undefined;
  if (providerId && Number.isFinite(providerId)) {
    const db = getDatabase();
    const prov = db.prepare(
      "SELECT * FROM ai_providers WHERE id = ? AND user_id = ?"
    ).get(providerId, req.user!.id) as Record<string, unknown> | undefined;
    if (prov) {
      providerOverride = {
        provider_type: prov.provider_type,
        base_url: prov.base_url,
        api_key: prov.api_key
      };
    }
  }

  // Build student overview data
  const bySubject = new Map<string, typeof trends>();
  for (const t of trends) {
    if (!t.subject) continue;
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject)!.push(t);
  }

  const subjectSummaries = Array.from(bySubject.entries()).map(([subject, points]) => {
    const avg = Math.round(points.reduce((s, p) => s + p.totalScore, 0) / points.length * 10) / 10;
    const classAvg = Math.round(points.reduce((s, p) => s + p.classAvg, 0) / points.length * 10) / 10;
    return { subject, examCount: points.length, avgScore: avg, avgClassAvg: classAvg, gap: Math.round((avg - classAvg) * 10) / 10 };
  });

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
        examId: 0,
        studentId: req.user!.id,
        studentName: req.user!.name,
        locale: "zh-CN",
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        providerOverride: providerOverride ?? undefined,
        studentAnalysis: true,
        subjectSummaries,
        totalExams: trends.length,
        recentExams: trends.slice(-5).map((t) => ({
          name: t.examName,
          subject: t.subject,
          score: t.totalScore,
          classAvg: t.classAvg,
          gradeAvg: t.gradeAvg,
          rank: t.rank,
          percentile: t.percentile,
        })),
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
    res.status(503).json({ message: `无法连接 AI 服务: ${error instanceof Error ? error.message : String(error)}` });
  }
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
