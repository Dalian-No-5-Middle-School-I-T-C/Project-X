/**
 * 安全 R19 验收：原生识别器面对超大图片 / 超大布局 / 越界 DPI 必须**安全退出**
 * （输出 {"status":"failed"} JSON + 退出码 2），而不是把内存吃光或直接崩掉。
 *
 * 同时验收「默认值 + PROJECTX_RECOGNIZER_* 覆盖 + 安全天花板」三档约定：
 * 非法值回落默认、超天花板夹紧，两种情况都要在 stderr 留痕且不影响正常识别。
 *
 * 跑另一个位宽的产物：ANSWER_CARD_RECOGNIZER_EXE=<路径> npm run verify:recognizer-limits
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { qrDarkRects } from "../src/shared/cardIdentity";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import type { ObjectiveBlock, Rect } from "../src/shared/types";
import { resolveRecognizerExe } from "../src/apps/answer-card/server/recognition";

/** 与 recognizer_limits.cpp 的 LIMIT_DEFS 一一对应；下面会拿源码里的名字回比，防止两边漂移。 */
const RECOGNIZER_LIMIT_ENV_VARS = [
  "PROJECTX_RECOGNIZER_MAX_IMAGE_BYTES",
  "PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS",
  "PROJECTX_RECOGNIZER_MAX_LAYOUT_BYTES",
  "PROJECTX_RECOGNIZER_MAX_LAYOUT_ITEMS",
  "PROJECTX_RECOGNIZER_MAX_LAYOUT_MM",
  "PROJECTX_RECOGNIZER_MIN_DPI",
  "PROJECTX_RECOGNIZER_MAX_DPI",
];

let passed = 0;
const failures: string[] = [];

function check(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(label);
}

type RunResult = { code: number | null; stdout: string; stderr: string; json: any };

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of RECOGNIZER_LIMIT_ENV_VARS) delete env[name];
  return env;
}

async function run(exe: string, args: string[], overrides: Record<string, string> = {}): Promise<RunResult> {
  const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...baseEnv(), ...overrides } });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  let json: any = null;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    json = null;
  }
  return { code, stdout, stderr, json };
}

function objectiveBlock(): ObjectiveBlock {
  return {
    id: "obj_limits_verify",
    type: "objective",
    title: "客观题",
    questionStart: 1,
    questionCount: 1,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 1,
    density: "compact",
    questions: [{ questionNumber: 1, optionCount: 4, mode: "single", score: 1 }],
  };
}

