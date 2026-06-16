const { spawnSync } = require("node:child_process");

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
const rebuild = spawnSync(npmCommand, ["run", "native:rebuild:node"], {
  stdio: "inherit",
  shell: false
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
