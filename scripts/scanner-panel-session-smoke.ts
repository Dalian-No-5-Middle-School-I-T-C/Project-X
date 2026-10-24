/** Mount the actual React panel; emit SSE events from its old render after card loading. */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { buildLayout } from "../src/shared/layout";
import { recognizedCells } from "../src/shared/scanCorrection";
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
const realSetTimeout = globalThis.setTimeout;
install("setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
  realSetTimeout(callback, delay === 5000 ? 0 : delay, ...args)) as typeof setTimeout);
let releaseCard!: () => void;
const cardReady = new Promise<void>(resolve => { releaseCard = resolve; });
const card = createDefaultCard("panel-review");
const version = cardFingerprint(card);
let cardRequests = 0;
let includeFailure = false;
let failNextSummary = false;
let failNextSnapshot = false;
let retainedPageCount = 2;
const snapshotRequests: string[] = [];
const summaryRequests: string[] = [];
const retryRequests: unknown[] = [];
const correctionSaves: Array<{ pages: unknown[] }> = [];
const summary = () => ({ failures: includeFailure ? [{ groupId: "1", studentId: null, stage: "recognition",
  message: "未识别学号", pages: [{ recordId: "page-2", pageNum: 2, layoutPage: 1, side: "front" }] }] : [],
  results: [
    { groupId: "0", studentId: "91001", pageCount: 1, needsReviewCount: 0,
      totalScore: 5, maxScore: 5, objectiveScore: 5, objectiveMaxScore: 5, subjectiveScore: 0, subjectiveMaxScore: 0,
      pages: [{ recordId: "page-1", pageNum: 1, layoutPage: 1, side: "front", objectiveScore: 5, subjectiveScore: 0, totalScore: 5, totalMaxScore: 5 }], saved: false },
    { groupId: "9", studentId: "91009", pageCount: 1, needsReviewCount: 1,
      totalScore: 0, maxScore: 5, objectiveScore: 0, objectiveMaxScore: 5, subjectiveScore: 0, subjectiveMaxScore: 0,
      pages: [{ recordId: "page-9", pageNum: 9, layoutPage: 1, side: "front", objectiveScore: 0, subjectiveScore: 0, totalScore: 0, totalMaxScore: 5 }], saved: false },
  ] });
