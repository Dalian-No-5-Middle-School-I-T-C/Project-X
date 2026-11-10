# Project-X | 五中智能试卷管理系统

<p align="center">
  <img src="https://img.shields.io/badge/version-2.7.1-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20MariaDB-green.svg" alt="Platform">
  <img src="https://img.shields.io/badge/license-GPLV3.0-yellow.svg" alt="License">
  <img src="https://img.shields.io/badge/tech-React%20%7C%20Node.js%20%7C%20C%2B%2B%20%7C%20SQLite%20%7C%20MariaDB%20%7C%20Electron-9cf.svg" alt="Tech Stack">
</p>

## 项目简介

**Project-X** 是大连市第五中学信息化部（I.T.C.）自主开发的智能试卷管理工具，旨在解决学校长期依赖外包扫描答题卡与阅卷系统所带来的**报错频繁、费用高昂、受制于人**等核心痛点。

本项目由信息化部成员 **1g NaOH、火箭、云墨丹心、近代先人、CH（往届学长）** 牵头推进，从零开始构建一套属于学校自己的、可自主可控的答题卡设计与阅卷解决方案。

> **项目起点**：2026-06-07 建库（v0.1.0 于 06-08 打包，v1.0.0 于 06-12 打标）
> **当前版本**：v2.7.1（版本历史见 [CHANGELOG.md](./readus/CHANGELOG.md)）
> **核心能力**：Home 仪表盘 → 答题卡设计 → PDF 导出 → 扫描仪直扫 → 自动识别判分 → 大题切块与整卡订正 → 网上阅卷（2P/3P 多评 + 争议仲裁 + 断点续批 + 批注系统）→ 考试管理（晨测/大考双模式 + 大考组）→ 成绩分析（难度 P / 区分度 D、总体正态性检验、学期与历次对比、知识点弱项诊断）→ 赋分引擎与自定义导出 → 教师/学生/班级管理 → AI 学情与知识点分析 → 原卷与逐题答案展示 → 成绩发布微信订阅提醒 → 多端响应式与双皮肤主题（纸锋 Paper Edge / 明澈 Flat 2.0）
> **下个里程碑**：TBD

我们的爱发电地址：https://ifdian.net/a/ProjectX
---

## 为什么要做这个项目？

大连市第五中学在考试阅卷工作中长期采用第三方外包服务，在实际使用中遇到了以下问题：

| 痛点 | 具体表现 |
|------|----------|
| **报错频繁** | 外包系统对答题卡格式要求苛刻，稍有偏差即导致扫描失败或识别错误 |
| **费用高昂** | 按次或按年收费，随着考试频次增加，成本持续累积 |
| **受制于人** | 无法自主修改答题卡模板，特殊需求响应慢，数据隐私存疑 |
| **体验割裂** | 不同考试需要反复适应不同系统，教师操作成本高 |

**Project-X 的目标**：让学校拥有完全自主的答题卡生成与阅卷能力，一次开发，长期受益，数据本地可控。

---

## 功能特性

### 网上阅卷系统

- **Home 仪表盘**：登录后进入图形化首页，提供模块卡片与快捷入口（继续阅卷 / 最新考试），底部 Tab 栏可按需开关
- **任务分配引擎**：年级组长为每个题块分配教师和份数，系统随机分配（Fisher-Yates 算法），教师进入考试后自选题块
- **2P/3P 多评**：支持单评、双评或三评独立打分，分差超阈值自动进入争议；支持 5 种取整方式（ceil / floor / round / half / none），每道题可单独配置
- **PAD 优先阅卷 UI**：左图右分，大按钮打分，滚轮缩放，90° 旋转，支持文字与手写批注（含防误触），学生端可查看批注
- **打分面板双模式**：满分 < 20 采用枚举大按钮直接点分；满分 ≥ 20 采用「十位 + 个位 + 十分位」位值合成；支持 0.5 分步进，点选即提交并自动跳下一卷
- **争议仲裁与工作量均衡**：争议卷可交由指定仲裁人或自动改派给未评过该生的教师；分配后自动平衡各教师待阅份数
- **断点续批与阅卷溯源**：退出自动保存进度和草稿分数；每名学生每轮评审人与分数全程可追溯
- **三层设置体系**：支持个人偏好（账号设置）、单场考试题块级网阅设置（含默认模板）与管理员全局策略分级管理

### 答题卡设计

- **答题卡管理**：新建（科目选择、考试名称、考试日期，支持同步创建或关联考试）、保存、读取、导出、导入、删除答题卡
- **学科模板**：语文、英语、数学、物理、化学、生物可自动生成常用题块；英语可选是否包含听力，语文可选选择题集中卷首或按题号穿插
- **确定性 ID**：基于科目 + 时间戳生成 8 位数字 ID，导入时自动生成新 ID 防冲突
- **导出/导入**：`.projectx-card.json` 格式，含标准答案、配图与坐标布局，即插即用
- **A4 标准版式**：含标题、定位标记、学生信息区、学号填涂区、二维码、题块与页码，坐标精确到毫米
- **客观题设计**：
  - 支持单选、多选、不定项，可按题配置题号、题型、选项数、分值和标准答案
  - 多选支持按选对项数、按正确答案总数分档、固定部分分等规则
  - 支持横向排列与高考 AB 卡式竖向排列（4 题一组纵向排布）
