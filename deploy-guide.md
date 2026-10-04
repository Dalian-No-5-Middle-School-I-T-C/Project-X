# Project-X 成绩分析系统 · 小程序上线部署指南

> 本指南说明 Project-X 后端部署与学生端小程序（独立仓库 [X-exam](https://github.com/Dalian-No-5-Middle-School-I-T-C/X-exam)）的上线步骤。

---

## 一、前置条件检查清单

| 项目 | 要求 | 说明 |
|------|------|------|
| 小程序主体 | 个人主体即可（以微信平台类目审核为准） | 学生端为原生页面，无需 `web-view` 企业认证 |
| 服务器 | 有公网 IP 或域名 | 用于部署后端 API + 静态网页 |
| 域名备案 | 国内服务器需 ICP 备案 | 微信小程序强制要求 |
| HTTPS | 必须 | 小程序只支持 HTTPS 业务域名 |
| 后端 | 已运行 Project-X 服务 | 本指南基于现有 Node.js + SQLite 后端 |

---

## 二、后端部署（Project-X 服务）

### 2.1 确认后端已运行

在服务器上进入项目目录，启动后端服务：

```bash
cd /path/to/Project-X-main
npm install
npm run server
# 或: npx tsx src/apps/answer-card/server/index.ts
```

默认监听 **5174 端口**（`127.0.0.1:5174`）。如果需要在公网访问，请修改启动参数：

```bash
PORT=5174 HOST=0.0.0.0 npx tsx src/apps/answer-card/server/index.ts
```

### 2.2 使用 Nginx 反向代理（推荐）

把 `5174` 端口反向代理到域名，并配置 HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name api.your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # 安全审计（F-12-2）：隐藏 Nginx 版本号
    server_tokens off;

    # 请求体上限与后端 8MB 保持一致（上传答题卡图片场景）
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:5174;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**关键配置项：**
- `proxy_set_header` 必须保留，确保后端能读取到 `X-Forwarded-Proto` 用于 HTTPS 判断
- `server_tokens off` 隐藏 Nginx 版本号；`client_max_body_size` 与后端上传限制保持一致
- 静态站点若部署于 Nginx 根目录，**严禁将项目根目录或 `data/`（含 SQLite 库）作为站点根目录**，否则数据库文件可被直接下载
- 如需 HSTS，可在 443 server 块内追加 `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`
- 如果前端网页和后端使用**同一域名**，需要把前端静态文件也放到这个 Nginx 配置中（见下一节）
- **扫描端接入必须走 HTTPS**（安全 R32）：开启 `PROJECTX_ENABLE_SCANNER_CLIENT_API=1` 后，
  扫描端在「服务器连接」里填的地址若是**跨机明文 http**，客户端会**拒绝发送 API Key**，
  上传按配置错误立即失败（这把 Key 能向服务器写入扫描结果，明文过网段等于交给同网段任何人）。
  因此对外提供扫描接入的部署必须配好 443 与证书，把 `https://` 地址发给扫描端；
  只有本机 `127.0.0.1` / `localhost` 的明文地址不受限。隔离的内网测试环境可由操作者在扫描端
  显式勾选「允许向该地址明文发送凭据」，该许可按 `host:port` 记录、换地址不继承。
  不带凭据的 `/api/app/health` 探测始终放行，所以扫描端仍能区分「服务器不可达」与「服务器可达但凭据被拦下」。

---

## 三、前端网页部署

### 3.1 部署方式选择

| 方式 | 适用场景 | 操作难度 |
|------|----------|----------|
| **同域部署（推荐）** | 前后端共用同一个域名 | 低 |
| **跨域部署** | 网页和后端分别在不同域名 | 中（需配置 CORS） |

### 3.2 同域部署（推荐）

把 `Grade-Analysis-System-mobile.html` 放到 Project-X 的 `dist/web` 目录中，或直接放到 Nginx 的静态目录：

```bash
# 假设 Nginx 根目录为 /var/www/project-x
cp Grade-Analysis-System-mobile.html /var/www/project-x/
```

确保 Nginx 配置中有静态文件服务：

```nginx
location / {
    root /var/www/project-x;
    try_files $uri $uri/ /index.html;
    # 静态页面不经 Express，需由 Nginx 补安全响应头（API 响应已由后端统一添加）
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
}

location /api/ {
    proxy_pass http://127.0.0.1:5174;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

媒体资源（图片 / PDF / SSE）在跨域模式下只能用 URL 携带凭据，后端已把它收紧为**短命、绑定路径的单次票据**
（`?mt=…`，默认 5 分钟；默认主令牌 `?token=` 仅对白名单媒体路径放行，其余接口一律要求 `Authorization` 头）。
票据与令牌仍会出现在查询串里，而 nginx 的 `access_log` 默认记录完整请求行，因此**请把查询串从访问日志里去掉**：

```nginx
# 只记路径、不记查询串：避免票据与历史 ?token= 落进日志
log_format px_noquery '$remote_addr - $remote_user [$time_local] '
                      '"$request_method $scheme://$host$uri $server_protocol" '
                      '$status $body_bytes_sent rt=$request_time';
access_log /var/log/nginx/access.log px_noquery;
```

后端自身的日志已对 `token` / `mt` / `api_key` 等查询参数与 `Authorization` 头做截断脱敏，
但代理日志归部署方管。可用档位与行为口径见 [README.md](README.md) 的「URL 凭据换成单次媒体票据」。

访问地址：
```
https://your-domain.com/Grade-Analysis-System-mobile.html
```

### 3.3 跨域部署

如果网页和后端使用不同域名，需要在后端开启 CORS。后端通过环境变量 `PROJECTX_CORS_ORIGIN` 配置允许的前端域名白名单（逗号分隔），例如：

```bash
PROJECTX_CORS_ORIGIN=https://your-frontend-domain.com
```

未设置时默认仅允许本机调试地址。学生端小程序使用原生 `wx.request` / `downloadFile`，不受浏览器 CORS 限制，无需加入白名单。

并在 `Grade-Analysis-System-mobile.html` 里**由部署方写死后端地址**（安全 R12）：编辑该文件头部的
`<meta name="px-api-base">`，把 `content` 填成你的 API 域名；同源部署留空即可。

```html
<!-- 跨源部署：写死 https 后端地址 -->
<meta name="px-api-base" content="https://your-api-domain.com">
```

> **不要用 URL 参数指定后端**。页面曾支持 `?api_base=...`，而它会把浏览器本地保存的会话令牌
> 以 Bearer 发往该参数指定的主机——任何人转发一条带 `api_base` 的链接，就能收走点开它的人的凭据。
> 现在该参数一律被忽略，页面会在底部提示「api_base 参数已被忽略」；非 https 的跨源配置同样被拒绝。

---

## 四、微信小程序配置

学生端小程序为独立仓库 [X-exam](https://github.com/Dalian-No-5-Middle-School-I-T-C/X-exam)（原生 `wx.request` / `downloadFile`，不使用 `web-view`）：

1. 注册小程序账号并获取 **AppID**（个人主体即可，无需企业认证；具体以微信平台类目审核为准）。
2. 在「开发」→「开发管理」→「开发设置」→「服务器域名」中，把后端域名加入 **request** 与 **downloadFile** 合法域名。
3. 用微信开发者工具导入 X-exam 仓库，确认 `project.config.json` 中的 AppID（仓库已配置；如使用自己的小程序，替换为你的 AppID）后编译预览。

---

## 五、小程序提审与上线

### 5.1 预览测试

在开发者工具中：
1. 点击「真机调试」→ 扫码在手机上测试
2. 输入你的服务器地址，点击「进入系统」
3. 检查数据加载、登录、图表显示是否正常

### 5.2 提交审核

1. 在开发者工具中点击「上传」
2. 登录微信公众平台 →「版本管理」→「开发版本」
3. 点击「提交审核」
4. 填写审核信息：
   - 标题：Project-X 成绩分析系统
   - 服务类目：教育 - 在线教育（或教育信息服务）
   - 标签：成绩查询、考试分析、教学管理
   - 简介：面向教师和学生的成绩查询与考试分析工具

### 5.3 审核通过后发布

审核通常需要 **1-3 个工作日**。通过后：
1. 在「版本管理」中点击「提交发布」
2. 选择全量发布或灰度发布

---

## 六、数据对接验证（关键步骤）

### 6.1 检查后端 API 是否正常

在浏览器直接访问：

```
https://your-domain.com/api/exams
```

应该返回 JSON 格式的考试列表。如果返回 404 或 500，请检查后端路由是否正确挂载。

### 6.2 检查登录接口

网页版登录时，浏览器开发者工具 Network 面板应看到：

```
POST /api/auth/login
Body: { identifier: "xxx", password: "xxx" }
Response: { token: "Bearer ...", user: {...} }
```

如果返回 401，请检查 `PROJECTX_AUTH_ENFORCE` 环境变量是否开启。

### 6.3 检查成绩分析接口

```
GET /api/analysis/exams/1/overview
GET /api/analysis/exams/1/students
GET /api/analysis/exams/1/questions
```

确保数据库中已有 `exams` 表数据和学生成绩数据。如果数据为空，页面会显示 0 或空白图表。

---

## 七、常见问题排查

### Q1: 小程序页面空白或接口报错

- 检查「服务器域名」中是否已配置后端的 request / downloadFile 合法域名
- 检查 `project.config.json` 中的 AppID 是否已替换
- 检查后端是否 HTTPS 且可公网访问

### Q2: 网页提示「后端连接失败」

- 检查 `api_base` 参数是否正确传递
- 检查后端服务是否运行且可被公网访问
- 检查 Nginx 反向代理是否把 `/api/` 请求转发到后端

### Q3: 登录后页面不跳转或提示 token 过期

- 检查后端 `/api/auth/me` 是否返回正确结构
- 检查浏览器 localStorage 是否有 `px_token`
- 如果是跨域，检查 CORS 是否允许 `Authorization` 头

### Q4: 排名/班级数据不显示

- 后端 `AnalysisRepository` 依赖 `class_students` 表关联。如果学生没有绑定班级，缓存会为空，班级列显示为空字符串
- 在后台管理页面把学生分配到班级即可

### Q5: 个人主体小程序能否使用

- 可以。学生端已改为原生页面（X-exam 仓库），不依赖 `web-view`，个人主体即可发布（以微信平台类目审核为准）。

---

## 八、文件清单

| 文件 | 说明 | 位置 |
|------|------|------|
| `Grade-Analysis-System-mobile.html` | 改造后的成绩分析网页（支持移动端 + API 接入） | 项目根目录 |
| X-exam 仓库 | 学生端小程序（独立仓库） | [github.com/Dalian-No-5-Middle-School-I-T-C/X-exam](https://github.com/Dalian-No-5-Middle-School-I-T-C/X-exam) |
| `deploy-guide.md` | 本部署指南 | 项目根目录 |

---

## 九、安全与合规建议

1. **HTTPS 强制**：生产环境务必使用 HTTPS，避免 token 被中间人截获
2. **Token 有效期**：建议后端设置 token 过期时间（如 7 天），并支持刷新
3. **数据隐私**：学生成绩属于敏感数据，小程序审核时可能需要提供「隐私保护协议」
4. **访问控制**：确保后端 `PROJECTX_AUTH_ENFORCE=1` 已开启，防止未授权访问成绩数据
5. **备案**：国内服务器必须完成 ICP 备案，否则微信会拒绝业务域名配置
6. **生产库不要留演示数据**（安全 R33/R48）：演示账号口令默认每次导入随机换发、演示教师范围收敛为
   「任课教师 + 两个演示班级」，但演示数据本身就是 16 个可登录账号，验收完请用「清除演示数据」移除。
   `PROJECTX_DEMO_FIXED_CREDENTIALS`（恢复文档里的 `teacher123` / 口令=学号）与
   `PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT`（跳过「库中已有真实数据」的二次确认）**只应在隔离测试环境打开**；
   生产环境保持未设即可，两个开关取值非法时一律按关闭处理。

---

祝上线顺利！如有问题，请检查浏览器控制台和微信开发者工具的控制台日志。
