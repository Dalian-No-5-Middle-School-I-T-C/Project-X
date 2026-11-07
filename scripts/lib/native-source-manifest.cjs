/**
 * 随包原生组件的源码摘要清单核对（三条构建线共用一份判据：win-ia32 / win-x64 / correction-linux-x64）。
 *
 * 要解决的问题：清单只是「记了哪些就查哪些」，于是把 `source-sha256.txt` 截断成空文件、
 * 或删掉其中几行，核对照样全绿——随包二进制相对当前源码已经旧了，门禁却看不见。
 * 这里把判据收成一个方向：**先算出这条构建线必须由哪些源码决定，再要求清单逐条覆盖**，
 * 缺覆盖就是失败，而不是「少写少查」。
 *
 * 用法（ESM 侧用 createRequire，与 scripts/verify-scanner-recovery.ts 取 .cjs 同一套路）：
 *   const { verifyNativeSourceManifest } = require("./lib/native-source-manifest.cjs");
 *   const result = verifyNativeSourceManifest({ rootDir, lane: "win-ia32" });
 *
 * `lane` 决定必选源码集合：识别器源码目录下的全部 .cpp/.hpp、该线的 CMake 入口与
 * toolchain、以及那条线自己的构建脚本（脚本改了同样会改变产出的二进制）。
 *
 * 两处真相要留意：这里的必选集合，与 `scripts/build-native-mingw.sh`、
 * `scripts/build-recognizer-linux.sh` 里那条 `sha256sum` 生成的文件列表必须保持同步。
 * 构建脚本不能引这个库（它们要在只有 cmake/coreutils 的 Linux 构建机上跑），所以清单少写一项时
 * 这里报的是「缺必选覆盖」——看到这条先去看构建脚本的 `sha256sum` 调用，别只往清单里手工补一行
 * （手工补的那行下一次重编会被脚本自己冲掉）。清单也没有注释语法：加 `#` 表头会被判「无法解析的行」。
 */
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");

const RECOGNIZER_SOURCE_DIR = "native/AnswerCardRecognizer/answer-card-recognizer";
const CMAKE_ENTRY = "native/CMakeLists.txt";

/** 每条构建线的必选源码。新增源码文件会自动进必选集合，不需要再维护一份列表。 */
const LANES = {
  "win-ia32": {
    label: "Windows ia32 识别器",
    manifest: "resources/native/win-ia32/source-sha256.txt",
    toolchains: ["native/cmake/mingw-ia32.cmake"],
    buildScripts: ["scripts/build-native-mingw.sh"],
  },
  "win-x64": {
    label: "Windows x64 识别器",
    manifest: "resources/native/win-x64/source-sha256.txt",
    toolchains: ["native/cmake/mingw-x64.cmake"],
    buildScripts: ["scripts/build-native-mingw.sh"],
  },
  "correction-linux-x64": {
    label: "Linux x86_64 补识别器",
    manifest: "resources/native/correction-linux-x64/source-sha256.txt",
    toolchains: ["native/cmake/linux-x64.cmake"],
    buildScripts: ["scripts/build-recognizer-linux.sh"],
  },
};

function joinPosix(...parts) {
  return parts.filter(Boolean).join("/");
}

/** 识别器源码目录里当前存在的 .cpp/.hpp（相对仓库根，正斜杠）。 */
function recognizerSources(rootDir) {
  const dir = path.join(rootDir, ...RECOGNIZER_SOURCE_DIR.split("/"));
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(cpp|hpp)$/.test(entry.name))
    .map((entry) => joinPosix(RECOGNIZER_SOURCE_DIR, entry.name))
    .sort();
}

function requiredSources(rootDir, lane) {
  const spec = LANES[lane];
  if (!spec) throw new Error(`未知的原生件构建线：${lane}`);
  return [...recognizerSources(rootDir), CMAKE_ENTRY, ...spec.toolchains, ...spec.buildScripts];
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
  if (!existsSync(file)) {
    failures.push(`找不到 ${spec.label} 的源码摘要清单：${path.relative(rootDir, file).split(path.sep).join("/")}`);
    return { entries, failures, missing: requiredSources(rootDir, lane), unparsable: [], crlfCheckout };
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
  const missing = requiredSources(rootDir, lane).filter((relative) => !entries.has(relative));
  if (missing.length > 0) {
    failures.push(`${spec.label} 的源码摘要清单缺 ${missing.length} 项必选覆盖：${missing.join("、")}。`
      + "清单没记的源码改动不会触发任何失败，等于允许随包二进制悄悄落后于审过的源码。");
  }
  return { entries, failures, missing, unparsable, crlfCheckout, manifest: spec.manifest, label: spec.label };
}

module.exports = {
  LANES,
  RECOGNIZER_SOURCE_DIR,
  recognizerSources,
  requiredSources,
  sha256Bytes,
  verifyNativeSourceManifest,
};
