import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { ScorePad } from "../src/apps/answer-card/client/components/ScorePad";

const dom = new JSDOM("<main></main>", { url: "https://review.test/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const host = document.querySelector("main")!;
const root = createRoot(host);
const submitted: number[] = [];

function Pad({ maxScore, hasHalfPoint }: { maxScore: number; hasHalfPoint: boolean }) {
  const [value, change] = useState(0);
  return createElement(ScorePad, { maxScore, hasHalfPoint, currentScore: value, onScoreChange: change, onSubmit: score => submitted.push(score) });
}
const buttons = () => [...host.querySelectorAll("button")];
async function click(label: string) {
  const button = buttons().find(b => b.textContent === label);
  assert.ok(button, `存在按钮「${label}」`);
  await act(() => button.click());
}
try {
  for (const maxScore of [0.25, 5.5, 5.25, 25.5, 25.25]) {
    const hasHalfPoint = maxScore % 1 === 0.25;
    await act(() => root.render(createElement(Pad, { key: maxScore, maxScore, hasHalfPoint })));
    const full = `满分 ${maxScore}`;
    const otherKeys = buttons().map(b => b.textContent!).filter(label => label !== full).map(Number);
    const step = hasHalfPoint ? 0.5 : 1;
    assert.ok(otherKeys.every(n => Number.isInteger(n / step) && n <= maxScore));
    await click(full);
    assert.equal(submitted.at(-1), maxScore);
    assert.ok(host.textContent?.endsWith(`${maxScore} 分`), "预览显示精确满分");
    if (maxScore >= 20) {
      const before = submitted.length;
      await click("10");
      assert.ok(host.textContent?.endsWith("15 分"), "从小数满分改选十位后回到设置允许的分值");
      await click("4");
      assert.equal(submitted.length, before, "十位与个位只更新草稿");
      const tenths = hasHalfPoint ? "0.5" : "0";
      const finalKey = buttons().filter(b => b.textContent === tenths).at(-1)!;
      await act(() => finalKey.click());
      assert.equal(submitted.at(-1), 14 + Number(tenths));
    } else {
      const partial = hasHalfPoint && maxScore >= 0.5 ? 0.5 : 0;
      await click(String(partial));
      assert.equal(submitted.at(-1), partial);
    }
  }
  console.log("ScorePad: exact full marks 0.25, 5.5, 5.25, 25.5 and 25.25, permitted partial marks and digit previews passed");
} finally {
  await act(() => root.unmount());
  dom.window.close();
}
