import { useEffect, useState } from "react";
import { X, ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { SUBJECT_OPTIONS, subjectToKey, isPredefinedSubject } from "../../../../shared/pinyin";

export interface NewCardFormData {
  subject: string;
  subjectLabel: string;
  title: string;
  examDate: string;
  examAction: "none" | "create" | "link";
  examName?: string;
  linkExamId?: number;
  englishListening?: boolean;
  chineseChoicePlacement?: "front" | "inline";
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
  exams?: ExamOption[];   // 已有考试列表（用于"关联已有"）
}

/**
 * 简易日历日期选择器（内联组件）
 */
const EXAM_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_EXAM_YEAR = 1900;
const MAX_EXAM_YEAR = 2100;

function isValidExamDate(value: string): boolean {
  const match = EXAM_DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_EXAM_YEAR || year > MAX_EXAM_YEAR || month < 1 || month > 12 || day < 1) {
    return false;
  }

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
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);

  function selectDay(day: number | null) {
    if (day === null) return;
    const yyyy = String(viewYear).padStart(4, "0");
    const mm = String(viewMonth + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    if (!isValidExamDate(dateStr)) return;
    onChange(dateStr);
    setManual(dateStr);
    setShowCalendar(false);
  }

  function handleManualChange(text: string) {
    setManual(text);
    if (isValidExamDate(text)) {
      onChange(text);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          value={manual}
          onChange={(e) => handleManualChange(e.target.value)}
          onBlur={() => {
            if (manual && !isValidExamDate(manual)) {
              setManual(value ?? "");
            }
          }}
          placeholder="YYYY-MM-DD（如 2026-06-14）"
          style={{ width: "100%", paddingRight: 36 }}
        />
        <button
          type="button"
          onClick={() => setShowCalendar(!showCalendar)}
          style={{
            position: "absolute",
            right: 2,
            top: 2,
            width: 34,
            height: 34,
            display: "grid",
            placeItems: "center",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            borderRadius: 6,
            color: "var(--text-secondary)"
          }}
        >
          <Calendar size={18} />
        </button>
      </div>

      {showCalendar && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 100,
            background: "#fff",
            border: "1px solid var(--line-strong)",
            borderRadius: 12,
            boxShadow: "0 12px 40px rgba(0,0,0,0.12)",
            padding: 16,
            marginTop: 4,
            width: 280
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => {
                if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
                else setViewMonth(viewMonth - 1);
              }}
              style={{ border: "none", background: "transparent", cursor: "pointer", padding: 4, borderRadius: 6 }}
            >
              <ChevronLeft size={18} />
            </button>
            <strong style={{ fontSize: 14 }}>{viewYear} 年 {viewMonth + 1} 月</strong>
            <button
              type="button"
              onClick={() => {
                if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
                else setViewMonth(viewMonth + 1);
              }}
              style={{ border: "none", background: "transparent", cursor: "pointer", padding: 4, borderRadius: 6 }}
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, textAlign: "center", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>
            {["日", "一", "二", "三", "四", "五", "六"].map((d) => (<div key={d}>{d}</div>))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, textAlign: "center" }}>
            {days.map((day, i) => {
              const isToday = day !== null && viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();
              const isSelected = day !== null && value === `${String(viewYear).padStart(4, "0")}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => selectDay(day)}
                  disabled={day === null}
                  style={{
                    width: 32,
                    height: 32,
                    border: isSelected ? "2px solid var(--brand)" : "1px solid transparent",
                    borderRadius: 8,
                    background: isSelected ? "var(--brand-soft)" : isToday ? "var(--surface-raised)" : "transparent",
                    fontWeight: isToday ? 700 : 400,
                    fontSize: 13,
                    cursor: day !== null ? "pointer" : "default",
                    color: day !== null ? "var(--text)" : "transparent",
                    transition: "all 0.15s"
                  }}
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
  const [subjectLabel, setSubjectLabel] = useState("物理"); // 默认
  const [showCustom, setShowCustom] = useState(false);
  const [customSubject, setCustomSubject] = useState("");
  const [title, setTitle] = useState("");
  const [examDate, setExamDate] = useState("");
  const [error, setError] = useState("");

  // 考试关联
  const [examAction, setExamAction] = useState<"none" | "create" | "link">("none");
  const [examName, setExamName] = useState("");
  const [linkExamId, setLinkExamId] = useState<number | null>(null);
  const [examNameManual, setExamNameManual] = useState(false);  // 用户是否手动改过考试名

  const [englishListening, setEnglishListening] = useState(true);
  const [chineseChoicePlacement, setChineseChoicePlacement] = useState<"front" | "inline">("front");
  if (!open) return null;

  function handleSubjectSelect(label: string) {
    setSubjectLabel(label);
    if (label === "其他") {
      setShowCustom(true);
    } else {
      setShowCustom(false);
      setCustomSubject("");
    }
  }

  function handleCreate() {
    const finalLabel = subjectLabel === "其他" ? customSubject.trim() : subjectLabel;
    if (!finalLabel) {
      setError("请选择科目或手动输入科目名");
      return;
    }
    const titleTrimmed = title.trim();
    if (!titleTrimmed) {
      setError("请输入考试名称（题目）");
      return;
    }
    // 校验考试关联
    if (examAction === "create" && !examName.trim()) {
      setError("请输入关联考试的考试名称");
      return;
    }
    if (examAction === "link" && !linkExamId) {
      setError("请选择要关联的已有考试");
      return;
    }
    const normalizedExamDate = examDate.trim();
    if (!normalizedExamDate) {
      setError("请选择考试时间");
      return;
    }
    if (!isValidExamDate(normalizedExamDate)) {
      setError(`请输入 ${MIN_EXAM_YEAR}-${MAX_EXAM_YEAR} 范围内的有效考试时间（YYYY-MM-DD）`);
      return;
    }
    const key = subjectToKey(finalLabel);
    onCreate({
      subject: key,
      subjectLabel: finalLabel,
      title: titleTrimmed,
      examDate: normalizedExamDate,
      examAction,
      examName: examAction === "create" ? examName.trim() || titleTrimmed : undefined,
      linkExamId: examAction === "link" && linkExamId ? linkExamId : undefined,
      englishListening,
      chineseChoicePlacement
    });
    // 重置状态
    setSubjectLabel("物理");
    setShowCustom(false);
    setCustomSubject("");
    setTitle("");
    setExamDate("");
    setExamAction("none");
    setExamName("");
    setLinkExamId(null);
    setExamNameManual(false);
    setEnglishListening(true);
    setChineseChoicePlacement("front");
    setError("");
  }

  // 当通过"其他"手动输入的内容命中预定义科目时，自动归类
  function handleCustomSubjectChange(text: string) {
    setCustomSubject(text);
    if (isPredefinedSubject(text.trim())) {
      setSubjectLabel(text.trim());
      setShowCustom(false);
      setCustomSubject("");
    }
  }

  const selectedSubjectKey = subjectToKey(showCustom ? customSubject.trim() : subjectLabel);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 440, maxWidth: "calc(100vw - 40px)" }}
      >
        <div className="modal-header">
          <h2>新建答题卡</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>

        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* 科目选择 */}
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>科目 <span style={{ color: "var(--brand)" }}>*</span></span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {SUBJECT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => handleSubjectSelect(opt.label)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    border: subjectLabel === opt.label && !showCustom ? "2px solid var(--brand)" : "1px solid var(--line-strong)",
                    background: subjectLabel === opt.label && !showCustom ? "var(--brand-soft)" : "#fff",
                    fontWeight: subjectLabel === opt.label && !showCustom ? 600 : 400,
                    cursor: "pointer",
                    fontSize: 14,
                    transition: "all 0.15s",
                    color: "var(--text)"
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </label>

          {/* 手动填写科目（选择"其他"时显示） */}
          {(selectedSubjectKey === "yingyu" || selectedSubjectKey === "waiyu" || selectedSubjectKey === "yuwen") && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>模板选项</span>
              {(selectedSubjectKey === "yingyu" || selectedSubjectKey === "waiyu") && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={englishListening} onChange={(event) => setEnglishListening(event.target.checked)} />
                  英语模板包含听力题 1-20
                </label>
              )}
              {selectedSubjectKey === "yuwen" && (
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>语文选择题位置</span>
                  <select value={chineseChoicePlacement} onChange={(event) => setChineseChoicePlacement(event.target.value as "front" | "inline")}>
                    <option value="front">统一放在卷首</option>
                    <option value="inline">按原题号分散</option>
                  </select>
                </label>
              )}
            </div>
          )}

          {showCustom && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>手动填写科目名称</span>
              <input
                value={customSubject}
                onChange={(e) => handleCustomSubjectChange(e.target.value)}
                placeholder="如：信息技术、日语、韩语..."
              />
              {customSubject.trim() && <span style={{ fontSize: 11, color: "var(--muted)" }}>拼音 key: {subjectToKey(customSubject.trim()) || "—"}</span>}
            </label>
          )}

          {/* 考试名称 */}
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>考试名称 <span style={{ color: "var(--brand)" }}>*</span></span>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                // 考试名称跟随标题联动（除非用户手动改过）
                if (!examNameManual) setExamName(e.target.value);
              }}
              placeholder="如：2026 上学期期中考试"
            />
          </label>

          {/* 考试时间（必填） */}
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>考试时间 <span style={{ color: "var(--brand)" }}>*</span></span>
            <DatePicker value={examDate} onChange={setExamDate} />
          </label>

          {/* 考试关联（可选） */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
              考试关联 <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>（可选）</span>
            </span>

            {/* 三选一 radio — 紧凑单行 */}
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {([
                ["none", "不关联"],
                ["create", "同步创建"],
                ["link", "关联已有"]
              ] as const).map(([value, label]) => {
                const isSelected = examAction === value;
                const isDisabled = value === "link" && exams.length === 0;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => {
                      if (value === "none") setExamAction("none");
                      else if (value === "create") { setExamAction("create"); if (!examName) setExamName(title.trim()); }
                      else setExamAction("link");
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "3px 10px",
                      border: isSelected ? "1.5px solid var(--brand)" : "1px solid var(--line-strong)",
                      borderRadius: 14,
                      background: isSelected ? "var(--brand-soft)" : "transparent",
                      color: isSelected ? "var(--brand)" : "var(--text-secondary)",
                      fontSize: 12,
                      fontWeight: isSelected ? 600 : 400,
                      cursor: isDisabled ? "not-allowed" : "pointer",
                      opacity: isDisabled ? 0.4 : 1,
                      transition: "all 0.15s",
                      lineHeight: 1.4
                    }}
                  >
                    {isSelected && (
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--brand)", flexShrink: 0 }} />
                    )}
                    {label}
                  </button>
                );
              })}
            </div>

            {/* 操作区：根据选中项显示 */}
            {examAction === "create" && (
              <div style={{ background: "var(--surface-soft)", borderRadius: 8, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
                <input
                  value={examName}
                  onChange={(e) => { setExamName(e.target.value); setExamNameManual(true); }}
                  placeholder="考试名称（默认与答题卡标题一致）"
                  style={{ padding: "4px 8px", border: "1px solid var(--line-strong)", borderRadius: 6, fontSize: 12 }}
                />
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  科目「{subjectLabel === "其他" ? (customSubject || "—") : subjectLabel}」从答题卡继承
                </span>
              </div>
            )}

            {examAction === "link" && (
              <div style={{ background: "var(--surface-soft)", borderRadius: 8, padding: "8px 10px" }}>
                <select
                  value={linkExamId ?? ""}
                  onChange={(e) => setLinkExamId(e.target.value ? Number(e.target.value) : null)}
                  style={{ width: "100%", padding: "4px 8px", border: "1px solid var(--line-strong)", borderRadius: 6, fontSize: 12 }}
                >
                  <option value="">— 请选择考试 —</option>
                  {exams.map((exam) => (
                    <option key={exam.id} value={exam.id}>
                      {exam.name}{exam.subject ? `（${exam.subject}）` : ""}{exam.card_id ? ` · 已关联卡 ${exam.card_id}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {error && <p style={{ color: "var(--brand)", fontSize: 13, margin: 0 }}>{error}</p>}
        </div>

        <div className="modal-footer" style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
          <button className="ghost-button" onClick={onClose}>取消</button>
          <button className="primary-button" onClick={handleCreate}>创建答题卡</button>
        </div>
      </div>
    </div>
  );
}
