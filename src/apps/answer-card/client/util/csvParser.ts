/**
 * CSV/Excel 解析工具
 * 支持 .csv 文本、.tsv 文本、.xlsx 文件
 * 自动识别表头类型（学生/教师）
 */

export interface ParsedCsvResult {
  type: "student" | "teacher" | "unknown";
  header: string[];
  rows: string[][];
  error?: string;
}

/** 解析 CSV 文本为二维数组 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    const sep = line.includes(",") ? "," : "\t";
    const cells: string[] = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cell += '"'; i++; }
          else { inQuotes = false; }
        } else { cell += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === sep) { cells.push(cell.trim()); cell = ""; }
        else { cell += ch; }
      }
    }
    cells.push(cell.trim());
    rows.push(cells);
  }
  return rows;
}

/** 检测 CSV 类型并提取结构化数据 */
export function detectAndParse(text: string): ParsedCsvResult {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { type: "unknown", header: [], rows: [], error: "CSV 至少需要表头 + 1 行数据" };
  }

  const header = rows[0].map((c) => c.toLowerCase().replace(/[_\s]+/g, ""));
  const hasGrade = header.some((h) => /年级|grade/.test(h));
  const hasClass = header.some((h) => /班级|class/.test(h));
  const hasSubject = header.some((h) => /科目|subject/.test(h));

  if (hasGrade || hasClass) {
    return { type: "student", header: rows[0], rows: rows.slice(1) };
  }
  if (hasSubject && !hasGrade && !hasClass) {
    return { type: "teacher", header: rows[0], rows: rows.slice(1) };
  }
  return { type: "unknown", header: rows[0], rows: rows.slice(1), error: "无法识别 CSV 类型" };
}

/** 读取文件并返回文本（支持 .csv,.txt,.xlsx,.xls） */
export async function readFileAsText(file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "xlsx" || ext === "xls") {
    return readExcelFile(file);
  }
  // CSV / TXT
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsText(file);
  });
}

/** 读取 Excel 文件为 CSV 文本 */
async function readExcelFile(file: File): Promise<string> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: true });
  // 将所有单元格转字符串，避免数字/日期问题
  return rows.map((r) => r.map((c) => String(c ?? "")).join(",")).join("\n");
}

/** 生成学生模板 CSV */
export function generateStudentTemplate(): string {
  return "年级,班级,学号,姓名\n高一,高一1班,24101,张三\n高一,高一1班,24102,李四\n";
}

/** 生成教师模板 CSV */
export function generateTeacherTemplate(): string {
  return "科目,姓名\n物理,王建国\n数学,李芳\n";
}
