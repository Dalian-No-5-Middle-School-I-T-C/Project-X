const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let server;
let mainWindow;

const DEFAULT_VARIANT = "teacher-scanner";
const VARIANTS = {
  student: {
    id: "student",
    productName: "Project-X 学生端",
    userDataDir: "answer-card-designer",
    enableScanner: false
  },
  teacher: {
    id: "teacher",
    productName: "Project-X 教师端",
    userDataDir: "answer-card-designer",
    enableScanner: false
  },
  "teacher-scanner": {
    id: "teacher-scanner",
    productName: "Project-X 教师扫描端",
    userDataDir: "answer-card-designer",
    enableScanner: true
  }
};

function normalizeVariant(value) {
  return value === "student" || value === "teacher" || value === "teacher-scanner"
    ? value
    : DEFAULT_VARIANT;
}

function getAppRoot() {
  return app.getAppPath();
}

function readPackagedVariant() {
  try {
    const packageJsonPath = path.join(getAppRoot(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return packageJson.projectxVariant;
  } catch {
    return undefined;
  }
}

function getVariantConfig() {
  const variant = normalizeVariant(process.env.PROJECTX_VARIANT || readPackagedVariant());
  return VARIANTS[variant];
}

const variantConfig = getVariantConfig();

function configureAppIdentity() {
  app.setName(variantConfig.productName);
  app.setPath("userData", path.join(app.getPath("appData"), variantConfig.userDataDir));
}


async function startLocalServer() {
  const appRoot = getAppRoot();
  const serverBundle = path.join(appRoot, "dist", "server", "index.mjs");
  const clientDist = path.join(appRoot, "dist", "client");
  const userDataDir = app.getPath("userData");
  const dataDir = path.join(userDataDir, "data", "answer-card");

  process.env.PROJECTX_VARIANT = variantConfig.id;
  process.env.PROJECTX_ENABLE_SCANNER = variantConfig.enableScanner ? "1" : "0";
  process.env.ANSWER_CARD_DATA_DIR = dataDir;
  process.env.ANSWER_CARD_CLIENT_DIST = clientDist;
  process.env.PROJECTX_DB_PATH = path.join(userDataDir, "data", "projectx.db");

  const serverModule = await import(pathToFileURL(serverBundle).href);
  const preferredPort = Number(process.env.PROJECTX_ELECTRON_PORT || 5174);
  try {
    server = await serverModule.startServer(preferredPort);
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      console.warn(`[Electron] Port ${preferredPort} is already in use; falling back to a random port.`);
      server = await serverModule.startServer(0);
    } else {
      throw error;
    }
  }
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("Cannot determine local server port.");
  }
  return `http://127.0.0.1:${address.port}`;
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
    title: variantConfig.productName,
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