install("fetch", async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/cards/")) { cardRequests++; await cardReady; return Response.json(card); }
  if (url.endsWith("/sources")) return Response.json({ sources: [], code: "NO_SOURCES" });
  if (url.endsWith("/scan")) {
    scans.push(JSON.parse(String(init?.body)));
    return Response.json({ sessionId: `scan-${scans.length}` });
  }
  if (/\/scan\/scan-\d+$/.test(url)) {
    snapshotRequests.push(url);
    if (failNextSnapshot) { failNextSnapshot = false; return Response.json({ message: "临时读取页面失败" }, { status: 503 }); }
    return Response.json({ session: { status: "error", error_msg: "未扫描到页面" }, records:
      Array.from({ length: retainedPageCount }, (_, index) => ({ id: `page-${index + 1}`, pageNum: index + 1,
        side: "front", studentId: index === 0 ? "91001" : null, studentConf: null, ocrStatus: "done" })) });
  }
  if (url.includes("/results") || url.endsWith("/validate")) {
    summaryRequests.push(`${init?.method ?? "GET"} ${url}`);
    if (failNextSummary) { failNextSummary = false; return Response.json({ message: "临时汇总失败" }, { status: 503 }); }
    const data = summary();
    if (init?.method === "POST" && url.endsWith("/results")) data.results.forEach(result => { result.saved = true; });
    return Response.json(data);
  }
  if (url.endsWith("/retry")) {
    retryRequests.push(JSON.parse(String(init?.body)));
    return Response.json({ ...summary(), warnings: ["重识别告警：历史灰度卷需改用彩色"] });
  }
  if (url.includes("/scan-image/")) return new Response("img", { headers: { "content-type": "image/png" } });
  if (url.endsWith("/health")) return Response.json({ ok: true, capabilities: { scannerClientApi: true } });
  if (/\/api\/scanner\/session\/[^/]+\/groups\/[^/]+\/correction$/.test(url)) {
    if (init?.method === "PUT") {
      correctionSaves.push(JSON.parse(String(init.body)) as { pages: unknown[] });
      return Response.json({ ok: true, saved: false, message: "填涂订正已保存，等待上传到关联考试" });
    }
    const page = buildLayout(card).pages[0];
    const sheet = {
      status: "ok", pageNumber: 1,
      studentId: { status: "ok", value: "91001" },
      questions: [{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }],
      subjectiveQuestions: [],
      geometry: { imageWidth: 1000, imageHeight: 1414, layoutToImage: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    } as never;
    return Response.json({ card, version: cardFingerprint(card), pages: [{
      sourceType: "twain_scan_record", sourceId: "page-1", revision: 1, layout: page,
      recognition: sheet, ...recognizedCells(page, sheet), imageUrl: "/api/scanner/scan-image/page-1",
    }] });
  }
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
  assert.equal(uploads.length, 2);
  assert.equal(uploads.some(item => item.name === "扫描_91009"), true, "存疑卷也要随完成自动上传");
  assert.equal(uploads[0].identityMode, "legacy");
  assert.equal(uploads[0].cardVersion, version);
  await click("开始新扫描"); await settle();
  card.title += " new local version";
  const nextVersion = cardFingerprint(card);
  await click("开始扫描"); await settle();
  assert.equal(scans[1].identityMode, "strict", "Legacy mode applies to one session");
  await act(async () => { streams[1].done(); }); await settle();
  assert.equal(uploads.length, 4);
  assert.equal(uploads[2].identityMode, "strict");
  assert.equal(uploads[2].cardVersion, nextVersion);
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
  assert.equal(uploads.length, 4, "A failed batch does not automatically upload partial results");
  await click("查看"); await settle();
  assert(document.querySelector('[role="dialog"] img[src*="page-1"]'), "View opens the retained page image");
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click(); }); await settle();
  await click("重新识别此卡"); await settle();
  assert.deepEqual(retryRequests, [{ groupId: "1" }]);
  assert(document.body.textContent?.includes("重识别告警：历史灰度卷需改用彩色"),
    "重新识别返回的告警要显示在扫描告警区");
  await click("刷新汇总"); await settle();
  assert.equal(uploads.length, 4, "Refreshing or correcting a partial session cannot auto-upload its successful cards");
  assert(document.body.textContent?.includes("实际输出 DPI 与设置不一致"), "Refresh and retry preserve the device error");
  await click("保存成功部分到服务器"); await settle();
  assert.equal(uploads.length, 6, "An explicit save uploads retained successful cards");
  assert.equal(uploads[4].cardVersion, nextVersion);
  assert(document.body.textContent?.includes("实际输出 DPI 与设置不一致"), "Explicit save also preserves the device error");
  await act(async () => { partial.onerror?.(); }); await settle();
  assert.equal(streams.length, 3, "Terminal errors do not reconnect the stream");
  await click("开始新扫描"); await settle();
  assert(!document.body.textContent?.includes("实际输出 DPI 与设置不一致"), "A new session clears the old device error");
  includeFailure = false;
  await click("开始扫描"); await settle();
  await act(async () => { streams[3].done(); }); await settle();
  assert.equal(uploads.length, 8, "A new complete session resumes normal automatic uploads");
  // 远端模式下这一卷已经随批次进入上传队列：从工作台改分必须当场说明改动不会回到服务器
  //（重复上传同一份卷子会被服务端当成第二份原卷，反而撤掉已保存的成绩）。
  await click("整卡改分"); await settle();
  const cell = document.querySelector("svg polygon") as SVGElement | null;
  assert(cell, "改分弹层渲染出可点选的填涂格");
  await act(async () => { cell.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle();
  await click("保存修改"); await settle();
  assert.equal(correctionSaves.length, 1, "工作台改分写入本机订正端点");
  assert(document.body.textContent?.includes("已随本批上传"), "工作台也要给出与后处理页一致的指路提示");

  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click(); }); await settle();

  await click("开始新扫描"); await settle();
  await click("开始扫描"); await settle();
  const summariesBeforeEmpty = summaryRequests.length;
  retainedPageCount = 0;
  await act(async () => { streams[4].emit({ type: "error", message: "未扫描到页面" }); }); await settle();
  assert(document.body.textContent?.includes("未扫描到页面"));
  assert(!hasAction("保存成功部分到服务器") && !hasAction("刷新汇总"), "A zero-page error keeps the scanner settings instead of an empty result panel");
  assert.equal(summaryRequests.length, summariesBeforeEmpty);
  assert(hasAction("开始扫描"));
  retainedPageCount = 1;
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
  assert.equal(uploads.length, 8, "Local partial results are saved locally");
  assert(document.body.textContent?.includes("走纸中断，本机已保留页面"));
  await click("开始新扫描"); await settle();
  await click("上传服务器"); await settle();
  await click("开始扫描"); await settle();
  retainedPageCount = 2;
  includeFailure = true;
  // A late initial connection receives only the terminal error, with no page events.
  await act(async () => { streams[6].emit({ type: "error", message: "迟到的终态错误" }); }); await settle();
  assert(document.body.textContent?.includes("扫描中断，已保留 2 页"));
  assert(document.body.textContent?.includes("91001") && hasAction("整卡改分") && hasAction("重新识别此卡"));
  assert.equal(uploads.length, 8, "Terminal replay hydrates persisted pages without uploading");
  await click("保存成功部分到服务器"); await settle();
  assert.equal(uploads.length, 10);
  await click("开始新扫描"); await settle();
  await click("开始扫描"); await settle();
  // Missing page events during a disconnect must also recover from persisted records.
  await act(async () => { streams[7].emit({ type: "page_done", recordId: "page-1", pageNum: 1, side: "front" }); });
  await act(async () => { streams[7].onerror?.(); }); await settle();
  assert.equal(streams.length, 9, "A disconnected progress stream is re-established");
  failNextSnapshot = true;
  await act(async () => { streams[8].emit({ type: "error", message: "重连后扫描中断" }); }); await settle();
  assert(document.body.textContent?.includes("临时读取页面失败") && hasAction("刷新汇总"));
  await click("刷新汇总"); await settle();
  assert(document.body.textContent?.includes("扫描中断，已保留 2 页"), "Persisted count replaces the incomplete SSE page list");
  assert(document.body.textContent?.includes("重连后扫描中断"));
  assert.equal(uploads.length, 10);
  await click("开始新扫描"); await settle();
  await click("开始扫描"); await settle();
  await act(async () => { streams[9].done(); }); await settle();
  assert.equal(uploads.length, 12, "The next completed session still uploads normally after terminal recovery");
  assert(!document.body.textContent?.includes("重连后扫描中断"));
  assert(document.body.textContent?.includes("扫描完成"));
  assert(snapshotRequests.length >= 7, "Error classification reads persisted pages, including zero-page errors and refreshes");
  console.log("PASS scanner panel React/SSE: session metadata; partial view/correction/save; terminal replay and reconnect hydrate persisted pages; hydration retry, zero-page and next-session recovery");
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
