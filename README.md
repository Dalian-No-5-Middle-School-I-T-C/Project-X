# Project-X | 五中智能试卷管理系统

<p align="center">
  <img src="https://img.shields.io/badge/version-1.2.0-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/platform-Windows-green.svg" alt="Platform">
  <img src="https://img.shields.io/badge/license-GPLV3.0-yellow.svg" alt="License">
  <img src="https://img.shields.io/badge/tech-React%20%7C%20Node.js%20%7C%20C%2B%2B%20%7C%20Electron-9cf.svg" alt="Tech Stack">
</p>

## 项目简介

**Project-X** 是大连市第五中学信息化部（I.T.C.）自主开发的智能试卷管理工具，旨在解决学校长期依赖外包扫描答题卡与阅卷系统所带来的**报错频繁、费用高昂、受制于人**等核心痛点。

本项目由信息化部成员 **1g NaOH、火箭、云墨丹心、近代先人、CH（往届学长）** 牵头推进，从零开始构建一套属于学校自己的、可自主可控的答题卡设计与阅卷解决方案。

> **当前版本**：v1.2.0
> **核心能力**：答题卡设计 → PDF 导出 → 扫描仪直扫 → 自动识别判分 → 成绩分析 → AI 成绩分析 → 教师/学生/班级管理 → 账密批量导入导出
> **下个里程碑**：v2.0 — 成绩预测、跨班深度对比分析

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

### 答题卡设计

- **答题卡管理**：新建（科目弹窗 + 考试名称 + 可选日期 + 同步创建/关联考试）、保存、读取、导出、导入、删除答题卡
- **确定性 ID**：基于科目 + 时间戳的 8 位纯数字 ID，导入时自动生成新 ID 防冲突
- **导出/导入**：`.projectx-card.json` 格式，含标准答案 + 配图 base64 + 坐标布局，即插即用
- **A4 标准版式**：含标题、六点定位标记、学生信息区、学号填涂区、题块、页码
- **客观题设计**：
  - 单选、多选、不定项，可配置选项数、题量、分值
  - 标准答案录入，多选支持部分得分规则
- **主观题设计**：
  - 带分数填涂区的手工给分样式（支持十位/个位/十分位）
  - 纯书写块、填空题（阿拉伯/罗马数字序号）、横线格、空白大框
  - 支持图片插入、最小高度设置
- **PDF 导出**：毫米级精确标准 A4 PDF，直接打印
- **单/双面支持**：标记答题卡为单面或双面，扫描/阅卷时自动过滤背面
- **坐标布局**：所有定位点、填涂框、作答区坐标精确到毫米

### 阅卷识别

- **批量识别判分**：上传多张答题卡图片，自动完成：
  - 客观题：选项填涂检测 + 标准答案对比判分
  - 主观题：红色划线分数格识别
  - 学号：数字填涂网格识别
- **多页合并评分**：双面卡 / 多页卡自动合并正反面成绩，去重汇总总分
- **PDF 式详情预览**：按学生聚合展示所有页面，纵向滚动翻阅，缩略图导航
- **低置信度标记**：置信度偏低的题目自动标"待复核"
- **Excel (.xlsx) 导出**：点击导出按钮下载，Excel 直接打开

### 扫描仪直扫

- **柯达 i3000 支持**：通过 C++ TWAIN 原生桥直接驱动高速扫描仪
- **单面过滤**：单面答题卡自动跳过背面扫描结果，避免无效数据
- **实时进度**：SSE 推送扫描进度 + 逐页缩略图预览
- **自动识别评分**：扫描完成自动调用识别引擎提取考号、判分
- **考号-图片持久化**：学号与图片路径存入 SQLite 数据库

### 成绩分析

- **考试管理**：创建考试、关联答题卡（支持新建答题卡时同步创建/关联）、科目信息
- **分析总览**：平均分、最高分、最低分、标准差、及格率、优秀率
- **分数分布**：SVG 柱状图（0-59 / 60-69 / 70-79 / 80-89 / 90-100）
- **学生排名**：学号、姓名、总分、客观分、主观分、待复核标记
- **题目分析**：每题得分率、正确率排行，低分题红色高亮
- **阅卷自动落库**：判分时选择考试自动写入数据库，消除阅后即焚
- **Excel (.xlsx) 成绩导出**：年级排名 / 班级排名两种模式，表头含班级、考号、姓名、成绩、双排名、客观/主观成绩、每题得分
- **AI 成绩分析**：手动调用 `llmclient` Python 服务，基于白名单成绩工具生成总体判断、薄弱题、复核风险和教学建议

