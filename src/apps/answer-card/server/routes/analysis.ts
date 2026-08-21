/**
 * Analysis API routes (extracted from index.ts).
 *
 * Mounted at /api/analysis in the main app.  Paths are relative to that prefix.
 *
 * Dependencies: helpers, middleware, llm-client, repos, db.
 */
import express from "express";
import { getMysqlDb, buildUpsertSQL } from "../../../../server/db";
import { AnalysisRepository } from "../../../../server/repositories/AnalysisRepository";
import { KnowledgePointRepository } from "../../../../server/repositories/KnowledgePointRepository";
import { analysisCache } from "../../../../server/services/analysisCache";
import { createAiAnalysisJob, enqueueAiAnalysisJob, getAiAnalysisJobWithCreator } from "../../../../server/services/aiAnalysisJobs";
import { suggestForCard } from "../../../../server/services/knowledgeSuggester";
import { ApiError } from "../../../../server/api-error";
import { numberArray, optionalPositiveNumber } from "../helpers";
import { requireExamAccess, getVisibleExamIds, validateExamIdsAccess } from "../middleware";
import { requirePermission, authMiddleware } from "../../../../server/middleware/auth";
import { PERMISSIONS } from "../../../../server/auth/permissions";
import { ScoreRepository } from "../../../../server/repositories/ScoreRepository";
import { canReadGroup } from "../../../../server/routes/exam-groups-helpers";
import {
  getAnalysisThresholds, validateThresholdsInput, invalidateAnalysisThresholdsCache,
  ANALYSIS_SETTING_KEYS, DEFAULT_ANALYSIS_THRESHOLDS
} from "../../../../server/services/analysisConfig";
import { maskApiKey } from "../../../../server/utils/maskApiKey";
import { fetchLlmClient } from "../llm-client";
import { CreateExamGroupSchema, validateBody } from "../validation";
import type {
  AiJobCreateResponse, AiJobPollResponse, BorderlineLineKind, BorderlineResponse, ClassKnowledgeResponse,
  ComparableResponse, CrossExamTotalRequest, KnowledgeSuggestResponse, StudentTrendPoint,
  SubjectDeviationResponse, SubjectQualityResponse, WrongQuestionRow
} from "../../../../shared/types";

const router = express.Router();

// ── 阈值配置（路线图 P0-1）─────────────────────────────
// GET: 任何已登录用户可读（分析页需展示当前阈值）；PUT: 限管理员。

router.get("/config/thresholds", authMiddleware, async (_req, res, next) => {
  try {
    const t = await getAnalysisThresholds();
    res.json(t);
  } catch (error) {
    next(error);
  }
});

router.put("/config/thresholds", requirePermission(PERMISSIONS.SYSTEM_MANAGE), async (req, res, next) => {
  try {
    const result = validateThresholdsInput(req.body);
    if (!result.ok) { res.status(400).json({ message: result.message }); return; }
    const t = result.value;
    const db = getMysqlDb();
    const upsertSQL = buildUpsertSQL(
      db.dialect, "system_settings",
      ["key", "value", "updated_at"], ["key"], ["value", "updated_at"]
    );
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run(upsertSQL, ANALYSIS_SETTING_KEYS.passRate, String(t.passRate), now);
      await tx.run(upsertSQL, ANALYSIS_SETTING_KEYS.excellentRate, String(t.excellentRate), now);
      await tx.run(upsertSQL, ANALYSIS_SETTING_KEYS.segmentSize, String(t.segmentSize), now);
      await tx.run(upsertSQL, ANALYSIS_SETTING_KEYS.errorTiers, t.errorTiers.join(","), now);
    });
    invalidateAnalysisThresholdsCache();
    analysisCache.clear();
    res.json({ ok: true, data: await getAnalysisThresholds() });
  } catch (error) {
    next(error);
  }
});

// 阈值默认值常量（供前端首屏占位）
router.get("/config/thresholds/defaults", authMiddleware, async (_req, res) => {
  res.json({ ...DEFAULT_ANALYSIS_THRESHOLDS, errorTiers: [...DEFAULT_ANALYSIS_THRESHOLDS.errorTiers] });
});

