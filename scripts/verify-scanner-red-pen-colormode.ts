/**
 * issue #331 ③「红笔在分数方框画斜线打分，有时读不到」的第一道防线：含分数格的卡必须彩色扫描。
 *
 * 复盘：识别器只在彩色像素里做红笔门控（HSV 饱和度下限 55），而扫描端、服务端路由与 TWAIN 桥
 * 三处 colorMode 缺省都是 `gray`。灰度图里红笔与印刷边框同为灰色，红笔掩码恒空，每格判为
 * `no_red_line`，整题落到 `no_valid_subjective_score`，分数按 0 计——「谁忘了切彩色」的批次整批
 * 读不到，其它批次正常，现场就成了「有时读不到、无规律」。
 * 这里锁三件事：卡面有分数格时色彩模式由服务端定（不再留给现场）、会话行记的是实际生效值、
 * 「全批零红笔」必须变成一条可执行的告警，而不是静默 0 分。
 * 真实红笔/灰度成像的行为差异在 `npm run verify:recognizer-red-pen` 里用同一个识别器验证。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  colorModeUpgradeNotice,
  layoutNeedsRedPenScoring,
  redPenMissNotice,
  resolveScanColorMode,
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

// ② 色彩模式判定只有一处入口：gray/bw/缺省/非法值都要升级到 color
for (const requested of ["gray", "bw", undefined, "", "Grey", "COLOR"]) {
  const resolved = resolveScanColorMode(requested, true);
  assert.equal(resolved.colorMode, "color", `②: ${JSON.stringify(requested)} 含分数格必须落到彩色`);
  assert.equal(resolved.upgraded, requested !== "color", "②: 已经是彩色时不该谎称改过");
}
assert.deepEqual(resolveScanColorMode("gray", false), { colorMode: "gray", upgraded: false },
  "②: 无分数格的卡保持操作员选择");
assert.equal(resolveScanColorMode("bw", false).colorMode, "bw", "②: 黑白仍是合法值");
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
  assert.match(service, /redPenPages \+= 1;[\s\S]{0,160}validCells\?\.length \?\? 0\) > 0/,
    "④: 统计的是「读到过有效分数格」，不是识别状态");
}

// ⑤ 服务端与桥接的缺省仍是 gray（老卡没有分数格时不该被连带改彩色），升级只能由上面的判定完成
{
  const route = readFileSync(fileURLToPath(new URL("../src/apps/answer-card/server/scanner/index.ts", import.meta.url)), "utf8");
  assert.match(route, /colorMode: body\.colorMode \|\| "gray"/, "⑤: 路由层保持原样，升级只在 scanner-service 一处发生");
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

console.log("verify-scanner-red-pen-colormode: 全部通过（分数格⇒彩色 / 会话与桥接同源 / 零红笔告警 / 门控依据仍在）");