- **主观题设计**：
  - 支持带分数填涂区的手工给分样式（十位 / 个位 / 十分位）
  - 支持纯书写块、填空题（阿拉伯/罗马数字序号）、解答题内小空、横线格、空白大框及插图
- **PDF 导出**：毫米级精确标准 A4 PDF，导出前自动校验答题卡版本一致性，直接打印
- **单/双面支持**：标记答题卡为单面或双面，扫描与阅卷时自动过滤空白背面
- **删除保护**：答题卡被考试引用时先提示冲突，可选择解绑考试或连同考试一起删除

### 阅卷识别

- **批量识别判分**：上传或扫描多张答题卡图片，自动完成：
  - 客观题：选项填涂检测 + 标准答案对比判分
  - 主观题：红笔手写分数格识别
  - 学号与页码：二维码及数字填涂网格识别
- **多页合并评分**：双面卡 / 多页卡自动合并各页成绩，汇总总分
- **整卡订正与预览**：按学生聚合展示全部页面，支持旋转浏览、学号/客观题/分数格可视化点选订正与旧卷补识别
- **大题作答图片切块**：识别成功后按题块坐标自动裁剪主观题作答图片（跨页大题自动生成续页切图），供网上阅卷、教师改分与学生查分使用
- **低置信度标记**：置信度偏低的题目或分数格自动标记「待复核」
- **Excel (.xlsx) 导出**：一键导出成绩明细表

### 扫描仪直扫

- **高速扫描仪支持**：通过 C++ TWAIN 原生桥直接驱动柯达 i3000 等高速扫描仪
- **双屏工作流**：答题卡选择页（单科 / 大考双 Tab）→ 扫描工作台（直扫 + 图片导入阅卷 + 异常卷后处理）
- **本地/远程双模**：本地模式直接识别入库 SQLite；远程模式通过 API Key 与 HTTPS 鉴权，将扫描会话、原卷页与题块切图同步至 Ubuntu 服务端
- **实时进度与告警**：SSE 实时推送扫描进度、逐页缩略图、DPI 与红笔识别诊断告警

### 成绩分析

- **考试选择页**：支持 [单科 | 大考 | 跨考] 三模式切换，单科按学年/年级/学科筛选，大考管理多科合集，跨考支持按周打包、自选合并与已存组分析
- **大考组管理**：创建多科联考合集（如语数英物化生），关联或内联新建子考试，支持拖拽排序与级联管理
- **六维分析视图**：
  - **概况 Tab**：核心统计卡片（人数 / 均分 / 最高 / 最低 / 及格率 / 优秀率 / 标准差）、**难度系数 P / 区分度 D** 指标卡、分数段分布图、箱型图、年级前五/后五与进退步榜单
  - **成绩 Tab**：含校排、班排、名次变化、偏差值、Z 值、百分位，支持排序、搜索与大考「合并 / 分科」视图切换
  - **题目分析 Tab**：逐题得分率、正确率、平均分、难度 P 与区分度 D 彩色档位徽章（阈值可由管理员在全局设置中自定义），支持点击下钻查看单题全体学生得分明细
  - **班级对比 Tab**：选择基准班级对比各班均分差值，大考下支持逐科班级均分对比
  - **总体分析 Tab**：直方图（叠加正态曲线）、Q-Q 图与正态性检验（Shapiro-Wilk / KS / AD / 偏度 / 峰度）
  - **AI 分析 Tab**：支持 GPT / DeepSeek / Gemini 多服务商（由管理员统一配置系统服务商），自动结合统计指标生成学情诊断报告
- **并列排名**：全系统统一采用同分并列排名（1, 2, 2, 4, 5...），覆盖单科、大考、跨考与导出
- **赋分引擎**：内置等级赋分与线性换算预设，支持化学、生物、地理、政治等科目一键赋分重算
- **成绩修改与重算**：支持单生逐题改分与全卷标准答案修改，修改后自动重算总分、赋分与排名
- **成绩公布控制**：批改完成后成绩默认不公布，由教师手动公布或撤回；支持部分成绩先行公布（缺考或异常卷待处理不阻塞已出分学生查分），管理员可配置改分后保持公布或自动撤回
- **原卷与逐题答案**：支持上传试卷原卷（DOCX / PDF / 图片）与配置逐题标准答案（文字录入 / AI 知识点提取 / 原文件展示），导出前提供分值、原卷与知识点三步检查
- **灵活导出**：支持胶囊拖拽自定义导出列、4 个导出模板槽、A4 超页预警，大考支持一键导出汇总与分科小分 ZIP 包

### 账户与安全