// 难度/区分度档位（系统设置可配，缺省回退内置默认）
router.get("/config/bands", authMiddleware, async (_req, res, next) => {
  try {
    const { getDifficultyDiscriminationBands } = await import("../../../../server/services/analysisConfig");
    const bands = await getDifficultyDiscriminationBands();
    res.json(bands);
  } catch (error) {
    next(error);
  }
});

type AiProviderRow = {
  id: number;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  models: string | null;
  is_active: number | boolean;
};

function mapAiProvider(p: AiProviderRow) {
  return {
    id: p.id,
    name: p.name,
    providerType: p.provider_type,
    baseUrl: p.base_url,
    apiKey: maskApiKey(p.api_key),
    models: p.models ? JSON.parse(p.models) : null,
    isActive: Boolean(p.is_active)
  };
}

async function getActiveAiProviders(userId: number) {
  const db = getMysqlDb();
  const providerRows = await db.all<AiProviderRow>(`
    SELECT id, name, provider_type, base_url, api_key, models, is_active
    FROM ai_providers
    WHERE (user_id = ? OR is_system = 1) AND is_active = 1
    ORDER BY is_system, sort_order, id
  `, userId);
  return providerRows.map(mapAiProvider);
}

async function getAiProviderForUser(providerId: number, userId: number) {
  const db = getMysqlDb();
  return (await db.get<AiProviderRow>("SELECT * FROM ai_providers WHERE id = ? AND (user_id = ? OR is_system = 1)", providerId, userId)) ?? null;
}

// ── Trends ──────────────────────────────────────────────

router.get("/trends", async (req, res, next) => {
  try {
    const subject = typeof req.query.subject === "string" ? req.query.subject : "";
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const analysisRepo = new AnalysisRepository();
    // 按教师可见考试范围过滤，避免学科老师/班主任拉取全校趋势
    const visibleExamIds = await getVisibleExamIds(req.user);
    const trend = await analysisRepo.getScoreTrend(subject, classId, visibleExamIds);
    res.json(trend);
  } catch (error) {
    next(error);
  }
});

// ── Cross-exam groups ───────────────────────────────────

router.get("/cross-exam/groups", async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    res.json(await analysisRepo.listExamGroups(req.user?.id));
  } catch (error) {
    next(error);
  }
});

router.post("/cross-exam/groups", validateBody(CreateExamGroupSchema), async (req, res, next) => {
  try {
    const { name, examIds, source, startDate, endDate } = req.body as {
      name?: string;
      examIds?: unknown[];
      source?: "cross-manual" | "week";
      startDate?: string;
      endDate?: string;
    };
    const normalizedExamIds = numberArray(examIds);
    if (!name?.trim()) {
      res.status(400).json({ message: "请输入考试组名称" });
      return;
    }
    if (normalizedExamIds.length === 0) {
      res.status(400).json({ message: "请选择至少一场考试" });
      return;
    }
    if (!(await validateExamIdsAccess(req, res, normalizedExamIds))) return;

    const analysisRepo = new AnalysisRepository();
    const group = await analysisRepo.createExamGroup({
      name,
      examIds: normalizedExamIds,
      source: source === "week" ? "week" : "cross-manual",
      startDate,
      endDate,
      createdBy: req.user?.id ?? null
    });
    res.status(201).json(group);
  } catch (error) {
    next(error);
  }
});

