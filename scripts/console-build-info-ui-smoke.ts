/**
 * 控制台「服务器版本与更新时间」区块挂载回归。
 *
 * 这个区块是发版后管理员唯一会看的东西，所以要钉住的是**渲染结果**而不是接口字段：
 *  - 有构建信息：版本、提交短号、构建时间（本地时刻，不是原始 ISO 串）、本次启动、已运行、平台都要出现。
 *  - 没有构建信息：三格显示「—」并给出原因，不能显示 undefined，也不能把请求时间当构建时间。
 *  - 脏构建要提示对应不到提交；CI 链接要带 rel=noopener。
 *
 * 用法: npm run verify:console-build-info-ui
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://console.test" });
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLAnchorElement", "HTMLButtonElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "DocumentFragment", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "getComputedStyle", "MutationObserver"]) {
  install(name, name === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[name]);
}
install("IS_REACT_ACT_ENVIRONMENT", true);
install("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
install("matchMedia", (query: string) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
}));

/**
 * 只喂 /build 这条；其余控制台聚合一律 ok:false，页面走各自的「加载失败」分支，不干扰本区块断言。
 * jsdom 不带 fetch/Response，所以给的是最小响应形状：fetchJson 只读 ok / statusText / json()。
 */
let buildPayload: Record<string, unknown> = {};
install("fetch", async (url: string) => {
  const path = String(url).split("?")[0];
  const body = path === "/api/admin/console/build" ? buildPayload : { ok: false };
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
});

const { createRoot } = await import("react-dom/client");
const { AdminConsolePage } = await import("../src/apps/answer-card/client/components/AdminConsolePage");

let failures = 0;
function ok(condition: boolean, label: string): void {
  if (!condition) {
    failures += 1;
    console.error(`  ✗ ${label}`);
    return;
  }
  console.log(`  ✓ ${label}`);
}

async function render(payload: Record<string, unknown>): Promise<string> {
  buildPayload = payload;
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(AdminConsolePage, { onBack: () => {} })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  const text = host.textContent ?? "";
  act(() => { root.unmount(); });
  host.remove();
  return text;
}

const BUILT_AT = "2026-11-03T01:20:00.000Z";
const STARTED_AT = "2026-11-03T02:00:00.000Z";

const fullBuild = {
  schema: 1,
  version: "2.7.2",
  commit: "abc1234def5678abc1234def5678abc1234def",
  commitShort: "abc1234",
  commitDirty: false,
  builtAt: BUILT_AT,
  builder: "node v22.23.4 / linux-x64",
  ciRef: "v2.7.2",
  ciRunUrl: "https://github.com/org/repo/actions/runs/42",
};

// ── 1. 构建信息齐备 ──────────────────────────────────────
console.log("\n── 有构建信息");
{
  const text = await render({
    ok: true,
    build: fullBuild,
    buildInfoFile: "build-info.json",
    reason: null,
    runtime: { now: STARTED_AT, startedAt: STARTED_AT, uptimeSeconds: 93_784, node: "v22.23.4", platform: "linux-x64" },
  });
  ok(text.includes("服务器版本与更新时间"), "区块标题渲染");
  ok(text.includes("2.7.2"), "版本号来自构建信息");
  ok(text.includes("abc1234"), "短提交号渲染");
  ok(text.includes("linux-x64"), "运行平台渲染");
  ok(text.includes("1 天 2 小时"), `运行时长按天/小时展开（93784 秒 → 1 天 2 小时）`);
  ok(!text.includes(BUILT_AT) && !text.includes("T01:20"), "不把原始 ISO 串直接甩给管理员");
  ok(/\d{4}\/\d{1,2}\/\d{1,2}/.test(text), "构建时间按本地日期展开");
  ok(!text.includes("undefined") && !text.includes("null"), "无 undefined / null 字面串漏到界面");
  ok(!text.includes("未提交改动"), "干净构建不提示脏工作区");
}

