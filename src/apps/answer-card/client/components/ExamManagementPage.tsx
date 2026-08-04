import React, { useEffect, useState, useCallback } from "react";
import { ClipboardCheck, Plus, Trash2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ExamRecord } from "../../../../shared/types";

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
      style={{
        display: "flex",
        alignItems: "center",
        padding: "10px 14px",
        background: isReview ? "#FFF8E1" : "var(--color-background-secondary)",
        borderRadius: 8,
        borderLeft: isReview ? "3px solid #FFA000" : "0.5px solid var(--color-border-tertiary)",
        gap: 12,
        marginBottom: 6,
      }}
    >
      {examManageMode === "single" && (
        <input
          type="checkbox"
          checked={selectedIds.has(exam.id)}
          onChange={() => onToggleSelect(exam.id)}
          style={{ width: 16, height: 16, flexShrink: 0 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>
          {exam.name}
          {isReview && <span style={{ color: "#E65100", marginLeft: 8, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}><ClipboardCheck size={13} aria-hidden="true" /> 待阅</span>}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
          {exam.subject ?? "未指定科目"} · {exam.status}
          {exam.start_time && ` · ${exam.start_time.slice(0, 10)}`}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        {isReview && (
          <button onClick={() => onEnterReview(exam.id)} style={actionBtn("var(--color-background-warning, #FFA000)", "#fff")}>
            网阅
          </button>
        )}
        <button onClick={() => onEnterExam(exam.id)} style={actionBtn("var(--color-background-secondary)", "var(--color-text-primary)")}>
          详情
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ padding: 24 }}>
      {/* 工具栏 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        {examManageMode === "single" ? (
          <>
            <button className="primary-button" onClick={onCreateExam}>
              <Plus size={16} /> 新建考试
            </button>
            {selectedIds.size > 0 && (
              <button className="ghost-button" style={{ color: "#E24B4A" }} onClick={onDeleteSelected}>
                <Trash2 size={16} /> 删除选中 ({selectedIds.size})
              </button>
            )}
          </>
        ) : (
          <button className="primary-button" onClick={onCreateGroup}>
            <Plus size={16} /> 新建大考
          </button>
        )}
        <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          共 {examManageMode === "single" ? exams.length : groupsCount} {examManageMode === "single" ? "个考试" : "个大考"}
        </span>
        <div style={{ display: "flex", gap: 0, border: "1px solid var(--color-text-primary)", borderRadius: 6, overflow: "hidden", marginLeft: "auto" }}>
          <button onClick={() => onSetExamManageMode("single")} style={toggleStyle(examManageMode === "single")}>单科考试</button>
          <button onClick={() => onSetExamManageMode("group")} style={toggleStyle(examManageMode === "group")}>大考</button>
        </div>
      </div>

      {/* 阅卷中区域 */}
      {reviewExams.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, marginTop: 4 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><ClipboardCheck size={13} aria-hidden="true" /> 阅卷中</span>
          </div>
          {reviewExams.map((e) => renderExamRow(e, true))}
        </>
      )}

      {/* 分割线 */}
      {hasDivider && (
        <div style={{ margin: "16px 0", borderTop: "1px solid var(--color-border-primary)", paddingTop: 8, fontSize: 12, color: "var(--color-text-secondary)" }}>
          ─── 其他考试 ───
        </div>
      )}

      {/* 普通考试 */}
      {normalExams.length > 0 && reviewExams.length === 0 && exams.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>全部考试</div>
      )}
      {normalExams.map((e) => renderExamRow(e, false))}

      {exams.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-tertiary)" }}>
          暂无考试
        </div>
      )}
    </div>
  );
}

function actionBtn(bg: string, color: string): React.CSSProperties {
  return {
    padding: "5px 12px", fontSize: 12, fontWeight: 500, borderRadius: 6,
    border: `0.5px solid ${color === "#fff" ? "transparent" : "var(--color-border-primary)"}`,
    background: bg, color, cursor: "pointer", whiteSpace: "nowrap",
  };
}

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    padding: "5px 14px", border: "none",
    background: active ? "var(--color-text-primary)" : "var(--color-background-secondary)",
    color: active ? "var(--color-background-primary)" : "var(--color-text-primary)",
    fontSize: 12, cursor: "pointer", fontWeight: active ? 600 : 400,
  };
}
