import React, { useState, useEffect, useCallback } from "react";
import { fetchJson } from "../auth/api";
import type { TeacherBlockAssignment } from "../../../../shared/types";

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

  if (loading) return <div style={{ padding: 24 }}>加载中...</div>;
  if (blocks.length === 0) return <div style={{ padding: 24, color: "var(--color-text-tertiary)" }}>暂无可阅题块</div>;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 16 }}>选择题块开始阅卷</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {blocks.map((block) => {
          const pct = block.totalCount > 0
            ? Math.round((block.remainingForMe / block.totalCount) * 100)
            : 100;
          const isDone = block.remainingForMe <= 0;

          return (
            <div
              key={block.blockId}
              onClick={() => !isDone && onSelectBlock(block.blockId)}
              style={{
                padding: "16px",
                background: isDone ? "var(--color-background-tertiary)" : "var(--color-background-secondary)",
                borderRadius: 10,
                border: "0.5px solid var(--color-border-tertiary)",
                cursor: isDone ? "default" : "pointer",
                opacity: isDone ? 0.6 : 1,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontWeight: 500, fontSize: 15 }}>{block.blockTitle || block.blockId}</div>
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
                  {block.remainingForMe}/{block.totalCount}
                </div>
              </div>
              <div style={{
                height: 6,
                background: "var(--color-border-tertiary)",
                borderRadius: 3,
                overflow: "hidden"
              }}>
                <div style={{
                  height: "100%",
                  width: `${pct}%`,
                  background: isDone ? "var(--color-text-tertiary)" : "var(--color-background-info)",
                  borderRadius: 3,
                  transition: "width 0.3s"
                }} />
              </div>
              {isDone && (
                <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 6 }}>
                  已完成
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
