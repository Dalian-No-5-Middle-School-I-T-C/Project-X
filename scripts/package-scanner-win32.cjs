#!/usr/bin/env node
// macOS/Linux -> Windows ia32, using MinGW executables and official Node prebuilds.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { build, Platform, Arch } = require("electron-builder");
const { createRuntimePackageJson } = require("./package-server-ubuntu.cjs");

const root = path.resolve(__dirname, "..");
const appDir = path.join(root, "ignored", "scanner-package");
const nativeDir = path.join(root, "ignored", "native-mingw", "stage", "win-ia32");
const nativeComponents = ["answer-card-recognizer.exe", "scanner-bridge.exe", "TWAINDSM.dll"];
const downloads = path.join(root, "ignored", "native-mingw", "downloads");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const versionOf = (name) => lock.packages[`node_modules/${name}`].version;
const electronVersion = versionOf("electron");
const sqliteVersion = versionOf("better-sqlite3");
const sharpVersion = versionOf("sharp");
const abi = require("node-abi").getAbi(electronVersion, "electron");
const prepared = process.argv.includes("--prepared");
const target = process.argv.includes("--portable") ? "portable" : "msi";
const verifyMsi = process.argv.includes("--verify-msi");
const prepareMsi = process.argv.includes("--prepare-msi");
if (process.argv.slice(2).some((a) => !["--prepared", "--portable", "--verify-msi", "--prepare-msi"].includes(a)) || (verifyMsi && (prepared || prepareMsi || target === "portable")) || (prepareMsi && target === "portable")) throw new Error("Usage: node scripts/package-scanner-win32.cjs [--prepared] [--portable | --prepare-msi] | --verify-msi");
process.env.ELECTRON_CACHE = path.join(root, ".electron-cache");
process.env.ELECTRON_BUILDER_CACHE = path.join(root, ".electron-builder-cache");
const env = { ...process.env, npm_config_cache: path.join(root, ".npm-cache") };

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}
function pe32(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error(`Not PE: ${file}`);
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 26 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x14c || bytes.readUInt16LE(offset + 24) !== 0x10b) {
    throw new Error(`Expected Windows ia32 PE32: ${file}`);
  }
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? walk(f) : e.isFile() ? [f] : [];
  });
}
async function verifyInstaller(artifact) {
  const { getPath7za } = require("app-builder-lib/out/toolsets/7zip");
  const sevenZip = await getPath7za();
  const checkDir = fs.mkdtempSync(path.join(root, "ignored", "scanner-installer-check-"));
  const extract = (file, dest) => execFileSync(sevenZip, ["x", "-y", "-bd", `-o${dest}`, file], { env, stdio: "pipe" });
  try {
    extract(artifact, checkDir);
    const payload = path.join(checkDir, "payload");
    if (target === "portable") {
      const archive = walk(checkDir).find((file) => path.basename(file) === "app-32.7z");
      if (!archive) throw new Error("Portable installer is missing app-32.7z");
      extract(archive, payload);
      for (const component of nativeComponents) {
        const file = path.join(payload, "resources", "native", "win-ia32", component);
        if (!fs.readFileSync(file).equals(fs.readFileSync(path.join(nativeDir, component)))) throw new Error(`Installer native component mismatch: ${component}`);
      }
    } else {
      const cabinets = walk(checkDir).filter((file) => /\.cab$/i.test(file));
      if (cabinets.length === 0) throw new Error("MSI is missing embedded cabinets");
      for (const [index, cabinet] of cabinets.entries()) extract(cabinet, path.join(payload, String(index)));
      const files = walk(payload);
      for (const component of nativeComponents) {
        const expected = fs.readFileSync(path.join(nativeDir, component));
        // MSI cabinets use generated file IDs rather than installation paths.
        if (!files.some((file) => fs.statSync(file).size === expected.length && fs.readFileSync(file).equals(expected))) throw new Error(`MSI is missing native component: ${component}`);
      }
    }
    console.log(`Installer payload verified: ${nativeComponents.join(", ")}`);
  } finally {
    fs.rmSync(checkDir, { recursive: true, force: true });
  }
}
function stripForeignPlatformPackages() {
  const modules = path.join(appDir, "node_modules");
  const allowed = (list, target) => !Array.isArray(list) || (!list.includes(`!${target}`) && (list.every((x) => x.startsWith("!")) || list.includes(target) || list.includes("any")));
  for (const entry of fs.readdirSync(modules)) {
    if (entry.startsWith(".")) continue;
    const base = path.join(modules, entry);
    const packageDirs = entry.startsWith("@") ? fs.readdirSync(base).map((name) => path.join(base, name)) : [base];
    for (const dir of packageDirs) {
      const metadata = path.join(dir, "package.json");
      if (!fs.existsSync(metadata)) continue;
      const dependency = JSON.parse(fs.readFileSync(metadata, "utf8"));
      if (!allowed(dependency.os, "win32") || !allowed(dependency.cpu, "ia32")) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const f of walk(modules)) if (/\.(exe|dll|node)$/i.test(f)) pe32(f);
}
function stageSqlitePrebuild() {
  fs.mkdirSync(downloads, { recursive: true });
  const name = `better-sqlite3-v${sqliteVersion}-electron-v${abi}-win32-ia32.tar.gz`;
  const archive = path.join(downloads, name);
  const release = JSON.parse(execFileSync("curl", ["-fsSL", "--retry", "3", `https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v${sqliteVersion}`], { env, encoding: "utf8" }));
  const asset = release.assets.find((a) => a.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) throw new Error(`Missing verified SQLite prebuild: ${name}`);
  if (!fs.existsSync(archive)) {
    run("curl", ["-fsSL", "--retry", "3", asset.browser_download_url, "-o", `${archive}.part`]);
    fs.renameSync(`${archive}.part`, archive);
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (`sha256:${digest}` !== asset.digest) throw new Error(`SQLite prebuild checksum mismatch: ${archive}`);
  run("tar", ["-xzf", archive, "-C", path.join(appDir, "node_modules", "better-sqlite3")]);
}
async function main() {
  if (verifyMsi) {
    await verifyInstaller(path.join(root, "release", `答题卡扫描端-${pkg.version}-ia32.msi`));
    run(process.execPath, ["scripts/hash-release-artifacts.cjs"]);
    run(process.execPath, ["scripts/hash-release-artifacts.cjs", "--check"]);
    return;
  }
  // Downloaded builder tools contain CommonJS .js scripts; isolate them from the repo's ESM scope.
  fs.mkdirSync(process.env.ELECTRON_BUILDER_CACHE, { recursive: true });
  fs.writeFileSync(path.join(process.env.ELECTRON_BUILDER_CACHE, "package.json"), JSON.stringify({ private: true, type: "commonjs" }) + "\n");
  if (!prepared) {
    run("bash", ["scripts/build-native-mingw.sh"]);
    run("npm", ["run", "build:scanner:full"]);
    fs.mkdirSync(appDir, { recursive: true });
    const appPkg = { name: pkg.name, version: pkg.version, description: pkg.description, author: pkg.author, private: true, type: pkg.type, main: pkg.main, dependencies: createRuntimePackageJson().dependencies };
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify(appPkg, null, 2) + "\n");
    const appLock = JSON.parse(JSON.stringify(lock));
    appLock.packages[""] = { name: appPkg.name, version: appPkg.version, dependencies: appPkg.dependencies };
    fs.writeFileSync(path.join(appDir, "package-lock.json"), JSON.stringify(appLock, null, 2) + "\n");
    run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--os=win32", "--cpu=ia32"], appDir);
    run("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--os=win32", "--cpu=ia32", "--force", `@img/sharp-win32-ia32@${sharpVersion}`], appDir);
  }
  stageSqlitePrebuild();
  stripForeignPlatformPackages();
  for (const component of nativeComponents) pe32(path.join(nativeDir, component));
  const imgDir = path.join(appDir, "node_modules", "@img");
  for (const name of ["sharp", "better-sqlite3"]) {
    if (JSON.parse(fs.readFileSync(path.join(appDir, "node_modules", name, "package.json"), "utf8")).version !== versionOf(name)) throw new Error(`Staged ${name} version mismatch`);
  }
  pe32(path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"));
  for (const f of walk(path.join(imgDir, "sharp-win32-ia32", "lib"))) if (/\.(dll|node)$/i.test(f)) pe32(f);
  fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
  for (const dir of ["scanner", "server"]) {
    fs.rmSync(path.join(appDir, "dist", dir), { recursive: true, force: true });
    fs.cpSync(path.join(root, "dist", dir), path.join(appDir, "dist", dir), { recursive: true });
  }
  fs.rmSync(path.join(appDir, "electron"), { recursive: true, force: true });
  fs.cpSync(path.join(root, "electron"), path.join(appDir, "electron"), { recursive: true });
  const manifestPath = path.join(appDir, "msi-project.wxs");
  const hookPath = path.join(appDir, "msi-project-hook.cjs");
  fs.writeFileSync(hookPath, `module.exports = (project) => { require("node:fs").copyFileSync(project, ${JSON.stringify(manifestPath)}); ${prepareMsi ? 'throw new Error("PROJECTX_MSI_PROJECT_PREPARED");' : ""} };\n`);
  const output = path.join(root, "release");
  const config = {
    appId: pkg.build.appId, productName: pkg.build.productName, electronVersion,
    electronDownload: { cache: process.env.ELECTRON_CACHE },
    directories: { app: appDir, output }, npmRebuild: false, asar: true,
    files: ["dist/scanner/**/*", "dist/server/**/*", "electron/**/*", "package.json"],
    extraResources: [
      { from: nativeDir, to: "native/win-ia32", filter: ["**/*"] },
      pkg.build.extraResources.find((resource) => resource.from === "llmclient")
    ],
    win: { ...pkg.build.win, icon: path.join(root, "resources", "icon.png"), target: [{ target, arch: ["ia32"] }] },
    msi: pkg.build.msi,
    msiProjectCreated: hookPath
  };
  // A config object is merged into package.json's build arrays, which would also include x64 resources.
  // An explicit config file selects only the resources prepared by this cross-build.
  const configPath = path.join(appDir, "builder-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  try {
    await build({ projectDir: root, targets: Platform.WINDOWS.createTarget([target], Arch.ia32), config: configPath, publish: "never" });
  } catch (error) {
    if (!prepareMsi || error.message !== "PROJECTX_MSI_PROJECT_PREPARED" || !fs.existsSync(manifestPath)) throw error;
  }
  const unpacked = path.join(output, "win-ia32-unpacked");
  for (const component of nativeComponents) {
    const packaged = path.join(unpacked, "resources", "native", "win-ia32", component);
    pe32(packaged);
    if (!fs.readFileSync(packaged).equals(fs.readFileSync(path.join(nativeDir, component)))) throw new Error(`Packaged native component mismatch: ${component}`);
  }
  for (const f of walk(unpacked)) if (/\.(exe|dll|node)$/i.test(f)) pe32(f);
  const asar = require("@electron/asar");
  const archive = path.join(unpacked, "resources", "app.asar");
  for (const entry of ["dist/scanner/index.html", "dist/server/index.mjs", "electron/main.cjs"]) asar.statFile(archive, entry);
  for (const entry of asar.listPackage(archive).filter((f) => /\.(dll|node)$/i.test(f))) {
    const relative = entry.replace(/^\//, "");
    if (!asar.statFile(archive, relative).unpacked) throw new Error(`Native dependency must be unpacked: ${entry}`);
    pe32(path.join(`${archive}.unpacked`, relative));
  }
  if (prepareMsi) {
    const { getBinFromUrl } = require("app-builder-lib/out/binDownload");
    await getBinFromUrl("wix-4.0.0.5512.2", "wix-4.0.0.5512.2.7z", "fe677fcd837b18c9b912985d91636bbd8a1e800c3b3a6a841b6f96e89624e839");
    console.log(`Windows ia32 application and MSI project prepared: ${manifestPath}\nCompile on Windows with scripts/build-scanner-msi.ps1, then run this script with --verify-msi.`);
    return;
  }
  const artifact = path.join(output, `答题卡扫描端-${pkg.version}-ia32.${target === "msi" ? "msi" : "exe"}`);
  const artifactBytes = fs.readFileSync(artifact);
  if (target === "portable") pe32(artifact);
  else if (!artifactBytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) throw new Error(`Not an MSI compound file: ${artifact}`);
  await verifyInstaller(artifact);
  const fingerprint = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  console.log(`Windows ia32 ${target} artifact: ${artifact}\nSHA256: ${fingerprint}`);
  run(process.execPath, ["scripts/hash-release-artifacts.cjs"]);
  run(process.execPath, ["scripts/hash-release-artifacts.cjs", "--check"]);
}
main().catch((error) => { console.error(error); process.exit(1); });
