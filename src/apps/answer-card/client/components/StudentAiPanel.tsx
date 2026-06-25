import { useEffect, useMemo, useState } from "react";
import { AlertCircle, BrainCircuit, KeyRound, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { AiAnalysisResponse, AiAnalysisStatus, AiProviderConfig } from "../../../../shared/types";

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
        fetchJson<AiAnalysisStatus>("/api/scores/me/ai-status"),
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

  const canGenerate = Boolean((aiAvailable || selectedProviderId > 0) && selectedModel && !generating);

  return (
    <div className="student-chart-section">
      <div className="student-chart-header">
        <div className="panel-title"><Sparkles size={17} /> AI 成绩分析</div>
        <button className="ghost-button" type="button" onClick={() => void loadStatus()} disabled={loadingStatus}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {/* Provider section */}
      <div className="student-ai-provider-section">
        <div className="student-ai-mode-select">
          <label className="chart-toggle">
            <input type="radio" name="ai-mode" checked={analysisMode === "single"} onChange={() => setAnalysisMode("single")} />
            <span>单场分析</span>
          </label>
          <label className="chart-toggle">
            <input type="radio" name="ai-mode" checked={analysisMode === "overall"} onChange={() => setAnalysisMode("overall")} />
            <span>整体分析</span>
          </label>
        </div>

        <div className="student-ai-selectors">
          <select
            value={selectedProviderId}
            onChange={(e) => {
              const pid = Number(e.target.value);
              setSelectedProviderId(pid);
              if (pid === 0) {
                const preferred = availableModels.find((m) => m.id === status?.defaultModel) ?? availableModels[0];
                setSelectedModel(preferred?.id ?? "");
              } else {
                const prov = userProviders.find((p) => p.id === pid);
                setSelectedModel(prov?.models?.[0] ?? "");
              }
            }}
            disabled={generating}
            style={{ minWidth: 150 }}
          >
            {hasBuiltin && <option value="0">内置 LLM 服务</option>}
            {userProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.providerType})</option>
            ))}
            {!hasBuiltin && userProviders.length === 0 && <option value="0">暂无可用服务商</option>}
          </select>

          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={!selectedProviderId && availableModels.length === 0 || generating}
            style={{ minWidth: 160 }}
          >
            {selectedProviderId === 0 ? (
              availableModels.length === 0
                ? <option value="">暂无模型</option>
                : availableModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)
            ) : (
              userProviders.find((p) => p.id === selectedProviderId)?.models?.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))
            )}
          </select>

          <button className="primary-button" onClick={() => void generateAnalysis()} disabled={!canGenerate}>
            <BrainCircuit size={16} /> {generating ? "分析中..." : analysisMode === "single" ? "在成绩列表中选择" : "整体分析"}
          </button>
        </div>

        {analysisMode === "single" && (
          <p className="student-ai-hint">单场分析：请在「成绩列表」中展开某场考试后，点击该场次的 AI 分析按钮使用。</p>
        )}

        <button className="ghost-button" type="button" onClick={() => setShowCreateForm(!showCreateForm)} style={{ marginTop: 8 }}>
          <KeyRound size={14} /> {showCreateForm ? "收起" : "配置 API Key"}
        </button>
      </div>

      {/* API Key creation form */}
      {showCreateForm && (
        <div className="student-ai-form">
          <div className="student-ai-form-row">
            <select value={newProviderType} onChange={(e) => {
              const t = e.target.value;
              setNewProviderType(t);
              const preset = MODEL_PRESETS[t];
              if (preset) {
                setNewProviderName(preset.label);
                setNewBaseUrl(preset.defaultBaseUrl);
                setNewModels(preset.models.join(", "));
              }
            }}>
              {presets.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
            </select>
            <input type="text" placeholder="服务商名称" value={newProviderName} onChange={(e) => setNewProviderName(e.target.value)} />
          </div>
          <div className="student-ai-form-row">
            <input type="password" placeholder="API Key" value={newApiKey} onChange={(e) => setNewApiKey(e.target.value)} />
            <input type="text" placeholder="Base URL (可选)" value={newBaseUrl} onChange={(e) => setNewBaseUrl(e.target.value)} />
          </div>
          <div className="student-ai-form-row">
            <input type="text" placeholder="模型列表，逗号分隔 (可选)" value={newModels} onChange={(e) => setNewModels(e.target.value)} />
            <button className="primary-button" onClick={() => void saveProvider()} disabled={saving}>
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      )}

      {/* Existing providers list */}
      {userProviders.length > 0 && (
        <div className="student-ai-provider-list">
          {userProviders.map((p) => (
            <div key={p.id} className="student-ai-provider-item">
              <span><strong>{p.name}</strong> ({p.providerType})</span>
              <span className="ai-provider-models">{p.models?.join(", ") || "自动获取"}</span>
              <button className="ghost-button" type="button" onClick={() => void deleteProvider(p.id)} style={{ color: "#A32D2D" }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {!aiAvailable && userProviders.length === 0 && (
        <div className="ai-status-warning">
          <AlertCircle size={15} />
          <span>{loadingStatus ? "检测中..." : (status?.reason || "暂无可用 AI 服务，请配置 API Key")}</span>
        </div>
      )}

      {error && !loadingStatus && (
        <div className="ai-status-warning">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      )}

      {/* Analysis result */}
      {analysis && (
        <div className="ai-report">
          <div className="ai-report-summary">
            <strong>{analysis.report.overallJudgement}</strong>
            <span>{analysis.model} · {new Date(analysis.generatedAt).toLocaleString()}</span>
          </div>
          <div className="ai-report-block">
            <h4>整体评价</h4>
            <p>{analysis.report.distributionInsight || "暂无"}</p>
          </div>
          <div className="ai-report-grid">
            <div className="ai-report-block">
              <h4>薄弱点</h4>
              {analysis.report.weakPoints.length === 0 ? <p className="ai-muted">暂无</p> : (
                <ul>{analysis.report.weakPoints.map((item, i) => <li key={i}>{item}</li>)}</ul>
              )}
            </div>
            <div className="ai-report-block">
              <h4>学习建议</h4>
              {analysis.report.teachingSuggestions.length === 0 ? <p className="ai-muted">暂无</p> : (
                <ul>{analysis.report.teachingSuggestions.map((item, i) => <li key={i}>{item}</li>)}</ul>
              )}
            </div>
          </div>
          {analysis.report.caveats.length > 0 && (
            <div className="ai-caveats">
              {analysis.report.caveats.map((item, i) => <span key={i}>{item}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
