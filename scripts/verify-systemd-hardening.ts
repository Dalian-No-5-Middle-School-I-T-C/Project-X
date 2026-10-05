/**
 * Ubuntu 24 服务器包 systemd 加固回归验证（安全审查第五批 C · R37）
 *
 * R37 的问题：打包脚本生成的 systemd 单元没有 User=/Group=/UMask=，服务以 root 运行；
 * 部署文档又教人 `sudo cp -a . /opt/project-x-server/`，数据目录权限完全没提。
 * 结果是一个持有全校成绩与扫描件的服务，既以 root 身份跑，又落在 0777&umask 的目录里。
 *
 * 本脚本只做静态断言：直接 require 打包脚本、渲染它生成的四份文本（unit / install.sh /
 * start.sh / 部署说明），逐条核对。systemd 本身无法在 Windows 打包机上执行，
 * 因此这里锁的是「生成物内容」，运行期行为由部署文档里的 systemctl show 自检步骤兜底。
 *
 * 用法：
 *   npx tsx scripts/verify-systemd-hardening.ts
 *
 * 期望输出：所有断言通过，退出码 0。
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const packaging: {
  buildPackage: () => void;
  createDeployReadme: () => string;
  createInstallScript: () => string;
  createRuntimePackageJson: () => Record<string, unknown>;
  createStartScript: () => string;
  createSystemdUnit: () => string;
} = require("../scripts/package-server-ubuntu.cjs");

const packagingSource = readFileSync(
  path.resolve("scripts/package-server-ubuntu.cjs"),
  "utf8"
);

const unit = packaging.createSystemdUnit();
const install = packaging.createInstallScript();
const start = packaging.createStartScript();
const readme = packaging.createDeployReadme();

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

/** 取单元里「生效的」指令行：跳过空行与 # 注释，注释掉的 SystemCallFilter 不算数。 */
function activeDirectives(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[.+\]$/.test(line)) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  }
  return map;
}

const directives = activeDirectives(unit);
const first = (key: string): string | undefined => directives.get(key)?.[0];

section("1. 单元结构与非 root 运行身份（R37）");
ok(unit.startsWith("[Unit]\n"), "单元以 [Unit] 段开头（systemd 要求段头在最前）");
ok(/^\[Service\]$/m.test(unit) && /^\[Install\]$/m.test(unit), "[Service] 与 [Install] 两段都在");
{
  // 结构自检：任何非注释、非段头行都必须是 Key=Value，
  // 否则 systemd 会整份单元报错（fail-safe 但服务起不来）。
  const bad: string[] = [];
  for (const raw of unit.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || /^\[.+\]$/.test(line)) continue;
    if (!/^[A-Za-z][A-Za-z0-9]*=/.test(line)) bad.push(line);
  }
  ok(bad.length === 0, `所有生效行都是 Key=Value 形式${bad.length ? `（异常：${bad.join(" | ")}）` : ""}`);
}
ok(first("User") === "projectx", "User=projectx —— 服务不再以 root 运行");
ok(first("Group") === "projectx", "Group=projectx —— 主组是专用系统组，不是 root/wheel");
ok(!/^User=root$/m.test(unit) && !/^Group=root$/m.test(unit), "没有 User=root / Group=root 回退");
ok(first("NoNewPrivileges") === "yes", "NoNewPrivileges=yes —— 子进程（AI sidecar）不能靠 setuid 提权");
ok(first("UMask") === "0027", "UMask=0027 —— 运行期新建的库文件/扫描件/备份天生不带 other 权限");
ok(/^Environment=HOME=\/var\/lib\/project-x$/m.test(unit),
  "HOME 指向数据目录而不是 /root（非 root 身份下 /root 不可读，写缓存会失败）");

