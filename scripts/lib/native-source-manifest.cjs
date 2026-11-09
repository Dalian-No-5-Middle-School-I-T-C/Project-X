// 输入清单记录原生构建读取的文件。构建记录同时校验清单和最终二进制。
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");

const RECOGNIZER_SOURCE_DIR = "native/AnswerCardRecognizer/answer-card-recognizer";
const BRIDGE_SOURCE_DIR = "native/ScannerBridge/scanner-bridge";
const TWAIN_INCLUDE_DIR = "native/ScannerBridge/third_party/twain-dsm-2.5.1/include";
const CMAKE_ENTRY = "native/CMakeLists.txt";

/** 每条构建线的必选源码。新增源码文件会自动进必选集合，不需要再维护一份列表。 */
const LANES = {
  "win-ia32": {
    label: "Windows ia32 识别器",
    manifest: "resources/native/win-ia32/source-sha256.txt",
    toolchains: ["native/cmake/mingw-ia32.cmake"],
    buildScripts: ["scripts/build-native-mingw.sh"],
    binaries: ["answer-card-recognizer.exe", "scanner-bridge.exe"],
  },
  "win-x64": {
    label: "Windows x64 识别器",
    manifest: "resources/native/win-x64/source-sha256.txt",
    toolchains: ["native/cmake/mingw-x64.cmake"],
    buildScripts: ["scripts/build-native-mingw.sh"],
    binaries: ["answer-card-recognizer.exe", "scanner-bridge.exe"],
  },
  "correction-linux-x64": {
    label: "Linux x86_64 补识别器",
    manifest: "resources/native/correction-linux-x64/source-sha256.txt",
    toolchains: ["native/cmake/linux-x64.cmake"],
    buildScripts: ["scripts/build-recognizer-linux.sh"],
    binaries: ["answer-card-recognizer"],
  },
};

function requiredSources(rootDir, lane, failures) {
  const spec = LANES[lane];
  const inputs = new Set([
    CMAKE_ENTRY,
    "scripts/lib/native-build-record.sh",
    ...spec.toolchains,
    ...spec.buildScripts,
  ]);
  const sourceDirs = [RECOGNIZER_SOURCE_DIR];
  if (lane.startsWith("win-")) {
    sourceDirs.push(BRIDGE_SOURCE_DIR, TWAIN_INCLUDE_DIR);
    inputs.add(`${TWAIN_INCLUDE_DIR}/twain.h`);
  }
  for (const sourceDir of sourceDirs) {
    const directory = path.join(rootDir, sourceDir);
    const files = existsSync(directory)
      ? readdirSync(directory, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.(cpp|h|hpp)$/.test(entry.name))
      : [];
    if (files.length === 0) failures.push(`找不到 ${spec.label} 的构建输入：${sourceDir}`);
    for (const entry of files) {
      inputs.add(path.relative(rootDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    }
  }
  return [...inputs];
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyBuildRecord(rootDir, spec, sourceManifest) {
  const directory = path.dirname(sourceManifest);
  const record = path.join(directory, "binary.sha256");
  const label = path.relative(rootDir, record);
  if (!existsSync(record)) return [`找不到 ${spec.label} 的构建记录：${label}`];

  const files = new Map([
    ["source-sha256.txt", sourceManifest],
    ...spec.binaries.map((name) => [name, path.join(directory, name)]),
  ]);
  const failures = [];
  for (const line of readFileSync(record, "utf8").trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match || !files.has(match[2])) {
      failures.push(`${label} 包含无效或重复的记录：${line.slice(0, 80)}`);
      continue;
    }
    const [, expected, name] = match;
    const file = files.get(name);
    files.delete(name);
    if (!existsSync(file)) {
      failures.push(`找不到构建产物：${path.relative(rootDir, file)}`);
    } else if (sha256Bytes(readFileSync(file)) !== expected) {
      failures.push(`${name} 与 ${label} 的摘要不一致。请重编 ${spec.label} 并一起导入产物与清单。`);
    }
  }
  for (const name of files.keys()) failures.push(`${label} 缺少 ${name} 的摘要。`);
  return failures;
}

/**
 * 按原始字节核对一份清单，并检查必选覆盖。
 *
 * 返回 `{ entries, failures, missing, unparsable, crlfCheckout }`：
 *  - `failures` 是要让调用方直接判失败的意见（含「清单为空」和「缺必选源码」）；
 *  - `crlfCheckout` 单独返回，因为「这份工作副本是 CRLF 检出」不是源码变更，
 *    两条线要给的结论不同（打包脚本要拒绝并说明换 LF 检出，来源核对也是），
 *    由调用方决定文案，避免这里替两边各写一套。
 */
function verifyNativeSourceManifest({ rootDir, lane, manifestPath }) {
  const spec = LANES[lane];
  if (!spec) throw new Error(`未知的原生件构建线：${lane}`);
  const file = manifestPath || path.join(rootDir, ...spec.manifest.split("/"));
  const failures = [];
  const crlfCheckout = [];
  const entries = new Map();
  const required = requiredSources(rootDir, lane, failures);
  if (!existsSync(file)) {
    failures.push(`找不到 ${spec.label} 的源码摘要清单：${path.relative(rootDir, file).split(path.sep).join("/")}`);
    return { entries, failures, missing: required, unparsable: [], crlfCheckout };
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    failures.push(`${spec.label} 的源码摘要清单是空的：没有任何源码与随包二进制绑定，门禁等于没开。`);
  }
  const unparsable = [];
  for (const line of lines) {
    // 允许 scripts/** ——构建脚本同样决定产出的二进制，漏掉它就是「少查一项」。
    const match = /^([a-f0-9]{64})  ((?:native|scripts)\/[A-Za-z0-9_./-]+)$/.exec(line);
    if (!match) {
      unparsable.push(line.slice(0, 80));
      failures.push(`清单里有无法解析的行：${line.slice(0, 80)}`);
      continue;
    }
    const [, expected, relative] = match;
    const target = path.join(rootDir, ...relative.split("/"));
    if (!existsSync(target)) {
      failures.push(`清单列出的文件已不存在：${relative}（源码被移动或删除，包内件对应不到当前仓库）`);
      continue;
    }
    const bytes = readFileSync(target);
    if (sha256Bytes(bytes) === expected) {
      entries.set(relative, expected);
      continue;
    }
    const lf = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    if (sha256Bytes(lf) === expected) {
      crlfCheckout.push(relative);
      entries.set(relative, expected);
      continue;
    }
    failures.push(`${relative} 与清单摘要不一致：源码已改动而随包 ${spec.label} 没有重编。`);
    entries.set(relative, expected);
  }
  const missing = required.filter((relative) => !entries.has(relative));
  if (missing.length > 0) {
    failures.push(`${spec.label} 的源码摘要清单缺 ${missing.length} 项必选覆盖：${missing.join("、")}。`
      + "清单没记的源码改动不会触发任何失败，等于允许随包二进制悄悄落后于审过的源码。");
  }
  failures.push(...verifyBuildRecord(rootDir, spec, file));
  return { entries, failures, missing, unparsable, crlfCheckout, manifest: spec.manifest, label: spec.label };
}

module.exports = { verifyNativeSourceManifest };
