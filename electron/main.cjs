const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// ── v1.6.1: Electron now only packages the scanner build.
// Teacher/student features are deployed via the web build (dist/web/).
// Single variant: scanner-only, always enabled.

// ── 单实例锁：扫描机常会重复双击启动。第二个实例直接退出并聚焦已有窗口，
// 避免 5174 被占回退随机端口、同一 userData 上跑两个内嵌服务（实测日志 EADDRINUSE + auth/me 401）。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let server;
let mainWindow;

const PRODUCT_NAME = "Project-X 答题卡扫描端";

function getAppRoot() {
  return app.getAppPath();
}

function getLogFilePath() {
  try {
    return path.join(app.getPath("userData"), "logs", "main.log");
  } catch {
    return path.join(app.getPath("appData"), "answer-card-designer", "logs", "main.log");
  }
}

// 黑匣子日志轮转：超过 MAX_LOG_BYTES 时滚动 main.log -> main.log.1 -> main.log.2，
// 最多保留 3 份（含当前），避免学校扫描机常开导致日志无限增长。
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_GENERATIONS = 2;

function rotateLogIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_LOG_BYTES) return;
    for (let i = LOG_KEEP_GENERATIONS - 1; i >= 0; i--) {
      const from = i === 0 ? file : `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      try {
        fs.rmSync(to, { force: true });
      } catch { /* ignore */ }
      try {
        if (i === 0) fs.renameSync(from, to);
        else if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch { /* ignore */ }
    }
  } catch {
    /* 首次写入无文件，无需轮转 */
  }
}

function appendLog(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    const file = getLogFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateLogIfNeeded(file);
    fs.appendFileSync(file, line, "utf8");
  } catch {
    /* 日志落盘失败不影响主流程 */
  }
  if (level === "ERROR") console.error(line.trim());
  else if (level === "WARN") console.warn(line.trim());
  else console.log(line.trim());
}

function setupMainProcessLogging() {
  const logFile = getLogFilePath();
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `\n===== ${PRODUCT_NAME} start ${new Date().toISOString()} arch=${process.arch} electron=${process.versions.electron} =====\n`, "utf8");
  } catch {
    /* ignore */
  }
  process.on("uncaughtException", (error) => {
    appendLog("ERROR", `[Main] uncaughtException: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    appendLog("ERROR", `[Main] unhandledRejection: ${msg}`);
  });
}

function configureAppIdentity() {
  app.setName(PRODUCT_NAME);
  const userDataDir = path.join(app.getPath("appData"), "answer-card-designer");
  app.setPath("userData", userDataDir);
  setupMainProcessLogging();
  appendLog("INFO", `[Electron] userData=${userDataDir} arch=${process.arch}`);
  // 打包后快捷方式启动时 CWD 是 C:\Windows\System32，服务端仍有按 cwd 解析的
  // 相对路径（config.yml、cleanup 兜底等），统一切到可写目录，避免 EPERM。
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    process.chdir(userDataDir);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Electron] Failed to switch CWD to userData: ${msg}`);
    appendLog("WARN", `[Electron] Failed to switch CWD to userData: ${msg}`);
  }
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
        const msg = `Port ${preferredPort} is unavailable (${error.code}); falling back to a random port.`;
        console.warn(`[Electron] ${msg}`);
        appendLog("WARN", `[Electron] ${msg}`);
        server = await serverModule.startServer(0);
      } else {
        throw error;
      }
    }
  } catch (importError) {
    const msg = importError instanceof Error ? importError.message : String(importError);
    console.error(`[Electron] Failed to load server bundle: ${msg}`);
    appendLog("ERROR", `[Electron] Failed to load server bundle: ${msg}`);
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

  // 安全审计（F-5）：新窗口仅放行同源；其余 URL 仅允许 https:// 经系统浏览器打开，
  // 拒绝 file://、smb:// 及自定义协议，防止远端页面被攻破后诱导打开本机文件/协议处理器。
  // 同源判定使用解析后 URL 的 origin（protocol+host+port）精确比较，不能用字符串前缀，
  // 否则 https://example.com.attacker.test 会被 https://example.com 的前缀检查放行（P2 缺陷）。
  const ALLOWED_EXTERNAL_SCHEMES = new Set(["https:"]);
  let baseOrigin = null;
  try {
    baseOrigin = new URL(baseUrl).origin;
  } catch {
    /* baseUrl 非法时 loadURL 本身会失败，这里保持全部拒绝 */
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (baseOrigin && parsed.origin === baseOrigin) {
        return { action: "allow" };
      }
      if (ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
        shell.openExternal(url);
      }
    } catch {
      /* 非法 URL，忽略 */
    }
    return { action: "deny" };
  });

  // ── 黑匣子诊断：渲染进程日志落盘 ──
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const lvl = level === 0 ? "INFO" : level === 1 ? "WARN" : "ERROR";
    appendLog(lvl, `[Renderer][console] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appendLog("ERROR", `[Renderer] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    appendLog("ERROR", `[Renderer] did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    const msg = error instanceof Error ? error.stack || error.message : String(error);
    appendLog("ERROR", `[Renderer] preload-error path=${preloadPath} error=${msg}`);
  });
  mainWindow.webContents.on("unresponsive", () => {
    appendLog("ERROR", "[Renderer] unresponsive");
  });
  mainWindow.webContents.on("responsive", () => {
    appendLog("INFO", "[Renderer] responsive (recovered)");
  });

  appendLog("INFO", `[Electron] loadURL ${baseUrl}`);
  await mainWindow.loadURL(baseUrl);
  appendLog("INFO", `[Electron] loadURL done status=${mainWindow.webContents.getURL()}`);
}

configureAppIdentity();

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    appendLog("ERROR", `[Electron] createWindow failed: ${error instanceof Error ? error.stack || msg : msg}`);
    dialog.showErrorBox("启动失败", msg);
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