router.delete("/cross-exam/groups/:groupId", async (req, res, next) => {
  try {
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      res.status(400).json({ message: "无效的考试组 ID" });
      return;
    }
    const analysisRepo = new AnalysisRepository();
    const ok = await analysisRepo.deleteExamGroup(groupId, req.user?.id ?? 0, req.user?.role_name === "admin");
    if (!ok) {
      res.status(404).json({ message: "考试组不存在或无权删除" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/cross-exam/total", async (req, res, next) => {
  try {
    const body = req.body as CrossExamTotalRequest;
    const mode = body.mode;
    if (mode !== "week" && mode !== "selected" && mode !== "group") {
      res.status(400).json({ message: "统计模式无效" });
      return;
    }

    const analysisRepo = new AnalysisRepository();
    let requestedExamIds: number[] = [];
    if (mode === "selected") {
      requestedExamIds = numberArray(body.examIds);
      if (requestedExamIds.length === 0) {
        res.status(400).json({ message: "请选择至少一场考试" });
        return;
      }
    } else if (mode === "group") {
      const groupId = optionalPositiveNumber(body.groupId);
      if (!groupId) {
        res.status(400).json({ message: "请选择考试组" });
        return;
      }
      const group = await analysisRepo.getExamGroup(groupId);
      if (!group) {
        res.status(404).json({ message: "考试组不存在" });
        return;
      }
      requestedExamIds = group.examIds;
    }

    if (requestedExamIds.length > 0 && !(await validateExamIdsAccess(req, res, requestedExamIds))) return;
    const visibleExamIds = await getVisibleExamIds(req.user);
    const data = await analysisRepo.getCrossExamTotal({
      mode,
      groupId: optionalPositiveNumber(body.groupId),
      examIds: requestedExamIds.length > 0 ? requestedExamIds : undefined,
      startDate: body.startDate,
      endDate: body.endDate,
      gradeId: optionalPositiveNumber(body.gradeId),
      classId: optionalPositiveNumber(body.classId),
      subject: typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : undefined,
      attendanceMode: body.attendanceMode === "full" ? "full" : "all"
    }, {
      visibleExamIds
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ── Per-exam analysis (requireExamAccess) ────────────────

router.get("/exams/:examId/classes", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const classes = await analysisRepo.getExamClasses(Number(req.params.examId));
    res.json(classes);
  } catch (error) {
    next(error);
  }
});

router.get("/exams/:examId/overview", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const overview = await analysisRepo.getExamOverview(Number(req.params.examId), classId);
    res.json(overview);
  } catch (error) {
    next(error);
  }
});

router.get("/exams/:examId/students", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const ranking = await analysisRepo.getStudentRanking(Number(req.params.examId), classId);
    res.json(ranking);
  } catch (error) {
    next(error);
  }
});

// v1.4.0: score table (rank change, deviation)
router.get("/exams/:examId/score-table", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const displayMode = (req.query.displayMode as string) || "deviation";
    const data = await analysisRepo.getScoreTableData(
      Number(req.params.examId),
      classId,
      displayMode as "deviation" | "zscore" | "percentile"
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// v1.7.0: previous exam comparison
router.get("/exams/:examId/previous", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const comparison = await analysisRepo.getPreviousExamComparison(
      Number(req.params.examId),
      classId
    );
    res.json(comparison);
  } catch (error) {
    next(error);
  }
});

router.get("/exams/:examId/questions", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const questions = await analysisRepo.getQuestionAnalysis(Number(req.params.examId), classId);
    res.json(questions);
  } catch (error) {
    next(error);
  }
});

// ── 逐题下钻：全班每人得分（难度/区分度增强）─────────────
router.get("/exams/:examId/question-students", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    // Bugfix: 严格校验 examId/questionNumber/classId，统一回正为有限正整数；无效值直接 400，
    // 避免后端异常或空结果（此前仅校验 questionNumber）。
    const examId = Number(req.params.examId);
    if (!Number.isInteger(examId) || examId <= 0) {
      res.status(400).json({ message: "examId 必须是正整数" });
      return;
    }
    const questionNumber = req.query.questionNumber ? Number(req.query.questionNumber) : undefined;
    if (questionNumber == null || !Number.isFinite(questionNumber)) {
      res.status(400).json({ message: "缺少 questionNumber 参数" });
      return;
    }
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    if (classId !== undefined && (!Number.isInteger(classId) || classId < 0)) {
      res.status(400).json({ message: "classId 必须是 ≥ 0 的整数（0=无班级）" });
      return;
    }
    const students = await analysisRepo.getQuestionStudentScores(examId, questionNumber, classId);
    res.json(students);
  } catch (error) {
    next(error);
  }
});

// ── 总体分析：单科/各班分布 ─────────────────────────
router.get("/exams/:examId/distribution", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const mode = (req.query.mode as string) === "class" ? "class" : "subject";
    const dist = await analysisRepo.getExamDistribution(Number(req.params.examId), mode);
    res.json(dist);
  } catch (error) {
    next(error);
  }
});

// ── 考试整体难度/区分度指标 ─────────────────────────
router.get("/exams/:examId/metrics", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const metrics = await analysisRepo.getExamMetrics(Number(req.params.examId), classId);
    res.json(metrics);
  } catch (error) {
    next(error);
  }
});