- **三级 RBAC 权限体系**：管理员、教师、学生三级角色，细粒度控制设计、阅卷、分析、用户与班级管理权限
- **教师细分角色与数据范围隔离**：支持「学科老师」「班主任」「学年主任」细分角色，后端对花名册、应考名单、考试管理与题块阅卷执行严格的数据范围校验（详见 [ACCOUNT-CONTROL.md](./readus/ACCOUNT-CONTROL.md)）
- **考试可见模式**：支持「晨测（全体教师可见）」与「大考（按任教与角色精细授权）」双模式切换
- **持久会话**：支持记住登录状态与一次性初始密码强制改密保护
- **双皮肤与明暗主题**：内置「纸锋 Paper Edge」（默认）与「明澈 Flat 2.0」两套视觉皮肤，均支持亮色/暗色模式，偏好随账号跨设备同步（详见 [SKIN-THEME.md](./readus/SKIN-THEME.md)）

### 学生功能

- **我的成绩**：查看已公布考试的各科成绩、大题作答切图与批注、原卷与标准答案、排名趋势图、学科雷达图及**本学期 vs 上学期对比**
- **成绩天梯**：年级前十榜单（支持单场考试、大考组、跨考累计三种维度，同分并列完整展示），管理员可随时开关
- **成绩发布提醒**：支持微信小程序一次性订阅消息，成绩公布时自动推送通知
- **AI 个人学情分析**：生成学生个人学科优劣势与知识点薄弱项诊断报告

### 桌面应用与服务端打包

- **Windows 扫描端**：Electron 桌面应用，专用于扫描仪直扫、批量识别、整卡订正与远端上传，提供 64 位（`x64`）与 32 位（`ia32`）的便携版 EXE 及 MSI 安装包
- **Web 端服务**：教师与学生通过浏览器直接访问 Ubuntu 服务端部署的 Web 页面，无需安装桌面客户端
- **产物完整性校验**：打包命令自动在 `release/` 下生成 `SHA256SUMS.txt` 与 `BUILD-INTEGRITY.txt`（可通过 `certutil -hashfile <安装包> SHA256` 或 `npm run release:hash:check` 校验）
- **备案信息配置**：打包 Ubuntu 服务端时，若仓库根目录存在 `beian.local.json`（含 `icp` / `publicSecurity`），会自动打入 `dist/web/beian.json`；未配置时自动隐藏备案页脚
- **支持项目**：账号菜单内置赞助支持入口，由 JSON 配置驱动收款码展示（详见 [SPONSOR-PAGE.md](./readus/SPONSOR-PAGE.md)）

> 多端部署与使用说明见 [`readus/多端使用说明.md`](./readus/多端使用说明.md)，CI 构建、代码签名与发版流程见 [`readus/发布构建与服务器更新时间.md`](./readus/发布构建与服务器更新时间.md)。

---

### 移动端 Web 适配

教师与学生在手机、平板浏览器上即可完整使用系统核心功能：

- **三级响应式断点**：统一为 `480px`（手机）/ `768px`（平板）/ `1024px`（桌面），由 `client/breakpoints.ts` 与 `useMediaQuery` 统一管理
- **自适应导航**：`<1024px` 顶栏提供 `Sheet` 侧边抽屉导航；`≤480px` 手机端额外提供底部快捷导航栏
- **表格卡片化与触控优化**：手机端自动将宽表格转换为 `DataCard` 卡片列表，弹窗采用底部抽屉样式并适配 iOS 安全区与触控热区

---

## 架构与设计体系

### 前端架构与设计系统

- **Vite + React 19 + TypeScript** 单仓多目标构建：`dist/web/`（教师 + 学生 Web 端）与 `dist/scanner/`（Electron 扫描工作台）共用同一组件库与主题；扫描端通过 `data-density="compact"` 启用紧凑密度。
- **路由与 mode 映射**：每个功能对应独立 URL，映射关系收敛在 `client/modeRoutes.ts`（`MODE_PATH` / `pathToMode`），支持 URL 深链、新标签页打开与刷新保持当前页；多端变体与可用路由集合定义在 `src/shared/appVariant.ts`。
- **样式与组件唯一事实源**：样式统一由 `src/apps/answer-card/client/theme/app.css`、`theme/tokens.css` 与 `theme/backdrop.css` 管理；基础 UI 组件统一从 `src/apps/answer-card/client/components/ui/v2/` 桶文件具名导出。
- **令牌三处同步**：`design/tokens/tokens.css` ↔ `app.css @theme` ↔ `client/theme.ts`，通过 `scripts/sync-tokens.mjs` 保持一致。
- **多皮肤与明暗主题**：支持 `paper-edge`（纸锋 Paper Edge，默认）与 `flat`（明澈 Flat 2.0）两套皮肤，均支持亮色/暗色模式，扩展方式详见 [SKIN-THEME.md](./readus/SKIN-THEME.md)。

### 架构与设计文档

