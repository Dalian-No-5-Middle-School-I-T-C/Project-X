#!/usr/bin/env node
/* 精确 DOM 检查 v2：双主题 × 两卡，点击后静置 400ms 再量，排除 transition 采样假阳性 */
import { pathToFileURL } from "node:url";
const PLAYWRIGHT_PATH = pathToFileURL(
  "C:/Users/杨钊霖/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs",
).href;
const { chromium } = await import(PLAYWRIGHT_PATH);
const BASE = process.env.PX_BASE ?? "http://127.0.0.1:5173";

async function measure(page) {
  return page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('button[role="radio"]'));
    return radios.map((el) => {
      const cs = getComputedStyle(el);
      const badge = el.querySelector('div[class*="bg-primary"]');
      return {
        name: el.querySelector("h2")?.textContent,
        ariaChecked: el.getAttribute("aria-checked"),
        borderColor: cs.borderColor,
        hasPrimaryBgBadge: !!badge,
        badgeBg: badge ? getComputedStyle(badge).backgroundColor : null,
      };
    });
  });
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    if (theme === "dark") {
      await page.addInitScript(() => {
        try {
          localStorage.setItem("projectx-theme", "dark");
          document.documentElement.setAttribute("data-theme", "dark");
        } catch {}
      });
    }
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.getByText("请先选择一种风格").waitFor({ timeout: 10000 });
    if (theme === "dark") {
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.waitForTimeout(300);
    }
    const dataSkin = await page.evaluate(() => document.documentElement.getAttribute("data-skin"));
    // 依次选两张卡，每张静置 400ms 后量
    for (let i = 0; i < 2; i++) {
      await page.locator('button[role="radio"]').nth(i).click();
      await page.waitForTimeout(400); // 静置过渡
      const m = await measure(page);
      const sel = m[i], other = m[1 - i];
      const differs = sel.borderColor !== other.borderColor;
      console.log(`[${theme}] data-skin=${dataSkin} 选「${sel.name}」`);
      console.log(`   选中 border=${sel.borderColor} 徽标=${sel.hasPrimaryBgBadge ? sel.badgeBg : "无"}`);
      console.log(`   未选 border=${other.borderColor}`);
      console.log(`   → 边框差异=${differs ? "TRUE ✅ 选中态清晰" : "FALSE ❌ 同色"}`);
    }
    await ctx.close();
  }
} catch (e) {
  console.error("[fatal]", e.stack || e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