### 账户与安全

- **RBAC 权限体系**：管理员、教师、学生三级角色，细粒度权限控制（设计/阅卷/分析/用户管理/成绩查看）
- **记住密码**：勾选后签发 180 天持久令牌，令牌存磁盘（`~/.projectx/tokens.json`），服务器/软件重启不丢失
- **6 个月免登录**：本设备内打开即用，无需反复输入密码

### 桌面应用

- **Windows 桌面端**：三端产品（学生端 / 教师普通端 / 教师扫描端），便携版 EXE + MSI 安装包
- **Electron 原生打包**：按端裁剪（学生端不打包 C++ 识别/扫描资源，教师普通端仅打包识别引擎，扫描端全量）
- **x64 / ia32 双架构**：三端均支持 64 位与 32 位 Windows 包；32 位原生资源位于 `resources/native/win-ia32/`
- **三端共用数据**：`%APPDATA%\answer-card-designer\`（管理员端建账号→学生端直接登录）
- **支持项目**：账号菜单低调入口，JSON 配置驱动的收款码预留接口（详见 [SPONSOR-PAGE.md](./readus/SPONSOR-PAGE.md)）

> 多端详细说明见 [`readus/多端使用说明.md`](./readus/多端使用说明.md)

---

## 快速开始

### 普通用户

#### 方式一：便携版 EXE（推荐临时使用）

前往 [GitHub Releases](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/releases) 按需下载：
```
Project-X 学生端-1.2.0-x64.exe
Project-X 教师端-1.2.0-x64.exe
Project-X 教师扫描端-1.2.0-x64.exe
Project-X 学生端-1.2.0-ia32.exe
Project-X 教师端-1.2.0-ia32.exe
Project-X 教师扫描端-1.2.0-ia32.exe
```

> 普通 64 位 Windows 请选择 `x64` 包；需要兼容 32 位 Windows 时选择 `ia32` 包。学生端仅查看成绩；教师端支持设计/阅卷/分析/账号；扫描端全功能含扫描仪直扫。

#### 方式二：MSI 安装包（推荐机房部署）

各端均有对应 MSI 安装包，适合学校机房、域控、组策略等集中部署场景。

#### 基本使用流程

**设计答题卡**：
1. 打开程序 → 点击「新建答题卡」→ 弹窗中选择科目、填写考试名称、可选考试日期
2. 编辑标题、题块、标准答案 → 保存 → 导出 PDF → 打印

**阅卷判分**：
1. 切到「阅卷」模式 → 选考试（答题卡自动关联）→ 导入图片
2. 点击「开始识别并判分」→ 查看成绩 → 导出 Excel (.xlsx)

**查看分析**：
1. 切到「分析」模式 → 选考试 → 查看总览/排名/题目分析
2. 点击「导出」→ 选择「年级排名」或「班级排名」→ 下载 Excel (.xlsx) 成绩表

---

### 开发人员

#### 环境要求

- Windows 操作系统
- Node.js 24+（开发）/ Node.js 22（Electron 打包）
- Visual Studio 2022（编译 C++ 原生模块需要）
- OpenCV 4.13+（识别引擎编译需要）

#### 安装依赖

```powershell
npm install --ignore-scripts
```

> 使用 `--ignore-scripts` 避免 Electron 下载 SSL 问题。安装后需手动重建原生模块：
> ```powershell
> npm rebuild better-sqlite3
> ```

#### 开发模式

```powershell
npm run dev
```

一条命令同时启动后端与前端。访问 `http://127.0.0.1:5173`，后端 API 默认端口 `5174`。

AI 成绩分析依赖单独手动启动的 Python 中转服务；配置方式见 **[AI成绩分析.md](./readus/AI成绩分析.md)**。

如需分终端调试，也可手动启动：

```powershell
# 终端 1：后端
npx tsx src/apps/answer-card/server/index.ts

# 终端 2：前端
npx vite --port 5173
```

