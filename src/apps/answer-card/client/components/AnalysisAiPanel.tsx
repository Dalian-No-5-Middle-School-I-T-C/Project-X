import { AlertCircle, BrainCircuit, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../auth/api";
import type {
  AiAnalysisResponse, AiAnalysisStatus, AiJobCreateResponse, AiJobPollResponse, AiProviderConfig,
} from "../../../../shared/types";
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./ui/v2";

interface Props {
  examId?: number;
  groupId?: number;
  classId?: string;
}

/** 内置 LLM 服务在 Select 里的哨兵值（Radix Select 不接受空字符串 value）。 */
const BUILTIN_PROVIDER = "0";

function modelLabel(status: AiAnalysisStatus | null, modelId: string): string {
  const model = status?.models.find((item) => item.id === modelId);
  return model ? model.label : modelId;
}

function providerLabel(providers: AiProviderConfig[], providerId: number): string {
  const p = providers.find((item) => item.id === providerId);
  return p ? p.name : "未知服务商";
}

/** 报告里的一个列表小节（薄弱点 / 教学建议 …）。 */
function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border-subtle bg-card p-3">
      <h4 className="m-0 text-sm font-semibold text-foreground">{title}</h4>
      {items.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">暂无</p>
      ) : (
        <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
          {items.map((item, index) => (
            <li
              key={`${title}-${index}`}
              className="text-sm text-secondary-foreground"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AnalysisAiPanel({ examId, groupId, classId = "" }: Props) {
  const [status, setStatus] = useState<AiAnalysisStatus | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState(0); // 0 = 内置 llmclient
  const [analysis, setAnalysis] = useState<AiAnalysisResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  // 建议 5：异步任务化 —— 提交后轮询 job 直到 done/error
  const [jobId, setJobId] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);

  const userProviders = useMemo(
    () => status?.providers ?? [],
    [status]
  );

  const availableModels = useMemo(
    () => status?.models.filter((model) => model.available) ?? [],
    [status]
  );

  // Models for current selected provider
  const providerModelOptions = useMemo(() => {
    if (selectedProviderId > 0) {
      const prov = userProviders.find((p) => p.id === selectedProviderId);
      return prov?.models ?? [];
    }
    return availableModels.map((m) => m.id);
  }, [selectedProviderId, userProviders, availableModels]);

  async function loadStatus() {
    setLoadingStatus(true);
    setError("");
    try {
      const nextStatus = await fetchJson<AiAnalysisStatus>("/api/analysis/ai/status");
      setStatus(nextStatus);

      // Select provider: prefer first user provider, else built-in
      if (nextStatus.providers && nextStatus.providers.length > 0) {
        setSelectedProviderId(nextStatus.providers[0].id);
        const firstProviderModels = nextStatus.providers[0].models;
        setSelectedModel(firstProviderModels && firstProviderModels.length > 0 ? firstProviderModels[0] : "");
      } else {
        setSelectedProviderId(0);
        const preferred = nextStatus.models.find((model) => model.available && model.id === nextStatus.defaultModel)
          ?? nextStatus.models.find((model) => model.available);
        setSelectedModel(preferred?.id ?? "");
      }
    } catch (err) {
      setStatus({
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        defaultModel: null,
        models: [],
        providers: []
      });
    } finally {
      setLoadingStatus(false);
    }
  }

  // 轮询任务状态（建议 5）：提交后每 1.5s 查询一次，直到 done/error
  useEffect(() => {
    if (jobId == null) return;
    let cancelled = false;
    setPolling(true);
    const timer = setInterval(async () => {
      try {
        const job = await fetchJson<AiJobPollResponse>(`/api/analysis/ai-analysis/jobs/${jobId}`);
        if (cancelled) return;
        if (job.status === "done") {
          setAnalysis(job.result ?? null);
          setError("");
          setPolling(false);
          setJobId(null);
        } else if (job.status === "error") {
          setError(job.error ?? "AI 分析失败");
          setAnalysis(null);
          setPolling(false);
          setJobId(null);
        }
      } catch {
        // 网络抖动继续轮询
      }
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [jobId]);

  useEffect(() => {
    setAnalysis(null);
    setJobId(null);
    setPolling(false);
    void loadStatus();
  }, [examId, groupId, classId]);

  async function generateAnalysis() {
    setGenerating(true);
    setError("");
    try {
      const body: Record<string, unknown> = { model: selectedModel || undefined };
      if (classId !== "") body.classId = Number(classId);
      if (selectedProviderId > 0) body.providerId = selectedProviderId;
      const endpoint = groupId
        ? `/api/exam-groups/${groupId}/ai-analysis`
        : `/api/analysis/exams/${examId}/ai-analysis`;
      // 立即拿到 jobId，不再同步等待 LLM（最长 120s 的阻塞移入后台串行队列）
      const created = await fetchJson<AiJobCreateResponse>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      setJobId(created.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  function handleProviderChange(value: string) {
    const pid = Number(value);
    setSelectedProviderId(pid);
    if (pid === 0) {
      // Built-in: use default model
      const preferred = availableModels.find((m) => m.id === status?.defaultModel)
        ?? availableModels[0];
      setSelectedModel(preferred?.id ?? "");
    } else {
      // User provider: pick first configured model or empty
      const prov = userProviders.find((p) => p.id === pid);
      setSelectedModel(prov?.models?.[0] ?? "");
    }
  }

  const hasBuiltinModels = availableModels.length > 0;
  const hasUserProviders = userProviders.length > 0;
  const noProviders = !hasBuiltinModels && !hasUserProviders;
  const aiAvailable = status?.available ?? false;
  const disabledReason = status?.available ? "" : (status?.reason || "AI service is not available.");
  const busy = generating || polling;
  const canGenerate = Boolean(aiAvailable && selectedModel && !busy);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Sparkles className="size-4 text-primary" /> AI 成绩分析
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 服务商选择 —— 支持多服务商 */}
          <Select
            value={String(selectedProviderId)}
            onValueChange={handleProviderChange}
            disabled={noProviders || generating}
          >
            <SelectTrigger className="w-40" aria-label="AI 服务商">
              <SelectValue placeholder="选择服务商" />
            </SelectTrigger>
            <SelectContent>
              {noProviders ? (
                <SelectItem value={BUILTIN_PROVIDER}>暂无可用服务商</SelectItem>
              ) : (
                <>
                  {hasBuiltinModels && (
                    <SelectItem value={BUILTIN_PROVIDER}>内置 LLM 服务</SelectItem>
                  )}
                  {hasUserProviders && (
                    <SelectGroup>
                      <SelectLabel>自定义服务商</SelectLabel>
                      {userProviders.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name}（{p.providerType}）
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </>
              )}
            </SelectContent>
          </Select>

          {/* 模型选择：内置走下拉，自定义服务商走文本 + datalist */}
          {selectedProviderId === 0 ? (
            <Select
              value={selectedModel}
              onValueChange={setSelectedModel}
              disabled={availableModels.length === 0 || generating}
            >
              <SelectTrigger className="w-44" aria-label="模型">
                <SelectValue placeholder="暂无可用模型" />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <>
              <Input
                type="text"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder="输入模型名称，如 gpt-5.4"
                list="analysis-ai-models"
                disabled={generating}
                aria-label="模型名称"
                className="w-48"
              />
              <datalist id="analysis-ai-models">
                {providerModelOptions?.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          )}

          <Button
            variant="ghost"
            size="sm"
            aria-label="刷新 AI 服务状态"
            title="刷新 AI 服务状态"
            onClick={() => void loadStatus()}
            disabled={loadingStatus || generating}
            loading={loadingStatus}
            icon={<RefreshCw className="size-4" />}
          />
          <Button
            variant="primary"
            size="sm"
            icon={<BrainCircuit className="size-4" />}
            onClick={() => void generateAnalysis()}
            disabled={!canGenerate}
            loading={busy}
          >
            {polling ? "AI 分析中…" : "生成分析"}
          </Button>
        </div>
      </div>

      {polling && (
        <div className="flex items-start gap-2 rounded-md border border-accent-border bg-accent-soft px-3 py-2 text-sm text-accent-foreground">
          <Sparkles className="mt-0.5 size-4 shrink-0" />
          <span>分析任务 #{jobId} 已提交，正在后台生成（异步执行，不再阻塞页面）。完成后自动展示报告。</span>
        </div>
      )}

      {!aiAvailable && (
        <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{loadingStatus ? "正在检测 AI 服务…" : disabledReason}</span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {analysis && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 rounded-md border border-accent-border bg-accent px-3 py-2.5">
            <strong className="text-base font-semibold text-foreground">
              {analysis.report.overallJudgement}
            </strong>
            <span className="text-xs text-muted-foreground">
              {selectedProviderId > 0
                ? `${providerLabel(userProviders, selectedProviderId)} / `
                : ""}
              {modelLabel(status, analysis.model)} ·{" "}
              <span className="tabular-nums">
                {new Date(analysis.generatedAt).toLocaleString()}
              </span>
            </span>
          </div>

          <div className="flex flex-col gap-1.5 rounded-md border border-border-subtle bg-card p-3">
            <h4 className="m-0 text-sm font-semibold text-foreground">分布洞察</h4>
            <p className="m-0 text-sm text-secondary-foreground">
              {analysis.report.distributionInsight || "暂无"}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <ListBlock title="薄弱点" items={analysis.report.weakPoints} />
            <ListBlock title="错误率高" items={analysis.report.reviewRisks} />
            <ListBlock title="教学建议" items={analysis.report.teachingSuggestions} />
            <ListBlock title="下一步行动" items={analysis.report.nextActions} />
          </div>

          {analysis.report.questionActions.length > 0 && (
            <div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-card p-3">
              <h4 className="m-0 text-sm font-semibold text-foreground">题目建议</h4>
              <div className="flex flex-col gap-2">
                {analysis.report.questionActions.map((item, index) => (
                  <div
                    key={`${item.questionNumber}-${index}`}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border-subtle pb-2 last:border-b-0 last:pb-0"
                  >
                    <strong className="shrink-0 text-sm tabular-nums text-foreground">
                      {item.questionNumber}
                    </strong>
                    <span className="min-w-0 flex-1 text-sm text-secondary-foreground">
                      {item.reason}
                    </span>
                    <em className="text-sm text-primary not-italic">{item.action}</em>
                  </div>
                ))}
              </div>
            </div>
          )}

          {analysis.report.caveats.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {analysis.report.caveats.map((item, index) => (
                <Badge key={index} tone="warning">
                  {item}
                </Badge>
              ))}
            </div>
          )}

          {analysis.toolCalls.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {analysis.toolCalls.map((call, index) => (
                <Badge key={`${call.name}-${index}`} tone="neutral">
                  {call.name}: {call.summary}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
