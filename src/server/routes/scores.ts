import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import { getMysqlDb } from "../db";
import { ScoreRepository } from "../repositories/ScoreRepository";
import { UserRepository } from "../repositories/UserRepository";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS } from "../auth/permissions";
import {
  getVisibleExamIds,
  isExamSoftDeleted,
  filterExamIdsByViewPermission,
  hasViewPermission
} from "../../apps/answer-card/server/middleware";
import { fetchLlmClient } from "../../apps/answer-card/server/llm-client";
import { trackAnalysisCall } from "../services/aiTelemetry";
// 安全（R11）：AI 计费与并发配额（判定与占位原子完成）
import { AiQuotaError, reserveAiCall } from "../services/aiQuota";
import type { SubjectWeaknessItem, StudentTrendPoint } from "../../shared/types";
import {
  judgeProgress,
  scoreRateChange,
  type ProgressDirection
} from "../../shared/scoreProgress";
import { listAnswerBlockCropsForStudent } from "../services/AnswerBlockCropService";
import {
  groupAnswersByPage,
  listAnswerKeyPages,
  listExamAnswerKeys,
  listExamPaperPages,
  loadAnswerKeyPageFilename,
  resolveAnswerKeyPageFile,
  resolvePaperPageFile,
} from "../services/ExamPaperViewService";
import {
  ANSWER_KEY_MODE_FILE,
  normalizeAnswerKeyMode,
  type AnswerKeyMode,
} from "../../shared/answerKeyMode";

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

/**
 * 学科进退步方向：取该学科最近两场考试，按**得分率变化（百分点）**判定（issue #345）。
 *
 * 旧口径用绝对分差 `> 3 分`，会被满分大小带偏——150 分卷涨 3 分只有 2%，
 * 100 分卷涨 3 分是 3%，同一阈值在不同卷子上代表的变化量不同。
 * 任一场解析不出满分即 `unknown`（不虚构分母，也不退回绝对分）。
 *
 * `/me/subject-comparison` 与 `/me/ai-analysis` 共用本函数，避免两处各写一套规则。
 */
function subjectTrendFromScoreRate(points: StudentTrendPoint[]): ProgressDirection {
  const sorted = [...points].sort((a, b) => String(a.examTime).localeCompare(String(b.examTime)));
  if (sorted.length < 2) return "stable";
  const change = scoreRateChange(
    sorted[sorted.length - 1].scoreRate,
    sorted[sorted.length - 2].scoreRate
  );
  return judgeProgress(change);
}

type AccessibleError = { status: number; message: string };

/**
 * 返回教师可访问的班级 ID 集合。与 getVisibleExamIds 保持同源：
 * - admin / grade_leader / 普通教师(无 teacher_role) → null（全校可见）
 * - head_teacher / subject_teacher → 任教学科匹配的班级 + 按班班主任（is_head_teacher）班级
 *   （班主任自 v54 起是「按班关系」，全局 head_teacher 角色不再等同于「关联的全部班级」，
 *   否则旧角色教师在全班范围可见且换人时无法收回，见评审 P1）
 * - 其他 → []（零可见）
 */
