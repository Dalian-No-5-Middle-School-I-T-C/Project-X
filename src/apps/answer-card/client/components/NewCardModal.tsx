// NewCardModal — 新建答题卡（v2 Dialog + Tailwind）
import { useEffect, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import { SUBJECT_OPTIONS, subjectToKey, isPredefinedSubject } from "../../../../shared/pinyin";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Select,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "../components/ui/v2";

export interface NewCardFormData {
  subject: string;
  subjectLabel: string;
  title: string;
  examDate: string;
  examAction: "none" | "create" | "link";
  examName?: string;
  linkExamId?: number;
  // 评审 P1-2：同步创建考试时须提供应考范围（年级或班级至少其一）
  gradeId?: number;
  classId?: number;
  englishListening?: boolean;
  chineseChoicePlacement?: "front" | "inline";
  paperSize: "A4" | "A3";
}

interface ExamOption {
  id: number;
  name: string;
  subject?: string | null;
  card_id?: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (data: NewCardFormData) => void;
  exams?: ExamOption[];
}

const EXAM_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_EXAM_YEAR = 1900;
const MAX_EXAM_YEAR = 2100;

export function isValidExamDate(value: string): boolean {
  const match = EXAM_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_EXAM_YEAR || year > MAX_EXAM_YEAR || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function DatePicker({ value, onChange }: { value?: string; onChange: (d: string) => void }) {
  const today = new Date();
  const initialValue = value && isValidExamDate(value) ? value : "";
  const [viewYear, setViewYear] = useState(initialValue ? Number(initialValue.slice(0, 4)) : today.getFullYear());
  const [viewMonth, setViewMonth] = useState(initialValue ? Number(initialValue.slice(5, 7)) - 1 : today.getMonth());
  const [manual, setManual] = useState(value ?? "");
  const [showCalendar, setShowCalendar] = useState(false);

  useEffect(() => {
    const nextValue = value ?? "";
    setManual(nextValue);
    if (isValidExamDate(nextValue)) {
      setViewYear(Number(nextValue.slice(0, 4)));
      setViewMonth(Number(nextValue.slice(5, 7)) - 1);
    }
  }, [value]);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
  const days: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);

  function selectDay(day: number | null) {
    if (day === null) return;
    const dateStr = `${String(viewYear).padStart(4, "0")}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!isValidExamDate(dateStr)) return;
    onChange(dateStr);
    setManual(dateStr);
    setShowCalendar(false);
  }

  function handleManualChange(text: string) {
    setManual(text);
    if (isValidExamDate(text)) onChange(text);
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <Input
          value={manual}
          onChange={(e) => handleManualChange(e.target.value)}
          onBlur={() => {
            if (manual && !isValidExamDate(manual)) setManual(value ?? "");
          }}
          placeholder="YYYY-MM-DD（如 2026-06-14）"
          className="pr-9"
        />
        <button
          type="button"
          onClick={() => setShowCalendar(!showCalendar)}
          className="absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="打开日历"
        >
          <Calendar size={16} />
        </button>
      </div>
      {showCalendar && (
        <div className="absolute top-full left-0 z-(--px-z-dropdown) mt-1 w-[280px] rounded-lg border border-border-subtle bg-popover p-3 shadow-3">
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => { if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); } else setViewMonth(viewMonth - 1); }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold text-foreground">{viewYear} 年 {viewMonth + 1} 月</span>
            <button
              type="button"
              onClick={() => { if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); } else setViewMonth(viewMonth + 1); }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-xs font-semibold text-muted-foreground">
            {["日", "一", "二", "三", "四", "五", "六"].map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {days.map((day, i) => {
              const isToday = day !== null && viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();
              const isSelected = day !== null && value === `${String(viewYear).padStart(4, "0")}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => selectDay(day)}
                  disabled={day === null}
                  className={cn(
                    "h-8 w-8 rounded-md text-sm transition-colors",
                    day === null && "invisible",
                    isSelected
                      ? "border-2 border-primary bg-accent font-semibold text-accent-foreground"
                      : isToday
                        ? "bg-secondary font-semibold text-foreground"
                        : "text-foreground hover:bg-secondary",
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function NewCardModal({ open, onCreate, onClose, exams = [] }: Props) {
  const [subjectLabel, setSubjectLabel] = useState("物理");
  const [showCustom, setShowCustom] = useState(false);
  const [customSubject, setCustomSubject] = useState("");
  const [title, setTitle] = useState("");
  const [examDate, setExamDate] = useState("");
  const [error, setError] = useState("");
  const [examAction, setExamAction] = useState<"none" | "create" | "link">("none");
  const [examName, setExamName] = useState("");
  const [linkExamId, setLinkExamId] = useState<number | null>(null);
  const [examNameManual, setExamNameManual] = useState(false);
  const [englishListening, setEnglishListening] = useState(true);
  const [chineseChoicePlacement, setChineseChoicePlacement] = useState<"front" | "inline">("front");
  const [paperSize, setPaperSize] = useState<"A4" | "A3">("A4");
  // 评审 P1-2：同步创建考试需应考范围（年级/班级）
  const [createGradeId, setCreateGradeId] = useState<string>("__none__");
  const [createClassId, setCreateClassId] = useState<string>("__none__");
  const [createGrades, setCreateGrades] = useState<Array<{ id: number; name: string }>>([]);
  const [createClasses, setCreateClasses] = useState<Array<{ id: number; name: string }>>([]);

  useEffect(() => {
    if (!open) return;
    fetchJson<Array<{ id: number; name: string }>>("/api/classes/grades")
      .then((grades) => { if (Array.isArray(grades)) setCreateGrades(grades); })
      .catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!open || !createGradeId || createGradeId === "__none__") {
      setCreateClasses([]);
      return;
    }
    fetchJson<Array<{ id: number; name: string }>>(`/api/classes?gradeId=${Number(createGradeId)}`)
      .then((cls) => { if (Array.isArray(cls)) setCreateClasses(cls); })
      .catch(() => setCreateClasses([]));
  }, [open, createGradeId]);

  useEffect(() => {
    if (open) {
      setSubjectLabel("物理");
      setShowCustom(false);
      setCustomSubject("");
      setTitle("");
      setExamDate("");
      setError("");
      setExamAction("none");
      setExamName("");
      setLinkExamId(null);
      setExamNameManual(false);
      setEnglishListening(true);
      setChineseChoicePlacement("front");
      setPaperSize("A4");
      setCreateGradeId("__none__");
      setCreateClassId("__none__");
      setCreateClasses([]);
    }
  }, [open]);

  function handleSubjectSelect(label: string) {
    setSubjectLabel(label);
    if (label === "其他") {
      setShowCustom(true);
    } else {
      setShowCustom(false);
      setCustomSubject("");
    }
  }

  function handleCustomSubjectChange(text: string) {
    setCustomSubject(text);
    if (isPredefinedSubject(text.trim())) {
      setSubjectLabel(text.trim());
      setShowCustom(false);
      setCustomSubject("");
    }
  }

  function handleCreate() {
    const finalLabel = subjectLabel === "其他" ? customSubject.trim() : subjectLabel;
    if (!finalLabel) { setError("请选择科目或手动输入科目名"); return; }
    const titleTrimmed = title.trim();
    if (!titleTrimmed) { setError("请输入考试名称（题目）"); return; }
    if (examAction === "create" && !examName.trim()) { setError("请输入关联考试的考试名称"); return; }
    if (examAction === "link" && !linkExamId) { setError("请选择要关联的已有考试"); return; }
    // 评审 P1-2：同步创建考试必须指定应考范围（年级或班级至少其一）
    if (examAction === "create") {
      const gradeId = createGradeId && createGradeId !== "__none__" ? Number(createGradeId) : undefined;
      const classId = createClassId && createClassId !== "__none__" ? Number(createClassId) : undefined;
      if (!gradeId && !classId) {
        setError("【完整性校验】请选择应考范围（年级或班级至少其一）");
        return;
      }
    }
    const normalizedExamDate = examDate.trim();
    if (!normalizedExamDate) { setError("请选择考试时间"); return; }
    if (!isValidExamDate(normalizedExamDate)) { setError(`请输入 ${MIN_EXAM_YEAR}-${MAX_EXAM_YEAR} 范围内的有效考试时间（YYYY-MM-DD）`); return; }
    const key = subjectToKey(finalLabel);
    onCreate({
      subject: key,
      subjectLabel: finalLabel,
      title: titleTrimmed,
      examDate: normalizedExamDate,
      examAction,
      examName: examAction === "create" ? examName.trim() || titleTrimmed : undefined,
      linkExamId: examAction === "link" && linkExamId ? linkExamId : undefined,
      gradeId: examAction === "create" && createGradeId && createGradeId !== "__none__" ? Number(createGradeId) : undefined,
      classId: examAction === "create" && createClassId && createClassId !== "__none__" ? Number(createClassId) : undefined,
      englishListening,
      chineseChoicePlacement,
      paperSize,
    });
  }

  const selectedSubjectKey = subjectToKey(showCustom ? customSubject.trim() : subjectLabel);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>新建答题卡</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5">
          <Field label="科目" required>
            <div className="flex flex-wrap gap-2">
              {SUBJECT_OPTIONS.map((opt) => (
                <Button
                  key={opt.key}
                  type="button"
                  variant={subjectLabel === opt.label && !showCustom ? "primary" : "outline"}
                  size="sm"
                  onClick={() => handleSubjectSelect(opt.label)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </Field>

          {(selectedSubjectKey === "yingyu" || selectedSubjectKey === "waiyu" || selectedSubjectKey === "yuwen") && (
            <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-secondary p-3">
              <span className="text-xs font-semibold text-secondary-foreground">模板选项</span>
              {(selectedSubjectKey === "yingyu" || selectedSubjectKey === "waiyu") && (
                <label className="flex items-center gap-2 text-sm text-secondary-foreground">
                  <input type="checkbox" checked={englishListening} onChange={(e) => setEnglishListening(e.target.checked)} />
                  英语模板包含听力题 1-20
                </label>
              )}
              {selectedSubjectKey === "yuwen" && (
                <Field label="语文选择题位置" className="m-0">
                  <Select value={chineseChoicePlacement} onValueChange={(v) => setChineseChoicePlacement(v as "front" | "inline")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="front">统一放在卷首</SelectItem>
                      <SelectItem value="inline">按原题号分散</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
          )}

          {showCustom && (
            <Field label="手动填写科目名称" hint={customSubject.trim() ? `拼音 key: ${subjectToKey(customSubject.trim()) || "—"}` : undefined}>
              <Input
                value={customSubject}
                onChange={(e) => handleCustomSubjectChange(e.target.value)}
                placeholder="如：信息技术、日语、韩语..."
              />
            </Field>
          )}

          <Field label="答题卡纸型">
            <Select value={paperSize} onValueChange={(v) => setPaperSize(v as "A4" | "A3")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="A4">A4 纵向（210 × 297 mm）</SelectItem>
                <SelectItem value="A3">A3 横向三版（420 × 297 mm）</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="考试名称" required>
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (!examNameManual) setExamName(e.target.value);
              }}
              placeholder="如：2026 上学期期中考试"
            />
          </Field>

          <Field label="考试时间" required>
            <DatePicker value={examDate} onChange={setExamDate} />
          </Field>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-secondary-foreground">考试关联 <span className="text-xs font-normal text-muted-foreground">（可选）</span></span>
            <div className="flex gap-2">
              {(["none", "create", "link"] as const).map((value) => {
                const label = value === "none" ? "不关联" : value === "create" ? "同步创建" : "关联已有";
                const disabled = value === "link" && exams.length === 0;
                return (
                  <Button
                    key={value}
                    type="button"
                    variant={examAction === value ? "primary" : "outline"}
                    size="sm"
                    disabled={disabled}
                    onClick={() => {
                      setExamAction(value);
                      if (value === "create" && !examName) setExamName(title.trim());
                    }}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
            {examAction === "create" && (
              <div className="flex flex-col gap-2 rounded-lg bg-secondary p-3">
                <Input
                  value={examName}
                  onChange={(e) => { setExamName(e.target.value); setExamNameManual(true); }}
                  placeholder="考试名称（默认与答题卡标题一致）"
                />
                <span className="text-xs text-muted-foreground">
                  科目「{subjectLabel === "其他" ? (customSubject || "—") : subjectLabel}」从答题卡继承
                </span>
                {/* 评审 P1-2：同步创建考试需应考范围（年级或班级至少其一） */}
                <div className="flex flex-wrap gap-2">
                  <Select value={createGradeId} onValueChange={(v) => { setCreateGradeId(v); setCreateClassId("__none__"); }}>
                    <SelectTrigger className="w-40"><SelectValue placeholder="应考年级（必选其一）" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" disabled>应考年级（必选其一）</SelectItem>
                      {createGrades.map((g) => (<SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <Select value={createClassId} onValueChange={setCreateClassId} disabled={createClasses.length === 0}>
                    <SelectTrigger className="w-40"><SelectValue placeholder={createClasses.length === 0 ? "先选年级" : "应考班级（可选）"} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" disabled>应考班级（可选，不选=整个年级）</SelectItem>
                      {createClasses.map((c) => (<SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {examAction === "link" && (
              <Select value={linkExamId?.toString() ?? ""} onValueChange={(v) => setLinkExamId(v ? Number(v) : null)}>
                <SelectTrigger><SelectValue placeholder="— 请选择考试 —" /></SelectTrigger>
                <SelectContent>
                  {exams.map((exam) => (
                    <SelectItem key={exam.id} value={String(exam.id)}>
                      {exam.name}{exam.subject ? `（${exam.subject}）` : ""}{exam.card_id ? ` · 已关联卡 ${exam.card_id}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {error && <p className="text-sm text-destructive-fg">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleCreate}>创建答题卡</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
