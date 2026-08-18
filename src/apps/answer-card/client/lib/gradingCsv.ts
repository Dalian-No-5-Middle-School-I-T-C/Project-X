import { csvCell } from "../../../../shared/csv";
import type { CombinedGradingRow } from "../../../../shared/types";

/** 前导制表符阻止 Excel 将 "8/10"、"3/4" 识别为日期。 */
export function csvTextCell(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  if (/^\d{1,2}\/\d{1,2}$/.test(text) || /^\d{1,2}-\d{1,2}$/.test(text)) {
    return `\t${text}`;
  }
  return text;
}

/** 识别成绩表导出 CSV（BOM + 统一转义/公式注入防御，与名册导出共用 src/shared/csv.ts）。 */
export function downloadGradingCsv(rows: CombinedGradingRow[], cardId: string): void {
  const header = ["文件名", "学号", "识别状态", "总分", "满分", "客观题得分", "主观题得分", "待复核题数", "异常数", "备注"];
  const lines = [
    header,
    ...rows.map((row) => [
      row.fileName,
      row.studentId ?? "未识别",
      row.recognitionStatus,
      String(row.totalScore),
      String(row.totalMaxScore),
      csvTextCell(`${row.objectiveScore}/${row.objectiveMaxScore}`),
      csvTextCell(`${row.subjectiveScore}/${row.subjectiveMaxScore}`),
      String(row.needsReviewCount),
      String(row.issueCount),
      row.message ?? ""
    ])
  ];
  const csv = lines.map((line) => line.map(csvCell).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `成绩表_${cardId}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
