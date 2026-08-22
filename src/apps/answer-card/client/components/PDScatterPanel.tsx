import { useMemo } from "react";
import type { QuestionAnalysisItem } from "../../../../shared/types";
import type { ThresholdBand } from "../../../../shared/stats";
import { Badge } from "./ui/v2";
import { PDScatter } from "./AnalysisCharts";

/**
 * D1: 难度-区分度诊断散点面板（题目分析页）。
 * 点 = 逐题（P/D），疑似问题题（难度 P < 0.5 且区分度 D < 0.3）描红圈高亮。
 */
export function PDScatterPanel({
  questions,
  bands,
}: {
  questions: QuestionAnalysisItem[];
  bands?: { difficulty: ThresholdBand[]; discrimination: ThresholdBand[] };
}) {
  const points = useMemo(
    () =>
      questions.map((q) => ({
        questionNumber: String(q.questionNumber),
        x: q.difficulty,
        y: q.discrimination ?? 0,
        scoreRate: q.scoreRate ?? null,
      })),
    [questions],
  );
  const suspectCount = useMemo(
    () => points.filter((p) => p.x < 0.5 && p.y < 0.3).length,
    [points],
  );
  if (points.length === 0) return null;

  return (
    <section className="my-4 flex flex-col gap-2 rounded-lg border border-border-subtle bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">难度-区分度诊断</h3>
        {suspectCount > 0 && (
          <Badge tone="warning" dot>疑题 {suspectCount} 道（高难度+低区分度）</Badge>
        )}
      </div>
      <PDScatter points={points} discBands={bands?.discrimination} />
      <p className="text-xs text-muted-foreground">
        每点一题：横轴难度系数 P（越低越难），纵轴区分度 D；点色按区分度档位着色，红圈为疑似问题题（P&lt;0.5 且 D&lt;0.3，可能出偏或超纲）。
      </p>
    </section>
  );
}