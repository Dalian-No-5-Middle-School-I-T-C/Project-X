import { useCallback, useEffect, useMemo, useState } from "react";
import { LineChart } from "lucide-react";
import type { ScoreTrendPoint } from "../../../../shared/types";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import { formatScore } from "../util/format";
import {
  EmptyState,
  ErrorState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "./ui/v2";

/**
 * 成绩变化曲线（手绘 SVG 折线图）。
 *
 * 迁移说明：保留原取数逻辑与 SVG 绘制，`trend-*` 旧工具类换成 Tailwind 语义类，
 * 年级线用 `chart-1`、班级线用 `chart-3`（数据系列色，来自 theme.ts 令牌），
 * 加载/失败/空三态改用 v2 `Skeleton`/`ErrorState`/`EmptyState`。
 */

interface ClassOption {
  id: number;
  name: string;
  grade_name?: string;
}

interface Props {
  exams: Array<{ subject?: string | null }>;
  initialSubject?: string;
  initialClassId?: string;
}

/** 班级下拉里「年级整体」的哨兵值（Radix Select 不接受空字符串 value） */
const ALL_CLASSES = "__all__";

function buildPath(points: Array<{ x: number; y: number }>): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function roundTick(value: number): number {
  return Math.round(value * 10) / 10;
}

export function AnalysisTrend({
  exams,
  initialSubject,
  initialClassId,
}: Props) {
  const subjects = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const exam of exams) {
      const subject = exam.subject?.trim();
      if (subject && !seen.has(subject)) {
        seen.add(subject);
        result.push(subject);
      }
    }
    return result;
  }, [exams]);

  const [subject, setSubject] = useState(initialSubject || "");
  const [classId, setClassId] = useState(initialClassId || "");
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [trend, setTrend] = useState<ScoreTrendPoint[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (initialSubject && subjects.includes(initialSubject))
      setSubject(initialSubject);
    else if (!subject && subjects.length > 0) setSubject(subjects[0]);
    if (subject && subjects.length > 0 && !subjects.includes(subject))
      setSubject(subjects[0]);
  }, [initialSubject, subject, subjects]);

  useEffect(() => {
    if (initialClassId !== undefined) setClassId(initialClassId);
  }, [initialClassId]);

  useEffect(() => {
    fetchJson<ClassOption[]>("/api/classes")
      .then(setClasses)
      .catch(() => setClasses([]));
  }, []);

  useEffect(() => {
    if (!subject) {
      setTrend([]);
      return;
    }

    let cancelled = false;
    setBusy(true);
    setError("");
    const params = new URLSearchParams({ subject });
    if (classId) params.set("classId", classId);
    fetchJson<ScoreTrendPoint[]>(`/api/analysis/trends?${params.toString()}`)
      .then((data) => {
        if (!cancelled) setTrend(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setTrend([]);
          setError(
            err instanceof Error ? err.message : "加载成绩变化曲线失败",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [subject, classId, reloadKey]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  const chart = useMemo(() => {
    const width = 720;
    const height = 260;
    const left = 56;
    const right = 688;
    const top = 28;
    const bottom = 206;
    const values = trend.flatMap((point) => [
      point.gradeAvg,
      ...(point.classAvg != null ? [point.classAvg] : []),
    ]);
    const rawMin = values.length ? Math.min(...values) : 0;
    const rawMax = values.length ? Math.max(...values) : 100;
    const span = Math.max(rawMax - rawMin, 1);
    const min = Math.max(0, rawMin - span * 0.12);
    const max = rawMax + span * 0.12;
    const xFor = (index: number) =>
      trend.length <= 1
        ? (left + right) / 2
        : left + (index / (trend.length - 1)) * (right - left);
    const yFor = (value: number) =>
      bottom - ((value - min) / Math.max(max - min, 1)) * (bottom - top);
    const gradePoints = trend.map((point, index) => ({
      x: xFor(index),
      y: yFor(point.gradeAvg),
      value: point.gradeAvg,
      label: point.examName,
    }));
    const classPoints = trend
      .map((point, index) =>
        point.classAvg == null
          ? null
          : {
              x: xFor(index),
              y: yFor(point.classAvg),
              value: point.classAvg,
              label: point.examName,
            },
      )
      .filter(
        (
          point,
        ): point is { x: number; y: number; value: number; label: string } =>
          point !== null,
      );
    const ticks = [max, min + (max - min) / 2, min].map(roundTick);
    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      gradePoints,
      classPoints,
      ticks,
      yFor,
    };
  }, [trend]);

  if (subjects.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-base font-semibold text-foreground">
          成绩变化曲线
        </h3>
        <div className="rounded-lg border border-border-subtle bg-card">
          <EmptyState
            size="sm"
            icon={<LineChart />}
            title="暂无带科目的考试数据"
            description="给考试补充科目后，这里会展示历次考试的均分走势。"
          />
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="m-0 text-base font-semibold text-foreground">
        成绩变化曲线
      </h3>
      <div className="flex flex-col rounded-lg border border-border-subtle bg-card p-4">
        <div className="mb-3 flex flex-wrap gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">科目</span>
            <Select value={subject} onValueChange={setSubject}>
              <SelectTrigger className="h-control-sm w-40 text-sm">
                <SelectValue placeholder="选择科目" />
              </SelectTrigger>
              <SelectContent>
                {subjects.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">班级</span>
            <Select
              value={classId === "" ? ALL_CLASSES : classId}
              onValueChange={(value) =>
                setClassId(value === ALL_CLASSES ? "" : value)
              }
            >
              <SelectTrigger className="h-control-sm w-48 text-sm">
                <SelectValue placeholder="年级整体" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CLASSES}>年级整体</SelectItem>
                <SelectItem value="0">未知班级</SelectItem>
                {classes.map((item) => (
                  <SelectItem key={item.id} value={String(item.id)}>
                    {item.grade_name
                      ? `${item.grade_name} / ${item.name}`
                      : item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        {busy && (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-[260px] w-full" />
            <Skeleton className="h-4 w-40" />
          </div>
        )}

        {!busy && error && (
          <ErrorState
            size="sm"
            title="加载成绩变化曲线失败"
            description={error}
            onRetry={retry}
          />
        )}

        {!busy && !error && trend.length === 0 && (
          <EmptyState
            size="sm"
            icon={<LineChart />}
            title="当前科目暂无已阅卷成绩"
            description="完成阅卷并发布成绩后，这里会显示历次均分走势。"
          />
        )}

        {!busy && !error && trend.length > 0 && (
          <>
            <svg
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              className="block h-auto w-full max-w-[760px]"
              role="img"
              aria-label="成绩变化曲线"
            >
              <line
                x1={chart.left}
                y1={chart.top}
                x2={chart.left}
                y2={chart.bottom}
                className="stroke-border-strong"
                strokeWidth={1.6}
              />
              <line
                x1={chart.left}
                y1={chart.bottom}
                x2={chart.right}
                y2={chart.bottom}
                className="stroke-border-strong"
                strokeWidth={1.6}
              />
              {chart.ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={chart.left}
                    y1={chart.yFor(tick)}
                    x2={chart.right}
                    y2={chart.yFor(tick)}
                    className="stroke-border-subtle"
                    strokeWidth={1}
                  />
                  <text
                    x={chart.left - 10}
                    y={chart.yFor(tick) + 4}
                    textAnchor="end"
                    className="fill-muted-foreground text-xs tabular-nums"
                  >
                    {formatScore(tick)}
                  </text>
                </g>
              ))}
              {chart.gradePoints.length > 1 && (
                <path
                  d={buildPath(chart.gradePoints)}
                  className="fill-none stroke-chart-1"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {chart.classPoints.length > 1 && (
                <path
                  d={buildPath(chart.classPoints)}
                  className="fill-none stroke-chart-3"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {chart.gradePoints.map((point) => (
                <g key={`grade-${point.label}`}>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={5}
                    className="fill-chart-1 stroke-card"
                    strokeWidth={2}
                  />
                  <text
                    x={point.x + 10}
                    y={point.y - 8}
                    textAnchor="start"
                    className="fill-chart-1 text-xs font-bold tabular-nums"
                  >
                    {formatScore(point.value)}
                  </text>
                </g>
              ))}
              {chart.classPoints.map((point) => (
                <g key={`class-${point.label}`}>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={5}
                    className="fill-chart-3 stroke-card"
                    strokeWidth={2}
                  />
                  <text
                    x={point.x + 10}
                    y={point.y + 18}
                    textAnchor="start"
                    className="fill-chart-3 text-xs font-bold tabular-nums"
                  >
                    {formatScore(point.value)}
                  </text>
                </g>
              ))}
              {trend.map((point, index) => {
                const x = chart.gradePoints[index]?.x ?? chart.left;
                return (
                  <text
                    key={point.examId}
                    x={x}
                    y={238}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {point.examName.length > 8
                      ? `${point.examName.slice(0, 8)}...`
                      : point.examName}
                  </text>
                );
              })}
            </svg>
            <div
              className={cn(
                "mt-2 flex items-center gap-4 text-xs text-muted-foreground",
              )}
            >
              <span className="inline-flex items-center gap-1.5">
                <i className="inline-block h-[3px] w-4.5 rounded-full bg-chart-1" />
                年级均分
              </span>
              {classId && (
                <span className="inline-flex items-center gap-1.5">
                  <i className="inline-block h-[3px] w-4.5 rounded-full bg-chart-3" />
                  班级均分
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
