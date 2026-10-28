/**
 * 继续扫描跨页面重挂载的顺序回归：
 *  - 自动开扫必须等数据源枚举结束，不能在「正在检测」时就发起扫描；
 *  - 枚举结果到达后保留本机记忆里仍有效的设备，不能被 Kodak/第一项覆盖；
 *  - 枚举晚到不能把已经进入 scanning 的面板切回 ready。
 *
 * 运行：npx tsx scripts/scanner-panel-autostart-smoke.ts
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createDefaultCard } from "../src/shared/defaultCard";

const dom = new JSDOM('<div id="root"></div>', { url: "https://scanner.test" });
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLFormElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "DocumentFragment", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
  install(name, name === "window" ? dom.window
    : name === "IS_REACT_ACT_ENVIRONMENT" ? true
    : (dom.window as unknown as Record<string, unknown>)[name]);
}
install("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof dom.window.matchMedia;

class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(_url: string) {}
  close() { this.closed = true; }
}
install("EventSource", FakeEventSource);

localStorage.setItem("projectx_scanner_mode", "local");
localStorage.setItem("projectx-scanner-settings-v1", JSON.stringify({
  dpi: 400,
  colorMode: "color",
  paperSize: "A4",
  maxSheets: 0,
  pageTimeoutSec: 0,
  showUi: false,
  selectedSource: "Kodak i3000",
}));

const card = createDefaultCard("autostart-review");
const scans: Array<Record<string, unknown>> = [];
let resolveSources!: (response: Response) => void;
const sourcesPending = new Promise<Response>((resolve) => { resolveSources = resolve; });
let sourcesCalls = 0;

install("fetch", async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/cards/")) return Response.json(card);
  if (url.endsWith("/sources")) {
    sourcesCalls += 1;
    return sourcesPending;
  }
  if (url.endsWith("/scan")) {
    scans.push(JSON.parse(String(init?.body)));
    return Response.json({ sessionId: "scan-autostart" });
  }
  // 面板卸载时会取消后台扫描（离开 = 不停设备是不允许的），这里同样要接住。
  if (/\/scan\/[^/]+\/cancel$/.test(url)) return Response.json({ ok: true });
  throw new Error(`Uncovered autostart request: ${url}`);
});

const { createRoot } = await import("react-dom/client");
const { ScannerPanel } = await import("../src/apps/answer-card/client/components/ScannerPanel");
const { TooltipProvider } = await import("../src/apps/answer-card/client/components/ui/v2");

const { serverStatus } = await import("../src/apps/answer-card/client/lib/remoteServerStatus");
const root = createRoot(document.getElementById("root")!);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
let consumed = 0;

try {
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(ScannerPanel, {
      cardId: card.id,
      autoStartScan: true,
      onAutoStartConsumed: () => { consumed += 1; },
    })));
  });
  await settle();
  assert.equal(sourcesCalls, 1, "挂载后开始枚举数据源");
  assert.equal(scans.length, 0, "数据源尚未返回时不能自动开扫");
  assert(!document.body.textContent?.includes("停止扫描"), "此时仍停留在检测/设置界面");

  await act(async () => {
    resolveSources(Response.json({ status: "ok", sources: [{ name: "EPSON" }, { name: "Kodak i3000" }] }));
  });
  await settle();
  assert.equal(consumed, 1, "自动开扫标记消费一次");
  assert.equal(scans.length, 1, "枚举结束后自动发起扫描");
  assert.equal(scans[0]?.sourceName, "Kodak i3000", "保留本机记忆里仍有效的设备，不覆盖成列表第一项");
  assert.equal(scans[0]?.dpi, 400, "继续扫描沿用本机记忆的 DPI");
  assert(document.body.textContent?.includes("停止扫描"), "自动开扫后进入扫描中，不被检测结果切回 ready");
  console.log("PASS scanner panel autostart: 等数据源 / 保留记忆设备 / 不被晚到结果覆盖");
} finally {
  await act(async () => { root.unmount(); });
  serverStatus.stop();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  dom.window.close();
}
