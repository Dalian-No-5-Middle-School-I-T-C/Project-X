#!/usr/bin/env node
/**
 * 发布产物完整性清单（安全 R42）
 *
 * 背景：`build.win.signAndEditExecutable` 是 false，仓库里也没有代码签名证书，
 * 所以发出去的扫描端 exe / msi 是**未签名**的——用户既看不到发布者，也没有任何办法
 * 判断手上这份文件有没有被改过。「买证书签名」不是本轮能做的事（证书更不能入库），
 * 但「收到文件的人能自己验一遍」可以立刻做到：每次打包后生成 SHA256 清单，
 * 并把签名状态如实写进构建报告，未签名就说未签名。
 *
 * 用法：
 *   node scripts/hash-release-artifacts.cjs                 # 生成清单（打包脚本末尾自动调用）
 *   node scripts/hash-release-artifacts.cjs --check         # 校验既有清单，任何不符即退出码 1
 *   node scripts/hash-release-artifacts.cjs --root <dir>    # 换个目录（验证脚本用）
 *
 * 产出：
 *   release/SHA256SUMS.txt        sha256sum -c 兼容，LF，按路径排序
 *   release/BUILD-INTEGRITY.txt   人读版：版本、提交、签名状态、校验方法
 */

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));

const MANIFEST_NAME = "SHA256SUMS.txt";
const REPORT_NAME = "BUILD-INTEGRITY.txt";
/** 构建中间物与本次输出，不进清单。 */
const SKIP_NAMES = new Set([
  MANIFEST_NAME,
  REPORT_NAME,
  "builder-debug.yml",
  "builder-effective-config.yaml"
]);
/** 扫描这两个目录的第一层：release/ 是 Windows 产物，server-ubuntu24/ 是服务器包。 */
const SCAN_ROOTS = ["", "server-ubuntu24"];

function parseArgs(argv) {
  const args = { check: false, root: path.join(repoRoot, "release") };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--check") args.check = true;
    else if (token === "--root") args.root = path.resolve(argv[++i] ?? "");
    else if (token.startsWith("--root=")) args.root = path.resolve(token.slice("--root=".length));
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function listArtifacts(rootDir) {
  const found = [];
  for (const scanRoot of SCAN_ROOTS) {
    const dir = path.join(rootDir, scanRoot);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || SKIP_NAMES.has(entry.name)) continue;
      // 相对 rootDir 的路径，统一用正斜杠：清单要能被 sha256sum 与 --check 双方同样解读。
      found.push(path.posix.join(scanRoot, entry.name));
    }
  }
  return found.sort();
}

function sha256Of(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const revision = run(["rev-parse", "--short", "HEAD"]);
  const dirty = run(["status", "--porcelain"]) !== "";
  return { revision: revision || "unknown", dirty };
}

/**
 * Authenticode 签名状态。
 * 路径可能含中文（`答题卡扫描端.exe`），直接拼进 -Command 会被控制台代码页吃掉，
 * 所以把清单写成 UTF-8 文件让 PowerShell 自己读，结果同样落文件再取回。
 */
