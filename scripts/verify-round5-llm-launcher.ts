/**
 * 五轮测试 B1：llmclient sidecar 路径解析（Electron 打包场景）+ 快速失败窗口。
 * 用法：npx tsx scripts/verify-round5-llm-launcher.ts（期望全绿，退出码 0）
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

import { repoRootCandidates } from "../src/apps/answer-card/server/llm-launcher";

section("repoRoot 候选解析 — Electron resources 场景");
const base = mkdtempSync(path.join(tmpdir(), "round5-llm-"));
const resources = path.join(base, "resources");
mkdirSync(path.join(resources, "llmclient"), { recursive: true });
writeFileSync(path.join(resources, "llmclient", "server.py"), "print(1)");

const root = repoRootCandidates([resources, path.join(base, "elsewhere")]);
ok(root === resources, `在 resources 候选下找到 llmclient 根 (${root})`);

section("普通 cwd 场景");
mkdirSync(path.join(base, "elsewhere", "llmclient"), { recursive: true });
writeFileSync(path.join(base, "elsewhere", "llmclient", "server.py"), "print(1)");
const root2 = repoRootCandidates([path.join(base, "elsewhere")]);
ok(root2 === path.join(base, "elsewhere"), "cwd 候选命中");

section("都找不到时回退第一个候选");
const root3 = repoRootCandidates([path.join(base, "nope")]);
ok(root3 === path.join(base, "nope"), "无命中回退首个候选");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }