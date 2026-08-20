import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BrainCircuit } from "lucide-react";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import type { ScoreTrendPoint, SubjectDeviationItem, SubjectDeviationResponse } from "../../../../shared/types";
import {
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";

/**
 * 建议 7：偏科预警 —— 跨科 Z 分识别「单科显著低于本人整体水平」的学生。
 * 数据源：POST /api/analysis/subject-deviation（examIds 来自同学科趋势端点自动选取）。
 */
export function SubjectDeviationPanel({ examId, subject, classId }: { examId: number; subject: string | null; classId: string; }) {
  const [examOptions, setExamOptions] = useState<ScoreTrendPoint[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [data, setData] = useState<SubjectDeviationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 默认选取同学科最近的 8 场考试（跨科比较需要多场考试）
  useEffect(() => {
    if (!subject) return;
    fetchJson<ScoreTrendPoint[]>(`/api/analysis/trends?subject=${encodeURIComponent(subject)}`)
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setExamOptions(list);
        setSelectedIds(list.slice(-8).map((r) => r.examId));
      })
      .catch(() => setExamOptions([]));
  }, [subject]);

  const includeCurrent = useMemo(() => {
    if (selectedIds.includes(examId)) return true;
    if (examOptions.some((r) => r.examId === examId)) return true; // 已在列表里
    return false;
  }, [selectedIds, examOptions, examId]);

  function toggleExam(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function analyze() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (classId) params.set("classId", classId);
      setData(await fetchJson<SubjectDeviationResponse>("/api/analysis/subject-deviation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examIds: selectedIds, classId: classId ? Number(classId) : undefined, threshold: 0.8 }),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "分析失败");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  if (!subject) {
    return <EmptyState size="sm" title="无学科信息" description="该考试未关联学科，无法做跨科偏科分析。" />;
  }

  const flaggedCount = data?.items.filter((i) => i.flagged).length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          偏科预警（跨科 Z 分，Z &lt; −0.8 预警）
        </h3>
        {!includeCurrent && (
          <Button variant="ghost" size="sm" onClick={() => toggleExam(examId)}>+ 加入本场考试</Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Z = (个人分 − 年级均分) / 年级标准差；同一学生跨科比较，单科显著低于本人整体水平即预警。已自动选取同学科最近 {examOptions.length > 0 ? Math.min(8, examOptions.length) : 0} 场：
      </p>
      <div className="flex flex-wrap gap-2">
        {examOptions.map((r) => {
          const active = selectedIds.includes(r.examId);
          const isCurrent = r.examId === examId;
          return (
            <label
              key={r.examId}
              className={cn(
                "inline-flex h-control-sm cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
                active
                  ? "border-accent-border bg-accent font-semibold text-accent-foreground"
                  : "border-border bg-card text-secondary-foreground hover:bg-secondary",
              )}
            >
              <input
                type="checkbox"
                className="accent-(--color-primary)"
                checked={active}
                onChange={() => toggleExam(r.examId)}
              />
              {r.examName}{isCurrent ? "（本场）" : ""}
            </label>
          );
        })}
        {examOptions.length === 0 && <span className="text-xs text-muted-foreground">暂无同学科历史考试</span>}
      </div>
      <div>
        <Button variant="primary" size="sm" icon={<BrainCircuit />} onClick={() => void analyze()} loading={loading} disabled={selectedIds.length === 0}>
          分析偏科
        </Button>
      </div>

      {error && <p className="text-sm text-destructive-fg">{error}</p>}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge tone="warning"><AlertTriangle className="size-3" aria-hidden />预警 {flaggedCount} 人</Badge>
            <Badge tone="neutral">参与 {data.items.length} 人</Badge>
            <Badge tone="neutral">科目 {data.examIds.length} 场</Badge>
          </div>
          {data.items.length === 0 ? (
            <EmptyState size="sm" title="暂无数据" description="所选考试没有成绩记录。" />
          ) : (
            <TableWrap>
              <Table className="text-sm">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>姓名</TableHead>
                    <TableHead>考号</TableHead>
                    <TableHead>班级</TableHead>
                    <TableHead>最弱科目</TableHead>
                    <TableHead numeric>最低 Z</TableHead>
                    <TableHead>各科 Z 分</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((item: SubjectDeviationItem) => (
                    <TableRow key={item.studentId} selected={item.flagged}>
                      <TableCell className="font-medium text-foreground">{item.studentName}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{item.studentNumber}</TableCell>
                      <TableCell className="text-muted-foreground">{item.className}</TableCell>
                      <TableCell>
                        {item.flagged ? (
                          <Badge tone="warning">{item.lowestSubject}</Badge>
                        ) : (
                          <span className="text-muted-foreground">{item.lowestSubject}</span>
                        )}
                      </TableCell>
                      <TableCell numeric className={cn("font-semibold tabular-nums", item.flagged ? "text-warning-foreground" : "text-muted-foreground")}>
                        {item.lowestZ.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {item.subjects.map((s) => (
                            <span
                              key={s.examId}
                              title={`${s.subject}：${s.score} 分（年级均分 ${s.gradeAvg}）`}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs tabular-nums",
                                s.z < -0.8
                                  ? "border-destructive-border bg-destructive-soft text-destructive-fg"
                                  : s.z > 0.8
                                    ? "border-success-border bg-success-soft text-success-foreground"
                                    : "border-border bg-card text-muted-foreground",
                              )}
                            >
                              {s.subject} {s.z.toFixed(2)}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          )}
        </>
      )}
    </div>
  );
}
