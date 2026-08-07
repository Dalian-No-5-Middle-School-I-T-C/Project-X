import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { authFetch, fetchJson } from "../auth/api";
import type { ExamGroupDetail, ExamGroupMember } from "../../../../shared/types";
import { cn } from "../lib/utils";
import {
  Button,
  Checkbox,
  ControlRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Skeleton,
  TaskProgress,
  notify,
} from "./ui/v2";

interface Props {
  groupId: number;
  onClose: () => void;
}

/** 导出进度快照（UI-3）。 */
interface ExportProgress {
  done: number;
  total: number;
  current: string;
  failed: number;
}

/** 一次导出里可数的产出项：总览表 + 每个勾选科目的小分表。 */
function buildExportItems(
  includeOverview: boolean,
  members: ExamGroupMember[],
  subjectExamIds: number[],
): string[] {
  const items: string[] = [];
  if (includeOverview) items.push("总览成绩表");
  for (const m of members) {
    if (subjectExamIds.includes(m.examId)) {
      items.push(m.subject || m.examName);
    }
  }
  return items;
}

export function GroupExportModal({ groupId, onClose }: Props) {
  const [detail, setDetail] = useState<ExamGroupDetail | null>(null);
  const [includeOverview, setIncludeOverview] = useState(true);
  const [subjectExamIds, setSubjectExamIds] = useState<number[]>([]);
  const [selectAll, setSelectAll] = useState(true);
  const [includeObjSub, setIncludeObjSub] = useState(true);
  const [includeSubjSub, setIncludeSubjSub] = useState(true);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const exporting = progress !== null && progress.failed === 0;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(false);
    fetchJson<ExamGroupDetail>(`/api/exam-groups/${groupId}`)
      .then((data) => {
        if (!alive) return;
        setDetail(data);
        setSubjectExamIds(data.members.map((m: ExamGroupMember) => m.examId));
      })
      .catch(() => {
        if (alive) setLoadError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [groupId]);

  const exportItems = useMemo(
    () => buildExportItems(includeOverview, detail?.members ?? [], subjectExamIds),
    [includeOverview, detail, subjectExamIds],
  );

  function toggleSubject(examId: number) {
    setSubjectExamIds((prev) =>
      prev.includes(examId)
        ? prev.filter((id) => id !== examId)
        : [...prev, examId],
    );
  }

  function handleSelectAll() {
    if (!detail) return;
    if (selectAll) {
      setSubjectExamIds([]);
    } else {
      setSubjectExamIds(detail.members.map((m) => m.examId));
    }
    setSelectAll(!selectAll);
  }

  /**
   * 导出为 ZIP。
   *
   * 进度说明（UI-3）：服务端目前只有「一次性返回 zip」的 POST 端点，没有逐项
   * 进度流。这里按「总览表 + 各科小分」把导出拆成可数的条目：请求在途时
   * `done = 0`，服务端返回后按条目扫一遍把 `done` 推到 `total` —— 这些条目在
   * 那一刻确实已经生成完毕，不是伪造的在途进度。
   *
   * // TODO(UI-3): 接真实 SSE 进度端点 /api/exam-groups/{id}/export/progress
   */
  async function handleExport() {
    const items = exportItems;
    const total = Math.max(1, items.length);
    setProgress({
      done: 0,
      total,
      current: `服务端正在生成 ${items.length} 个工作表…`,
      failed: 0,
    });

    try {
      const res = await authFetch(`/api/exam-groups/${groupId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          includeOverview,
          subjectExamIds,
          includeObjSub,
          includeSubjSub,
        }),
      });

      if (!res.ok) throw new Error("导出失败");

      // 服务端已完成全部条目，逐项推进 done 让用户看清导出了哪些表。
      for (let i = 0; i < items.length; i += 1) {
        setProgress({
          done: i + 1,
          total,
          current: items[i],
          failed: 0,
        });
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
      }

      setProgress({ done: total, total, current: "正在打包下载…", failed: 0 });

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${detail?.name ?? "大考"}_导出.zip`;
      a.click();
      URL.revokeObjectURL(url);
      notify.success(`已导出 ${items.length} 个工作表`);
      setProgress(null);
      onClose();
    } catch (err) {
      setProgress((prev) => ({
        done: prev?.done ?? 0,
        total: prev?.total ?? total,
        current: "导出中断",
        failed: total - (prev?.done ?? 0),
      }));
      notify.error(err instanceof Error ? err.message : "导出失败");
    }
  }

  const canExport = includeOverview || subjectExamIds.length > 0;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !exporting) onClose();
      }}
    >
      <DialogContent size="sm" className="max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>导出大考{detail ? `：${detail.name}` : ""}</DialogTitle>
          <DialogDescription>
            选择要导出的表格与小分范围，结果打包为一个 ZIP 文件。
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {loading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : loadError || !detail ? (
            <ErrorState
              title="加载大考信息失败"
              description="无法读取该大考的科目列表，请稍后重试。"
            />
          ) : (
            <>
              {/* 总览表 */}
              <div className="rounded-md border border-border-subtle bg-secondary p-3">
                <ControlRow
                  htmlFor="group-export-overview"
                  control={
                    <Checkbox
                      id="group-export-overview"
                      checked={includeOverview}
                      onCheckedChange={(v) => setIncludeOverview(v === true)}
                      disabled={exporting}
                    />
                  }
                  label={<span className="font-medium">总览成绩表</span>}
                  description="按总分排名的跨科成绩表，含各科校排/班排/原始分。有赋分的科目同列显示赋分。"
                />
              </div>

              {/* 各科小分 */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-base font-medium text-foreground">
                    各科详细小分
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectAll}
                    disabled={exporting}
                  >
                    {selectAll ? "取消全选" : "全选"}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail.members.map((m) => {
                    const active = subjectExamIds.includes(m.examId);
                    return (
                      <button
                        key={m.examId}
                        type="button"
                        aria-pressed={active}
                        disabled={exporting}
                        onClick={() => toggleSubject(m.examId)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm",
                          "transition-colors duration-(--px-dur-1) ease-standard",
                          "outline-none focus-visible:shadow-focus",
                          "disabled:cursor-not-allowed disabled:opacity-50",
                          active
                            ? "border-accent-border bg-accent font-medium text-accent-foreground"
                            : "border-border bg-card text-secondary-foreground hover:border-input-hover hover:bg-secondary",
                        )}
                      >
                        {m.subject || m.examName}
                      </button>
                    );
                  })}
                  {detail.members.length === 0 && (
                    <span className="text-sm text-muted-foreground">
                      该大考暂无成员考试
                    </span>
                  )}
                </div>
              </div>

              {/* 小分选项 */}
              <div className="flex flex-col gap-2">
                <span className="text-base font-medium text-foreground">
                  小分选项
                </span>
                <div className="flex flex-wrap gap-6">
                  <ControlRow
                    htmlFor="group-export-obj"
                    control={
                      <Checkbox
                        id="group-export-obj"
                        checked={includeObjSub}
                        onCheckedChange={(v) => setIncludeObjSub(v === true)}
                        disabled={exporting}
                      />
                    }
                    label={<span className="text-sm">客观题小分</span>}
                  />
                  <ControlRow
                    htmlFor="group-export-subj"
                    control={
                      <Checkbox
                        id="group-export-subj"
                        checked={includeSubjSub}
                        onCheckedChange={(v) => setIncludeSubjSub(v === true)}
                        disabled={exporting}
                      />
                    }
                    label={<span className="text-sm">主观题小分</span>}
                  />
                </div>
              </div>

              {/* 摘要 */}
              <p className="m-0 rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
                导出为 ZIP 压缩包，含
                {includeOverview ? "总览表 + " : ""}
                <span className="tabular-nums">{subjectExamIds.length}</span>{" "}
                科详细小分
              </p>

              {/* 进度（UI-3） */}
              {progress && (
                <TaskProgress
                  label="导出大考成绩"
                  current={progress.current}
                  done={progress.done}
                  total={progress.total}
                  failed={progress.failed}
                  tone={progress.failed > 0 ? "destructive" : "primary"}
                />
              )}
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={exporting}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={<Download className="size-4" />}
            onClick={() => void handleExport()}
            loading={exporting}
            disabled={loading || loadError || !canExport}
          >
            导出 ZIP
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
