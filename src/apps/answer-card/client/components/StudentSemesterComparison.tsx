import { useCallback, useEffect, useState } from "react";
import { CalendarRange, TrendingDown, TrendingUp } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { StudentSemesterComparison as SemesterComparison } from "../../../../shared/types";
import { cn } from "../lib/utils";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";

/**
 * 学科 → 数据色板工具类（`--px-chart-N`，经 @theme 注册为 `bg-chart-N` / `border-chart-N`）。
 * chart-1 品牌红按 DESIGN-SYSTEM §3.2 保留给「当前主体」，学科系列从 2 起取；
 * 用类名查表而非内联 style，做到零内联样式 + 零十六进制（铁律 §3/§4）。
 */
const SUBJECT_DOT_CLASS: Record<string, string> = {
  "语文": "bg-chart-2", "数学": "bg-chart-3", "英语": "bg-chart-4",
  "物理": "bg-chart-5", "化学": "bg-chart-6", "生物": "bg-chart-7",
  "历史": "bg-chart-8", "地理": "bg-chart-2", "政治": "bg-chart-5",
};
const FALLBACK_DOT_CLASS = "bg-chart-8";

const SUBJECT_BORDER_CLASS: Record<string, string> = {
  "语文": "border-chart-2", "数学": "border-chart-3", "英语": "border-chart-4",
  "物理": "border-chart-5", "化学": "border-chart-6", "生物": "border-chart-7",
  "历史": "border-chart-8", "地理": "border-chart-2", "政治": "border-chart-5",
};
const FALLBACK_BORDER_CLASS = "border-chart-8";

/** 学期概览统计块：大数值 + 指标名，语气色（好/差）走语义令牌类 */
function SemesterStat({
  value,
  label,
  tone = "neutral",
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <div
      className={cn(
        "flex min-w-[100px] flex-1 flex-col gap-0.5 rounded-lg border px-4 py-3",
        tone === "neutral" && "border-border-subtle bg-card",
        tone === "good" && "border-success-border bg-success-soft",
        tone === "bad" && "border-destructive-border bg-destructive-soft",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1 text-2xl font-semibold tabular-nums",
          tone === "neutral" && "text-foreground",
          tone === "good" && "text-success-foreground",
          tone === "bad" && "text-destructive-fg",
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function StudentSemesterComparison() {
  const [data, setData] = useState<SemesterComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchJson<SemesterComparison>("/api/scores/me/semester-comparison");
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载学期对比失败");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
        正在加载学期对比...
      </div>
    );
  }

  if (error) {
    return <ErrorState description={error} onRetry={() => void load()} size="sm" />;
  }

  if (!data?.current) {
    return (
      <EmptyState
        icon={<CalendarRange />}
        title="暂无学期数据"
        description="参加更多考试后，可在此查看本学期与上学期的成绩对比。"
      />
    );
  }

  const { current, previous, avgScoreChange, improvedSubjects, declinedSubjects } = data;

  return (
    <Card>
      <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><CalendarRange size={17} /> 学期对比</span></CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <SemesterStat value={current.label} label="当前学期" tone="good" />
          <SemesterStat value={current.examCount} label="考试场次" />
          <SemesterStat value={current.avgScore} label="学期均分" />
          {avgScoreChange != null && (
            <SemesterStat
              tone={avgScoreChange >= 0 ? "good" : "bad"}
              label="较上学期均分"
              value={
                <>
                  {avgScoreChange >= 0 ? <TrendingUp className="size-5" /> : <TrendingDown className="size-5" />}
                  {avgScoreChange >= 0 ? "+" : ""}{avgScoreChange}
                </>
              }
            />
          )}
        </div>

        {previous && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-border-subtle bg-secondary px-3.5 py-2.5 text-sm">
            <span className="text-muted-foreground">
              对比上学期（{previous.label}，<span className="tabular-nums">{previous.startDate}</span> ~ <span className="tabular-nums">{previous.endDate}</span>）：
            </span>
            <span className="text-foreground">
              上学期均分 <span className="tabular-nums">{previous.avgScore}</span> · <span className="tabular-nums">{previous.examCount}</span> 场考试
            </span>
          </div>
        )}

        {(improvedSubjects.length > 0 || declinedSubjects.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {improvedSubjects.map((subject) => (
              <Badge
                key={`up-${subject}`}
                tone="success"
                icon={<TrendingUp />}
                className={cn("rounded-full", SUBJECT_BORDER_CLASS[subject] ?? FALLBACK_BORDER_CLASS)}
              >
                {subject} 进步
              </Badge>
            ))}
            {declinedSubjects.map((subject) => (
              <Badge
                key={`down-${subject}`}
                tone="danger"
                icon={<TrendingDown />}
                className={cn("rounded-full", SUBJECT_BORDER_CLASS[subject] ?? FALLBACK_BORDER_CLASS)}
              >
                {subject} 待加强
              </Badge>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="text-base font-semibold text-foreground">本学期各学科</div>
          <TableWrap>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>学科</TableHead>
                  <TableHead numeric>考试次数</TableHead>
                  <TableHead numeric>平均分</TableHead>
                  <TableHead numeric>最高分</TableHead>
                  {previous && <TableHead numeric>上学期均分</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {current.subjects.map((subject) => {
                  const prevSubject = previous?.subjects.find((item) => item.subject === subject.subject);
                  const delta = prevSubject ? Math.round((subject.avgScore - prevSubject.avgScore) * 10) / 10 : null;
                  return (
                    <TableRow key={subject.subject}>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className={cn(
                              "inline-block size-2 shrink-0 rounded-full",
                              SUBJECT_DOT_CLASS[subject.subject] ?? FALLBACK_DOT_CLASS,
                            )}
                            aria-hidden
                          />
                          {subject.subject}
                        </span>
                      </TableCell>
                      <TableCell numeric>{subject.examCount}</TableCell>
                      <TableCell numeric>{subject.avgScore}</TableCell>
                      <TableCell numeric>{subject.bestScore}</TableCell>
                      {previous && (
                        <TableCell
                          numeric
                          className={cn(
                            delta == null
                              ? "text-muted-foreground"
                              : delta >= 0
                                ? "text-success-foreground"
                                : "text-destructive-fg",
                          )}
                        >
                          {prevSubject ? (
                            <>
                              {prevSubject.avgScore}
                              {delta != null && (
                                <span className="ml-2 text-xs">
                                  ({delta >= 0 ? "+" : ""}{delta})
                                </span>
                              )}
                            </>
                          ) : "—"}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableWrap>
        </div>
      </CardContent>
    </Card>
  );
}
