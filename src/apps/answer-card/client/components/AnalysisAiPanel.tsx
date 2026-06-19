import { AlertCircle, BrainCircuit, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../auth/api";
import type { AiAnalysisResponse, AiAnalysisStatus, AiProviderConfig } from "../../../../shared/types";

interface Props {
  examId: number;
  classId?: string;
}

function modelLabel(status: AiAnalysisStatus | null, modelId: string): string {
  const model = status?.models.find((item) => item.id === modelId);
  return model ? model.label : modelId;
}

function providerLabel(providers: AiProviderConfig[], providerId: number): string {
  const p = providers.find((item) => item.id === providerId);
  return p ? p.name : "未知服务商";
}

function listBlock(title: string, items: string[]) {
  return (
    <div className="ai-report-block">
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="ai-muted">暂无</p>
      ) : (
        <ul>
          {items.map((item, index) => (
            <li key={`${title}-${index}`}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AnalysisAiPanel({ examId, classId = "" }: Props) {
  const [status, setStatus] = useState<AiAnalysisStatus | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState(0); // 0 = 内置 llmclient
  const [analysis, setAnalysis] = useState<AiAnalysisResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

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

  useEffect(() => {
    setAnalysis(null);
    void loadStatus();
  }, [examId, classId]);

  async function generateAnalysis() {
    setGenerating(true);
    setError("");
    try {
      const body: Record<string, unknown> = { model: selectedModel || undefined };
      if (classId !== "") body.classId = Number(classId);
      if (selectedProviderId > 0) body.providerId = selectedProviderId;
      const result = await fetchJson<AiAnalysisResponse>(`/api/analysis/exams/${examId}/ai-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      setAnalysis(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  const hasBuiltinModels = availableModels.length > 0;
  const hasUserProviders = userProviders.length > 0;
  const aiAvailable = status?.available ?? false;
  const disabledReason = status?.available ? "" : (status?.reason || "AI service is not available.");
  const canGenerate = Boolean(aiAvailable && selectedModel && !generating);

  return (
    <div className="analysis-section ai-analysis-panel">
      <div className="ai-analysis-header">
        <div className="panel-title">
          <Sparkles size={17} /> AI 成绩分析
        </div>
        <div className="ai-analysis-controls" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {/* Provider selector — multi-provider support */}
          <select
            value={selectedProviderId}
            onChange={(e) => {
              const pid = Number(e.target.value);
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
            }}
            disabled={(!hasBuiltinModels && !hasUserProviders) || generating}
            style={{ minWidth: 140 }}
          >
            {!hasBuiltinModels && !hasUserProviders ? (
              <option value="0">暂无可用服务商</option>
            ) : (
              <>
                {hasBuiltinModels && <option value="0">内置 LLM 服务</option>}
                {hasUserProviders && (
                  <optgroup label="自定义服务商">
                    {userProviders.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({p.providerType})</option>
                    ))}
                  </optgroup>
                )}
              </>
            )}
          </select>

          {/* Model selector: dropdown for built-in, text+datalist for custom providers */}
          {selectedProviderId === 0 ? (
            <select
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              disabled={availableModels.length === 0 || generating}
              style={{ minWidth: 160 }}
            >
              {availableModels.length === 0 ? (
                <option value="">暂无可用模型</option>
              ) : (
                availableModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))
              )}
            </select>
          ) : (
            <>
              <input
                type="text"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder="输入模型名称，如 gpt-5.4"
                list="custom-provider-models"
                disabled={generating}
                style={{
                  padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line-strong)",
                  fontSize: 13, minWidth: 180, height: 36, boxSizing: "border-box"
                }}
              />
              <datalist id="custom-provider-models">
                {providerModelOptions?.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          )}

          <button className="icon-button" title="刷新 AI 服务状态" onClick={() => void loadStatus()} disabled={loadingStatus || generating}>
            <RefreshCw size={15} />
          </button>
          <button className="primary-button" onClick={() => void generateAnalysis()} disabled={!canGenerate}>
            <BrainCircuit size={16} /> {generating ? "分析中..." : "生成分析"}
          </button>
        </div>
      </div>

      {!aiAvailable && (
        <div className="ai-status-warning">
          <AlertCircle size={15} />
          <span>{loadingStatus ? "正在检测 AI 服务..." : disabledReason}</span>
        </div>
      )}

      {error && (
        <div className="ai-status-warning">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      )}

      {analysis && (
        <div className="ai-report">
          <div className="ai-report-summary">
            <strong>{analysis.report.overallJudgement}</strong>
            <span>{selectedProviderId > 0 ? `${providerLabel(userProviders, selectedProviderId)} / ` : ""}{modelLabel(status, analysis.model)} · {new Date(analysis.generatedAt).toLocaleString()}</span>
          </div>
          <div className="ai-report-block">
            <h4>分布洞察</h4>
            <p>{analysis.report.distributionInsight || "暂无"}</p>
          </div>
          <div className="ai-report-grid">
            {listBlock("薄弱点", analysis.report.weakPoints)}
            {listBlock("错误率高", analysis.report.reviewRisks)}
            {listBlock("教学建议", analysis.report.teachingSuggestions)}
            {listBlock("下一步行动", analysis.report.nextActions)}
          </div>
          {analysis.report.questionActions.length > 0 && (
            <div className="ai-question-actions">
              <h4>题目建议</h4>
              {analysis.report.questionActions.map((item, index) => (
                <div key={`${item.questionNumber}-${index}`} className="ai-question-action">
                  <strong>{item.questionNumber}</strong>
                  <span>{item.reason}</span>
                  <em>{item.action}</em>
                </div>
              ))}
            </div>
          )}
          {analysis.report.caveats.length > 0 && (
            <div className="ai-caveats">
              {analysis.report.caveats.map((item, index) => (
                <span key={index}>{item}</span>
              ))}
            </div>
          )}
          {analysis.toolCalls.length > 0 && (
            <div className="ai-tool-trace">
              {analysis.toolCalls.map((call, index) => (
                <span key={`${call.name}-${index}`}>{call.name}: {call.summary}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
