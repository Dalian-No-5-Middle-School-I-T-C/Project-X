import { useRef, useState } from "react";
import { Download } from "lucide-react";
import type { CsvImportResult, CsvRowError } from "../auth/types";
import { csvCell } from "../../../../shared/csv";
import { detectAndParse, readFileAsText, generateStudentTemplate, generateTeacherTemplate } from "../util/csvParser";
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
  onImport: (csvText: string) => Promise<CsvImportResult>;
  onClose: () => void;
}

function errorText(errors: CsvRowError[]): string {
  return ["行号,原始内容,错误原因", ...errors.map((item) => [item.rowNumber, item.row.join(" | "), item.message].map(csvCell).join(","))].join("\n");
}

export function ImportModal({ title, csvType, onImport, onClose }: ImportModalProps) {
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState<string[][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CsvImportResult | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleTextChange(text: string) {
    setImportText(text);
    setResult(null);
    setActionMessage("");
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
      handleTextChange(text);
    } catch {
      setError("读取文件失败");
    } finally {
      e.target.value = "";
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
    if (!importText.trim() || busy) return;
    setBusy(true);
    setError("");
    setActionMessage("");
    try {
      setResult(await onImport(importText));
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  const hint = csvType === "student"
    ? "格式：班级,学号,姓名,文理（文理可空）。账号自动生成为 P+学号，初始密码由系统随机生成。"
    : "格式：科目,姓名（可含表头）。账号自动生成 T+6位随机数，密码为6位随机数字。";

  const placeholder = csvType === "student"
    ? "班级,学号,姓名,文理\n高一1班,24101,张三,理科\n高一2班,24201,李四,文科"
    : "科目,姓名\n物理,王建国\n数学,李芳";

  const previewCols = csvType === "student"
    ? ["班级", "学号", "姓名", "文理"]
    : ["科目", "姓名"];
  const summary = result ? (csvType === "student" ? result.students : result.teachers) : null;
  const errors = result ? [...result.students.errors, ...result.teachers.errors] : [];
  const accounts = result
    ? [
      ...(result.students.createdAccounts ?? []).map((account) => ({ ...account, studentNumber: account.studentNumber })),
      ...(result.teachers.createdAccounts ?? []).map((account) => ({ ...account, studentNumber: "" })),
    ]
    : [];

  function downloadErrors() {
    const blob = new Blob(["\uFEFF" + errorText(errors)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "import-errors.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="lg">
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
              onChange={(event) => void handleFileSelect(event)}
            />
            <Button variant="outline" size="sm" icon={<Download size={16} />} onClick={() => fileInputRef.current?.click()} disabled={busy}>
              选择 CSV / Excel 文件
            </Button>
            <Button variant="outline" size="sm" icon={<Download size={16} />} onClick={() => void downloadTemplate()} disabled={busy}>
              下载 Excel 模板
            </Button>
          </div>
          <Textarea
            rows={6}
            placeholder={placeholder}
            value={importText}
            onChange={(e) => handleTextChange(e.target.value)}
            disabled={busy}
          />
          {error && <p role="alert" className="text-sm text-destructive-fg">{error}</p>}
          {actionMessage && <p role="status" className="text-sm text-success-foreground">{actionMessage}</p>}
          {preview.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">共解析 {preview.length} 条记录：</p>
              <TableWrap className="max-h-[200px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {previewCols.map((column) => <TableHead key={column}>{column}</TableHead>)}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.slice(0, 50).map((row, index) => (
                      <TableRow key={index}>
                        {row.slice(0, previewCols.length).map((cell, columnIndex) => <TableCell key={columnIndex}>{cell}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            </div>
          )}
          {result && summary && (
            <div className="flex flex-col gap-3 rounded-md border border-border-subtle bg-muted/30 p-3">
              <p className="m-0 text-sm font-medium text-foreground">
                导入完成：新增 {summary.created}，{csvType === "student" ? `关联已有学生 ${result.students.linked}，` : ""}跳过 {summary.skipped}，错误 {errors.length}。
              </p>
              {accounts.length > 0 && (
                <div className="max-h-52 overflow-auto">
                  <TableWrap>
                    <Table>
                      <TableHeader><TableRow><TableHead>原始行号</TableHead><TableHead>姓名</TableHead><TableHead>账号</TableHead><TableHead>一次性初始密码</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {accounts.map((account) => (
                          <TableRow key={`${account.username}-${account.rowNumber}`}>
                            <TableCell>{account.rowNumber}</TableCell><TableCell>{account.name}</TableCell><TableCell>{account.username}</TableCell><TableCell className="font-mono">{account.initialPassword}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableWrap>
                </div>
              )}
              {errors.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(errorText(errors)).then(() => setActionMessage("错误列表已复制")).catch((copyError: unknown) => setError(copyError instanceof Error ? copyError.message : "复制失败"))}>复制错误列表</Button>
                    <Button variant="outline" size="sm" icon={<Download size={16} />} onClick={downloadErrors}>下载错误列表</Button>
                  </div>
                  <TableWrap className="max-h-52">
                    <Table>
                      <TableHeader><TableRow><TableHead>原始行号</TableHead><TableHead>原始内容</TableHead><TableHead>错误原因</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {errors.map((item, index) => (
                          <TableRow key={`${item.rowNumber}-${index}`}>
                            <TableCell>{item.rowNumber}</TableCell><TableCell className="max-w-72 break-all">{item.row.join(" | ")}</TableCell><TableCell>{item.message}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableWrap>
                </div>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{result ? "完成" : "取消"}</Button>
          <Button
            variant="primary"
            onClick={() => void handleImport()}
            loading={busy}
            disabled={busy || !importText.trim() || preview.length === 0}
          >
            确认导入 ({preview.length})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
