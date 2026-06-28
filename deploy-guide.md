# Project-X 成绩分析系统 · 小程序上线部署指南

> 本指南教你如何把 `Grade-Analysis-System-mobile.html` 接入 Project-X 后端，并通过 **微信小程序 web-view** 方式上线发布。

---

## 一、前置条件检查清单

| 项目 | 要求 | 说明 |
|------|------|------|
| 小程序主体 | **企业 / 组织 / 政府** | 个人类型小程序无法使用 `web-view` 组件 |
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
- 如果前端网页和后端使用**同一域名**，需要把前端静态文件也放到这个 Nginx 配置中（见下一节）

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
}

location /api/ {
    proxy_pass http://127.0.0.1:5174;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

访问地址：
```
https://your-domain.com/Grade-Analysis-System-mobile.html
```

### 3.3 跨域部署

如果网页和后端使用不同域名，需要在后端开启 CORS。修改 `src/apps/answer-card/server/index.ts`，在路由前添加：

```typescript
import cors from 'cors';

app.use(cors({
  origin: ['https://your-frontend-domain.com', 'https://your-miniprogram-domain.com'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));
```

并在 `Grade-Analysis-System-mobile.html` 的 URL 中通过 `?api_base=...` 指定后端地址：

```
https://your-frontend-domain.com/Grade-Analysis-System-mobile.html?api_base=https://your-api-domain.com
```

---

## 四、微信小程序配置

### 4.1 注册与认证

1. 登录 [微信公众平台](https://mp.weixin.qq.com)
2. 注册小程序账号，选择 **企业/组织/政府** 主体类型
3. 完成主体认证（需企业营业执照或组织机构代码证）
4. 在「开发」→「开发管理」→「开发设置」中获取 **AppID**

> ⚠️ **重要**：个人主体小程序无法使用 `web-view`，请务必确认主体类型。

### 4.2 配置业务域名

1. 进入「开发」→「开发管理」→「开发设置」→「服务器域名」
2. 在 **request 合法域名** 中添加你的后端域名：
   ```
   https://your-domain.com
   ```
3. 在 **业务域名（webview）** 中添加你的前端网页域名：
   ```
   https://your-domain.com
   ```
4. 下载「校验文件」并上传到网站根目录（微信会验证域名所有权）

### 4.3 导入小程序项目

1. 下载并安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 打开开发者工具，选择「导入项目」
3. 选择 `miniprogram` 目录
4. 填入你的 **AppID**（在 `project.config.json` 中把 `wxYOURAPPIDHERE` 替换）
5. 点击「编译」预览效果

### 4.4 修改小程序配置

打开 `miniprogram/project.config.json`，替换 AppID：

```json
{
  "appid": "wx1234567890abcdef",
  "projectname": "project-x-grade-analysis"
}
```

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

### Q1: 小程序中打开网页空白或报错

- 检查「业务域名」是否已配置并通过验证
- 检查网页是否为 HTTPS
- 检查 `web-view` 的 `src` 地址是否正确编码

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

### Q5: 个人类型小程序无法使用 web-view

- **无解**。必须注册企业/组织主体才能使用 `web-view`。
- 替代方案：将页面重写为小程序原生页面（WXML/WXSS/JS），但工作量极大。

---

## 八、文件清单

| 文件 | 说明 | 位置 |
|------|------|------|
| `Grade-Analysis-System-mobile.html` | 改造后的成绩分析网页（支持移动端 + API 接入） | 项目根目录 |
| `miniprogram/` | 微信小程序项目代码 | 项目根目录 |
| `deploy-guide.md` | 本部署指南 | 项目根目录 |

---

## 九、安全与合规建议

1. **HTTPS 强制**：生产环境务必使用 HTTPS，避免 token 被中间人截获
2. **Token 有效期**：建议后端设置 token 过期时间（如 7 天），并支持刷新
3. **数据隐私**：学生成绩属于敏感数据，小程序审核时可能需要提供「隐私保护协议」
4. **访问控制**：确保后端 `PROJECTX_AUTH_ENFORCE=1` 已开启，防止未授权访问成绩数据
5. **备案**：国内服务器必须完成 ICP 备案，否则微信会拒绝业务域名配置

---

祝上线顺利！如有问题，请检查浏览器控制台和微信开发者工具的控制台日志。