export async function getAccessibleClassIds(
  user: express.Request["user"]
): Promise<number[] | null> {
  if (!user || user.role_name === "admin") return null;
  if (user.role_name !== "teacher") return [];
  if (!user.teacher_role) return null; // plain teacher: back-compat 全部可见
  if (user.teacher_role === "grade_leader") return null;
  const db = getMysqlDb();
  if (user.teacher_role === "head_teacher" || user.teacher_role === "subject_teacher") {
    // 遗留数据兼容：全局 head_teacher 角色 + 不带科目的班级关联 = 旧模型的班主任；
    // 但仅限「该班尚无按班标记」——否则被替换流程换下的旧班主任会继续全科可见（见 middleware.ts 同款说明）
    const headWhere = user.teacher_role === "head_teacher"
      ? `(tc.is_head_teacher = 1 OR (tc.subject IS NULL AND NOT EXISTS (
           SELECT 1 FROM teacher_classes h
            WHERE h.class_id = tc.class_id AND h.is_head_teacher = 1)))`
      : "tc.is_head_teacher = 1";
    // 按班班主任（is_head_teacher）：其担任班主任的班级可见，不受任教学科限制
    if (!user.subject) {
      const headRows = await db.all<{ class_id: number }>(
        `SELECT tc.class_id FROM teacher_classes tc WHERE tc.teacher_id = ? AND ${headWhere}`, user.id
      );
      return headRows.map((r) => r.class_id);
    }
    // 任课班级：与 middleware 同口径——head_teacher 的「不带科目关联」是旧班主任标记而非任课，
    // 不接受 subject IS NULL 的宽松匹配，否则被换下的旧班主任仍能在成绩侧看到该班（评审 P1）
    const subjectWhere = user.teacher_role === "head_teacher"
      ? "tc.subject = ?"
      : "(tc.subject = ? OR tc.subject IS NULL)";
    const rows = await db.all<{ class_id: number }>(
      `SELECT tc.class_id FROM teacher_classes tc
        WHERE tc.teacher_id = ? AND (${subjectWhere} OR ${headWhere})`,
      user.id, user.subject
    );
    return rows.length > 0 ? rows.map((r) => r.class_id) : [];
  }
  return [];
}

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
    const classIds = await getAccessibleClassIds(user);
    if (classIds === null) return null; // grade_leader / plain teacher → 全校可见
    if (classIds.length === 0) return { status: 403, message: "无权访问该学生：当前无任教班级" };
    const db = getMysqlDb();
    const row = await db.get<{ ok: number }>(
      `SELECT 1 AS ok FROM class_students WHERE student_id = ? AND class_id IN (${classIds.map(() => "?").join(",")}) LIMIT 1`,
      studentId, ...classIds
    );
    if (!row) return { status: 403, message: "无权访问该学生：未在该生所在班级任教" };
    return null;
  }
  return { status: 403, message: "权限不足" };
}

/** 解析学生的主班级 ID（用于 AI 分析上下文）
 *  与成绩侧「当前班级」同一口径：在读优先 → 加入时间最新 → class_id 最大。
 *  此前按 joined_at 取最早一条，调班后仍留在原班的学生会拿到旧班的班级均分。 */
