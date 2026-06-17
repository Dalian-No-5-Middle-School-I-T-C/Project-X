import { AlertCircle, BrainCircuit, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../auth/api";
import type { AiAnalysisResponse, AiAnalysisStatus } from "../../../../shared/types";

interface Props {
  examId: number;
  classId?: string;
}

function modelLabel(status: AiAnalysisStatus | null, modelId: string): string {
  const model = status?.models.find((item) => item.id === modelId);
  return model ? model.label : modelId;
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
  const [analysis, setAnalysis] = useState<AiAnalysisResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const availableModels = useMemo(
    () => status?.models.filter((model) => model.available) ?? [],
    [status]
  );

  async function loadStatus() {
    setLoadingStatus(true);
    setError("");
    try {
      const nextStatus = await fetchJson<AiAnalysisStatus>("/api/analysis/ai/status");
      setStatus(nextStatus);
      const preferred = nextStatus.models.find((model) => model.available && model.id === nextStatus.defaultModel)
        ?? nextStatus.models.find((model) => model.available);
      setSelectedModel(preferred?.id ?? "");
    } catch (err) {
      setStatus({
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        defaultModel: null,
        models: []
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

  const disabledReason = status?.available ? "" : (status?.reason || "AI service is not available.");
  const canGenerate = Boolean(status?.available && selectedModel && !generating);

  return (
    <div className="analysis-section ai-analysis-panel">
      <div className="ai-analysis-header">
        <div className="panel-title">
          <Sparkles size={17} /> AI 成绩分析
        </div>
        <div className="ai-analysis-controls">
          <select
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
            disabled={availableModels.length === 0 || generating}
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
          <button className="icon-button" title="刷新 AI 服务状态" onClick={() => void loadStatus()} disabled={loadingStatus || generating}>
            <RefreshCw size={15} />
          </button>
          <button className="primary-button" onClick={() => void generateAnalysis()} disabled={!canGenerate}>
            <BrainCircuit size={16} /> {generating ? "分析中..." : "生成分析"}
          </button>
        </div>
      </div>

      {!status?.available && (
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
            <span>{modelLabel(status, analysis.model)} · {new Date(analysis.generatedAt).toLocaleString()}</span>
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
