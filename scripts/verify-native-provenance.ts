#!/usr/bin/env node
// 核对随包 Windows 原生件的构建记录及 TWAIN DSM。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeManifest = createRequire(import.meta.url)("./lib/native-source-manifest.cjs") as {
  verifyNativeSourceManifest: (params: { rootDir: string; lane: string }) => {
    entries: Map<string, string>;
    failures: string[];
    missing: string[];
    crlfCheckout: string[];
  };
};
const failures: string[] = [];

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fail(message: string): void {
  failures.push(message);
  console.error(`  ✗ ${message}`);
}

function pass(message: string): void {
  console.log(`  ✓ ${message}`);
}

for (const lane of ["win-ia32", "win-x64"]) {
  console.log(`\n── 随包 ${lane} 原生件的构建记录`);
  const check = nativeManifest.verifyNativeSourceManifest({ rootDir: root, lane });
  for (const relative of check.crlfCheckout) {
    fail(`${relative} 以 CRLF 检出。请设置 core.autocrlf=false 和 core.eol=lf 后重新检出。`);
  }
  for (const message of check.failures) fail(message);
  if (check.failures.length === 0 && check.crlfCheckout.length === 0) {
    pass(`${lane}: ${check.entries.size} 项构建输入、识别器和扫描桥与构建记录一致`);
  }
}

console.log("\n── TWAINDSM.dll 是否与 DSM 第三方源同步");
const stagedDsm = path.join(root, "resources", "native", "win-ia32", "TWAINDSM.dll");
const vendorDsm = path.join(
  root,
  "native",
  "ScannerBridge",
  "third_party",
  "twain-dsm-2.5.1",
  "dsm",
  "win-ia32",
  "TWAINDSM.dll",
);
if (!existsSync(vendorDsm)) {
  fail(`找不到 DSM 第三方源 ${path.relative(root, vendorDsm)}：无法核对随包 TWAINDSM.dll 是否落后。`);
} else if (!existsSync(stagedDsm)) {
  fail(`找不到随包 ${path.relative(root, stagedDsm)}：扫描端安装包不能缺 DSM。`);
} else {
  const stagedHash = sha256(stagedDsm);
  const vendorHash = sha256(vendorDsm);
  if (stagedHash === vendorHash) {
    pass("随包 TWAINDSM.dll 与 third_party/dsm/win-ia32 源字节一致");
  } else {
    fail(
      "随包 TWAINDSM.dll 与 native/ScannerBridge/third_party/twain-dsm-2.5.1/dsm/win-ia32/TWAINDSM.dll 不一致："
        + "第三方 DSM 已升级但未同步 resources/native/win-ia32/，请按交叉打包工序拷贝并入库。",
    );
  }
}

console.log(`\nWindows 原生件（ia32 + x64）来源核对：${failures.length === 0 ? "通过" : `${failures.length} 项失败`}。`);
if (failures.length > 0) process.exit(1);
