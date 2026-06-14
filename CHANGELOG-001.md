# CHANGELOG #001 — 答题卡系统 UX 增强 & 卡片管理

> 日期：2026-06-14
> 涉及：前端 (App.tsx, styles.css)、后端 (server/index.ts, CardRepository.ts)、数据层 (types.ts, schema.sql, db/index.ts)

---

## 1. 侧栏仅设计 Tab 显示 + 阅卷/分析全屏

- `App.tsx`：`showCardSidebar` 条件从 `canDesign || canGrade` 改为 `mode === "design"`
- `styles.css`：新增 `.no-card-sidebar` 规则，无侧栏时 shell 改为 `grid-template-columns: 1fr`
- 效果：切换到「阅卷」「分析」「账号管理」「我的成绩」时左侧栏隐藏，工作区全屏

## 2. 标题 & 图标更换

- 侧栏品牌标题：`答题卡设计系统` → `答题卡设计阅卷系统`
- 图标：从 CSS `::before` 渐变伪元素改为真实 `<img>` 标签
  - 图标文件：`resources/icon.png`（从用户桌面复制到项目）
  - CSS：移除 `.brand::before` / `.brand:hover::before`，新增 `.brand-icon` 样式
- 静态路由：`server/index.ts` 新增 `app.use("/resources", ...)`
- Vite 配置：`vite.config.ts` 代理新增 `/resources`

## 3. 答题卡 ID 改为确定性 8 位纯数字

- `shared/defaultCard.ts`：新增 **`generateCardId(subject)`**
  - 基于 `{subject}_{Date.now()}` 的 hash，取 10000000~99999999 范围
  - 同一科目+同一毫秒 → 同一 ID；不同毫秒 → 不同 ID
- `server/index.ts` `POST /api/cards`：前端传 `{ subject }`，后端据此生成 ID
  - 冲突时自动追加 `_N` 后缀重试（最多 100 次）
- `AnswerCard` 类型新增 `subject?: string` 字段
- `CardSummary` 类型新增 `subject?: string` 字段
- DB Schema：`answer_cards` 表新增 `subject TEXT` 列
- DB Migration：`db/index.ts` 自动为旧库添加 `subject` 列

## 4. 答题卡导出/导入/删除

### 导出
- **GET `/api/cards/:cardId/export`**
  - 返回 `.projectx-card.json` 文件，格式：
    ```json
    {
      "format": "projectx-card",
      "version": 1,
      "exportedAt": "...",
      "card": { /* 完整 AnswerCard，含 answerKey */ },
      "layout": { /* LayoutDocument 完整坐标 */ },
      "assets": { "asset_xxx.jpg": "base64..." }
    }
    ```
  - 答案（answerKey、multipleScoring）全部包含
  - 图片资产以 base64 内嵌，即插即用
- 前端：每个卡片右侧增加 **⬇ 导出按钮**，点击触发浏览器下载

### 导入
- **POST `/api/cards/import`**：接收 JSON body
  - 校验 `format === "projectx-card" && version === 1`
  - 用原 `subject` + 当前时间重新生成 ID（避免冲突）
  - 写入 SQLite + JSON 文件 + 解码 base64 写入 assets 目录
- 前端：侧栏底部新增 **「导入答题卡」** 按钮，选择 `.json` 文件上传

### 删除
- **DELETE `/api/cards/:cardId`**
  - 删除 SQLite 记录（CASCADE 级联删除子表）
  - 删除 `data/answer-card/cards/:id.json`
  - 删除 `data/answer-card/layouts/:id.json`
  - 删除 `data/answer-card/assets/:id/` 目录
  - 返回引用计数（如被考试引用，前端显示警告但不阻止删除）
- 前端：每个卡片右侧增加 **🗑 删除按钮**，点击 `confirm` 后执行

## 5. 设计器基本信息面板新增「科目」字段

- 「基本信息」面板在标题下方新增科目输入框
- 新建答题卡时侧栏提供科目输入框（必填），新建按钮关联科目
- `App.tsx` 新增 `cardSubject` 状态

## 6. 卡片列表 UI 改造

- 列表项从单 `<button>` 改为 `grid-template-columns: 1fr auto` 布局
- 主点击区保留（点击加载卡片），右侧新增导出/删除操作按钮
- 列表项显示 `科目 · ID:xxxx`（使用 subjectLabel 中文显示）

## 7. 设计 Tab 滚动修复 (2026-06-14 下午)

- `styles.css`：`.workspace` 新增 `max-height: 100vh; overflow: hidden;` 确保内容区高度受限
- 修复无法滚轮滚动查看设计页下方内容的问题

## 8. 新建答题卡改为 Modal 弹窗 (2026-06-14 下午)

### 删除原有侧栏科目输入
- 侧栏的科目输入框已删除，不再手动输入 subject key
- 点击「新建答题卡」按钮弹出 `NewCardModal` 模态框

### NewCardModal 组件
- **文件**：`src/apps/answer-card/client/components/NewCardModal.tsx`
- **科目选择**：
  - 9 个预设按钮：语文、数学、英语、物理、化学、生物、政治、历史、地理
  - 「其他」选项：选择后出现手动输入框，可输入自定义科目名
  - 自动识别：手动输入的科目名若命中上述 9 科 → 自动归类为预设科目
- **拼音转换工具**：`src/shared/pinyin.ts`
  - `subjectToKey()`：中文科目名 → 拼音 key（如 物理 → wuli）
  - 9 科固定映射 + 扩展字符逐字转拼音