// ── 建议 4：临界生（踩线生）名单 ─────────────────────
router.get("/exams/:examId/borderline-students", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const examId = Number(req.params.examId);
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const lineKind = (["pass", "excellent", "custom", "percent"] as BorderlineLineKind[]).includes(req.query.lineKind as BorderlineLineKind)
      ? (req.query.lineKind as BorderlineLineKind)
      : "pass";
    const lineValue = req.query.lineValue ? Number(req.query.lineValue) : undefined;
    const margin = req.query.margin ? Number(req.query.margin) : undefined;
    const data = await analysisRepo.getBorderlineStudents(examId, { classId, lineKind, lineValue, margin });
    res.json(data satisfies BorderlineResponse);
  } catch (error) {
    next(error);
  }
});

// ── 建议 3：学生个人跨考试成长曲线 ────────────────────
// 越权防护：学生只能看本人曲线；教师/管理员只能看可见考试范围内的数据，
// 且目标学生在可见考试内无成绩时拒绝（防止拿任意学生 ID 枚举其他教师管辖的数据）。
router.get("/students/:studentId/trend", authMiddleware, async (req, res, next) => {
  try {
    const studentId = Number(req.params.studentId);
    if (!Number.isInteger(studentId) || studentId <= 0) {
      res.status(400).json({ message: "无效的学生 ID" });
      return;
    }
    const analysisRepo = new AnalysisRepository();
    const user = req.user;

    // 学生角色：只能读取本人曲线
    if (user?.role_name === "student") {
      if (user.id !== studentId) {
        res.status(403).json({ message: "权限不足：只能查看本人的成长曲线" });
        return;
      }
      const data = await analysisRepo.getStudentTrend(studentId, null);
      res.json(data satisfies StudentTrendPoint[]);
      return;
    }

    // 管理员 / 年级组长 / 普通教师（后兼容）→ 全部可见
    const visibleIds = await getVisibleExamIds(user);
    if (visibleIds === null) {
      const data = await analysisRepo.getStudentTrend(studentId, null);
      res.json(data satisfies StudentTrendPoint[]);
      return;
    }

    // 其余教师：仅返回可见考试内的数据；该生在可见范围内无成绩时拒绝访问
    const hasAnyScore = await getMysqlDb().get("SELECT 1 FROM student_scores WHERE student_id = ? LIMIT 1", studentId);
    const data = await analysisRepo.getStudentTrend(studentId, visibleIds);
    if (data.length === 0) {
      if (hasAnyScore) {
        res.status(403).json({ message: "权限不足：无权访问该学生" });
        return;
      }
      res.json([] satisfies StudentTrendPoint[]);
      return;
    }
    res.json(data satisfies StudentTrendPoint[]);
  } catch (error) {
    next(error);
  }
});

// ── 建议 7：偏科预警（POST 多考试跨科 Z 分）───────────
router.post("/subject-deviation", async (req, res, next) => {
  try {
    const examIds = numberArray(req.body?.examIds);
    if (examIds.length === 0) {
      res.status(400).json({ message: "请至少选择一场考试" });
      return;
    }
    if (!(await validateExamIdsAccess(req, res, examIds))) return;
    const classId = req.body?.classId ? Number(req.body.classId) : undefined;
    const threshold = req.body?.threshold ? Number(req.body.threshold) : 0.8;
    const analysisRepo = new AnalysisRepository();
    const data = await analysisRepo.getSubjectDeviation(examIds, { classId, threshold });
    res.json(data satisfies SubjectDeviationResponse);
  } catch (error) {
    next(error);
  }
});

// ── 建议 10：班级知识点掌握对比 ───────────────────────
router.get("/exams/:examId/class-knowledge", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const examId = Number(req.params.examId);
    let classIds: number[] | undefined;
    if (typeof req.query.classIds === "string" && req.query.classIds.trim()) {
      classIds = req.query.classIds.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
    }
    const data = await analysisRepo.getClassKnowledgeStats(examId, classIds);
    res.json(data satisfies ClassKnowledgeResponse);
  } catch (error) {
    next(error);
  }
});