function svgRect(value: Rect, fill: string, stroke = "#111", strokeWidth = 0.18): string {
  return `<rect x="${value.x}" y="${value.y}" width="${value.width}" height="${value.height}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

async function main(): Promise<void> {
  const exe = resolveRecognizerExe();
  const card = createDefaultCard("90000019", "recognizer-limits");
  card.bodyBlocks = [objectiveBlock()];
  const layout = buildLayout(card);
  const page = layout.pages[0];
  const studentNumber = "82048";

  const markers = page.markers.map((marker) => svgRect(marker.rect, "#000", "#000", 0)).join("");
  const digits = (page.studentArea?.digitCells ?? [])
    .map((cell) => svgRect(cell.rect, Number(studentNumber[cell.digitIndex]) === cell.digit ? "#000" : "#fff"))
    .join("");
  const options = page.blocks
    .flatMap((block) => (block.type === "objective" ? block.items : []))
    .flatMap((item) => item.options.map((option) => svgRect(option.rect, option.label === "A" ? "#000" : "#fff")))
    .join("");
  const qr = qrDarkRects(page.header.qrCode).map((r) => svgRect(r, "#000", "#000", 0)).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}"><rect width="100%" height="100%" fill="#fff"/>${markers}${digits}${options}${qr}</svg>`;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "projectx-recognizer-limits-"));
  try {
    const imagePath = path.join(tempDir, "card.png");
    const layoutPath = path.join(tempDir, "layout.json");
    await sharp(Buffer.from(svg))
      .resize(Math.round((page.width / 25.4) * 300), Math.round((page.height / 25.4) * 300))
      .png()
      .toFile(imagePath);
    await writeFile(layoutPath, JSON.stringify(layout), "utf8");

    const argsFor = (overrides: { layout?: string; page?: string; dpi?: string } = {}): string[] => [
      "--identity-mode", "strict",
      "--image", imagePath,
      "--layout", overrides.layout ?? layoutPath,
      "--page", overrides.page ?? "1",
      "--dpi", overrides.dpi ?? "300",
    ];
    const args = argsFor();

    // ── 基线：默认档位下这张 A4@300 的卡必须照常识别 ──
    const baseline = await run(exe, args);
    check(baseline.code === 0 && baseline.json?.status !== "failed", `默认档位下正常识别（exit=${baseline.code} status=${baseline.json?.status ?? "无 JSON"}）`);
    check(baseline.json?.studentId?.value === studentNumber, "默认档位下学号识别正确（说明新增校验没有误伤正常卡）");
    check(baseline.stderr.includes("[recognizer-limits]"), "stderr 打印了生效档位，现场排查不用猜默认值");
    for (const fragment of ["图片 ≤", "像素", "布局 ≤", "数组 ≤", "毫米", "DPI ∈"]) {
      check(baseline.stderr.includes(fragment), `生效档位摘要包含「${fragment}」`);
    }

    // ── 图片：字节上限与像素上限都要在解码前/后挡住 ──
    const smallBytes = await run(exe, args, { PROJECTX_RECOGNIZER_MAX_IMAGE_BYTES: "4096" });
    check(smallBytes.code === 2 && smallBytes.json?.status === "failed", `图片字节超限安全退出（exit=${smallBytes.code}）`);
    check(String(smallBytes.json?.message ?? "").includes("超过识别器上限"), "图片字节超限的报文说明了上限与如何调整");
    check(String(smallBytes.json?.message ?? "").includes("PROJECTX_RECOGNIZER_MAX_IMAGE_BYTES"), "图片字节超限的报文点名了对应环境变量");

    const fewPixels = await run(exe, args, { PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS: "1000000" });
    check(fewPixels.code === 2 && fewPixels.json?.status === "failed", `像素预算超限安全退出（exit=${fewPixels.code}）`);
    check(String(fewPixels.json?.message ?? "").includes("头部声明"), "像素超限是在**解码前**按文件头挡下的（不是等 OpenCV 分配完再失败）");

    // ── 布局：字节、数组长度、页尺寸、矩形数值 ──
    const smallLayout = await run(exe, args, { PROJECTX_RECOGNIZER_MAX_LAYOUT_BYTES: "2048" });
    check(smallLayout.code === 2 && smallLayout.json?.status === "failed", `布局字节超限安全退出（exit=${smallLayout.code}）`);
    check(String(smallLayout.json?.message ?? "").includes("布局 JSON"), "布局字节超限的报文指向布局 JSON");

    const fewItems = await run(exe, args, { PROJECTX_RECOGNIZER_MAX_LAYOUT_ITEMS: "2" });
    check(fewItems.code === 2 && fewItems.json?.status === "failed", `布局数组长度超限安全退出（exit=${fewItems.code}）`);
    check(String(fewItems.json?.message ?? "").includes("PROJECTX_RECOGNIZER_MAX_LAYOUT_ITEMS"), "布局数组超限的报文点名了对应环境变量");

    // 布局页尺寸有两个来源：page.width 优先，缺省时回落到顶层 layout.width——两条路径都要被校验
    const hugePageLayout = JSON.parse(JSON.stringify(layout));
    hugePageLayout.pages[0].width = 1e9;
    hugePageLayout.pages[0].height = 1e9;
    const hugePagePath = path.join(tempDir, "layout-huge-page.json");
    await writeFile(hugePagePath, JSON.stringify(hugePageLayout), "utf8");
    const hugePage = await run(exe, argsFor({ layout: hugePagePath }));
    check(hugePage.code === 2 && hugePage.json?.status === "failed", `布局页尺寸 1e9 毫米安全退出（exit=${hugePage.code}）`);
    check(String(hugePage.json?.message ?? "").includes("毫米"), "布局页尺寸越界的报文按毫米说明");

    const hugeTopLayout = JSON.parse(JSON.stringify(layout));
    delete hugeTopLayout.pages[0].width;
    delete hugeTopLayout.pages[0].height;
    hugeTopLayout.width = 1e9;
    hugeTopLayout.height = 1e9;
    const hugeTopPath = path.join(tempDir, "layout-huge-top.json");
    await writeFile(hugeTopPath, JSON.stringify(hugeTopLayout), "utf8");
    const hugeTop = await run(exe, argsFor({ layout: hugeTopPath }));
    check(hugeTop.code === 2 && hugeTop.json?.status === "failed", `顶层 layout.width 回落到 1e9 毫米时同样安全退出（exit=${hugeTop.code}）`);

    const badRect = JSON.parse(JSON.stringify(layout));
    badRect.pages[0].markers[0].rect.x = 1e300;
    const badRectPath = path.join(tempDir, "layout-bad-rect.json");
    await writeFile(badRectPath, JSON.stringify(badRect), "utf8");
    const badRectRun = await run(exe, argsFor({ layout: badRectPath }));
    check(badRectRun.code === 2 && badRectRun.json?.status === "failed", `矩形坐标 1e300 安全退出（exit=${badRectRun.code}）`);
    check(String(badRectRun.json?.message ?? "").includes("Rect field"), "非法矩形坐标的报文指出具体字段");

    // ── DPI：#280 只夹了服务端一侧，原生进程自己也得夹 ──
    const hugeDpi = await run(exe, argsFor({ dpi: "100000" }));
    check(hugeDpi.code === 2 && hugeDpi.json?.status === "failed", `--dpi 100000 安全退出（exit=${hugeDpi.code}）`);
    check(String(hugeDpi.json?.message ?? "").includes("DPI"), "DPI 越界的报文说明了允许范围");

    const lowDpi = await run(exe, argsFor({ dpi: "10" }));
    check(lowDpi.code === 2 && lowDpi.json?.status === "failed", `--dpi 10 低于下限同样安全退出（exit=${lowDpi.code}）`);

    const narrowRange = await run(exe, args, { PROJECTX_RECOGNIZER_MAX_DPI: "200" });
    check(narrowRange.code === 2 && narrowRange.json?.status === "failed", "MAX_DPI 收紧到 200 后 300DPI 的请求被拒");

    const invertedRange = await run(exe, args, { PROJECTX_RECOGNIZER_MIN_DPI: "300", PROJECTX_RECOGNIZER_MAX_DPI: "200" });
    check(invertedRange.stderr.includes("已按 max_dpi 回落"), "下限被调到上限之上时按上限回落并在 stderr 留痕");

    const badPage = await run(exe, argsFor({ page: "0" }));
    check(badPage.code === 2 && badPage.json?.status === "failed", `--page 0 安全退出（exit=${badPage.code}）`);

    // ── 三档约定：非法值回落默认、超天花板夹紧，都不能影响正常识别 ──
    const invalidOverride = await run(exe, args, { PROJECTX_RECOGNIZER_MAX_IMAGE_BYTES: "abc" });
    check(invalidOverride.code === 0 && invalidOverride.json?.status !== "failed", "非法覆盖值回落默认档位，识别照常成功");
    check(invalidOverride.stderr.includes("不是正整数"), "非法覆盖值在 stderr 留痕");

    const overCeiling = await run(exe, args, { PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS: "999999999999" });
    check(overCeiling.code === 0 && overCeiling.json?.status !== "failed", "超天花板覆盖值被夹紧后识别照常成功");
    check(overCeiling.stderr.includes("已按天花板夹紧"), "超天花板覆盖值在 stderr 留痕");

    const underPixelDefault = await run(exe, args, { PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS: "1000000" });
    const clampedToCeiling = await run(exe, args, { PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS: "999999999999" });
    check(underPixelDefault.code === 2 && clampedToCeiling.code === 0, "同一张卡在「像素上限过小」时被拒、在「超天花板被夹紧」时通过——夹紧确实生效而非空转");

    // ── 源码/文档与本脚本的档位清单必须一致 ──
    const limitsSource = readFileSync(path.resolve("native/AnswerCardRecognizer/answer-card-recognizer/recognizer_limits.cpp"), "utf8");
    const sourceNames = [...new Set(limitsSource.match(/PROJECTX_RECOGNIZER_[A-Z_]+/g) ?? [])].sort();
    check(
      sourceNames.length === RECOGNIZER_LIMIT_ENV_VARS.length
        && sourceNames.every((name, index) => name === [...RECOGNIZER_LIMIT_ENV_VARS].sort()[index]),
      `识别器源码里的环境变量清单与本脚本一致（源码 ${sourceNames.length} 个：${sourceNames.join(", ")}）`
    );
    const readme = readFileSync(path.resolve("README.md"), "utf8");
    for (const name of RECOGNIZER_LIMIT_ENV_VARS) {
      check(readme.includes(name), `README 记录了 ${name} 档位`);
    }
    const visionSource = readFileSync(path.resolve("native/AnswerCardRecognizer/answer-card-recognizer/vision_utils.cpp"), "utf8");
    check(visionSource.includes("read_capped_file") && visionSource.includes("probe_declared_image_size"), "read_image 走「字节上限 → 头部尺寸 → 解码后像素」三段校验");
    check(!/std::istreambuf_iterator/.test(visionSource), "不再用 istreambuf_iterator 无上限整份读图");
    const layoutSource = readFileSync(path.resolve("native/AnswerCardRecognizer/answer-card-recognizer/layout_io.cpp"), "utf8");
    check(layoutSource.includes("assert_array_size") && layoutSource.includes("assert_layout_mm") && layoutSource.includes("assert_recognizer_dpi"), "布局解析处按数组长度 / 毫米 / DPI 三个维度收口");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log(`识别器资源边界（R19）：${passed} 通过，${failures.length} 失败`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
