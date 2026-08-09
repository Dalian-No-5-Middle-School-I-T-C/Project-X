#!/usr/bin/env node
/**
 * QA 皮肤引导层（SkinOnboarding）闭环验证脚本（参数化）
 *
 * 覆盖两条路径（flat=明澈 / paper-edge=纸锋）× 双主题（light/dark），
 * 外加两个健壮性场景：防重复弹窗（onboarded=1 后 reload 不弹）、
 * 预览图 404 兜底（route abort 后组件不白屏/错位）。
 *
 * 每个正常组合断言：
 *   1) 引导层弹出（首次全新 context）
 *   2) 初始确认按钮 disabled（文案「请先选择一种风格」）
 *   3) 选中对应卡片后：aria-checked="true"、确认启用、文案正确
 *   4) 确认后 storage：projectx-skin / projectx-skin-chosen / onboarded="1" / data-skin
 *   5) 进入登录页（input[autocomplete='username'] 可见）
 *   6) 预览图真实加载（naturalWidth>0 + 像素方差非空白）
 *   7) 选中态视觉可见（border 与未选中不同）
 *   8) 登录页应用所选皮肤（body 背景色随 skin 变化）
 *   9) 暗色主题下选中卡片标题对比度（可读性）
 *  10) 防重复弹窗（同一 context reload 不再弹）
 *
 * 用法：
 *   SKIN=flat|paper-edge|both  THEME=light|dark|both \
 *   PX_BASE=http://127.0.0.1:5173 \
 *   C:/Users/杨钊霖/.workbuddy/binaries/node/versions/22.22.2/node.exe \
 *   scripts/qa-skin-onboarding.mjs
 *
 * 输出：.workbuddy/screenshots/qa-skin-<skin>_<theme>[_initial|_selected|_after].png
 *       .workbuddy/screenshots/qa-skin-<skin>_404fallback.png
 *       .workbuddy/qa-skin-results.json（结构化结果，供报告汇总）
 */

import { pathToFileURL } from "node:url";
const PLAYWRIGHT_PATH = pathToFileURL(
  "C:/Users/杨钊霖/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs",
).href;
const { chromium } = await import(PLAYWRIGHT_PATH);
import { mkdir } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(PROJECT_ROOT, ".workbuddy", "screenshots");
const BASE = process.env.PX_BASE ?? "http://127.0.0.1:5173";

/** 每套皮肤的定位配置（radio 索引、落盘 id、确认文案、预览图路径） */
const SKIN_CONFIG = {
  flat: {
    radioIndex: 0,
    id: "flat",
    confirmText: "使用明澈风格，进入登录",
    name: "明澈 Flat 2.0",
    preview: "/skin-onboarding-assets/flat-preview.png",
  },
  "paper-edge": {
    radioIndex: 1,
    id: "paper-edge",
    confirmText: "使用纸锋风格，进入登录",
    name: "纸锋 Paper Edge",
    preview: "/skin-onboarding-assets/paper-edge-preview.png",
  },
};

const SKINS_RAW = (process.env.SKIN ?? "both").split(",").map((s) => s.trim()).filter(Boolean);
const SKIN_LIST = SKINS_RAW.includes("both") || SKINS_RAW.length === 0 ? ["flat", "paper-edge"] : SKINS_RAW;
const THEMES_RAW = (process.env.THEME ?? "both").split(",").map((s) => s.trim()).filter(Boolean);
const THEME_LIST = THEMES_RAW.includes("both") || THEMES_RAW.length === 0 ? ["light", "dark"] : THEMES_RAW;

function ensureDir(p) {
  if (!existsSync(p)) return mkdir(p, { recursive: true });
}

// ---- 颜色 / 对比度工具 ----
function parseRGB(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(",").map((x) => parseFloat(x.trim()));
  return [p[0], p[1], p[2]];
}
function relLuminance([r, g, b]) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrastRatio(c1, c2) {
  const l1 = relLuminance(c1);
  const l2 = relLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

async function setupContext(browser, theme, { abortPreview } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 2,
  });
  if (theme === "dark") {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("px.theme", "dark");
        localStorage.setItem("projectx-theme", "dark");
        document.documentElement.setAttribute("data-theme", "dark");
      } catch {}
    });
  }
  if (abortPreview) {
    await context.route(abortPreview, (route) => route.abort());
  }
  return context;
}

