import { skinPatchDecision } from "../src/apps/answer-card/client/lib/skinPatchGuard";
import { createSkinPreferenceWriter } from "../src/apps/answer-card/client/lib/skinPreferenceWriter";

// 回归测试：PR #260 登录前切换皮肤误写账号偏好（陈旧闭包 PATCH）。
// 纯逻辑驱动：按 effect 执行序列推进 skinPatchDecision，统计 patch 次数。
//
// 场景记号：
//   - localOld  = 登录前本机 localStorage 里的皮肤（ScannerApp skin state 初值来源）
//   - account   = users.theme_skin（serverSkin）
//   - chosen    = 登录前显式选择（sessionStorage projectx-skin-chosen；null = 未选择）
//
// effect 序列模拟：
//   t1 = 登录完成的那次 effect 运行（user 由 null → 有值；skin 尚为切换前闭包值）
//   t2 = 同步 effect setSkin 生效后的那次运行（仅当 skin 实际变化时发生）

let passed = 0;
const failures: string[] = [];
function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function runScenario(
  label: string,
  args: {
    localOld: string;
    account: string;
    chosen: string | null;
    postLoginSwitch?: string | null;
  },
): { patches: number; patchedValues: string[] } {
  const { localOld, account, chosen, postLoginSwitch } = args;
  let prevUserId: string | null = null;
  const patchedValues: string[] = [];

  // ── 登录前：未登录态下切换/落盘不触发 PATCH ──
  if (chosen !== null) {
    const d = skinPatchDecision(prevUserId, null, chosen, account, chosen);
    check(d.patch === false && d.nextPrevUserId === null, `${label} · 未登录态不产生 PATCH`);
  }

  // ── t1：认证完成。skin 闭包值 = 受控接线时已提前更新的值 / 或本机旧值（无选择时）──
  const skinAtT1 = chosen ?? localOld;
  const d1 = skinPatchDecision(prevUserId, "u1", skinAtT1, account, chosen);
  prevUserId = d1.nextPrevUserId;
  if (d1.patch) patchedValues.push(skinAtT1);
  // 护栏核心断言：登录瞬态只允许回写「显式选择异于账号」这一种情况
  const expectT1Patch = chosen !== null && chosen !== account;
  check(
    d1.patch === expectT1Patch,
    `${label} · t1 登录瞬态判定正确（期望 ${expectT1Patch ? "回写显式选择" : "跳过"}）`,
  );

  // ── 同步 effect：chosen || account 写入 skin（Object.is 相同则无重渲染）──
  const syncedSkin = chosen ?? account;
  if (syncedSkin !== skinAtT1) {
    const d2 = skinPatchDecision(prevUserId, "u1", syncedSkin, account, chosen);
    prevUserId = d2.nextPrevUserId;
    if (d2.patch) patchedValues.push(syncedSkin);
  }

  // ── 可选：登录后在扫描工作台内主动切换 ──
  if (postLoginSwitch !== undefined && postLoginSwitch !== null) {
    const d3 = skinPatchDecision(prevUserId, "u1", postLoginSwitch, account, chosen);
    prevUserId = d3.nextPrevUserId;
    if (d3.patch) patchedValues.push(postLoginSwitch);
  }

  return { patches: patchedValues.length, patchedValues };
}

console.log("\n== 场景 S1（#260 缺陷复现）：本机旧 flat ≠ 账号 paper-edge，登录前选择与账号同款 ==");
{
  const r = runScenario("S1", { localOld: "flat", account: "paper-edge", chosen: "paper-edge" });
  check(r.patches === 0, `S1 · 全程零 PATCH（实际 ${r.patches} 次：${r.patchedValues.join(",") || "无"}）`);
}

console.log("\n== 场景 S2：登录前显式选择异于账号 → 应恰好一次 PATCH 且值为所选皮肤 ==");
{
  const r = runScenario("S2", { localOld: "flat", account: "flat", chosen: "paper-edge" });
  check(r.patches === 1 && r.patchedValues[0] === "paper-edge", `S2 · 恰一次 PATCH paper-edge（实际 ${r.patches} 次）`);
}

console.log("\n== 场景 S3：登录前无选择、本机旧值 ≠ 账号 → 账号权威，不得被本机旧值覆盖 ==");
{
  const r = runScenario("S3", { localOld: "flat", account: "paper-edge", chosen: null });
  check(r.patches === 0, `S3 · 零 PATCH（实际 ${r.patches} 次：${r.patchedValues.join(",") || "无"}）`);
}

