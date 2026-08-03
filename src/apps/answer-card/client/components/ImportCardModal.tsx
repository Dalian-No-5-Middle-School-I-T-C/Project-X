// ImportCardModal — 导入答题卡确认（v2 Dialog + Tailwind）
import { useEffect, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { SUBJECT_OPTIONS, subjectToKey } from "../../../../shared/pinyin";
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

export interface ImportCardFormData {
  subject: string;
  subjectLabel: string;
  title: string;
  examDate: string;
  examAction: "none" | "create" | "link";
  examName?: string;
  linkExamId?: number;
}

interface ExamOption {
  id: number;
  name: string;
  subject?: string | null;
}

interface Props {
  open: boolean;
  initialTitle: string;
  initialSubject: string;
  initialSubjectLabel: string;
  initialExamDate: string;
  exams: ExamOption[];
  onConfirm: (data: ImportCardFormData) => void;
  onClose: () => void;
}

function DatePicker({ value, onChange }: { value?: string; onChange: (d: string) => void }) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(value ? Number(value.slice(0, 4)) : today.getFullYear());
  const [viewMonth, setViewMonth] = useState(value ? Number(value.slice(5, 7)) - 1 : today.getMonth());
  const [manual, setManual] = useState(value ?? "");
  const [showCalendar, setShowCalendar] = useState(false);

  useEffect(() => { setManual(value ?? ""); }, [value]);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
  const days: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);

  function selectDay(day: number | null) {
    if (day === null) return;
    const dateStr = `${String(viewYear).padStart(4, "0")}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    onChange(dateStr);
    setManual(dateStr);
    setShowCalendar(false);
  }

  function prevMonth() { if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); } else setViewMonth(viewMonth - 1); }
  function nextMonth() { if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); } else setViewMonth(viewMonth + 1); }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <Input
          value={manual}
          onChange={(e) => {
            setManual(e.target.value);
            if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange(e.target.value);
          }}
          placeholder="YYYY-MM-DD"
          className="w-[150px] pr-9"
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
        <div className="absolute top-full left-0 z-(--px-z-dropdown) mt-1 w-[240px] rounded-lg border border-border-subtle bg-popover p-2 shadow-3">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" onClick={prevMonth} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"><ChevronLeft size={16} /></button>
            <span className="text-sm font-semibold text-foreground">{viewYear} 年 {viewMonth + 1} 月</span>
            <button type="button" onClick={nextMonth} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"><ChevronRight size={16} /></button>
          </div>
          <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-xs font-semibold text-muted-foreground">
            {["日", "一", "二", "三", "四", "五", "六"].map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {days.map((day, idx) => {
              const isSelected = day !== null && value === `${String(viewYear).padStart(4, "0")}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => selectDay(day)}
                  disabled={day === null}
                  className={cn(
                    "h-7 rounded-md text-xs transition-colors",
                    day === null && "invisible",
                    isSelected ? "bg-primary font-semibold text-primary-foreground" : "text-foreground hover:bg-secondary",
                  )}
                >
                  {day ?? ""}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function ImportCardModal({
  open, initialTitle, initialSubject, initialSubjectLabel, initialExamDate,
  exams, onConfirm, onClose
}: Props) {
  const [subject, setSubject] = useState(initialSubject);
  const [subjectLabel, setSubjectLabel] = useState(initialSubjectLabel);
  const [title, setTitle] = useState(initialTitle);
  const [examDate, setExamDate] = useState(initialExamDate || "");
  const [examAction, setExamAction] = useState<"none" | "create" | "link">("none");
  const [examName, setExamName] = useState("");
  const [linkExamId, setLinkExamId] = useState<number | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setSubject(initialSubject);
      setSubjectLabel(initialSubjectLabel);
      setTitle(initialTitle);
      setExamDate(initialExamDate || "");
      setExamAction("none");
      setExamName("");
      setLinkExamId(undefined);
      setErrors({});
    }
  }, [open, initialSubject, initialSubjectLabel, initialTitle, initialExamDate]);

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = "请输入考试名称";
    if (!examDate || !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) errs.examDate = "请选择考试日期";
    if (!subject) errs.subject = "请选择科目";
    if (examAction === "link" && !linkExamId) errs.linkExamId = "请选择关联的考试";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleConfirm() {
    if (!validate()) return;
    onConfirm({
      subject,
      subjectLabel,
      title: title.trim(),
      examDate,
      examAction,
      examName: examAction === "create" ? (examName?.trim() || title.trim()) : undefined,
      linkExamId: examAction === "link" ? linkExamId : undefined,
    });
  }

  function handleSubjectChange(label: string) {
    setSubjectLabel(label);
    setSubject(subjectToKey(label));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>导入答题卡 — 确认设置</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Field label="科目" error={errors.subject}>
            <Select value={subjectLabel} onValueChange={handleSubjectChange}>
              <SelectTrigger><SelectValue placeholder="请选择科目" /></SelectTrigger>
              <SelectContent>
                {SUBJECT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.key} value={opt.label}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="考试名称" error={errors.title} required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：2026上学期期中物理" />
          </Field>

          <Field label="考试日期" error={errors.examDate} required>
            <DatePicker value={examDate} onChange={setExamDate} />
          </Field>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-secondary-foreground">考试关联</span>
            <div className="flex flex-wrap gap-2">
              {(["none", "create", "link"] as const).map((value) => {
                const label = value === "none" ? "不创建" : value === "create" ? "创建考试" : "关联已有";
                return (
                  <Button
                    key={value}
                    type="button"
                    variant={examAction === value ? "primary" : "outline"}
                    size="sm"
                    onClick={() => setExamAction(value)}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
            {examAction === "create" && (
              <Input
                value={examName}
                onChange={(e) => setExamName(e.target.value)}
                placeholder={`留空则默认「${title.trim() || "同答题卡名称"}」`}
              />
            )}
            {examAction === "link" && (
              <Field error={errors.linkExamId}>
                <Select value={linkExamId?.toString() ?? ""} onValueChange={(v) => setLinkExamId(v ? Number(v) : undefined)}>
                  <SelectTrigger><SelectValue placeholder="选择已有考试..." /></SelectTrigger>
                  <SelectContent>
                    {exams.map((exam) => (
                      <SelectItem key={exam.id} value={String(exam.id)}>{exam.name} {exam.subject ? `(${exam.subject})` : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleConfirm}>确认导入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