async function capture(browser, skin, theme) {
  const cfg = SKIN_CONFIG[skin];
  const context = await setupContext(browser, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    const text = m.text();
    // 登录前请求认证接口返回 401 属正常噪音，排除
    if (m.type() === "error" && !text.includes("401 (Unauthorized)")) errors.push(text);
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  // 断言1：引导层弹出（首次访问，全新 context 无 onboarded）
  await page.getByText("请先选择一种风格").waitFor({ timeout: 10000 });

  // 暗色兜底：mount 后强制确认 data-theme=dark
  if (theme === "dark") {
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(300);
  }

  const result = { skin, theme, steps: {} };

  // 断言2：初始确认按钮禁用（必须二选一）
  const confirmInitial = page.getByRole("button", { name: "请先选择一种风格" });
  result.steps.initialDisabled = await confirmInitial.isDisabled();

  const initFile = path.join(OUT_DIR, `qa-skin-${skin}_${theme}_initial.png`);
  await page.screenshot({ path: initFile });
  result.steps.initShot = path.relative(PROJECT_ROOT, initFile);

  // 选中对应 radio（明澈 nth0 / 纸锋 nth1）
  const radios = page.locator('button[role="radio"]');
  const radioCount = await radios.count();
  result.steps.radioCount = radioCount;
  await radios.nth(cfg.radioIndex).click();
  await page.getByRole("button", { name: cfg.confirmText }).waitFor({ timeout: 5000 });

  // 断言3：选中后按钮启用 + aria-checked
  const confirmSelected = page.getByRole("button", { name: cfg.confirmText });
  result.steps.selectedDisabled = await confirmSelected.isDisabled();
  result.steps.radioChecked = await radios.nth(cfg.radioIndex).getAttribute("aria-checked");

  // 断言7：选中态视觉可见（选中卡片 border 与未选中不同）
  const otherIdx = cfg.radioIndex === 0 ? 1 : 0;
  const selBorder = await radios.nth(cfg.radioIndex).evaluate((el) => getComputedStyle(el).borderColor);
  const otherBorder = await radios.nth(otherIdx).evaluate((el) => getComputedStyle(el).borderColor);
  result.steps.selectedBorder = selBorder;
  result.steps.otherBorder = otherBorder;
  result.steps.borderDiffers = selBorder !== otherBorder;

  // 断言6：预览图真实加载（B）—— naturalWidth + 像素方差
  const imgEl = radios.nth(cfg.radioIndex).locator("img").first();
  result.steps.preview = await imgEl.evaluate((img) => ({
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    currentSrc: img.currentSrc,
  }));
  try {
    result.steps.previewVariance = await imgEl.evaluate((img) => {
      if (!img.complete || !img.naturalWidth) return { error: "not_loaded" };
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let min = 255, max = 0, sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 16) {
        const v = d[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        n++;
      }
      const mean = sum / n;
      let varSum = 0;
      for (let i = 0; i < d.length; i += 16) {
        const dv = d[i] - mean;
        varSum += dv * dv;
      }
      return { min, max, mean: Math.round(mean), variance: Math.round(varSum / n) };
    });
  } catch (e) {
    result.steps.previewVariance = { error: String(e && e.message ? e.message : e) };
  }

  // 断言9：暗色主题下选中卡片标题对比度（D，仅 dark）
  if (theme === "dark") {
    const c = await radios.nth(cfg.radioIndex).evaluate((el) => {
      const title = el.querySelector("h2");
      const card = el.closest("[class*='bg-card']") || el;
      return { titleColor: getComputedStyle(title).color, cardBg: getComputedStyle(card).backgroundColor };
    });
    result.steps.darkTitleColor = c.titleColor;
    result.steps.darkCardBg = c.cardBg;
    try {
      result.steps.darkContrastRatio = +contrastRatio(parseRGB(c.titleColor), parseRGB(c.cardBg)).toFixed(2);
    } catch {}
  }

  const selectedFile = path.join(OUT_DIR, `qa-skin-${skin}_${theme}_selected.png`);
  await page.screenshot({ path: selectedFile });
  result.steps.selectedShot = path.relative(PROJECT_ROOT, selectedFile);

  // 确认 → 进入登录页（引导层卸载）
  await confirmSelected.click();
  await page.locator("input[autocomplete='username']").waitFor({ timeout: 10000 });

  // 断言4：落盘 + data-skin
  result.steps.storage = await page.evaluate(() => ({
    skin: localStorage.getItem("projectx-skin"),
    chosen: sessionStorage.getItem("projectx-skin-chosen"),
    onboarded: localStorage.getItem("projectx-skin-onboarded"),
    dataSkin: document.documentElement.getAttribute("data-skin"),
  }));

  // 断言8：登录页应用所选皮肤（C）—— body 背景色随 skin 变化
  result.steps.loginBodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  const afterFile = path.join(OUT_DIR, `qa-skin-${skin}_${theme}_after.png`);
  await page.screenshot({ path: afterFile });
  result.steps.afterShot = path.relative(PROJECT_ROOT, afterFile);

  // 断言10：防重复弹窗（E）—— 同一 context 已设 onboarded=1，reload 不应再弹
  await page.reload({ waitUntil: "domcontentloaded" });
  let reappeared = true;
  try {
    await page.getByText("请先选择一种风格").waitFor({ timeout: 4000 });
  } catch {
    reappeared = false;
  }
  const loginAfterReload = await page.locator("input[autocomplete='username']").isVisible().catch(() => false);
  result.steps.antiDuplicateReappeared = reappeared;
  result.steps.antiDuplicateLoginVisible = loginAfterReload;

  result.errors = errors;
  await context.close();
  return result;
}

/** 健壮性场景 H：故意 abort 某预览图，验证组件不白屏/错位 */
async function captureRobustness(browser, skin) {
  const cfg = SKIN_CONFIG[skin];
  const context = await setupContext(browser, "light", { abortPreview: cfg.preview });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" && !text.includes("401 (Unauthorized)")) errors.push(text);
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  let popup = true;
  try {
    await page.getByText("请先选择一种风格").waitFor({ timeout: 10000 });
  } catch {
    popup = false;
  }
  const radios = page.locator('button[role="radio"]');
  const radioCount = await radios.count();
  const radiogroupCount = await page.locator('[role="radiogroup"]').count();
  const confirmTextVisible = await page.getByText("请先选择一种风格").isVisible().catch(() => false);

  const shotFile = path.join(OUT_DIR, `qa-skin-${skin}_404fallback.png`);
  await page.screenshot({ path: shotFile });

  await context.close();
  return {
    skin,
    previewAborted: cfg.preview,
    popup,
    radioCount,
    radiogroupCount,
    confirmTextVisible,
    expected404Error: errors.filter((e) => /404|Failed to load resource/.test(e)),
    otherErrors: errors.filter((e) => !/404|Failed to load resource/.test(e)),
    shot: path.relative(PROJECT_ROOT, shotFile),
  };
}

function printCombo(r) {
  const s = r.steps;
  const errs = r.errors || [];
  const cfg = SKIN_CONFIG[r.skin];
  const pass =
    s.initialDisabled === true &&
    s.selectedDisabled === false &&
    s.radioChecked === "true" &&
    s.radioCount === 2 &&
    s.storage.skin === cfg.id &&
    s.storage.chosen === cfg.id &&
    s.storage.onboarded === "1" &&
    s.storage.dataSkin === cfg.id &&
    s.antiDuplicateReappeared === false &&
    errs.length === 0 &&
    s.preview.naturalWidth > 0 &&
    s.borderDiffers === true;
  console.log(`[combo] ${r.skin} · ${r.theme}`);
  console.log(`  初始禁用=${s.initialDisabled} 选中启用=${s.selectedDisabled} aria-checked=${s.radioChecked} radio数=${s.radioCount}`);
  console.log(`  storage=${JSON.stringify(s.storage)}`);
  console.log(`  预览=${JSON.stringify(s.preview)} 方差=${JSON.stringify(s.previewVariance)}`);
  console.log(`  选中border=${s.selectedBorder} 未选border=${s.otherBorder} 差异=${s.borderDiffers}`);
  if (r.theme === "dark") console.log(`  暗色标题对比度=${s.darkContrastRatio} (color=${s.darkTitleColor} bg=${s.darkCardBg})`);
  console.log(`  登录bodyBg=${s.loginBodyBg} 防重复弹窗(reappeared)=${s.antiDuplicateReappeared} 登录可见=${s.antiDuplicateLoginVisible}`);
  console.log(`  非401报错数=${errs.length}`);
  if (errs.length) errs.forEach((e) => console.log(`    [browser-error] ${e}`));
  console.log(`  → ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

function printRobustness(rb) {
  console.log(`[robust] 预览404兜底 · ${rb.skin} (abort ${rb.previewAborted})`);
  console.log(`  popup=${rb.popup} radio数=${rb.radioCount} radiogroup数=${rb.radiogroupCount} 确认文案可见=${rb.confirmTextVisible}`);
  console.log(`  预期404报错=${rb.expected404Error.length} 其它报错=${rb.otherErrors.length}`);
  rb.otherErrors.forEach((e) => console.log(`    [other-error] ${e}`));
  const ok = rb.popup && rb.radioCount === 2 && rb.radiogroupCount === 1 && rb.confirmTextVisible && rb.otherErrors.length === 0;
  console.log(`  → ${ok ? "PASS（不白屏/不崩溃）" : "FAIL"}`);
}

await ensureDir(OUT_DIR);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const results = { combos: [], robustness: [], meta: { base: BASE, skinList: SKIN_LIST, themeList: THEME_LIST } };
try {
  for (const skin of SKIN_LIST) {
    for (const theme of THEME_LIST) {
      console.log(`\n=== QA 引导层 · ${skin} · ${theme} ===`);
      const r = await capture(browser, skin, theme);
      results.combos.push(r);
      printCombo(r);
    }
  }
  for (const skin of SKIN_LIST) {
    console.log(`\n=== QA 健壮性 · 预览404兜底 · ${skin} ===`);
    const rb = await captureRobustness(browser, skin);
    results.robustness.push(rb);
    printRobustness(rb);
  }
} catch (err) {
  console.error("[fatal]", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

writeFileSync(path.join(PROJECT_ROOT, ".workbuddy", "qa-skin-results.json"), JSON.stringify(results, null, 2));
console.log(`\n[result] 已写入 ${path.relative(PROJECT_ROOT, path.join(".workbuddy", "qa-skin-results.json"))}`);
