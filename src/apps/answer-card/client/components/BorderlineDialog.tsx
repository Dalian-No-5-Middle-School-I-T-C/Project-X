import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Star } from "lucide-react";
import { fetchJson } from "../auth/api";
import { downloadCsv } from "../util/download";
import type { BorderlineLineKind, BorderlineResponse } from "../../../../shared/types";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";

interface ClassOption { id: number; name: string; grade_name?: string; }

const ALL_CLASSES = "__all__";

const LINE_KIND_LABELS: Record<BorderlineLineKind, string> = {
  pass: "及格线（阈值配置）",
  excellent: "优秀线（阈值配置）",
  percent: "总分百分比线",
  custom: "自定义绝对分线",
};

/**
 * 建议 4：临界生（踩线生）名单 —— 培优补差核心工具。
 * 阈值线三种来源：百分比线（复用阈值配置体系）/ 绝对分数线 / 自定义百分比线。
 */
export function BorderlineDialog({
  examId,
  examName,
  classes,
  onClose,
}: {
  examId: number;
  examName: string;
  classes: ClassOption[];
  onClose: () => void;
}) {
  const [lineKind, setLineKind] = useState<BorderlineLineKind>("pass");
  const [lineValue, setLineValue] = useState("60");
  const [margin, setMargin] = useState("");
  const [classId, setClassId] = useState("");
  const [data, setData] = useState<BorderlineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function query() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("lineKind", lineKind);
      if (lineKind === "custom" || lineKind === "percent") {
        if (lineValue.trim()) params.set("lineValue", lineValue);
      }
      if (margin.trim()) params.set("margin", margin);
      if (classId) params.set("classId", classId);
      setData(await fetchJson<BorderlineResponse>(`/api/analysis/exams/${examId}/borderline-students?${params.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void query(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [examId, lineKind, classId]);

  function exportCsv() {
    if (!data || data.items.length === 0) return;
    downloadCsv(
      `${examName}_临界生_${data.lineLabel}.csv`,
      ["名次", "姓名", "考号", "班级", "总分", "阈值线", "距线分差", "线上/线下"],
      data.items.map((r) => [r.rank, r.studentName, r.studentNumber, r.className, r.totalScore, r.line, r.distance, r.side === "above" ? "线上" : "线下"])
    );
  }

  const classGroups = (() => {
    const m = new Map<string, ClassOption[]>();
    for (const c of classes) {
      const g = c.grade_name || "无年级";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(c);
    }
    return Array.from(m.entries());
  })();

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>临界生名单（培优补差）</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="阈值线" htmlFor="bl-line-kind">
              <Select value={lineKind} onValueChange={(v) => setLineKind(v as BorderlineLineKind)}>
                <SelectTrigger id="bl-line-kind" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(LINE_KIND_LABELS) as BorderlineLineKind[]).map((k) => (
                    <SelectItem key={k} value={k}>{LINE_KIND_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {(lineKind === "custom" || lineKind === "percent") && (
              <Field label={lineKind === "percent" ? "百分比（如 60 = 满分的 60%）" : "分数线（绝对分）"} htmlFor="bl-line-value">
                <Input id="bl-line-value" type="number" className="w-28 tabular-nums" value={lineValue} onChange={(e) => setLineValue(e.target.value)} />
              </Field>
            )}
            <Field label="上下浮动（分，留空=线×5%）" htmlFor="bl-margin">
              <Input id="bl-margin" type="number" className="w-28 tabular-nums" value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="自动" />
            </Field>
            <Field label="班级" htmlFor="bl-class">
              <Select value={classId === "" ? ALL_CLASSES : classId} onValueChange={(v) => setClassId(v === ALL_CLASSES ? "" : v)}>
                <SelectTrigger id="bl-class" className="w-36">
                  <SelectValue placeholder="全部班级" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_CLASSES}>全部班级</SelectItem>
                  {classGroups.map(([grade, list]) => (
                    <SelectGroup key={grade}>
                      <SelectLabel>{grade}</SelectLabel>
                      {list.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button variant="primary" size="sm" onClick={() => void query()} loading={loading}>查询</Button>
          </div>

          {error && <p className="mt-3 text-sm text-destructive-fg">{error}</p>}

          {data && (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge tone="accent">{data.lineLabel}：{data.line} 分</Badge>
                <Badge tone="neutral">±{data.margin} 分区间</Badge>
                <Badge tone="neutral">命中 {data.items.length} 人</Badge>
                <span>按距线分差升序</span>
              </div>
              <div className="mt-3 max-h-105 overflow-y-auto rounded-lg border border-border-subtle">
                <TableWrap>
                  <Table className="text-sm">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead numeric>名次</TableHead>
                        <TableHead>姓名</TableHead>
                        <TableHead>考号</TableHead>
                        <TableHead>班级</TableHead>
                        <TableHead numeric>总分</TableHead>
                        <TableHead numeric>距线</TableHead>
                        <TableHead>状态</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.items.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">该区间内暂无学生</TableCell>
                        </TableRow>
                      ) : data.items.map((r) => (
                        <TableRow key={`${r.studentId}-${r.side}`}>
                          <TableCell numeric className="tabular-nums">{r.rank}</TableCell>
                          <TableCell className="font-medium text-foreground">{r.studentName}</TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">{r.studentNumber}</TableCell>
                          <TableCell className="text-muted-foreground">{r.className}</TableCell>
                          <TableCell numeric className="font-semibold tabular-nums">{r.totalScore}</TableCell>
                          <TableCell numeric className="tabular-nums">
                            <span className={r.side === "above" ? "text-success-foreground" : "text-warning-foreground"}>
                              {r.side === "above" ? "+" : "−"}{r.distance}
                            </span>
                          </TableCell>
                          <TableCell>
                            {r.side === "above"
                              ? (lineKind === "excellent" ? <Badge tone="accent"><Star className="size-3" aria-hidden />线上</Badge> : <Badge tone="success"><CheckCircle2 className="size-3" aria-hidden />线上</Badge>)
                              : <Badge tone="warning"><AlertTriangle className="size-3" aria-hidden />线下</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableWrap>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <span className="mr-auto text-xs text-muted-foreground">线下学生是补差重点，线上学生是培优重点</span>
          <Button variant="outline" size="sm" icon={<Download />} onClick={exportCsv} disabled={!data || data.items.length === 0}>导出 CSV</Button>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
