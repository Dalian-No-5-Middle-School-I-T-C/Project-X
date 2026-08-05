import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { parseCsv, detectAndParse, readFileAsText, generateStudentTemplate, generateTeacherTemplate } from "../util/csvParser";
import {
  Button,
  Textarea,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  TableWrap,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./ui/v2";

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleTextChange(text: string) {
    setImportText(text);
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

  async function downloadTemplate() {
    const blob = csvType === "student"
      ? await generateStudentTemplate()
      : await generateTeacherTemplate();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvType === "student" ? "student_template.xlsx" : "teacher_template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    if (!importText.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onImport(importText);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  const hint = csvType === "student"
    ? "格式：班级(几年几班),学号,姓名（可含表头）。账号自动生成 P+学号，密码=账号。"
    : "格式：科目,姓名（可含表头）。账号自动生成 T+6位随机数，密码为6位随机数字。";

  const placeholder = csvType === "student"
    ? "班级,学号,姓名\n高一1班,24101,张三\n高一2班,24201,李四"
    : "科目,姓名\n物理,王建国\n数学,李芳";

  const previewCols = csvType === "student"
    ? ["班级", "学号", "姓名"]
    : ["科目", "姓名"];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{hint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              accept=".csv,.txt,.xlsx,.xls"
              className="hidden"
              onChange={handleFileSelect}
            />
            <Button variant="outline" size="sm" icon={<Download size={16} />} onClick={() => fileInputRef.current?.click()}>
              选择 CSV / Excel 文件
            </Button>
            <Button variant="outline" size="sm" icon={<Download size={16} />} onClick={() => void downloadTemplate()}>
              下载 Excel 模板
            </Button>
          </div>
          <Textarea
            rows={6}
            placeholder={placeholder}
            value={importText}
            onChange={(e) => handleTextChange(e.target.value)}
          />
          {error && <p className="text-sm text-destructive-fg">{error}</p>}
          {preview.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">共解析 {preview.length} 条记录：</p>
              <TableWrap className="max-h-[200px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {previewCols.map((c) => <TableHead key={c}>{c}</TableHead>)}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.slice(0, 50).map((r, i) => (
                      <TableRow key={i}>
                        {r.slice(0, previewCols.length).map((c, j) => <TableCell key={j}>{c}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={busy || !importText.trim() || preview.length === 0}
          >
            {busy ? "导入中..." : `确认导入 (${preview.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
