/** 扫描端通知卡回归：主进程崩溃恢复 → React 通知卡；未捕获错误 → 可关闭诊断卡。
 *  同时钉住两边的事件名：electron/main.cjs 派发，ScannerNotice 监听。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM('<div id="root"></div>', { url: "https://scanner.test" });
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "CustomEvent", "getComputedStyle"]) {
  install(name, name === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[name]);
}
install("IS_REACT_ACT_ENVIRONMENT", true);

const { ScannerNotice, reportRendererProblem } = await import("../src/apps/answer-card/client/components/ScannerNotice");
const recoveredFlag = dom.window as unknown as { __projectxRendererRecovered?: boolean };
const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
const settle = async () => { await act(async () => { await Promise.resolve(); }); };

// ① 挂载前就报上来的异常：先存着，挂载后立刻显示，不会丢
reportRendererProblem("界面遇到异常", "TypeError: boom at render");
const host = document.getElementById("root")!;
const root = createRoot(host);
await act(async () => { root.render(createElement(ScannerNotice)); });
const problem = document.querySelector('[role="alert"]');
assert(problem, "未捕获错误要显示诊断卡");
assert(problem!.textContent?.includes("界面遇到异常"), "诊断卡标题");
assert(problem!.textContent?.includes("TypeError: boom at render"), "技术信息要能展开看到原始错误");
assert(button(problem!, "重新加载"), "诊断卡保留重新加载入口");
assert(button(problem!, "知道了"), "诊断卡可关闭，不遮整页");
await act(async () => { button(problem!, "知道了")!.click(); });
assert.equal(document.querySelector('[role="alert"]'), null, "关闭后诊断卡消失");

// ② 渲染进程崩溃重载：主进程置位标记并派发同名事件
recoveredFlag.__projectxRendererRecovered = true;
await act(async () => { dom.window.dispatchEvent(new dom.window.Event("projectx:renderer-recovered")); });
const recovered = document.querySelector('[role="status"]');
assert(recovered, "崩溃重载后要提示已自动恢复");
assert(recovered!.textContent?.includes("界面已自动恢复"), "恢复提示文案");
assert(recovered!.className.includes("z-(--px-z-toast)"), "层级走语义令牌阶梯，不写死 z-index");
assert.equal(recoveredFlag.__projectxRendererRecovered, false, "标记读一次即清，后续导航不再重复弹");
await act(async () => { button(recovered!, "知道了")!.click(); });
assert.equal(document.querySelector('[role="status"]'), null, "关闭后恢复提示消失");

// ③ 事件早于 React 挂载：挂载时补读标记
await act(async () => { root.unmount(); });
recoveredFlag.__projectxRendererRecovered = true;
const host2 = document.createElement("div");
document.body.append(host2);
const root2 = createRoot(host2);
await act(async () => { root2.render(createElement(ScannerNotice)); });
await settle();
assert(host2.querySelector('[role="status"]')?.textContent?.includes("界面已自动恢复"),
  "事件早于挂载时，挂载后仍要显示恢复提示");
await act(async () => { root2.unmount(); });
host2.remove();

// ④ 两边的事件名成对：只在一边改字符串，通知会静默失效
const mainSource = readFileSync("electron/main.cjs", "utf8");
assert(mainSource.includes("projectx:renderer-recovered"), "electron/main.cjs 必须派发同一个事件名");
assert(!mainSource.includes("style.cssText"), "主进程不再注入内联样式的 DOM，提示卡由 React 渲染");

console.log("PASS scanner-notice");
