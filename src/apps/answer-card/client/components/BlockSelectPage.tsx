// BlockSelectPage —— 选择题块开始阅卷（T5 v2 迁移）
// 视觉层切换到 v2：Card / Progress / Badge / EmptyState / Spinner。
// 功能守恒：GET /api/review-assign/exams/:examId/teachers/me/blocks 与选块回调零改动。
import React, { useState, useEffect, useCallback } from "react";
import { ClipboardList } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { TeacherBlockAssignment } from "../../../../shared/types";
import { Badge, Card, EmptyState, Progress, Spinner } from "./ui/v2";

interface Props {
  examId: number;
  teacherId: number;
  onSelectBlock: (blockId: string) => void;
}

export function BlockSelectPage({ examId, teacherId, onSelectBlock }: Props) {
  const [blocks, setBlocks] = useState<TeacherBlockAssignment[]>([]);
  const [loading, setLoading] = useState(true);

  const loadBlocks = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; data: TeacherBlockAssignment[] }>(
        `/api/review-assign/exams/${examId}/teachers/me/blocks`
      );
      if (res.ok) setBlocks(res.data);
    } catch { /* silent */ }
    setLoading(false);
  }, [examId]);

  useEffect(() => { loadBlocks(); }, [loadBlocks]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner size={16} /> 加载中...
      </div>
    );
  }

  if (blocks.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList />}
        title="暂无可阅题块"
        description="尚未给你分配阅卷任务，请联系年级组长在「阅卷分配」中派发。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6" data-teacher-id={teacherId}>
      <h2 className="text-base font-medium text-foreground">选择题块开始阅卷</h2>

      <div className="flex flex-col gap-3">
        {blocks.map((block) => {
          const pct = block.totalCount > 0
            ? Math.round((block.remainingForMe / block.totalCount) * 100)
            : 100;
          const isDone = block.remainingForMe <= 0;

          return (
            <Card
              key={block.blockId}
              interactive={!isDone}
              className={isDone ? "p-4 opacity-60" : "p-4"}
              onClick={() => !isDone && onSelectBlock(block.blockId)}
              role={isDone ? undefined : "button"}
              tabIndex={isDone ? undefined : 0}
              onKeyDown={(e) => {
                if (isDone) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectBlock(block.blockId);
                }
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="truncate text-base font-medium text-foreground">
                  {block.blockTitle || block.blockId}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {block.remainingForMe}/{block.totalCount}
                </span>
              </div>

              <Progress value={pct} tone={isDone ? "success" : "primary"} size="sm" />

              {isDone && (
                <div className="mt-2">
                  <Badge tone="success" dot>已完成</Badge>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
