import { useEffect, useState, useCallback } from "react";
import { ClipboardCheck, Layers, Plus, Trash2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ExamRecord } from "../../../../shared/types";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  SegmentedControl,
  type SegmentedItem,
} from "./ui/v2";
import { cn } from "../lib/utils";

interface ExamItem extends ExamRecord {
  hasReviewTask?: boolean;
  pendingCount?: number;
  totalCount?: number;
}

interface Props {
  exams: ExamItem[];
  onCreateExam: () => void;
  onCreateGroup: () => void;
  onDeleteSelected: () => void;
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onSelectAll: () => void;
  examManageMode: "single" | "group";
  onSetExamManageMode: (m: "single" | "group") => void;
  groupsCount: number;
  onEnterExam: (examId: number) => void;
  onEnterReview: (examId: number) => void;
}

const MANAGE_MODE_ITEMS: ReadonlyArray<SegmentedItem<"single" | "group">> = [
  { value: "single", label: "单科考试" },
  { value: "group", label: "大考", icon: <Layers /> },
];

export function ExamManagementPage({
  exams, onCreateExam, onCreateGroup, onDeleteSelected, selectedIds,
  onToggleSelect, onSelectAll, examManageMode, onSetExamManageMode,
  groupsCount, onEnterExam, onEnterReview
}: Props) {
  const [reviewExamIds, setReviewExamIds] = useState<Set<number>>(new Set());

  const loadReviewStatus = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; data: Array<{ examId: number; pendingCount: number; totalCount: number }> }>(
        "/api/review/my-exams"
      );
      if (res.ok) {
        const ids = new Set<number>();
        for (const item of res.data) ids.add(item.examId);
        setReviewExamIds(ids);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadReviewStatus(); }, [loadReviewStatus]);

  const reviewExams = exams.filter((e) => reviewExamIds.has(e.id));
  const normalExams = exams.filter((e) => !reviewExamIds.has(e.id));
  const hasDivider = reviewExams.length > 0 && normalExams.length > 0;

  const renderExamRow = (exam: ExamItem, isReview: boolean) => (
    <div
      key={exam.id}
      className={cn(
        "mb-1.5 flex items-center gap-3 rounded-lg px-3.5 py-2.5",
        isReview
          ? "border-l-[3px] border-l-warning bg-warning-soft"
          : "border border-border-subtle bg-secondary",
      )}
    >
      {examManageMode === "single" && (
        <Checkbox
          aria-label={`选择考试 ${exam.name}`}
          checked={selectedIds.has(exam.id)}
          onCheckedChange={() => onToggleSelect(exam.id)}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-base font-medium text-foreground">
          <span className="truncate">{exam.name}</span>
          {isReview && (
            <Badge tone="warning" icon={<ClipboardCheck aria-hidden />}>待阅</Badge>
          )}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {exam.subject ?? "未指定科目"} · {exam.status}
          {exam.start_time && ` · ${exam.start_time.slice(0, 10)}`}
        </div>
      </div>
      <div className="flex shrink-0 gap-1.5">
        {isReview && (
          <Button size="sm" variant="primary" onClick={() => onEnterReview(exam.id)}>
            网阅
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => onEnterExam(exam.id)}>
          详情
        </Button>
      </div>
    </div>
  );

  return (
    <div className="p-6">
      {/* 工具栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {examManageMode === "single" ? (
          <>
            <Button variant="primary" icon={<Plus />} onClick={onCreateExam}>
              新建考试
            </Button>
            {selectedIds.size > 0 && (
              <Button variant="ghost" icon={<Trash2 />} className="text-destructive-fg" onClick={onDeleteSelected}>
                删除选中 ({selectedIds.size})
              </Button>
            )}
          </>
        ) : (
          <Button variant="primary" icon={<Plus />} onClick={onCreateGroup}>
            新建大考
          </Button>
        )}
        <span className="text-sm text-muted-foreground">
          共 <span className="tabular-nums">{examManageMode === "single" ? exams.length : groupsCount}</span> {examManageMode === "single" ? "个考试" : "个大考"}
        </span>
        <SegmentedControl
          className="ml-auto"
          aria-label="考试管理视图"
          value={examManageMode}
          onValueChange={onSetExamManageMode}
          items={MANAGE_MODE_ITEMS}
        />
      </div>

      {/* 阅卷中区域 */}
      {reviewExams.length > 0 && (
        <>
          <div className="mt-1 mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ClipboardCheck className="size-3.5" aria-hidden /> 阅卷中
          </div>
          {reviewExams.map((e) => renderExamRow(e, true))}
        </>
      )}

      {/* 分割线 */}
      {hasDivider && (
        <div className="my-4 border-t border-border pt-2 text-xs text-muted-foreground">
          其他考试
        </div>
      )}

      {/* 普通考试 */}
      {normalExams.length > 0 && reviewExams.length === 0 && exams.length > 0 && (
        <div className="mb-2 text-xs text-muted-foreground">全部考试</div>
      )}
      {normalExams.map((e) => renderExamRow(e, false))}

      {exams.length === 0 && (
        <Card className="p-2">
          <EmptyState icon={<Layers />} title="暂无考试" size="sm" />
        </Card>
      )}
    </div>
  );
}