section("2. 沙箱指令");
const requiredSandbox: Array<[string, string]> = [
  ["ProtectSystem", "full"],
  ["ProtectHome", "yes"],
  ["PrivateTmp", "yes"],
  ["PrivateDevices", "yes"],
  ["ProtectKernelTunables", "yes"],
  ["ProtectKernelModules", "yes"],
  ["ProtectKernelLogs", "yes"],
  ["ProtectControlGroups", "yes"],
  ["ProtectClock", "yes"],
  ["RestrictNamespaces", "yes"],
  ["RestrictSUIDSGID", "yes"],
  ["RestrictRealtime", "yes"],
  ["LockPersonality", "yes"],
  ["SystemCallArchitectures", "native"]
];
for (const [key, expected] of requiredSandbox) {
  ok(first(key) === expected, `${key}=${expected}`);
}
ok(first("CapabilityBoundingSet") === "", "CapabilityBoundingSet 为空 —— 不给任何 capability（绑 <1024 端口由 Nginx 反代承担）");
const families = first("RestrictAddressFamilies") ?? "";
ok(families.split(/\s+/).sort().join(" ") === ["AF_INET", "AF_INET6", "AF_NETLINK", "AF_UNIX"].sort().join(" "),
  `RestrictAddressFamilies 恰好是 AF_UNIX/AF_INET/AF_INET6/AF_NETLINK（少了 AF_NETLINK 会让 glibc getifaddrs 失败）—— 实际：${families || "（缺失）"}`);
ok(first("ProtectSystem") === "full" && !/ProtectSystem=strict/.test(unit),
  "ProtectSystem 用 full 而不是 strict：AI sidecar 的 .venv 与 llmclient/.env 就在 /opt/project-x-server 下，strict 会把它变成只读");
ok(!/^\s*MemoryDenyWriteExecute\s*=/m.test(unit),
  "刻意不加 MemoryDenyWriteExecute —— V8 的 JIT 需要可写后可执行的内存页，加上 node 会在启动阶段直接崩");
ok(!/^\s*SystemCallFilter\s*=/m.test(unit),
  "SystemCallFilter 默认不生效（只在注释里给 drop-in 示例）—— Node/Python 的系统调用集随版本漂移，收紧过头表现为生产崩溃循环");
ok(/MemoryDenyWriteExecute/.test(unit) && /SystemCallFilter=@system-service/.test(unit),
  "两条「为什么不开」的理由写在单元注释里，下一个人不会当成漏项又加回去");

section("3. 加固没有顺手改掉既有行为");
ok(/Environment=PROJECTX_AUTH_ENFORCE=1/.test(unit), "PROJECTX_AUTH_ENFORCE=1 仍在（R37 不得顺带关掉鉴权）");
ok(first("WorkingDirectory") === "/opt/project-x-server", "WorkingDirectory 仍是 /opt/project-x-server");
ok(/Environment=PROJECTX_DB_PATH=\/var\/lib\/project-x\/projectx\.db/.test(unit), "SQLite 库路径仍在 /var/lib/project-x");
ok(/Environment=ANSWER_CARD_DATA_DIR=\/var\/lib\/project-x\/answer-card/.test(unit), "答题卡数据目录仍在 /var/lib/project-x/answer-card");
ok(/Environment=PORT=5174/.test(unit), "默认端口 5174 未变（Nginx 反代配置不需要跟着改）");
ok(/ExecStart=\/usr\/bin\/node \/opt\/project-x-server\/dist\/server\/index\.mjs/.test(unit), "ExecStart 仍用绝对路径的 node 与入口");
ok(/Restart=always/.test(unit) && /RestartSec=5/.test(unit), "Restart=always / RestartSec=5 未变");
ok(/After=network-online\.target/.test(unit) && /Wants=network-online\.target/.test(unit),
  "等待 network-online 而不是 network：MariaDB 远端模式下 DNS/路由未就绪时启动会直接失败");

