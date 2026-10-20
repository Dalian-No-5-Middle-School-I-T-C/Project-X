/** 原卷旋转组件挂载回归（issue #347 评审②③）：
 *  图片先加载、之后才点旋转按钮也必须生效；90°/270° 时视口与容器宽高比同步互换；
 *  同一实例换页要重新测量尺寸；挂载时已旋转的懒加载页可测量；加载失败仍回调给调用方（媒体票据重签）。
 *  用法: npm run verify:card-rotation-ui */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import type { ImageRotation } from "../src/apps/answer-card/client/components/RotatedCardImage";

const dom = new JSDOM('<div id="root"></div>', { url: "https://web.test" });
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLImageElement", "DocumentFragment", "Element", "Node", "Event", "CustomEvent", "getComputedStyle"]) {
  install(name, name === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[name]);
}
install("IS_REACT_ACT_ENVIRONMENT", true);
install("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const { createRoot } = await import("react-dom/client");
const { RotatedCardImage, RotationButtons, rotateImageBy } =
  await import("../src/apps/answer-card/client/components/RotatedCardImage");

async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 12)); }); }

/** jsdom 不加载网络图片：把 naturalWidth/Height 写进元素再派发 load。 */
function fireLoad(el: Element, width: number, height: number) {
  Object.defineProperty(el, "naturalWidth", { configurable: true, get: () => width });
  Object.defineProperty(el, "naturalHeight", { configurable: true, get: () => height });
  act(() => { el.dispatchEvent(new dom.window.Event("load")); });
}
function fireError(el: Element) {
  act(() => { el.dispatchEvent(new dom.window.Event("error")); });
}

interface ProbeProps { src: string; initialRotation?: ImageRotation; onError?: () => void }
/** 与真实用法同构：工具条持有 rotation，图片随状态重绘；src 由外部切换（翻页/换页）。 */
function Probe({ src, initialRotation = 0, onError }: ProbeProps) {
  const [rotation, setRotation] = useState<ImageRotation>(initialRotation);
  return createElement("div", null,
    createElement(RotationButtons, { rotation, onChange: setRotation }),
    createElement(RotatedCardImage, { src, alt: "原卷", rotation, onError: onError as never }),
  );
}

const ratio = (el: Element) => (el as HTMLElement).style.aspectRatio.replace(/\s+/g, " ").trim();

/** 一个挂载点：同一实例可反复换 src，从而检验「换图后重新测量」。 */
function mount(props: ProbeProps) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (next: ProbeProps = props) => { await act(async () => root.render(createElement(Probe, next))); await settle(); };
  const img = () => host.querySelector("img");
  const svg = () => host.querySelector("svg[role=img]");
  const rotate = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find(el => el.getAttribute("aria-label") === label);
    assert(button, `旋转按钮「${label}」存在`);
    await act(async () => { button!.click(); });
    await settle();
  };
  return { host, root, render, img, svg, rotate };
}

const mounted: ReturnType<typeof mount>[] = [];
function opened(props: ProbeProps) { const instance = mount(props); mounted.push(instance); return instance; }

try {
  // ── 正常时序：先看图（0°），加载完成后才点旋转按钮 ──
  const page = opened({ src: "/api/card/page-1.png" });
  await page.render();
  assert(page.img(), "未旋转时按普通 <img> 渲染");
  assert(!page.svg(), "未旋转时不引入 SVG 容器");
  fireLoad(page.img()!, 1000, 1414);
  await settle();
  assert(page.img() && !page.svg(), "0° 时保持原图渲染，不因已测得尺寸改结构");

  await page.rotate("顺时针旋转 90 度");
  assert(page.svg(), "图片加载完成后再点旋转也能进入 SVG 分支");
  assert.equal(page.svg()!.getAttribute("viewBox"), "0 0 1414 1000", "90° 视口宽高互换");
  assert.equal(ratio(page.svg()!), "1414 / 1000", "90° 容器宽高比同步互换，不留白");
  assert.equal(page.svg()!.querySelector("image")?.getAttribute("width"), "1000", "图片本体仍是原始宽度");
  assert(page.svg()!.querySelector("g")?.getAttribute("transform")?.includes("rotate(-90)"), "内容整组旋转");

  await page.rotate("顺时针旋转 90 度");
  assert.equal(page.svg()!.getAttribute("viewBox"), "0 0 1000 1414", "180° 回到原始宽高");
  assert.equal(ratio(page.svg()!), "1000 / 1414", "180° 容器比例一致");

  await page.rotate("顺时针旋转 90 度");
  assert.equal(page.svg()!.getAttribute("viewBox"), "0 0 1414 1000", "270° 同样互换");
  assert.equal(ratio(page.svg()!), "1414 / 1000", "270° 容器比例同步互换");
  assert(page.svg()!.querySelector("g")?.getAttribute("transform")?.includes("rotate(90)"), "270° 反向旋转");

  await page.rotate("逆时针旋转 90 度");
  assert.equal(page.svg()!.getAttribute("viewBox"), "0 0 1000 1414", "270° 逆时针回退到 180°");
  await page.rotate("逆时针旋转 90 度");
  await page.rotate("逆时针旋转 90 度");
  assert(!page.svg() && page.img(), "转回 0° 回落为原图渲染");

  // ── 同一实例在 90° 状态下翻页：新图必须重新测量，不能沿用上一页尺寸 ──
  await page.rotate("顺时针旋转 90 度");
  await page.render({ src: "/api/card/page-2.png" });
  assert(!page.svg(), "换图后尺寸未知时不画旋转容器");
  assert.match(page.img()!.getAttribute("src")!, /page-2\.png$/, "换的是下一页");
  fireLoad(page.img()!, 1414, 1000);
  await settle();
  assert(page.svg(), "横版新图重新测量后按 90° 旋转");
  assert.equal(page.svg()!.getAttribute("viewBox"), "0 0 1000 1414", "横版图旋转 90° 后视口竖放");
  assert.equal(ratio(page.svg()!), "1000 / 1414", "容器比例跟随新图，不沿用上一页");

  // ── 挂载时已是 90°：整批旋转之后才加载的懒加载页 ──
  const late = opened({ src: "/api/card/page-3.png", initialRotation: 90 });
  await late.render();
  fireLoad(late.img()!, 1000, 1414);
  await settle();
  assert(late.svg(), "挂载即旋转的页面加载后进入 SVG 分支");
  assert.equal(late.svg()!.getAttribute("viewBox"), "0 0 1414 1000", "挂载即 90° 时视口互换");
  assert.equal(ratio(late.svg()!), "1414 / 1000", "挂载即 90° 时容器比例互换");

  // ── 加载失败仍交给调用方：媒体票据重签依赖 <img> 的 error 事件 ──
  let errored = 0;
  const broken = opened({ src: "/api/card/page-4.png", onError: () => { errored++; } });
  await broken.render();
  fireError(broken.img()!);
  assert.equal(errored, 1, "未旋转分支的加载失败回调透传给调用方");

  // ── 步进闭合：连点不出现负角度或非法值 ──
  assert.equal(rotateImageBy(0, -90), 270);
  assert.equal(rotateImageBy(90, -90), 0);
  assert.equal(rotateImageBy(270, 90), 0);

  console.log("PASS rotated-card-image-ui-smoke");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const instance of mounted) await act(async () => instance.root.unmount());
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[name];
  }
}
