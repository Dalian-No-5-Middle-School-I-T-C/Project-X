/**
 * 大题切块核对 —— 自动化验证脚本（issue #331 ③「OpenCV 识别不准，大题划分有时读不到，无规律」）
 * ----------------------------------------------------------------
 * 运行方式：npx tsx scripts/verify-scanner-block-crops.ts
 *
 * 背景：「大题划分读不到」在界面上没有落点——识别状态只看学号与客观题，切块只写进
 *   `answer_block_crops` 给网阅队列用。三条静默路径（随包 exe 不支持 --crops-dir 而降级、
 *   识别漏出某个大题、切块图片在落库时被跳过）症状完全一样，日志又各在一处，
 *   所以现场只能描述成「无规律」。
 *
 * 兜底：以**布局声明的大题**为基准逐页核对识别产出与落库数量，缺哪一块、属于哪一类、
 *   共几页全部计数，会话结束时汇总成一条 `[checkpoint] blocks` 日志和一条界面告警。
 *
 * 断言方式：① 纯函数用真实 buildLayout 产物做正反例（含空块不误报、落库为 0 要单独成类）；
 *   ② 接线检查——服务层确实逐页核对、捕获落库统计并以 type:"warning" 上报。
 *
 * 全部用例通过则进程退出码为 0，否则为 1。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { auditBlockCrops, summarizeBlockCropAudits } from "../src/shared/scanBlockCrops";
import type { BodyBlock, PageRenderBlock, RecognitionBlockCrop } from "../src/shared/types";

let passed = 0;
const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

const root = process.cwd();

/** 三个大题：客观单选 + 客观多选 + 主观解答题，覆盖布局的两类 blockId */
const bodyBlocks: BodyBlock[] = [
  {
    id: "obj-single", type: "objective", title: "单选题", questionStart: 1, questionCount: 5,
    optionCount: 4, mode: "single", scorePerQuestion: 5, density: "normal", answerKey: { 1: ["A"] }
  },
  {
    id: "obj-multi", type: "objective", title: "多选题", questionStart: 6, questionCount: 3,
    optionCount: 4, mode: "multiple", scorePerQuestion: 5, density: "normal", answerKey: {}
  },
  {
    id: "subj", type: "subjective", title: "解答题",
    questions: [{ id: "q9", number: 9, score: 10, style: "manual_score_grid", kind: "plain_box", minHeightMm: 30 }]
  }
];

const card = createDefaultCard("91514003");
card.studentInfo.studentNumberDigits = 5;
card.bodyBlocks = bodyBlocks;
const layout = buildLayout(card);
const blocks: PageRenderBlock[] = layout.pages[0].blocks;

function cropFor(blockId: string): RecognitionBlockCrop {
  return {
    blockId,
    blockTitle: blockId,
    blockType: blockId === "subj" ? "subjective" : "objective",
    pageNumber: 1,
    segmentIndex: 0,
    questionNumbers: [1],
    rect: { x: 10, y: 40, width: 180, height: 60 },
    path: `C:/scans/crop-temp/${blockId}.png`,
    widthPx: 900,
    heightPx: 300,
    dpi: 300
  };
}

const allCrops = () => blocks.map(block => cropFor(block.blockId));

