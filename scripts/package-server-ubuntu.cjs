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

const serverDependencies = [
  "adm-zip",
  "archiver",
  "bcryptjs",
  "better-sqlite3",
  "expr-eval",
  "express",
  "multer",
  "mysql2",
  "pdfkit",
  "xlsx"
];

const outputRoot = path.join(rootDir, "release", "server-ubuntu24");
const packageName = `project-x-server-ubuntu24-${packageJson.version}`;
const packageDir = path.join(outputRoot, packageName);
const zipPath = path.join(outputRoot, `${packageName}.zip`);

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
  for (const dependencyName of serverDependencies) {
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
    description: "Project-X Ubuntu 24 server runtime package without Electron dependencies.",
    scripts: {
      start: "PROJECTX_AUTH_ENFORCE=${PROJECTX_AUTH_ENFORCE:-1} PROJECTX_VARIANT=${PROJECTX_VARIANT:-teacher} PROJECTX_ENABLE_SCANNER=${PROJECTX_ENABLE_SCANNER:-0} node dist/server/index.mjs"
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
export PROJECTX_VARIANT="\${PROJECTX_VARIANT:-teacher}"
export PROJECTX_ENABLE_SCANNER="\${PROJECTX_ENABLE_SCANNER:-0}"

exec node dist/server/index.mjs
`;
}

function createDeployReadme() {
  return `# Project-X Ubuntu 24 服务端部署包

这个包只包含 Project-X 服务端运行所需内容，不包含 Electron、electron-builder、Windows 扫描桥接程序或前端 dist/client。

## 目录内容

- dist/server/index.mjs：服务端入口。
- dist/server/schema.sql：SQLite 初始化 schema。
- resources/background.jpg：服务端背景图接口使用的资源。
- package.json：只保留服务端生产依赖。
- start.sh：Ubuntu 24 启动脚本。

## Ubuntu 24 准备

\`\`\`bash
sudo apt update
sudo apt install -y nodejs npm build-essential python3 make g++
\`\`\`

建议使用 Node.js 22 LTS 或更新版本。better-sqlite3 会在 Ubuntu 机器上按本机环境编译。

## 安装和启动

\`\`\`bash
unzip project-x-server-ubuntu24-${packageJson.version}.zip
cd project-x-server-ubuntu24-${packageJson.version}
npm install --omit=dev
chmod +x start.sh
./start.sh
\`\`\`

服务默认监听 http://127.0.0.1:5174，并默认设置：

- PROJECTX_AUTH_ENFORCE=1
- PROJECTX_VARIANT=teacher
- PROJECTX_ENABLE_SCANNER=0

如果需要指定数据位置：

\`\`\`bash
export PROJECTX_DB_PATH=/var/lib/project-x/projectx.db
export ANSWER_CARD_DATA_DIR=/var/lib/project-x/answer-card
./start.sh
\`\`\`

健康检查：

\`\`\`bash
curl http://127.0.0.1:5174/api/app/health
\`\`\`

生产环境建议用 Nginx 反向代理到 127.0.0.1:5174，并在 Nginx 层配置 HTTPS。
`;
}

function createSystemdUnit() {
  return `[Unit]
Description=Project-X Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/project-x-server
Environment=PORT=5174
Environment=PROJECTX_AUTH_ENFORCE=1
Environment=PROJECTX_VARIANT=teacher
Environment=PROJECTX_ENABLE_SCANNER=0
Environment=PROJECTX_DB_PATH=/var/lib/project-x/projectx.db
Environment=ANSWER_CARD_DATA_DIR=/var/lib/project-x/answer-card
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

if (!existsSync(path.join(rootDir, "dist", "server", "index.mjs"))) {
  throw new Error("Missing dist/server/index.mjs. Run npm run build:server before packaging.");
}
if (!existsSync(path.join(rootDir, "dist", "server", "schema.sql"))) {
  throw new Error("Missing dist/server/schema.sql. Run npm run build:server before packaging.");
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });

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
writeTextFile(path.join(packageDir, "Ubuntu24服务端部署说明.md"), createDeployReadme());

try {
  chmodSync(path.join(packageDir, "start.sh"), 0o755);
} catch {
  // Windows zip extraction may not preserve this bit; the deploy doc includes chmod.
}

createZip(packageDir, zipPath);

console.log(`[Project-X] Ubuntu 24 server package directory: ${packageDir}`);
console.log(`[Project-X] Ubuntu 24 server package zip: ${zipPath}`);
