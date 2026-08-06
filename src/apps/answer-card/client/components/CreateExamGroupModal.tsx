import { useEffect, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { authFetch, fetchJson } from "../auth/api";
import type { ExamFilterItem, ExamGroupMember } from "../../../../shared/types";
import {
  Button,
  Checkbox,
  ControlRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from "./ui/v2";
import { cn } from "../lib/utils";

/** Radix Select 不接受空字符串 value，用哨兵代表「不限 / 无标签 / 全部科目」 */
const ANY = "__any__";

interface Props {
  onClose: () => void;
  onCreated?: (groupId: number) => void;
  existingGroup?: {
    id: number; name: string; description?: string;
    grade_id?: number | null; tag?: string;
    is_official?: number;
    total_score_mode?: string; only_full_participants?: number;
  };
  existingMembers?: ExamGroupMember[];
}

export function CreateExamGroupModal({ onClose, onCreated, existingGroup, existingMembers }: Props) {
  const [name, setName] = useState(existingGroup?.name ?? "");
  const [description, setDescription] = useState(existingGroup?.description ?? "");
  const [gradeId, setGradeId] = useState(existingGroup?.grade_id ? String(existingGroup.grade_id) : "");
  const [tag, setTag] = useState(existingGroup?.tag ?? "");
  const [isOfficial, setIsOfficial] = useState(existingGroup?.is_official ?? 0);
  const [totalScoreMode, setTotalScoreMode] = useState<string>(existingGroup?.total_score_mode ?? "raw");

  const [selectedExams, setSelectedExams] = useState<Array<{ examId: number; examName: string; subject: string; date: string; trackType: string }>>(
    existingMembers?.map((m: any) => ({
      examId: m.examId ?? m.exam_id,
      examName: m.examName ?? m.exam_name,
      subject: m.subject ?? "",
      date: m.examDate ?? m.exam_date ?? "",
      trackType: m.trackType ?? m.track_type ?? "common"
    })) ?? []
  );
  const [showPicker, setShowPicker] = useState(false);
  const [pickerExams, setPickerExams] = useState<ExamFilterItem[]>([]);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerSubject, setPickerSubject] = useState("");
  const [pickerLoading, setPickerLoading] = useState(false);
  const [grades, setGrades] = useState<Array<{ id: number; name: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const isEdit = !!existingGroup;

  useEffect(() => {
    fetchJson<Array<{ id: number; name: string }>>("/api/classes/grades")
      .then(setGrades)
      .catch(() => setGrades([]));
  }, []);

  // Preload exams for picker
  useEffect(() => {
    loadPickerExams();
  }, []);

  useEffect(() => {
    if (showPicker && pickerSubject) {
      loadPickerExams();
    }
  }, [pickerSubject]);

  async function loadPickerExams() {
    setPickerLoading(true);
    try {
      const params = new URLSearchParams({ selection: "1" });
      if (pickerSubject) params.set("subject", pickerSubject);
      const data = await fetchJson<ExamFilterItem[]>(`/api/exams?${params.toString()}`);
      setPickerExams(data);
    } catch { setPickerExams([]); }
    finally { setPickerLoading(false); }
  }

  async function handleSubmit() {
    if (creating) return;
    if (!name.trim()) { setError("大考名称不能为空"); return; }
    if (selectedExams.length === 0) { setError("请至少关联一场考试"); return; }

    setCreating(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        grade_id: gradeId ? Number(gradeId) : null,
        tag: tag || null,
        is_official: isOfficial,
        total_score_mode: totalScoreMode,
        examIds: selectedExams.map((e) => e.examId),
        memberTracks: Object.fromEntries(
          selectedExams.map((e) => [String(e.examId), e.trackType || "common"])
        )
      };

      if (isEdit) {
        await authFetch(`/api/exam-groups/${existingGroup!.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        onCreated?.(existingGroup!.id);
      } else {
        const res = await authFetch("/api/exam-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        onCreated?.(data.id);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setCreating(false);
    }
  }

  function addExamFromPicker(exam: ExamFilterItem) {
    if (selectedExams.some((e) => e.examId === exam.id)) return;
    setSelectedExams([...selectedExams, {
      examId: exam.id,
      examName: exam.name,
      subject: exam.subject || "",
      date: exam.exam_date || "",
      trackType: defaultTrackType(exam.subject || "")
    }]);
  }

  function updateTrackType(examId: number, trackType: string) {
    setSelectedExams(selectedExams.map((e) => e.examId === examId ? { ...e, trackType } : e));
  }

  function removeExam(examId: number) {
    setSelectedExams(selectedExams.filter((e) => e.examId !== examId));
  }

  // Inline exam creation
  const tags = ["", "月考", "期中", "期末", "模考", "统考"];
  const allSubjects = ["语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理"];

  /** 文理分科（Issue #177）：按科目自动预填科目归属 */
  function defaultTrackType(subject: string): string {
    if (["物理", "化学", "生物"].includes(subject)) return "science";
    if (["政治", "历史", "地理"].includes(subject)) return "arts";
    return "common";
  }

  const filteredPicker = pickerExams.filter((e) =>
    !pickerSearch || e.name.includes(pickerSearch) || (e.subject || "").includes(pickerSearch)
  );

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑大考" : "创建大考"}</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {/* Name & grade row */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <Field className="sm:flex-[1.5]" label="大考名称" required htmlFor="exam-group-name">
              <Input
                id="exam-group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：2026高考摸底大考"
              />
            </Field>
            <Field className="sm:flex-1" label="年级">
              <Select
                value={gradeId || ANY}
                onValueChange={(value) => setGradeId(value === ANY ? "" : value)}
              >
                <SelectTrigger aria-label="年级">
                  <SelectValue placeholder="不限" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>不限</SelectItem>
                  {grades.map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>

          {/* Description & tag */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <Field className="sm:flex-[1.5]" label="描述" htmlFor="exam-group-desc">
              <Input
                id="exam-group-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="可选描述"
              />
            </Field>
            <Field className="sm:flex-1" label="标签">
              <Select
                value={tag || ANY}
                onValueChange={(value) => setTag(value === ANY ? "" : value)}
              >
                <SelectTrigger aria-label="标签">
                  <SelectValue placeholder="无标签" />
                </SelectTrigger>
                <SelectContent>
                  {tags.map((t) => (
                    <SelectItem key={t || ANY} value={t || ANY}>{t || "无标签"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          {/* Options */}
          <div className="flex flex-wrap items-center gap-4">
            <ControlRow
              htmlFor="exam-group-official"
              control={
                <Checkbox
                  id="exam-group-official"
                  checked={isOfficial === 1}
                  onCheckedChange={(checked) => setIsOfficial(checked === true ? 1 : 0)}
                />
              }
              label="官方统考"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-secondary-foreground">总分计算：</span>
              <Select value={totalScoreMode} onValueChange={setTotalScoreMode}>
                <SelectTrigger className="w-28" aria-label="总分计算方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="raw">原始分</SelectItem>
                  <SelectItem value="assigned">赋分</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                （仅对化学/生物/地理/政治等赋分科目生效）
              </span>
            </div>
          </div>

          {/* Associated exams */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-secondary-foreground">
                关联考试 <span className="text-destructive" aria-hidden>*</span>
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  已选 <span className="tabular-nums">{selectedExams.length}</span> 场
                </span>
              </div>
              <Button
                size="sm"
                variant="primary"
                icon={<Plus />}
                onClick={() => setShowPicker(!showPicker)}
              >
                {showPicker ? "收起" : "关联已有考试"}
              </Button>
            </div>

            {/* Picker panel */}
            {showPicker && (
              <div className="max-h-50 overflow-auto rounded-lg border border-border-subtle bg-secondary p-3">
                <div className="mb-2 flex gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      className="pl-8"
                      value={pickerSearch}
                      onChange={(e) => setPickerSearch(e.target.value)}
                      placeholder="搜索考试..."
                      aria-label="搜索考试"
                    />
                  </div>
                  <Select
                    value={pickerSubject || ANY}
                    onValueChange={(value) => setPickerSubject(value === ANY ? "" : value)}
                  >
                    <SelectTrigger className="w-32" aria-label="科目筛选">
                      <SelectValue placeholder="全部科目" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>全部科目</SelectItem>
                      {allSubjects.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                {pickerLoading ? (
                  <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                    <Spinner /> 加载中...
                  </div>
                ) : filteredPicker.length === 0 ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    {pickerExams.length === 0 ? "暂无可用考试" : "没有匹配的考试"}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {filteredPicker.slice(0, 30).map((exam) => {
                      const alreadyAdded = selectedExams.some((e) => e.examId === exam.id);
                      return (
                        <button
                          key={exam.id}
                          type="button"
                          disabled={alreadyAdded}
                          onClick={() => addExamFromPicker(exam)}
                          className={cn(
                            "flex items-center justify-between gap-2 rounded-md border-0 px-2 py-1.5 text-left text-sm",
                            "outline-none focus-visible:shadow-focus",
                            alreadyAdded
                              ? "cursor-default bg-warning-soft opacity-60"
                              : "cursor-pointer bg-card hover:bg-accent",
                          )}
                        >
                          <span className="flex min-w-0 gap-2">
                            <span className="truncate font-medium text-foreground">{exam.name}</span>
                            <span className="shrink-0 text-muted-foreground">{exam.subject || "—"}</span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {alreadyAdded ? "已添加" : exam.graded_count > 0 ? `${exam.graded_count}人 均${exam.avg_score}` : "未阅卷"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Selected exams list */}
            <div className="flex flex-col gap-1.5">
              {selectedExams.map((exam, idx) => (
                <div
                  key={exam.examId}
                  className="flex items-center justify-between gap-2 rounded-lg bg-secondary px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums">
                      {idx + 1}
                    </span>
                    <span className="truncate font-medium text-foreground">{exam.examName}</span>
                    <span className="shrink-0 text-xs text-secondary-foreground">{exam.subject || "无科目"}</span>
                    {exam.date && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{exam.date}</span>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* 文理分科（Issue #177）：科目归属 共同/文科/理科 */}
                    <Select
                      value={exam.trackType || "common"}
                      onValueChange={(v) => updateTrackType(exam.examId, v)}
                    >
                      <SelectTrigger className="h-control-sm w-20 text-xs" aria-label={`${exam.examName} 文理分科归属`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="common">共同</SelectItem>
                        <SelectItem value="arts">文科</SelectItem>
                        <SelectItem value="science">理科</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`移除 ${exam.examName}`}
                      onClick={() => removeExam(exam.examId)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
              {selectedExams.length === 0 && (
                <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                  点击上方「关联已有考试」从列表选择
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">
              {error}
            </div>
          )}
        </DialogBody>

        {/* Actions */}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={creating}>取消</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} loading={creating}>
            {isEdit ? "保存修改" : "创建大考"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