- **考试名称**：必填，如「2026 上学期期中考试」
- **考试时间**：可选
  - 内联日历日期选择器（翻月、点击日期）
  - 支持直接输入 `YYYY-MM-DD` 格式
  - 支持模糊解析（如输入 `2026/6/14`）

### 数据模型更新
- `AnswerCard` 新增 `subjectLabel?: string`（中文科目名）、`examDate?: string`（考试日期）
- `CardSummary` 新增 `subjectLabel?: string`、`examDate?: string`
- DB：`answer_cards` 表新增 `subject_label TEXT`、`exam_date TEXT` 列（含自动 migration）
- 信息面板：基本信息区显示科目和考试时间（只读，创建时确定）

### Modal 样式
- `styles.css` 新增 `.modal-backdrop`、`.modal-card`、`.modal-header`、`.modal-close`、`.modal-body`、`.modal-footer`
- 毛玻璃背景 + slideUp 动画入场

## 9. 答题卡默认单面 (2026-06-14 下午)

- `defaultCard.ts`：`sided` 默认值从 `"double"` 改为 `"single"`
- `schema.sql`：`sided` 列 DEFAULT 从 `'double'` 改为 `'single'`

## 10. 登录「记住密码」6个月免登录 (2026-06-14 下午)

### 后端
- `AuthService.ts`：新增 `PERSISTENT_TOKEN_EXPIRE_MS = 180天`
- `login()` 方法接受 `isPersistent` 参数，选中时签发 6 个月有效期 token
- `auth.ts` 路由：从请求 body 读取 `isPersistent` 字段

### 前端
- `AuthContext.tsx`：`login()` 签名新增 `isPersistent?: boolean` 参数
- `LoginPage.tsx`：
  - 新增「记住密码（6个月内免登录）」复选框（默认勾选）
  - 品牌标题同步更新为「答题卡设计阅卷系统」
- `styles.css`：新增 `.login-remember` 样式

### 机制
- token 保存在 `localStorage`，App 启动时自动检测 → 调用 `/api/auth/me` 验证
- 6 个月内 token 有效则跳过登录页直接进入
- 退出登录时清除 token

## 11. 登录页文案精简 (2026-06-14 下午)

- 删除底部的「首次使用默认管理员：admin / admin123，登录后请立即修改密码」提示
- 用户名输入框 placeholder 从 `admin 或学号` 改为 `请输入用户名 / 学号`

## 12. Topbar 布局修复：Tab栏固定右侧 (2026-06-14 下午)

- 按钮组（坐标JSON、PDF、保存）从右侧移到中间区域，不再挤占 Tab 空间
- Tab 切换栏和 AccountMenu 固定在 topbar 最右侧，切换 tab 时位置永不跳动
- `topbar` CSS：移除 `justify-content: space-between`，改用三段式 flex（标题/按钮组/tab栏）
- 新增 `.topbar-actions-left` 样式

## 13. Token 磁盘持久化 (2026-06-14 下午)

- `AuthService` token 存储从内存 Map 改为 `~/.projectx/tokens.json` 磁盘文件
- 启动时自动加载未过期的 token → 服务器重启不影响已登录用户
- 创建/删除/吊销/清理 token 时自动写入磁盘（`setImmediate` 合并短时多次写入）
- 保证：勾选「记住密码」后，6 个月内无论重启多少次软件和服务器，都无需重新登录

## 涉及文件清单

| 文件 | 改动 |
|------|------|
| `src/shared/types.ts` | AnswerCard + CardSummary 新增 subject, subjectLabel, examDate |
| `src/shared/defaultCard.ts` | 新增 generateCardId()，createDefaultCard 签名变更，sided 默认 single |
| `src/shared/pinyin.ts` | **新增**：中文科目名 → 拼音 key 转换工具 + 预定义科目常量 |
| `src/server/services/AuthService.ts` | login() 支持 isPersistent，签发 6 个月 token |
| `src/server/routes/auth.ts` | login 路由读取 isPersistent |
| `src/server/repositories/CardRepository.ts` | CRUD 支持 subject/subjectLabel/examDate 字段 |
| `src/server/db/schema.sql` | answer_cards 表新增 subject/subject_label/exam_date 列，sided 默认 single |
| `src/server/db/index.ts` | DB 自动 migration 加三列 |
| `src/apps/answer-card/server/index.ts` | 新增 DELETE/EXPORT/IMPORT 路由；POST /api/cards 改接 subject+title+examDate；/resources 静态路由 |
| `src/apps/answer-card/client/App.tsx` | 侧栏条件、标题文字/图标、卡片操作按钮、导入/导出/删除函数、NewCardModal 集成、移除侧栏科目输入 |
| `src/apps/answer-card/client/auth/AuthContext.tsx` | login() 支持 isPersistent 参数 |
| `src/apps/answer-card/client/components/NewCardModal.tsx` | **新增**：新建答题卡弹窗（科目选择 + 考试名称 + 日期选择器） |
| `src/apps/answer-card/client/components/LoginPage.tsx` | 新增「记住密码」复选框，品牌标题更新 |
| `src/apps/answer-card/client/styles.css` | brand icon、card-list 操作按钮、no-card-sidebar 布局、滚动修复、modal 样式、login-remember 样式 |
| `vite.config.ts` | 代理新增 /resources |
| `resources/icon.png` | 新增图标文件 |

---

## 向后兼容

- 旧卡片无 `subject` 字段 → 自动为 `null`/`undefined`，列表显示「未知科目」
- 旧数据库自动 migration 添加 `subject` 列
- 旧卡片导出时 `subject` 为 null，导入后会提示但不会报错
- ID 格式不变：仍是 8 位纯数字字符串