async function resolveStudentPrimaryClassId(studentId: number): Promise<number | null> {
  const db = getMysqlDb();
  const row = await db.get<{ class_id: number }>(
    `SELECT cs.class_id AS class_id
     FROM class_students cs
     JOIN classes c ON c.id = cs.class_id
     JOIN grades g ON g.id = c.grade_id
     WHERE cs.student_id = ?
     ORDER BY (c.archived_at IS NULL AND g.archived_at IS NULL) DESC, cs.joined_at DESC, cs.class_id DESC
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

/** GET /api/scores/me/exams/:examId — 当前用户某场考试的逐题明细（含班级均分与原卷图块） */
router.get("/me/exams/:examId", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  // #246 auto_delete：软删除考试的逐题明细不可访问
  if (await isExamSoftDeleted(examId)) {
    res.status(404).json({ message: "未找到你在该场考试的成绩" });
    return;
  }
  if (!(await scoreRepo.hasScore(req.user!.id, examId))) {
    res.status(404).json({ message: "未找到你在该场考试的成绩" });
    return;
  }
  // v41: 成绩未公布前学生不可查看（后端硬过滤）
  if (!(await scoreRepo.isExamScorePublished(examId))) {
    res.status(404).json({ message: "该场考试的成绩尚未公布" });
    return;
  }

  // 班级逐题均分 + 原卷图块：仅返回当前用户自己的数据，
  // 避免为小程序放开 /api/exams 教师接口造成越权（IDOR）
  const db = getMysqlDb();
  const classQuestionStats: Record<number, { avgScore: number; maxScore: number; count: number }> = {};
  const classId = await resolveStudentPrimaryClassId(req.user!.id);
  if (classId) {
    const classAvgs = await db.all(
      `SELECT qs.question_number, qs.score_type, ROUND(AVG(qs.score), 1) as avgScore, MAX(qs.max_score) as maxScore, COUNT(*) as cnt
       FROM question_scores qs
       JOIN class_students cs ON cs.student_id = qs.student_id
       WHERE qs.exam_id = ? AND cs.class_id = ?
       GROUP BY qs.question_number, qs.score_type
       ORDER BY qs.question_number`,
      examId, classId
    ) as Array<{ question_number: number; score_type: string; avgScore: number; maxScore: number; cnt: number }>;
    for (const row of classAvgs) {
      classQuestionStats[row.question_number] = { avgScore: row.avgScore, maxScore: row.maxScore, count: row.cnt };
    }
  }
  const answerBlocks = await listAnswerBlockCropsForStudent(examId, req.user!.id, db);

  res.json({
    examId,
    questions: await scoreRepo.getStudentQuestionScores(req.user!.id, examId),
    classQuestionStats,
    answerBlocks,
    // v54: 详情页「查看答案解析」入口，与 /paper 复用同一道门（已公布 + 教师开启显示原卷）
    paperVisible: (await assertStudentPaperVisible(examId, req.user!.id)).ok ? 1 : 0
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
    // 趋势判断：最近两次考试的得分率变化（见 subjectTrendFromScoreRate）
    const trend = subjectTrendFromScoreRate(points);

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
  // v41: 成绩未公布前学生不可请求 AI 分析（防止经由分析接口间接取分）
  if (!(await scoreRepo.isExamScorePublished(examId))) {
    res.status(403).json({ message: "该场考试的成绩尚未公布" });
    return;
  }

  const classId = await resolveStudentPrimaryClassId(req.user!.id);

  try {
    // 安全（R11 + PR #312 CR8/CR9）：学生侧 AI 分析是同步打模型的，它不建任务行，
    // 早先完全绕开了并发维度。现在准入直接把占位行（success IS NULL 的运行记录）
    // 写进同一个临界区：判定与占位原子完成，调用结束时由 trackAnalysisCall 回填即释放。
    // 复用统一的 llmclient 转发封装（自动拉起 sidecar + 内部鉴权头），
    // 避免与 llm-client.ts 的环境变量命名（LLMCLIENT_URL/LLMCLIENT_INTERNAL_API_KEY）不一致。
    const model = typeof req.body?.model === "string" ? req.body.model : undefined;
    const reservedRunId = await reserveAiCall(getMysqlDb(), req.user?.id ?? null, {
      feature: "student_analysis",
      model: model ?? null,
    });
    const response = await trackAnalysisCall({
      userId: req.user!.id,
      feature: "student_analysis",
      model: model ?? null,
      reservedRunId,
      doCall: (runId) => fetchLlmClient("/analysis/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examId,
          classId,
          callerRole: "student",
          studentId: req.user!.id,
          model,
          locale: "zh-CN",
        }),
      }, 120_000, { runId, provider: "llmclient", model: model ?? null, stage: "analysis" })
    });

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
    // 安全（R11）：配额拒绝不是「AI 服务不可用」，必须原样 429 + Retry-After，
    // 否则客户端会把限流当成故障反复重试，反而放大模型开销。
    if (error instanceof AiQuotaError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      res.status(429).json({ code: error.code, message: error.message, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
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
    const trend = subjectTrendFromScoreRate(points);
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
    weakPoints.push(`成绩下滑学科：${decliningSubjects.join("、")}。最近一次考试的得分率有所下降，需要关注。`);
    suggestions.push(`回顾 ${decliningSubjects.join("、")} 近期错题，分析失分原因。`);
  }
  // issue #345：满分解析不出来的学科不参与得分率比较，需要向学生说明结论不完整
  const unjudgedSubjects = subjectSummaries.filter((s) => s.trend === "unknown").map((s) => s.subject);
  if (unjudgedSubjects.length > 0) {
    caveats.push(`${unjudgedSubjects.join("、")} 的考试缺少满分依据，未参与进步/退步判定。`);
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

// ── v54: 学生「查看原卷 / 查看答案解析」（v66 追加答案原文件直发） ──

type StudentPaperAccess =
  | {
      ok: true;
      exam: {
        id: number;
        card_id: string | null;
        name: string | null;
        subject: string | null;
        /** 「显示原卷」开关：只控制原卷页图片是否下发 */
        showOriginalPaper: boolean;
        /** 正确答案展示模式：text=逐题文字 / file=答案原文件 */
        answerKeyMode: AnswerKeyMode;
      };
    }
  | { ok: false; status: number; message: string };

/**
 * 学生查看原卷/答案的硬门（后端强制，前端隐藏按钮不等于授权）：
 * 考试未被软删除 → 本人有成绩 → 成绩已公布 → 「显示原卷」与「答案原文件直发」至少开一项。
 *
 * v66 为什么把它并列：选择「答案原文件直发」本身就是教师把答案交给学生的动作，
 * 而这类考试常常没有单独上传原卷图片；若仍要求「显示原卷」才会开门，老师按字面
 * 配置后学生根本看不到入口（公布闸门与面板文案相反是本项目反复踩过的坑）。
 * 原卷页图片依旧只受「显示原卷」控制，直发模式不会顺带把试卷图泄露出去。
 *
 * 未开放一律回 404：避免通过状态码区分「没成绩/没公布/没开放」泄露他人信息。
 */
async function assertStudentPaperVisible(examId: number, studentId: number): Promise<StudentPaperAccess> {
  if (!Number.isInteger(examId) || examId <= 0) {
    return { ok: false, status: 400, message: "无效的考试 ID" };
  }
  if (await isExamSoftDeleted(examId)) {
    return { ok: false, status: 404, message: "未找到你在该场考试的成绩" };
  }
  if (!(await scoreRepo.hasScore(studentId, examId))) {
    return { ok: false, status: 404, message: "未找到你在该场考试的成绩" };
  }
  if (!(await scoreRepo.isExamScorePublished(examId))) {
    return { ok: false, status: 404, message: "该场考试的成绩尚未公布" };
  }
  const exam = await getMysqlDb().get<{
    id: number; card_id: string | null; name: string | null; subject: string | null;
    show_original_paper: number | null; answer_key_mode: string | null;
  }>(
    "SELECT id, card_id, name, subject, show_original_paper, answer_key_mode FROM exams WHERE id = ?",
    examId
  );
  if (!exam) {
    return { ok: false, status: 404, message: "未找到你在该场考试的成绩" };
  }
  const showOriginalPaper = exam.show_original_paper === 1;
  const answerKeyMode = normalizeAnswerKeyMode(exam.answer_key_mode);
  if (!showOriginalPaper && answerKeyMode !== ANSWER_KEY_MODE_FILE) {
    return { ok: false, status: 404, message: "本场考试未开放原卷与答案查看" };
  }
  return {
    ok: true,
    exam: {
      id: exam.id, card_id: exam.card_id, name: exam.name, subject: exam.subject,
      showOriginalPaper, answerKeyMode,
    },
  };
}

/**
 * GET /api/scores/me/exams/:examId/paper — 原卷页 + 正确答案 + 本人作答图块
 *
 * 正确答案二选一（exams.answer_key_mode）：
 *  - 'text'：只下发逐题文字（answers / pages[].answers），answerFiles 为空；
 *  - 'file'：只下发教师上传的答案原文件（answerFiles），文字答案整体不再下发。
 * 由后端决定下发哪一份，客户端只按 answerKeyMode 排版，不再自行推断该看哪一侧。
 */
router.get("/me/exams/:examId/paper", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const access = await assertStudentPaperVisible(examId, req.user!.id);
  if (!access.ok) {
    res.status(access.status).json({ message: access.message });
    return;
  }

  const db = getMysqlDb();
  const directFiles = access.exam.answerKeyMode === ANSWER_KEY_MODE_FILE;
  const [paperPages, answers, answerFiles, answerBlocks] = await Promise.all([
    // 原卷页是答题卡级资产，只受「显示原卷」控制，与答案模式无关
    access.exam.showOriginalPaper ? listExamPaperPages(access.exam.card_id, db) : Promise.resolve([]),
    directFiles ? Promise.resolve([]) : listExamAnswerKeys(examId, db),
    directFiles ? listAnswerKeyPages(examId, db, { exact: true }) : Promise.resolve([]),
    listAnswerBlockCropsForStudent(examId, req.user!.id, db),
  ]);
  const grouped = groupAnswersByPage(answers, paperPages.map((page) => page.pageIndex));

  res.json({
    examId,
    examName: access.exam.name,
    subject: access.exam.subject,
    answerKeyMode: access.exam.answerKeyMode,
    // 从未上传过原卷图片（或教师未开放原卷）时为空数组，客户端据此显示「原卷未上传」
    hasOriginalPaper: paperPages.length > 0,
    showOriginalPaper: access.exam.showOriginalPaper ? 1 : 0,
    pages: paperPages.map((page) => ({
      pageIndex: page.pageIndex,
      filename: page.filename,
      mimeType: page.mimeType,
      isImage: page.isImage,
      imageUrl: `/api/scores/me/exams/${examId}/paper/pages/${page.pageIndex}/image`,
      answers: grouped.get(page.pageIndex) ?? [],
    })),
    // 全量逐题答案（题号升序）：供「只看答案」列表视图使用；直发模式下恒为空
    answers,
    // 答案原文件（图片 / PDF / DOCX）：学生看到的是教师上传的那份文件本身
    answerFiles: answerFiles.map((page) => ({
      pageIndex: page.pageIndex,
      filename: page.filename,
      mimeType: page.mimeType,
      isImage: page.isImage,
      fileUrl: `/api/scores/me/exams/${examId}/paper/answer-file/${page.pageIndex}`,
    })),
    // 学生自己的作答图块：产品口径为「先看卷、再看作答」，故排在原卷之后
    answerBlocks,
  });
});

/** GET /api/scores/me/exams/:examId/paper/pages/:pageIndex/image — 原卷页字节（同套门校验，页码只走 DB 解析） */
router.get("/me/exams/:examId/paper/pages/:pageIndex/image", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const pageIndex = Number(req.params.pageIndex);
  const access = await assertStudentPaperVisible(examId, req.user!.id);
  if (!access.ok) {
    res.status(access.status).json({ message: access.message });
    return;
  }
  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    res.status(400).json({ message: "无效的页码" });
    return;
  }
  // v66：直发模式可以单独开门（不必开「显示原卷」），因此这里必须再确认一次原卷确实被放开，
  // 否则只想要「答案文件」的考试会把试卷图片一并被取走。
  if (!access.exam.showOriginalPaper) {
    res.status(404).json({ message: "本场考试未开放原卷查看" });
    return;
  }
  // 只允许该考试原卷分页表里的页码：URL 不含文件名，无法构造路径穿越
  const pages = await listExamPaperPages(access.exam.card_id);
  const page = pages.find((item) => item.pageIndex === pageIndex);
  if (!page) {
    res.status(404).json({ message: "原卷页不存在" });
    return;
  }
  const resolved = resolvePaperPageFile(access.exam.card_id!, pageIndex);
  if (!resolved) {
    res.status(404).json({ message: "原卷页不存在" });
    return;
  }
  res.contentType(resolved.mimeType);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.sendFile(resolved.filePath);
});

/**
 * GET /api/scores/me/exams/:examId/paper/answer-file/:pageIndex — 答案原文件字节（v66）
 *
 * 只在 exams.answer_key_mode='file' 时提供，门与原卷完全同一套（公布 + 入口 + 本人有成绩）。
 * 页码只走 DB 登记的记录解析文件名，URL 不含文件名，无法构造路径穿越；
 * 教师端 /api/exams/:id/answer-key/pages/:n/image 依旧是 requireExamAccess，学生打不通。
 */
router.get("/me/exams/:examId/paper/answer-file/:pageIndex", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const pageIndex = Number(req.params.pageIndex);
  const access = await assertStudentPaperVisible(examId, req.user!.id);
  if (!access.ok) {
    res.status(access.status).json({ message: access.message });
    return;
  }
  if (access.exam.answerKeyMode !== ANSWER_KEY_MODE_FILE) {
    res.status(404).json({ message: "本场考试未开放答案文件查看" });
    return;
  }
  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    res.status(400).json({ message: "无效的页码" });
    return;
  }
  const filename = await loadAnswerKeyPageFilename(examId, pageIndex);
  if (!filename) {
    res.status(404).json({ message: "答案文件不存在" });
    return;
  }
  const resolved = resolveAnswerKeyPageFile(examId, pageIndex, filename, { exact: true });
  if (!resolved) {
    res.status(404).json({ message: "答案文件不存在" });
    return;
  }
  res.contentType(resolved.mimeType);
  // DOCX 浏览器与小程序都无法内联渲染，显式 attachment 让客户端走「下载后打开」；
  // 文件名是服务端生成的 answerkey[-N].docx，不含用户输入，仍需去掉引号防头注入。
  if (path.extname(resolved.filename).toLowerCase() === ".docx") {
    res.setHeader("Content-Disposition", `attachment; filename="${resolved.filename.replace(/["\r\n]/g, "")}"`);
  }
  // 媒体 URL 不含账号。private + max-age 会让同一浏览器换账号后仍命中上一名学生的答案字节。
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(resolved.filePath);
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
  // 教师/管理员代查：公布门是学生端读门，代查须能看到未公布成绩（评审 P2，
  // 与教师端考试详情/天梯接口行为一致）
  let scores = await scoreRepo.getStudentScores(studentId, { publishedOnly: false });
  // 评审 P1：教师代查同样消费 #246 权限矩阵 —— 先按可见范围收敛（含软删除剔除），
  // 再逐场叠加 can_view_scores（成绩）与 can_view_students（姓名/考号）查看门；
  // 普通教师（无 teacher_role）此前回到全校可见、矩阵行完全失效的旁路由此收口。
  if (req.user!.role_name === "teacher") {
    const visibleIds = await getVisibleExamIds(req.user);
    const visible = visibleIds === null ? null : new Set(visibleIds);
    let inScope = visible === null ? scores : scores.filter((s) => visible.has(s.exam_id));
    const scopeExamIds = [...new Set(inScope.map((s) => s.exam_id))];
    if (scopeExamIds.length === 0 && scores.length > 0) {
      // 学生有成绩但教师可见范围内一场都没有 → 不借「空列表+姓名」泄露其身份
      res.status(403).json({ message: "权限不足：该学生的所有考试成绩都不在你的查看范围内" });
      return;
    }
    const scoreAllowed = await filterExamIdsByViewPermission(req.user, scopeExamIds, "can_view_scores");
    if (scopeExamIds.length > 0 && scoreAllowed.size === 0) {
      res.status(403).json({ message: "权限不足：管理员已关闭你对相关考试的「成绩」查看权限" });
      return;
    }
    const studentAllowed = await filterExamIdsByViewPermission(req.user, scopeExamIds, "can_view_students");
    if (studentAllowed.size !== scopeExamIds.length) {
      res.status(403).json({ message: "权限不足：管理员已关闭你对相关考试的「学生名单」查看权限" });
      return;
    }
    scores = inScope.filter((s) => scoreAllowed.has(s.exam_id));
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
    // #246 auto_delete：软删除考试的代查明细不可访问
    if (await isExamSoftDeleted(examId)) {
      res.status(404).json({ message: "考试不存在或已按数据保留策略清理" });
      return;
    }
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
      // 评审 P1：代查逐题明细叠加 can_view_scores + can_view_students 矩阵门
      if (
        !(await hasViewPermission(req.user, examId, "can_view_scores")) ||
        !(await hasViewPermission(req.user, examId, "can_view_students"))
      ) {
        res.status(403).json({ message: "权限不足：管理员已关闭你对本场考试的「成绩」或「学生名单」查看权限" });
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
