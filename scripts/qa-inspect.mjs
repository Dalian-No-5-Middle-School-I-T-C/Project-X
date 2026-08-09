#!/usr/bin/env node
/**
 * 聚焦检查：引导层选中态视觉（badge 颜色、border、当前 data-skin、token 解析值）
 * 仅用于 QA 证据采集，不改源码。
 */
import { pathToFileURL } from "node:url";
const PLAYWRIGHT_PATH = pathToFileURL(
  "C:/Users/杨钊霖/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs",
).href;
const { chromium } = await import(PLAYWRIGHT_PATH);
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const BASE = process.env.PX_BASE ?? "http://127.0.0.1:5173";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.getByText("请先选择一种风格").waitFor({ timeout: 10000 });

async function inspect(idx, label) {
  const radios = page.locator('button[role="radio"]');
  await radios.nth(idx).click();
  await page.waitForTimeout(300);
  const info = await radios.nth(idx).evaluate((el) => {
    const cs = getComputedStyle(el);
    // 选中态的 check badge：绝对定位、bg-primary
    const badge = el.querySelector('div[class*="bg-primary"]');
    const badgeCs = badge ? getComputedStyle(badge) : null;
    const root = document.documentElement;
    const cvar = (n) => getComputedStyle(root).getPropertyValue(n).trim();
    return {
      className: el.className,
      borderColor: cs.borderColor,
      badgeExists: !!badge,
      badgeBg: badgeCs ? badgeCs.backgroundColor : null,
      dataSkin: root.getAttribute("data-skin"),
      token_primary: cvar("--primary"),
      token_px_accent_bg: cvar("--px-accent-bg"),
      token_px_border_subtle: cvar("--px-border-subtle"),
      token_px_border_default: cvar("--px-border-default"),
    };
  });
  console.log(`\n[inspect] 选中 ${label} (radio nth${idx})`);
  console.log(JSON.stringify(info, null, 2));
  return info;
}

await inspect(0, "明澈 flat");
await inspect(1, "纸锋 paper-edge");

await context.close();
await browser.close();
console.log("\n[done]");
