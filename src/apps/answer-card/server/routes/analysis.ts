/**
 * Analysis API routes (extracted from index.ts).
 *
 * Mounted at /api/analysis in the main app.  Paths are relative to that prefix.
 *
 * Dependencies: helpers, middleware, llm-client, repos, db.
 */
import express from "express";
import { getMysqlDb } from "../../../../server/db";
import { AnalysisRepository } from "../../../../server/repositories/AnalysisRepository";
import { KnowledgePointRepository } from "../../../../server/repositories/KnowledgePointRepository";
import { ApiError } from "../../../../server/api-error";
import { numberArray, optionalPositiveNumber } from "../helpers";
import { requireExamAccess, getVisibleExamIds, validateExamIdsAccess } from "../middleware";
import { maskApiKey } from "../../../../server/utils/maskApiKey";
import { fetchLlmClient } from "../llm-client";
import { CreateExamGroupSchema, validateBody } from "../validation";
import type { CrossExamTotalRequest } from "../../../../shared/types";

const router = express.Router();

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
    WHERE user_id = ? AND is_active = 1
    ORDER BY sort_order, id
  `, userId);
  return providerRows.map(mapAiProvider);
}

async function getAiProviderForUser(providerId: number, userId: number) {
  const db = getMysqlDb();
  return db.get<AiProviderRow>("SELECT * FROM ai_providers WHERE id = ? AND user_id = ?", providerId, userId);
}

// ── Trends ──────────────────────────────────────────────

router.get("/trends", async (req, res, next) => {
  try {
    const subject = typeof req.query.subject === "string" ? req.query.subject : "";
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const analysisRepo = new AnalysisRepository();
    const trend = await analysisRepo.getScoreTrend(subject, classId);
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
      visibleExamIds: await getVisibleExamIds(req.user)
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

// v1.9.0: 跨班深度对比（概况 / 题目矩阵 / 知识点矩阵）
router.get("/exams/:examId/class-compare", requireExamAccess, async (req, res, next) => {
  try {
    const examId = Number(req.params.examId);
    if (!Number.isInteger(examId) || examId <= 0) {
      res.status(400).json({ code: ApiError.INVALID_VALUE, message: "无效的考试 ID" });
      return;
    }

    const rawClassIds = typeof req.query.classIds === "string"
      ? req.query.classIds.split(",").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(req.query.classIds)
        ? req.query.classIds.map(String)
        : [];
    const classIds = rawClassIds
      .map((v) => Number(v))
      .filter((id) => Number.isInteger(id) && id >= 0);

    const baselineRaw = req.query.baselineClassId;
    const baselineClassId = baselineRaw === undefined || baselineRaw === ""
      ? null
      : Number(baselineRaw);
    if (baselineClassId != null && (!Number.isInteger(baselineClassId) || baselineClassId < 0)) {
      res.status(400).json({ code: ApiError.INVALID_VALUE, message: "无效的基准班级 ID" });
      return;
    }

    const includeRaw = typeof req.query.include === "string" ? req.query.include : "questions,knowledge,distribution";
    const includeSet = new Set(includeRaw.split(",").map((s) => s.trim()).filter(Boolean));
    const includeQuestions = includeSet.size === 0 || includeSet.has("questions") || includeSet.has("all");
    const includeKnowledge = includeSet.size === 0 || includeSet.has("knowledge") || includeSet.has("all");

    const analysisRepo = new AnalysisRepository();
    const result = await analysisRepo.getCrossClassDeepCompare(
      examId,
      classIds.length > 0 ? classIds : undefined,
      { baselineClassId, includeQuestions, includeKnowledge }
    );
    res.json(result);
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

    const response = await fetchLlmClient("/analysis/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        examId,
        classId,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        locale: "zh-CN",
        providerOverride: providerOverride ?? undefined
      })
    }, 120_000);

    if (!response.ok) {
      let message = `AI 服务返回 ${response.status}`;
      try {
        const body = await response.json() as { detail?: string; message?: string };
        message = body.detail || body.message || message;
      } catch {
        const text = await response.text().catch(() => "");
        if (text) message = text;
      }
      if (message.includes("404") && providerOverride) {
        const urlHint = providerOverride.base_url ? ` (base_url: ${providerOverride.base_url})` : "";
        message = `自定义服务商 API 返回 404${urlHint}。请检查 Base URL 是否正确 — 它应该是 API 端点地址，而非网站首页。确保 Python llmclient 已启动。`;
      }
      res.status(response.status >= 400 && response.status < 500 ? response.status : 502)
        .json({ code: ApiError.AI_SERVICE_ERROR, message });
      return;
    }

    res.json(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      res.status(504).json({ code: ApiError.AI_SERVICE_TIMEOUT, message: "AI 服务请求超时。请检查 llmclient 是否正常运行。" });
      return;
    }
    if (error instanceof Error && (error.message.includes("fetch") || error.message.includes("ECONNREFUSED"))) {
      res.status(503).json({ code: ApiError.AI_SERVICE_UNREACHABLE, message: "无法连接到 Python llmclient 中转服务。请先启动：py -m uvicorn llmclient.server:app --host 127.0.0.1 --port 8766" });
      return;
    }
    next(error);
  }
});

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
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
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

export default router;
