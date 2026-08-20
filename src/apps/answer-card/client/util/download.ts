import { authFetch } from "../auth/api";

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

/** 纯前端 CSV 导出（临界生名单等轻量场景）。 */
export function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number>>): void {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const content = [header, ...rows].map((row) => row.map(esc).join(",")).join("\n");
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
