/**
 * 发布产物完整性清单回归验证（安全审查第五批 C · R42）
 *
 * R42 的原判定：`build.win.signAndEditExecutable` 是 false，扫描端 exe/msi 未签名，
 * 收件方既看不到发布者也无法判断文件有没有被改过。没有证书就签不了名（证书更不能入库），
 * 所以本轮的处置是**可验证的完整性凭据**：每次打包生成 SHA256SUMS.txt + BUILD-INTEGRITY.txt，
 * 并如实写出「未签名」这件事，而不是让产物看起来像已经过了签名。
 *
 * 本脚本用一次性临时目录真跑生成与校验（含篡改、多出文件、缺清单三种失败路径），
 * 再静态核对打包命令的接线与文档口径。
 *
 * 用法：
 *   npx tsx scripts/verify-release-integrity.ts
 *
 * 期望输出：所有断言通过，退出码 0。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const hasher: {
  MANIFEST_NAME: string;
  REPORT_NAME: string;
  SCAN_ROOTS: string[];
  listArtifacts: (rootDir: string) => string[];
  parseManifest: (text: string) => Map<string, string>;
  sha256Of: (filePath: string) => string;
} = require("../scripts/hash-release-artifacts.cjs");

const hasherPath = path.resolve("scripts/hash-release-artifacts.cjs");
const hasherSource = readFileSync(hasherPath, "utf8");
const packageJson = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
  version: string;
  scripts: Record<string, string>;
  build?: { win?: { signAndEditExecutable?: boolean } };
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

function run(args: string[]): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, [hasherPath, ...args], { encoding: "utf8" });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const fixture = mkdtempSync(path.join(tmpdir(), "projectx-release-integrity-"));
try {
  // 产物名刻意用中文与真实命名一致：`答题卡扫描端-<version>-<arch>.exe`，
  // 清单里的路径与 PowerShell 签名检测都要能处理非 ASCII 文件名。
  const exeName = `答题卡扫描端-${packageJson.version}-x64.exe`;
  const zipName = `project-x-server-ubuntu24-${packageJson.version}.zip`;
  const exeBody = "MZ-fake-pe-payload";
  const zipBody = "PK-fake-zip-payload";
  writeFileSync(path.join(fixture, exeName), exeBody, "utf8");
  writeFileSync(path.join(fixture, zipName), zipBody, "utf8");
  writeFileSync(path.join(fixture, "builder-debug.yml"), "intermediate: true\n", "utf8");
  mkdirSync(path.join(fixture, "win-x64-unpacked"), { recursive: true });
  writeFileSync(path.join(fixture, "win-x64-unpacked", "not-distributed.txt"), "x", "utf8");
  mkdirSync(path.join(fixture, "server-ubuntu24"), { recursive: true });
  writeFileSync(path.join(fixture, "server-ubuntu24", zipName), zipBody, "utf8");

  section("1. 产物挑选");
  const artifacts = hasher.listArtifacts(fixture);
  ok(artifacts.includes(exeName) && artifacts.includes(zipName), "release/ 第一层的 exe 与 zip 都进清单");
  ok(artifacts.includes(`server-ubuntu24/${zipName}`), "第二个扫描根 server-ubuntu24/ 下的服务器包也进清单");
  ok(!artifacts.includes("builder-debug.yml"), "builder-debug.yml 是构建中间物，不进清单");
  ok(!artifacts.includes("win-x64-unpacked/not-distributed.txt"), "*-unpacked/ 目录不递归（那不是分发物）");
  ok(!artifacts.includes(hasher.MANIFEST_NAME) && !artifacts.includes(hasher.REPORT_NAME), "清单与报告本身不进清单");
  ok(artifacts.every((_, index) => index === 0 || artifacts[index - 1]! < artifacts[index]!), "清单按路径排序（两次构建可逐行 diff）");
  ok(artifacts.every((rel) => !rel.includes("\\")), "清单里的路径统一用正斜杠");

  section("2. 生成清单与构建报告");
  const written = run(["--root", fixture]);
  ok(written.status === 0, `生成模式退出码 0${written.status === 0 ? "" : `：${written.out.slice(0, 300)}`}`);
  const manifestPath = path.join(fixture, hasher.MANIFEST_NAME);
  const reportPath = path.join(fixture, hasher.REPORT_NAME);
  ok(existsSync(manifestPath), `${hasher.MANIFEST_NAME} 已生成`);
  ok(existsSync(reportPath), `${hasher.REPORT_NAME} 已生成`);

  const manifestRaw = readFileSync(manifestPath, "utf8");
  ok(!manifestRaw.includes("\r"), "清单是 LF 行尾（sha256sum -c 与跨平台 diff 都不会被 \\r 绊住）");
  ok(!manifestRaw.startsWith("\uFEFF"), "清单没有 BOM");
  const manifestLines = manifestRaw.split("\n").filter((line) => line.length > 0);
  ok(manifestLines.length === artifacts.length, `清单行数（${manifestLines.length}）等于产物数（${artifacts.length}）`);
  ok(manifestLines.every((line) => /^[0-9a-f]{64} {2}\S/.test(line)), "每行都是 `<64 位小写十六进制>  <路径>`（sha256sum -c 兼容）");
  const parsed = hasher.parseManifest(manifestRaw);
  ok(parsed.get(exeName) === sha256(exeBody), "exe 的校验和与独立计算一致");
  ok(parsed.get(zipName) === sha256(zipBody), "zip 的校验和与独立计算一致");
  ok(parsed.get(`server-ubuntu24/${zipName}`) === sha256(zipBody), "子目录产物的路径键与校验和都正确");
  ok(hasher.sha256Of(path.join(fixture, zipName)) === sha256(zipBody), "导出的 sha256Of 与独立计算一致");

  const report = readFileSync(reportPath, "utf8");
  ok(report.includes(`版本          : ${packageJson.version}`), "报告写出版本号");
  ok(/构建提交      : [0-9a-f]{7,}|构建提交      : unknown/.test(report), "报告写出构建提交");
  ok(report.includes("代码签名状态"), "报告有签名状态一节");
  ok(/未签名产物|无法检测|本次没有 exe/.test(report), "报告如实交代签名状态（未签名就说未签名，检测不了就说检测不了）");
  ok(report.includes("signAndEditExecutable=false") && report.includes("证书不得入库"), "报告写明未签名的原因是配置关闭 + 仓库不含证书");
  ok(report.includes("SmartScreen"), "报告写出未签名的现场后果（SmartScreen 拦未知发布者）");
  ok(report.includes("certutil -hashfile"), "报告给出不依赖本仓库的校验方法（certutil）");
  ok(report.includes(`certutil -hashfile "${exeName}" SHA256`),
    "certutil 示例用的是本次真实产物名，不是写死的版本号（现场可直接复制粘贴）");
  if (process.platform === "win32") {
    ok(new RegExp(`${exeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (Valid|NotSigned|UnknownError|HashMismatch)`).test(report),
      "Windows 上确实调用 PowerShell 取到了每个 exe 的 Authenticode 状态，而不是笼统的「无法检测」");
  }
  ok(report.includes("--check"), "报告给出一次校验全部产物的方法（--check）");
  ok(written.out.includes("未签名") || process.platform !== "win32", "生成时对未签名的可执行产物打印显式警告");

  section("3. 校验模式：一致 / 篡改 / 多出 / 缺失");
  const good = run(["--check", "--root", fixture]);
  ok(good.status === 0, `未改动时 --check 退出码 0${good.status === 0 ? "" : `：${good.out.slice(0, 300)}`}`);
  ok(good.out.includes("全部与清单一致"), "--check 通过时给出明确结论");

  appendFileSync(path.join(fixture, zipName), "tampered", "utf8");
  const tampered = run(["--check", "--root", fixture]);
  ok(tampered.status === 1, "改过一个字节后 --check 退出码 1");
  ok(tampered.out.includes(zipName) && tampered.out.includes("校验和不符"), "--check 点名被改的文件并给出两个校验和");
  ok(tampered.out.includes("不要使用"), "--check 明确告诉收件方不要用这份产物");
  writeFileSync(path.join(fixture, zipName), zipBody, "utf8");
  ok(run(["--check", "--root", fixture]).status === 0, "改回原样后 --check 重新通过（篡改检测不是单向的）");

  writeFileSync(path.join(fixture, "extra-payload.exe"), "MZ-extra", "utf8");
  const extra = run(["--check", "--root", fixture]);
  ok(extra.status === 1 && extra.out.includes("清单外多出的文件"), "目录里多出清单外的文件也算失败（塞进来的东西同样能被查出来）");
  rmSync(path.join(fixture, "extra-payload.exe"));

  rmSync(path.join(fixture, zipName));
  const missing = run(["--check", "--root", fixture]);
  ok(missing.status === 1 && missing.out.includes("清单里有、目录里缺"), "清单里有而目录里缺的文件也算失败");
  writeFileSync(path.join(fixture, zipName), zipBody, "utf8");

  const noManifest = mkdtempSync(path.join(tmpdir(), "projectx-release-nomanifest-"));
  writeFileSync(path.join(noManifest, "anything.exe"), "x", "utf8");
  const bare = run(["--check", "--root", noManifest]);
  ok(bare.status === 1 && bare.out.includes("没有完整性清单"), "产物目录里根本没有清单时 --check 直接失败，不会静默通过");
  rmSync(noManifest, { recursive: true, force: true });

  const emptyDir = mkdtempSync(path.join(tmpdir(), "projectx-release-empty-"));
  const empty = run(["--root", emptyDir]);
  ok(empty.status === 0 && empty.out.includes("没有任何可发布产物"), "空目录不生成清单也不报错（electron:pack --dir 会走到这条）");
  ok(!existsSync(path.join(emptyDir, hasher.MANIFEST_NAME)), "空目录不会留下一个空清单冒充「已校验」");
  rmSync(emptyDir, { recursive: true, force: true });

  const missingRoot = run(["--root", path.join(fixture, "definitely-not-here")]);
  ok(missingRoot.status === 1 && missingRoot.out.includes("目录不存在"), "产物目录不存在时退出码 1 并提示先跑打包命令");

  section("4. 清单解析的失败路径");
  let threw = false;
  try {
    hasher.parseManifest("not-a-checksum  file.exe\n");
  } catch {
    threw = true;
  }
  ok(threw, "清单里出现格式不符的行时抛错，而不是当成「没有这个文件」悄悄放过");
  ok(hasher.parseManifest("").size === 0, "空清单解析为空表（由 --check 的缺失分支负责报错）");
  ok(hasher.SCAN_ROOTS.length === 2 && hasher.SCAN_ROOTS[0] === "", "扫描根包含 release/ 本身与 server-ubuntu24/");

  section("5. 打包命令接线");
  const wired = ["electron:dist", "electron:dist:ia32", "electron:msi", "electron:msi:ia32", "package:server:ubuntu24"];
  for (const name of wired) {
    const script = (packageJson.scripts[name] ?? "").trim();
    ok(script.includes("npm run release:hash") && script.endsWith("npm run release:hash"),
      `${name} 以 npm run release:hash 收尾 —— 产物不可能在没有清单的情况下被打出来`);
  }
  ok(typeof packageJson.scripts["release:hash"] === "string" && packageJson.scripts["release:hash"].includes("hash-release-artifacts.cjs"),
    "release:hash 脚本存在且指向 hash-release-artifacts.cjs");
  ok((packageJson.scripts["release:hash:check"] ?? "").includes("--check"), "release:hash:check 用 --check 模式");
  ok(!wired.some((name) => (packageJson.scripts[name] ?? "").includes("release:hash:check")), "打包命令用的是生成模式，不是校验模式");
  for (const name of ["electron:pack", "electron:pack:ia32"]) {
    ok(!(packageJson.scripts[name] ?? "").includes("release:hash"), `${name} 不接清单（--dir 产物是目录，不是分发物）`);
  }

  section("6. 签名处置的口径与守卫");
  ok(packageJson.build?.win?.signAndEditExecutable === false,
    "signAndEditExecutable 仍是 false —— 本轮不假称已签名，处置是完整性凭据 + 文档");
  ok(/CSC_LINK/.test(hasherSource) && /signAndEditExecutable === false/.test(hasherSource),
    "环境里给了证书但配置关着签名时打印警告（否则「以为签了」的产物照样发出去）");
  ok(/if \(require\.main === module\)/.test(hasherSource), "生成动作收在 require.main 判断里，验证脚本可以 require 其中的纯函数");
  ok(/module\.exports = \{/.test(hasherSource), "导出 listArtifacts / parseManifest / sha256Of 供验证脚本直接调用");
  const readme = readFileSync(path.resolve("README.md"), "utf8");
  ok(readme.includes("SHA256SUMS.txt") && readme.includes("未签名"),
    "README 有「未签名与完整性校验」一节，写明 SHA256SUMS.txt 的用法");
  ok(readme.includes("signAndEditExecutable"), "README 写出 signAndEditExecutable=false 这个事实与启用签名的步骤");
  ok(/certutil -hashfile/.test(readme), "README 给出现场不需要本仓库也能用的校验命令");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(`\n发布产物完整性验收：${passed} 通过，${failed} 失败`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
