const { spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const validArches = new Set(["ia32", "x64", "arm64"]);
const arches = process.argv.slice(2);
if (arches.length === 0 || arches.some((arch) => !validArches.has(arch))) {
  console.error("[sharp] Usage: node scripts/ensure-sharp-platform-binaries.cjs <ia32|x64|arm64> [...]");
  process.exit(1);
}

const sharpPackageJsonPath = path.join(__dirname, "..", "node_modules", "sharp", "package.json");
if (!existsSync(sharpPackageJsonPath)) {
  console.error("[sharp] node_modules/sharp is missing; run npm install first.");
  process.exit(1);
}
const sharpVersion = JSON.parse(readFileSync(sharpPackageJsonPath, "utf8")).version;
const imgDir = path.join(__dirname, "..", "node_modules", "@img");

function platformPackagesFor(arch) {
  return [`sharp-win32-${arch}`];
}

function missingPackages(arch) {
  return platformPackagesFor(arch).filter((name) => !existsSync(path.join(imgDir, name)));
}

function copyPlatformPackages(stagingNodeModules, arch) {
  const stagingImgDir = path.join(stagingNodeModules, "@img");
  if (!existsSync(stagingImgDir)) {
    console.error(`[sharp] Staging install produced no @img directory for win32-${arch}.`);
    process.exit(1);
  }
  mkdirSync(imgDir, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(stagingImgDir)) {
    if (!entry.endsWith(`win32-${arch}`)) continue;
    cpSync(path.join(stagingImgDir, entry), path.join(imgDir, entry), { recursive: true });
    copied += 1;
    console.log(`[sharp] Installed ${entry} (for sharp@${sharpVersion}) into node_modules/@img.`);
  }
  if (copied === 0) {
    console.error(`[sharp] Staging install contained no win32-${arch} packages.`);
    process.exit(1);
  }
}

for (const arch of arches) {
  const missing = missingPackages(arch);
  if (missing.length === 0) {
    console.log(`[sharp] win32-${arch} binaries for sharp@${sharpVersion} already present.`);
    continue;
  }
  console.log(`[sharp] Fetching win32-${arch} binaries for sharp@${sharpVersion}: ${missing.join(", ")}`);
  const stagingDir = path.join(os.tmpdir(), `sharp-platform-staging-win32-${arch}-${sharpVersion}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(
    path.join(stagingDir, "package.json"),
    JSON.stringify({ name: "sharp-platform-staging", version: "1.0.0", private: true }, null, 2)
  );
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--force", `@img/sharp-win32-${arch}@${sharpVersion}`],
    { cwd: stagingDir, stdio: "inherit", shell: process.platform === "win32" }
  );
  if (result.error) {
    console.error(`[sharp] Failed to spawn npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (result.status === null || result.status === undefined) {
      console.error("[sharp] npm install did not complete; see error above.");
    }
    rmSync(stagingDir, { recursive: true, force: true });
    process.exit(result.status ?? 1);
  }
  try {
    copyPlatformPackages(path.join(stagingDir, "node_modules"), arch);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
