import { useState } from "react";
import { BrainCircuit } from "lucide-react";
import { fetchJson } from "../auth/api";
import { Button } from "./ui/v2";

/** v1.8.0 — 导出检查卡片内的知识点分析小面板（从 App.tsx 拆出）。 */
export function KnowledgeAnalysisInline({ cardId, onDone }: {
  cardId: string;
  onDone: (points: Array<{ question_number: number; points: string[] }>) => void;
}) {
  const [questionRange, setQuestionRange] = useState("全部");
  const [customRange, setCustomRange] = useState("");
  const [extraNotes, setExtraNotes] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setError(null);
    const range = questionRange === "all" ? "全部" : customRange.trim();
    if (!range) { setError("请输入题目范围"); setAnalyzing(false); return; }

    try {
      const res = await fetchJson<{ knowledgePoints?: Array<{ questionNumber: number; points: string[] }>; mode?: string; message?: string }>(
        `/api/cards/${cardId}/knowledge-points/analyze`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionRange: range, extraNotes: extraNotes.trim() }) }
      );
      if (res.message && (!res.knowledgePoints || res.knowledgePoints.length === 0)) {
        setError(res.message); setAnalyzing(false); return;
      }
      const pts = (res.knowledgePoints || []).map(k => ({ question_number: k.questionNumber || (k as any).question_number, points: k.points }));
      // Auto-save
      await fetchJson(`/api/cards/${cardId}/knowledge-points`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: pts.flatMap(p => p.points.map(pt => ({ question_number: p.question_number, point_text: pt }))) })
      }).catch(() => {});
      onDone(pts);
    } catch (e: any) {
      setError(e?.message || "AI 服务暂时不可用，请检查 llmclient 是否启动");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">题目范围 *</h4>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name="kpRange" checked={questionRange === "all"} onChange={() => setQuestionRange("all")} />
        全部题目
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name="kpRange" checked={questionRange === "custom"} onChange={() => setQuestionRange("custom")} />
        自定义范围
      </label>
      {questionRange === "custom" && (
        <input type="text" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          placeholder="如：第1-15题、选择题"
          value={customRange} onChange={(e) => setCustomRange(e.target.value)} />
      )}
      <textarea className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        placeholder="特别描述（可选）" value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} rows={2} />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button variant="primary" type="button" onClick={handleAnalyze} disabled={analyzing}
        icon={<BrainCircuit size={16} />}>
        {analyzing ? "分析中..." : "开始分析"}
      </Button>
      {analyzing && <p className="mt-1 text-xs text-muted-foreground">正在调用 AI 分析，约需 10-30 秒...</p>}
    </div>
  );
}
