/**
 * issue #331 ③「红笔在分数方框画斜线打分，有时读不到」的第一道防线：含分数格的卡必须彩色扫描。
 *
 * 复盘：识别器只在彩色像素里做红笔门控（HSV 饱和度下限 55），而扫描端、服务端路由与 TWAIN 桥
 * 三处 colorMode 缺省都曾落到 `gray`。灰度图里红笔与印刷边框同为灰色，红笔掩码恒空，每格判为
 * `no_red_line`，整题落到 `no_valid_subjective_score`，分数按 0 计——「谁忘了切彩色」的批次整批
 * 读不到，其它批次正常，现场就成了「有时读不到、无规律」。缺省值已由 #330 统一改成彩色，
 * 这里锁的是剩下的三件事：卡面有分数格时色彩模式由服务端定（历史会话与显式灰度也升级为彩色）、
 * 会话行记的是实际生效值、「全批零红笔」必须变成一条可执行的告警，而不是静默 0 分。
 * 真实红笔/灰度成像的行为差异在 `npm run verify:recognizer-red-pen` 里用同一个识别器验证。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  colorModeUpgradeNotice,
  layoutNeedsRedPenScoring,
  pageNeedsRedPenScoring,
  redPenMissNotice,
  resolveScanColorMode,
  scoreCellsSampled,
} from "../src/shared/scanRedPenScore";
import type { PageLayout } from "../src/shared/types";

const page = (types: string[]): PageLayout => ({
  elements: types.map((type, index) => ({ id: `${type}-${index}`, type, score: 5, rect: { x: 0, y: 0, width: 1, height: 1 }, blockId: "b", questionId: "q", questionNumber: 1 })),
} as unknown as PageLayout);

// ① 只有版面里真的生成 score_cell 才算「必须彩色」：客观题卡不该被强行改色彩（体积与速度都变）
assert.equal(layoutNeedsRedPenScoring([]), false, "①: 空版面不需要红笔");
assert.equal(layoutNeedsRedPenScoring([page(["objective_option", "student_digit", "marker"])]), false,
  "①: 没有分数格时不得改写操作员的选择");
assert.equal(layoutNeedsRedPenScoring([page(["objective_option"]), page(["score_cell"])]), true,
  "①: 任意一页有分数格即需彩色");

// ② 色彩模式判定只有一处入口：gray/bw 才按低色彩走，缺省与非法值一律落彩色
for (const requested of ["gray", "bw", undefined, "", "Grey", "COLOR", "color"]) {
  const resolved = resolveScanColorMode(requested, true);
  assert.equal(resolved.colorMode, "color", `②: ${JSON.stringify(requested)} 含分数格必须落到彩色`);
  assert.equal(resolved.upgraded, requested === "gray" || requested === "bw",
    `②: ${JSON.stringify(requested)} 只有真从低色彩抬上来才算改过`);
}
assert.deepEqual(resolveScanColorMode("gray", false), { colorMode: "gray", upgraded: false },
  "②: 无分数格的卡保持操作员选择");
assert.equal(resolveScanColorMode("bw", false).colorMode, "bw", "②: 黑白仍是合法值");
// 不认识的值不能被当成灰度：不含分数格的卡不升级，那种卡就会静默按灰度扫（③ 的病根之一）
for (const junk of [undefined, "", "Grey", "COLOR"]) {
  assert.equal(resolveScanColorMode(junk, false).colorMode, "color", `②: ${JSON.stringify(junk)} 不得降级成灰度扫描`);
}
// 升级提示必须点名「原来是什么、为什么改」，否则操作员只看到模式自己跳了
assert.match(colorModeUpgradeNotice("gray"), /从「灰度」改为「彩色」/, "②: 提示要写明原模式");
assert.match(colorModeUpgradeNotice("bw"), /从「黑白」改为「彩色」/, "②: 提示要写明原模式");
assert.match(colorModeUpgradeNotice("gray"), /一律读成 0/, "②: 提示要写明不改的后果");

// ③ 告警只在「全批零红笔」时出现：个别卷子空白属缺考/未打分，不该刷屏
assert.equal(redPenMissNotice({ needsRedPen: false, colorMode: "color", pageCount: 30, pagesWithRedMark: 0 }), null,
  "③: 无分数格的卡与此告警无关");
assert.equal(redPenMissNotice({ needsRedPen: true, colorMode: "gray", pageCount: 30, pagesWithRedMark: 1 }), null,
  "③: 读到过一张就说明彩色可用，不能误报");
assert.equal(redPenMissNotice({ needsRedPen: true, colorMode: "gray", pageCount: 0, pagesWithRedMark: 0 }), null,
  "③: 零页批次（取消/失败）不给结论");
const grayNotice = redPenMissNotice({ needsRedPen: true, colorMode: "gray", pageCount: 12, pagesWithRedMark: 0 })!;
assert.match(grayNotice, /12 张/, "③: 提示要给出核对过的张数");
assert.match(grayNotice, /扫描模式为「灰度」/, "③: 提示要指名当前模式");
assert.match(grayNotice, /改用彩色模式重扫/, "③: 提示要给出可执行动作");
const colorNotice = redPenMissNotice({ needsRedPen: true, colorMode: "color", pageCount: 12, pagesWithRedMark: 0 })!;
assert.match(colorNotice, /已用彩色扫描/, "③: 已是彩色时不能再让用户去改模式");
assert.match(colorNotice, /手工改分/, "③: 兜底路径要写清楚");

// ③b 分母只能数「这一页自己生成过分数格」的页：第 1 页客观题、第 2 页分数格的卡若这批只扫到第 1 页，
// subjectiveQuestions 恒为空，按整卡计数就会报成「12 张一张都没读到」，而分数页根本不在这批里。
assert.equal(pageNeedsRedPenScoring(page(["objective_option", "student_digit"])), false, "③b: 纯客观题页不进分母");
assert.equal(pageNeedsRedPenScoring(page(["score_cell"])), true, "③b: 分数格页进分母");
assert.equal(pageNeedsRedPenScoring(undefined), false, "③b: 页号越界按无分数格处理，不得抛错");

// ③c 识别器只把「看到红笔但未采纳」的格子放进 invalidCells（打「×」走 multiple_red_components）。
// 这类批次彩色是可用的，问题在画线方式，文案不能再把老师带去改色彩模式。
const rejectedNotice = redPenMissNotice({ needsRedPen: true, colorMode: "color", pageCount: 12, pagesWithRedMark: 0, pagesWithRejectedRed: 9 })!;
assert.match(rejectedNotice, /读到了红笔只是未采信/, "③c: 读到过红笔要说成未采信，不是没读到");
assert.match(rejectedNotice, /9 张/, "③c: 未采纳的张数要给出");
assert.doesNotMatch(rejectedNotice, /改用彩色|改为「彩色」/, "③c: 已读到红笔时不得再建议改色彩模式");
assert.match(rejectedNotice, /手工改分/, "③c: 未采纳的兜底路径要写清楚");
assert.equal(redPenMissNotice({ needsRedPen: true, colorMode: "gray", pageCount: 12, pagesWithRedMark: 2, pagesWithRejectedRed: 9 }), null,
  "③c: 采纳过一张就不告警，未采纳数不得压过已采纳");
assert.equal(redPenMissNotice({ needsRedPen: true, colorMode: "color", pageCount: 12, pagesWithRedMark: 0, pagesWithRejectedRed: 0 })!, colorNotice,
  "③c: 完全没有红笔时仍是原来的色彩/笔迹结论");

// ③d 分母还要排除「格子根本没被采样」的页：二维码校验或定位点检测失败时，识别器提前返回
// status:"failed" 且 subjectiveQuestions 为空。整批都这样失败时若仍按版面计数，
// 告警会说成「红笔分数格一张都没读到」，而真实故障是该页识别失败（已按页报出）。
assert.equal(scoreCellsSampled({ status: "failed", subjectiveQuestions: [] }), false,
  "③d: 提前失败且无条目 ⇒ 格子没被看过，不进分母");
assert.equal(scoreCellsSampled({ status: "failed", subjectiveQuestions: [{ questionId: "q1" }] }), false,
  "③d: status 已判 failed 就不算采样过，残缺条目不能拿来反证读到红笔");
assert.equal(scoreCellsSampled({ status: "ok", subjectiveQuestions: [] }), false,
  "③d: 成功但一题都没有 ⇒ 这页没被采样（版面与识别对不上）");
assert.equal(scoreCellsSampled({ status: "ok", subjectiveQuestions: [{ questionId: "q1" }] }), true,
  "③d: 采样过的页按题留条目，未打分也有状态——这是进分母的证据");
assert.equal(scoreCellsSampled({ status: "partial", subjectiveQuestions: [{ questionId: "q1", validCells: [] }] }), true,
  "③d: partial 算采样过，零红笔告警仍要照常给");
assert.equal(scoreCellsSampled({ status: "ok" }), false, "③d: 缺 subjectiveQuestions 字段按未采样处理，不得凭整卡判定就计数");

const failedBatch = [
  { status: "failed", subjectiveQuestions: [] as unknown[] },
  { status: "failed", subjectiveQuestions: [] as unknown[] }
];
const failedCounted = failedBatch.filter(scoreCellsSampled).length;
assert.equal(failedCounted, 0, "③d: 全批识别失败的页一页都不进分母");
assert.equal(redPenMissNotice({ needsRedPen: true, colorMode: "gray", pageCount: failedCounted, pagesWithRedMark: 0 }), null,
  "③d: 识别失败批次不给红笔告警，故障由该页的识别状态与失败原因报");

// ④ 接线：会话行、送进桥接的参数、告警出口三处都要走同一个判定，不能各写一套
{
  const service = readFileSync(fileURLToPath(new URL("../src/apps/answer-card/server/scanner/scanner-service.ts", import.meta.url)), "utf8");
  assert.match(service, /colorMode: resolveScanColorMode\(config\.colorMode, layoutNeedsRedPenScoring\(prepared\.layout\.pages\)\)\.colorMode,/,
    "④: createScanSession 落库的必须是实际生效的色彩模式");
  assert.match(service, /const colorMode = resolveScanColorMode\(\s*config\.colorMode,\s*layoutNeedsRedPenScoring\(prepared\.layout\.pages\)\s*\);/,
    "④: runScanSession 必须自行重算（不能依赖调用方改过的 config）");
  assert.match(service, /colorMode: colorMode\.colorMode,/, "④: 传给 TWAIN 桥的必须是升级后的模式");
  assert.match(service, /if \(colorMode\.upgraded\) \{\s*onProgress\(\{ sessionId, type: "warning", message: colorModeUpgradeNotice\(config\.colorMode\) \}\);/,
    "④: 自动改写必须当场告知操作员");
  assert.match(service, /colorMode=\$\{colorMode\.colorMode\}\$\{colorMode\.upgraded \? "\(forced\)" : ""\}/,
    "④: [checkpoint] 日志要留下最终生效的模式，现场取证只看日志也能定案");
  assert.match(service, /const missNotice = redPenMissNotice\(\{[\s\S]{0,200}colorMode: session\?\.color_mode,/,
    "④: 识别阶段按会话记录的模式给结论");
  assert.match(service, /type: "warning", message: missNotice/, "④: 全批零红笔要走 SSE 告警，不能只写日志");
  assert.match(service, /if \(needsRedPen && pageNeedsRedPenScoring\(layout\.pages\[layoutPage - 1\]\) && scoreCellsSampled\(recognition\)\) \{\s*redPenPages \+= 1;[\s\S]{0,160}validCells\?\.length \?\? 0\) > 0/,
    "④: 分母同时要求「本页有分数格」与「格子真被采样过」，且统计的是「读到过有效分数格」，不是识别状态");
  assert.match(service, /invalidCells\?\.length \?\? 0\) > 0\)\)\s*\{[\s\S]{0,160}redRejectedPages \+= 1;/,
    "④: 「读到红笔但未采纳」单独计数，不能和「完全没有红笔」混成一条");
  assert.match(service, /pagesWithRejectedRed: redRejectedPages/, "④: 未采纳计数必须进告警判定");
}

// ⑤ 升级判定只有一处：路由与桥接都只传值，不能再各写一套色彩模式默认
{
  const route = readFileSync(fileURLToPath(new URL("../src/apps/answer-card/server/scanner/index.ts", import.meta.url)), "utf8");
  assert.match(route, /colorMode: body\.colorMode \|\| "color"/, "⑤: 路由层沿用 #330 的彩色缺省，不自己做分数格判定");
  assert.doesNotMatch(route, /resolveScanColorMode|layoutNeedsRedPenScoring/, "⑤: 色彩模式判定只能落在 scanner-service，路由不许复制一份");
  const bridge = readFileSync(fileURLToPath(new URL("../src/apps/answer-card/server/scanner/twain-bridge.ts", import.meta.url)), "utf8");
  assert.match(bridge, /"--mode", config\.colorMode,/, "⑤: 桥接必须照传解析后的模式，不能再自己兜一次默认");
}

// ⑥ 判定依据必须与识别器的真实门控同源：红笔靠 HSV 饱和度筛，灰度图饱和度恒为 0
{
  const native = readFileSync(fileURLToPath(new URL("../native/AnswerCardRecognizer/answer-card-recognizer/answer_recognition.cpp", import.meta.url)), "utf8");
  assert.match(native, /cv::cvtColor\(roi, hsv, cv::COLOR_BGR2HSV\);[\s\S]{0,260}?cv::inRange\(hsv, cv::Scalar\(0, 55, 55\)/,
    "⑥: 分数格仍按饱和度≥55 的红笔门控判定——这是「必须彩色」的依据，门控若改要走显式决策");
  assert.match(native, /cv::cvtColor\(warped, bgr, cv::COLOR_GRAY2BGR\);/,
    "⑥: 灰度输入被补成 B=G=R，饱和度恒为 0，红笔掩码必然为空（灰度扫描读不到红笔的根因）");
  assert.match(native, /sample\.reason = "no_red_line";/, "⑥: 读不到红笔必须留下可归因的 reason");
}

console.log("verify-scanner-red-pen-colormode: 全部通过（分数格⇒彩色 / 会话与桥接同源 / 零红笔告警按页统计且区分未采纳 / 门控依据仍在）");
