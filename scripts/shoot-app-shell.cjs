/**
 * 【临时脚本】登录后截取 App.tsx 新外壳
 * 用法：先同时起 vite (5173) 与 server (5174)，然后
 *       env -u ELECTRON_RUN_AS_NODE npx electron scripts/shoot-app-shell.cjs
 * ⚠ P5 清理阶段删除。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.argv[2] || "http://127.0.0.1:5173";
const OUT = path.resolve(process.argv[3] || ".workbuddy/plans/p3-shots");
const ADMIN_PASS =
  process.argv[4] ||
  fs.readFileSync(path.resolve("data/bootstrap-admin.txt"), "utf-8").trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: false,
    webPreferences: { offscreen: true },
  });

  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  await win.loadURL(`${BASE}/home`);
  await sleep(1500);

  // 登录
  const onLogin = await win.webContents.executeJavaScript(`
    !!document.querySelector('input[type="password"]')
  `);
  if (onLogin) {
    await win.webContents.executeJavaScript(`
      (() => {
        const inputs = document.querySelectorAll('input');
        const idInput = Array.from(inputs).find(i => i.type === 'text' || i.name === 'identifier' || i.placeholder?.includes('账号'));
        const pwInput = Array.from(inputs).find(i => i.type === 'password');
        if (idInput) { idInput.value = 'admin'; idInput.dispatchEvent(new Event('input', {bubbles:true})); }
        if (pwInput) { pwInput.value = ${JSON.stringify(ADMIN_PASS)}; pwInput.dispatchEvent(new Event('input', {bubbles:true})); }
        const btn = document.querySelector('button[type="submit"]') || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('登录'));
        if (btn) btn.click();
        return true;
      })()
    `);
    await sleep(2500);
  }

  // 截图 light
  await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','light'); document.documentElement.removeAttribute('data-density'); window.scrollTo(0,0); return true;`);
  await sleep(500);
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "01-home-light.png"), img.toPNG());
  console.log("01-home-light.png", img.getSize());

  // 切到设计页
  await win.webContents.executeJavaScript(`
    (() => {
      const link = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('答题卡设计'));
      if (link) link.click();
      return true;
    })()
  `);
  await sleep(2000);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "02-design-light.png"), img.toPNG());
  console.log("02-design-light.png", img.getSize());

  // dark
  await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','dark'); return true;`);
  await sleep(500);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "03-design-dark.png"), img.toPNG());
  console.log("03-design-dark.png", img.getSize());

  if (errors.length) {
    console.log("控制台错误/警告：");
    errors.slice(0, 20).forEach((e) => console.log("   ", e));
  } else {
    console.log("无控制台错误");
  }
  app.quit();
});
