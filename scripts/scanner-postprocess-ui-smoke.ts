/** 后处理页真实组件挂载回归：三视图渲染、画布↔表格双向即时同步、多选删除 409 二次确认、
 *  改考号只替换 digit 格不伤其他填涂、按组补传的卡版本指纹与队列清零。 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { cardFingerprint } from "../src/shared/cardVersion";
import { correctionCells, correctionState, recognizedCells, type CorrectionDocument, type CorrectionEdit } from "../src/shared/scanCorrection";
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
/** 扫描当时写入会话的指纹。必须和「现在重新拉到的卡」不是同一串，补传才证明没用最新卡面。 */
const scanVersion = "aaaaaaaaaaaaaaaaaaaaaaaa";
const decoyVersion = "bbbbbbbbbbbbbbbbbbbbbbbb";
assert.notEqual(scanVersion, version);
assert.equal(scanVersion.length, 24);
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
/** 剧本：下一轮「非 force → 409 → force」里让 force 请求返回 500，用来检查失败提示会不会被确认框挡住。 */
let failForceDeleteOnce = false;
let duplicateKept = false;
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

const puts: Array<{ groupId: string; draft: boolean; pages: Array<{ sourceId: string; selected: string[]; touched?: string[] }> }> = [];
const deletes: Array<{ url: string; body: { groupIds: string[]; force?: boolean; previewOnly?: boolean } }> = [];
const saveBodies: unknown[] = [];
const saveCalls: string[] = [];
const discards: Array<{ url: string; body: unknown }> = [];
const participantUrls: string[] = [];
const searchUrls: string[] = [];
/** 第二批会话：groupId 与第一批重号，用来钉住「删除必须按会话下发」 */
const batchFor = (sessionId: string): ScanBatchResponse => {
  const first = batch();
  if (sessionId === "scan-3") {
    const kept = { ...first.results[1], groupId: "1", studentId: "20002",
      pages: first.results[1].pages.map(page => ({ ...page, recordId: "rec-6", pageNum: 6 })) };
    return duplicateKept
      ? { results: [kept], failures: [], reviewCards: [] }
      : {
        results: [{ ...first.results[1], groupId: "2", studentId: "20003", pages: first.results[1].pages.map(page => ({ ...page, recordId: "rec-7", pageNum: 7 })) }],
        failures: [{ groupId: "0", studentId: "20002", stage: "saving", message: "重复学号：新旧答题卡均需核对订正",
          pages: [{ recordId: "rec-4", pageNum: 4, side: "front", layoutPage: 1 }],
          conflicts: [
            { sessionId: "scan-3", groupId: "0", studentId: "20002", previouslySaved: false, totalScore: 10, maxScore: 10, needsReviewCount: 0, pages: [{ recordId: "rec-4", pageNum: 4, side: "front", layoutPage: 1 }] },
            { sessionId: "scan-3", groupId: "1", studentId: "20002", previouslySaved: false, totalScore: 10, maxScore: 10, needsReviewCount: 0, pages: [{ recordId: "rec-6", pageNum: 6, side: "front", layoutPage: 1 }] },
          ] }],
        reviewCards: [],
      };
  }
  if (sessionId === "scan-decoy") return { results: [], failures: [], reviewCards: [] };
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
let hideCard = false;
install("fetch", async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (hideCard && (url.includes("/sync/cards/") || url.includes("/api/cards/"))) {
    return Response.json({ message: "答题卡不存在" }, { status: 404 });
  }
  if (url.includes("/api/cards/")) return Response.json(card);
  const sessionMatch = url.match(/\/api\/scanner\/session\/([^/]+)\/(validate|results)/);
  if (sessionMatch) {
    // 仅本地模式的「保存成绩入库」= POST results（save 模式），与 validate 演算不是一条路
    if (method === "POST" && url.endsWith("/results")) {
      saveCalls.push(`${method} ${url}`);
      saveBodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
    }
    return Response.json(batchFor(sessionMatch[1]));
  }
  if (/\/api\/scanner\/scan\/[^/]+$/.test(url)) {
    const sessionId = url.match(/\/api\/scanner\/scan\/([^/]+)$/)?.[1] ?? "";
    const examId = sessionId === "scan-decoy" ? 99 : sessionId === "scan-2" ? 8 : 7;
    const card_version = sessionId === "scan-decoy" ? decoyVersion : scanVersion;
    const warnings_json = sessionId === "scan-1"
      ? JSON.stringify(["本批未识别到红笔分数，请检查彩色设置"])
      : null;
    return Response.json({ session: { identity_mode: "strict", dpi: 300, paper_size: "A4", card_version, warnings_json }, records: [], examId });
  }
  if (/\/api\/scanner\/card\/[^/]+\/scans$/.test(url)) {
    return Response.json([
      { recordId: "rec-1", createdAt: "2026-10-17 09:00:01", scanQuality: 88.5 },
      { recordId: "rec-2", createdAt: "2026-10-17 09:00:02", scanQuality: 71.25 },
      { recordId: "rec-3", createdAt: "2026-10-17 09:00:03", scanQuality: 90 },
    ]);
  }
  if (/\/api\/exams\/\d+\/participants$/.test(url)) {
    participantUrls.push(url);
    // 错场名单故意包含即将输入的 10002：用了第一场 examId 时徽章会消失，断言才能抓住。
    if (url.includes("/api/exams/99/")) return Response.json({ known: true, students: [{ studentId: 2, studentNumber: "10002", name: "错场" }] });
    return Response.json({ known: true, students: [{ studentId: 1, studentNumber: "10001", name: "李四" }] });
  }
  if (/\/participant-search\?/.test(url)) {
    searchUrls.push(url);
    return Response.json({ ok: true, students: [{ id: 11, name: "张三", student_number: "10002" }] });
  }
  if (/\/groups\/[^/]+\/correction$/.test(url)) {
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { pages: never[]; draft?: boolean };
      puts.push({ groupId: url.match(/\/groups\/([^/]+)\/correction$/)![1], draft: body.draft === true, pages: body.pages });
      // 服务端 saveSessionCorrection 对已关联考试的会话会顺带入库，返回 saved:true
      return Response.json({ ok: true, saved: true });
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
    if (failForceDeleteOnce && !body.force) {
      return Response.json({ message: "所选卷包含已上传或待确认的回执", blocked: body.groupIds }, { status: 409 });
    }
    if (failForceDeleteOnce && body.force) {
      failForceDeleteOnce = false;
      return Response.json({ message: "服务端删除失败（HTTP 500）" }, { status: 500 });
    }
    return Response.json({ ...batch(), deletedGroups: body.groupIds.length, missingGroups: [] });
  }
  if (url.endsWith("/retry")) return Response.json(batch());
  if (url.endsWith("/discard")) {
    discards.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as unknown });
    // 作废的是「另一份」：组 0 被作废后，重拉批结果时只剩保留下来的组 1
    if (url.includes("/scan-3/")) duplicateKept = true;
    return Response.json(batchFor(url.match(/\/session\/([^/]+)\/groups\/[^/]+\/discard$/)?.[1] ?? ""));
  }
  throw new Error(`Uncovered postprocess request: ${method} ${url}`);
});

