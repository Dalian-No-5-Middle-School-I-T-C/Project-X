/** 后处理页真实组件挂载回归：三视图渲染、画布↔表格双向即时同步、多选删除 409 二次确认、
 *  改考号只替换 digit 格不伤其他填涂、按组补传的卡版本指纹与队列清零。 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { cardFingerprint } from "../src/shared/cardVersion";
import { recognizedCells, type CorrectionDocument } from "../src/shared/scanCorrection";
import type { StartUploadInput } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import type { ScanBatchResponse } from "../src/shared/scanPages";

const dom = new JSDOM('<div id="root"></div>', { url: "https://scanner.test" });
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLFormElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "DocumentFragment", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "Blob"]) {
  install(name, name === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[name]);
}
install("IS_REACT_ACT_ENVIRONMENT", true);
install("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
// jsdom 没有滚动布局，scrollIntoView 在真实浏览器/Electron 里恒存在，这里只补空实现
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof dom.window.matchMedia;
install("URL", dom.window.URL);
(dom.window.URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:stub";
(dom.window.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
(globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:stub";
(globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
localStorage.setItem("projectx_scanner_mode", "local");

// ── 夹具：单页卡，1 道单选（下拉）+ 1 道多选（chips，可点击）──
const card = createDefaultCard("postprocess");
card.title = "后处理页夹具";
card.bodyBlocks = [
  { id: "pp_single", type: "objective", title: "单选", questionStart: 1, questionCount: 1, optionCount: 4,
    mode: "single", scorePerQuestion: 5, answerKey: { "1": ["A"] }, density: "normal" },
  { id: "pp_multi", type: "objective", title: "多选", questionStart: 2, questionCount: 1, optionCount: 4,
    mode: "multiple", scorePerQuestion: 5, answerKey: { "2": ["B", "C"] }, density: "normal" },
];
assert.equal(buildLayout(card).pages.length, 1, "夹具为单页卡");
const version = cardFingerprint(card);
const layout = buildLayout(card).pages[0];
const recognition = {
  status: "ok", pageNumber: 1,
  studentId: { status: "ok", value: "10001" },
  questions: [
    { questionNumber: 1, selectedOptions: ["A"], confidence: 0.9 },
    { questionNumber: 2, selectedOptions: ["B", "C"], confidence: 0.05 },
  ],
  subjectiveQuestions: [],
  geometry: { imageWidth: 1000, imageHeight: 1414, layoutToImage: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
} as unknown as Parameters<typeof recognizedCells>[1];
const derived = recognizedCells(layout, recognition);
const correctionDocument: CorrectionDocument = {
  card, version,
  pages: [{
    sourceType: "twain_scan_record", sourceId: "rec-1", revision: 3, layout,
    recognition: recognition as never, selected: derived.selected, invalid: derived.invalid,
    imageUrl: "/api/scanner/scan-image/rec-1",
  }],
};

let secondGroupResolved = false;
let allClean = false;
let deleteBlockedOnce = false;
const groupTwoResult = {
  groupId: "1", studentId: "10002", totalScore: 10, maxScore: 10, objectiveScore: 10, objectiveMaxScore: 10,
  subjectiveScore: 0, subjectiveMaxScore: 0, needsReviewCount: 0, pageCount: 1, saved: false,
  pages: [{ recordId: "rec-2", pageNum: 2, side: "front" as const, layoutPage: 1, objectiveScore: 10, subjectiveScore: 0, totalScore: 10, totalMaxScore: 10 }],
};
const batch = (): ScanBatchResponse => ({
  results: [
    { groupId: "0", studentId: "10001", totalScore: 5, maxScore: 10, objectiveScore: 5, objectiveMaxScore: 10,
      subjectiveScore: 0, subjectiveMaxScore: 0, needsReviewCount: allClean ? 0 : 1, pageCount: 1, saved: false,
      pages: [{ recordId: "rec-1", pageNum: 1, side: "front", layoutPage: 1, objectiveScore: 5, subjectiveScore: 0, totalScore: 5, totalMaxScore: 10 }] },
    { groupId: "2", studentId: "10003", totalScore: 10, maxScore: 10, objectiveScore: 10, objectiveMaxScore: 10,
      subjectiveScore: 0, subjectiveMaxScore: 0, needsReviewCount: 0, pageCount: 1, saved: false,
      pages: [{ recordId: "rec-3", pageNum: 3, side: "front", layoutPage: 1, objectiveScore: 10, subjectiveScore: 0, totalScore: 10, totalMaxScore: 10 }] },
    ...(secondGroupResolved ? [groupTwoResult] : []),
  ],
  failures: secondGroupResolved ? [] : [{ groupId: "1", studentId: null, stage: "recognition" as const, message: "Student ID recognition failed.",
    pages: [{ recordId: "rec-2", pageNum: 2, side: "front" as const, layoutPage: 1 }] }],
  reviewCards: [],
});

const puts: Array<{ groupId: string; pages: Array<{ sourceId: string; selected: string[] }> }> = [];
const deletes: Array<{ url: string; body: { groupIds: string[]; force?: boolean } }> = [];
/** 第二批会话：groupId 与第一批重号，用来钉住「删除必须按会话下发」 */
const batchFor = (sessionId: string): ScanBatchResponse => {
  const first = batch();
  if (sessionId !== "scan-2") return first;
  return {
    results: [
      { ...first.results[1], groupId: "0", studentId: "20001", pages: first.results[1].pages.map(page => ({ ...page, recordId: "rec-4", pageNum: 4 })) },
      { ...first.results[1], groupId: "1", studentId: "20002", pages: first.results[1].pages.map(page => ({ ...page, recordId: "rec-5", pageNum: 5 })) },
    ],
    failures: [],
    reviewCards: [],
  };
};
install("fetch", async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.includes("/api/cards/")) return Response.json(card);
  const sessionMatch = url.match(/\/api\/scanner\/session\/([^/]+)\/(validate|results)/);
  if (sessionMatch) return Response.json(batchFor(sessionMatch[1]));
  if (/\/api\/scanner\/scan\/[^/]+$/.test(url)) {
    return Response.json({ session: { identity_mode: "strict", dpi: 300, paper_size: "A4" }, records: [], examId: 7 });
  }
  if (/\/api\/scanner\/card\/[^/]+\/scans$/.test(url)) {
    return Response.json([
      { recordId: "rec-1", createdAt: "2026-10-17 09:00:01", scanQuality: 88.5 },
      { recordId: "rec-2", createdAt: "2026-10-17 09:00:02", scanQuality: 71.25 },
      { recordId: "rec-3", createdAt: "2026-10-17 09:00:03", scanQuality: 90 },
    ]);
  }
  if (/\/participant-search\?/.test(url)) return Response.json({ ok: true, students: [{ id: 11, name: "张三", student_number: "10002" }] });
  if (/\/groups\/[^/]+\/correction$/.test(url)) {
    if (method === "PUT") {
      puts.push({ groupId: url.match(/\/groups\/([^/]+)\/correction$/)![1], pages: (JSON.parse(String(init?.body)) as { pages: never[] }).pages });
      return Response.json({ ok: true });
    }
    return Response.json(correctionDocument);
  }
  if (/\/scan-image\//.test(url)) return new Response("img", { headers: { "content-type": "image/png" } });
  if (url.endsWith("/groups") && method === "DELETE") {
    const body = JSON.parse(String(init?.body)) as { groupIds: string[]; force?: boolean };
    deletes.push({ url, body });
    if (!body.force && !deleteBlockedOnce) {
      deleteBlockedOnce = true;
      return Response.json({ message: "所选卷包含已上传或待确认的回执", blocked: body.groupIds }, { status: 409 });
    }
    return Response.json({ ...batch(), deletedGroups: body.groupIds.length, missingGroups: [] });
  }
  if (url.endsWith("/retry") || url.endsWith("/discard")) return Response.json(batch());
  throw new Error(`Uncovered postprocess request: ${method} ${url}`);
});

