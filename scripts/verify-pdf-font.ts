import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createDefaultCard } from "../src/shared/defaultCard";
import { createPdf, fontFileSupportsCjk } from "../src/apps/answer-card/server/pdf";

async function pdfBuffer(): Promise<Buffer> {
  const card = createDefaultCard("90000001", "font-test");
  card.title = "中文答题卡字体回归";
  const doc = createPdf(card);
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

const nonCjkCandidates = [
  "C:\\Windows\\Fonts\\DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
];
for (const candidate of nonCjkCandidates) {
  if (!existsSync(candidate)) continue;
  assert.equal(fontFileSupportsCjk(candidate), false, `非中文字体不得被 PDF 导出器接受: ${candidate}`);
}

const buffer = await pdfBuffer();
const pdfSource = buffer.toString("latin1");
assert.match(pdfSource, /\/BaseFont \/[^\s]*(?:Noto|SimSun|YaHei|Hei|PingFang|WenQuanYi|WQY|UMing)/i, "PDF 未嵌入已验证的中文字体");
assert.doesNotMatch(pdfSource, /\/BaseFont \/[^\s]*DejaVuSans/i, "DejaVu Sans 不得再被当作中文字体嵌入");
if (process.argv[2]) await writeFile(process.argv[2], buffer);
console.log(`PDF 中文字体验证通过（${buffer.length} bytes）`);
