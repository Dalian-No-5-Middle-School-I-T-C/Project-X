import { useRef, useState } from "react";
import { Upload, X, Download } from "lucide-react";
import { parseCsv, detectAndParse, readFileAsText, generateStudentTemplate, generateTeacherTemplate } from "../util/csvParser";

interface ImportModalProps {
  title: string;
  csvType: "student" | "teacher";
  onImport: (csvText: string) => Promise<void>;
  onClose: () => void;
}

export function ImportModal({ title, csvType, onImport, onClose }: ImportModalProps) {
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState<string[][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleTextChange(text: string) {
    setImportText(text);
    setResult("");
    try {
      const parsed = detectAndParse(text);
      if (parsed.error) {
        setError(parsed.error);
        setPreview([]);
      } else if (parsed.type !== csvType) {
        setError(`文件类型不匹配：预期${csvType === "student" ? "学生" : "教师"}CSV，检测为${parsed.type}`);
        setPreview([]);
      } else {
        setError("");
        setPreview(parsed.rows.filter((r) => r.some((c) => c.trim())));
      }
    } catch {
      setError("CSV 解析失败");
      setPreview([]);
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      setImportText(text);
      handleTextChange(text);
    } catch {
      setError("读取文件失败");
    }
  }

  function downloadTemplate() {
    const template = csvType === "student" ? generateStudentTemplate() : generateTeacherTemplate();
    const blob = new Blob(["\uFEFF" + template], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvType === "student" ? "student_template.csv" : "teacher_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    if (!importText.trim()) return;
    setBusy(true);
    setError("");
    setResult("");
    try {
      await onImport(importText);
      setResult("导入完成！");
      setImportText("");
      setPreview([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  const hint = csvType === "student"
    ? "格式：年级,班级,学号,姓名（可含表头）。账号自动生成 P+学号，密码=账号。"
    : "格式：科目,姓名（可含表头）。账号自动生成 T+6位随机数，密码为6位随机数字。";

  const placeholder = csvType === "student"
    ? "年级,班级,学号,姓名\n高一,高一1班,24101,张三\n高一,高一1班,24102,李四"
    : "科目,姓名\n物理,王建国\n数学,李芳";

  const previewCols = csvType === "student"
    ? ["年级", "班级", "学号", "姓名"]
    : ["科目", "姓名"];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: "95vw" }}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p className="hint">
            {hint}
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              type="file"
              ref={fileInputRef}
              accept=".csv,.txt,.xlsx,.xls"
              style={{ display: "none" }}
              onChange={handleFileSelect}
            />
            <button className="ghost-button" type="button" onClick={() => fileInputRef.current?.click()}>
              <Download size={16} /> 选择 CSV / Excel 文件
            </button>
            <button className="ghost-button" type="button" onClick={downloadTemplate}>
              <Download size={16} /> 下载模板
            </button>
          </div>
          <textarea
            rows={6}
            placeholder={placeholder}
            value={importText}
            onChange={(e) => handleTextChange(e.target.value)}
            style={{
              borderRadius: 10, padding: 10, border: "1px solid var(--line-strong)",
              fontSize: 13, fontFamily: "inherit", width: "100%", boxSizing: "border-box"
            }}
          />
          {error && <p className="login-error">{error}</p>}
          {result && <p className="hint" style={{ color: "var(--success)" }}>{result}</p>}
          {preview.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p className="hint">共解析 {preview.length} 条记录：</p>
              <div className="account-table-wrap" style={{ maxHeight: 200, overflow: "auto" }}>
                <table className="account-table">
                  <thead>
                    <tr>{previewCols.map((c) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.slice(0, 50).map((r, i) => (
                      <tr key={i}>{r.slice(0, previewCols.length).map((c, j) => <td key={j}>{c}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="ghost-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="button" onClick={handleImport} disabled={busy || !importText.trim() || preview.length === 0}>
            {busy ? "导入中..." : `确认导入 (${preview.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