// ── 建议 11：错题本 XLSX 导出 ────────────────────────
router.get("/exams/:examId/export-wrong", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const examId = Number(req.params.examId);
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const threshold = req.query.threshold ? Number(req.query.threshold) : 0.6;
    const rows: WrongQuestionRow[] = await analysisRepo.getWrongQuestionRows(examId, { classId, threshold });

    const XLSX = await import("xlsx");
    const header = ["班级", "考号", "姓名", "总分", "题号", "满分", "得分", "得分率%"];
    const data = rows.map((r) => [r.className, r.studentNumber, r.studentName, r.totalScore, r.questionNumber, r.maxScore, r.score, r.scoreRate]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws["!cols"] = [
      { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 8 },
      { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 8 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "错题本");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const exam = await analysisRepo.getExam(examId);
    const filename = `${exam?.name ?? "成绩表"}_错题本.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="wrong.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buf);
  } catch (error) {
    next(error);
  }
});

// ── 建议 14：年级间同类考试对比（同答题卡模板）────────
router.get("/exams/:examId/comparable", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const data = await analysisRepo.getComparableExams(Number(req.params.examId));
    res.json(data satisfies ComparableResponse);
  } catch (error) {
    next(error);
  }
});

// ── 建议 15：学科命题质量趋势（历次 P/D）──────────────
router.get("/subject-quality", async (req, res, next) => {
  try {
    const subject = typeof req.query.subject === "string" ? req.query.subject : "";
    const analysisRepo = new AnalysisRepository();
    const data = await analysisRepo.getSubjectQuality(subject);
    res.json(data satisfies SubjectQualityResponse);
  } catch (error) {
    next(error);
  }
});

// ── B2: 逐题选项分析（v29）──────────────────────────
router.get("/exams/:examId/option-analysis", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const data = await analysisRepo.getOptionAnalysis(Number(req.params.examId), classId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ── B3: 跨班对比（v29）─────────────────────────────
router.get("/exams/:examId/class-comparison", requireExamAccess, async (req, res, next) => {
  try {
    const raw = typeof req.query.classIds === "string" ? req.query.classIds : "";
    let classIds = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    const allClasses = req.query.all === "1" || req.query.all === "true";
    const analysisRepo = new AnalysisRepository();
    if (allClasses) {
      const examClasses = await analysisRepo.getExamClasses(Number(req.params.examId));
      classIds = examClasses.map((cls) => cls.classId);
    }
    if (classIds.length < 2 || (!allClasses && classIds.length > 30)) {
      res.status(400).json({ message: "请选择 2-30 个班级（或使用 all=1 对比全部班级）" });
      return;
    }
    const includeOptions = req.query.includeOptions === "1" || req.query.includeOptions === "true";
    const data = await analysisRepo.getClassComparison(Number(req.params.examId), classIds, includeOptions);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ── AI ──────────────────────────────────────────────────

router.get("/ai/status", async (req, res) => {
  try {
    const response = await fetchLlmClient("/health", { method: "GET" }, 2_500);
    const healthOk = response.ok;
    let llmStatus: { ok?: boolean; dbExists?: boolean; defaultModel?: string; models?: Array<{ id: string; provider: string; label: string; available: boolean; thinking?: boolean }> } = {};
    if (healthOk) {
      llmStatus = await response.json() as any;
    }

    const userProviders = await getActiveAiProviders(req.user!.id);

    const configuredModels = llmStatus.models ?? [];
    const hasAvailableModel = configuredModels.some((model) => model.available);
    const hasUserProvider = userProviders.length > 0;

    res.json({
      available: Boolean((healthOk && llmStatus.dbExists && hasAvailableModel) || hasUserProvider),
      reason: !healthOk
        ? `LLM service returned ${response.status}`
        : !llmStatus.dbExists && !hasUserProvider
          ? "LLM service is running, but Project-X database was not found."
          : !hasAvailableModel && !hasUserProvider
            ? "LLM service is running, but no provider API key is configured."
            : undefined,
      defaultModel: llmStatus.defaultModel ?? (hasUserProvider ? "auto" : null),
      models: configuredModels,
      providers: userProviders
    });
  } catch (error) {
    try {
      const userProviders = await getActiveAiProviders(req.user!.id);

      res.json({
        available: userProviders.length > 0,
        reason: userProviders.length > 0 ? undefined : "LLM service is not reachable and no local providers configured.",
        defaultModel: userProviders.length > 0 ? "auto" : null,
        models: [],
        providers: userProviders
      });
    } catch {
      res.json({
        available: false,
        reason: error instanceof Error ? error.message : "LLM service is not reachable.",
        defaultModel: null,
        models: [],
        providers: []
      });
    }
  }
});

router.post("/exams/:examId/ai-analysis", requireExamAccess, async (req, res, next) => {
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId) || examId <= 0) {
      res.status(400).json({ code: ApiError.INVALID_VALUE, message: "无效的考试 ID" });
      return;
    }

    const analysisRepo = new AnalysisRepository();
    const exam = await analysisRepo.getExam(examId);
    if (!exam) {
      res.status(404).json({ code: ApiError.NOT_FOUND, message: "考试不存在" });
      return;
    }

    const classIdValue = req.body?.classId;
    const classId = classIdValue === undefined || classIdValue === null || classIdValue === ""
      ? undefined
      : Number(classIdValue);
    if (classId !== undefined && !Number.isFinite(classId)) {
      res.status(400).json({ code: ApiError.INVALID_VALUE, message: "无效的班级 ID" });
      return;
    }

    const providerId = req.body?.providerId ? Number(req.body.providerId) : undefined;
    let providerOverride: Record<string, unknown> | undefined;
    if (providerId && Number.isFinite(providerId)) {
      const prov = await getAiProviderForUser(providerId, req.user!.id);
      if (prov) {
        providerOverride = {
          provider_type: prov.provider_type,
          base_url: prov.base_url,
          api_key: prov.api_key
        };
      }
    }

    // 建议 5：先建任务立即返回 jobId，后台串行队列执行（不再同步阻塞最长 120s）
    const jobId = await createAiAnalysisJob({
      examId,
      classId,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      providerOverride,
      createdBy: req.user?.id ?? null,
    });
    enqueueAiAnalysisJob(jobId, { examId, classId, model: typeof req.body?.model === "string" ? req.body.model : undefined, providerOverride })
      .catch((err) => console.error(`[AiJob] #${jobId} failed:`, err));
    res.status(202).json({ jobId, status: "queued" } satisfies AiJobCreateResponse);
  } catch (error) {
    next(error);
  }
});

