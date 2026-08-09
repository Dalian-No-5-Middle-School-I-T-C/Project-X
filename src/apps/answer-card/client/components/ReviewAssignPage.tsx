// ReviewAssignPage —— 阅卷任务分配（T5 v2 迁移）
// 视觉层整体切换到 v2：Field / Select / Input / Button / Table / Badge / EmptyState。
// 功能守恒：
//  · GET    /api/review/exams/:examId/blocks
//  · GET    /api/review-assign/exams/:examId/eligible-teachers
//  · GET    /api/review-assign/exams/:examId/blocks/:blockId
//  · POST   /api/review-assign/exams/:examId/blocks/:blockId  { teacherCounts }
//  · DELETE /api/review-assign/:id
//  · GET    /api/review-pool/exams/:examId/blocks/:blockId        （#218 试卷池管理）
//  · POST   /api/review-pool/exams/:examId/blocks/:blockId/crops/:cropId/release （#218 强制释放）
// 请求/响应形状与权限判断零改动，仅替换视觉层。
import React, { useState, useEffect, useCallback } from "react";
import { AlertTriangle, CheckCircle2, Dices, RefreshCw, UserPlus, X, Users } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ReviewAssignment, ReviewBlockSummary, ReviewPoolEntry, ReviewPoolSummary } from "../../../../shared/types";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";

interface Props {
  examId: number;
}

type TeacherOption = { id: number; name: string; subject: string | null };
type AssignmentInput = { teacherId: number; count: number };

