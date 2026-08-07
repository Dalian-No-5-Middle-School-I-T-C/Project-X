import { useEffect, useMemo, useState } from "react";
import { AlertCircle, BrainCircuit, KeyRound, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { AiAnalysisResponse, AiAnalysisStatus, AiProviderConfig } from "../../../../shared/types";
import {
  Badge,
  Button,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type SegmentedItem,
} from "./ui/v2";

/** 简易的模型描述配置 */
interface ModelPreset {
  type: string;
  label: string;
  models: string[];
  defaultBaseUrl: string;
}

const MODEL_PRESETS: Record<string, ModelPreset> = {
  deepseek: { type: "deepseek", label: "DeepSeek", models: ["deepseek-chat", "deepseek-reasoner"], defaultBaseUrl: "https://api.deepseek.com" },
  openai: { type: "openai", label: "OpenAI 兼容", models: [], defaultBaseUrl: "" },
  gemini: { type: "gemini", label: "Gemini", models: ["gemini-2.0-flash", "gemini-2.5-pro"], defaultBaseUrl: "" },
};

type AnalysisMode = "single" | "overall";

const ANALYSIS_MODES: SegmentedItem<AnalysisMode>[] = [
  { value: "single", label: "单场分析" },
  { value: "overall", label: "整体分析" },
];

/** 内置 LLM 服务在 Select 里的哨兵值（Radix Select 不接受空字符串 value）。 */
const BUILTIN_PROVIDER = "0";
/** 无可用模型时的占位项值，避免 Radix Select 收到空 value。 */
const NO_MODEL = "__none__";

export function StudentAiPanel() {
  const [status, setStatus] = useState<AiAnalysisStatus | null>(null);
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState(0);
  const [selectedModel, setSelectedModel] = useState("");
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("single");
  const [analysis, setAnalysis] = useState<AiAnalysisResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  // Provider creation form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newProviderType, setNewProviderType] = useState("deepseek");
  const [newProviderName, setNewProviderName] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newModels, setNewModels] = useState("");
  const [saving, setSaving] = useState(false);

  const presets = useMemo(() => [...Object.values(MODEL_PRESETS)], []);

  const availableModels = useMemo(
    () => status?.models.filter((m) => m.available) ?? [],
    [status]
  );

  const userProviders = providers;
  const hasBuiltin = availableModels.length > 0;
  const aiAvailable = status?.available ?? false;

  async function loadStatus() {
    setLoadingStatus(true);
    setError("");
    try {
      // Fetch both status and user providers
      const [nextStatus, userProv] = await Promise.all([
        fetchJson<AiAnalysisStatus>("/api/analysis/ai/status"),
        fetchJson<AiProviderConfig[]>("/api/ai/providers"),
      ]);
      setStatus(nextStatus);
      setProviders(Array.isArray(userProv) ? userProv : []);

      if (userProv.length > 0) {
        setSelectedProviderId(userProv[0].id);
        setSelectedModel(userProv[0].models?.[0] ?? "");
      } else {
        setSelectedProviderId(0);
        const preferred = nextStatus.models.find((m) => m.available && m.id === nextStatus.defaultModel)
          ?? nextStatus.models.find((m) => m.available);
        setSelectedModel(preferred?.id ?? "");
      }
    } catch (err) {
      setStatus({
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        defaultModel: null,
        models: [],
        providers: [],
      });
    } finally {
      setLoadingStatus(false);
    }
  }

  useEffect(() => { void loadStatus(); }, []);

  async function generateAnalysis() {
    setGenerating(true);
    setError("");
    setAnalysis(null);
    try {
      const body: Record<string, unknown> = { model: selectedModel || undefined };
      if (selectedProviderId > 0) body.providerId = selectedProviderId;

      if (analysisMode === "single") {
        // Single exam mode: prompt user to select an exam
        // For now, we'll make it request from the teacher's existing endpoint
        // In a real implementation, we'd have a dropdown for exam selection
        setError("请先在「成绩列表」中选择一场考试，然后使用 AI 分析。");
        setGenerating(false);
        return;
      }

      // Overall analysis: new endpoint for student personal analysis
      const result = await fetchJson<AiAnalysisResponse>("/api/scores/me/ai-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setAnalysis(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function saveProvider() {
    if (!newProviderName.trim() || !newApiKey.trim()) {
      setError("请填写服务商名称和 API Key");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await fetchJson("/api/ai/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProviderName.trim(),
          providerType: newProviderType,
          apiKey: newApiKey.trim(),
          baseUrl: newBaseUrl.trim() || undefined,
          models: newModels.trim() ? newModels.split(",").map((m) => m.trim()).filter(Boolean) : undefined,
        }),
      });
      setShowCreateForm(false);
      setNewProviderName("");
      setNewApiKey("");
      setNewBaseUrl("");
      setNewModels("");
      void loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteProvider(id: number) {
    try {
      await fetchJson(`/api/ai/providers/${id}`, { method: "DELETE" });
      void loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  function handleProviderChange(value: string) {
    const pid = Number(value);
    setSelectedProviderId(pid);
    if (pid === 0) {
      const preferred = availableModels.find((m) => m.id === status?.defaultModel) ?? availableModels[0];
      setSelectedModel(preferred?.id ?? "");
    } else {
      const prov = userProviders.find((p) => p.id === pid);
      setSelectedModel(prov?.models?.[0] ?? "");
    }
  }

  function handlePresetChange(type: string) {
    setNewProviderType(type);
    const preset = MODEL_PRESETS[type];
    if (preset) {
      setNewProviderName(preset.label);
      setNewBaseUrl(preset.defaultBaseUrl);
      setNewModels(preset.models.join(", "));
    }
  }

  const providerModels =
    selectedProviderId === 0
      ? availableModels.map((m) => ({ value: m.id, label: m.label }))
      : (userProviders.find((p) => p.id === selectedProviderId)?.models ?? []).map(
          (m) => ({ value: m, label: m }),
        );

  const modelSelectDisabled =
    generating || (selectedProviderId === 0 && availableModels.length === 0);

  const canGenerate = Boolean((aiAvailable || selectedProviderId > 0) && selectedModel && !generating);

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border-subtle bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Sparkles className="size-4 text-primary" /> AI 成绩分析
        </div>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => void loadStatus()}
          disabled={loadingStatus}
          loading={loadingStatus}
          icon={<RefreshCw className="size-4" />}
        >
          刷新
        </Button>
      </div>

      {/* 服务商与模式 */}
      <div className="flex flex-col gap-3 rounded-md border border-border-subtle bg-secondary p-3">
        <SegmentedControl
          value={analysisMode}
          onValueChange={setAnalysisMode}
          items={ANALYSIS_MODES}
          size="sm"
          aria-label="分析模式"
          className="self-start"
        />

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={String(selectedProviderId)}
            onValueChange={handleProviderChange}
            disabled={generating}
          >
            <SelectTrigger className="w-44" aria-label="AI 服务商">
              <SelectValue placeholder="选择服务商" />
            </SelectTrigger>
            <SelectContent>
              {hasBuiltin && (
                <SelectItem value={BUILTIN_PROVIDER}>内置 LLM 服务</SelectItem>
              )}
              {userProviders.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}（{p.providerType}）
                </SelectItem>
              ))}
              {!hasBuiltin && userProviders.length === 0 && (
                <SelectItem value={BUILTIN_PROVIDER}>暂无可用服务商</SelectItem>
              )}
            </SelectContent>
          </Select>

          <Select
            value={selectedModel || NO_MODEL}
            onValueChange={(v) => setSelectedModel(v === NO_MODEL ? "" : v)}
            disabled={modelSelectDisabled}
          >
            <SelectTrigger className="w-44" aria-label="模型">
              <SelectValue placeholder="暂无模型" />
            </SelectTrigger>
            <SelectContent>
              {providerModels.length === 0 ? (
                <SelectItem value={NO_MODEL}>暂无模型</SelectItem>
              ) : (
                providerModels.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          <Button
            variant="primary"
            size="sm"
            icon={<BrainCircuit className="size-4" />}
            onClick={() => void generateAnalysis()}
            disabled={!canGenerate}
            loading={generating}
          >
            {analysisMode === "single" ? "在成绩列表中选择" : "整体分析"}
          </Button>
        </div>

        {analysisMode === "single" && (
          <p className="m-0 text-xs text-muted-foreground">
            单场分析：请在「成绩列表」中展开某场考试后，点击该场次的 AI 分析按钮使用。
          </p>
        )}

        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setShowCreateForm(!showCreateForm)}
          icon={<KeyRound className="size-4" />}
          className="self-start"
        >
          {showCreateForm ? "收起" : "配置 API Key"}
        </Button>
      </div>

      {/* API Key 表单 */}
      {showCreateForm && (
        <div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-card p-3">
          <div className="flex flex-wrap gap-2">
            <Select value={newProviderType} onValueChange={handlePresetChange}>
              <SelectTrigger className="w-40" aria-label="服务商类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.type} value={p.type}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="text"
              placeholder="服务商名称"
              aria-label="服务商名称"
              value={newProviderName}
              onChange={(e) => setNewProviderName(e.target.value)}
              className="min-w-0 flex-1"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              placeholder="API Key"
              aria-label="API Key"
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Input
              type="text"
              placeholder="Base URL（可选）"
              aria-label="Base URL"
              value={newBaseUrl}
              onChange={(e) => setNewBaseUrl(e.target.value)}
              className="min-w-0 flex-1"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              type="text"
              placeholder="模型列表，逗号分隔（可选）"
              aria-label="模型列表"
              value={newModels}
              onChange={(e) => setNewModels(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button
              variant="primary"
              onClick={() => void saveProvider()}
              disabled={saving}
              loading={saving}
            >
              保存
            </Button>
          </div>
        </div>
      )}

      {/* 已配置服务商 */}
      {userProviders.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {userProviders.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-md border border-border-subtle bg-card px-3 py-2"
            >
              <span className="shrink-0 text-sm text-foreground">
                <strong className="font-medium">{p.name}</strong>（{p.providerType}）
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {p.models?.join(", ") || "自动获取"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-label={`删除服务商 ${p.name}`}
                className="text-destructive-fg hover:text-destructive-fg"
                onClick={() => void deleteProvider(p.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {!aiAvailable && userProviders.length === 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            {loadingStatus
              ? "检测中…"
              : status?.reason || "暂无可用 AI 服务，请配置 API Key"}
          </span>
        </div>
      )}

      {error && !loadingStatus && (
        <div className="flex items-start gap-2 rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 分析结果 */}
      {analysis && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 rounded-md border border-accent-border bg-accent px-3 py-2.5">
            <strong className="text-base font-semibold text-foreground">
              {analysis.report.overallJudgement}
            </strong>
            <span className="text-xs text-muted-foreground">
              {analysis.model} ·{" "}
              <span className="tabular-nums">
                {new Date(analysis.generatedAt).toLocaleString()}
              </span>
            </span>
          </div>

          <div className="flex flex-col gap-1.5 rounded-md border border-border-subtle bg-card p-3">
            <h4 className="m-0 text-sm font-semibold text-foreground">整体评价</h4>
            <p className="m-0 text-sm text-secondary-foreground">
              {analysis.report.distributionInsight || "暂无"}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border-subtle bg-card p-3">
              <h4 className="m-0 text-sm font-semibold text-foreground">薄弱点</h4>
              {analysis.report.weakPoints.length === 0 ? (
                <p className="m-0 text-sm text-muted-foreground">暂无</p>
              ) : (
                <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
                  {analysis.report.weakPoints.map((item, i) => (
                    <li key={i} className="text-sm text-secondary-foreground">
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border-subtle bg-card p-3">
              <h4 className="m-0 text-sm font-semibold text-foreground">学习建议</h4>
              {analysis.report.teachingSuggestions.length === 0 ? (
                <p className="m-0 text-sm text-muted-foreground">暂无</p>
              ) : (
                <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
                  {analysis.report.teachingSuggestions.map((item, i) => (
                    <li key={i} className="text-sm text-secondary-foreground">
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {analysis.report.caveats.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {analysis.report.caveats.map((item, i) => (
                <Badge key={i} tone="warning">
                  {item}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
