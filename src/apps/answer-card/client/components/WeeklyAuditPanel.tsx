import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, CalendarDays, ClipboardList } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { WeeklyAuditResponse, WeeklyAuditSummary } from "../../../../shared/types";
import { cn } from "../lib/utils";
import { AnalysisAiPanel } from "./AnalysisAiPanel";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  StatCard,
  StatCardRow,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";

interface Props {
  /** 打开某周的完整周报（考试组分析页） */
  onOpenAnalysisGroup: (groupId: number) => void;
}

function scoreRateTone(rate: number): string {
  if (rate < 50) return "text-destructive-fg";
  if (rate < 70) return "text-warning-foreground";
  return "text-success-foreground";
}

/**
 * 首页「每周考试审计」板块：
 * 周切换（近 5 周）+ 年级切换（多年级时显示）+ 统计摘要 + 班级对比 + 薄弱题 Top 5
 * + 查看完整周报 / AI 教学建议（复用 AnalysisAiPanel 的 groupId 模式）。
 */
export function WeeklyAuditPanel({ onOpenAnalysisGroup }: Props) {
  const [data, setData] = useState<WeeklyAuditResponse | null>(null);
  const [selectedWeek, setSelectedWeek] = useState("");
  const [selectedGradeId, setSelectedGradeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAi, setShowAi] = useState(false);

  const load = useCallback(async (week?: string, gradeId?: number | null) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (week) params.set("week", week);
      if (gradeId != null && gradeId > 0) params.set("gradeId", String(gradeId));
      const query = params.toString();
      const res = await fetchJson<WeeklyAuditResponse>(
        `/api/weekly-audit/summary${query ? `?${query}` : ""}`,
      );
      setData(res);
      // 显式请求了某周（历史周）而该周无已发布报告（active=null）时，保留用户所选周，
      // 让 selectedWeekOpt 命中该周选项以正确展示「顺延/无晨测」状态，避免跳回本周。
      setSelectedWeek(week ?? res.active?.weekStart ?? res.weeks[0]?.weekStart ?? "");
      setSelectedGradeId(res.active?.gradeId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function handleWeekChange(weekStart: string) {
    if (weekStart === selectedWeek) return;
    setShowAi(false);
    void load(weekStart, selectedGradeId);
  }

  function handleGradeChange(gradeId: number) {
    if (gradeId === selectedGradeId) return;
    setShowAi(false);
    void load(selectedWeek, gradeId);
  }

  const active = data?.active ?? null;
  const selectedWeekOpt = data?.weeks.find((w) => w.weekStart === selectedWeek) ?? null;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="size-5 text-primary" />
          <CardTitle className="text-base">每周考试审计</CardTitle>
          {active && (
            <Badge tone="accent">
              {active.weekLabel}
              {active.gradeName ? ` · ${active.gradeName}` : ""}
            </Badge>
          )}
          {active && <Badge tone="success">已发布</Badge>}
        </div>
        {data && data.weeks.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {data.weeks.map((week) => (
              <button
                key={week.weekStart}
                type="button"
                onClick={() => handleWeekChange(week.weekStart)}
                className={cn(
                  "flex items-baseline gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                  week.weekStart === selectedWeek
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border-subtle bg-card text-secondary-foreground hover:border-border hover:text-foreground",
                )}
              >
                <span className="font-medium">{week.label}</span>
                <span className={cn("tabular-nums", week.weekStart === selectedWeek ? "opacity-80" : "opacity-60")}>
                  {week.rangeLabel}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <CardContent className="flex flex-col gap-4 p-5">
        {loading && !data ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-40" />
          </div>
        ) : error ? (
          <ErrorState
            size="sm"
            description={error}
            onRetry={() => void load(selectedWeek, selectedGradeId)}
            retrying={loading}
          />
        ) : !active ? (
          selectedWeekOpt && !selectedWeekOpt.published ? (
            <EmptyState
              size="sm"
              title="本周期报告尚未发布"
              description={
                selectedWeekOpt.pendingExamNames.length > 0
                  ? `以下考试尚未完成，报告将顺延至全部完成后发布：${selectedWeekOpt.pendingExamNames.join("、")}`
                  : `报告于每周六上午 8:00 发布（${selectedWeekOpt.publishAtLabel}），发布后会自动出现在这里。`
              }
            />
          ) : (
            <EmptyState
              size="sm"
              title="该周暂无晨测记录"
              description="该周没有已发布的晨测报告（模式为「晨测」的考试）。"
            />
          )
        ) : (
          <>
            {data && data.grades.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {data.grades.map((grade) => (
                  <button
                    key={grade.gradeId}
                    type="button"
                    onClick={() => handleGradeChange(grade.gradeId)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs transition-colors",
                      grade.gradeId === selectedGradeId
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border-subtle bg-card text-secondary-foreground hover:border-border hover:text-foreground",
                    )}
                  >
                    {grade.gradeName}
                  </button>
                ))}
              </div>
            )}

            <StatCardRow>
              <StatCard
                label="晨测场次"
                value={active.examCount}
                suffix="场"
                delta={active.vsLastWeek?.examCountChange ?? null}
                deltaLabel="较上周"
              />
              <StatCard
                label="参评人数"
                value={active.participantCount}
                suffix="人"
                delta={active.vsLastWeek?.participantChange ?? null}
                deltaLabel="较上周"
              />
              <StatCard
                label="平均得分率"
                value={active.avgScoreRate}
                suffix="%"
                delta={active.vsLastWeek?.avgScoreRateChange ?? null}
                deltaLabel="较上周"
              />
              <StatCard
                label="覆盖天数"
                value={active.coverageDays}
                suffix={`/ ${active.coverageTargetDays} 天`}
                hint={`出勤 ${active.attendedCount} 人次 · 全勤 ${active.fullAttendanceCount} 人`}
              />
            </StatCardRow>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="min-w-0 rounded-lg border border-border-subtle bg-card">
                <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                  <h3 className="text-sm font-semibold text-foreground">班级对比</h3>
                  <span className="text-xs text-muted-foreground">按平均得分率排序</span>
                </div>
                {active.classSummaries.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">暂无班级数据</p>
                ) : (
                  <TableWrap>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>班级</TableHead>
                          <TableHead className="text-right">平均得分率</TableHead>
                          <TableHead className="text-right">参评</TableHead>
                          <TableHead className="text-right">缺考</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {active.classSummaries.map((cls) => (
                          <TableRow key={cls.classId ?? "unknown"}>
                            <TableCell className="font-medium">{cls.className}</TableCell>
                            <TableCell className={cn("text-right tabular-nums", scoreRateTone(cls.avgScoreRate))}>
                              {cls.avgScoreRate}%
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{cls.count} 人</TableCell>
                            <TableCell className="text-right tabular-nums">{cls.absentCount} 人次</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableWrap>
                )}
              </section>

              <section className="min-w-0 rounded-lg border border-border-subtle bg-card">
                <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                  <h3 className="text-sm font-semibold text-foreground">薄弱题目 Top 5</h3>
                  <span className="text-xs text-muted-foreground">按得分率最低排序</span>
                </div>
                {active.weakPoints.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">暂无逐题数据（该周考试未配置题目得分）</p>
                ) : (
                  <ul className="flex flex-col">
                    {active.weakPoints.map((point, index) => (
                      <li
                        key={`${point.examId}-${point.questionNumber}`}
                        className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5 last:border-b-0"
                      >
                        <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                        <Badge tone="neutral" className="shrink-0">
                          {point.subject} 第{point.questionNumber}题
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-sm text-secondary-foreground" title={point.knowledgePoint ?? point.examName}>
                          {point.knowledgePoint ?? point.examName}
                        </span>
                        <span className={cn("shrink-0 text-sm tabular-nums", scoreRateTone(point.scoreRate))}>
                          {point.scoreRate}%
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<ClipboardList className="size-4" />}
                onClick={() => active.groupId != null && onOpenAnalysisGroup(active.groupId)}
                disabled={active.groupId == null}
              >
                查看完整周报
              </Button>
              <Button
                variant="outline"
                size="sm"
                icon={<BrainCircuit className="size-4" />}
                onClick={() => setShowAi((v) => !v)}
                disabled={active.groupId == null}
              >
                AI 教学建议
              </Button>
            </div>

            {showAi && active.groupId != null && (
              <AnalysisAiPanel groupId={active.groupId} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