| 文档 | 说明 |
|------|------|
| [readus/ARCHITECTURE.md](./readus/ARCHITECTURE.md) | 系统总体架构、分层、数据流、原生模块、构建部署与环境变量速查 |
| [readus/UI-ARCHITECTURE.md](./readus/UI-ARCHITECTURE.md) | v2 组件体系、主题令牌、样式分层与新 UI 开发规范 |
| [design/DESIGN-SYSTEM.md](./design/DESIGN-SYSTEM.md) | Flat 2.0「明澈 Clarity」美学规格（令牌架构、组件规格、设计原则） |
| [design/tokens/tokens.css](./design/tokens/tokens.css) | 主题令牌事实源（L1 原始 / L2 语义 / L3 组件） |
| [design/demo/demo.html](./design/demo/demo.html) | 交互 Demo（8 视图 × 亮暗双主题），视觉验收基准 |
| [design/designer-sandbox.html](./design/designer-sandbox.html) | 设计器沙盒 |

---

## 快速开始

### 普通用户

#### 方式一：便携版 EXE（推荐临时使用）

前往 [GitHub Releases](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/releases) 按需下载对应架构的扫描端程序（64 位 Windows 选择 `x64`，32 位 Windows 选择 `ia32`）：

```text
答题卡扫描端-<版本>-x64.exe
答题卡扫描端-<版本>-ia32.exe
```

#### 方式二：MSI 安装包（推荐机房部署）

Releases 同时提供 `x64` 与 `ia32` 的 MSI 安装包，适合学校机房、域控、组策略等集中部署场景。教师与学生日常使用请直接通过浏览器访问服务器部署的 Web 端。

#### 基本使用流程

**设计答题卡**：
1. 打开 Web 端 → 点击「新建答题卡」→ 选择科目、填写考试名称和考试日期
2. 编辑标题、题块、标准答案 → 保存 → 导出 PDF → 打印

**阅卷判分**：
1. 扫描端：选择答题卡 → 扫描工作台直扫或导入图片 →「开始识别判分」→ 整卡订正异常卷 → 上传或导出成绩
2. Web 端：「考试管理」→ 选择考试 → 点「网阅」→「阅卷」Tab 选题块 → 逐卷打分（支持 2P/3P 多评与争议仲裁）

**查看分析**：
1. 切到「分析」页面 → 选择单科考试、大考组或跨考组合 → 查看概况、成绩、题目分析、班级对比、总体分析与 AI 分析
2. 点击「导出」→ 选择导出模板或自定义列 → 下载 Excel (.xlsx) 或大考汇总 ZIP 包

---

### 开发人员

#### 环境要求

- **操作系统**：Windows（完整桌面扫描端与 TWAIN 开发）或 Linux / macOS（Web 端与服务端开发）
- **Node.js**：`>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1`（推荐使用 Node.js 24 LTS）
- **C++ 工具链（可选，重编原生识别器与扫描桥时需用）**：Visual Studio 2022 / MinGW-w64 + OpenCV 4.13+

#### 安装依赖

```powershell
npm install --ignore-scripts
npm rebuild better-sqlite3
```

> Electron 二进制在运行 `electron:dev` 或打包脚本时按需下载（`npm run electron:install`）。

#### 数据库模式

支持本地 SQLite 与远程 MariaDB 双数据库模式，可通过环境变量或管理员界面（系统设置 → 数据存储）切换：

| 模式 | 后端 | 说明 |
|------|------|------|
| **本地 SQLite**（默认） | `data/projectx.db` | 零依赖，适合单机、离线与本地开发测试 |
| **远程 MariaDB** | MariaDB 10.11 LTS | 生产环境多用户部署 |

```powershell
# SQLite 模式（默认）
npm run dev

# MariaDB 模式
$env:PROJECTX_MARIADB_HOST     = "127.0.0.1"
$env:PROJECTX_MARIADB_USER     = "projectx_app"
$env:PROJECTX_MARIADB_PASSWORD = "your_password"
npm run dev
```

> 首次连接 MariaDB 时自动执行 `schema.mariadb.sql` 建表。现有 SQLite 数据可通过 `npx tsx scripts/migrate-to-mariadb.ts` 迁移至 MariaDB。

#### 开发模式

```powershell
npm run dev
```

一条命令同时启动后端（`http://127.0.0.1:5174`）与前端 Vite 开发服务（`http://127.0.0.1:5173`）：

| 端 | 访问地址 | 页面内容 |
|----|---------|---------|
| **Web 端** | `http://127.0.0.1:5173/` | 教师 + 学生完整功能（设计 / 考试管理 / 网上阅卷 / 分析 / 账号） |
| **扫描端** | `http://127.0.0.1:5173/index-scanner.html` | 答题卡选择 + 扫描工作台（直扫 + 图片导入判分 + 整卡订正） |

> **扫描仪硬件调试**：开发环境默认关闭本机 TWAIN 路由。如需连接真实扫描仪调试，启动前设置 `$env:PROJECTX_ENABLE_SCANNER = "1"`。
>
> **AI 成绩分析服务（可选）**：首次启用需执行 `py -m pip install -r llmclient/requirements.txt` 并复制配置 `llmclient/.env.example` 为 `llmclient/.env`，详见 [AI成绩分析.md](./readus/AI成绩分析.md)。