section("4. 安装脚本（幂等、且升级也落到非 root）");
ok(/^#!\/usr\/bin\/env bash/.test(install) && /^set -euo pipefail$/m.test(install), "install.sh 是 bash + set -euo pipefail");
ok(/\[ "\$\(id -u\)" != "0" \]/.test(install) && /exit 1/.test(install), "非 root 调用直接退出，不会装出一个半权限的残局");
ok(/groupadd --system "\$SERVICE_GROUP"/.test(install) && /getent group/.test(install), "系统组用 getent 探测后创建（重复执行不报错）");
ok(/useradd --system --gid "\$SERVICE_GROUP"/.test(install)
  && /--no-create-home/.test(install) && /--shell \/usr\/sbin\/nologin/.test(install),
  "系统账号 --system + nologin + 不建家目录，不能用它登录");
ok(/id -u "\$SERVICE_USER" >\/dev\/null 2>&1/.test(install), "账号已存在时复用而不是重建（升级路径幂等）");
ok(/chown -R "\$SERVICE_USER":"\$SERVICE_GROUP" "\$DATA_DIR"/.test(install), "数据目录属主交给服务账号（旧 root 安装留下的库文件一并纠正）");
ok(/chmod 0750 "\$DATA_DIR" "\$DATA_DIR\/answer-card" "\$DATA_DIR\/backups"/.test(install),
  "数据目录、答题卡目录、自动备份目录都是 0750（含成绩与扫描件，不给 other）");
ok(/chown -R root:"\$SERVICE_GROUP" "\$APP_DIR"/.test(install)
  && /chmod -R g\+rX,o-rwx "\$APP_DIR"/.test(install),
  "代码目录归 root、服务账号只读+可执行（g+rX 保留原有执行位，不会把 .venv/bin/python 改坏）");
ok(/chmod 0750 "\$APP_DIR"/.test(install), "代码目录本身 0750");
ok(/if \[ "\$SRC_DIR" != "\$APP_DIR" \]; then/.test(install), "就地升级时跳过自我复制（cp 自己到自己会报错）");
ok(/install -D -m 0644 "\$APP_DIR\/systemd\/\$UNIT_NAME" "\$UNIT_DST"/.test(install)
  && /UNIT_DST="\/etc\/systemd\/system\/\$UNIT_NAME"/.test(install),
  "单元装到 /etc/systemd/system 且 0644");
ok(/systemctl daemon-reload/.test(install) && /systemctl enable "\$UNIT_NAME"/.test(install) && /systemctl restart "\$UNIT_NAME"/.test(install),
  "daemon-reload + enable + restart 三步都在（升级后单元内容变化必须 daemon-reload）");
ok(/systemctl --no-pager show "\$UNIT_NAME" -p User -p Group -p UMask/.test(install),
  "装完立即回显 User/Group/UMask，现场能当场看出是不是真的非 root");
{
  // 单元里的身份与安装脚本的默认身份必须是同一套字面量，
  // 否则「脚本建了 projectx，单元跑的是别的账号」这种静默错配就没人发现。
  const userDefault = /\$\{PROJECTX_SERVICE_USER:-(\w+)\}/.exec(install)?.[1];
  const groupDefault = /\$\{PROJECTX_SERVICE_GROUP:-(\w+)\}/.exec(install)?.[1];
  ok(userDefault === first("User"), `install.sh 默认账号（${userDefault}）与单元 User=（${first("User")}）一致`);
  ok(groupDefault === first("Group"), `install.sh 默认组（${groupDefault}）与单元 Group=（${first("Group")}）一致`);
  const appDefault = /\$\{PROJECTX_APP_DIR:-([^}]+)\}/.exec(install)?.[1];
  const dataDefault = /\$\{PROJECTX_DATA_DIR:-([^}]+)\}/.exec(install)?.[1];
  ok(appDefault === first("WorkingDirectory"), `install.sh 默认安装目录（${appDefault}）与单元 WorkingDirectory 一致`);
  ok(unit.includes(`${dataDefault}/projectx.db`) && unit.includes(`${dataDefault}/answer-card`),
    `install.sh 默认数据目录（${dataDefault}）覆盖单元里的库路径与答题卡路径`);
  ok(/sed -e "s\/\^User=projectx\$\/User=\$SERVICE_USER\/"/.test(install),
    "自定义账号名时用 sed 重写单元里的 User=/Group=，不会装出一份身份对不上的单元");
}

section("5. start.sh 与部署说明");
ok(/\[ "\$\(id -u\)" = "0" \]/.test(start) && /systemd\/install\.sh/.test(start),
  "start.sh 以 root 运行时给出警告并指向 install.sh（前台试跑仍可用，但不留「就这么跑生产」的错觉）");
