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
  "expr-eval",
  "express",
  "mammoth",
  "multer",
  "mysql2",
  "pdfjs-dist",
  "pdfkit",
  "sharp",
  "tesseract.js",
  "xlsx",
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
      start: "PROJECTX_AUTH_ENFORCE=${PROJECTX_AUTH_ENFORCE:-1} PROJECTX_ENABLE_SCANNER=${PROJECTX_ENABLE_SCANNER:-0} PROJECTX_MARIADB_HOST=${PROJECTX_MARIADB_HOST:-} PROJECTX_MARIADB_PORT=${PROJECTX_MARIADB_PORT:-3306} PROJECTX_MARIADB_USER=${PROJECTX_MARIADB_USER:-} PROJECTX_MARIADB_PASSWORD=${PROJECTX_MARIADB_PASSWORD:-} PROJECTX_MARIADB_DATABASE=${PROJECTX_MARIADB_DATABASE:-projectx} node dist/server/index.mjs"
    },
    engines: {
      node: ">=22"
    },
    dependencies
  };
}

function createStartScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export PORT="\${PORT:-5174}"
export PROJECTX_AUTH_ENFORCE="\${PROJECTX_AUTH_ENFORCE:-1}"
export PROJECTX_ENABLE_SCANNER="\${PROJECTX_ENABLE_SCANNER:-0}"

# MariaDB remote mode. Leave empty for local SQLite.
export PROJECTX_MARIADB_HOST="\${PROJECTX_MARIADB_HOST:-}"
export PROJECTX_MARIADB_PORT="\${PROJECTX_MARIADB_PORT:-3306}"
export PROJECTX_MARIADB_USER="\${PROJECTX_MARIADB_USER:-}"
export PROJECTX_MARIADB_PASSWORD="\${PROJECTX_MARIADB_PASSWORD:-}"
export PROJECTX_MARIADB_DATABASE="\${PROJECTX_MARIADB_DATABASE:-projectx}"
export ANSWER_CARD_CLIENT_DIST="\${ANSWER_CARD_CLIENT_DIST:-$(pwd)/dist/web}"

exec node dist/server/index.mjs
`;
}

function createDeployReadme() {
  return `# Project-X Ubuntu 24 Web Server Package

This is the browser-accessible web server package. It includes dist/web for the browser UI and dist/server for the API/static server, and supports local SQLite by default plus remote MariaDB 10.11 LTS for production multi-user deployments. It does not include Electron, electron-builder, Windows scanner bridge binaries, or Windows native resources.

## Contents

- dist/web/: browser UI served by the Node app.
- dist/server/index.mjs: Node API + static server.
- dist/server/schema.sql: SQLite initialization schema.
- dist/server/schema.mariadb.sql: MariaDB 10.11 schema.
- resources/background.jpg: runtime resource used by the background API.
- package.json: production runtime dependencies only.
- systemd/project-x-server.service: systemd unit file.
- start.sh: Ubuntu 24 startup script.

## Ubuntu 24 Prerequisites

\`\`\`bash
sudo apt update
sudo apt install -y nodejs npm build-essential python3 make g++ fonts-noto-cjk
\`\`\`

Node.js 22 LTS or newer is recommended. better-sqlite3 is installed on the Ubuntu host for the local ABI.

## Quick Start (local SQLite)

\`\`\`bash
unzip project-x-server-ubuntu24-${packageJson.version}.zip
cd project-x-server-ubuntu24-${packageJson.version}
npm install --omit=dev
chmod +x start.sh
./start.sh
\`\`\`

The service listens on http://127.0.0.1:5174 by default. Point Nginx to this port for the whole site: / serves the browser UI and /api serves the API.

Default environment:

- PROJECTX_AUTH_ENFORCE=1
- PROJECTX_ENABLE_SCANNER=0

Optional SQLite data paths:

\`\`\`bash
export PROJECTX_DB_PATH=/var/lib/project-x/projectx.db
export ANSWER_CARD_DATA_DIR=/var/lib/project-x/answer-card
./start.sh
\`\`\`

Optional PDF font override:

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

## Systemd Service

\`\`\`bash
sudo mkdir -p /opt/project-x-server /var/lib/project-x/answer-card
sudo cp -a . /opt/project-x-server/
sudo cp systemd/project-x-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now project-x-server
\`\`\`

## Health Check

\`\`\`bash
curl http://127.0.0.1:5174/api/app/health
\`\`\`

Returns \`{"ok":true,"dialect":"sqlite"|"mariadb"}\`.
`;
}

function createSystemdUnit() {
  return `[Unit]
Description=Project-X Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/project-x-server
Environment=PORT=5174
Environment=PROJECTX_AUTH_ENFORCE=1
Environment=PROJECTX_ENABLE_SCANNER=0
Environment=PROJECTX_MARIADB_HOST=
Environment=PROJECTX_MARIADB_PORT=3306
Environment=PROJECTX_MARIADB_USER=
Environment=PROJECTX_MARIADB_PASSWORD=
Environment=PROJECTX_MARIADB_DATABASE=projectx
Environment=PROJECTX_DB_PATH=/var/lib/project-x/projectx.db
Environment=ANSWER_CARD_DATA_DIR=/var/lib/project-x/answer-card
Environment=ANSWER_CARD_CLIENT_DIST=/opt/project-x-server/dist/web
ExecStart=/usr/bin/node /opt/project-x-server/dist/server/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function createZip(sourceDir, targetZipPath) {
  const zip = new AdmZip();
  zip.addLocalFolder(sourceDir, path.basename(sourceDir));
  zip.writeZip(targetZipPath);
}

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
copyFileIfExists(path.join(rootDir, "resources", "background.jpg"), path.join(packageDir, "resources", "background.jpg"));
mkdirSync(path.join(packageDir, "data", "answer-card"), { recursive: true });

writeFileSync(
  path.join(packageDir, "package.json"),
  `${JSON.stringify(createRuntimePackageJson(), null, 2)}\n`,
  "utf8"
);
writeTextFile(path.join(packageDir, "start.sh"), createStartScript());
writeTextFile(path.join(packageDir, "systemd", "project-x-server.service"), createSystemdUnit());
writeTextFile(path.join(packageDir, deployReadmeName), createDeployReadme());

try {
  chmodSync(path.join(packageDir, "start.sh"), 0o755);
} catch {
  // Windows zip extraction may not preserve this bit; the deploy doc includes chmod.
}

createZip(packageDir, zipPath);

console.log(`[Project-X] Ubuntu 24 web server package directory: ${packageDir}`);
console.log(`[Project-X] Ubuntu 24 web server package zip: ${zipPath}`);