#### 演示数据（Demo 种子）

无需真实扫描仪即可体验网上阅卷（双模式打分面板、0.5 分步进、工作量均衡）、文理分科大考、P/D 统计与正态性检验等功能：

```powershell
# 方式一：管理员登录后在右上角账户菜单点击「导入演示数据」
# 方式二：命令行导入（重复运行会自动先清理旧演示数据再重建）
npx tsx testdata/demo-exams/scripts/seed.ts
```

导入后会自动创建「演示-网阅测试」等演示考试及演示教师（`demo-teacher`、`demo-teacher-2`）、演示学生（`20260101` ~ `20260116`）账号。演示账号默认生成一次性随机初始口令（可在管理员「导出账密」中查看），详细说明见 [演示数据.md](./readus/演示数据.md)。

#### 打包与构建

```powershell
# Web 端 + 服务端构建
npm run build                          # 输出 dist/web/ + dist/server/

# 扫描端 + 服务端构建
npm run build:scanner:full             # 输出 dist/scanner/ + dist/server/

# Ubuntu 24.04 服务端安装包
npm run package:server:ubuntu24

# Windows 扫描端便携版 EXE 与 MSI 安装包
npm run electron:dist                  # 扫描端便携 EXE (x64)
npm run electron:dist:ia32             # 扫描端便携 EXE (ia32)
npm run electron:msi                   # 扫描端 MSI (x64)
npm run electron:msi:ia32              # 扫描端 MSI (ia32)
```

#### 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run dev` | 启动前后端开发服务器 |
| `npm run build` | 构建 Web 端与后端 |
| `npm run build:scanner:full` | 构建扫描端与后端 |
| `npm run electron:dev` | 构建扫描端并启动 Electron 桌面环境 |
| `npm run native:rebuild:node` | Electron 打包后恢复本机 Node ABI 的 `better-sqlite3` |
| `npm run verify:auth` | 认证与账号权限回归验证 |
| `npm run verify:permission-scope` | 教师角色与考试/班级/题块数据范围验证 |
| `npm run verify:core-logic` | 核心判分、排名与统计逻辑验证 |
| `npm run verify:security-critical` | 安全与数据完整性关键回归验证 |
| `npm run verify:scan-correction` | 整卡订正与草稿保存回归验证 |
| `npm run verify:mariadb` | MariaDB 适配与集成回归验证 |
| `npx tsx scripts/grading-rules-smoke.ts` | 客观题部分得分规则冒烟验证 |

---

## 文档

项目说明与手册类文档统一放在 [`readus/`](./readus/) 与 [`docs/`](./docs/) 目录（完整分类索引见 [readus/README.md](./readus/README.md)）：

