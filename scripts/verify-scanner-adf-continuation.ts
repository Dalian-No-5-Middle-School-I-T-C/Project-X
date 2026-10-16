/**
 * issue #331 ②「仍旧只能扫描一张」：进纸器批次的续等判定不能只认 ENDXFER 的 pending.Count。
 *
 * 复盘：旧循环写的是 `hasMorePages = pending.Count > 0`，而 CAP_XFERCOUNT 请求的是 -1（不限张数）。
 *   TWAIN 2.x 规范里这种情况下多数驱动**恒报 Count=0**（它不知道还剩几张，0xFFFF 也常见），
 *   于是第一张 ENDXFER 之后循环就退出——现场表现为「ADF 吞了 100 张，软件只收到 1 张」。
 *   同一处还有三个各自独立会让批次提前收尾的缺陷：
 *   - 驱动用 ENDOFLJOB（0x0007）表示「这就是最后一张」，旧代码当 ENDXFER 失败，连已到手的那张都报成扫描失败；
 *   - 双面分支只在 `pending.Count > 0` 时才等背面，Count=0 的驱动因此永远只交正面；
 *   - enableSource 无条件 `m_state = 3`，把 MSG_ENABLEDS 内部就已到达的第一帧 XFERREADY 抹掉，
 *     随后 waitForState(6) 干等一个不会再来的事件（表现为「按下扫描没反应」）。
 * 这些判定全在原生桥里，TS 侧改不动它，所以这里锁源码语义；同时锁住「桥的诊断必须回到服务端日志」——
 * 现场只有拿到 effective CAP_FEEDERENABLED 和批次结束原因，才能区分「驱动不支持」与「软件提前收尾」。
 *
 * 注意：随包 scanner-bridge.exe 必须由 `npm run native:build:x64` / `:ia32`（或交叉打包工序）重编译后
 * 才会生效；只改源码不出包，现场跑的仍是旧二进制。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractBridgeDiagnostics } from "../src/apps/answer-card/server/scanner/twain-bridge";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cpp = readFileSync(fileURLToPath(new URL("../native/ScannerBridge/scanner-bridge/twain_controller.cpp", import.meta.url)), "utf8");
const hpp = readFileSync(fileURLToPath(new URL("../native/ScannerBridge/scanner-bridge/twain_controller.hpp", import.meta.url)), "utf8");

// ① 续等判定必须走 shouldWaitForTransfer，且旧的「只认 Count」谓词不能残留
assert.match(cpp, /hasMorePages = shouldWaitForTransfer\(pending\.Count\);/,
  "①: 循环尾部必须用 shouldWaitForTransfer(pending.Count)");
assert.doesNotMatch(cpp, /hasMorePages = pending\.Count > 0;/,
  "①: hasMorePages = pending.Count > 0 会在 CAP_XFERCOUNT=-1 时第一张就退出");
assert.match(cpp, /static constexpr TW_UINT16 TWRC_ENDOFLJOB = TWRC_ENDOFLIST;/,
  "①: 随包 twain.h 只在枚举场景定义同值的 TWRC_ENDOFLIST，必须按 MSG_ENDXFER 语义命名 ENDOFLJOB");

// ② ENDOFLJOB 是正常收尾：正反面两处 ENDXFER 都要认，且不得写 errorMessage
const endofljobSites = cpp.match(/if \(endRc == TWRC_ENDOFLJOB\) \{/g) ?? [];
assert.equal(endofljobSites.length, 2, "②: 正面与背面的 ENDXFER 都要处理 ENDOFLJOB");
for (const site of endofljobSites) {
  const at = cpp.indexOf(site);
  const block = cpp.slice(at, cpp.indexOf("break;", at));
  assert.match(block, /hasMorePages = false;/, "②: 作业结束要停止续等");
  assert.doesNotMatch(block, /errorMessage/, "②: ENDOFLJOB 不是失败，不能把已到手的一批判为扫描失败");
}

// ③ 双面背面不能由 Count 决定，等不到背面也不能判整批失败
assert.doesNotMatch(cpp, /if \(config\.duplex && pending\.Count > 0\)/,
  "③: 双面背面是否到达不能只问 pending.Count");
const duplex = cpp.slice(cpp.indexOf("// Back side (duplex)"));
assert.ok(duplex.length > 100, "③: 找不到背面传输代码块");
assert.match(duplex.slice(0, 900), /if \(!shouldWaitForTransfer\(pending\.Count\)\) \{/,
  "③: 进入背面等待前必须先问 shouldWaitForTransfer");
const backTimeoutAt = duplex.indexOf("if (!waitForState(6, config.pageTimeoutMs)) {");
const backTimeout = duplex.slice(backTimeoutAt, duplex.indexOf("break;", backTimeoutAt));
assert.match(backTimeout, /no back side for sheet/, "③: 等不到背面必须打印可诊断的原因");
assert.doesNotMatch(backTimeout, /result\.errorMessage/,
  "③: 混合批次里某张确实只有正面，等不到背面不该判整批失败");

// ④ 判定表：状态机 > Count > 送纸器；Count=0 只有在没走送纸器时才算「没有下一张」
{
  const at = cpp.indexOf("bool TwainController::shouldWaitForTransfer");
  assert.ok(at > 0, "④: 缺少 shouldWaitForTransfer");
  const body = cpp.slice(at, cpp.indexOf("\nbool ", at + 10));
  assert.match(body, /if \(m_state >= 6\) return true;/, "④: 已经到达的 XFERREADY 优先，不该再等事件");
  assert.match(body, /if \(pendingCount > 0\) return true;/, "④: Count>0（含 0xFFFF）是明确的继续信号");
  assert.match(body, /if \(!m_feederEnabled\) \{/, "④: 没开送纸器时 Count=0 才可信，必须据此收尾");
  assert.match(body, /queryFeederLoaded\(&loaded\)/, "④: 走纸器场景要用 CAP_FEEDERLOADED 求证");
  const unreadable = body.slice(body.indexOf("if (!queryFeederLoaded"), body.indexOf("if (!queryFeederLoaded") + 330);
  assert.match(unreadable, /return true;/, "④: 驱动不答 CAP_FEEDERLOADED 时宁可多等一个超时，少收一张不可恢复");
  assert.ok(body.indexOf("if (m_state >= 6)") < body.indexOf("if (pendingCount > 0)"), "④: 判定顺序不能颠倒");
}

// ⑤ 送纸器状态必须回读：SET 被静默拒绝（平板机型）时按 false 处理，否则每张之间白等超时
assert.match(cpp, /readCurrentOneValueCap\(&m_appId, &m_sourceId, CAP_FEEDERENABLED, rawItem, itemType\)/,
  "⑤: enableADF 必须回读 CAP_FEEDERENABLED，不能只信 SET 返回值");
assert.match(cpp, /m_feederEnabled = readable \? rawItem != 0 : accepted;/,
  "⑤: 回读可用则用回读，不可用才退回 SET 结果");
assert.match(hpp, /bool m_feederEnabled = false;/, "⑤: 送纸器实际状态必须是成员变量供续等判定使用");

// ⑥ enableSource 不能抹掉 MSG_ENABLEDS 内部就已到达的 XFERREADY
assert.equal(cpp.match(/if \(m_state < 3\) m_state = 3;/g)?.length, 2,
  "⑥: enableSource 的两个出口都要用下限写法，保留更早的 XFERREADY");
assert.doesNotMatch(cpp, /(^|[^f])\n\s*m_state = 3;/, "⑥: 不允许无条件把状态写回 3");

// ⑦ ENDXFER 回报 Count>0 时，下一帧已挂在状态 6，它不会再发一次 XFERREADY
assert.equal(cpp.match(/if \(pending\.Count > 0\) m_state = 6;/g)?.length, 2,
  "⑦: 正反面两处 ENDXFER 之后都要按 Count 推进状态机");

// ⑧ TS 侧：桥的诊断必须落到服务端日志，且只取桥自己的行（不吞驱动噪声）
{
  const lines = [
    "some vendor driver chatter",
    "[ScannerBridge] CAP_FEEDERENABLED set=ok effective=1 (GETCURRENT) CAP_AUTOFEED requested=1",
    "  [ScannerBridge] pending=0 feederLoaded=1; waiting up to 60000ms for next transfer  ",
    "[ScannerBridge] ENDXFER: end of job after sheet 12 (pending=0)",
    "twaindsm.dll loaded",
  ];
  assert.deepEqual(extractBridgeDiagnostics(lines.join("\n")), [
    "[ScannerBridge] CAP_FEEDERENABLED set=ok effective=1 (GETCURRENT) CAP_AUTOFEED requested=1",
    "[ScannerBridge] pending=0 feederLoaded=1; waiting up to 60000ms for next transfer",
    "[ScannerBridge] ENDXFER: end of job after sheet 12 (pending=0)",
  ], "⑧: 只转发 [ScannerBridge] 行并去掉首尾空白");
  assert.deepEqual(extractBridgeDiagnostics(""), [], "⑧: 空 stderr 不该产出噪声");

  const bridge = readFileSync(fileURLToPath(new URL("../src/apps/answer-card/server/scanner/twain-bridge.ts", import.meta.url)), "utf8");
  assert.match(bridge, /for \(const line of extractBridgeDiagnostics\(stderr\)\)\s*\{?\s*console\.warn\(`\[scanner\] \$\{line\}`\)/,
    "⑧: 扫描桥 stderr 必须逐行转发到服务端日志，否则现场只看到「只扫了一张」却没有原因");
}

// ⑨ 批次判定所依赖的两个能力必须真的被请求：CAP_XFERCOUNT=-1 与 CAP_FEEDERLOADED 只在需要时查询
assert.match(cpp, /setCapability\(CAP_XFERCOUNT, TWTY_INT16, &unlimited\)/,
  "⑨: 不设 CAP_XFERCOUNT=-1 时驱动默认只交付 1 页（柯达 i3000 实测），续等逻辑再对也收不到第 2 张");
assert.match(cpp, /readCurrentOneValueCap\(&m_appId, &m_sourceId, CAP_FEEDERLOADED/,
  "⑨: CAP_FEEDERLOADED 必须走统一的安全读取，避免异构容器越界解析");

console.log("verify-scanner-adf-continuation: 全部通过（续等判定 / ENDOFLJOB 收尾 / 双面背面 / 送纸器回读 / 状态机不被抹平 / 桥诊断回传）");
