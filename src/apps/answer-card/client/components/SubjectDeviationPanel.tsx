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
 * 数据源：GET /api/analysis/subject-deviation/exam-options（每科最近一场）→ POST /api/analysis/subject-deviation。
 */
export function SubjectDeviationPanel({ examId, subject, classId }: { examId: number; subject: string | null; classId: string; }) {
  const [examOptions, setExamOptions] = useState<ScoreTrendPoint[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [data, setData] = useState<SubjectDeviationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 偏科判定需要多个学科的成绩，故取「每科最近一场」的跨科考试集合。
  // 不能复用按单科过滤的 /trends：单科集合会让相对个人基线的算法永远无法成立。
  // 必须带 examId（锚点年级）与 classId 作用域，否则他年级更新的考试会顶掉本班候选（评审 P2）。
  // 切换考试 / 班级时先清空候选、勾选与旧结果再发请求：否则空窗期会用上一轮（可能属于他班）
  // 的 examIds 配新的 classId 提交，产出无效队列比较或静默空结果（评审 P2）。
  useEffect(() => {
    const controller = new AbortController();
    setOptionsLoading(true);
    setExamOptions([]);
    setSelectedIds([]);
    setData(null);
    const params = new URLSearchParams({ perSubject: "1", examId: String(examId) });
    if (classId) params.set("classId", classId);
    fetchJson<ScoreTrendPoint[]>(`/api/analysis/subject-deviation/exam-options?${params.toString()}`, { signal: controller.signal })
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setExamOptions(list);
        setSelectedIds(list.map((r) => r.examId));
      })
      .catch(() => { if (!controller.signal.aborted) setExamOptions([]); })
      .finally(() => { if (!controller.signal.aborted) setOptionsLoading(false); });
    return () => controller.abort();
  }, [examId, classId]);

  const hasCurrentInOptions = examOptions.some((r) => r.examId === examId);
  // 手动加入的本场考试不在候选接口结果里，需补一条可勾选条目——否则它只进 selectedIds、
  // 界面上既看不见也无法取消，却持续参与提交（评审 P2）。
  const manualCurrentOption = useMemo<ScoreTrendPoint>(
    () => ({ examId, examName: "本场考试", subject: subject ?? "", examTime: "", gradeAvg: 0, gradeCount: 0 }),
    [examId, subject],
  );
  const renderOptions = useMemo(
    () => (!hasCurrentInOptions && selectedIds.includes(examId) ? [...examOptions, manualCurrentOption] : examOptions),
    [examOptions, hasCurrentInOptions, selectedIds, examId, manualCurrentOption],
  );

  const includeCurrent = hasCurrentInOptions || selectedIds.includes(examId);

  // 勾选覆盖的学科数 < 2 时相对落差恒为 0，此时不展示结果而是提示补充科目
  const selectedSubjects = useMemo(
    () => new Set(renderOptions.filter((r) => selectedIds.includes(r.examId)).map((r) => r.subject)),
    [renderOptions, selectedIds],
  );
  const crossSubjectReady = selectedSubjects.size >= 2;

  function toggleExam(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function analyze() {
    if (optionsLoading) return; // 候选仍在重载：此时提交会拿旧 examIds 配新 classId（评审 P2）
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
          偏科预警
        </h3>
        {!includeCurrent && !optionsLoading && (
          <Button variant="ghost" size="sm" onClick={() => toggleExam(examId)}>+ 加入本场考试</Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        先算各科年级 Z =（个人分 − 年级均分）/ 年级标准差，再与本人跨科平均 Z 比较，相对落差 &lt; -{data?.threshold ?? 0.8} 触发预警。
        已按学科各取最近一场考试（共 {new Set(examOptions.map((r) => r.subject)).size} 个学科 / {examOptions.length} 场）：
      </p>
      <div className="flex flex-wrap gap-2">
        {renderOptions.map((r) => {
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
              <span className="text-muted-foreground">{r.subject}</span>
              · {r.examName}{isCurrent ? "（本场）" : ""}
            </label>
          );
        })}
        {optionsLoading && <span className="text-xs text-muted-foreground">正在按本场考试的年级 / 班级重载候选…</span>}
        {!optionsLoading && renderOptions.length === 0 && <span className="text-xs text-muted-foreground">暂无含成绩的历史考试</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          icon={<BrainCircuit />}
          onClick={() => void analyze()}
          loading={loading}
          disabled={optionsLoading || selectedIds.length === 0 || !crossSubjectReady}
        >
          分析偏科
        </Button>
        {crossSubjectReady ? null : (
          <span className="text-xs text-muted-foreground">
            偏科需要至少 2 个学科的成绩，当前仅 {selectedSubjects.size} 个——请勾选其他学科的考试，或先在「+ 加入本场考试」中并入本场。
          </span>
        )}
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
                    <TableHead numeric>相对落差</TableHead>
                    <TableHead>各科相对 Z（年级 Z）</TableHead>
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
                              title={`${s.subject}：${s.score} 分（年级均分 ${s.gradeAvg}，年级 Z ${s.z.toFixed(2)}，个人基线 ${item.ownMeanZ.toFixed(2)}）`}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs tabular-nums",
                                s.relativeZ < -(data?.threshold ?? 0.8)
                                  ? "border-destructive-border bg-destructive-soft text-destructive-fg"
                                  : s.relativeZ > (data?.threshold ?? 0.8)
                                    ? "border-success-border bg-success-soft text-success-foreground"
                                    : "border-border bg-card text-muted-foreground",
                              )}
                            >
                              {s.subject} {s.relativeZ.toFixed(2)}
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
