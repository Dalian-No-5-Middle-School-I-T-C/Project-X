import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  normalizePageTimeoutMs,
  PAGE_TIMEOUT_DEFAULT_MS,
} from "../src/apps/answer-card/server/scanner/index";

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

// Read the shipped executables directly. These markers identify the expected artifacts.
for (const arch of ["win-x64", "win-ia32"]) {
  const file = new URL(`../resources/native/${arch}/scanner-bridge.exe`, import.meta.url);
  assert.ok(existsSync(file), `缺少随包扫描桥 ${arch}/scanner-bridge.exe`);
  const bridge = readFileSync(file);
  for (const marker of [
    "--page-timeout-ms",
    "pending=0 ADF enabled; waiting up to %dms for next transfer event",
    "ICAP_PIXELTYPE requested=%u set=%s effective=%d",
    "DPI requested=%d X(set=%s effective=%.4f) Y(set=%s effective=%.4f)",
    "image DPI requested=%d actualX=%.4f actualY=%.4f",
    "image pixel mode requested=%u actual=%d",
    "transfer duplex contract requested=%d state=%d verified=%d",
  ]) {
    assert.ok(bridge.includes(marker), `${arch} 随包扫描桥缺少标记 ${marker}`);
  }
  assert.ok(!bridge.includes("CAP_FEEDERLOADED unsupported; trusting pending count"),
    `${arch} 随包扫描桥含旧版送纸器回退标记`);
  if (arch === "win-ia32") {
    for (const marker of [
      "ENDXFER: end of job after sheet",
      "ENDXFER: end of job after back of sheet",
      "ENDXFER: rc=ENDOFLIST but pending=%u after sheet",
      "ENDXFER: rc=ENDOFLIST but pending=%u after back of sheet",
    ]) {
      assert.ok(bridge.includes(marker), `ia32 随包扫描桥缺少收尾标记 ${marker}`);
    }
  }
}

const recognizerFile = new URL("../resources/native/win-ia32/answer-card-recognizer.exe", import.meta.url);
assert.ok(existsSync(recognizerFile), "缺少随包 ia32 识别器");
assert.ok(readFileSync(recognizerFile).includes("layoutToImage"), "ia32 随包识别器缺少坐标映射字段");

console.log("PASS scanner page timeout defaults, input bounds and shipped executable markers");
