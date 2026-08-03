import { useEffect, useState } from "react";
import { Calculator } from "lucide-react";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import type { AssignedFormula } from "../../../../shared/types";
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
  Field,
  Input,
  Spinner,
} from "../components/ui/v2";

interface Props {
  examId: number;
  examName: string;
  subject: string | null;
  onClose: () => void;
  onSaved: () => void;
}

interface FormulaPreset {
  id: string;
  name: string;
  formula: AssignedFormula;
}

export function AssignedFormulaModal({ examId, examName, subject, onClose, onSaved }: Props) {
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [formula, setFormula] = useState<AssignedFormula | null>(null);
  const [presets, setPresets] = useState<FormulaPreset[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchJson<{
      formula: AssignedFormula | null;
      isAssignedSubject: boolean;
      presets: FormulaPreset[];
      customFormulaDisabled: boolean;
    }>(`/api/exams/${examId}/assigned-formula`)
      .then((data) => {
        setFormula(data.formula);
        setPresets(data.presets);
      })
      .catch(() => setMessage("加载赋分配置失败"))
      .finally(() => setLoading(false));
  }, [examId]);

  async function handleSave(recalculate: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const result = await fetchJson<{ ok: boolean; updated?: number }>(
        `/api/exams/${examId}/assigned-formula`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ formula, recalculate })
        }
      );
      setMessage(recalculate ? `已保存并重算 ${result.updated ?? 0} 条成绩` : "已保存");
      onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(preset: FormulaPreset) {
    setFormula(structuredClone(preset.formula));
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setOpen(false);
      onClose();
    }
  }

  const description = subject ? `${examName} · ${subject}` : examName;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="size-5" />
            赋分配置
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
              <Spinner size={18} label="加载赋分配置中" />
              <span>加载赋分配置中…</span>
            </div>
          ) : (
            <>
              <Field label="公式预设">
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => {
                    const active = formula?.type === p.formula.type;
                    return (
                      <Button
                        key={p.id}
                        type="button"
                        variant={active ? "primary" : "outline"}
                        size="sm"
                        onClick={() => applyPreset(p)}
                      >
                        {p.name}
                      </Button>
                    );
                  })}
                </div>
              </Field>

              {formula?.type === "custom" && (
                <p className="text-sm text-destructive-fg" role="alert">
                  此考试保存了历史自定义表达式。该功能已因安全原因停用，历史配置和既有赋分不会被自动修改；请选择上方比例或线性预设后再保存。
                </p>
              )}

              <ControlRow
                control={
                  <Checkbox
                    checked={formula?.enabled ?? false}
                    onCheckedChange={(checked) =>
                      setFormula((f) => (f ? { ...f, enabled: checked === true } : null))
                    }
                    disabled={formula?.type === "custom"}
                  />
                }
                label="启用赋分"
              />

              {formula?.enabled && (
                <div className="flex flex-col gap-4">
                  {formula.type === "proportional" && (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="原始最低">
                        <Input
                          type="number"
                          value={formula.params.minIn ?? 0}
                          onChange={(e) =>
                            setFormula({
                              ...formula,
                              params: { ...formula.params, minIn: Number(e.target.value) },
                            })
                          }
                        />
                      </Field>
                      <Field label="原始最高">
                        <Input
                          type="number"
                          value={formula.params.maxIn ?? 100}
                          onChange={(e) =>
                            setFormula({
                              ...formula,
                              params: { ...formula.params, maxIn: Number(e.target.value) },
                            })
                          }
                        />
                      </Field>
                      <Field label="转换最低">
                        <Input
                          type="number"
                          value={formula.params.minOut ?? 30}
                          onChange={(e) =>
                            setFormula({
                              ...formula,
                              params: { ...formula.params, minOut: Number(e.target.value) },
                            })
                          }
                        />
                      </Field>
                      <Field label="转换最高">
                        <Input
                          type="number"
                          value={formula.params.maxOut ?? 100}
                          onChange={(e) =>
                            setFormula({
                              ...formula,
                              params: { ...formula.params, maxOut: Number(e.target.value) },
                            })
                          }
                        />
                      </Field>
                    </div>
                  )}

                  {formula.type === "linear" && (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="系数 a（乘数）">
                        <Input
                          type="number"
                          step="0.1"
                          value={formula.params.a ?? 0.7}
                          onChange={(e) =>
                            setFormula({
                              ...formula,
                              params: { ...formula.params, a: Number(e.target.value) },
                            })
                          }
                        />
                      </Field>
                      <Field label="常数 b（偏移量）">
                        <Input
                          type="number"
                          step="1"
                          value={formula.params.b ?? 30}
                          onChange={(e) =>
                            setFormula({
                              ...formula,
                              params: { ...formula.params, b: Number(e.target.value) },
                            })
                          }
                        />
                      </Field>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </DialogBody>

        <DialogFooter>
          {message && (
            <span
              className={cn(
                "flex-1 text-sm",
                message.includes("失败") ? "text-destructive-fg" : "text-success-foreground"
              )}
            >
              {message}
            </span>
          )}
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          {formula?.enabled && formula.type !== "custom" && (
            <Button variant="outline" onClick={() => handleSave(true)} disabled={busy} loading={busy}>
              保存并重算全部
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => handleSave(false)}
            disabled={busy || formula?.type === "custom"}
            loading={busy}
          >
            {busy ? "保存中…" : "仅保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
