/**
 * 【临时脚本 · DESIGN_PREVIEW】P2 过闸截图
 *
 * 用 Electron（仓库已有，无需额外下载浏览器）加载 /design-preview，
 * 依次切换 light / dark / compact 三态并整页截图，供人工核对 demo.html。
 *
 * 用法（需先起 dev server）：
 *   npx electron scripts/shoot-design-preview.cjs [baseUrl] [outDir]
 *
 * ⚠ P5 清理阶段与 dev/DesignPreviewPage.tsx 一并删除。
 */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.argv[2] || "http://127.0.0.1:5173";
const OUT = path.resolve(process.argv[3] || ".workbuddy/plans/p2-shots");
const WIDTH = 1440;

const SHOTS = [
  { name: "01-light", theme: "light", density: "normal" },
  { name: "02-dark", theme: "dark", density: "normal" },
  { name: "03-light-compact", theme: "light", density: "compact" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: WIDTH,
    height: 1200,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on("render-process-gone", (_e, d) =>
    errors.push("render-process-gone: " + JSON.stringify(d)),
  );

  await win.loadURL(`${BASE}/design-preview`);
  await sleep(2500);

  // 页面真的挂载了吗
  const mounted = await win.webContents.executeJavaScript(
    `!!document.querySelector('#shell') && document.querySelectorAll('section[id]').length`,
  );
  console.log("[shoot] 已渲染分区数 =", mounted);

  for (const shot of SHOTS) {
    await win.webContents.executeJavaScript(`(() => {
      const r = document.documentElement;
      r.setAttribute('data-theme', ${JSON.stringify(shot.theme)});
      if (${JSON.stringify(shot.density)} === 'compact') r.setAttribute('data-density','compact');
      else r.removeAttribute('data-density');
      window.scrollTo(0, 0);
      return true;
    })()`);
    await sleep(600);

    const full = await win.webContents.executeJavaScript(
      `document.documentElement.scrollHeight`,
    );
    win.setContentSize(WIDTH, Math.min(full, 16000));
    await sleep(900);

    const image = await win.webContents.capturePage();
    const file = path.join(OUT, `${shot.name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`[shoot] ${file}  ${image.getSize().width}x${image.getSize().height}`);

    win.setContentSize(WIDTH, 1200);
    await sleep(200);
  }

  if (errors.length) {
    console.log("[shoot] 控制台错误/警告：");
    errors.slice(0, 20).forEach((e) => console.log("   ", e));
  } else {
    console.log("[shoot] 无控制台错误");
  }

  app.quit();
});
