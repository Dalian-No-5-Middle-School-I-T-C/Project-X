const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// ── v1.6.1: Electron now only packages the scanner build.
// Teacher/student features are deployed via the web build (dist/web/).
// Single variant: scanner-only, always enabled.

let server;
let mainWindow;

const PRODUCT_NAME = "Project-X 答题卡扫描端";

function getAppRoot() {
  return app.getAppPath();
}

function configureAppIdentity() {
  app.setName(PRODUCT_NAME);
  app.setPath("userData", path.join(app.getPath("appData"), "answer-card-designer"));
}

async function startLocalServer() {
  const appRoot = getAppRoot();
  const serverBundle = path.join(appRoot, "dist", "server", "index.mjs");
  const clientDist = path.join(appRoot, "dist", "scanner");
  const userDataDir = app.getPath("userData");
  const dataDir = path.join(userDataDir, "data", "answer-card");

  process.env.PROJECTX_ENABLE_SCANNER = "1";
  process.env.ANSWER_CARD_DATA_DIR = dataDir;
  process.env.ANSWER_CARD_CLIENT_DIST = clientDist;
  process.env.PROJECTX_DB_PATH = path.join(userDataDir, "data", "projectx.db");

  try {
    const serverModule = await import(pathToFileURL(serverBundle).href);
    const preferredPort = Number(process.env.PROJECTX_ELECTRON_PORT || 5174);
    try {
      server = await serverModule.startServer(preferredPort);
    } catch (error) {
      if (error && (error.code === "EADDRINUSE" || error.code === "EACCES")) {
        console.warn(`[Electron] Port ${preferredPort} is unavailable (${error.code}); falling back to a random port.`);
        server = await serverModule.startServer(0);
      } else {
        throw error;
      }
    }
  } catch (importError) {
    const msg = importError instanceof Error ? importError.message : String(importError);
    console.error(`[Electron] Failed to load server bundle: ${msg}`);
    if (msg.includes("better-sqlite3") || msg.includes("node_sqlite3") || msg.includes(".node")) {
      throw new Error(
        `后端原生模块加载失败，可能是本机架构（${process.arch}）与已编译模块不匹配。` +
        `\n请运行 npm run rebuild:electron 重新编译原生模块后再启动。` +
        `\n\n技术细节：${msg}`
      );
    }
    throw new Error(`后端启动失败：${msg}`);
  }
  const address = server.address();
  const actualPort = Number(server.actualPort || (address && typeof address === "object" ? address.port : 0));
  const localUrl = server.localUrl || (Number.isFinite(actualPort) && actualPort > 0 ? `http://127.0.0.1:${actualPort}` : "");
  if (!localUrl) {
    const addressText = address === null || address === undefined ? String(address) : JSON.stringify(address);
    throw new Error(`Cannot determine local server port. listening=${Boolean(server.listening)} address=${addressText}`);
  }
  await waitForLocalServer(localUrl);
  return localUrl;
}

async function waitForLocalServer(baseUrl) {
  const healthUrl = `${baseUrl}/api/app/health`;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const statusCode = await requestLocalHealth(healthUrl);
      if (statusCode >= 200 && statusCode < 300) return;
      lastError = new Error(`Health check returned ${statusCode}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Local server did not respond at ${healthUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function requestLocalHealth(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 1000 }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode || 0));
    });
    request.on("timeout", () => {
      request.destroy(new Error("health check timed out"));
    });
    request.on("error", reject);
  });
}

async function resolveStartUrl() {
  const serverMode = (process.env.PROJECTX_SERVER_MODE || "local").toLowerCase();
  if (serverMode === "remote") {
    const remoteUrl = process.env.PROJECTX_REMOTE_URL;
    if (!remoteUrl) {
      throw new Error("PROJECTX_SERVER_MODE=remote requires PROJECTX_REMOTE_URL.");
    }
    return remoteUrl;
  }
  return startLocalServer();
}

async function createWindow() {
  const baseUrl = await resolveStartUrl();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    title: PRODUCT_NAME,
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

configureAppIdentity();

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
