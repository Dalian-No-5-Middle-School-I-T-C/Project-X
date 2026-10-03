#!/usr/bin/env node
/**
 * 把 Microsoft Visual C++ 可再发行运行库（CRT）以 app-local 方式部署到
 * resources/native/<arch>/，使 answer-card-recognizer.exe 与 opencv_world4130.dll
 * （二者均为 /MD 动态 CRT）在未安装 VC++ 可再发行包的扫描机上也能启动。
 *
 * 为什么必须随包分发：
 *   - scanner-bridge.exe / TWAINDSM.dll 是 /MT 静态 CRT，自包含；
 *   - answer-card-recognizer.exe 与 opencv_world4130.dll 是 /MD，导入表中含
 *     msvcp140.dll / vcruntime140(_1).dll / concrt140.dll。缺失时进程以
 *     0xC0000135 (STATUS_DLL_NOT_FOUND) 立即退出，表现为「检测扫描仪正常，
 *     一按开始扫描每一页识别全灭」。
 *
 * 用法：
 *   node scripts/stage-vc-runtime.cjs            # 同时部署 x64 与 ia32
 *   node scripts/stage-vc-runtime.cjs ia32       # 只部署 ia32
 *   node scripts/stage-vc-runtime.cjs ia32 --source="D:\path\to\Microsoft.VC145.CRT"
 *
 * UCRT 说明（2026-09-28 修正）：
 *   原注释假设「UCRT 自 Windows 10 起属 OS 组件，无需 app-local 部署」。实测在
 *   老旧的 ia32 扫描工作站上，识别器以 0xC0000142（STATUS_DLL_INIT_FAILED）退出——
 *   即 api-ms-win-crt-* 系列在目标机解析不到（系统过旧 / 运行库被精简）。
 *   为保证「拷过去就能跑」，现在把 api-ms-win-crt-*.dll 与 ucrtbase.dll 一并随包分发。
 *   UCRT 在 Windows 10 SDK 里有两种可再发行布局，两者都要探测：
 *     新版 <Kits>\10\Redist\<SDK版本>\ucrt\DLLs\<arch>
 *     旧版 <Kits>\10\Redist\ucrt\DLLs\<arch>
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

/** 每个架构实际需要的 DLL 前辍（按工具集给出的完整 CRT 集合部署，避免传递依赖漏项）。 */
const REQUIRED_PREFIXES = ["msvcp140", "vcruntime140", "concrt140"];

/** UCRT：api-ms-win-crt-*.dll 与 ucrtbase.dll，老目标机上必须 app-local。 */
const UCRT_FILE_PATTERN = /^api-ms-win-crt-.*\.dll$/i;
const UCRT_BASE = "ucrtbase.dll";

/** vccorlib140.dll 仅用于 WinRT/C++ 组件扩展，原生 exe 不依赖，部署会白占体积。 */
const EXCLUDED = new Set(["vccorlib140.dll"]);

const ARCH_TARGETS = {
  x64: "win-x64",
  ia32: "win-ia32"
};
const PE_MACHINES = { x64: 0x8664, ia32: 0x014c };

