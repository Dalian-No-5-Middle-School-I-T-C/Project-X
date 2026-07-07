import { useEffect, useMemo, useState } from "react";
import type { ScoreTrendPoint } from "../../../../shared/types";
import { fetchJson } from "../auth/api";

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

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function buildPath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

export function AnalysisTrend({ exams, initialSubject, initialClassId }: Props) {
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

  useEffect(() => {
    if (initialSubject && subjects.includes(initialSubject)) setSubject(initialSubject);
    else if (!subject && subjects.length > 0) setSubject(subjects[0]);
    if (subject && subjects.length > 0 && !subjects.includes(subject)) setSubject(subjects[0]);
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
          setError(err instanceof Error ? err.message : "加载成绩变化曲线失败");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [subject, classId]);

  const chart = useMemo(() => {
    const width = 720;
    const height = 260;
    const left = 56;
    const right = 688;
    const top = 28;
    const bottom = 206;
    const values = trend.flatMap((point) => [
      point.gradeAvg,
      ...(point.classAvg != null ? [point.classAvg] : [])
    ]);
    const rawMin = values.length ? Math.min(...values) : 0;
    const rawMax = values.length ? Math.max(...values) : 100;
    const span = Math.max(rawMax - rawMin, 1);
    const min = Math.max(0, rawMin - span * 0.12);
    const max = rawMax + span * 0.12;
    const xFor = (index: number) => trend.length <= 1 ? (left + right) / 2 : left + (index / (trend.length - 1)) * (right - left);
    const yFor = (value: number) => bottom - ((value - min) / Math.max(max - min, 1)) * (bottom - top);
    const gradePoints = trend.map((point, index) => ({ x: xFor(index), y: yFor(point.gradeAvg), value: point.gradeAvg, label: point.examName }));
    const classPoints = trend
      .map((point, index) => point.classAvg == null ? null : ({ x: xFor(index), y: yFor(point.classAvg), value: point.classAvg, label: point.examName }))
      .filter((point): point is { x: number; y: number; value: number; label: string } => point !== null);
    const ticks = [max, min + (max - min) / 2, min].map(roundTick);
    return { width, height, left, right, top, bottom, gradePoints, classPoints, ticks, yFor };
  }, [trend]);

  if (subjects.length === 0) {
    return (
      <div className="analysis-section">
        <div className="panel-title">成绩变化曲线</div>
        <div className="empty-text">暂无带科目的考试数据。</div>
      </div>
    );
  }

  return (
    <div className="analysis-section">
      <div className="panel-title">成绩变化曲线</div>
      <div className="trend-panel">
        <div className="trend-controls">
          <label>
            <span>科目</span>
            <select value={subject} onChange={(event) => setSubject(event.target.value)}>
              {subjects.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            <span>班级</span>
            <select value={classId} onChange={(event) => setClassId(event.target.value)}>
              <option value="">年级整体</option>
              <option value="0">未知班级</option>
              {classes.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.grade_name ? `${item.grade_name} / ${item.name}` : item.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {busy && <div className="empty-text">正在加载成绩变化曲线...</div>}
        {error && !busy && <div className="empty-text">{error}</div>}
        {!busy && !error && trend.length === 0 && <div className="empty-text">当前科目暂无已阅卷成绩。</div>}
        {!busy && !error && trend.length > 0 && (
          <>
            <svg viewBox={`0 0 ${chart.width} ${chart.height}`} className="trend-chart" role="img" aria-label="成绩变化曲线">
              <line x1={chart.left} y1={chart.top} x2={chart.left} y2={chart.bottom} className="trend-axis" />
              <line x1={chart.left} y1={chart.bottom} x2={chart.right} y2={chart.bottom} className="trend-axis" />
              {chart.ticks.map((tick) => (
                <g key={tick}>
                  <line x1={chart.left} y1={chart.yFor(tick)} x2={chart.right} y2={chart.yFor(tick)} className="trend-grid-line" />
                  <text x={chart.left - 10} y={chart.yFor(tick) + 4} textAnchor="end" className="trend-axis-label">
                    {formatScore(tick)}
                  </text>
                </g>
              ))}
              {chart.gradePoints.length > 1 && <path d={buildPath(chart.gradePoints)} className="trend-line trend-line-grade" />}
              {chart.classPoints.length > 1 && <path d={buildPath(chart.classPoints)} className="trend-line trend-line-class" />}
              {chart.gradePoints.map((point) => (
                <g key={`grade-${point.label}`}>
                  <circle cx={point.x} cy={point.y} r={5} className="trend-dot trend-dot-grade" />
                  <text x={point.x} y={point.y - 10} textAnchor="middle" className="trend-point-label">
                    {formatScore(point.value)}
                  </text>
                </g>
              ))}
              {chart.classPoints.map((point) => (
                <g key={`class-${point.label}`}>
                  <circle cx={point.x} cy={point.y} r={5} className="trend-dot trend-dot-class" />
                  <text x={point.x} y={point.y + 18} textAnchor="middle" className="trend-point-label trend-point-label-class">
                    {formatScore(point.value)}
                  </text>
                </g>
              ))}
              {trend.map((point, index) => {
                const x = chart.gradePoints[index]?.x ?? chart.left;
                return (
                  <text key={point.examId} x={x} y={238} textAnchor="middle" className="trend-exam-label">
                    {point.examName.length > 8 ? `${point.examName.slice(0, 8)}...` : point.examName}
                  </text>
                );
              })}
            </svg>
            <div className="trend-legend">
              <span><i className="trend-legend-grade" />年级均分</span>
              {classId && <span><i className="trend-legend-class" />班级均分</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function roundTick(value: number): number {
  return Math.round(value * 10) / 10;
}