function signatureStatuses(files) {
  const statuses = new Map();
  if (process.platform !== "win32" || files.length === 0) return statuses;
  let dir;
  try {
    dir = mkdtempSync(path.join(tmpdir(), "projectx-signcheck-"));
    const listFile = path.join(dir, "files.txt");
    const outFile = path.join(dir, "result.txt");
    writeFileSync(listFile, `${files.join("\n")}\n`, "utf8");
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$targets = Get-Content -LiteralPath '${listFile}' -Encoding UTF8 | Where-Object { $_ -ne '' }`,
      "$lines = foreach ($t in $targets) {",
      "  $s = Get-AuthenticodeSignature -LiteralPath $t",
      "  $subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }",
      "  \"$t`t$($s.Status)`t$subject\"",
      "}",
      `Set-Content -LiteralPath '${outFile}' -Value $lines -Encoding UTF8`
    ].join("\n");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000
    });
    if (!existsSync(outFile)) return statuses;
    for (const line of readFileSync(outFile, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [target, status, subject] = line.split("\t");
      if (target) statuses.set(path.resolve(target), { status: status || "Unknown", subject: subject || "" });
    }
  } catch (error) {
    console.warn(`[release-integrity] 签名状态检测失败（不影响清单生成）: ${error.message}`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  return statuses;
}

function parseManifest(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) throw new Error(`Malformed line in ${MANIFEST_NAME}: ${line}`);
    entries.set(match[2].trim(), match[1].toLowerCase());
  }
  return entries;
}

function runCheck(rootDir) {
  const manifestPath = path.join(rootDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    console.error(`[release-integrity] 找不到 ${manifestPath}`);
    console.error("[release-integrity] 这份产物没有完整性清单，无法验证——请先在打包机上运行 npm run release:hash。");
    process.exitCode = 1;
    return;
  }
  const expected = parseManifest(readFileSync(manifestPath, "utf8"));
  const actual = new Map(listArtifacts(rootDir).map((rel) => [rel, sha256Of(path.join(rootDir, rel))]));

  let bad = 0;
  for (const [rel, digest] of actual) {
    const want = expected.get(rel);
    if (want === undefined) {
      bad++;
      console.error(`  ✗ 清单外多出的文件：${rel}`);
    } else if (want !== digest) {
      bad++;
      console.error(`  ✗ 校验和不符：${rel}`);
      console.error(`    清单：${want}`);
      console.error(`    实际：${digest}`);
    } else {
      console.log(`  ✓ ${rel}`);
    }
  }
  for (const rel of expected.keys()) {
    if (!actual.has(rel)) {
      bad++;
      console.error(`  ✗ 清单里有、目录里缺：${rel}`);
    }
  }

  if (bad > 0) {
    console.error(`[release-integrity] ${bad} 项不符：这份产物要么被改过，要么与清单不是同一次构建。`);
    console.error("[release-integrity] 不要使用，回到发布方重新取包与清单。");
    process.exitCode = 1;
    return;
  }
  console.log(`[release-integrity] ${actual.size} 个产物全部与清单一致。`);
  console.log("[release-integrity] 注意：一致只说明「与打包机产出时相同」，不代表已签名——签名状态见 BUILD-INTEGRITY.txt。");
}

function runWrite(rootDir) {
  if (!existsSync(rootDir)) {
    console.error(`[release-integrity] 目录不存在：${rootDir}`);
    console.error("[release-integrity] 先跑打包命令（npm run electron:dist / electron:msi / package:server:ubuntu24）。");
    process.exitCode = 1;
    return;
  }
  const artifacts = listArtifacts(rootDir);
  if (artifacts.length === 0) {
    console.error(`[release-integrity] ${rootDir} 下没有任何可发布产物，跳过清单生成。`);
    return;
  }

  const digests = new Map(artifacts.map((rel) => [rel, sha256Of(path.join(rootDir, rel))]));
  const statuses = signatureStatuses(artifacts.map((rel) => path.join(rootDir, rel)));
  const signable = artifacts.filter((rel) => /\.(exe|msi)$/i.test(rel));
  const signed = signable.filter((rel) => statuses.get(path.join(rootDir, rel))?.status === "Valid");
  const unsigned = signable.filter((rel) => !signed.includes(rel));

  // sha256sum -c 兼容：两个空格分隔，路径相对清单所在目录，LF 行尾。
  const manifest = artifacts.map((rel) => `${digests.get(rel)}  ${rel}`).join("\n") + "\n";
  writeFileSync(path.join(rootDir, MANIFEST_NAME), manifest, "utf8");

  const git = gitInfo();
  const now = new Date().toISOString();
  const lines = [
    "Project-X 发布产物完整性报告",
    "============================",
    "",
    `版本          : ${packageJson.version}`,
    `构建提交      : ${git.revision}${git.dirty ? "（工作区有未提交改动，产物无法对应到某个提交）" : ""}`,
    `生成时间      : ${now}`,
    `生成环境      : node ${process.version} / ${process.platform}-${process.arch}`,
    `产物目录      : ${rootDir}`,
    "",
    "校验和（SHA256）",
    "----------------",
    ...artifacts.map((rel) => {
      const size = statSync(path.join(rootDir, rel)).size;
      return `${digests.get(rel)}  ${rel}  (${size} 字节)`;
    }),
    "",
    "代码签名状态",
    "----------------"
  ];
  if (signable.length === 0) {
    lines.push("本次没有 exe / msi 产物。");
  } else if (statuses.size === 0) {
    lines.push(`无法检测（${process.platform === "win32" ? "PowerShell 调用失败" : "非 Windows 平台"}），签名状态未知。`);
  } else {
    for (const rel of signable) {
      const info = statuses.get(path.join(rootDir, rel));
      const status = info?.status ?? "Unknown";
      lines.push(`${rel}: ${status}${info?.subject ? ` — ${info.subject}` : ""}`);
    }
  }
  if (unsigned.length > 0) {
    lines.push(
      "",
      `未签名产物：${unsigned.length} / ${signable.length} 个。`,
      "原因：build.win.signAndEditExecutable=false，且仓库内不含代码签名证书（证书不得入库）。",
      "后果：Windows SmartScreen 会拦「未知发布者」，用户也无法用签名判断文件真伪。",
      "补偿手段：把本文件与 SHA256SUMS.txt 和安装包一起发布，收件方按下面的方法自行校验。",
      "启用签名的步骤见 README「Windows 扫描端安装包：未签名与完整性校验」。"
    );
  }
  lines.push(
    "",
    "收件方如何校验",
    "----------------",
    "方法一（无需本仓库，Windows 自带）：",
    `  certutil -hashfile "${signable[0] ?? artifacts[0]}" SHA256`,
    "  把输出的 64 位十六进制与 SHA256SUMS.txt 里同名文件那行比对，全等即未被改动。",
    "",
    "方法二（有本仓库时，一次校验全部产物）：",
    "  把 SHA256SUMS.txt 与产物放在同一目录，然后运行",
    "  node scripts/hash-release-artifacts.cjs --check --root <产物目录>",
    "  任何一项不符都会退出码 1 并点名文件。"
  );
  writeFileSync(path.join(rootDir, REPORT_NAME), `${lines.join("\n")}\n`, "utf8");

  console.log(`[release-integrity] ${artifacts.length} 个产物已写入 ${path.join(rootDir, MANIFEST_NAME)}`);
  console.log(`[release-integrity] 构建报告：${path.join(rootDir, REPORT_NAME)}`);
  if (unsigned.length > 0) {
    console.warn(`[release-integrity] 警告：${unsigned.length} 个可执行产物未签名（${unsigned.join("、")}）。`);
    console.warn("[release-integrity] 发布时必须连同 SHA256SUMS.txt 与本报告一起给出，否则收件方无法验证完整性。");
  }
  if ((process.env.CSC_LINK || process.env.WIN_CSC_LINK) && packageJson.build?.win?.signAndEditExecutable === false) {
    console.warn("[release-integrity] 警告：环境里给了 CSC_LINK，但 build.win.signAndEditExecutable=false，");
    console.warn("[release-integrity]       electron-builder 不会用它签名——产物仍然是未签名的。要签名请先把该开关打开。");
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) runCheck(args.root);
  else runWrite(args.root);
}

if (require.main === module) {
  main();
}

module.exports = { listArtifacts, parseManifest, sha256Of, MANIFEST_NAME, REPORT_NAME, SCAN_ROOTS };
