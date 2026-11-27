import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MAX_ANSWER_TEXT_LENGTH, parseAnswerKeyText } from "../src/apps/answer-card/server/answer-key-ocr";
import { compressImage, imageToPdf } from "../src/apps/answer-card/server/paper-converter";
import { extractPdfText } from "../src/apps/answer-card/server/paper-ocr";
import { isVisionProvider } from "../src/apps/answer-card/server/llm-capabilities";
import { getKnowledgePointProvider } from "../src/apps/answer-card/server/paper-ai-provider";
import type { DbAdapter } from "../src/server/db/mysql";

type Check = (condition: boolean, label: string) => void;

// Standard Chinese composite font with an external predefined CMap. No system font dependency.
function cjkPdfFixture(): Buffer {
  const content = "BT /F1 16 Tf 30 90 Td <7b546848> Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /FontDescriptor 7 0 R /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii");
}

export async function verifyPaperOcrInputs(dir: string, ok: Check): Promise<void> {
  const options = parseAnswerKeyText([
    "1-5 B A C D B 6—8 DCB",
    "9～10 C，A",
    "11至15 A、B、C、D、A",
    "16–18 AB；ACD;BD",
    "题号 19 20 21 22 23",
    "答案 A B C D A",
    "24 A 25 B 26 C",
  ].join("\n"));
  ok(isDeepStrictEqual(options.map(d => [d.questionNumber, d.answerText]),
    ["B", "A", "C", "D", "B", "D", "C", "B", "C", "A", "A", "B", "C", "D", "A",
      "AB", "ACD", "BD", "A", "B", "C", "D", "A", "A", "B", "C"].map((value, index) => [index + 1, value])),
  "区间、混合分隔符、两行表格和逐题选项均按题号展开，多选保留同一题");

  const math = parseAnswerKeyText([
    "二、解答题",
    "第12题：3.14，比例为 1:2，9:30 开始。(1)(2) 见下文。",
    "(1) 12.56 是周长。",
    "（2）取 x = 2.5",
    "① 已知质量不变",
    "② 代入公式 |x| ~ 2",
    "3.14 参与后续计算。",
    "1:2 为最终比值。",
    "9:30 验证结果。",
    "13．单独作答",
    "第二行继续推导",
    "三、计算题",
    "小标题后的说明",
    "14: 最后的答案",
  ].join("\n"));
  ok(isDeepStrictEqual(math.map(d => [d.questionNumber, d.answerText]), [
    [12, "3.14，比例为 1:2，9:30 开始。(1)(2) 见下文。 (1) 12.56 是周长。 （2）取 x = 2.5 ① 已知质量不变 ② 代入公式 |x| ~ 2 3.14 参与后续计算。 1:2 为最终比值。 9:30 验证结果。"],
    [13, "单独作答 第二行继续推导"],
    [14, "最后的答案"],
  ]), "小数、比值、时间及括号小问保持原文，多行答案按大题和章节边界归集");

  const bounds = parseAnswerKeyText("第200题：" + "甲".repeat(510) + "\n第200题：重复\n第201题：越界");
  ok(bounds.length === 1 && bounds[0].questionNumber === 200 && bounds[0].answerText === "甲".repeat(MAX_ANSWER_TEXT_LENGTH),
    "题号上限、去重和答案长度生效");

  const inlineAndCase = parseAnswerKeyText([
    "1. a 2. b",
    "3. 叶绿体 4. 线粒体",
    "5. 共 2、3 两项符合要求",
    "二、解答题 （共 60 分）",
    "选择题：6-8 ABD",
    "参考答案：9. C 10. D",
    "填空题：11. 3.14 12. 5",
  ].join("\n"));
  ok(isDeepStrictEqual(inlineAndCase.map(d => [d.questionNumber, d.answerText]), [
    [1, "A"], [2, "B"], [3, "叶绿体"], [4, "线粒体"], [5, "共 2、3 两项符合要求"],
    [6, "A"], [7, "B"], [8, "D"], [9, "C"], [10, "D"], [11, "3.14"], [12, "5"],
  ]), "小写选项统一大写，同行多题与带章节前缀的单行答案均正确解析且不误拆「2、3」");

  const exif = path.join(dir, "orientation-six.jpg");
  const tall = path.join(dir, "tall.png");
  const pairedPdf = path.join(dir, "orientation-six.pdf");
  await sharp({ create: { width: 800, height: 400, channels: 3, background: "white" } })
    .jpeg().withMetadata({ orientation: 6 }).toFile(exif);
  await sharp({ create: { width: 1500, height: 4000, channels: 3, background: "white" } }).png().toFile(tall);
  const oriented = await sharp(await compressImage(exif)).metadata();
  const scaled = await sharp(await compressImage(tall)).metadata();
  ok(oriented.width === 400 && oriented.height === 800 && !oriented.orientation, "EXIF 6 的竖拍 JPEG 按显示方向旋转像素");
  ok(scaled.width === 768 && scaled.height === 2048, "1500×4000 图片按比例将长边缩到 2048");
  await imageToPdf(exif, pairedPdf);
  const pdfBytes = await readFile(pairedPdf);
  const jpegStart = pdfBytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  const jpegEnd = jpegStart >= 0 ? pdfBytes.indexOf(Buffer.from([0xff, 0xd9]), jpegStart) : -1;
  const embeddedMeta = jpegStart >= 0 && jpegEnd > jpegStart
    ? await sharp(pdfBytes.subarray(jpegStart, jpegEnd + 2)).metadata()
    : null;
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument(pairedPdf);
  try {
    const page = await (await loading.promise).getPage(1);
    ok(page.view[2] === 400 && page.view[3] === 800 &&
      embeddedMeta?.width === 400 && embeddedMeta?.height === 800 && !embeddedMeta.orientation,
    "原卷 EXIF 6 图片的配对 PDF 页面与内嵌 JPEG 像素均为旋正后的竖向");
  } finally {
    await loading.destroy();
  }
  const cjkText = await extractPdfText(cjkPdfFixture());
  ok(cjkText?.replace(/\s+/g, "") === "答案", `PDF.js 从本地 CMap 提取中文文字层（提取结果：${cjkText}）`);

  const vision = ["qwen3-vl", "glm-5v", "doubao-vision", "gpt-5.5", "gpt-6",
    "gemini-3.5-flash", "claude-sonnet-5", "deePseeK-v4-flash-vision-exp"];
  ok(vision.every(model => isVisionProvider("custom", model)) &&
    ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "text"].every(model => !isVisionProvider("openai", model)),
  "兼容服务商按模型名识别视觉能力，纯文本模型走文字路径");

  const emptyModelsGeminiDb = {
    all: async () => [{ id: 9, provider_type: "gemini", base_url: "", api_key: "k", models: null }],
  } as unknown as DbAdapter;
  const pickedDefaultVision = await getKnowledgePointProvider(emptyModelsGeminiDb, 1, { visionOnly: true });
  ok(pickedDefaultVision?.providerId === 9 && pickedDefaultVision.providerType === "gemini",
    "models 为空的 Gemini 服务商在 visionOnly 模式下仍按默认视觉能力选用");

  const emptyDb = { all: async () => [] } as unknown as DbAdapter;
  const prevUrl = process.env.LLMCLIENT_URL;
  process.env.LLMCLIENT_URL = "http://127.0.0.1:1";
  try {
    const offlineProvider = await getKnowledgePointProvider(emptyDb, 1, { visionOnly: false });
    ok(offlineProvider === null, "无数据库配置且边车不可达时返回 null 而非抛出网络异常");
  } finally {
    if (prevUrl === undefined) delete process.env.LLMCLIENT_URL;
    else process.env.LLMCLIENT_URL = prevUrl;
  }
}