const { createRoot } = await import("react-dom/client");
const { ScannerPostprocessPage } = await import("../src/apps/answer-card/client/components/ScannerPostprocessPage");
const { TooltipProvider } = await import("../src/apps/answer-card/client/components/ui/v2");
const { scannerUploadManager } = await import("../src/apps/answer-card/client/lib/scannerUploadManager");
const uploads: StartUploadInput[] = [];
const realStartUpload = scannerUploadManager.startUpload;
scannerUploadManager.startUpload = (input => { uploads.push(input); return `upload-${uploads.length}`; }) as typeof scannerUploadManager.startUpload;

const root = createRoot(document.getElementById("root")!);
let root2: ReturnType<typeof createRoot> | null = null;
async function settle(ms = 12) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
async function clickNode(node: Element) {
  await act(async () => {
    // SVG polygon 没有 HTMLElement.click()，统一派发冒泡的 click 事件
    if (typeof (node as HTMLElement).click === "function") (node as HTMLElement).click();
    else node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function clickText(label: string) {
  const node = [...document.querySelectorAll("button")].find(el => el.textContent?.trim() === label)
    ?? [...document.querySelectorAll("button")].find(el => el.textContent?.trim().startsWith(label));
  assert(node, `Missing button: ${label}`);
  await clickNode(node);
}
async function clickSelector(selector: string) {
  const node = document.querySelector(selector);
  assert(node, `Missing element: ${selector}`);
  await clickNode(node);
}
const text = () => document.body.textContent ?? "";
const totalShown = () => text().match(/总分 ([\d.]+)/)?.[1] ?? "";
const saveButton = () => [...document.querySelectorAll("button")].find(el => el.textContent?.trim() === "保存修改");

const digitCell = (index: number, digit: number) => layout.elements.find(
  element => element.type === "student_digit" && element.digitIndex === index && element.digit === digit)!.id;
const optionCell = (question: number, option: string) => layout.elements.find(
  element => element.type === "objective_option" && element.questionNumber === question && element.option === option)!.id;

let failure: unknown = null;
try {
  await act(async () => {
    root.render(createElement(TooltipProvider, null,
      createElement(ScannerPostprocessPage, {
        cardId: card.id, cardTitle: card.title, sessions: [{ sessionId: "scan-1", pageCount: 3 }], onBack: () => {},
      })));
  });
  await settle();

  // ── 视图 1：页头统计 + 方块网格（异常置顶）──
  assert.match(text(), /已扫 3 组/);
  assert.match(text(), /异常 2/);
  assert.match(text(), /已入库 0/);
  const tiles = document.querySelectorAll('[aria-label^="打开 "]');
  assert.equal(tiles.length, 3, "三组卷子各一个方块");
  assert.equal(tiles[2].getAttribute("aria-label"), "打开 10003", "无异常卷排到最后（异常置顶）");

  // ── 多选删除：无 force → 服务端 409 → 代价文案 → 二次确认带 force ──
  await clickText("选择");
  await clickSelector('[aria-label="选择 组 1"]');
  await clickText("删除选中（1）");
  assert.match(text(), /删除 1 张扫描卡？/, "确认弹窗先说清动作");
  await clickText("删除，不可恢复");
  await settle();
  assert.deepEqual(deletes[0].body, { groupIds: ["1"], force: false }, "首次删除不得带 force");
  assert.match(text(), /知晓代价，仍删除/, "409 之后必须把代价讲明白");
  await clickText("知晓代价，仍删除");
  await settle();
  assert.deepEqual(deletes[1].body, { groupIds: ["1"], force: true }, "二次确认后带 force 重试");

  // ── 视图 2：画布点选与表格汇总双向即时同步（D5 并存不切换）──
  await clickText("扫描结果");
  await clickSelector('[aria-label="打开 10003"]');
  await clickText("卡查看与改分");
  await settle();
  assert(document.querySelector('[data-question="2"]'), "表格列出多选题");
  const totalBefore = totalShown();
  await clickSelector('polygon[aria-label="第 2 题 C，已选"]');
  await settle();
  assert.notEqual(totalShown(), totalBefore, "画布改动即时反映到汇总");
  await clickText("C");
  await settle();
  assert.equal(totalShown(), totalBefore, "表格改回原值同样即时重算");
  assert(saveButton()?.disabled, "改回原样不再算脏，保存必须禁用");
  await clickText("D");
  await settle();
  assert(saveButton() && !saveButton()!.disabled, "有真实改动时保存按钮可用");
  await clickText("保存修改");
  await settle();
  const savedCells = puts.find(entry => entry.groupId === "2")?.pages[0]?.selected ?? [];
  assert(savedCells.includes(optionCell(2, "D")), "表格改的选项写进格选集合");
  assert(savedCells.includes(optionCell(1, "A")), "同卡其他题不受影响");
  assert(savedCells.includes(digitCell(0, 1)), "学号格不能被按题改分抹掉");

  // ── 视图 3：考号面板独立入口（D10）+ 花名册联想 + 只替换 digit 格 ──
  await clickText("异常处理");
  await settle();
  assert.match(text(), /考号问题/, "考号未识别进队列");
  assert.match(text(), /第 1 \/ 2 条/);
  const studentInput = document.querySelector('input[aria-label="考号"]') as HTMLInputElement | null;
  assert(studentInput, "改考号必须有独立输入入口");
  assert.equal(studentInput.value, "10001", "初值取卡面已填考号");
  const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    valueSetter.call(studentInput, "10002");
    studentInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle(700);
  assert.match(text(), /张三/, "花名册联想给出考号+姓名");
  const confirm = [...document.querySelectorAll("button")].find(el => el.textContent?.includes("确认考号"));
  assert(confirm, "确认考号入口存在");
  await act(async () => { confirm.click(); });
  await settle();
  const digitPut = puts.find(entry => entry.groupId === "1")?.pages[0]?.selected ?? [];
  for (const cell of [digitCell(0, 1), digitCell(1, 0), digitCell(2, 0), digitCell(3, 0), digitCell(4, 2)]) {
    assert(digitPut.includes(cell), `考号逐位写入 digit 格：${cell}`);
  }
  assert(digitPut.includes(optionCell(1, "A")), "改考号不得抹掉客观题填涂");

  // ── 远端模式：处理完一条异常 → 按组补传一次，卡版本必须是全量指纹 ──
  localStorage.setItem("projectx_scanner_mode", "remote");
  localStorage.setItem("projectx_server_url", "https://remote.test");
  secondGroupResolved = true;
  await act(async () => { confirm.click(); });
  await settle();
  assert.equal(uploads.length, 1, "已处理组按组补传一次");
  assert.equal(uploads[0].cardVersion, version, "补传必须上报完整卡版本指纹");
  assert.equal(uploads[0].kind, "scan");
  assert.equal(uploads[0].pages.length, 1);

  // ── 队列进度：处理完一条后条数减少、已处理计数保留 ──
  await settle();
  assert.match(text(), /第 1 \/ 1 条/, "异常队列随批结果收缩");
  assert.match(text(), /已处理 1/, "已处理条目仍计入进度");
  assert.match(text(), /识别存疑/, "剩下的存疑卷切到对应面板");

  // ── 存疑题「去改这题」跳到视图 2 定位，改分保存后队列清零 ──
  await clickText("去改这题");
  await settle();
  assert(document.querySelector('[data-question="1"]'), "跳转后渲染改分表");
  allClean = true;
  await clickSelector('polygon[aria-label="第 1 题 B"]');
  await settle();
  assert(saveButton() && !saveButton()!.disabled, "点选后保存可用");
  await clickText("保存修改");
  await settle();
  await clickText("异常处理");
  await settle();
  assert.match(text(), /队列已清零/, "异常全部处理完 → 队列清零");

  // ── 续扫第二批：groupId 跨会话重号，删除与选择都必须按会话隔离 ──
  await act(async () => { root.unmount(); });
  allClean = false;
  secondGroupResolved = false;
  const host2 = document.createElement("div");
  document.body.appendChild(host2);
  root2 = createRoot(host2);
  await act(async () => {
    root2.render(createElement(TooltipProvider, null,
      createElement(ScannerPostprocessPage, {
        cardId: card.id, cardTitle: card.title,
        sessions: [{ sessionId: "scan-1", pageCount: 3 }, { sessionId: "scan-2", pageCount: 2 }], onBack: () => {},
      })));
  });
  await settle();
  assert.equal(document.querySelectorAll('[aria-label^="打开 "]').length, 5, "两批共五组");
  await clickText("选择");
  await clickSelector('[aria-label="选择 组 1"]');
  assert(document.querySelector('[aria-label="选择 20002"]')?.getAttribute("aria-pressed") === "false",
    "选中第一批的组 1 不得连带选中第二批的同名组");
  await clickText("删除选中（1）");
  await clickText("删除，不可恢复");
  await settle();
  assert.match(deletes[deletes.length - 1].url, /\/session\/scan-1\/groups$/, "删除必须下发到组所属的会话");
  assert.deepEqual(deletes[deletes.length - 1].body.groupIds, ["1"]);

  // ── 正常组（本批已被 ScannerPanel 排队上传）改分保存后绝不再建第二个上传会话 ──
  const uploadsBefore = uploads.length;
  await clickText("扫描结果");
  await clickSelector('[aria-label="打开 20001"]');
  await settle();
  assert(document.querySelector('[data-question="1"]'), "正常卷直接进入改分视图");
  await clickSelector('polygon[aria-label="第 1 题 B"]');
  await settle();
  await clickText("保存修改");
  await settle();
  assert(puts.some(entry => entry.groupId === "0"), "第二批的改动已写回本机");
  assert.equal(uploads.length, uploadsBefore, "已上传过的组不得重复补传（第二份回执会撤回正式成绩）");
  console.log("PASS scanner-postprocess-ui-smoke");
} catch (error) {
  failure = error;
} finally {
  await act(async () => { root.unmount(); root2?.unmount(); });
  scannerUploadManager.startUpload = realStartUpload;
  // 不关掉 jsdom 的 window，其定时器与观察者会让进程一直挂着
  dom.window.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

// jsdom 收尾后仍有句柄没释放，脚本必须自己决定退出码（断言失败一律 1，不能静默通过）
if (failure) {
  console.error(failure);
  process.exit(1);
}
process.exit(0);