function log(message) {
  process.stdout.write(`[stage-vc-runtime] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[stage-vc-runtime] ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const arches = [];
  let source = null;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "用法: node scripts/stage-vc-runtime.cjs [x64] [ia32] [--source=<CRT 目录>（需指定单一架构）]\n"
      );
      process.exit(0);
    }
    const match = /^--source=(.+)$/.exec(arg);
    if (match) {
      source = match[1].replace(/^"|"$/g, "");
      continue;
    }
    if (arg in ARCH_TARGETS) {
      arches.push(arg);
      continue;
    }
    fail(`无法识别的参数: ${arg}（可用: x64 | ia32 | --source=<目录>）`);
  }
  if (source && arches.length !== 1) {
    fail("使用 --source 时必须且只能指定一个架构（x64 或 ia32）");
  }
  return { arches: arches.length > 0 ? arches : ["x64", "ia32"], source };
}

function vsInstallRoots() {
  const roots = [];
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (fs.existsSync(vswhere)) {
    try {
      const out = execFileSync(vswhere, ["-products", "*", "-property", "installationPath"], {
        encoding: "utf8",
        windowsHide: true
      });
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) roots.push(trimmed);
      }
    } catch {
      /* vswhere 失败时继续走回退路径 */
    }
  }
  if (process.env.VC_REDIST_VS_ROOT) roots.push(process.env.VC_REDIST_VS_ROOT);
  for (const drive of ["C", "D", "E"]) {
    for (const layout of [
      `${drive}:\\Program Files\\Microsoft Visual Studio\\2022`,
      `${drive}:\\Program Files (x86)\\Microsoft Visual Studio\\2022`,
      `${drive}:\\apps\\vs-s-c`,
      `${drive}:\\VisualStudio`
    ]) {
      roots.push(layout);
    }
  }
  return [...new Set(roots)].filter((root) => fs.existsSync(root));
}

/** 在候选 VS 安装中挑出「MSVC 版本号最高」且含指定架构 CRT 的目录。 */
function findCrtDir(arch, explicitSource) {
  if (explicitSource) {
    if (!fs.existsSync(explicitSource)) fail(`--source 指定的目录不存在: ${explicitSource}`);
    return explicitSource;
  }

  // VC\Redist\MSVC\<版本>\<x64|x86>\Microsoft.VC<NNN>.CRT
  const redistArch = arch === "x64" ? "x64" : "x86";
  const candidates = [];
  for (const root of vsInstallRoots()) {
    const redistRoot = path.join(root, "VC", "Redist", "MSVC");
    if (!fs.existsSync(redistRoot)) continue;
    for (const version of safeReaddir(redistRoot)) {
      if (!version.isDirectory()) continue;
      const archDir = path.join(redistRoot, version.name, redistArch);
      if (!fs.existsSync(archDir)) continue;
      for (const crt of safeReaddir(archDir)) {
        if (!crt.isDirectory() || !/^Microsoft\.VC\d+\.CRT$/i.test(crt.name)) continue;
        candidates.push({ version: version.name, dir: path.join(archDir, crt.name) });
      }
    }
  }
  if (candidates.length === 0) return null;

  // 同一台机器可能并存多个工具集（v143/v144/v145），取版本号最高者，
  // 保证 app-local 运行库不低于链接期所用 CRT 版本。
  candidates.sort((a, b) => compareVersionStrings(b.version, a.version));
  return candidates[0].dir;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function compareVersionStrings(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function isRequired(name) {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".dll")) return false;
  if (EXCLUDED.has(lower)) return false;
  return REQUIRED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** 仅读取 PE 头中的 Machine 字段，在任何复制发生前排除错位数 DLL。 */
function peMachine(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") return null;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return null;
  return bytes.readUInt16LE(peOffset + 4);
}

/** 拷贝时先比大小与内容，内容一致就跳过，避免每次打包都刷新 mtime 触发无谓 diff。 */
function copyIfChanged(from, to) {
  const fromBuf = fs.readFileSync(from);
  if (fs.existsSync(to)) {
    const toBuf = fs.readFileSync(to);
    if (toBuf.length === fromBuf.length && toBuf.equals(fromBuf)) return false;
  }
  fs.writeFileSync(to, fromBuf);
  return true;
}

/**
 * 定位 UCRT 可再发行目录。SDK 里存在两种布局，必须都探测：
 *   新版（当前 SDK，如 10.0.26100.0）：<Kits>\10\Redist\<SDK版本>\ucrt\DLLs\<x64|x86>
 *   旧版（早期 Windows 10 SDK）　　　　：<Kits>\10\Redist\ucrt\DLLs\<x64|x86>
 *
 * 原实现把 `Redist\ucrt\DLLs` 的第一层子项当成 SDK 版本目录，在其后再追加一次架构，
 * 于是实际查找 `Redist\ucrt\DLLs\x86\x86`、`...\x64\x64` 这类不存在的目录，
 * 评审用标准目录结构模拟即返回 null，只能回退系统目录——而 System32 里只有
 * ucrtbase.dll，没有 api-ms-win-crt-* 转发桩，恰好是老目标机 0xC0000142 的成因。
 *
 * 候选目录还要通过 {@link ucrtMissingFiles} 的完整性校验才可采用，避免把裁剪过的
 * 目录当成可用源。
 *
 * @param {string} arch "x64" | "ia32"
 * @param {string} [explicitSource] --source 指定的 CRT 目录
 * @param {string[]} [kitsBases] Program Files 根列表，测试时注入临时目录
 */
function findUcrtDir(arch, explicitSource, kitsBases) {
  const redistArch = arch === "x64" ? "x64" : "x86";
  const candidates = [];
  if (explicitSource) {
    // --source 显式指向 CRT 目录时，尝试同级的 ..\..\ucrt\DLLs\<arch>
    candidates.push(path.resolve(explicitSource, "..", "..", "ucrt", "DLLs", redistArch));
  }

  const bases = kitsBases || [
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env.ProgramFiles || "C:\\Program Files"
  ];
  for (const base of bases) {
    const redistRoot = path.join(base, "Windows Kits", "10", "Redist");
    // 新布局：Redist\<SDK版本>\ucrt\DLLs\<arch>，版本号高者优先（与所链 MSVC 运行库同期）
    const versioned = safeReaddir(redistRoot)
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versioned) {
      candidates.push(path.join(redistRoot, version, "ucrt", "DLLs", redistArch));
    }
    // 旧布局：Redist\ucrt\DLLs\<arch>
    candidates.push(path.join(redistRoot, "ucrt", "DLLs", redistArch));
  }

  const found = candidates.find(isCompleteUcrtDir);
  if (found) return found;

  // 回退：直接取本机系统目录中的 UCRT（注意 SysWOW64 才是 32 位）。
  // 这一层只保证 ucrtbase.dll，转发桩通常缺全，因此显式告警而不是静默。
  const sysDir = arch === "ia32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "SysWOW64")
    : path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  if (fs.existsSync(path.join(sysDir, UCRT_BASE))) {
    log(`${arch}: 警告——SDK 未提供完整 UCRT 可再发行目录，回退 ${sysDir}`);
    return sysDir;
  }
  return null;
}

/**
 * UCRT 一套完整可再发行集合：ucrtbase.dll + 15 个 api-ms-win-crt-* 转发桩。
 * 名单在旧 `Redist\ucrt\DLLs` 与新 `Redist\<版本>\ucrt\DLLs` 两种布局下实测一致。
 */
const UCRT_STUB_NAMES = [
  "api-ms-win-crt-conio-l1-1-0.dll",
  "api-ms-win-crt-convert-l1-1-0.dll",
  "api-ms-win-crt-environment-l1-1-0.dll",
  "api-ms-win-crt-filesystem-l1-1-0.dll",
  "api-ms-win-crt-heap-l1-1-0.dll",
  "api-ms-win-crt-locale-l1-1-0.dll",
  "api-ms-win-crt-math-l1-1-0.dll",
  "api-ms-win-crt-multibyte-l1-1-0.dll",
  "api-ms-win-crt-private-l1-1-0.dll",
  "api-ms-win-crt-process-l1-1-0.dll",
  "api-ms-win-crt-runtime-l1-1-0.dll",
  "api-ms-win-crt-stdio-l1-1-0.dll",
  "api-ms-win-crt-string-l1-1-0.dll",
  "api-ms-win-crt-time-l1-1-0.dll",
  "api-ms-win-crt-utility-l1-1-0.dll"
];

/** 返回该目录缺少的 UCRT 文件名；空数组即「完整可用」。 */
function ucrtMissingFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [UCRT_BASE, ...UCRT_STUB_NAMES];
  const present = new Set(
    safeReaddir(dir).filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase())
  );
  return [UCRT_BASE, ...UCRT_STUB_NAMES].filter((name) => !present.has(name));
}

function isCompleteUcrtDir(dir) {
  return ucrtMissingFiles(dir).length === 0;
}

function isUcrtFile(name) {
  const lower = name.toLowerCase();
  return lower === UCRT_BASE || UCRT_FILE_PATTERN.test(lower);
}

function stageArch(arch, explicitSource) {
  const destDir = path.join(ROOT, "resources", "native", ARCH_TARGETS[arch]);
  if (!fs.existsSync(destDir)) fail(`目标目录不存在: ${destDir}`);

  const crtDir = findCrtDir(arch, explicitSource);
  if (!crtDir) {
    fail(
      `未找到 ${arch} 版 VC++ 运行库（Microsoft.VC*.CRT）。\n` +
        "  请安装带 C++ 工作负载的 Visual Studio（含 MSVC 可再发行文件），\n" +
        "  或用 --source=\"<含 msvcp140.dll 的目录>\" 显式指定。"
    );
  }

  const files = safeReaddir(crtDir).filter((entry) => entry.isFile() && isRequired(entry.name));
  // 每个架构都必须拿到这三项核心 DLL，缺任意一项都说明找错了目录
  const names = new Set(files.map((f) => f.name.toLowerCase()));
  for (const core of ["msvcp140.dll", "vcruntime140.dll", "concrt140.dll"]) {
    if (!names.has(core)) fail(`${crtDir} 缺少 ${core}，不是有效的 CRT 可再发行目录`);
  }
  for (const entry of files) {
    const machine = peMachine(path.join(crtDir, entry.name));
    if (machine !== PE_MACHINES[arch]) {
      fail(`${crtDir} 中的 ${entry.name} 不是 ${arch} 版 PE DLL（Machine=${machine === null ? "无效" : `0x${machine.toString(16)}`}）`);
    }
  }

  // UCRT：老目标机必需，缺失会导致 0xC0000142（STATUS_DLL_INIT_FAILED）
  const ucrtDir = findUcrtDir(arch, explicitSource);
  const ucrtFiles = ucrtDir
    ? safeReaddir(ucrtDir).filter((entry) => entry.isFile() && isUcrtFile(entry.name))
    : [];
  if (ucrtFiles.length === 0) {
    log(`${arch}: 警告——未找到 UCRT 源目录（api-ms-win-crt-*.dll / ucrtbase.dll），老目标机可能启动失败`);
  } else {
    // 系统目录回退只有 ucrtbase.dll，转发桩缺全等同于没补，必须点名告警
    const missing = ucrtMissingFiles(ucrtDir);
    if (missing.length > 0) {
      log(`${arch}: 警告——UCRT 源 ${ucrtDir} 不完整，缺 ${missing.join(", ")}；`
        + "干净的老目标机仍会 0xC0000142，请安装带 C++ 工作负载的 Visual Studio 或 Windows 10 SDK");
    }
  }

  log(`${arch}: MSVC 源 ${crtDir}`);
  if (ucrtDir) log(`${arch}: UCRT 源 ${ucrtDir}`);

  let copied = 0;
  const staged = [];
  for (const entry of [...files, ...ucrtFiles]) {
    const sourceDir = isUcrtFile(entry.name) ? ucrtDir : crtDir;
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (!fs.existsSync(from)) continue;
    if (copyIfChanged(from, to)) copied += 1;
    staged.push(`${entry.name}(${(fs.statSync(to).size / 1024).toFixed(0)}KB)`);
  }
  log(`${arch}: ${staged.length} 个运行库已就位（新写入 ${copied}）→ ${path.relative(ROOT, destDir)}`);
  log(`  ${staged.join(", ")}`);
}

function main() {
  const { arches, source } = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32") {
    fail("本脚本仅用于 Windows 打包（运行库来源为 MSVC 可再发行目录）");
  }
  for (const arch of arches) {
    stageArch(arch, source);
  }
  log("完成：识别器/OpenCV 的 /MD 运行库依赖已随包分发，目标机无需安装 VC++ 可再发行包。");
}

// 直接执行为打包步骤；被 require 时只暴露纯函数供回归脚本单测（见 scripts/verify-stage-vc-runtime.ts）。
if (require.main === module) {
  main();
}

module.exports = { findUcrtDir, isCompleteUcrtDir, ucrtMissingFiles, UCRT_STUB_NAMES, UCRT_BASE };
