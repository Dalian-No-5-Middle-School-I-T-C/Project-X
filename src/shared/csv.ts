/**
 * CSV 单元格统一转义（服务端名册导出与客户端成绩导出共用一套标准）：
 * - 前导制表符阻止 Excel 把 "8/10"、"3-4" 识别成日期；
 * - 以 = + - @ TAB CR 开头的值加单引号防公式注入；
 * - 双引号转义为 ""，整格加引号。
 */
export function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? "" : String(value);
  const withTab = /^\d{1,2}\/\d{1,2}$/.test(text) || /^\d{1,2}-\d{1,2}$/.test(text)
    ? `\t${text}`
    : text;
  const safe = /^[=+\-@\t\r]/.test(withTab) ? `'${withTab}` : withTab;
  return `"${safe.replace(/"/g, '""')}"`;
}