ok(/exec node dist\/server\/index\.mjs/.test(start), "start.sh 的启动命令未变");
ok(/sudo systemd\/install\.sh/.test(readme), "部署说明改用 sudo systemd/install.sh");
ok(!/sudo cp -a \. \/opt\/project-x-server\//.test(readme),
  "手工 `sudo cp -a . /opt/...` 那套流程已从文档移除（它既不改属主也不改权限）");
ok(/MemoryDenyWriteExecute/.test(readme) && /SystemCallFilter=@system-service/.test(readme),
  "部署说明写清两条刻意不启用的指令及原因，并给出 drop-in 启用方式");
ok(/systemd-analyze security project-x-server/.test(readme), "文档给出 systemd-analyze security 复核命令");
ok(/venv records absolute paths/.test(readme) && /at its final\s*\n\s*location/.test(readme),
  "文档说明 .venv 必须在最终位置创建（临时目录里建的 venv 复制过去后 console script 会指向失效路径）");
ok(/systemd\/install\.sh: idempotent install/.test(readme), "包内容清单里列出了 systemd/install.sh");
ok(readme.includes("- systemd/project-x-server.service: hardened systemd unit"), "包内容清单说明单元已加固（非 root 账号）");

section("6. 打包脚本自身的接线");
ok(/writeTextFile\(path\.join\(packageDir, "systemd", "install\.sh"\), createInstallScript\(\)\);/.test(packagingSource),
  "打包时确实写出 systemd/install.sh（只改生成器不接线，包里就不会有这个文件）");
ok(/for \(const scriptName of \["start\.sh", path\.join\("systemd", "install\.sh"\)\]\)/.test(packagingSource)
  && /chmodSync\(path\.join\(packageDir, scriptName\), 0o755\)/.test(packagingSource),
  "start.sh 与 install.sh 都置 0755");
ok(/mkdirSync\(path\.join\(packageDir, "data", "answer-card"\), \{ recursive: true, mode: 0o750 \}\)/.test(packagingSource),
  "包内 data/answer-card 用 0750 建，解压出来不是公开目录");
ok(/if \(require\.main === module\) \{\s*\n\s*buildPackage\(\);/.test(packagingSource),
  "打包动作收在 require.main 判断里 —— 验证脚本能 require 生成器而不触发「缺 dist/ 就抛错」");
ok(typeof packaging.buildPackage === "function" && typeof packaging.createRuntimePackageJson === "function",
  "module.exports 暴露了生成器（buildPackage / createRuntimePackageJson 等）");
{
  const runtime = packaging.createRuntimePackageJson();
  ok(runtime.type === "module" && typeof runtime.dependencies === "object",
    "运行时 package.json 生成未受影响（type=module + dependencies 齐全）");
}

section("7. 生成物行尾与 shell 语法");
{
  // 本仓库在 Windows 上是 CRLF 检出，模板字面量会把 \r 带进生成物：
  // start.sh / install.sh 的 shebang 会变成 `/usr/bin/env bash\r` → bad interpreter，
  // 单元里的 Environment 值也会多一个尾随 \r。生成器必须统一转 LF。
  for (const [name, text] of [["unit", unit], ["install.sh", install], ["start.sh", start], ["readme", readme]] as const) {
    ok(!text.includes("\r"), `${name} 不含 CR（LF 行尾，与 .gitattributes 的 *.sh text eol=lf 一致）`);
  }
  ok(/^#!\/usr\/bin\/env bash$/m.test(install), "install.sh 的 shebang 行干净（无尾随 \\r）");
}
{
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.log("  - 本机找不到 bash，跳过语法检查（CI 的 ubuntu 作业会真正跑到这两条）");
  } else {
    const dir = mkdtempSync(path.join(tmpdir(), "projectx-r37-shellsyntax-"));
    try {
      for (const [name, text] of [["install.sh", install], ["start.sh", start]] as const) {
        const file = path.join(dir, name);
        writeFileSync(file, text, { encoding: "utf8" });
        const res = spawnSync("bash", ["-n", file], { encoding: "utf8" });
        ok(res.status === 0,
          `bash -n ${name} 语法通过${res.status === 0 ? "" : `：${(res.stderr ?? "").trim().slice(0, 200)}`}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\nsystemd 加固验收：${passed} 通过，${failed} 失败`);if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
