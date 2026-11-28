import { useEffect, useMemo, useState } from "react";
import type { ObjectiveBlock } from "../../../../shared/types";
import { parseObjectiveAnswerBlock, type ObjectiveAnswerParsePreview } from "../../../../shared/objectiveAnswerInput";
import { Button, Field, Textarea } from "./ui/v2";

export interface ObjectiveAnswerBatchInputProps {
  block: ObjectiveBlock;
  onApply: (preview: ObjectiveAnswerParsePreview) => void;
  disabled?: boolean;
}

/** 设计器与答案修订页共用的批量答案录入：先预览，确认后才写入。 */
export function ObjectiveAnswerBatchInput({ block, onApply, disabled = false }: ObjectiveAnswerBatchInputProps) {
  const [text, setText] = useState("");
  useEffect(() => setText(""), [block.id]);
  const preview = useMemo(() => parseObjectiveAnswerBlock(block, text), [block, text]);

  function apply() {
    if (preview.errors.length === 0) {
      onApply(preview);
      setText("");
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-secondary p-2.5">
      <Field label="共用答案文本">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              apply();
            }
          }}
          disabled={disabled}
          rows={3}
          placeholder={"单选：ABCD… 逐题分配\n多选：AC,BD（每行一题）；混合块按题序逐行填写"}
          aria-label="共用答案文本"
        />
      </Field>
      <p className="m-0 text-xs text-muted-foreground">
        换行作为题边界；多选每段可用连续字母或逗号。应用前会校验选项范围、单选数量与重复项。按 Ctrl/Cmd+Enter 可直接应用。
      </p>
      {text.trim() && (
        <div className="max-h-32 overflow-auto rounded-md border border-border-subtle bg-card p-2" aria-label="答案解析预览">
          {preview.rows.map((row) => (
            <div key={row.questionNumber} className="flex items-center gap-2 text-xs">
              <span className="w-8 shrink-0 tabular-nums text-muted-foreground">{row.questionNumber}.</span>
              <span className={row.error ? "text-destructive-fg" : "font-semibold text-foreground"}>
                {row.error ?? (row.options.join("") || "清空")}
              </span>
            </div>
          ))}
          {preview.errors.length > 0 && (
            <p className="m-0 mt-1 text-xs text-destructive-fg" role="alert">{preview.errors.join("；")}</p>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="primary" disabled={disabled || !text.trim() || preview.errors.length > 0} onClick={apply}>
          应用到全部题目
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setText("");
            onApply(parseObjectiveAnswerBlock(block, ""));
          }}
        >
          清空全部答案
        </Button>
      </div>
    </div>
  );
}