#### 打包发布

```powershell
npm run build                          # 构建前后端

# 如需重新构建 C++ 原生组件，先按目标架构生成 native 资源
npm run native:build:x64               # 输出到 resources/native/win-x64
npm run native:build:ia32              # 输出到 resources/native/win-ia32

# 三端分别打包（顺序执行，勿并行）
npm run electron:pack:student          # 学生端目录包
npm run electron:pack:teacher          # 教师普通端目录包
npm run electron:pack:scanner          # 教师扫描端目录包

npm run electron:dist:student          # 学生端便携 EXE
npm run electron:dist:teacher          # 教师端便携 EXE
npm run electron:dist:scanner          # 教师扫描端便携 EXE

# 32 位便携 EXE
npm run electron:dist:student:ia32
npm run electron:dist:teacher:ia32
npm run electron:dist:scanner:ia32

# MSI 安装包
npm run electron:msi:student           # 学生端 x64 MSI
npm run electron:msi:teacher           # 教师端 x64 MSI
npm run electron:msi:scanner           # 教师扫描端 x64 MSI
npm run electron:msi:student:ia32      # 学生端 32 位 MSI
npm run electron:msi:teacher:ia32      # 教师端 32 位 MSI
npm run electron:msi:scanner:ia32      # 教师扫描端 32 位 MSI
npm run electron:msi:all               # 一次生成三端 x64/ia32 共 6 个 MSI

# 默认命令仍指向扫描端（完整功能包）
npm run electron:pack                  # = electron:pack:scanner
npm run electron:dist                  # = electron:dist:scanner
npm run electron:msi                   # = electron:msi:scanner
```

多端打包和使用方式见 **[多端使用说明.md](./readus/多端使用说明.md)**。

#### 常用脚本

| 命令 | 说明 |
|------|------|
| `npx tsc --noEmit` | TypeScript 类型检查 |
| `npm run build` | 构建前端 + 后端 |
| `npm run dev` | Web 开发模式 |
| `npm run electron:dev` | 构建后启动 Electron |
| `npm run electron:dist` | 生成扫描端便携 EXE |
| `npm run electron:dist:student` | 生成学生端便携 EXE |
| `npm run electron:dist:teacher` | 生成教师端便携 EXE |
| `npm run electron:dist:scanner:ia32` | 生成 32 位教师扫描端便携 EXE |
| `npm run electron:msi` | 生成扫描端 MSI |
| `npm run electron:msi:all` | 一次生成三端 x64/ia32 共 6 个 MSI |
| `npm run verify:auth` | 账号权限自动化验证（33 项用例） |

---

## 文档

项目说明与手册类文档统一放在 [`readus/`](./readus/) 目录，按主题分类如下：

| 文档 | 说明 | 适合读者 |
|------|------|----------|
| [ARCHITECTURE.md](./readus/ARCHITECTURE.md) | 系统总体架构、分层、数据流、原生模块与构建部署 | 开发者 |
| [项目胶囊.md](./readus/项目胶囊.md) | 架构速查：目录、类型、API、约定的一页摘要 | 开发者 |
| [DATABASE.md](./readus/DATABASE.md) | SQLite 表结构、Repository、认证与数据清理 | 开发者 / 运维 |
| [ACCOUNT-ARCHITECTURE.md](./readus/ACCOUNT-ARCHITECTURE.md) | 三级账号 RBAC 全栈架构与 v1.0→v1.1 变更说明 | 开发者 |
| [ACCOUNT-CONTROL.md](./readus/ACCOUNT-CONTROL.md) | 账号控制系统 API、权限矩阵与启用方式 | 开发者 |
| [ADMIN-GUIDE.md](./readus/ADMIN-GUIDE.md) | 管理员日常操作：教师/学生管理、导入导出、年级班级花名册 | 机房管理员 / 教务 |
| [多端使用说明.md](./readus/多端使用说明.md) | 学生端、教师端、教师扫描端的功能差异、共用数据目录、账号登录与打包检查 | 管理员 / 教师 / 打包维护 |
| [AI成绩分析.md](./readus/AI成绩分析.md) | AI 成绩分析卡片、llmclient Python 服务、模型配置、工具白名单与本地端口探活 | 教师 / 管理员 / 开发者 |
| [SPONSOR-PAGE.md](./readus/SPONSOR-PAGE.md) | 赞助/支持页面入口、收款码配置与 API 说明（Issue #11） | 开发者 / 运维 |
| [CHANGELOG.md](./readus/CHANGELOG.md) | 版本变更记录（v1.2.0 AI 成绩分析 + v1.1.x 多端/账号/打包增强） | 开发者 / 测试 |

