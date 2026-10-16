import assert from "node:assert/strict";
const { scanTimeoutMs } = await import("../src/apps/answer-card/server/scanner/twain-bridge");
// 不限张数时看门狗按帧进度续期；一次停滞仍受一小时限制。
assert.equal(scanTimeoutMs(0), 3_600_000);
// 400 张双面 = 800 帧；每帧都可能消耗完整等纸时间，另含最后一次空等及配置/收尾。
assert.equal(scanTimeoutMs(800), 52_360_000);
assert.equal(scanTimeoutMs(800, 120_000), 100_420_000);
assert.equal(scanTimeoutMs(1, 2000), 600_000);
for (const pageWaitMs of [2000, 60000, 120000]) {
  const frameCount = 100;
  const permittedWaits = (frameCount + 1) * pageWaitMs;
  assert.ok(scanTimeoutMs(frameCount, pageWaitMs) > permittedWaits,
    "Parent watchdog must cover all permitted native waits plus transfer/setup time");
}
assert.ok(scanTimeoutMs(100, 60000) > 100 * 10000,
  "100 pages spaced 10 seconds apart must not hit the former 800-second watchdog");
console.log("scanTimeoutMs OK");
