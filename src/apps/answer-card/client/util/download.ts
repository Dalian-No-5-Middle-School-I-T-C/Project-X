import { authFetch } from "../auth/api";
import { csvCell } from "../../../../shared/csv";

/** 带鉴权下载（authFetch → blob → 模拟点击），XLSX/PDF 等二进制导出用。 */
export async function downloadBlob(url: string, filename: string): Promise<void> {
  const resp = await authFetch(url);
  if (!resp.ok) throw new Error(`下载失败（${resp.status}）`);
  const blob = await resp.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

/**
 * 纯前端 CSV 导出（临界生名单等轻量场景）。
 *
 * 安全（R17）：字段一律走 `src/shared/csv.ts` 的 `csvCell`——与服务端名册导出同一套口径。
 * 此前的本地 `esc` 只处理引号/逗号/换行，姓名或班级里出现 `=cmd|...`、`@SUM(...)`、
 * `1-2` 这类前缀时，Excel/WPS 打开会把它当公式执行；临界生名单正是「从别的系统导入再导出」
 * 的链路，字段来源不完全可控。
 */
export function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number>>): void {
  const content = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + content], { type: "text/csv;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