// GET /api/analysis/ai-analysis/jobs/:jobId — 轮询任务状态（建议 5）
router.get("/ai-analysis/jobs/:jobId", authMiddleware, async (req, res, next) => {
  try {
    const jobId = Number(req.params.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      res.status(400).json({ message: "无效的任务 ID" });
      return;
    }
    const entry = await getAiAnalysisJobWithCreator(jobId);
    if (!entry) {
      res.status(404).json({ message: "任务不存在" });
      return;
    }
    const { job, createdBy } = entry;
    // 匿名开发模式（未强制鉴权且无 token）维持向后兼容放行；
    // 其余用户按创建者 / 考试可见性二次校验，杜绝按自增 ID 遍历他人任务（IDOR）。
    if (req.user && !(await canAccessAiJobContext(req.user, createdBy, job))) {
      res.status(403).json({ message: "权限不足：无权访问该任务" });
      return;
    }
    res.json(job satisfies AiJobPollResponse);
  } catch (error) {
    next(error);
  }
});

/**
 * 轮询接口的 IDOR 防护辅助：管理员 / 任务创建者放行；
 * 其余按任务引用的考试（requireExamAccess 语义）或考试组（requireReadableGroup 语义）重新校验。
 */
async function canAccessAiJobContext(
  user: NonNullable<express.Request["user"]>,
  createdBy: number | null,
  job: AiJobPollResponse
): Promise<boolean> {
  if (user.role_name === "admin") return true;
  if (createdBy != null && createdBy === user.id) return true;

  if (job.examId != null) {
    if (user.role_name === "student") {
      // 学生只能轮询自己参加过的考试对应的任务
      return await new ScoreRepository().hasScore(user.id, job.examId);
    }
    const visibleIds = await getVisibleExamIds(user);
    return visibleIds === null || visibleIds.includes(job.examId);
  }
  if (job.groupId != null) {
    return await canReadGroup({ user } as express.Request, job.groupId);
  }
  return false;
}

