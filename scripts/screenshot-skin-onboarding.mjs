#!/usr/bin/env node
/**
 * 皮肤引导层（SkinOnboarding）闭环视觉验证脚本
 *
 * 覆盖：首次访问（无 onboarded 标志）弹出 → 初始确认禁用（必须二选一）
 *       → 点选纸锋 → 选中态 → 确认 → 写入落盘 + 进入登录页
 *       亮 / 暗双主题各跑一遍（独立 context，避免 onboarded 串扰）
 *
 * 用法：
 *   PX_BASE=http://127.0.0.1:5173 \
 *     C:/Users/杨钊霖/.workbuddy/binaries/node/versions/22.22.2/node.exe \
 *     scripts/screenshot-skin-onboarding.mjs
 *
 * 输出：.workbuddy/screenshots/skin-onboarding_{initial|selected|after}_{light|dark}.png
 */

import { pathToFileURL } from "node:url";
const PLAYWRIGHT_PATH = pathToFileURL(
  "C:/Users/杨钊霖/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs",
).href;
const { chromium } = await import(PLAYWRIGHT_PATH);
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(PROJECT_ROOT, ".workbuddy", "screenshots");
const BASE = process.env.PX_BASE ?? "http://127.0.0.1:5173";

async function ensureDir(p) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function capture(browser, theme) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 2,
  });
  // 暗色：在 App 初始化前注入 localStorage（让默认 theme=dark），并兜底设 data-theme
  if (theme === "dark") {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("px.theme", "dark");
        localStorage.setItem("projectx-theme", "dark");
        document.documentElement.setAttribute("data-theme", "dark");
      } catch {}
    });
  }
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    const text = m.text();
    // 登录前页面自动请求认证接口返回 401 属正常预期，与引导层功能无关
    if (m.type() === "error" && !text.includes("401 (Unauthorized)")) {
      errors.push(text);
    }
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });

  // 引导层应弹出（首次访问，全新 context 无 onboarded）
  await page.getByText("请先选择一种风格").waitFor({ timeout: 10000 });

  // 暗色兜底：mount 后强制确认 data-theme=dark（防止 App 默认重置）
  if (theme === "dark") {
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(300);
  }

  // 断言 1：初始确认按钮禁用（必须二选一）
  const confirmInitial = page.getByRole("button", { name: "请先选择一种风格" });
  const disabledInit = await confirmInitial.isDisabled();
  console.log(`[assert] ${theme}: 初始确认按钮 disabled = ${disabledInit} (期望 true)`);

  const initFile = path.join(OUT_DIR, `skin-onboarding_initial_${theme}.png`);
  await page.screenshot({ path: initFile });
  console.log(`[shot] ${path.relative(PROJECT_ROOT, initFile)}`);

  // 选中纸锋（第二个 radio：明澈 nth0 / 纸锋 nth1）
  const radios = page.locator('button[role="radio"]');
  const radioCount = await radios.count();
  await radios.nth(1).click();
  await page.getByRole("button", { name: "使用纸锋风格，进入登录" }).waitFor({ timeout: 5000 });

  // 断言 2：选中后按钮文案 & 激活
  const confirmSelected = page.getByRole("button", { name: "使用纸锋风格，进入登录" });
  const disabledAfterSel = await confirmSelected.isDisabled();
  const radio1Checked = await radios.nth(1).getAttribute("aria-checked");
  console.log(`[assert] ${theme}: 选中后按钮 disabled = ${disabledAfterSel} (期望 false) | 纸锋 aria-checked = ${radio1Checked} (期望 true) | radio 数量 = ${radioCount}`);

  const selectedFile = path.join(OUT_DIR, `skin-onboarding_selected_${theme}.png`);
  await page.screenshot({ path: selectedFile });
  console.log(`[shot] ${path.relative(PROJECT_ROOT, selectedFile)}`);

  // 确认 → 应进入登录页（引导层卸载）
  await confirmSelected.click();
  await page.locator("input[autocomplete='username']").waitFor({ timeout: 10000 });

  // 断言 3：落盘 + 进入登录页
  const storage = await page.evaluate(() => ({
    skin: localStorage.getItem("projectx-skin"),
    chosen: sessionStorage.getItem("projectx-skin-chosen"),
    onboarded: localStorage.getItem("projectx-skin-onboarded"),
    dataSkin: document.documentElement.getAttribute("data-skin"),
  }));
  console.log(`[assert] ${theme}: storage = ${JSON.stringify(storage)}`);

  const afterFile = path.join(OUT_DIR, `skin-onboarding_after_${theme}.png`);
  await page.screenshot({ path: afterFile });
  console.log(`[shot] ${path.relative(PROJECT_ROOT, afterFile)}`);

  await context.close();
  return { disabledInit, disabledAfterSel, radio1Checked, radioCount, storage, errors };
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
await ensureDir(OUT_DIR);

const results = {};
try {
  for (const theme of ["light", "dark"]) {
    console.log(`\n=== 皮肤引导层 · ${theme} ===`);
    results[theme] = await capture(browser, theme);
  }
} catch (err) {
  console.error("[fatal]", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

// 汇总
console.log("\n=== 核验汇总 ===");
let allPass = true;
for (const theme of ["light", "dark"]) {
  const r = results[theme];
  if (!r) {
    allPass = false;
    console.log(`${theme}: 未产出（见上方错误）`);
    continue;
  }
  const pass =
    r.disabledInit === true &&
    r.disabledAfterSel === false &&
    r.radio1Checked === "true" &&
    r.storage.skin === "paper-edge" &&
    r.storage.chosen === "paper-edge" &&
    r.storage.onboarded === "1" &&
    r.storage.dataSkin === "paper-edge" &&
    r.errors.length === 0;
  if (!pass) allPass = false;
  console.log(
    `${theme}: 初始禁用=${r.disabledInit} 选中启用=${r.disabledAfterSel} 纸锋选中=${r.radio1Checked} skin=${r.storage.skin} chosen=${r.storage.chosen} onboarded=${r.storage.onboarded} dataSkin=${r.storage.dataSkin} 报错=${r.errors.length} → ${pass ? "PASS" : "FAIL"}`,
  );
  if (r.errors.length) r.errors.forEach((e) => console.log(`   [browser-error] ${e}`));
}
console.log(`\n总判定: ${allPass ? "ALL PASS" : "HAS FAIL"}`);
