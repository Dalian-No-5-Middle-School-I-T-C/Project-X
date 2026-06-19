import { useEffect, useState } from "react";
import { X, ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { SUBJECT_OPTIONS, subjectToKey } from "../../../../shared/pinyin";

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

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);

  function selectDay(day: number | null) {
    if (day === null) return;
    const yyyy = String(viewYear).padStart(4, "0");
    const mm = String(viewMonth + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    onChange(dateStr);
    setManual(dateStr);
    setShowCalendar(false);
  }

  function prevMonth() { if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); } else setViewMonth(viewMonth - 1); }
  function nextMonth() { if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); } else setViewMonth(viewMonth + 1); }

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          value={manual}
          onChange={(e) => {
            setManual(e.target.value);
            if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange(e.target.value);
          }}
          onFocus={() => setShowCalendar(true)}
          placeholder="YYYY-MM-DD"
          style={{
            width: 130, padding: "6px 10px", borderRadius: 8,
            border: "1px solid var(--line-strong)", fontSize: 13, background: "#fff"
          }}
        />
        <button
          type="button"
          onClick={() => setShowCalendar(!showCalendar)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)", padding: 4 }}
        >
          <Calendar size={16} />
        </button>
      </div>
      {showCalendar && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 100,
          background: "#fff", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          border: "1px solid var(--line)", padding: 10, width: 240, marginTop: 4
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <button type="button" onClick={prevMonth} style={{ background: "none", border: "none", cursor: "pointer" }}><ChevronLeft size={14} /></button>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{viewYear} 年 {viewMonth + 1} 月</span>
            <button type="button" onClick={nextMonth} style={{ background: "none", border: "none", cursor: "pointer" }}><ChevronRight size={14} /></button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, textAlign: "center" }}>
            {["日","一","二","三","四","五","六"].map((d) => (
              <span key={d} style={{ fontSize: 11, color: "var(--muted)", padding: "2px 0" }}>{d}</span>
            ))}
            {days.map((day, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => selectDay(day)}
                disabled={day === null}
                style={{
                  padding: "4px 0", fontSize: 12, borderRadius: 6, border: "none",
                  background: day !== null && value === `${String(viewYear).padStart(4,"0")}-${String(viewMonth+1).padStart(2,"0")}-${String(day).padStart(2,"0")}` ? "var(--brand)" : "transparent",
                  color: day !== null && value === `${String(viewYear).padStart(4,"0")}-${String(viewMonth+1).padStart(2,"0")}-${String(day).padStart(2,"0")}` ? "#fff" : "var(--text-primary)",
                  cursor: day !== null ? "pointer" : "default"
                }}
              >
                {day ?? ""}
              </button>
            ))}
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

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

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
      linkExamId: examAction === "link" ? linkExamId : undefined
    });
  }

  function handleSubjectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const label = e.target.value;
    setSubjectLabel(label);
    setSubject(subjectToKey(label));
  }

  if (!open) return null;

  return (
    <div className="pdf-modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 480, maxWidth: "calc(100vw - 40px)", maxHeight: "90vh", overflowY: "auto" }}>
        <div className="modal-header">
          <h2>导入答题卡 — 确认设置</h2>
          <button className="modal-close" type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          {/* 科目 */}
          <label style={{ display: "block", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>科目</span>
            <select
              value={subjectLabel}
              onChange={handleSubjectChange}
              style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: `1px solid ${errors.subject ? "#A32D2D" : "var(--line-strong)"}`, fontSize: 13, background: "#fff" }}
            >
              <option value="">请选择科目</option>
              {SUBJECT_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.label}>{opt.label}</option>
              ))}
            </select>
            {errors.subject && <span style={{ color: "#A32D2D", fontSize: 11 }}>{errors.subject}</span>}
          </label>

          {/* 标题 */}
          <label style={{ display: "block", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>考试名称</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：2026上学期期中物理"
              style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: `1px solid ${errors.title ? "#A32D2D" : "var(--line-strong)"}`, fontSize: 13, background: "#fff", boxSizing: "border-box" }}
            />
            {errors.title && <span style={{ color: "#A32D2D", fontSize: 11 }}>{errors.title}</span>}
          </label>

          {/* 考试日期 */}
          <label style={{ display: "block", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>
              考试日期 <span style={{ color: "#A32D2D" }}>*</span>
            </span>
            <DatePicker value={examDate} onChange={setExamDate} />
            {errors.examDate && <span style={{ color: "#A32D2D", fontSize: 11 }}>{errors.examDate}</span>}
          </label>

          {/* 考试关联 */}
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 8 }}>考试关联</span>
            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
                <input type="radio" name="examAction" checked={examAction === "none"} onChange={() => setExamAction("none")} />
                不创建
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
                <input type="radio" name="examAction" checked={examAction === "create"} onChange={() => setExamAction("create")} />
                创建考试
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
                <input type="radio" name="examAction" checked={examAction === "link"} onChange={() => setExamAction("link")} />
                关联已有
              </label>
            </div>

            {examAction === "create" && (
              <div style={{ marginTop: 8 }}>
                <input
                  type="text"
                  value={examName}
                  onChange={(e) => setExamName(e.target.value)}
                  placeholder={`留空则默认「${title.trim() || "同答题卡名称"}」`}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 13, background: "#fff", boxSizing: "border-box" }}
                />
              </div>
            )}

            {examAction === "link" && (
              <div style={{ marginTop: 8 }}>
                <select
                  value={linkExamId ?? ""}
                  onChange={(e) => setLinkExamId(e.target.value ? Number(e.target.value) : undefined)}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: `1px solid ${errors.linkExamId ? "#A32D2D" : "var(--line-strong)"}`, fontSize: 13, background: "#fff" }}
                >
                  <option value="">选择已有考试...</option>
                  {exams.map((exam) => (
                    <option key={exam.id} value={exam.id}>{exam.name} {exam.subject ? `(${exam.subject})` : ""}</option>
                  ))}
                </select>
                {errors.linkExamId && <span style={{ color: "#A32D2D", fontSize: 11 }}>{errors.linkExamId}</span>}
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="ghost-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="button" onClick={handleConfirm}>确认导入</button>
        </div>
      </div>
    </div>
  );
}
