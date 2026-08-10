# Project-X 服务器部署说明

## 服务状态

✅ 已成功启动，当前运行中。

## 公网访问地址

- **前端页面**: https://plaintiff-spears-weapon-mining.trycloudflare.com
- **后端 API**: https://plaintiff-spears-weapon-mining.trycloudflare.com/api/...
- **健康检查**: https://plaintiff-spears-weapon-mining.trycloudflare.com/api/app/health

## 默认账号

- 用户名: `admin`
- 密码: 见数据库旁的 `bootstrap-admin.txt`（#185 起为随机一次性密码，权限 0600）
- ⚠️ 首次登录会强制要求立即改密！

## 如何使用

### 浏览器直接访问
在浏览器中打开：
```
https://plaintiff-spears-weapon-mining.trycloudflare.com/Grade-Analysis-System-mobile.html?api_base=https://plaintiff-spears-weapon-mining.trycloudflare.com
```

### 微信小程序接入
学生端小程序为独立仓库 X-exam，通过原生 request/downloadFile 访问后端，不使用 `web-view`；此页面仅用于浏览器直访。

## 当前运行中的进程

| 进程 | 说明 | 端口 |
|------|------|------|
| Node.js (tsx) | Project-X 后端服务 | `127.0.0.1:5174` |
| cloudflared | Cloudflare Quick Tunnel | 公网 HTTPS |

## 从 GitHub 同步更新（一键拉取最新代码）

如果你从 GitHub 仓库推送了新代码，服务器上可以一键同步更新。

### 一键更新（推荐，Git Bash）

在项目目录中打开 **Git Bash**，然后执行：

```bash
bash update.sh
```

这个脚本会自动完成：
1. 保存本地修改（如缓存头配置）
2. 从 GitHub 拉取最新代码
3. 恢复本地修改（如有冲突会提示）
4. 同步前端文件到 `dist/web/`
5. 重启后端服务

**更新完成后**，刷新浏览器即可看到最新版本。

### 手动更新

```bash
cd /c/Users/Administrator/Desktop/Project-X-main

# 1. 保存本地修改
git stash

# 2. 拉取最新代码
git pull origin main

# 3. 恢复本地修改
git stash pop

# 4. 构建并同步前端到 dist/web
npm run build:web
# 注意：请勿再用根目录的 Grade-Analysis-System-mobile.html 覆盖 dist/web/index.html；
# React 应用入口由 Vite 构建生成，该旧版单页仅用于微信小程序独立部署。

# 5. 重启后端（先停止旧进程，再启动新进程）
kill <旧后端PID>
bash start-server.sh
```

---

## 重启服务

如果服务意外停止，请按以下步骤重启：

### 方式 1：一键启动（推荐）

双击运行项目目录中的 `start-server.bat` 文件，会自动启动后端和隧道。

### 方式 2：手动启动

打开 **Git Bash**，进入项目目录：

```bash
cd /c/Users/Administrator/Desktop/Project-X-main
```

**步骤 1：启动后端**
```bash
node node_modules/tsx/dist/cli.mjs src/apps/answer-card/server/index.ts
```
（保持这个窗口运行，不要关闭）

**步骤 2：另开一个 Git Bash 窗口，启动 Cloudflare 隧道**
```bash
cd /c/Users/Administrator/Desktop/Project-X-main
./cloudflared.exe tunnel --url http://127.0.0.1:5174
```
（保持这个窗口运行，不要关闭）

**步骤 3：记录新的公网 URL**
Cloudflare Quick Tunnel 每次重启会分配一个新的随机 URL（例如 `https://xxx.trycloudflare.com`），请做好记录。

## 注意事项

1. **URL 会变化**: Cloudflare Quick Tunnel 免费版每次重启都会分配新的随机 URL。如需固定域名，请看下方的"升级方案"。
2. **稳定性**: Cloudflare 基础设施比 localtunnel 更稳定，延迟更低，支持 QUIC 协议。
3. **HTTPS 已支持**: 无需额外配置，Cloudflare 自动提供 HTTPS 证书。
4. **无反钓鱼页面**: 不像 localtunnel 需要点击 "Click to Continue"，Cloudflare 直接访问。

## 升级方案：固定域名（Named Tunnel）

如果你有自己的域名（例如 `your-domain.com`），可以通过以下步骤获得**永久固定**的访问地址：

### 前置条件
- 一个已经在 Cloudflare 管理的域名（在 dash.cloudflare.com 添加并修改 DNS）
- 已登录 cloudflared CLI（`cloudflared.exe tunnel login`）

### 步骤

```bash
# 1. 登录（浏览器授权）
./cloudflared.exe tunnel login

# 2. 创建隧道（只需执行一次）
./cloudflared.exe tunnel create project-x
# 记录输出的 Tunnel ID，例如：a1b2c3d4-e5f6-7890-abcd-ef1234567890

# 3. 创建配置文件 config.yml
# 内容示例：
# tunnel: a1b2c3d4-e5f6-7890-abcd-ef1234567890
# credentials-file: C:\Users\Administrator\.cloudflared\a1b2c3d4-e5f6-7890-abcd-ef1234567890.json
# ingress:
#   - hostname: projectx.your-domain.com
#     service: http://localhost:5174
#   - service: http_status:404

# 4. 添加 DNS 记录（只需执行一次）
./cloudflared.exe tunnel route dns project-x projectx.your-domain.com

# 5. 运行隧道
./cloudflared.exe tunnel run project-x
```

完成后，永久访问地址为：
```
https://projectx.your-domain.com
```

重启后 URL **永不变化**！

## 技术栈信息

- **Node.js 版本**: v24.15.0 (kimi-desktop 内置)
- **后端框架**: Express + TypeScript (tsx)
- **数据库**: SQLite (better-sqlite3, 本地模式) / MariaDB 10.11 LTS (mysql2, 远程模式)
- **隧道工具**: Cloudflare Tunnel (cloudflared)
- **本地端口**: 5174

## 数据库

- **本地模式**（默认）：`data/projectx.db`（SQLite 单文件）
- **远程模式**：设置 `PROJECTX_MARIADB_HOST` 环境变量连接 MariaDB 10.11 服务器
  - 详见 `readus/DATABASE.md` — 完整安装/配置/迁移指引
  - 详见 `scripts/package-server-ubuntu.cjs` — 服务器部署打包

## 常见问题

### Q: 访问提示 "Bad Gateway" 或 "530"
A: 后端服务或 cloudflared 已停止，请按上方步骤重启。

### Q: 如何修改默认管理员密码？
A: 登录系统后，在"账号管理"或"设置"页面修改。

### Q: 需要配置 CORS 吗？
A: 当前配置下，前端页面和后端 API 使用同一域名，无需额外配置 CORS。

### Q: 如何让 URL 固定不变？
A: 参考上方的"升级方案：固定域名（Named Tunnel）"，需要拥有域名并在 Cloudflare 管理。

### Q: 为什么不用 localtunnel 了？
A: Cloudflare Tunnel 更稳定、更快、自带 HTTPS，无需点击反钓鱼页面，支持 QUIC 协议。

EOF
