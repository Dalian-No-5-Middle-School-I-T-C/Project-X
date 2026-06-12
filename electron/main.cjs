const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let server;
let mainWindow;

function getAppRoot() {
  return app.getAppPath();
}

async function startLocalServer() {
  const appRoot = getAppRoot();
  const serverBundle = path.join(appRoot, "dist", "server", "index.mjs");
  const clientDist = path.join(appRoot, "dist", "client");
  const userDataDir = app.getPath("userData");
  const dataDir = path.join(userDataDir, "data", "answer-card");

  process.env.ANSWER_CARD_DATA_DIR = dataDir;
  process.env.ANSWER_CARD_CLIENT_DIST = clientDist;
  process.env.PROJECTX_DB_PATH = path.join(userDataDir, "data", "projectx.db");

  const serverModule = await import(pathToFileURL(serverBundle).href);
  server = await serverModule.startServer(0);
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("Cannot determine local server port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function createWindow() {
  const baseUrl = await startLocalServer();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    title: "答题卡设计系统",
    backgroundColor: "#eef2ef",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseUrl)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(baseUrl);
}

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
    dialog.showErrorBox("启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("before-quit", () => {
  if (server) {
    server.close();
    server = undefined;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