| 文档 | 说明 | 适合读者 |
|------|------|----------|
| [readus/README.md](./readus/README.md) | `readus/` 文档总索引（区分现行规范与时间点记录） | 全体 |
| [ARCHITECTURE.md](./readus/ARCHITECTURE.md) | 系统总体架构、分层、数据流、原生模块与构建部署 | 开发者 |
| [UI-ARCHITECTURE.md](./readus/UI-ARCHITECTURE.md) | v2 组件体系、主题令牌、样式分层与新页面开发规范 | 开发者 |
| [项目胶囊.md](./readus/项目胶囊.md) | 架构速查：目录、类型、API、约定的一页摘要 | 开发者 |
| [DATABASE.md](./readus/DATABASE.md) | SQLite / MariaDB 表结构、迁移台账、Repository 与数据清理 | 开发者 / 运维 |
| [双方言SQL函数安全清单.md](./readus/双方言SQL函数安全清单.md) | SQLite / MariaDB 共用 SQL 的禁用写法与已踩过的坑 | 开发者 |
| [ACCOUNT-ARCHITECTURE.md](./readus/ACCOUNT-ARCHITECTURE.md) | 三级账号 RBAC 整体架构、会话模型与教师细分角色 | 开发者 |
| [ACCOUNT-CONTROL.md](./readus/ACCOUNT-CONTROL.md) | 账号控制系统 API、考试范围数据门、权限矩阵与启用方式 | 开发者 |
| [ADMIN-GUIDE.md](./readus/ADMIN-GUIDE.md) | 管理员日常操作：教师/学生管理、导入导出、年级班级花名册 | 机房管理员 / 教务 |
| [ADMIN-BOOTSTRAP-PASSWORD.md](./readus/ADMIN-BOOTSTRAP-PASSWORD.md) | 首次启动管理员引导随机口令机制 | 管理员 / 运维 |
| [SCANNER-SETUP.md](./readus/SCANNER-SETUP.md) | 扫描端环境配置、TWAIN 驱动与 OMR 识别说明 | 管理员 / 开发者 |
| [扫描端胶囊.md](./readus/扫描端胶囊.md) | 扫描端模块结构、上传队列、后处理与会话状态速查 | 开发者 |
| [多端使用说明.md](./readus/多端使用说明.md) | Web 端 / 扫描端的功能差异、共用数据目录、账号登录与构建部署 | 管理员 / 教师 / 打包维护 |
| [整卡改分说明.md](./readus/整卡改分说明.md) | 整卡订正、学号/客观题/分数格点选改分与旧卷补识别 | 教师 / 开发者 |
| [Windows32位扫描端交叉打包.md](./readus/Windows32位扫描端交叉打包.md) | Windows ia32 扫描端交叉编译与 MSI 打包流程 | 打包维护 / 开发者 |
| [虚拟扫描仪验证.md](./readus/虚拟扫描仪验证.md) | TWAIN 官方虚拟扫描仪搭建与回归验证矩阵 | 开发者 |
| [发布构建与服务器更新时间.md](./readus/发布构建与服务器更新时间.md) | Release Actions 构建发版流程、产物校验、备案配置与服务器构建信息 | 打包维护 / 运维 |
| [反馈与备份恢复收尾说明.md](./readus/反馈与备份恢复收尾说明.md) | 问题反馈附件、全量备份恢复维护态与失败回退步骤 | 管理员 / 运维 |
| [原卷与逐题答案-使用说明.md](./readus/原卷与逐题答案-使用说明.md) | 试卷原卷展示开关、逐题答案上传/OCR 与学生端查看规则 | 教师 / 管理员 |
| [WECHAT-GRADE-RELEASE-部署与排错.md](./readus/WECHAT-GRADE-RELEASE-部署与排错.md) | 成绩发布微信小程序订阅消息配置与排错指南 | 管理员 / 运维 |
| [WECHAT-GRADE-RELEASE-开发者上线清单.md](./readus/WECHAT-GRADE-RELEASE-开发者上线清单.md) | 微信订阅消息服务端上线动作与自检判据 | 开发者 / 运维 |
| [AI成绩分析.md](./readus/AI成绩分析.md) | AI 成绩分析卡片、llmclient Python 服务、模型配置与工具白名单 | 教师 / 管理员 / 开发者 |
| [SKIN-THEME.md](./readus/SKIN-THEME.md) | 皮肤切换功能说明：入口、数据流、API 与新增皮肤方法 | 开发者 |
| [SPONSOR-PAGE.md](./readus/SPONSOR-PAGE.md) | 赞助/支持页面入口、收款码配置与 API 说明 | 开发者 / 运维 |
| [演示数据.md](./readus/演示数据.md) | 演示数据生成、随机口令策略、导入闸门与清理机制 | 开发者 / 管理员 |
| [答题卡二维码说明.md](./readus/答题卡二维码说明.md) | 卡面二维码格式与页面身份绑定说明 | 开发者 |
| [docs/班级迁移与考试历史归属.md](./docs/班级迁移与考试历史归属.md) | 学生调班/迁移后的历史考试班级快照重锚规则 | 开发者 / 教务 |
| [docs/扫描端后处理页-施工接手文档.md](./docs/扫描端后处理页-施工接手文档.md) | 扫描端异常卷后处理页架构与交互设计说明 | 开发者 |
| [SECURITY-AUDIT-NOTES-2026-10-04.md](./readus/SECURITY-AUDIT-NOTES-2026-10-04.md) | 安全审查各项判定、边界设计（R01–R48）与复检证据口径 | 开发者 / 运维 |
| [CHANGELOG.md](./readus/CHANGELOG.md) | 历次版本发布与专项整改变更记录 | 全体 |

---

## 项目架构

> 详细架构分层、数据流、原生模块、构建部署及环境变量速查见 **[ARCHITECTURE.md](./readus/ARCHITECTURE.md)**。

| 目录 / 路径 | 职责说明 |
|-------------|----------|
| `src/apps/answer-card/client/` | React 前端（`main.tsx` / `App.tsx` 为 Web 端入口，`main-scanner.tsx` / `ScannerApp.tsx` 为扫描端入口，`pages/` 为路由页面，`components/` 为业务与 `ui/v2` 基础组件，`theme/` 为样式事实源） |
| `src/apps/answer-card/server/` | Express 应用入口、答题卡 CRUD、PDF 导出、原生识别调用（`recognition.ts`）、TWAIN 直扫子系统（`scanner/`）与文件存储 |
| `src/server/` | 后端核心模块：`auth/` 与 `middleware/`（认证与权限范围）、`db/`（SQLite / MariaDB 适配器与迁移）、`repositories/`（数据访问层）、`services/`（业务服务）、`routes/`（业务路由） |
| `src/shared/` | 前后端共享类型（`types.ts`）、版面坐标计算（`layout.ts`）、判分规则（`grading.ts`）、统计与排名（`stats.ts`、`ranking.ts`）、整卡订正契约（`scanCorrection.ts`）及运行配额定义 |
| `native/` | C++ 原生组件源码：`AnswerCardRecognizer/`（OpenCV OMR 识别引擎）与 `ScannerBridge/`（TWAIN 扫描仪桥接） |
| `resources/native/` | 随包分发的原生二进制资源（`win-x64/`、`win-ia32/`、`correction-linux-x64/`） |
| `electron/` | Windows 扫描端 Electron 桌面主进程与运行容器 |
| `llmclient/` | Python AI 成绩分析中转服务（FastAPI + 多模型服务商接入 + PDF 渲染隔离） |
| `scripts/` | 构建、打包、数据库迁移与自动化回归验证脚本 |
| `readus/`、`docs/`、`design/` | 项目架构、运维手册、功能说明与 UI 设计规范文档 |

