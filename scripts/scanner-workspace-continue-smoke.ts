/**
 * 工作台在已有批次时提供「继续扫描」，并直接把扫描面板挂出来开下一批。
 * 运行：npx tsx scripts/scanner-workspace-continue-smoke.ts
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
localStorage.setItem("projectx_scanner_mode", "local");

class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(_url: string) {}
  close() { this.closed = true; }
}
install("EventSource", FakeEventSource);

const card = createDefaultCard("workspace-continue");
const scans: Array<Record<string, unknown>> = [];
install("fetch", async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/cards/")) return Response.json(card);
  if (url.endsWith("/sources")) return Response.json({ status: "ok", sources: [{ name: "Kodak i3000" }] });
  if (url.endsWith("/scan")) {
    scans.push(JSON.parse(String(init?.body)));
    return Response.json({ sessionId: `scan-${scans.length}` });
  }
  if (/\/scan\/[^/]+\/cancel$/.test(url)) return Response.json({ ok: true });
  if (/\/scan\/[^/]+$/.test(url)) return Response.json({ session: { status: "scanning" }, records: [], workerActive: true });
  throw new Error(`Uncovered workspace request: ${url}`);
});

const { createRoot } = await import("react-dom/client");
const { ScannerWorkspace } = await import("../src/apps/answer-card/client/components/ScannerWorkspace");
const { TooltipProvider } = await import("../src/apps/answer-card/client/components/ui/v2");
const { serverStatus } = await import("../src/apps/answer-card/client/lib/remoteServerStatus");

const root = createRoot(document.getElementById("root")!);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
let openedPostprocess = 0;

try {
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(ScannerWorkspace, {
      cardId: card.id,
      cardTitle: "高一数学",
      onBack: () => undefined,
      postprocessBatchCount: 0,
    })));
  });
  await settle();
  assert(![...document.querySelectorAll("button")].some(node => node.textContent?.trim() === "继续扫描"), "还没有批次时不显示继续扫描");

  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(ScannerWorkspace, {
      cardId: card.id,
      cardTitle: "高一数学",
      onBack: () => undefined,
      postprocessBatchCount: 2,
      onOpenPostprocess: () => { openedPostprocess += 1; },
    })));
  });
  await settle();
  const continueButton = [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === "继续扫描");
  assert(continueButton, "已有批次时工作台提供继续扫描");
  await act(async () => { continueButton.click(); });
  await settle();
  assert.equal(scans.length, 1, "继续扫描直接开下一批");
  assert.equal(scans[0]?.cardId, card.id, "继续扫描仍落在当前答题卡");
  assert(document.body.textContent?.includes("停止扫描"), "继续扫描进入扫描中");
  assert.equal(openedPostprocess, 0, "继续扫描不先跳进后处理");
  console.log("PASS scanner workspace continue: 有批次才显示，点击后直接开扫");
} finally {
  await act(async () => { root.unmount(); });
  serverStatus.stop();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  dom.window.close();
}
