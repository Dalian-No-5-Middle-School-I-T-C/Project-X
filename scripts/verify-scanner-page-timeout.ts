/**
 * 等纸超时的默认值必须真正落到扫描机上（评审 P1「60 秒默认超时没有进入实际安装包」）。
 *
 * 复盘：#304 原先只把 `twain_controller.hpp` 的 pageTimeoutMs 从 15000 改成 60000，但
 *   - `resolveScannerBridgeExe()` 优先使用 `resources/native/<arch>/scanner-bridge.exe`，
 *   - 打包链路（electron:dist / :pack / :msi）只重编 better-sqlite3 后整目录拷贝 resources/native，
 *   - 两个预编译 exe 当时与主线逐字节相同。
 * 于是 UI 上写的「默认 60 秒」在现场跑的仍是旧 exe 的 15000ms，慢速 ADF 的
 * 「扫进 100 张只进 1 张」照旧。修法是不依赖二进制内部默认值，由调用链恒定显式传参；
 * 这里同时钉住「传参确实有效」的证据：预编译 exe 内含 --page-timeout-ms 开关。
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizePageTimeoutMs,
  PAGE_TIMEOUT_DEFAULT_MS,
} from "../src/apps/answer-card/server/scanner/index";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ① 缺省与非法输入一律回落到服务端默认 60s，绝不落到 undefined（那会交给旧 exe 的 15s）
for (const bad of [undefined, null, NaN, Infinity, -Infinity, 0, -1, 1_999, 120_001, "30000", {}, []]) {
  assert.equal(normalizePageTimeoutMs(bad), PAGE_TIMEOUT_DEFAULT_MS,
    `①: ${JSON.stringify(bad) ?? String(bad)} 必须回落到默认值，不能透传给 native`);
}
assert.equal(PAGE_TIMEOUT_DEFAULT_MS, 60_000, "①: 默认必须是 60s，而不是旧 exe 的 15s");

// ② 合法区间原样生效（含取整），上限下限都算合法
assert.equal(normalizePageTimeoutMs(2_000), 2_000, "②: 下限 2s 合法");
assert.equal(normalizePageTimeoutMs(120_000), 120_000, "②: 上限 2min 合法");
assert.equal(normalizePageTimeoutMs(90_500.7), 90_501, "②: 小数取整后透传");
assert.equal(normalizePageTimeoutMs(30_000), 30_000, "②: 用户显式选择必须生效，不能被默认覆盖");

// ③ 调用链恒定传参：twain-bridge 只在 >0 时附加开关，而服务端已保证拿到的是正数
{
  const bridge = readFileSync(fileURLToPath(new URL("../src/apps/answer-card/server/scanner/twain-bridge.ts", import.meta.url)), "utf8");
  assert.match(bridge, /if \(config\.pageTimeoutMs && config\.pageTimeoutMs > 0\)[\s\S]{0,120}"--page-timeout-ms", String\(config\.pageTimeoutMs\)/,
    "③: twain-bridge 必须把 pageTimeoutMs 作为 --page-timeout-ms 传给 exe");
  const route = readFileSync(fileURLToPath(new URL("../src/apps/answer-card/server/scanner/index.ts", import.meta.url)), "utf8");
  assert.match(route, /pageTimeoutMs: normalizePageTimeoutMs\(body\.pageTimeoutMs\)/,
    "③: 扫描入口必须规范化后再传，不能把 undefined 交给 native 默认");
}

// ④ 预编译二进制确实认这个开关：两个随包 exe 内含 --page-timeout-ms 字串。
//    这是「显式传参足以生效」的直接证据；若将来替换的 exe 不再支持该开关，此断言会失败。
for (const rel of ["resources/native/win-x64/scanner-bridge.exe", "resources/native/win-ia32/scanner-bridge.exe"]) {
  const file = `${ROOT}${rel}`;
  assert.ok(existsSync(file), `④: 缺少随包二进制 ${rel}`);
  const bytes = readFileSync(file);
  assert.ok(bytes.includes("--page-timeout-ms"), `④: ${rel} 不支持 --page-timeout-ms，默认值改不动现场`);
}

// ⑤ 头文件默认值与服务端默认值保持一致（防止两处各写一套：源码 60s、实际跑的 exe 15s）
{
  const hpp = readFileSync(fileURLToPath(new URL("../native/ScannerBridge/scanner-bridge/twain_controller.hpp", import.meta.url)), "utf8");
  const m = hpp.match(/int pageTimeoutMs = (\d+);/);
  assert.ok(m, "⑤: twain_controller.hpp 必须有 pageTimeoutMs 默认值");
  assert.equal(Number(m![1]), PAGE_TIMEOUT_DEFAULT_MS,
    `⑤: native 默认 ${m![1]}ms 与服务端 ${PAGE_TIMEOUT_DEFAULT_MS}ms 不一致，重编译后行为会漂移`);
}

console.log("verify-scanner-page-timeout: 全部通过（默认值回落 / 恒定传参 / 预编译 exe 支持开关 / 头文件同源）");
