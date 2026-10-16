// Compile the production scan loop against a fake DSM/message clock. No scanner or Windows runtime is needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "scanner-native-recheck-"));
try {
  const source = readFileSync(path.join(root, "native/ScannerBridge/scanner-bridge/twain_controller.cpp"), "utf8");
  const methods = ["scan", "shouldWaitForTransfer", "queryFeederLoaded", "readCurrentUInt16Capability",
    "enableADF", "enableSource", "setPixelType", "setDuplex", "waitForState", "processTwainEvent"];
  const implementations = methods.map((name) => {
    const match = source.match(new RegExp(`^(?:ScanResult|bool|TW_UINT16) TwainController::${name}\\([\\s\\S]*?^}`, "m"));
    assert.ok(match, `Missing production method ${name}`);
    return match[0];
  }).join("\n\n");
  writeFileSync(path.join(dir, "production.inc"), `namespace ScannerBridge {\n${implementations}\n}`);
  writeFileSync(path.join(dir, "windows.h"), `#pragma once
#include <cstdint>
using DWORD = uint32_t;
using HWND = void*;
using HANDLE = void*;
struct MSG {};
constexpr int TRUE = 1, FALSE = 0, PM_REMOVE = 1;
DWORD GetTickCount();
void Sleep(DWORD);
bool PeekMessage(MSG*, void*, int, int, int);
void TranslateMessage(MSG*);
void DispatchMessage(MSG*);
void* GlobalLock(void*);
void GlobalUnlock(void*);
void GlobalFree(void*);
`);
  // Use the vendored SDK's portable declarations even when this test runs on macOS.
  const sdk = path.join(root, "native/ScannerBridge/third_party/twain-dsm-2.5.1/include/twain.h");
  writeFileSync(path.join(dir, "twain.h"), `#pragma once
#ifdef __APPLE__
#undef __APPLE__
#define SCANNER_TEST_APPLE 1
#endif
#include ${JSON.stringify(sdk)}
#ifdef SCANNER_TEST_APPLE
#define __APPLE__ 1
#endif
`);
  const exe = path.join(dir, "native-recheck");
  execFileSync(process.env.CXX || "c++", ["-std=c++17", "-Wall", "-Wextra", "-I", dir,
    "-I", path.join(root, "native/ScannerBridge/scanner-bridge"),
    path.join(root, "scripts/fixtures/scanner-native-recheck.cpp"), "-o", exe], { stdio: "inherit" });
  execFileSync(exe, [], { stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
