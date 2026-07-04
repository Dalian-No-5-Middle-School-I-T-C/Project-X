import React, { useState } from "react";

interface QuestionPoints {
  question_number: number;
  points: string[];
}

interface Props {
  questions: QuestionPoints[];
  onChange: (questions: QuestionPoints[]) => void;
  editable?: boolean;
  loading?: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  "力学": "#3b82f6",
  "电磁": "#ef4444",
  "电磁学": "#ef4444",
  "热学": "#10b981",
  "光学": "#f59e0b",
  "近代物理": "#8b5cf6",
  "原子物理": "#8b5cf6",
  "代数": "#3b82f6",
  "几何": "#ef4444",
  "概率统计": "#10b981",
  "函数": "#8b5cf6",
  "无机": "#3b82f6",
  "有机": "#ef4444",
  "实验": "#f59e0b",
  "计算": "#8b5cf6",
};

function pickColor(_point: string): string {
  return "#6b7280"; // 默认灰色，后续可扩展学科匹配
}

export function KnowledgeTagList({ questions, onChange, editable = true, loading }: Props) {
  const [editingIdx, setEditingIdx] = useState<{ qi: number; pi: number } | null>(null);
  const [editValue, setEditValue] = useState("");

  const startEdit = (qi: number, pi: number, current: string) => {
    if (!editable) return;
    setEditingIdx({ qi, pi });
    setEditValue(current);
  };

  const commitEdit = () => {
    if (!editingIdx) return;
    const { qi, pi } = editingIdx;
    const newQuestions = [...questions];
    const pts = [...newQuestions[qi].points];
    if (editValue.trim()) {
      pts[pi] = editValue.trim();
    } else {
      pts.splice(pi, 1);
    }
    newQuestions[qi] = { ...newQuestions[qi], points: pts };
    onChange(newQuestions);
    setEditingIdx(null);
  };

  const removePoint = (qi: number, pi: number) => {
    const newQuestions = [...questions];
    const pts = newQuestions[qi].points.filter((_, i) => i !== pi);
    newQuestions[qi] = { ...newQuestions[qi], points: pts };
    onChange(newQuestions);
  };

  const addPoint = (qi: number) => {
    const newQuestions = [...questions];
    const pts = [...newQuestions[qi].points, ""];
    newQuestions[qi] = { ...newQuestions[qi], points: pts };
    onChange(newQuestions);
    // 立即进入编辑
    setEditingIdx({ qi, pi: pts.length - 1 });
    setEditValue("");
  };

  if (loading) {
    return (
      <div className="knowledge-loading">
        <div className="skeleton-row" />
        <div className="skeleton-row" />
        <div className="skeleton-row" />
      </div>
    );
  }

  return (
    <div className="knowledge-tag-list">
      {questions.map((q, qi) => (
        <div key={q.question_number} className="knowledge-question-group">
          <div className="knowledge-question-header">第{q.question_number}题</div>
          <div className="knowledge-tags">
            {q.points.map((point, pi) => {
              const isEditing = editingIdx?.qi === qi && editingIdx?.pi === pi;
              if (isEditing) {
                return (
                  <input
                    key={pi}
                    className="knowledge-tag-edit"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditingIdx(null);
                    }}
                    autoFocus
                    style={{ fontSize: "14px" }}
                  />
                );
              }
              return (
                <span
                  key={pi}
                  className="knowledge-tag"
                  style={{ backgroundColor: pickColor(point), color: "#fff" }}
                  onDoubleClick={() => startEdit(qi, pi, point)}
                  title="双击编辑"
                >
                  {point}
                  {editable && (
                    <button
                      className="knowledge-tag-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        removePoint(qi, pi);
                      }}
                      title="删除"
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
            {editable && (
              <button
                className="knowledge-tag-add"
                onClick={() => addPoint(qi)}
                title="添加知识点"
              >
                + 添加
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
