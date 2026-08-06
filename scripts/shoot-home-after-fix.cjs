const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const outDir = path.join(__dirname, "..", ".workbuddy", "plans", "p3-home-fix");
fs.mkdirSync(outDir, { recursive: true });

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

  setTimeout(async () => {
    const png = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, "home.png"), png.toPNG());
    console.log("saved", path.join(outDir, "home.png"));
    await win.close();
    app.quit();
  }, 4000);
});

app.on("window-all-closed", () => app.quit());
