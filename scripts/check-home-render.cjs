const { app, BrowserWindow } = require("electron");

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL("http://127.0.0.1:5173/home");

  // 等页面加载 + React 渲染 + 若干重渲染
  setTimeout(async () => {
    const html = await win.webContents.executeJavaScript("document.body.innerHTML");
    const hasError = html.includes("Unexpected Application Error") || html.includes("Rendered more hooks");
    const title = await win.webContents.executeJavaScript("document.title");
    console.log(JSON.stringify({ hasError, title, errorText: hasError ? html.match(/Unexpected Application Error[\s\S]{0,200}/)?.[0] ?? "" : "" }, null, 2));
    await win.close();
    app.quit();
    process.exit(hasError ? 1 : 0);
  }, 4000);
});

app.on("window-all-closed", () => app.quit());
