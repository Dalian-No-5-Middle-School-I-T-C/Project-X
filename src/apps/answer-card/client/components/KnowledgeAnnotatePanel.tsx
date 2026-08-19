import { useCallback, useEffect, useState } from "react";
import { Check, Sparkles, Wand2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import type { KnowledgeSuggestResponse } from "../../../../shared/types";
import { Button, EmptyState } from "./ui/v2";

type Selection = Array<{ questionNumber: number; point_text: string }>;

/**
 * 建议 8：知识点半自动标注（静态词典第一步）。
 * 词典匹配出候选知识点 → 人工勾选确认 → 批量写入 knowledge_points（下游分析零改动）。
 */
export function KnowledgeAnnotatePanel({ examId, onApplied }: { examId: number; onApplied: () => void }) {
  const [data, setData] = useState<KnowledgeSuggestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState<Selection>([]);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetchJson<KnowledgeSuggestResponse>(`/api/analysis/knowledge-points/${examId}/suggest`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [examId]);

  useEffect(() => { load(); }, [load]);

  function toggle(qn: number, point: string) {
    setSelected((prev) => {
      const exists = prev.some((s) => s.questionNumber === qn && s.point_text === point);
      return exists ? prev.filter((s) => !(s.questionNumber === qn && s.point_text === point)) : [...prev, { questionNumber: qn, point_text: point }];
    });
  }

  async function apply() {
    if (selected.length === 0) return;
    setApplying(true);
    setMsg("");
    try {
      const res = await fetchJson<{ ok?: boolean; applied?: number; message?: string }>(
        `/api/analysis/knowledge-points/${examId}/apply-suggestions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points: selected }),
        },
      );
      if (res.ok || typeof res.applied === "number") {
        setMsg(`已标注 ${res.applied ?? selected.length} 条`);
        setSelected([]);
        onApplied();
      } else {
        setMsg(res.message ?? "应用失败");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "应用失败");
    } finally {
      setApplying(false);
    }
  }

  const suggestions = data?.suggestions ?? [];
  const withMatches = suggestions.filter((s) => s.matched.length > 0);
  const hasSuggestions = withMatches.length > 0;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Wand2 className="size-4 text-primary" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground">知识点半自动标注</h3>
          <span className="text-xs text-muted-foreground">（静态词典匹配，人工确认后写入）</span>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-primary">{msg}</span>}
          <Button variant="outline" size="sm" icon={<Sparkles />} onClick={() => void load()} loading={loading}>重新匹配</Button>
          <Button variant="primary" size="sm" icon={<Check />} onClick={() => void apply()} loading={applying} disabled={selected.length === 0}>
            应用勾选（{selected.length}）
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="py-3 text-center text-sm text-muted-foreground">匹配中...</p>
      ) : !hasSuggestions ? (
        <EmptyState
          size="sm"
          title="暂无匹配候选"
          description="客观题没有独立题干文本；解答题请在答题卡设计页补充题干注释（annotation）后重新匹配。"
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {withMatches.map((s) => (
            <li key={s.questionNumber} className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle px-3 py-2">
              <span className="w-10 shrink-0 text-sm font-semibold tabular-nums text-foreground">第{s.questionNumber}题</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={s.source}>{s.source}</span>
              <div className="flex flex-wrap gap-1.5">
                {s.matched.map((point) => {
                  const active = selected.some((sel) => sel.questionNumber === s.questionNumber && sel.point_text === point);
                  return (
                    <button
                      key={point}
                      type="button"
                      onClick={() => toggle(s.questionNumber, point)}
                      className={cn(
                        "inline-flex h-control-sm items-center gap-1 rounded-full border px-2.5 text-xs transition-colors",
                        active
                          ? "border-primary bg-primary-soft font-semibold text-primary-foreground"
                          : "border-border bg-card text-secondary-foreground hover:bg-secondary",
                      )}
                    >
                      {active && <Check className="size-3" aria-hidden />}
                      {point}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