console.log("\n== 场景 S4：登录后工作台内切换 → 正常回写一次 ==");
{
  const r = runScenario("S4", { localOld: "flat", account: "paper-edge", chosen: null, postLoginSwitch: "flat" });
  check(r.patches === 1 && r.patchedValues[0] === "flat", `S4 · 恰一次 PATCH flat（实际 ${r.patches} 次）`);
}

console.log("\n== 场景 S5：登出清除 → 换账号重登，登录瞬态仍受护栏保护 ==");
{
  let prevUserId: string | null = "u1";
  const dLogout = skinPatchDecision(prevUserId, null, "paper-edge", "paper-edge", null);
  check(dLogout.patch === false && dLogout.nextPrevUserId === null, "S5 · 登出重置护栏状态");
  prevUserId = dLogout.nextPrevUserId;
  const dRelogin = skinPatchDecision(prevUserId, "u2", "flat", "paper-edge", null);
  check(dRelogin.patch === false, "S5 · 换账号 u2 登录瞬态跳过 PATCH");
}

console.log("\n== 场景 S6：记住密码冷启动直登（首挂即有会话）→ 首次运行视为瞬态 ==");
{
  const d = skinPatchDecision(null, "u1", "flat", "paper-edge", null);
  check(d.patch === false && d.nextPrevUserId === "u1", "S6 · 冷启动首次运行不 PATCH 且记录 userId");
}

// ── R49：回写成功后必须更新「本地权威快照」，否则 A→B→A 的最后一步会被跳过 ──
// 把组件里的判定压成一台小状态机：account=服务端值、snapshot=前端 user.themeSkin、skin=本机当前皮肤；
// 组件的闸门是「skin 与 snapshot 一致就不回写」，回写成功才更新 snapshot。
async function simulateSkinFlow(opts: {
  account: string;
  sequence: string[];
  writeBack: boolean;
}): Promise<{ account: string; snapshot: string; patches: string[] }> {
  let account = opts.account;
  let snapshot = opts.account;
  const patches: string[] = [];
  const writer = createSkinPreferenceWriter(async (skin) => {
    account = skin;
    patches.push(skin);
  });
  for (const skin of opts.sequence) {
    if (skin === snapshot) continue;
    await writer(skin, (applied) => { if (opts.writeBack) snapshot = applied; }, () => {});
  }
  return { account, snapshot, patches };
}

console.log("\n== 场景 R49-1：切 A→B→A，回写成功后账号回到 A（验收口径）==");
{
  const r = await simulateSkinFlow({ account: "flat", sequence: ["paper-edge", "flat"], writeBack: true });
  check(
    r.account === "flat" && r.patches.length === 2,
    `R49-1 · 两次回写后服务端为 flat（实际 ${r.account}，PATCH ${r.patches.join("→") || "无"}）`
  );
}

console.log("\n== 场景 R49-2：不回写本地快照 → 复现原缺陷（账号停在 paper-edge）==");
{
  const r = await simulateSkinFlow({ account: "flat", sequence: ["paper-edge", "flat"], writeBack: false });
  check(
    r.account === "paper-edge" && r.patches.length === 1,
    `R49-2 · 缺回写时最后一步被跳过（服务端 ${r.account}，PATCH ${r.patches.length} 次）——这正是修复前的行为`
  );
}

console.log("\n== 场景 R49-3：连续切换时旧响应后到，不得覆盖最新选择 ==");
{
  const settle: Array<() => void> = [];
  let account = "flat";
  let snapshot = "flat";
  const writer = createSkinPreferenceWriter(
    (skin) => new Promise<void>((resolve) => { settle.push(() => { account = skin; resolve(); }); })
  );
  const first = writer("paper-edge", (applied) => { snapshot = applied; }, () => {});
  const second = writer("dark", (applied) => { snapshot = applied; }, () => {});
  settle[1]();          // 后发的请求先返回
  await second;
  settle[0]();          // 先发请求的旧响应后到
  const firstOutcome = await first;
  check(
    firstOutcome === "superseded" && snapshot === "dark",
    `R49-3 · 旧响应判为 ${firstOutcome}，本地快照停在 ${snapshot}（期望 superseded / dark）`
  );
}

console.log("\n== 场景 R49-4：PATCH 失败 → 走 onFailed，本地快照不能被写成假成功 ==");
{
  let snapshot = "flat";
  let failedCalls = 0;
  const writer = createSkinPreferenceWriter(async () => { throw new Error("offline"); });
  const outcome = await writer("paper-edge", (applied) => { snapshot = applied; }, () => { failedCalls += 1; });
  check(
    outcome === "failed" && failedCalls === 1 && snapshot === "flat",
    `R49-4 · 结果为 ${outcome}，onFailed 调用 ${failedCalls} 次，快照仍为 ${snapshot}（调用方据此 refreshUser）`
  );
}

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
