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
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLFormElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "DocumentFragment", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle"]) {
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
  closed = false;
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  done() { this.onmessage?.({ data: JSON.stringify({ type: "done" }) }); }
}
install("EventSource", FakeEventSource);
let releaseCard!: () => void;
const cardReady = new Promise<void>(resolve => { releaseCard = resolve; });
const card = createDefaultCard("panel-review");
const version = cardFingerprint(card);
let cardRequests = 0;
let includeFailure = false;
let failNextSummary = false;
const summaryRequests: string[] = [];
const retryRequests: unknown[] = [];
const summary = () => ({ failures: includeFailure ? [{ groupId: "1", studentId: null, stage: "recognition",
  message: "未识别学号", pages: [{ recordId: "page-2", pageNum: 2, layoutPage: 1, side: "front" }] }] : [],
  results: [{ groupId: "0", studentId: "91001", pageCount: 1, needsReviewCount: 0,
    totalScore: 5, maxScore: 5, objectiveScore: 5, objectiveMaxScore: 5, subjectiveScore: 0, subjectiveMaxScore: 0,
    pages: [{ recordId: "page-1", pageNum: 1, layoutPage: 1, side: "front", objectiveScore: 5, subjectiveScore: 0, totalScore: 5, totalMaxScore: 5 }], saved: false }] });
install("fetch", async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/cards/")) { cardRequests++; await cardReady; return Response.json(card); }
  if (url.endsWith("/sources")) return Response.json({ sources: [], code: "NO_SOURCES" });
  if (url.endsWith("/scan")) {
    scans.push(JSON.parse(String(init?.body)));
    return Response.json({ sessionId: `scan-${scans.length}` });
  }
  if (url.includes("/results") || url.endsWith("/validate")) {
    summaryRequests.push(`${init?.method ?? "GET"} ${url}`);
    if (failNextSummary) { failNextSummary = false; return Response.json({ message: "临时汇总失败" }, { status: 503 }); }
    const data = summary();
    if (init?.method === "POST" && url.endsWith("/results")) data.results.forEach(result => { result.saved = true; });
    return Response.json(data);
  }
  if (url.endsWith("/retry")) { retryRequests.push(JSON.parse(String(init?.body))); return Response.json(summary()); }
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
function hasAction(label: string) {
  return [...document.querySelectorAll("button")].some(node => node.textContent?.trim() === label);
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
  await click("开始新扫描"); await settle();
  includeFailure = true;
  failNextSummary = true;
  await click("开始扫描"); await settle();
  const partial = streams[2];
  await act(async () => {
    partial.emit({ type: "page_done", recordId: "partial-page", pageNum: 1, side: "front" });
    partial.emit({ type: "page_done", recordId: "page-2", pageNum: 2, side: "front" });
    partial.emit({ type: "error", message: "实际输出 DPI 与设置不一致" });
  }); await settle();
  assert.equal(partial.closed, true, "Terminal errors close the progress stream");
  assert(document.body.textContent?.includes("实际输出 DPI 与设置不一致"), "Partial summary preserves the scanner error");
  assert(document.body.textContent?.includes("临时汇总失败"));
  assert(document.body.textContent?.includes("扫描中断，已保留 2 页"));
  assert(hasAction("刷新汇总"), "A failed partial summary keeps its retry action visible");
  await click("刷新汇总"); await settle();
  assert(!document.body.textContent?.includes("临时汇总失败"), "A successful refresh clears the transient summary error");
  assert(document.body.textContent?.includes("91001"), "Retained student results are visible after a scan error");
  assert(hasAction("查看") && hasAction("查看失败卡"), "Both successful and failed cards can be viewed");
  assert(hasAction("整卡改分") && hasAction("重新识别此卡"), "Correction controls remain available");
  assert(hasAction("保存成功部分到服务器"), "Partial results retain the explicit save action");
  assert.equal(uploads.length, 2, "A failed batch does not automatically upload partial results");
  await click("查看"); await settle();
  assert(document.querySelector('[role="dialog"] img[src*="page-1"]'), "View opens the retained page image");
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click(); }); await settle();
  await click("重新识别此卡"); await settle();
  assert.deepEqual(retryRequests, [{ groupId: "1" }]);
  await click("刷新汇总"); await settle();
  assert.equal(uploads.length, 2, "Refreshing or correcting a partial session cannot auto-upload its successful cards");
  assert(document.body.textContent?.includes("实际输出 DPI 与设置不一致"), "Refresh and retry preserve the device error");
  await click("保存成功部分到服务器"); await settle();
  assert.equal(uploads.length, 3, "An explicit save uploads retained successful cards");
  assert.equal(uploads[2].cardVersion, nextVersion);
  assert(document.body.textContent?.includes("实际输出 DPI 与设置不一致"), "Explicit save also preserves the device error");
  await act(async () => { partial.onerror?.(); }); await settle();
  assert.equal(streams.length, 3, "Terminal errors do not reconnect the stream");
  await click("开始新扫描"); await settle();
  assert(!document.body.textContent?.includes("实际输出 DPI 与设置不一致"), "A new session clears the old device error");
  includeFailure = false;
  await click("开始扫描"); await settle();
  await act(async () => { streams[3].done(); }); await settle();
  assert.equal(uploads.length, 4, "A new complete session resumes normal automatic uploads");
  await click("开始新扫描"); await settle();
  await click("开始扫描"); await settle();
  const summariesBeforeEmpty = summaryRequests.length;
  await act(async () => { streams[4].emit({ type: "error", message: "未扫描到页面" }); }); await settle();
  assert(document.body.textContent?.includes("未扫描到页面"));
  assert(!hasAction("保存成功部分到服务器") && !hasAction("刷新汇总"), "A zero-page error keeps the scanner settings instead of an empty result panel");
  assert.equal(summaryRequests.length, summariesBeforeEmpty);
  assert(hasAction("开始扫描"));
  await click("本地存储"); await settle();
  await click("开始扫描"); await settle();
  await act(async () => {
    streams[5].emit({ type: "page_done", recordId: "page-1", pageNum: 1, side: "front" });
    streams[5].emit({ type: "error", message: "走纸中断，本机已保留页面" });
  }); await settle();
  assert(hasAction("保存成功部分"));
  assert.match(summaryRequests.at(-1)!, /^POST .*\/validate$/);
  await click("保存成功部分"); await settle();
  assert.match(summaryRequests.at(-1)!, /^POST .*\/results$/);
  assert.equal(uploads.length, 4, "Local partial results are saved locally");
  assert(document.body.textContent?.includes("走纸中断，本机已保留页面"));
  console.log("PASS scanner panel React/SSE: session metadata; partial results visible/viewable/retryable; explicit save only; error retained; next-session and zero-page recovery");
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