export function ReviewAssignPage({ examId }: Props) {
  const [blocks, setBlocks] = useState<ReviewBlockSummary[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState("");
  const [assignments, setAssignments] = useState<ReviewAssignment[]>([]);
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [inputs, setInputs] = useState<AssignmentInput[]>([{ teacherId: 0, count: 0 }]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [msgTone, setMsgTone] = useState<"success" | "error" | "">("");
  const [poolData, setPoolData] = useState<{ summary: ReviewPoolSummary; entries: ReviewPoolEntry[] } | null>(null);
  const [poolMsg, setPoolMsg] = useState("");

  // 加载题块列表
  useEffect(() => {
    fetchJson<{ ok: boolean; data: ReviewBlockSummary[] }>(`/api/review/exams/${examId}/blocks`)
      .then((res) => {
        if (res.ok && res.data.length > 0) {
          setBlocks(res.data);
          setSelectedBlockId(res.data[0].blockId);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [examId]);

  // 加载教师列表
  useEffect(() => {
    fetchJson<{ ok: boolean; data: TeacherOption[] }>(`/api/review-assign/exams/${examId}/eligible-teachers`)
      .then((res) => { if (res.ok) setTeachers(res.data); })
      .catch(() => {});
  }, [examId]);

  // 选择题块时加载分配
  const loadAssignments = useCallback((blockId: string) => {
    if (!blockId) return;
    fetchJson<{ ok: boolean; data: ReviewAssignment[] }>(
      `/api/review-assign/exams/${examId}/blocks/${encodeURIComponent(blockId)}`
    ).then((res) => { if (res.ok) setAssignments(res.data); }).catch(() => {});
  }, [examId]);

  useEffect(() => {
    if (selectedBlockId) loadAssignments(selectedBlockId);
  }, [selectedBlockId, loadAssignments]);

  // Issue #174: 加载试卷池汇总与条目
  const loadPool = useCallback((blockId: string) => {
    if (!blockId) return;
    setPoolMsg("");
    fetchJson<{ ok: boolean; data: { summary: ReviewPoolSummary; entries: ReviewPoolEntry[] }; error?: string }>(
      `/api/review-pool/exams/${examId}/blocks/${encodeURIComponent(blockId)}`
    )
      .then((res) => {
        if (res.ok) setPoolData(res.data);
        else setPoolMsg(res.error ?? "加载试卷池失败");
      })
      .catch((err: any) => setPoolMsg(err.message ?? "加载试卷池失败"));
  }, [examId]);

  useEffect(() => {
    if (selectedBlockId) loadPool(selectedBlockId);
  }, [selectedBlockId, loadPool]);

  // 更新输入行
  const updateInput = (idx: number, field: "teacherId" | "count", value: number) => {
    const next = [...inputs];
    next[idx] = { ...next[idx], [field]: value };
    setInputs(next);
  };

  // 随机分配
  const handleCreate = async () => {
    const valid = inputs.filter((i) => i.teacherId > 0 && i.count > 0);
    if (valid.length === 0 || !selectedBlockId) return;

    const teacherCounts: Record<number, number> = {};
    for (const i of valid) teacherCounts[i.teacherId] = i.count;

    setSaving(true);
    setMsg("");
    setMsgTone("");
    try {
      const res = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/review-assign/exams/${examId}/blocks/${encodeURIComponent(selectedBlockId)}`,
        { method: "POST", body: JSON.stringify({ teacherCounts }) }
      );
      if (res.ok) {
        setMsg("分配成功！系统已随机分配学生");
        setMsgTone("success");
        setInputs([{ teacherId: 0, count: 0 }]);
        loadAssignments(selectedBlockId);
        loadPool(selectedBlockId);
      } else {
        setMsg(res.error || "分配失败");
        setMsgTone("error");
      }
    } catch (err: any) {
      setMsg(err.message || "网络错误");
      setMsgTone("error");
    }
    setSaving(false);
  };

  // 删除分配
  const handleDelete = async (id: number) => {
    setMsg("");
    setMsgTone("");
    try {
      await fetchJson(`/api/review-assign/${id}`, { method: "DELETE" });
      loadAssignments(selectedBlockId);
    } catch (err: any) {
      setMsg(err.message || "删除分配失败");
      setMsgTone("error");
    }
  };

  // Issue #174: 强制释放被领取的试卷回池
  const handleForceRelease = async (cropId: string) => {
    if (!selectedBlockId) return;
    setPoolMsg("");
    try {
      const res = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/review-pool/exams/${examId}/blocks/${encodeURIComponent(selectedBlockId)}/crops/${encodeURIComponent(cropId)}/release`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }
      );
      if (res.ok) {
        setPoolMsg("已强制释放该试卷回池");
        loadPool(selectedBlockId);
      } else {
        setPoolMsg(res.error ?? "释放失败");
      }
    } catch (err: any) {
      setPoolMsg(err.message ?? "释放失败");
    }
  };

  const totalAssigned = assignments.reduce((s, a) => s + a.studentCount, 0);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner size={16} /> 加载中...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">阅卷任务分配</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新分配"
          onClick={() => { loadAssignments(selectedBlockId); loadPool(selectedBlockId); }}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {blocks.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="暂无可分配题块"
          description="本场考试尚未生成网阅题块，请先完成扫描与切块。"
        />
      ) : (
        <>
          {/* 题块选择 */}
          <Field
            label="选择题块"
            hint={selectedBlockId ? `已分配 ${totalAssigned} 份` : undefined}
            className="max-w-md"
          >
            <Select value={selectedBlockId} onValueChange={setSelectedBlockId}>
              <SelectTrigger aria-label="选择题块">
                <SelectValue placeholder="选择题块..." />
              </SelectTrigger>
              <SelectContent>
                {blocks.map((b) => (
                  <SelectItem key={b.blockId} value={b.blockId}>
                    {b.blockTitle} （待批 {b.pendingCount}/{b.totalCount}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {/* 已有分配 */}
          {assignments.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">当前分配</h3>
              <div className="flex flex-col gap-1.5">
                {assignments.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 rounded-md bg-secondary px-3 py-2 text-base"
                  >
                    <span className="flex-1 truncate text-foreground">
                      {a.teacherName ?? `教师${a.teacherId}`}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {a.studentCount} 份
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive-fg"
                      onClick={() => handleDelete(a.id)}
                    >
                      删除
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 新建分配 */}
          <section className="flex flex-col gap-3 border-t border-border-subtle pt-4">
            <h3 className="text-sm font-medium text-foreground">新建分配</h3>

            {inputs.map((input, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-2">
                <Select
                  value={input.teacherId > 0 ? String(input.teacherId) : ""}
                  onValueChange={(v) => updateInput(idx, "teacherId", Number(v))}
                >
                  <SelectTrigger className="w-48" aria-label="选择教师">
                    <SelectValue placeholder="选择教师..." />
                  </SelectTrigger>
                  <SelectContent>
                    {teachers.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name}{t.subject ? ` (${t.subject})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  placeholder="份数"
                  min={1}
                  aria-label="份数"
                  value={input.count || ""}
                  onChange={(e) => updateInput(idx, "count", Number(e.target.value))}
                  className="w-24 tabular-nums"
                />
                {inputs.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="移除教师"
                    className="text-destructive-fg"
                    onClick={() => setInputs(inputs.filter((_, i) => i !== idx))}
                  >
                    <X className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                icon={<UserPlus />}
                onClick={() => setInputs([...inputs, { teacherId: 0, count: 0 }])}
              >
                添加教师
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Dices />}
                loading={saving}
                disabled={!selectedBlockId}
                onClick={handleCreate}
              >
                {saving ? "分配中..." : "随机分配"}
              </Button>
            </div>

            {msg && (
              <div
                className={
                  msgTone === "success"
                    ? "flex items-center gap-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success-foreground"
                    : "flex items-center gap-2 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive-fg"
                }
                role="status"
              >
                {msgTone === "success" && (
                  <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                )}
                {msg}
              </div>
            )}
          </section>

          {/* Issue #174: 试卷池管理（#218） */}
          <section className="flex flex-col gap-3 border-t border-border-subtle pt-4">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-foreground">试卷池管理</h3>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="刷新试卷池"
                onClick={() => loadPool(selectedBlockId)}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>

            {poolMsg && (
              <div
                className="flex items-center gap-2 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive-fg"
                role="status"
              >
                <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                {poolMsg}
              </div>
            )}

            {poolData ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="info">池中可领 {poolData.summary.inPoolCount}</Badge>
                  <Badge>已领取 {poolData.summary.claimedCount}</Badge>
                  <Badge tone="success">已阅 {poolData.summary.reviewedCount}</Badge>
                  <Badge tone="warning">待复核 {poolData.summary.pendingCount}</Badge>
                  <Badge tone="danger">争议 {poolData.summary.disputedCount}</Badge>
                  <Badge>总量 {poolData.summary.totalCount}</Badge>
                </div>

                <div className="text-sm text-muted-foreground">
                  教师领取情况：
                  {poolData.summary.assignments.length > 0
                    ? poolData.summary.assignments
                        .map((a) => `${a.teacherName ?? `教师${a.teacherId}`} 分配${a.assignedCount}/已领${a.claimedCount}/已阅${a.reviewedCount}`)
                        .join("；")
                    : "暂无分配记录（教师仍可直接从池中领卷）"}
                </div>

                <TableWrap>
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>学生</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>领取人</TableHead>
                        <TableHead>领取时间</TableHead>
                        <TableHead numeric>累计领取</TableHead>
                        <TableHead>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {poolData.entries.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            {entry.studentName ?? entry.studentNumber ?? `学生${entry.studentId ?? ""}`}
                          </TableCell>
                          <TableCell>{statusBadge(entry.status)}</TableCell>
                          <TableCell>{entry.claimedByName ?? "—"}</TableCell>
                          <TableCell>{entry.claimedAt ? new Date(entry.claimedAt).toLocaleString() : "—"}</TableCell>
                          <TableCell numeric>{entry.claimCount}</TableCell>
                          <TableCell>
                            {entry.claimedBy != null && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive-fg"
                                onClick={() => handleForceRelease(entry.id)}
                              >
                                强制释放
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableWrap>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">{poolMsg || "加载中..."}</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** #218 试卷池条目状态 → v2 状态徽章（§4.5：色彩永不单独承载状态） */
function statusBadge(status?: string) {
  switch (status) {
    case "ready": return <Badge>待批</Badge>;
    case "pending": return <Badge tone="warning">待复核</Badge>;
    case "reviewed": return <Badge tone="success">已阅</Badge>;
    case "disputed": return <Badge tone="danger">争议</Badge>;
    default: return <Badge>{status ?? "—"}</Badge>;
  }
}