function main(): void {
  console.log("\n\x1b[36m== 基准：布局声明的大题 ==\x1b[0m");

  check(blocks.map(block => block.blockId).join(",") === "obj-single,obj-multi,subj",
    `夹具布局第 1 页声明 3 个大题（实际 ${blocks.length} 个），核对才有基准`);

  const ok = auditBlockCrops(1, blocks, allCrops(), 3);
  check(ok.status === "ok" && ok.expected === 3 && ok.got === 3 && ok.missingBlockIds.length === 0,
    `3 个切块齐 → ok (status=${ok.status}, got=${ok.got})`);

  console.log("\n\x1b[36m== 三类「读不到」要分得开 ==\x1b[0m");

  const dropped = auditBlockCrops(7, blocks, allCrops().filter(c => c.blockId !== "subj"), 2);
  check(dropped.status === "partial" && dropped.missingBlockIds.join() === "subj" && dropped.missingTitles.join() === "解答题",
    `识别漏出「解答题」→ partial，并能报出缺的是哪个大题 (status=${dropped.status})`);

  const noField = auditBlockCrops(3, blocks, undefined, 0);
  check(noField.status === "unsupported" && noField.expected === 3 && noField.got === 0,
    `整页没有 blockCrops 字段（旧 exe 降级）→ unsupported，不与「识别漏块」混为一谈 (status=${noField.status})`);

  const emptyArray = auditBlockCrops(3, blocks, [], 0);
  check(emptyArray.status === "partial",
    `字段在但数组为空 → 按识别漏块算（说明识别器支持切块，只是这页没切出来）(status=${emptyArray.status})`);

  const lostBeforeDb = auditBlockCrops(4, blocks, allCrops(), 0);
  check(lostBeforeDb.status === "not_persisted" && lostBeforeDb.missingBlockIds.length === 3,
    `识别报出 3 块却一块没入库（切块图片丢失）→ not_persisted (status=${lostBeforeDb.status})`);

  const dbThrew = auditBlockCrops(4, blocks, allCrops(), undefined);
  check(dbThrew.status === "ok", "落库统计缺失（持久化抛错，另有 [Scanner] 日志）不额外断言切块丢失");

  console.log("\n\x1b[36m== 不误报 ==\x1b[0m");

  const emptyPage = auditBlockCrops(2, [], undefined, 0);
  check(emptyPage.status === "ok" && emptyPage.expected === 0,
    `没有大题的页面（如未排题的空白背面）→ ok，不产生告警 (status=${emptyPage.status})`);

  const blankBlock: PageRenderBlock = {
    type: "objective", blockId: "blank", title: "未排题", rect: { x: 10, y: 40, width: 180, height: 20 },
    frameRect: { x: 9, y: 39, width: 182, height: 22 }, rowMarkers: [], items: [], density: "normal"
  };
  const noQuestionBlock = auditBlockCrops(1, [blankBlock], [], 0);
  check(noQuestionBlock.status === "ok" && noQuestionBlock.expected === 0,
    "没排题的空块不计入「应有切块」——与 native block_crops_from_page 的判据一致");

  const extra = auditBlockCrops(1, blocks, [...allCrops(), cropFor("stale-block")], 4);
  check(extra.status === "ok", "多出来的切块（改版型后的旧 id）不算丢失，避免反向误报");

  console.log("\n\x1b[36m== 会话汇总：把逐页结论压成一条能截图的话 ==\x1b[0m");

  const clean = summarizeBlockCropAudits([ok, ok, ok]);
  check(clean.message === undefined && clean.auditedPages === 3 && clean.partialPages === 0,
    `全部齐备 → 不给告警文案 (message=${clean.message ?? "undefined"})`);

  const mixed = summarizeBlockCropAudits([ok, dropped, noField]);
  check(mixed.partialPages === 1 && mixed.unsupportedPages === 1 && mixed.auditedPages === 3,
    `混合成因分别计数 (partial=${mixed.partialPages}, unsupported=${mixed.unsupportedPages})`);
  check(Boolean(mixed.message?.includes("第 7 页")) && Boolean(mixed.message?.includes("解答题")),
    "文案带页号与缺失大题名，现场不用翻日志就能复述");
  check(Boolean(mixed.message?.includes("--crops-dir")), "文案点出旧识别组件这一成因，避免只说「识别不准」");

  const manyPages = summarizeBlockCropAudits(
    Array.from({ length: 12 }, (_, index) => auditBlockCrops(index + 1, blocks, [], 0))
  );
  check(Boolean(manyPages.message) && manyPages.message!.includes("…") && manyPages.partialPages === 12,
    `长会话只列前 8 页，页号列表不撑爆告警条 (partialPages=${manyPages.partialPages})`);

  console.log("\n\x1b[36m== 接线检查：核对要走到日志与界面 ==\x1b[0m");

  const serviceSource = readFileSync(path.join(root, "src/apps/answer-card/server/scanner/scanner-service.ts"), "utf8");
  check(/cropStats = await persistAnswerBlockCrops\(/.test(serviceSource),
    "捕获落库统计（原实现丢弃返回值，导致「识别说有块、库里没块」不可见）");
  check(serviceSource.includes("auditBlockCrops("), "识别成功的每一页都按布局声明核对切块");
  check(serviceSource.includes("layout.pages[layoutPage - 1]?.blocks"), "核对基准取的是本次布局的同一页，不是整份卡");
  check(serviceSource.includes("summarizeBlockCropAudits(blockCropAudits)"), "会话结束时汇总逐页核对结果");
  check(/\[checkpoint\] blocks/.test(serviceSource), "缺块页与汇总各写一条 [checkpoint] blocks 日志");
  check(/onProgress\(\{ sessionId, type: "warning", message: blockSummary\.message \}\)/.test(serviceSource),
    "汇总结论以 type:\"warning\" 上报界面");

  const nativeSource = readFileSync(
    path.join(root, "native/AnswerCardRecognizer/answer-card-recognizer/answer_recognition.cpp"), "utf8");
  check((nativeSource.match(/\[recognizer-crops\] dropped/g) ?? []).length === 2,
    "native build_block_crops 的两处 continue（版面退化、写图失败）都报出丢的是哪个大题");

  const recognizerBridgeSource = readFileSync(path.join(root, "src/apps/answer-card/server/recognition.ts"), "utf8");
  check(recognizerBridgeSource.includes('"[recognizer-crops]"'),
    "识别成功时也转发 native 的丢块原因——只写 stderr 会被子进程静默丢弃");

  console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("verify-scanner-block-crops: ALL PASS");
}

main();
