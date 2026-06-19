const { spawnSync } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const path = require("node:path");

function findPythonForNodeGyp() {
  if (process.env.NODE_GYP_FORCE_PYTHON) return process.env.NODE_GYP_FORCE_PYTHON;
  if (process.env.PYTHON && existsSync(process.env.PYTHON)) return process.env.PYTHON;
  if (process.platform === "win32") {
    const chromiumEnv = "C:\\ProgramData\\WorkBuddy\\chromium-env";
    if (existsSync(chromiumEnv)) {
      for (const sessionDir of readdirSync(chromiumEnv)) {
        const p = path.join(chromiumEnv, sessionDir, ".workbuddy", "binaries", "python", "versions");
        if (existsSync(p)) {
          for (const versionDir of readdirSync(p)) {
            const exe = path.join(p, versionDir, "python.exe");
            if (existsSync(exe)) return exe;
          }
        }
      }
    }
  }
  return undefined;
}

const nativeModules = ["better-sqlite3"];

function loadNativeModules() {
  const failures = [];
  for (const moduleName of nativeModules) {
    try {
      require(moduleName);
    } catch (error) {
      failures.push({ moduleName, error });
    }
  }
  return failures;
}

function formatFailure({ moduleName, error }) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  return `${moduleName}: ${message.split(/\r?\n/)[0]}`;
}

const failures = loadNativeModules();
if (failures.length === 0) {
  console.log("[native] better-sqlite3 is ready for this Node.js version.");
  process.exit(0);
}

console.warn("[native] Native module load failed; rebuilding for the current Node.js version.");
for (const failure of failures) {
  console.warn(`[native] ${formatFailure(failure)}`);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
// node-gyp needs Python to rebuild native modules — ensure it can be found
const pythonPath = findPythonForNodeGyp();
const rebuildEnv = { ...process.env };
if (pythonPath) {
  rebuildEnv.PYTHON = pythonPath;
  console.warn(`[native] Using Python: ${pythonPath}`);
}

const rebuild = spawnSync(npmCommand, ["run", "native:rebuild:node"], {
  stdio: "inherit",
  shell: false,
  env: rebuildEnv
});

if (rebuild.status !== 0) {
  process.exit(rebuild.status ?? 1);
}

const postRebuildFailures = loadNativeModules();
if (postRebuildFailures.length > 0) {
  console.error("[native] Rebuild completed, but native modules still cannot load:");
  for (const failure of postRebuildFailures) {
    console.error(`[native] ${formatFailure(failure)}`);
  }
  process.exit(1);
}

console.log("[native] Rebuild completed successfully.");
