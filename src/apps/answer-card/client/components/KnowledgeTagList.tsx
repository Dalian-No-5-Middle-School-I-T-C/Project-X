import { useState } from "react";
import { Plus, X } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  SkeletonText,
  paletteColor,
} from "./ui/v2";

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

/** 字符串确定性散列：同一知识点名恒映射到同一调色板序号 */
function hashCode(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 学科色只经由图表调色板解析，组件内不出现任何十六进制（铁律 §4） */
function subjectColor(point: string): string {
  return paletteColor(hashCode(point));
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
      <div role="status" aria-label="知识点加载中">
        <SkeletonText lines={3} />
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="暂无知识点"
        description="开始分析后自动生成知识点标签"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {questions.map((q, qi) => (
        <div key={q.question_number} className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 text-sm font-medium text-foreground">第{q.question_number}题</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {q.points.map((point, pi) => {
              const isEditing = editingIdx?.qi === qi && editingIdx?.pi === pi;
              if (isEditing) {
                return (
                  <Input
                    key={pi}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditingIdx(null);
                    }}
                    autoFocus
                    className="max-w-40"
                    aria-label="编辑知识点"
                  />
                );
              }
              return (
                <Badge
                  key={pi}
                  tone="solid"
                  className="cursor-pointer select-none hover:opacity-85"
                  // 动态值：知识点名 → 图表调色板色（散列稳定），非静态工具类可表达
                  style={{ backgroundColor: subjectColor(point) }}
                  onDoubleClick={() => startEdit(qi, pi, point)}
                  title="双击编辑"
                >
                  {point}
                  {editable && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removePoint(qi, pi);
                      }}
                      className="-m-0.5 inline-flex shrink-0 items-center rounded-sm p-0.5 text-white/70 transition-colors hover:text-white"
                      title="删除"
                      aria-label="删除知识点"
                    >
                      <X aria-hidden />
                    </button>
                  )}
                </Badge>
              );
            })}
            {editable && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={<Plus />}
                onClick={() => addPoint(qi)}
                title="添加知识点"
              >
                添加
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
