const AdmZip = require("adm-zip");
const {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const packageJson = require(path.join(rootDir, "package.json"));

const runtimeDependencies = [
  "adm-zip",
  "archiver",
  "bcryptjs",
  "better-sqlite3",
  "express",
  "express-rate-limit",
  "fontkit",
  "mammoth",
  "multer",
  "mysql2",
  "pdfjs-dist",
  "pdfkit",
  "qrcode",
  "sharp",
  "tesseract.js",
  "xlsx",
  "yauzl",
  "zod"
];

const outputRoot = path.join(rootDir, "release", "server-ubuntu24");
const packageName = `project-x-server-ubuntu24-${packageJson.version}`;
const packageDir = path.join(outputRoot, packageName);
const zipPath = path.join(outputRoot, `${packageName}.zip`);
const deployReadmeName = "Ubuntu24\u6d4f\u89c8\u5668\u7248\u90e8\u7f72\u8bf4\u660e.md";

function assertInsideRoot(targetPath) {
  const relative = path.relative(rootDir, path.resolve(targetPath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside repository: ${targetPath}`);
  }
}

function copyFileIfExists(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function copyDirectoryIfExists(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

function writeTextFile(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

/**
 * 本文件在 Windows 上是 CRLF 检出，模板字面量会把 \r\n 带进生成物：
 * start.sh / install.sh 会变成 `#!/usr/bin/env bash\r`，Ubuntu 上直接 bad interpreter；
 * systemd 单元的值也会多出尾随 \r（Environment=PORT=5174\r）。
 * 所有生成文本统一走这里转成 LF，与 .gitattributes 的 `*.sh text eol=lf` 对齐。
 */
function toLf(text) {
  return text.replace(/\r\n/g, "\n");
}

function createRuntimePackageJson() {
  const dependencies = {};
  for (const dependencyName of runtimeDependencies) {
    const version = packageJson.dependencies?.[dependencyName];
    if (!version) {
      throw new Error(`Missing dependency in package.json: ${dependencyName}`);
    }
    dependencies[dependencyName] = version;
  }

  return {
    name: "project-x-server-ubuntu24",
    version: packageJson.version,
    private: true,
    type: "module",
    description: "Project-X Ubuntu 24 web server package. Supports local SQLite and remote MariaDB 10.11 without Electron dependencies.",
    scripts: {
      start: "PROJECTX_AUTH_ENFORCE=${PROJECTX_AUTH_ENFORCE:-1} PROJECTX_ENABLE_SCANNER=${PROJECTX_ENABLE_SCANNER:-0} PROJECTX_ENABLE_SCANNER_CLIENT_API=${PROJECTX_ENABLE_SCANNER_CLIENT_API:-1} PROJECTX_MARIADB_HOST=${PROJECTX_MARIADB_HOST:-} PROJECTX_MARIADB_PORT=${PROJECTX_MARIADB_PORT:-3306} PROJECTX_MARIADB_USER=${PROJECTX_MARIADB_USER:-} PROJECTX_MARIADB_PASSWORD=${PROJECTX_MARIADB_PASSWORD:-} PROJECTX_MARIADB_DATABASE=${PROJECTX_MARIADB_DATABASE:-projectx} PROJECTX_PDF_FONT_PATH=${PROJECTX_PDF_FONT_PATH:-/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc} PROJECTX_PDF_FONT_POSTSCRIPT_NAME=${PROJECTX_PDF_FONT_POSTSCRIPT_NAME:-NotoSansCJKsc-Regular} node dist/server/index.mjs"
    },
    engines: {
      node: ">=22"
    },
    dependencies
  };
}

function createStartScript() {
  return toLf(`#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ "$(id -u)" = "0" ]; then
  echo "[start.sh] 警告：正在以 root 运行（安全 R37）。生产环境请改用 sudo bash systemd/install.sh，" >&2
  echo "[start.sh]       它会建专用系统账号、收紧数据目录权限并以该账号启动 systemd 服务。" >&2
fi

export PORT="\${PORT:-5174}"
export PROJECTX_AUTH_ENFORCE="\${PROJECTX_AUTH_ENFORCE:-1}"
export PROJECTX_ENABLE_SCANNER="\${PROJECTX_ENABLE_SCANNER:-0}"
export PROJECTX_ENABLE_SCANNER_CLIENT_API="\${PROJECTX_ENABLE_SCANNER_CLIENT_API:-1}"
export PROJECTX_PDF_FONT_PATH="\${PROJECTX_PDF_FONT_PATH:-/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc}"
export PROJECTX_PDF_FONT_POSTSCRIPT_NAME="\${PROJECTX_PDF_FONT_POSTSCRIPT_NAME:-NotoSansCJKsc-Regular}"

# MariaDB remote mode. Leave empty for local SQLite.
export PROJECTX_MARIADB_HOST="\${PROJECTX_MARIADB_HOST:-}"
export PROJECTX_MARIADB_PORT="\${PROJECTX_MARIADB_PORT:-3306}"
export PROJECTX_MARIADB_USER="\${PROJECTX_MARIADB_USER:-}"
export PROJECTX_MARIADB_PASSWORD="\${PROJECTX_MARIADB_PASSWORD:-}"
export PROJECTX_MARIADB_DATABASE="\${PROJECTX_MARIADB_DATABASE:-projectx}"
export ANSWER_CARD_CLIENT_DIST="\${ANSWER_CARD_CLIENT_DIST:-$(pwd)/dist/web}"

exec node dist/server/index.mjs
`);
}

function createDeployReadme() {
  return toLf(`# Project-X Ubuntu 24 Web Server Package

This is the browser-accessible web server package. It includes dist/web for the browser UI and dist/server for the API/static server, and supports local SQLite by default plus remote MariaDB 10.11 LTS for production multi-user deployments. It does not include Electron, electron-builder, Windows scanner bridge binaries, or Windows native resources.

## Contents

- dist/web/: browser UI served by the Node app.
- dist/server/index.mjs: Node API + static server.
- dist/server/schema.sql: SQLite initialization schema.
- dist/server/schema.mariadb.sql: MariaDB 10.11 schema.
- llmclient/: Python AI sidecar source and requirements (no local credentials).
- resources/background.jpg: runtime resource used by the background API.
- package.json: production runtime dependencies only.
- systemd/project-x-server.service: hardened systemd unit (dedicated non-root account).
- systemd/install.sh: idempotent install / upgrade script (creates the service account,
  fixes ownership and permissions, installs and enables the unit).
- start.sh: Ubuntu 24 startup script.

## Ubuntu 24 Prerequisites

\`\`\`bash
sudo apt update
sudo apt install -y nodejs npm build-essential python3 make g++ fonts-noto-cjk
\`\`\`

Node.js 22 LTS or newer is recommended. better-sqlite3 is installed on the Ubuntu host for the local ABI.

Ubuntu 24's default nodejs package is older than 22; install Node.js 22 or newer before running npm install.

## AI Service

Install the bundled sidecar dependencies in a virtual environment **at its final
location**. A venv records absolute paths in its console scripts, so a venv created
in a temporary extraction directory breaks as soon as the tree is copied to
/opt/project-x-server:

\`\`\`bash
sudo apt install -y python3-venv
npm install --omit=dev             # still inside the extracted package directory
sudo bash systemd/install.sh            # copies the tree to /opt/project-x-server
cd /opt/project-x-server
sudo python3 -m venv .venv
sudo .venv/bin/python -m pip install -r llmclient/requirements.txt
sudo chown -R root:projectx .venv && sudo chmod -R g+rX,o-rwx .venv
sudo systemctl restart project-x-server
\`\`\`

The launcher discovers .venv automatically. Configure providers in Global Settings
or supply a deployment-specific llmclient/.env; credentials are never packaged.
For an independently managed sidecar, set LLMCLIENT_AUTOSTART=false and LLMCLIENT_URL.

## Quick Start (local SQLite)

\`\`\`bash
unzip project-x-server-ubuntu24-${packageJson.version}.zip
cd project-x-server-ubuntu24-${packageJson.version}
npm install --omit=dev
chmod +x start.sh
./start.sh
\`\`\`

The service listens on http://127.0.0.1:5174 by default. Point Nginx to this port for the whole site: / serves the browser UI and /api serves the API.

This is a foreground trial run as whoever invoked it. For a production install use
\`sudo bash systemd/install.sh\` instead — see "Systemd Service" below.

Default environment:

- PROJECTX_AUTH_ENFORCE=1
- PROJECTX_ENABLE_SCANNER=0
- PROJECTX_ENABLE_SCANNER_CLIENT_API=1

\`PROJECTX_ENABLE_SCANNER_CLIENT_API=1\` enables authenticated uploads from the
Windows scanner client and permits its loopback HTTP origin through CORS. It
does not enable TWAIN or attempt to access scanner hardware on Ubuntu.

Optional SQLite data paths:

\`\`\`bash
export PROJECTX_DB_PATH=/var/lib/project-x/projectx.db
export ANSWER_CARD_DATA_DIR=/var/lib/project-x/answer-card
./start.sh
\`\`\`

## PDF Chinese Font

The PDF exporter requires a font with Chinese glyphs and refuses to generate a broken tofu-glyph PDF. The prerequisite command above installs Noto Sans CJK. Verify the file before starting:

\`\`\`bash
test -r /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
\`\`\`

To use another CJK font, override the defaults:

\`\`\`bash
export PROJECTX_PDF_FONT_PATH=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
export PROJECTX_PDF_FONT_POSTSCRIPT_NAME=NotoSansCJKsc-Regular
./start.sh
\`\`\`

## MariaDB Setup (remote mode)

MariaDB 10.11 LTS supports both 32-bit and 64-bit Ubuntu 24.

\`\`\`bash
sudo apt install -y mariadb-server
sudo mysql_secure_installation
sudo mysql -e "CREATE DATABASE projectx DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
sudo mysql -e "CREATE USER 'projectx_app'@'127.0.0.1' IDENTIFIED BY 'your_password'"
sudo mysql -e "GRANT SELECT, INSERT, UPDATE, DELETE ON projectx.* TO 'projectx_app'@'127.0.0.1'"
sudo mysql -e "FLUSH PRIVILEGES"
\`\`\`

Then start with MariaDB env vars:

\`\`\`bash
export PROJECTX_MARIADB_HOST=127.0.0.1
export PROJECTX_MARIADB_USER=projectx_app
export PROJECTX_MARIADB_PASSWORD=your_password
./start.sh
\`\`\`

## Systemd Service (production install)

\`./start.sh\` is for a trial run in the foreground. Production uses the installer,
which runs the service as a dedicated non-root account (security R37):

\`\`\`bash
cd project-x-server-ubuntu24-${packageJson.version}
sudo bash systemd/install.sh
\`\`\`

The script is idempotent, so re-running it after an upgrade is safe. It:

1. creates the system account \`projectx\` (nologin, no home directory);
2. copies the tree to \`/opt/project-x-server\`, owned by \`root:projectx\` with
   \`0750\` on the directory and \`g+rX,o-rwx\` on the tree, so the service account
   can execute but never modify the code;
3. hands \`/var/lib/project-x\` (SQLite database, answer-card scans, automatic
   backups) to \`projectx\` with \`0750\`;
4. installs \`/etc/systemd/system/project-x-server.service\`, then
   \`daemon-reload\`, \`enable\` and \`restart\`.

Overrides, all read from the environment before running the installer:

\`\`\`bash
sudo PROJECTX_SERVICE_USER=px PROJECTX_SERVICE_GROUP=px \\
     PROJECTX_APP_DIR=/srv/project-x PROJECTX_DATA_DIR=/srv/project-x-data \\
     bash systemd/install.sh
\`\`\`

The installer rewrites the unit it installs, so \`WorkingDirectory\`, \`ExecStart\`,
\`Environment=HOME\` / \`PROJECTX_DB_PATH\` / \`ANSWER_CARD_DATA_DIR\` /
\`ANSWER_CARD_CLIENT_DIST\` and \`User\`/\`Group\` all follow the directories above —
a custom \`PROJECTX_APP_DIR\` is not just where the files land, it is what the service
runs. The rewritten unit is verified line by line before \`daemon-reload\`, and the
install fails loudly instead of silently starting the packaged default paths.

Note the scripts are shipped with the Unix executable bit set inside the ZIP, but the
documented command uses \`sudo bash ...\` on purpose: extraction tools, Samba shares and
plain \`cp -r\` each drop that bit in their own way, and \`bash script.sh\` works regardless.

The unit itself sets \`UMask=0027\`, \`NoNewPrivileges=yes\`, \`ProtectSystem=full\`,
\`ProtectHome=yes\`, \`PrivateTmp=yes\`, \`PrivateDevices=yes\`, the \`ProtectKernel*\` /
\`ProtectControlGroups\` / \`ProtectClock\` group, \`RestrictNamespaces\`,
\`RestrictSUIDSGID\`, \`RestrictRealtime\`, \`LockPersonality\`, an empty
\`CapabilityBoundingSet\`, \`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK\`
and \`SystemCallArchitectures=native\`.

Two directives are deliberately absent, both because they break the runtime rather
than harden it:

- \`MemoryDenyWriteExecute=yes\` — V8's JIT needs writable-then-executable pages, so
  node dies at startup.
- \`SystemCallFilter=@system-service\` — the Node and Python-sidecar syscall surface
  drifts between releases; over-filtering shows up as a production crash loop. Enable
  it in a drop-in and review with \`systemd-analyze security project-x-server\`:

\`\`\`bash
sudo mkdir -p /etc/systemd/system/project-x-server.service.d
printf '[Service]\\nSystemCallFilter=@system-service\\nSystemCallErrorNumber=EPERM\\n' \\
  | sudo tee /etc/systemd/system/project-x-server.service.d/hardening.conf
sudo systemctl daemon-reload && sudo systemctl restart project-x-server
sudo journalctl -u project-x-server -n 50
\`\`\`

If the service was previously installed by hand as root, running the installer once
migrates it: the unit gains \`User=\`/\`Group=\` and the data directory changes owner.
Check afterwards with:

\`\`\`bash
systemctl show project-x-server -p User -p Group -p UMask
sudo -u projectx test -r /var/lib/project-x && echo "service account can read data"
\`\`\`

## Package Integrity

The build machine writes \`release/SHA256SUMS.txt\` and \`release/BUILD-INTEGRITY.txt\`
after packaging (security R42). Distribute them together with this zip. To verify a
copy you received:

\`\`\`bash
sha256sum -c SHA256SUMS.txt          # in the directory holding the artifacts
\`\`\`

Nothing here is code-signed; the checksum manifest is the only tamper evidence
available. \`BUILD-INTEGRITY.txt\` also records the exact build commit and states the
signing status plainly.

## Health Check

\`\`\`bash
curl http://127.0.0.1:5174/api/app/health
\`\`\`

Returns \`{"ok":true,"dialect":"sqlite"|"mariadb"}\`.
`);
}

function createSystemdUnit() {
  return toLf(`[Unit]
Description=Project-X Web Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple

# 安全 R37：服务不再以 root 运行。安装脚本 systemd/install.sh 会创建这两个账号，
# 并把 /var/lib/project-x 的属主交给它；升级时同样走该脚本，不会退回 root。
User=projectx
Group=projectx
NoNewPrivileges=yes
# 0027 让运行期新建的文件（SQLite 库、扫描件、自动备份）天生不带 other 权限。
UMask=0027

WorkingDirectory=/opt/project-x-server
Environment=HOME=/var/lib/project-x
Environment=PORT=5174
Environment=PROJECTX_AUTH_ENFORCE=1
Environment=PROJECTX_ENABLE_SCANNER=0
Environment=PROJECTX_ENABLE_SCANNER_CLIENT_API=1
Environment=PROJECTX_MARIADB_HOST=
Environment=PROJECTX_MARIADB_PORT=3306
Environment=PROJECTX_MARIADB_USER=
Environment=PROJECTX_MARIADB_PASSWORD=
Environment=PROJECTX_MARIADB_DATABASE=projectx
Environment=PROJECTX_DB_PATH=/var/lib/project-x/projectx.db
Environment=ANSWER_CARD_DATA_DIR=/var/lib/project-x/answer-card
Environment=ANSWER_CARD_CLIENT_DIST=/opt/project-x-server/dist/web
Environment=PROJECTX_PDF_FONT_PATH=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
Environment=PROJECTX_PDF_FONT_POSTSCRIPT_NAME=NotoSansCJKsc-Regular
ExecStart=/usr/bin/node /opt/project-x-server/dist/server/index.mjs
Restart=always
RestartSec=5

# ── 沙箱 ──
# ProtectSystem=full 而不是 strict：AI sidecar 的 .venv 就住在 /opt/project-x-server 下，
# strict 会把 /opt 变成只读，sidecar 与 llmclient/.env 都写不进去。
ProtectSystem=full
ProtectHome=yes
# 备份/还原的临时目录走 os.tmpdir()，私有 /tmp 正好让这些中间文件对其他进程不可见。
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
# AF_NETLINK 不能省：glibc 的 getifaddrs 用它枚举网卡。
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
SystemCallArchitectures=native
# 刻意不加 MemoryDenyWriteExecute=yes：V8 的 JIT 需要「先写后执行」的内存页，
# 打开后 node 会在启动阶段直接崩掉，而这份配置无法在打包机上验证。
# SystemCallFilter=@system-service 同理默认不开：Node 与 Python sidecar 的实际
# 系统调用集随版本漂移，收紧过头表现为生产环境崩溃循环。需要时在 drop-in 里打开，
# 并用 systemd-analyze security project-x-server 复核：
#   /etc/systemd/system/project-x-server.service.d/hardening.conf
#     [Service]
#     SystemCallFilter=@system-service
#     SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
`);
}

function createInstallScript() {
  return toLf(`#!/usr/bin/env bash
# 幂等安装 / 升级脚本（安全 R37）。
# 做四件事：建专用系统账号 → 铺包体并收紧权限 → 交出数据目录属主 → 安装并启用 systemd 单元。
# 首次安装与后续升级都走这个脚本，所以「升级不小心退回 root」这条路被封死了。
set -euo pipefail

SERVICE_USER="\${PROJECTX_SERVICE_USER:-projectx}"
SERVICE_GROUP="\${PROJECTX_SERVICE_GROUP:-projectx}"
APP_DIR="\${PROJECTX_APP_DIR:-/opt/project-x-server}"
DATA_DIR="\${PROJECTX_DATA_DIR:-/var/lib/project-x}"
UNIT_NAME="project-x-server.service"

SRC_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" != "0" ]; then
  echo "[install] 需要 root 权限：sudo bash systemd/install.sh" >&2
  exit 1
fi

if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$DATA_DIR" \\
    --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "[install] 已创建系统账号 $SERVICE_USER:$SERVICE_GROUP"
else
  echo "[install] 系统账号 $SERVICE_USER 已存在，复用"
fi

mkdir -p "$APP_DIR" "$DATA_DIR" "$DATA_DIR/answer-card" "$DATA_DIR/backups"

# 包体归 root，服务账号靠组成员身份「只读 + 可进入目录」执行代码。
# 用 g+rX/o-rwx 而不是统一 chmod 0640：X 只给本来就可执行的文件补组执行位，
# 这样 node_modules/.bin、dist/server/index.mjs 和 .venv/bin/python 不会被改坏。
# 就地升级（脚本已经在 $APP_DIR 里）时不能再 cp 自己，否则会 EEXIST/SAMEFILE。
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  cp -a "$SRC_DIR"/. "$APP_DIR"/
else
  echo "[install] 源目录就是 $APP_DIR，跳过复制"
fi
chown -R root:"$SERVICE_GROUP" "$APP_DIR"
chown -R root:"$SERVICE_GROUP" "$APP_DIR"
chmod -R g+rX,o-rwx "$APP_DIR"
chmod 0750 "$APP_DIR"
chmod 0750 "$APP_DIR/start.sh" "$APP_DIR/systemd/install.sh"

# 数据目录（SQLite 库、答题卡扫描件、自动备份）只有服务账号能读写。
chown -R "$SERVICE_USER":"$SERVICE_GROUP" "$DATA_DIR"
chmod 0750 "$DATA_DIR" "$DATA_DIR/answer-card" "$DATA_DIR/backups"

UNIT_SRC="$APP_DIR/systemd/$UNIT_NAME"
UNIT_DST="/etc/systemd/system/$UNIT_NAME"

# 单元里的账号**和路径**都按本次实际使用的目录重写（CR #313 P2-9）。
# INSTALL-REWRITE-BEGIN —— 验证脚本按这对标记切出「重写 + 自检」，在临时目录里带自定义目录真跑一遍
# 此前只改 User/Group：老师给了 PROJECTX_APP_DIR / PROJECTX_DATA_DIR，包体和数据确实
# 落到自定义目录，但 systemd 仍按包内默认的 /opt 与 /var/lib 起服务——服务读的是旧路径，
# 自定义目录成了摆设，升级时还会静默跑起一份旧代码。
# 用 awk 的 index()/substr() 而不是 sed：路径里的 & \\ 在 sed 替换串里是元字符，
# 换个带这些字符的目录就会串位；按「键名」整行重写也避免了默认值一改就漏改。
awk -v app="$APP_DIR" -v data="$DATA_DIR" -v user="$SERVICE_USER" -v group="$SERVICE_GROUP" '
  function subpath(line, from, to,   i) {
    i = index(line, from)
    return i ? substr(line, 1, i - 1) to substr(line, i + length(from)) : line
  }
  /^#/    { print subpath(subpath($0, "/opt/project-x-server", app), "/var/lib/project-x", data); next }
  /^User=/  { print "User=" user; next }
  /^Group=/ { print "Group=" group; next }
  /^WorkingDirectory=/              { print "WorkingDirectory=" app; next }
  /^Environment=HOME=/              { print "Environment=HOME=" data; next }
  /^Environment=PROJECTX_DB_PATH=/  { print "Environment=PROJECTX_DB_PATH=" data "/projectx.db"; next }
  /^Environment=ANSWER_CARD_DATA_DIR=/     { print "Environment=ANSWER_CARD_DATA_DIR=" data "/answer-card"; next }
  /^Environment=ANSWER_CARD_CLIENT_DIST=/  { print "Environment=ANSWER_CARD_CLIENT_DIST=" app "/dist/web"; next }
  /^ExecStart=/ {
    node = $1
    sub(/^ExecStart=/, "", node)          # 沿用包内既有的 node 可执行路径，只换脚本目录
    print "ExecStart=" node " " app "/dist/server/index.mjs"
    next
  }
  { print }
' "$UNIT_SRC" > "$UNIT_DST"
chmod 0644 "$UNIT_DST"

# 自检：重写后的单元必须真的指向本次目录。sed/awk 的锚点一旦与包内单元漂移，
# 症状是「服务从默认路径起了个旧版本」——现场最难查的那一类，所以宁可装到一半就失败。
for probe in \\
  "User=$SERVICE_USER" \\
  "Group=$SERVICE_GROUP" \\
  "WorkingDirectory=$APP_DIR" \\
  "Environment=HOME=$DATA_DIR" \\
  "Environment=PROJECTX_DB_PATH=$DATA_DIR/projectx.db" \\
  "Environment=ANSWER_CARD_DATA_DIR=$DATA_DIR/answer-card" \\
  "Environment=ANSWER_CARD_CLIENT_DIST=$APP_DIR/dist/web"; do
  if ! grep -qxF "$probe" "$UNIT_DST"; then
    echo "[install] systemd 单元缺少期望的行：$probe" >&2
    echo "[install] 包内单元与安装脚本的重写规则可能已漂移：$UNIT_SRC" >&2
    exit 1
  fi
done
case "$(awk '/^ExecStart=/{print; exit}' "$UNIT_DST")" in
  *" $APP_DIR/dist/server/index.mjs") ;;
  *)
    echo "[install] systemd 单元的 ExecStart 未指向 $APP_DIR/dist/server/index.mjs" >&2
    exit 1
    ;;
esac
# INSTALL-REWRITE-END —— 以上片段只读 APP_DIR / DATA_DIR / SERVICE_USER / SERVICE_GROUP / UNIT_SRC / UNIT_DST

systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
systemctl restart "$UNIT_NAME"

echo "[install] $UNIT_NAME 已安装并以 $SERVICE_USER 身份重启"
systemctl --no-pager show "$UNIT_NAME" -p User -p Group -p UMask -p ActiveState || true
`);
}

/** ZIP 里 `.sh` 条目的 Unix 权限：S_IFREG + 0755（外层 dos 属性位原样保留）。 */
const ZIP_UNIX_EXEC_MODE = 0o100755;
/** 「version made by」高字节 = 3（Unix）。低字节 0x14 = 2.0，与 adm-zip 原本写的一致。 */
const ZIP_MADE_BY_UNIX = 0x0314;

function isShellEntry(entry) {
  return !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".sh");
}

/**
 * 给打包产物补 Unix 可执行位（CR #313 P2-8）。
 *
 * 打包机是 Windows：`fs.statSync` 没有 x 位，adm-zip 于是把每个条目都写成 0666，
 * Linux 上 `unzip` 出来的 `start.sh` / `systemd/install.sh` 自然不可执行，
 * 而按旧文档直接执行 `systemd/install.sh` 的第一条命令就是 permission denied。
 * 这里显式写 0755，并把 made-by 标成 Unix：解压端（unzip / tar / Python）判断
 * 「外部属性里的 mode 是否可信」看的就是这个字节，光有 mode 还可能被忽略。
 * 文档同时改成 `sudo bash systemd/install.sh`——权限位会经过解压器、Samba、
 * `cp -r` 等多手传递，用解释器显式执行才是任何一条路都不断的那一个。
 */
function applyUnixExecBits(zip) {
  for (const entry of zip.getEntries()) {
    if (!isShellEntry(entry)) continue;
    entry.attr = (((ZIP_UNIX_EXEC_MODE << 16) | (entry.attr & 0xffff)) >>> 0);
    entry.header.made = ZIP_MADE_BY_UNIX;
  }
}

function createZip(sourceDir, targetZipPath) {
  const zip = new AdmZip();
  zip.addLocalFolder(sourceDir, path.basename(sourceDir));
  applyUnixExecBits(zip);
  zip.writeZip(targetZipPath);
}

function buildPackage() {
  assertInsideRoot(outputRoot);
  assertInsideRoot(packageDir);
  assertInsideRoot(zipPath);

  if (!existsSync(path.join(rootDir, "dist", "web", "index.html"))) {
    throw new Error("Missing dist/web/index.html. Run npm run build:web before packaging.");
  }
  if (!existsSync(path.join(rootDir, "dist", "server", "index.mjs"))) {
    throw new Error("Missing dist/server/index.mjs. Run npm run build:server before packaging.");
  }
  if (!existsSync(path.join(rootDir, "dist", "server", "schema.sql"))) {
    throw new Error("Missing dist/server/schema.sql. Run npm run build:server before packaging.");
  }
  if (!existsSync(path.join(rootDir, "dist", "server", "schema.mariadb.sql"))) {
    throw new Error("Missing dist/server/schema.mariadb.sql. Run npm run build:server before packaging.");
  }

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });

  copyDirectoryIfExists(path.join(rootDir, "dist", "web"), path.join(packageDir, "dist", "web"));
  copyDirectoryIfExists(path.join(rootDir, "dist", "server"), path.join(packageDir, "dist", "server"));
  cpSync(path.join(rootDir, "llmclient"), path.join(packageDir, "llmclient"), {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return ![".env", ".venv", "venv", "__pycache__"].includes(name)
        && !name.endsWith(".env") && !name.startsWith(".env.")
        && !/\.(?:pyc|pyo|log)$/.test(name);
    }
  });
  copyFileIfExists(path.join(rootDir, "resources", "background.jpg"), path.join(packageDir, "resources", "background.jpg"));
  // 安全 R37：包内 data/answer-card 用 0750 建，避免解压出来就是 0777&umask 的公开目录。
  mkdirSync(path.join(packageDir, "data", "answer-card"), { recursive: true, mode: 0o750 });

  writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(createRuntimePackageJson(), null, 2)}\n`,
    "utf8"
  );
  writeTextFile(path.join(packageDir, "start.sh"), createStartScript());
  writeTextFile(path.join(packageDir, "systemd", "project-x-server.service"), createSystemdUnit());
  writeTextFile(path.join(packageDir, "systemd", "install.sh"), createInstallScript());
  writeTextFile(path.join(packageDir, deployReadmeName), createDeployReadme());

  for (const scriptName of ["start.sh", path.join("systemd", "install.sh")]) {
    try {
      chmodSync(path.join(packageDir, scriptName), 0o755);
    } catch {
      // Windows zip extraction may not preserve this bit; the deploy doc includes chmod.
    }
  }

  createZip(packageDir, zipPath);

  console.log(`[Project-X] Ubuntu 24 web server package directory: ${packageDir}`);
  console.log(`[Project-X] Ubuntu 24 web server package zip: ${zipPath}`);
}

module.exports = {
  applyUnixExecBits,
  buildPackage,
  createDeployReadme,
  createInstallScript,
  createRuntimePackageJson,
  createStartScript,
  createSystemdUnit,
  ZIP_MADE_BY_UNIX,
  ZIP_UNIX_EXEC_MODE
};

// 让 verify-systemd-hardening.ts 能直接 require 这些生成器做静态断言，
// 而不必先跑一遍 build:web / build:server 产出 dist/。
if (require.main === module) {
  buildPackage();
}