---

## 使用的技术

| 层级 | 技术 |
|------|------|
| **前端** | React 19 + TypeScript + Vite + Tailwind CSS + Lucide React |
| **后端** | Node.js + Express 5 + Multer |
| **识别引擎** | C++ + OpenCV 4.13 + nlohmann/json（子进程调用） |
| **扫描仪桥接** | C++ TWAIN API + GDI+（子进程调用） |
| **数据库** | SQLite（`better-sqlite3`，本地模式）/ MariaDB 10.11（`mysql2`，服务端生产模式） |
| **跨方言数据层** | `DbAdapter` 统一接口 + `buildUpsertSQL` + `buildInsertIgnore` |
| **PDF 生成** | PDFKit（毫米级精确排版） |
| **AI 服务** | Python + FastAPI + OpenAI / Google GenAI SDK + PyMuPDF |
| **桌面端与打包** | Electron 43 + electron-builder + WiX Toolset |
| **构建工具** | Vite（前端）+ esbuild（后端） |

---

## API 接口一览

| 模块 | 主要路径 | 说明 |
|------|----------|------|
| **答题卡与原卷** | `GET/POST /api/cards`、`GET/PUT/DELETE /api/cards/:id` | 答题卡列表、创建、详情、保存（含 `revision` 版本控制）与删除 |
| | `GET /api/cards/:id/pdf`、`GET /api/cards/:id/layout` | 导出标准 A4 PDF（支持 `?v=<revision>` 校验）与实时生成布局坐标 |
| | `GET /api/cards/:id/export`、`POST /api/cards/import`、`POST /api/cards/:id/assets` | 导出/导入 `.projectx-card.json` 及上传答题卡配图资源 |
| | `POST /api/cards/:id/recognition`、`POST /api/cards/:id/grading` | 单张识别与批量识别判分 |
| **考试与成绩** | `GET/POST /api/exams`、`GET/PATCH/DELETE /api/exams/:id` | 考试列表、创建、详情、状态流转与删除 |
| | `GET/PUT /api/exams/:examId/student/:studentId/scores` | 单名学生逐题得分详情与人工改分 |
| | `GET/PUT /api/exams/:examId/answers` | 标准答案读取、修改与全卷重算 |
| | `GET/PUT/DELETE /api/exams/:id/assigned-formula`、`POST /api/exams/:id/recalculate-assigned` | 等级赋分公式配置与批量重算 |
| | `GET/POST /api/exam-groups`、`GET/PUT/DELETE /api/exam-groups/:id` | 大考组管理、子考试关联、概览、跨科排名与 ZIP 导出 |
| **扫描与整卡订正** | `GET /api/scanner/sources`、`POST /api/scanner/scan`、`GET /api/scanner/progress/:id` | 本机 TWAIN 扫描仪检测、启动扫描会话与 SSE 实时进度 |
| | `GET /api/scanner/session/:id/results`、`GET /api/scanner/scan-image/:recordId` | 扫描会话成绩汇总与扫描原图预览 |
| | `POST /api/scanner/upload/sessions`、`POST .../pages`、`POST .../crops`、`POST .../complete` | 扫描端远程上传会话、原卷页、题块切图与完成确认 |
| | `GET/POST /api/scan-correction/*` | 整卡订正草稿读取、旧卷补识别与显式保存 |
| **网上阅卷** | `GET /api/review/my-exams`、`GET /api/review/exams/:id/blocks`、`GET /api/review/exams/:id/block-crops` | 教师待阅考试、题块进度汇总与待阅切块队列 |
| | `POST /api/review/exams/:id/block-crops/:cropId/submit`、`GET /api/review/exams/:id/trace` | 提交题块打分与查询多轮阅卷溯源记录 |
| | `GET/POST /api/review-assign/exams/:id/blocks/:bid`、`GET/PUT /api/review-session/exams/:id/blocks/:bid` | 阅卷任务分配、工作量均衡与断点续批会话 |
| | `GET /api/review-arbitration/exams/:id/disputes`、`POST /api/review-arbitration/crops/:cid/resolve` | 多评争议卷列表与仲裁定分 |
| | `GET/POST /api/block-grading-config/exams/:id`、`GET/POST/DELETE /api/review-annotations` | 题块网阅参数配置与切图批注管理 |
| **成绩分析与导出** | `GET /api/analysis/exams/:id/overview`、`students`、`questions`、`classes`、`score-table`、`previous` | 单科考试总览、排名、题目得分率、班级对比、成绩表与历次对比 |
| | `POST /api/analysis/cross-exam/total`、`GET/POST/DELETE /api/analysis/cross-exam/groups` | 跨考合并统计与跨考组管理 |
| | `GET /api/analysis/exams/:id/export-csv`、`POST /api/export/exams/:id/scores`、`GET/PUT/DELETE /api/export/templates/:slot` | 成绩 Excel 导出与自定义导出列模板管理 |
| | `GET/PUT /api/ladder/config`、`GET /api/ladder/exams/:id`、`exam-groups/:id`、`cross-exam` | 成绩天梯开关与各维度榜单查询 |
| **学生查分与原卷** | `GET /api/scores/me/semester-comparison` | 学生本学期与上学期成绩对比 |
| | `GET /api/scores/me/exams/:examId/paper`、`.../pages/:pageIndex/image`、`.../answer-file/:pageIndex` | 学生查看已公布考试的原卷页、逐题解析与答案附件 |
| **账户、AI 与系统运维** | `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/media-ticket` | 登录认证、当前会话信息与单次媒体访问票据 |
| | `GET/PUT /api/teachers`、`POST /api/users/import-csv`、`GET /api/export/students`、`GET /api/export/teachers` | 教师/学生/班级管理、批量导入与初始账密导出 |
| | `PATCH /api/users/me/settings`、`POST /api/users/me/background`、`GET /api/app/background` | 个人偏好设置与自定义背景图 |
| | `GET/POST/PUT/DELETE /api/ai/providers`、`GET/POST/PUT/DELETE /api/ai/providers/system` | AI 服务商配置与学情分析任务调用 |
| | `GET/PUT /api/system-settings`、`GET/POST/PUT/DELETE /api/admin/api-keys`、`GET/PATCH /api/app/db-config` | 全局策略设置、扫描端 API Key 管理与数据库配置 |
| | `GET /api/db/backup`、`POST /api/db/restore`、`POST /api/db/import-demo`、`POST /api/db/clear-demo` | 全量数据备份/恢复与演示数据导入/清理 |
| | `GET /api/app/health`、`GET /api/sponsor` | 服务健康检查与赞助页配置 |