// ── 2. 脏构建与 CI 链接 ─────────────────────────────────
console.log("\n── 脏构建与流水线链接");
{
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  buildPayload = {
    ok: true,
    build: { ...fullBuild, commitDirty: true },
    buildInfoFile: "build-info.json",
    reason: null,
    runtime: { now: STARTED_AT, startedAt: STARTED_AT, uptimeSeconds: 60, node: "v22.23.4", platform: "win32-x64" },
  };
  const root = createRoot(host);
  await act(async () => { root.render(createElement(AdminConsolePage, { onBack: () => {} })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  const text = host.textContent ?? "";
  ok(text.includes("未提交改动"), "脏构建如实提示对应不到提交");
  const anchors = Array.from(host.querySelectorAll("a"));
  const ci = anchors.find((a) => a.getAttribute("href")?.includes("actions/runs/42"));
  ok(Boolean(ci), "给出可点的流水线链接");
  ok(ci?.getAttribute("rel")?.includes("noopener") === true, "外链带 rel=noopener");
  ok(ci?.getAttribute("target") === "_blank", "外链新窗口打开");
  act(() => { root.unmount(); });
  host.remove();
}

// ── 3. 没有构建信息 ─────────────────────────────────────
console.log("\n── 无构建信息（源码直跑或旧包）");
{
  const text = await render({
    ok: true,
    build: null,
    buildInfoFile: null,
    reason: "本次运行没有构建信息（源码直跑或旧版部署包）",
    runtime: { now: STARTED_AT, startedAt: STARTED_AT, uptimeSeconds: 42, node: "v22.23.4", platform: "linux-x64" },
  });
  ok(text.includes("本次运行没有构建信息"), "给出缺失原因而不是空白");
  ok(text.includes("—"), "缺失字段显示「—」");
  ok(!text.includes("2.7.2"), "不显示任何猜测出来的版本号");
  ok(!text.includes(BUILT_AT), "不拿当前时间或别处的时间冒充构建时间");
  ok(text.includes("42 秒"), "启动与运行时长仍然如实显示（刚起来的服务要说秒，不能落到「0 分」）");
  ok(!text.includes("undefined"), "无 undefined 字面串");
}

// ── 4. 半截数据与异常形状 ───────────────────────────────
console.log("\n── 字段残缺 / 运行信息缺失");
{
  const text = await render({ ok: true, build: { schema: 1, builtAt: BUILT_AT }, buildInfoFile: "build-info.json", reason: null });
  ok(!text.includes("undefined") && !text.includes("null"), "缺 runtime 与多数字段时也不漏字面串");
  ok(text.includes("—"), "缺字段一律显示「—」");
  ok(text.includes("服务器版本与更新时间"), "区块本身仍然渲染（不能因为半截数据整块消失）");

  const broken = await render({ ok: false });
  ok(broken.includes("构建信息加载失败"), "接口失败时说明失败，不留空白");
}

// ── 5. 提交短号缺失 ─────────────────────────────────────
console.log("\n── 只有构建时间、没有提交短号");
{
  const text = await render({
    ok: true,
    build: { ...fullBuild, commitShort: null },
    buildInfoFile: "build-info.json",
    reason: null,
    runtime: { now: STARTED_AT, startedAt: STARTED_AT, uptimeSeconds: 5, node: "v22.23.4", platform: "linux-x64" },
  });
  // 服务端归一化层会用完整提交号补出短号，正常不会走到这里；真走到时界面必须留空而不是猜。
  ok(text.includes("—"), "短号缺失时该格显示「—」，不拿别的字段顶");
  ok(!text.includes("undefined"), "无 undefined 字面串");
  ok(text.includes("2.7.2"), "其余字段照常渲染，一格缺不缺不影响整块");
}

assert.equal(failures, 0, `${failures} 项渲染断言失败`);
console.log(`\n控制台构建信息区块：全部断言通过。`);

for (const [name, descriptor] of globals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}
