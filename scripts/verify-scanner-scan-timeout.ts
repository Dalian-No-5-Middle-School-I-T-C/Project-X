import assert from "node:assert/strict";
const { scanTimeoutMs } = await import("../src/apps/answer-card/server/scanner/twain-bridge");
// 不限张数（0）：1 小时兜底（native 侧 ADF 空纸 60s 自退，不会真挂死）
assert.equal(scanTimeoutMs(0), 3_600_000);
// 400 张双面 = 800 页：800×5s + 300s 缓冲 = 4300s，且不低于旧默认 600s
assert.equal(scanTimeoutMs(800), 4_300_000);
// 小批量不低于旧行为
assert.equal(scanTimeoutMs(30), 600_000);
console.log("scanTimeoutMs OK");