> 各接口的上传体积、像素边界、并发配额与环境变量速查见 [ARCHITECTURE.md §14](./readus/ARCHITECTURE.md#14-运行配额与环境变量速查)，安全与权限边界设计见 [ACCOUNT-CONTROL.md](./readus/ACCOUNT-CONTROL.md) 与 [SECURITY-AUDIT-NOTES-2026-10-04.md](./readus/SECURITY-AUDIT-NOTES-2026-10-04.md)。


---

## 贡献者

本项目由大连市第五中学信息化部（I.T.C.）成员发起并维护：

| 昵称 | 角色 | 备注 |
|------|------|------|
| **1g NaOH** | 项目牵头人 | 核心架构与后端开发 |
| **火箭** | 项目牵头人 | 前端与 Electron 桌面端 |
| **云墨丹心** | 项目牵头人 | UI/UX 设计与答题卡版式 |
| **近代先人** | 项目牵头人 | 算法与识别模块预研 |
| **CH** | 项目牵头人 | 项目奠基与经验传承 |

> 感谢所有为 Project-X 提供测试反馈、文档建议和代码贡献的同学与老师！

---
## 看板娘
<img width="1254" height="1254" alt="82210f7b5cb77968108b5aa81a3b2191" src="https://github.com/user-attachments/assets/34c2c9b5-a373-48cf-b605-5a66faecc7b8" />
<img width="1070" height="1470" alt="31c82194dfda46f5a99ea69efd19eb45" src="https://github.com/user-attachments/assets/c73fd099-d40f-4dd2-8e1a-57982522b326" />
<img width="1254" height="1254" alt="9884f7ad4fb44e7d82c66620f1eb43a5" src="https://github.com/user-attachments/assets/e4e05802-68d4-486b-8c32-da3abf754f14" />
<img width="1122" height="1402" alt="aea2da6d3469351758d4d3d9dc56f9b0" src="https://github.com/user-attachments/assets/4680cf8c-c7af-454e-a082-cdbf41afd025" />
<img width="3344" height="1882" alt="27dacd5f25f0f04ed397bf22a3cdc441" src="https://github.com/user-attachments/assets/3bf17d59-5867-4e97-beda-c3630617c7c9" />
<img width="1054" height="1492" alt="1e26fe449f38c89316b12e8cfc78db07" src="https://github.com/user-attachments/assets/d7e0d091-a18a-4786-9ef8-7b76bc2213d2" />
## 开源协议

本项目采用 GPL-3.0 license 开源协议。

---

## 联系我们

- **组织**：大连市第五中学信息化部（I.T.C.）
- **仓库**：[github.com/Dalian-No-5-Middle-School-I-T-C/Project-X](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X)
- **Issues**：如有问题或建议，欢迎提交 [GitHub Issue](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/issues)

---

<p align="center">
  <strong>由五中人，为五中人，服务五中教学。</strong><br>
  <em>Project-X —— 让技术回归校园，让智慧赋能教育。</em>
</p>