---

## 项目架构

> 详细架构说明（分层、数据流、原生模块、构建部署等）见 **[ARCHITECTURE.md](./readus/ARCHITECTURE.md)**。

```
Project-X/
├── src/
│   ├── apps/answer-card/
│   │   ├── client/                      # React 前端
│   │   │   ├── App.tsx                  # 主应用（设计/阅卷/分析/成绩/账号五模式）
│   │   │   ├── styles.css               # 全局样式
│   │   │   └── components/              # 子组件
│   │   │       ├── NewCardModal.tsx        # 新建答题卡弹窗（科目+名称+日期+考试关联）
│   │   │       ├── LoginPage.tsx            # 登录页（记住密码）
│   │   │       ├── AccountMenu.tsx          # 账户下拉菜单（含支持项目入口）
│   │   │       ├── SponsorPage.tsx          # 赞助/支持页面（收款码预留）
│   │   │       ├── AccountManagement.tsx    # 教师/学生管理（双 Tab）
│   │   │       ├── TeacherManagement.tsx    # 教师管理（科目/班级关联）
│   │   │       ├── StudentManagement.tsx    # 学生管理（按班级+导入/导出）
│   │   │       ├── ImportModal.tsx          # 通用CSV/Excel导入弹窗
│   │   │       ├── StudentScores.tsx        # 学生我的成绩
│   │   │       ├── ScannerPanel.tsx         # 扫描仪控制面板
│   │   │       ├── AnalysisOverview.tsx   # 分析总览卡片
│   │   │       ├── AnalysisDistribution.tsx # SVG 分数分布图
│   │   │       ├── AnalysisAiPanel.tsx      # AI 成绩分析卡片
│   │   │       ├── AnalysisRanking.tsx     # 学生排名表
│   │   │       └── AnalysisQuestions.tsx   # 题目得分率排行
│   │   └── server/                      # Express 后端
│   │       ├── index.ts                 # 主路由（卡片CRUD/导入导出/识别/阅卷/考试/分析）
│   │       ├── recognition.ts           # C++ 识别引擎子进程管理
│   │       ├── storage.ts               # 文件存储层
│   │       ├── pdf.ts                   # PDF 生成（pdfkit）
│   │       ├── database/                # 扫描记录 SQLite
│   │       └── scanner/                 # TWAIN 扫描仪子系统
│   ├── server/                          # 共享服务模块
│   │   ├── db/                          # 主数据库（projectx.db）
│   │   ├── repositories/                # 数据访问层
│   │   │   ├── CardRepository.ts         # 答题卡 CRUD
│   │   │   ├── ExamRepository.ts         # 考试 CRUD
│   │   │   ├── UserRepository.ts         # 用户管理
│   │   │   └── AnalysisRepository.ts     # 分析查询
│   │   ├── middleware/                   # 认证中间件
│   │   ├── routes/                       # 认证/用户/赞助等路由
│   │   └── services/                     # AuthService（登录/令牌持久化）
│   └── shared/                          # 前后端共享
│       ├── types.ts                     # 全部类型定义
│       ├── grading.ts                   # 评分引擎
│       ├── layout.ts                    # 答题卡坐标布局
│       ├── pinyin.ts                    # 科目名→拼音 key 转换
│       ├── blankLabels.ts               # 填空序号格式化
│       ├── defaultCard.ts               # 默认答题卡工厂 + ID 生成
│       └── appVariant.ts                # 多端变体定义（学生/教师/扫描端）
├── native/
│   ├── AnswerCardRecognizer/            # C++ 识别引擎（OpenCV）
│   └── ScannerBridge/                   # C++ TWAIN 扫描仪桥接
├── scripts/
│   ├── build-server.ts                  # esbuild 后端打包
│   └── build-scanner-bridge.bat         # 扫描仪桥接一键编译
├── electron/
│   └── main.cjs                         # Electron 主进程
├── llmclient/                            # Python AI 中转服务（FastAPI + provider SDK）
├── readus/                              # 项目文档（架构、账号、管理员手册、多端说明等）
├── data/                                # 运行时数据
│   ├── answer-card/                     # 答题卡 JSON、扫描图片、资产
│   ├── sponsor/qr/                      # 收款码图片（部署时放置，不进 git）
│   └── projectx.db                      # 主数据库（用户/卡片/考试/成绩）
├── dist/                                # 构建产物
├── resources/native/win-x64/            # 64 位原生模块打包目录
├── resources/native/win-ia32/           # 32 位原生模块打包目录
└── release/                             # Electron 打包输出
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | React 19 + TypeScript + Vite + Lucide React |
| **后端** | Node.js + Express 5 + multer |
| **识别引擎** | C++ + OpenCV 4.13 + nlohmann/json（子进程调用） |
| **扫描仪** | C++ TWAIN API + GDI+（子进程调用） |
| **数据库** | SQLite via better-sqlite3（WAL + 外键约束） |
| **PDF** | pdfkit（毫米级精确排版） |
| **桌面** | Electron 39 + electron-builder + WiX Toolset |
| **构建** | Vite（前端）+ esbuild（后端） |

---

## API 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST` | `/api/cards` | 答题卡列表 / 创建（含 subject/title/examDate） |
| `GET/PUT/DELETE` | `/api/cards/:id` | 答题卡详情 / 保存 / 删除 |
| `GET` | `/api/cards/:id/export` | 导出为 .projectx-card.json（含答案+配图+布局） |
| `POST` | `/api/cards/import` | 导入答题卡 |
| `GET` | `/api/cards/:id/layout` | 布局坐标 |
| `GET` | `/api/cards/:id/pdf` | 导出 PDF |
| `POST` | `/api/cards/:id/recognition` | 单张识别（客观+主观） |
| `POST` | `/api/cards/:id/grading` | 批量识别判分（支持 examId 落库） |
| `POST` | `/api/cards/:id/assets` | 上传资源图片 |
| `GET/POST` | `/api/exams` | 考试列表 / 创建 |
| `GET` | `/api/exams/:id` | 考试详情+成绩 |
| `PATCH` | `/api/exams/:id` | 更新考试（cardId/name/subject） |
| `DELETE` | `/api/exams/:id` | 删除考试 |
| `GET` | `/api/analysis/exams/:id/overview` | 考试总览统计 |
| `GET` | `/api/analysis/exams/:id/students` | 学生排名 |
| `GET` | `/api/analysis/exams/:id/questions` | 题目得分率 |
| `GET` | `/api/analysis/exams/:id/classes` | 考试关联班级 |
| `GET` | `/api/analysis/exams/:id/export-csv` | 导出成绩 Excel (.xlsx)（?classId= 选班级） |
| `GET` | `/api/scanner/sources` | TWAIN 扫描仪检测 |
| `POST` | `/api/scanner/scan` | 启动扫描会话 |
| `GET` | `/api/scanner/progress/:id` | SSE 扫描进度 |
| `GET` | `/api/scanner/session/:id/results` | 合并学生成绩（多页汇总） |
| `GET` | `/api/scanner/scan-image/:recordId` | 扫描原图预览 |
| `POST` | `/api/auth/login` | 登录（支持 isPersistent 6 月免登录） |
| `GET` | `/api/auth/me` | 当前用户信息 |
| `GET` | `/api/teachers` | 教师列表（按创建时间排序） |
| `GET/PUT` | `/api/teachers/:id` | 教师详情 / 更新（姓名/科目） |
| `POST` | `/api/teachers/:id/classes` | 教师关联班级 |
| `DELETE` | `/api/teachers/:id/classes/:classId` | 教师解除班级关联 |
| `POST` | `/api/users/import-csv` | 批量导入学生/教师（CSV/Excel） |
| `GET` | `/api/export/students` | 导出学生账密 Excel |
| `GET` | `/api/export/teachers` | 导出教师账密 Excel |
| `GET` | `/api/sponsor` | 赞助页配置（各渠道收款码 URL） |
| `GET` | `/api/sponsor/qr/:channelId` | 收款码图片 |

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
