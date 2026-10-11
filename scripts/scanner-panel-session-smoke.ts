/** Mount the actual React panel; emit SSE events from its old render after card loading. */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createDefaultCard } from "../src/shared/defaultCard";
import { cardFingerprint } from "../src/shared/cardVersion";
import type { StartUploadInput } from "../src/apps/answer-card/client/lib/scannerUploadManager";

const dom = new JSDOM('<div id="root"></div>', { url: "https://scanner.test" });
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLFormElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "DocumentFragment", "Element", "Node", "Event", "CustomEvent", "MutationObserver", "getComputedStyle"]) {
  install(name, name === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[name]);
}
install("IS_REACT_ACT_ENVIRONMENT", true);
install("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof dom.window.matchMedia;
localStorage.setItem("projectx_scanner_mode", "remote");
localStorage.setItem("projectx_server_url", "https://remote.test");
const uploads: StartUploadInput[] = [];
const scans: Array<{ identityMode: string }> = [];
const streams: FakeEventSource[] = [];
class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { streams.push(this); }
  close() {}
  done() { this.onmessage?.({ data: JSON.stringify({ type: "done" }) }); }
}
install("EventSource", FakeEventSource);
let releaseCard!: () => void;
const cardReady = new Promise<void>(resolve => { releaseCard = resolve; });
const card = createDefaultCard("panel-review");
const version = cardFingerprint(card);
let cardRequests = 0;
install("fetch", async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/cards/")) { cardRequests++; await cardReady; return Response.json(card); }
  if (url.endsWith("/sources")) return Response.json({ sources: [], code: "NO_SOURCES" });
  if (url.endsWith("/scan")) {
    scans.push(JSON.parse(String(init?.body)));
    return Response.json({ sessionId: `scan-${scans.length}` });
  }
  if (url.includes("/results") || url.endsWith("/validate")) return Response.json({ failures: [], results: [{ groupId: "0", studentId: "91001",
    pages: [{ recordId: "page-1", pageNum: 1, layoutPage: 1, side: "front" }], saved: false, objectiveQuestions: [], subjectiveQuestions: [], totalScore: 5 }] });
  if (url.endsWith("/health")) return Response.json({ ok: true, capabilities: { scannerClientApi: true } });
  throw new Error(`Uncovered panel request: ${url}`);
});
const { createRoot } = await import("react-dom/client");
const { ScannerPanel } = await import("../src/apps/answer-card/client/components/ScannerPanel");
const { TooltipProvider } = await import("../src/apps/answer-card/client/components/ui/v2");
const { scannerUploadManager } = await import("../src/apps/answer-card/client/lib/scannerUploadManager");
const { serverStatus } = await import("../src/apps/answer-card/client/lib/remoteServerStatus");
const startUpload = scannerUploadManager.startUpload;
scannerUploadManager.startUpload = input => { uploads.push(input); return `upload-${uploads.length}`; };
const root = createRoot(document.getElementById("root")!);
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  assert(button, `Missing panel action: ${label}`);
  await act(async () => { button.click(); });
}
try {
  await act(async () => { root.render(createElement(TooltipProvider, null, createElement(ScannerPanel, { cardId: card.id }))); });
  await settle();
  const checkbox = document.querySelector<HTMLButtonElement>('[role="checkbox"]');
  assert(checkbox, "Actual legacy-mode control is mounted");
  await act(async () => { checkbox.click(); });
  await click("开始扫描");
  assert.equal(scans.length, 0, "Early start waits for the card version before opening the scanner");
  assert(cardRequests >= 2, "Scan start captures a fresh local card version");
  await click("停止扫描");
  releaseCard(); await settle();
  assert.equal(scans.length, 0, "Cancelling during version loading prevents a late scan from starting");
  await click("开始扫描"); await settle();
  assert.equal(scans[0].identityMode, "legacy");
  assert.equal(streams.length, 1);
  // This handler was installed by the scan-start render, before the legacy
  // session state was committed. It must still upload with the session snapshot.
  await act(async () => { streams[0].done(); }); await settle();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].identityMode, "legacy");
  assert.equal(uploads[0].cardVersion, version);
  await click("开始新扫描"); await settle();
  card.title += " new local version";
  const nextVersion = cardFingerprint(card);
  await click("开始扫描"); await settle();
  assert.equal(scans[1].identityMode, "strict", "Legacy mode applies to one session");
  await act(async () => { streams[1].done(); }); await settle();
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].identityMode, "strict");
  assert.equal(uploads[1].cardVersion, nextVersion);
  assert.equal(uploads[0].cardVersion, version, "Later card loads cannot replace the original session version");
  console.log("PASS scanner panel React/SSE: early start/cancel guards version loading; legacy/strict sessions upload their own pinned metadata");
} finally {
  releaseCard();
  await act(async () => { root.unmount(); });
  serverStatus.stop(); scannerUploadManager.startUpload = startUpload;
  dom.window.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
