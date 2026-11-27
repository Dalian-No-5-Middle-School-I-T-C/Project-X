import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { compile } from "tailwindcss";

const dom = new JSDOM('<div id="root"></div>', {
  url: "https://scanner.test",
  pretendToBeVisual: true,
});
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
install("window", dom.window);
install("document", dom.window.document);
install("navigator", dom.window.navigator);
install("localStorage", dom.window.localStorage);
install("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
install("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
install("IS_REACT_ACT_ENVIRONMENT", true);

let serverOnline = true;
install("fetch", async (input: RequestInfo | URL) => {
  assert.equal(String(input), "https://upload.test/api/app/health");
  return serverOnline
    ? Response.json({ ok: true, capabilities: { scannerClientApi: true } })
    : Response.json({ error: "服务器离线" }, { status: 503 });
});
localStorage.setItem("projectx_server_url", "https://upload.test");

const { createRoot } = await import("react-dom/client");
const { UploadProgressCard } = await import("../src/apps/answer-card/client/components/UploadProgressCard");
const { scannerUploadManager } = await import("../src/apps/answer-card/client/lib/scannerUploadManager");
const { serverStatus } = await import("../src/apps/answer-card/client/lib/remoteServerStatus");
const mount = document.getElementById("root")!;
const root = createRoot(mount);

function button(label: string): HTMLButtonElement {
  const element = Array.from(mount.querySelectorAll("button")).find(node =>
    (node.getAttribute("aria-label") ?? node.textContent?.trim()) === label);
  assert(element, `缺少按钮「${label}」`);
  return element;
}

function click(label: string) {
  return act(async () => { button(label).click(); });
}

function startTask(name: string, cardVersion: string) {
  scannerUploadManager.startUpload({
    kind: "scan",
    cardId: "upload-progress",
    cardVersion,
    name,
    pages: [{ pageNum: 1, side: "front", getBlob: async () => new Blob(["sample"]) }],
  });
}

const jobs = () => scannerUploadManager.getState().jobs;
const errorCount = () => jobs().filter(job => job.status === "error").length;
const list = () => mount.querySelector<HTMLElement>('[aria-label="上传任务列表"]');

try {
  await act(async () => {
    root.render(createElement(UploadProgressCard));
  });
  assert.equal(serverStatus.getState().kind, "online");
  await act(async () => {
    for (let i = 0; i < 140; i++) startTask(`失败卷 ${i + 1}`, "");
  });
  assert.equal(errorCount(), 140);
  assert.equal(list()?.querySelectorAll('button[aria-label="关闭"]').length, 140);

  await click("收起上传");
  const collapsed = button("展开上传（140） · 失败 140");
  assert.equal(collapsed.textContent, "失败 140");
  assert.equal(collapsed.getAttribute("aria-expanded"), "false");
  assert.equal(mount.querySelectorAll("button").length, 1);
  assert.equal(list(), null);
  await click("展开上传（140） · 失败 140");

  serverOnline = false;
  await act(async () => { serverStatus.refresh(); });
  assert.equal(serverStatus.getState().kind, "offline");
  await act(async () => {
    const version = "0123456789abcdef01234567";
    startTask("已暂停的卷", version);
    startTask("排队的卷 1", version);
    startTask("排队的卷 2", version);
  });
  assert.equal(jobs().filter(job => job.status === "paused").length, 1);
  assert.equal(jobs().filter(job => job.status === "queued").length, 2);
  await click("收起上传");
  assert.equal(button("展开上传（143） · 排队 2 · 已暂停 1 · 失败 140").textContent, "排队 2 · 已暂停 1 · 失败 140");
  await click("展开上传（143） · 排队 2 · 已暂停 1 · 失败 140");

  const panel = mount.querySelector<HTMLElement>('[aria-label="上传任务"]')!;
  const taskList = list()!;
  const close = button("收起上传");
  const clear = button("清空失败（140）");
  const cancel = button("取消排队（3）");
  const layoutElements = [panel, taskList, close.parentElement!, clear.parentElement!];
  // 用挂载元素的 Tailwind 样式验证实际滚动容器，不读取组件源码。
  const utilities = await compile("@tailwind utilities;");
  const style = document.createElement("style");
  style.textContent = utilities.build(layoutElements.flatMap(el => Array.from(el.classList)));
  document.head.append(style);
  assert.equal(dom.window.getComputedStyle(taskList).overflowY, "auto");
  assert.equal(dom.window.getComputedStyle(panel).overflow, "hidden");
  for (const control of [close, clear, cancel]) {
    assert.equal(taskList.contains(control), false);
    assert.equal(dom.window.getComputedStyle(control.parentElement!).flexShrink, "0");
  }

  await click("取消排队（3）");
  assert.equal(jobs().filter(job => job.status === "queued" || job.status === "paused").length, 0);
  assert.equal(errorCount(), 140);
  assert.equal(taskList.textContent?.includes("任务已取消"), true);
  await click("清空失败（140）");
  assert.equal(errorCount(), 0);
  assert.equal(taskList.textContent?.includes("失败卷"), false);
  await click("关闭");
  assert.equal(mount.querySelector('[aria-label="上传任务"]'), null);

  console.log("PASS scanner-upload-progress-ui-smoke");
} finally {
  await act(async () => { root.unmount(); });
  serverStatus.stop();
  dom.window.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