// ── Export ──────────────────────────────────────────────

router.get("/exams/:examId/export-csv", requireExamAccess, async (req, res, next) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const examId = Number(req.params.examId);

    const { students, questionHeaders } = await analysisRepo.getExportData(examId, classId);

    const header = ["班级", "考号", "姓名", "成绩", "班级排名", "年级排名", "客观题", "主观题", ...questionHeaders];
    const data = students.map((s) => [
      s.className,
      s.studentNumber,
      s.name,
      s.totalScore,
      s.classRank,
      s.gradeRank,
      s.objectiveScore,
      s.subjectiveScore,
      ...s.questionScores
    ]);

    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws["!cols"] = [
      { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 8 },
      { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "成绩表");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

    const exam = await analysisRepo.getExam(examId);
    const filename = `${exam?.name ?? "成绩表"}_${classId ? "班级" : "年级"}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // RFC 5987：中文文件名用 filename* 传输，避免浏览器显示 URL 编码串
    res.setHeader("Content-Disposition", `attachment; filename="scores.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buf);
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 知识点分析端点 (v1.8.0)
// ============================================================

// GET /api/analysis/knowledge-points/:examId — 按知识点聚合全班得分率
router.get("/knowledge-points/:examId", requireExamAccess, async (req, res, next) => {
  try {
    const examId = parseInt(String(req.params.examId), 10);
    const classId = req.query.classId ? parseInt(String(req.query.classId), 10) : undefined;

    const repo = new KnowledgePointRepository();
    const weaknesses = await repo.getWeaknessesForExam(examId, classId);
    res.json({ weaknesses });
  } catch (error) {
    next(error);
  }
});

// GET /api/analysis/knowledge-points/:examId/students/:studentId — 单个学生知识点弱项
router.get("/knowledge-points/:examId/students/:studentId", requireExamAccess, async (req, res, next) => {
  try {
    const examId = parseInt(String(req.params.examId), 10);
    const studentId = parseInt(String(req.params.studentId), 10);

    const repo = new KnowledgePointRepository();
    const weaknesses = await repo.getWeaknessesForStudent(examId, studentId);
    res.json({ weaknesses });
  } catch (error) {
    next(error);
  }
});

// ── 建议 8：知识点半自动标注（静态词典匹配 + 人工应用）──
// GET /api/analysis/knowledge-points/:examId/suggest — 该考试答题卡的逐题候选知识点
router.get("/knowledge-points/:examId/suggest", requireExamAccess, async (req, res, next) => {
  try {
    const examId = parseInt(String(req.params.examId), 10);
    const db = getMysqlDb();
    const exam = await db.get("SELECT card_id, subject FROM exams WHERE id = ?", examId) as { card_id: string | null; subject: string | null } | undefined;
    if (!exam?.card_id) {
      res.json({ cardId: null, subject: null, suggestions: [] } satisfies KnowledgeSuggestResponse);
      return;
    }
    const data = await suggestForCard(exam.card_id, exam.subject);
    res.json(data satisfies KnowledgeSuggestResponse);
  } catch (error) {
    next(error);
  }
});

// POST /api/analysis/knowledge-points/:examId/apply-suggestions — 批量勾选应用标注
router.post("/knowledge-points/:examId/apply-suggestions", requireExamAccess, async (req, res, next) => {
  try {
    const examId = parseInt(String(req.params.examId), 10);
    const points = req.body?.points;
    if (!Array.isArray(points)) {
      res.status(400).json({ message: "缺少 points 数组" });
      return;
    }
    const db = getMysqlDb();
    const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
    if (!exam?.card_id) {
      res.status(404).json({ message: "考试无关联答题卡" });
      return;
    }
    const cleaned = points
      .filter((p: any) => p && Number.isInteger(Number(p.question_number)) && typeof p.point_text === "string" && p.point_text.trim())
      .map((p: any) => ({ question_number: Number(p.question_number), point_text: p.point_text.trim(), category: p.category || null }));
    const repo = new KnowledgePointRepository();
    await repo.mergeByCard(exam.card_id, cleaned);
    analysisCache.invalidateExam(examId);
    res.json({ ok: true, applied: cleaned.length });
  } catch (error) {
    next(error);
  }
});

export default router;