const { createRoot } = await import("react-dom/client");
const { ScannerPostprocessPage } = await import("../src/apps/answer-card/client/components/ScannerPostprocessPage");
const { TooltipProvider } = await import("../src/apps/answer-card/client/components/ui/v2");
const { scannerUploadManager } = await import("../src/apps/answer-card/client/lib/scannerUploadManager");
const uploads: StartUploadInput[] = [];
const { notify } = await import("../src/apps/answer-card/client/components/ui/v2");
const notices: string[] = [];
const realNotifyInfo = notify.info;
notify.info = ((message: string) => { notices.push(message); return realNotifyInfo(message); }) as typeof notify.info;
const realStartUpload = scannerUploadManager.startUpload;
scannerUploadManager.startUpload = (input => { uploads.push(input); return `upload-${uploads.length}`; }) as typeof scannerUploadManager.startUpload;

const root = createRoot(document.getElementById("root")!);
let root2: ReturnType<typeof createRoot> | null = null;
let root3: ReturnType<typeof createRoot> | null = null;
let root4: ReturnType<typeof createRoot> | null = null;
let root5: ReturnType<typeof createRoot> | null = null;
let root6: ReturnType<typeof createRoot> | null = null;
let root7: ReturnType<typeof createRoot> | null = null;
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
        cardId: card.id, cardTitle: card.title,
        sessions: [{ sessionId: "scan-decoy", pageCount: 0 }, { sessionId: "scan-1", pageCount: 3 }], onBack: () => {},
      })));
  });
  await settle();
  assert.match(text(), /本批未识别到红笔分数，请检查彩色设置/, "跳到后处理页后仍展示本批扫描告警");
  assert.match(text(), /答题卡已更换，缺页按本次实际扫到的页核对/, "会话指纹对不上当前卡时，缺页不按新卡页数报");

  // ── 视图 1：页头统计 + 方块网格（异常置顶）──
  assert.match(text(), /已扫 3 组/);
  assert.match(text(), /异常 2/);
  assert.match(text(), /已入库 0/);
  const tiles = document.querySelectorAll('[aria-label^="打开 "]');
  assert.equal(tiles.length, 3, "三组卷子各一个方块");
  assert.equal(tiles[2].getAttribute("aria-label"), "打开 10003", "无异常卷排到最后（异常置顶）");

  // ── 仅本地模式必须留有人库入口（自动跳页会卸载 ScannerPanel 的 done 视图）──
  assert(saveCalls.length === 0, "进页面本身只演算，不写成绩");
  await clickText("保存成绩入库");
  await settle();
  assert.equal(saveCalls.length, 1, "「保存成绩入库」走 POST results（save 模式）");
  assert.match(saveCalls[0], /POST .*\/session\/scan-1\/results$/, "入库打到本会话的 results 端点");
  assert.deepEqual(saveBodies[0], { groupIds: ["0", "2"] }, "存疑卷与正常卷一起入库；没有学号的失败组不跟着 POST");

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

  // ── 强制删除自身失败：确认框必须让位，失败原因要当场看得见（评审 P2）──
  failForceDeleteOnce = true;
  await clickText("选择");
  await clickSelector('[aria-label="选择 组 1"]');
  await clickText("删除选中（1）");
  await clickText("删除，不可恢复");
  await settle();
  assert.match(text(), /知晓代价，仍删除/, "第二轮仍然先给出代价确认");
  await clickText("知晓代价，仍删除");
  await settle();
  assert(!document.querySelector('[role="alertdialog"][data-state="open"]'), "强制删除失败后确认框必须关闭");
  assert.match(text(), /服务端删除失败（HTTP 500）/, "失败原因要显示在当前视图，不能躲在确认框背后");
  assert.equal(failForceDeleteOnce, false, "500 剧本只触发一次");
  await clickText("选择");

  // ── 视图 2：画布点选与表格汇总双向即时同步（D5 并存不切换）──
  await clickText("扫描结果");
  await clickSelector('[aria-label="打开 10003"]');
  await clickText("卡查看与改分");
  await settle();
  assert(document.querySelector('[data-question="2"]'), "表格列出多选题");
  await clickSelector('polygon[aria-label="第 1 题 A，已选"]');
  await settle();
  await clickSelector('polygon[aria-label="第 1 题 A"]');
  await settle();
  assert(saveButton()?.disabled, "高置信度题目点掉再点回不算确认，保存保持禁用");
  const totalBefore = totalShown();
  await clickSelector('polygon[aria-label="第 2 题 C，已选"]');
  await settle();
  assert.notEqual(totalShown(), totalBefore, "画布改动即时反映到汇总");
  await clickText("C");
  await settle();
  assert.equal(totalShown(), totalBefore, "表格改回原值同样即时重算");
  assert(saveButton() && !saveButton()!.disabled, "低置信度原答案点掉再点回是确认，保存必须可用");
  await clickText("D");
  await settle();
  assert(saveButton() && !saveButton()!.disabled, "有真实改动时保存按钮可用");
  await clickText("扫描结果");
  await settle();
  await clickText("卡查看与改分");
  await settle();
  assert(saveButton() && !saveButton()!.disabled, "切到扫描结果再回来，未保存的修改还在");
  await clickText("保存修改");
  await settle();
  const savedPage = puts.find(entry => entry.groupId === "2")?.pages[0];
  const savedCells = savedPage?.selected ?? [];
  assert(savedPage?.touched?.includes(optionCell(2, "C")), "低置信度确认必须把点过的选项格记入 touched");
  assert(!savedPage?.touched?.includes(optionCell(1, "A")), "高置信度题目点回原样不得记入 touched");
  assert(savedCells.includes(optionCell(2, "D")), "表格改的选项写进格选集合");
  assert(savedCells.includes(optionCell(1, "A")), "同卡其他题不受影响");
  assert(savedCells.includes(digitCell(0, 1)), "学号格不能被按题改分抹掉");
  // 服务端入库成功后本组不能再从这条通道改，界面必须锁住并说明去处
  assert(saveButton()?.disabled, "已入库后保存按钮必须禁用");
  assert.match(text(), /已入库/, "锁住时要说清去哪儿改");
  await clickSelector('polygon[aria-label="第 1 题 A，已选"]');
  assert.equal(puts.filter(entry => entry.groupId === "2").length, 1, "锁定后画布点选不再生效");

  // ── 视图 3：考号面板独立入口（D10）+ 花名册联想 + 只替换 digit 格 ──
  await clickText("异常处理");
  await settle();
  assert.match(text(), /考号问题/, "考号未识别进队列");
  assert.match(text(), /第 1 \/ 2 条/);
  const studentInput = document.querySelector('input[aria-label="考号"]') as HTMLInputElement | null;
  assert(studentInput, "改考号必须有独立输入入口");
  assert.equal(studentInput.value, "10001", "初值取自卡面 digit 格选");
  const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    valueSetter.call(studentInput, "10002");
    studentInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle(700);
  assert.match(text(), /张三/, "花名册联想给出考号+姓名");
  assert.match(text(), /该考号不在应考名单/, "应考名单来自 participants，联想命中也不能当成在名单里");
  assert.ok(participantUrls.some(entry => entry.includes("/api/exams/7/participants")), "应考名单必须打到当前会话的考试");
  assert.ok(!participantUrls.some(entry => entry.includes("/api/exams/99/")), "不能拿先加载的另一场会话的 examId 查名单");
  assert.ok(searchUrls.some(entry => entry.includes("/api/exams/7/participant-search")), "联想搜索也必须用当前会话的考试");
  // 画布点选必须压过输入框里的旧文本：把末位点回 1，输入框要跟着变
  await clickSelector('polygon[aria-label="学号第 5 位 1"]');
  await settle();
  assert.equal((document.querySelector('input[aria-label="考号"]') as HTMLInputElement).value, "10001",
    "点画布后输入框跟随格选，不能留着旧文本");
  const confirm = [...document.querySelectorAll("button")].find(el => el.textContent?.includes("确认考号"));
  assert(confirm, "确认考号入口存在");
  await act(async () => { confirm.click(); });
  await settle();
  const digitPut = puts.find(entry => entry.groupId === "1")?.pages[0]?.selected ?? [];
  for (const cell of [digitCell(0, 1), digitCell(1, 0), digitCell(2, 0), digitCell(3, 0), digitCell(4, 1)]) {
    assert(digitPut.includes(cell), `考号逐位写入 digit 格：${cell}`);
  }
  assert(!digitPut.includes(digitCell(4, 2)), "提交的是画布上的号，不能被输入框旧文本覆盖");
  assert(digitPut.includes(optionCell(1, "A")), "改考号不得抹掉客观题填涂");

  // ── 远端模式：处理完一条异常 → 按组补传一次，卡版本必须是全量指纹 ──
  localStorage.setItem("projectx_scanner_mode", "remote");
  localStorage.setItem("projectx_server_url", "https://remote.test");
  const { retryPreviewBody } = await import("../src/apps/answer-card/client/components/scanner-postprocess/PostprocessQueueView");
  assert.deepEqual(retryPreviewBody(), { previewOnly: true }, "远端重新识别必须告诉服务端只做 preview，避免给其余组写回执");
  localStorage.setItem("projectx_scanner_mode", "local");
  assert.deepEqual(retryPreviewBody(), {}, "本机模式重新识别后仍走原来的 validate");
  localStorage.setItem("projectx_scanner_mode", "remote");
  secondGroupResolved = true;
  await act(async () => { confirm.click(); });
  await settle();
  assert.equal(uploads.length, 3, "后处理页首传会带上所有识别成功的卷，已处理组也在其中");
  assert.deepEqual(uploads.map(item => item.name), ["扫描_10001", "扫描_10003", "扫描_10002"]);
  for (const upload of uploads) {
    assert.equal(upload.cardVersion, scanVersion, "补传必须上报扫描当时的卡版本");
    assert.notEqual(upload.cardVersion, version, "不能改用页面后来拉到的最新卡指纹");
    assert.notEqual(upload.cardVersion, decoyVersion, "不能改用另一场会话的卡版本");
    assert.equal(upload.localSessionId, "scan-1");
    assert.equal(upload.kind, "scan");
    assert.equal(upload.pages.length, 1);
  }
  assert.equal(uploads.some(item => item.name === "扫描_10001"), true, "存疑卷也要先上传，复核在服务器侧完成");

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
  assert(puts.some(entry => entry.groupId === "0" && entry.draft), "远端模式确认存疑题时只写草稿，不把本机入库当成已上传");
  assert(uploads.some(item => item.name === "扫描_10001" && item.localSessionId === "scan-1"), "存疑题全部确认后仍要补传到远端");
  assert(puts.some(entry => entry.groupId === "2" && !entry.draft), "仅本地模式的改分仍然正式入库");
  assert.equal(uploads.length, 3, "已经上传过的存疑卷不能再建第二份回执");
  assert(notices.some(message => message.includes("已随本批上传")),
    "已上传组的本机改分必须指路 Web 成绩修改，不能静默留在本机");

  // ── 续扫第二批：groupId 跨会话重号，删除与选择都必须按会话隔离 ──
  await act(async () => { root.unmount(); });
  localStorage.removeItem(`projectx-postprocess-view/v1/${encodeURIComponent(card.id)}`);
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
  assert.equal(deletes[deletes.length - 1].body.previewOnly, true, "远端模式删除后刷新必须走 preview，不能给留下的组写回执");

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

  // ── 重卡定性：队列项是被作废的那份时，补传必须跟着「保留下来的那份」走 ──
  await act(async () => { root2.unmount(); });
  localStorage.removeItem(`projectx-postprocess-view/v1/${encodeURIComponent(card.id)}`);
  const host3 = document.createElement("div");
  document.body.appendChild(host3);
  root3 = createRoot(host3);
  await act(async () => {
    root3.render(createElement(TooltipProvider, null,
      createElement(ScannerPostprocessPage, {
        cardId: card.id, cardTitle: card.title, sessions: [{ sessionId: "scan-3", pageCount: 2 }], onBack: () => {},
      })));
  });
  await settle();
  await clickText("异常处理");
  await settle();
  assert.match(text(), /考号重复/, "重卡排在队首");
  const keepButtons = [...document.querySelectorAll("button")].filter(el => el.textContent?.trim() === "保留这份");
  assert.equal(keepButtons.length, 2, "两份副本并排定性");
  const uploadsBeforeKeep = uploads.length;
  // 队列项是组 0，这里点的是组 1 卡片上的「保留这份」→ 作废的是组 0
  await act(async () => { keepButtons[1].click(); });
  await settle();
  assert.equal(discards.length, 0, "远端预览重卡不能打本地作废接口");
  assert.deepEqual(
    JSON.parse(localStorage.getItem(`projectx-postprocess-preview-discard/${card.id}`) ?? "[]"),
    [{ sessionId: "scan-3", groupId: "0" }],
    "不保留的那份记在本机，后续预览和首传都要滤掉",
  );
  assert.equal(uploads.length, uploadsBeforeKeep + 1, "保留下来的那份要补传（它只出现在 conflicts 里）");
  assert.equal(uploads[uploads.length - 1].name, "扫描_20002", "补传任务对应保留下来的那份卷");
  assert.equal(uploads.filter(item => item.localSessionId === "scan-3" && item.pages[0]?.groupId === "1").length, 1, "保留份只上传一次");

  // ── 崩溃恢复停在队列中间那一条：定位请求不能被队列的上报改写成队首 ──
  await act(async () => { root3.unmount(); });
  const resumeFlags = { allClean, secondGroupResolved };
  allClean = false; secondGroupResolved = false;
  const viewKey = `projectx-postprocess-view/v1/${encodeURIComponent(card.id)}`;
  localStorage.removeItem(viewKey);
  // scan-1 的队列是 [考号问题 组 1, 存疑 组 0]；停在第二条才是「恢复中间那一条」
  localStorage.setItem(viewKey, JSON.stringify({ view: "queue", sessionId: "scan-1", groupId: "0", at: Date.now() }));
  const resumeHost = document.createElement("div");
  document.body.appendChild(resumeHost);
  root3 = createRoot(resumeHost);
  await act(async () => {
    root3!.render(createElement(TooltipProvider, null,
      createElement(ScannerPostprocessPage, {
        cardId: card.id, cardTitle: card.title, sessions: [{ sessionId: "scan-1", pageCount: 1 }], onBack: () => {},
      })));
  });
  await settle();
  assert.match(resumeHost.textContent ?? "", /第 2 \/ 2 条/,
    `恢复要停在崩溃前那一条，不是队首（实际 ${resumeHost.textContent?.match(/第 \d+ \/ \d+ 条/)?.[0] ?? "没有条数"}）`);
  assert.match(resumeHost.textContent ?? "", /已恢复上次停留的卷/, "恢复要当场告诉老师停在了哪一张");
  const resumedMarker = JSON.parse(localStorage.getItem(viewKey) ?? "null") as { view: string; sessionId: string; groupId: string } | null;
  assert.deepEqual(resumedMarker && { view: resumedMarker.view, sessionId: resumedMarker.sessionId, groupId: resumedMarker.groupId },
    { view: "queue", sessionId: "scan-1", groupId: "0" }, "恢复标记不能被队列首帧的上报改写回队首");
  // root3 交给下一段卸载（那里本来就先 unmount 再清恢复标记）
  allClean = resumeFlags.allClean; secondGroupResolved = resumeFlags.secondGroupResolved;

  // ── 远端卡 404：本机卡也没有时，页面仍能返回，而不是停在没有按钮的失败态 ──
  await act(async () => { root3.unmount(); });
  localStorage.removeItem(`projectx-postprocess-view/v1/${encodeURIComponent(card.id)}`);
  hideCard = true;
  const host4 = document.createElement("div");
  document.body.appendChild(host4);
  root4 = createRoot(host4);
  await act(async () => {
    root4.render(createElement(TooltipProvider, null,
      createElement(ScannerPostprocessPage, {
        cardId: card.id, cardTitle: card.title, sessions: [{ sessionId: "scan-1", pageCount: 1 }], onBack: () => {},
      })));
  });
  await settle();
  assert.match(text(), /答题卡不存在/);
  assert(document.querySelector('[aria-label="返回扫描"]'), "加载失败时仍能返回扫描");
  assert([...document.querySelectorAll("button")].some(el => el.textContent?.includes("重试")), "加载失败时可以重试");

  // A valid score-cell combination still needs explicit teacher confirmation when recognition says review.
  await act(async () => { root4!.unmount(); });
  localStorage.removeItem(`projectx-postprocess-view/v1/${encodeURIComponent(card.id)}`);
  const reviewCard = createDefaultCard("subjective-review");
  reviewCard.bodyBlocks = [{id:"review-block",type:"subjective",title:"待确认",questions:[
    {id:"review-question",number:2,score:30,style:"manual_score_grid",kind:"plain_box",minHeightMm:30},
  ]}];
  const reviewLayout = buildLayout(reviewCard).pages[0];
  const ten = correctionCells(reviewLayout).find(c => c.type === "score_cell" && c.score === 10)!;
  const reviewRecognition = {...recognition,questions:[],subjectiveQuestions:[{
    blockId:"review-block",questionId:"review-question",questionNumber:2,maxScore:30,score:10,
    status:"review" as const,confidence:0.05,validCells:[{score:10,rect:ten.rect}],invalidCells:[],
  }]};
  const reviewDoc: CorrectionDocument = {card:reviewCard,version:cardFingerprint(reviewCard),pages:[{
    sourceType:"twain_scan_record",sourceId:"review-record",revision:0,layout:reviewLayout,
    recognition:reviewRecognition,...recognizedCells(reviewLayout,reviewRecognition),imageUrl:"/review-image",
  }]};
  const {localChannel} = await import("../src/apps/answer-card/client/components/scanner-postprocess/postprocessChannel");
  const {PostprocessQueueView} = await import("../src/apps/answer-card/client/components/scanner-postprocess/PostprocessQueueView");
  const {PostprocessCorrectionView} = await import("../src/apps/answer-card/client/components/scanner-postprocess/PostprocessCorrectionView");
  let reviewed = false, jumped = false;
  const reviewChannel = {...localChannel(),request:async (url:string,init?:RequestInit) => {
    if (url === "/review-image") return new Response("image");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {pages:CorrectionEdit[];draft:boolean};
      assert.equal(body.draft,true);assert(body.pages[0].touched?.includes(ten.id));
      reviewDoc.pages[0].recognition = correctionState(reviewCard,reviewDoc.pages[0],body.pages[0].selected,body.pages[0].touched).recognition;
      assert.equal(reviewDoc.pages[0].recognition.subjectiveQuestions[0].status,"ok");
      assert.equal(reviewDoc.pages[0].recognition.subjectiveQuestions[0].score,10);
      reviewed = true;return Response.json({saved:false,drafted:true});
    }
    return Response.json(reviewDoc);
  }};
  const reviewHost = document.createElement("div");document.body.append(reviewHost);root5 = createRoot(reviewHost);
  await act(async()=>root5!.render(createElement(TooltipProvider,null,createElement(PostprocessQueueView,{
    channel:reviewChannel,queue:[{id:"subjective",kind:"low_confidence",sessionId:"review",groupId:"0",studentId:"10001",
      label:"10001",conflicts:[],missingLayoutPages:[],needsReviewCount:1}],scans:[],examIdForSession:()=>null,
    layoutPageCountFor:()=>1,onResolved:()=>{},onPreviewDiscard:()=>{},onDelete:async()=>{},
    onJumpToCorrection:(_sid,_gid,question)=>{assert.equal(question,2);jumped=true;},
  }))));
  // 列表现直接复用共享判分的结果，所以状态取判分侧的归类（missing_score_grid），不再是识别原始字串。
  await settle();assert.match(text(),/第 2 题（主观 missing_score_grid）/);assert(!text().includes("没有低于阈值的题"));
  // ── 双面卡的低置信度面板：按整份卡判一次，别把另一页「没上报的题」列成存疑 ──
  const pageTwoRecognition = {...recognition, pageNumber: 2, questions: [], subjectiveQuestions: []};
  const twoPageDoc: CorrectionDocument = {card, version, pages: [
    {sourceType:"twain_scan_record", sourceId:"multi-1", revision:0, layout,
      recognition, ...recognizedCells(layout, recognition), imageUrl:"/multi-1"},
    {sourceType:"twain_scan_record", sourceId:"multi-2", revision:0, layout,
      recognition:pageTwoRecognition as typeof recognition, ...recognizedCells(layout, pageTwoRecognition), imageUrl:"/multi-2"},
  ]};
  const twoPageChannel = {...localChannel(), request:async () => Response.json(twoPageDoc)};
  const twoPageHost = document.createElement("div");document.body.append(twoPageHost);root6 = createRoot(twoPageHost);
  await act(async()=>root6!.render(createElement(TooltipProvider,null,createElement(PostprocessQueueView,{
    channel:twoPageChannel,queue:[{id:"subjective",kind:"low_confidence",sessionId:"multi",groupId:"0",studentId:"10001",
      label:"10001",conflicts:[],missingLayoutPages:[],needsReviewCount:1}],scans:[],examIdForSession:()=>null,
    layoutPageCountFor:()=>2,onResolved:()=>{},onPreviewDiscard:()=>{},onDelete:async()=>{},onJumpToCorrection:()=>{},
  }))));
  await settle();
  assert.match(text(),/第 2 题（客观）/, "真实存在的低置信度题要列出来");
  assert.equal((text().match(/题（客观）/g) ?? []).length, 1, "第二页没上报的题不能被重复列成存疑");
  assert(!text().includes("未答"), "合成条目不能伪装成本页的空白作答");

  // ── 两份考号异常卷来回切换：各自草稿必须隔离，不能把上一份写到下一份键下 ──
  {
    const docFor = (sid: string): CorrectionDocument => {
      const recognized = { ...recognition, studentId: { status: "ok", value: "10001" } } as typeof recognition;
      return { card, version, pages: [{
        sourceType: "twain_scan_record", sourceId: `${sid}-p1`, revision: 0, layout,
        recognition: recognized, ...recognizedCells(layout, recognized), imageUrl: `/${sid}`,
      }] };
    };
    const studentDocs = new Map([["a", docFor("a")], ["b", docFor("b")]]);
    const studentChannel = {
      ...localChannel(),
      request: async (url: string) => {
        const sid = [...studentDocs.keys()].find(key => url.includes(`/session/${key}/`));
        return sid ? Response.json(studentDocs.get(sid)) : Response.json({ message: "unknown" }, { status: 404 });
      },
    };
    const studentHost = document.createElement("div");
    document.body.append(studentHost);
    root7 = createRoot(studentHost);
    const queueItems = [
      { id: "sid-b", kind: "student_id" as const, sessionId: "b", groupId: "1", studentId: null, label: "考号问题",
        conflicts: [], missingLayoutPages: [], needsReviewCount: 0 },
      { id: "sid-a", kind: "student_id" as const, sessionId: "a", groupId: "2", studentId: null, label: "考号问题",
        conflicts: [], missingLayoutPages: [], needsReviewCount: 0 },
    ];
    const currentChanges: string[] = [];
    await act(async () => root7!.render(createElement(TooltipProvider, null, createElement(PostprocessQueueView, {
      channel: studentChannel, queue: queueItems, scans: [], examIdForSession: () => null,
      layoutPageCountFor: () => 1, onCurrentChange: (sessionId, groupId) => currentChanges.push(`${sessionId}/${groupId}`),
      onResolved: () => {}, onPreviewDiscard: () => {}, onDelete: async () => {}, onJumpToCorrection: () => {},
    }))));
    await settle();
    assert.deepEqual(currentChanges, ["b/1"], "当前队列项变化要上抛给页面持久化");
    const input = () => studentHost.querySelector('input[aria-label="考号"]') as HTMLInputElement;
    const next = () => {
      const button = [...studentHost.querySelectorAll("button")].find(node => node.textContent?.trim() === "下一条");
      assert(button, "队列需要下一条入口");
      return button;
    };
    const setInput = async (value: string) => {
      await act(async () => {
        valueSetter.call(input(), value);
        input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await settle();
    };
    assert.equal(input().value, "10001", "B 的初始考号来自卡面格选");
    await setInput("1000");
    assert.equal(input().value, "1000", "B 只输了一半，保持手输值");
    await act(async () => { next().click(); });
    await settle();
    assert.equal(input().value, "10001", "切到 A 时不能带着 B 的未保存手输值");
    assert.equal(currentChanges.at(-1), "a/2", "下一条后上抛的当前项要跟着变");
    await setInput("2000");
    await act(async () => { next().click(); });
    await settle();
    assert.equal(input().value, "1000", "切回 B 要恢复 B 自己的半截草稿，不能被 A 覆盖或清掉");
    await act(async () => { next().click(); });
    await settle();
    assert.equal(input().value, "2000", "切回 A 也要恢复 A 自己的草稿");
    // 本机存储写不进去时，界面不能继续宣称「已自动保存草稿」。
    const storageProto = dom.window.Storage.prototype as Storage;
    const realSetItem = storageProto.setItem;
    storageProto.setItem = () => { throw new Error("QuotaExceededError"); };
    await setInput("2001");
    assert(studentHost.textContent?.includes("本机草稿保存失败"), "草稿写入失败要当场提示");
    storageProto.setItem = realSetItem;
    await setInput("2000");
    assert(!studentHost.textContent?.includes("本机草稿保存失败"), "恢复写入后失败提示要消失");
    await act(async () => { root7!.unmount(); });

    // 崩溃恢复带着定位目标挂载：首帧就得停在那一条。先报队首的话，页面会把恢复标记改写成第 1 条，
    // 而 focus 又跟着回报值变，两边会一直对抖（第 2 条永远恢复不出来）。
    const focusHost = document.createElement("div");
    document.body.append(focusHost);
    root7 = createRoot(focusHost);
    const focusChanges: string[] = [];
    await act(async () => root7!.render(createElement(TooltipProvider, null, createElement(PostprocessQueueView, {
      channel: studentChannel, queue: queueItems, scans: [], examIdForSession: () => null,
      layoutPageCountFor: () => 1, focus: { sessionId: "a", groupId: "2" },
      onCurrentChange: (sessionId: string, groupId: string) => focusChanges.push(`${sessionId}/${groupId}`),
      onResolved: () => {}, onPreviewDiscard: () => {}, onDelete: async () => {}, onJumpToCorrection: () => {},
    }))));
    await settle();
    assert.deepEqual(focusChanges, ["a/2"], "带定位目标挂载时首帧上报的就是目标项，不是队首");
    assert(focusHost.textContent?.includes("第 2 / 2 条"), `队列直接停在恢复目标那一条（实际 ${focusHost.textContent?.match(/第 \d+ \/ \d+ 条/)?.[0]}）`);
    await act(async () => { root7!.unmount(); });
    root7 = null;
    studentHost.remove();
    focusHost.remove();
  }

  await clickText("去改这题");assert(jumped);
  const releasedGroups: string[] = [];
  await act(async()=>root5!.render(createElement(TooltipProvider,null,createElement(PostprocessCorrectionView,{
    channel:reviewChannel,sessionId:"review",groupId:"0",draftOnly:true,onSaved:()=>{},
    onUploadAbandoned:()=>{releasedGroups.push("review/0");},
  }))));
  await settle();assert(saveButton()?.disabled,"打开待确认卷不会自动确认");
  const scoreCell = () => document.querySelector(`[data-cell-id="${ten.id}"]`)!;
  await clickNode(scoreCell());await clickNode(scoreCell());await settle();
  assert(saveButton() && !saveButton()!.disabled,"点回原分数同样可以明确确认");
  // 上传锁：逐页现读本机订正，在途、只差提交或留着可续传的半成品时保存都会让服务器收到半旧半新的快照。
  // 在途与只差提交都只让教师等或重试；可续传的半成品必须给出「放弃续传」，并回调调用方清掉入队标记，
  // 否则标记一直留着，syncAfterFix 会永远跳过这一组（评审 P1 + P2）。
  const realGroupBlock = scannerUploadManager.groupUploadBlock;
  const realAbandon = scannerUploadManager.abandonGroupUpload;
  const abandonArgs: string[] = [];
  let uploadBlock: "in-flight" | "partial-pages" | "completion-pending" | null = "in-flight";
  dom.window.confirm = (() => true) as typeof dom.window.confirm;
  scannerUploadManager.groupUploadBlock = () => uploadBlock;
  scannerUploadManager.abandonGroupUpload = ((cardId: string, groupId: string, sessionId: string) => {
    abandonArgs.push(`${cardId}/${groupId}/${sessionId}`); uploadBlock = null; return { ok: true as const };
  }) as typeof scannerUploadManager.abandonGroupUpload;
  // 订阅只在管理器状态变化时重渲染，桩换了还得让组件自己更新一次才会重读这把锁。
  const findButton = (label: string) => [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  await clickText("放大"); await settle();
  assert(saveButton()?.disabled, "上传在途时后处理页不允许保存改分");
  assert(!findButton("放弃续传"), "正在传输时不提供放弃，只让教师等它传完或取消");
  uploadBlock = "completion-pending";
  await clickText("放大"); await settle();
  assert(saveButton()?.disabled, "页面传完只差提交时同样不允许保存改分");
  assert(!findButton("放弃续传"), "只差提交时不提供放弃，否则同一份原卷会被当成新会话再传一遍");
  uploadBlock = "partial-pages";
  await clickText("放大"); await settle();
  const abandonButton = findButton("放弃续传");
  assert(abandonButton, "可续传的半成品要给出明确的解锁动作");
  assert(saveButton()?.disabled, "半成品没放弃前不能保存改分");
  await clickNode(abandonButton!); await settle();
  assert.deepEqual(abandonArgs, [`${reviewCard.id}/0/review`], "放弃续传要按本卡本组本会话点名");
  assert.deepEqual(releasedGroups, ["review/0"], "放弃成功后必须回调调用方清掉入队标记");
  assert(!findButton("放弃续传"), "放弃后不再显示解锁按钮");
  assert(text().includes("已放弃这一卷的续传"), "界面要说明接下来可以改分并整卷重传");
  assert(saveButton() && !saveButton()!.disabled, "放弃续传后保存按钮回到正常脏数据规则");
  // 恢复记录损坏：不许保存、也不给放弃（放弃会把同一份原卷当新会话再传一遍、撤掉已有成绩），
  // 只给「已核对服务器，清除损坏记录」，且必须教师在确认框里认过核对才真的清（评审 P2）。
  uploadBlock = "recovery-damaged";
  const discardCalls: string[] = [];
  const realDiscard = scannerUploadManager.discardDamagedRecovery;
  const realDamagedSession = scannerUploadManager.damagedRecoverySessionId;
  scannerUploadManager.damagedRecoverySessionId = () => "remote-corrupt";
  scannerUploadManager.discardDamagedRecovery = ((cardId: string, groupId: string, sessionId: string) => {
    discardCalls.push(`${cardId}/${groupId}/${sessionId}`); uploadBlock = null;
    return { ok: true as const, remoteSessionId: "remote-corrupt" };
  }) as typeof scannerUploadManager.discardDamagedRecovery;
  await clickText("放大"); await settle();
  assert(saveButton()?.disabled, "损坏记录时不允许保存改分");
  assert(!findButton("放弃续传"), "损坏记录不提供放弃");
  const discardButton = findButton("已核对服务器，清除损坏记录");
  assert(discardButton, "损坏记录要给出核对后的清除入口");
  dom.window.confirm = (() => false) as typeof dom.window.confirm;
  await clickNode(discardButton!); await settle();
  assert.deepEqual(discardCalls, [], "没确认核对过就不清除记录");
  dom.window.confirm = (() => true) as typeof dom.window.confirm;
  await clickNode(findButton("已核对服务器，清除损坏记录")!); await settle();
  assert.deepEqual(discardCalls, [`${reviewCard.id}/0/review`], "确认核对后按本卡本组本会话清除");
  assert.deepEqual(releasedGroups, ["review/0", "review/0"], "清除后也要回调调用方清掉入队标记");
  assert(text().includes("已清除损坏的恢复记录"), "界面要说明清除后的下一步");
  assert(saveButton() && !saveButton()!.disabled, "清除损坏记录后保存回到正常脏数据规则");
  scannerUploadManager.discardDamagedRecovery = realDiscard;
  scannerUploadManager.damagedRecoverySessionId = realDamagedSession;
  scannerUploadManager.groupUploadBlock = realGroupBlock;
  scannerUploadManager.abandonGroupUpload = realAbandon;
  await clickText("放大"); await settle();
  await clickText("保存修改");assert(reviewed);

  // issue #347：横放原卷旋转到正向再点选，热区必须仍落在同一格上
  const rotatedPoints = scoreCell()!.getAttribute("points");
  const pressedBefore = scoreCell()!.getAttribute("aria-pressed");
  const rotateButton = [...reviewHost.querySelectorAll("button")].find(el => el.getAttribute("aria-label") === "顺时针旋转 90 度");
  assert(rotateButton, "改分视图带旋转按钮");
  await clickNode(rotateButton!);await settle();
  const rotatedCanvas = reviewHost.querySelector('svg[aria-label^="第 1 页答题卡"]') as SVGSVGElement | null;
  assert(rotatedCanvas, "旋转后仍渲染点选画布");
  assert.equal(rotatedCanvas!.getAttribute("viewBox"), "0 0 1414 1000", "旋转 90° 后视口宽高互换");
  assert(rotatedCanvas!.getAttribute("aria-label")?.includes("已旋转 90°"), "画布告知当前方向");
  assert.equal(scoreCell()!.getAttribute("points"), rotatedPoints, "热区坐标不随显示旋转改写");
  assert(scoreCell()!.parentElement?.getAttribute("transform")?.includes("rotate(90)"), "热区随图片按顺时针方向旋转");
  assert(!scoreCell()!.parentElement?.getAttribute("transform")?.includes("rotate(-90)"), "顺时针按钮不再生成逆时针的 rotate(-90)");
  await clickNode(scoreCell());await settle();
  assert.notEqual(scoreCell()!.getAttribute("aria-pressed"), pressedBefore, "旋转后点选仍命中同一格");
  await clickNode(scoreCell());await settle();
  assert.equal(scoreCell()!.getAttribute("aria-pressed"), pressedBefore, "再点一次回到原状态");

  console.log("PASS scanner-postprocess-ui-smoke");
} catch (error) {
  failure = error;
} finally {
  await act(async () => { root.unmount(); root2?.unmount(); root3?.unmount(); root4?.unmount(); root5?.unmount(); root6?.unmount(); root7?.unmount(); });
  notify.info = realNotifyInfo;
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
