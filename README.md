# Project-X | 五中智能试卷管理系统

<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.0-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/platform-Windows-green.svg" alt="Platform">
  <img src="https://img.shields.io/badge/license-GPLV3.0-yellow.svg" alt="License">
  <img src="https://img.shields.io/badge/tech-Electron%20%7C%20React%20%7C%20Node.js%20%7C%20C%2B%2B-9cf.svg" alt="Tech Stack">
</p>

## 项目简介

**Project-X** 是大连市第五中学信息化部（I.T.C.）自主开发的智能试卷管理工具，旨在解决学校长期依赖外包扫描答题卡与阅卷系统所带来的**报错频繁、费用高昂、受制于人**等核心痛点。

本项目由信息化部成员 **1g NaOH、火箭、云墨丹心、近代先人、CH（往届学长）** 牵头推进，从零开始构建一套属于学校自己的、可自主可控的答题卡设计与阅卷解决方案。

> **当前版本**：v0.3.0  
> **核心能力**：答题卡设计 → A4 PDF 导出 → 扫描仪直扫 → 自动识别判分 → 考号-图片持久化  
> **下个里程碑**：v1.0 (pre)，成绩分析面板

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

### 答题卡设计（设计模式）

- **答题卡管理**：新建、保存、读取答题卡，每张答题卡自动生成唯一 ID
- **A4 标准版式**：包含答题卡 ID、标题、六个定位方块、学生信息区、学号填涂区、正文题块和页脚页码
- **客观题设计**：
  - 支持单选、多选、不定项，可配置选项数、题量、分值
  - 四种密度预设：宽松、标准、紧凑、高密
  - 支持标准答案录入，多选支持部分得分
- **主观题设计**：
  - 支持带顶部分数填涂区的手工给分样式（红色划线识别）
  - 支持纯书写块（无分数填涂区）
  - 内容支持：填空（阿拉伯/罗马数字序号）、横线格、空白大框、最小高度设置、图片插入
  - 大题总分超过 16 分自动使用十位/个位/十分位填涂
- **PDF 导出**：生成标准 A4 PDF，适合直接打印
- **坐标数据保存**：保存所有定位标记、学号填涂点、选项填涂框、主观题区域和分数格的毫米坐标

### 阅卷识别（阅卷模式）

- **批量识别判分**：上传多张答题卡图片（最多 200 张），自动完成：
  - 客观题：选项填涂检测 + 标准答案对比判分
  - 主观题：红色划线分数格识别
  - 学号：数字填涂网格 OCR
- **低置信度标记**：识别置信度偏低的题目自动标记"待复核"
- **成绩导出**：支持 CSV 导出（UTF-8 BOM，Excel 直接打开）

### 扫描仪直扫（柯达 i3000 支持）

- **TWAIN 驱动集成**：通过 C++ 原生桥直接驱动柯达 i3000 高速扫描仪
- **实时进度**：SSE 推送扫描进度 + 逐页缩略图预览
- **自动 OCR**：扫描完成后自动调用识别引擎提取学号
- **考号-图片挂钩**：每张扫描图的学号与图片路径持久化存入 SQLite 数据库
- **扫描记录管理**：支持查询、删除扫描会话和单条记录

### 桌面应用

- **Windows 桌面端**：支持便携版 EXE 和 MSI 安装包两种分发方式
- **Electron 原生打包**：C++ 识别引擎和 TWAIN 桥接自动内嵌，无需额外安装
- **数据隔离**：答题卡和扫描数据存储在用户应用数据目录，多用户环境数据隔离

### 即将推出（v1.0 pre）

- [x] 成绩分析面板 —— 考试总览、分数分布、学生排名、题目得分率
- [x] 考试管理 —— 创建考试、选择答题卡、批量阅卷入考试
- [x] 阅卷结果持久化 —— 成绩自动写入 SQLite，不再阅后即焚
- [ ] 年级分析 —— 多班级对比、趋势图
- [ ] 知识点诊断 —— 关联知识图谱定位薄弱环节

---

## 快速开始

### 普通用户

#### 方式一：便携版 EXE（推荐临时使用）

1. 前往 [GitHub Releases](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/releases) 下载：
   ```
   答题卡设计系统-0.3.0-x64.exe
   ```
2. 双击即可运行，无需安装，不写注册表

#### 方式二：MSI 安装包（推荐机房部署）

1. 下载：
   ```
   答题卡设计系统-0.3.0-x64.msi
   ```
2. 适合学校机房、域控、SCCM、Intune、组策略等集中部署场景

#### 基本使用流程

**答题卡设计**：
1. 打开程序 → 点击「新建答题卡」
2. 编辑标题、学生信息、客观题块和主观题块
3. 配置标准答案（阅卷必需）
4. 点击保存 → 导出 PDF 并打印

**阅卷判分**：
1. 切换到「阅卷」模式
2. 选择答题卡 → 导入答题卡图片（文件或文件夹）
3. 点击「开始识别并判分」
4. 查看成绩表格 → 下载 CSV

**扫描仪直扫**：
1. 阅卷模式下点击「扫描仪录入」
2. 系统自动检测柯达 i3000（需已装 TWAIN 驱动）
3. 配置 DPI / 双面 / 纸张 → 点击开始扫描
4. 扫描完成自动识别学号，学号与图片存入数据库

> **数据存储说明**：答题卡 JSON 保存在 `%APPDATA%\answer-card-designer\data\answer-card\`，扫描记录存入 SQLite 数据库 `scanner.db`。

---

### 开发人员

#### 环境要求

- Windows 操作系统
- Node.js 20+
- Visual Studio 2022（编译 C++ 原生模块需要）
- OpenCV 4.13+（识别引擎编译需要）

#### 安装依赖

```powershell
npm install --ignore-scripts
```

> 注意：使用 `--ignore-scripts` 避免 Electron 下载 SSL 问题。

#### 开发模式

**Web 开发模式**（前端热更新，推荐日常开发）：
```powershell
npm run dev
```
访问：`http://127.0.0.1:5173`（前端）  
后端 API 默认端口：`5174`

**本地服务模式**（前后端构建后运行）：
```powershell
npm run build
npm run server
```
访问：`http://127.0.0.1:5174`

#### 原生模块编译

**答题卡识别引擎**（C++ / OpenCV）：
```powershell
# 在 VS2022 中打开
native\AnswerCardRecognizer\AnswerCardRecognizer.slnx
# 编译 Release|x64 → answer-card-recognizer.exe
# 拷贝到 resources\native\win-x64\
```

**TWAIN 扫描仪桥接**（C++ / Windows SDK）：
```powershell
# 方式一：VS2022 Developer Command Prompt
cd E:\git\Project-X\native\ScannerBridge\scanner-bridge
MSBuild scanner-bridge.vcxproj /p:Configuration=Release /p:Platform=x64
copy x64\Release\scanner-bridge.exe E:\git\Project-X\resources\native\win-x64\

# 方式二：一键脚本
scripts\build-scanner-bridge.bat
```

#### 打包发布

```powershell
# 构建前端和服务端产物
npm run build

# 生成 Electron 目录包（本机测试）
npm run electron:pack
# 输出：release/win-unpacked/答题卡设计系统.exe

# 生成 Windows 便携版 EXE
npm run electron:dist
# 输出：release/答题卡设计系统-0.3.0-x64.exe

# 生成 Windows MSI 安装包
npm run electron:msi
# 输出：release/答题卡设计系统-0.3.0-x64.msi
```

> **打包提示**：MSI 由 electron-builder 调用 WiX Toolset 生成。若从旧构建缓存继续打包时遇到 WiX 图标引用错误，可删除旧的 MSI 临时目录后重新打包：
> ```powershell
> Remove-Item -Recurse -Force .\release\__msi-x64
> npm run electron:msi
> ```

#### 常用脚本速查

| 命令 | 说明 |
|------|------|
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build` | 构建前端和服务端 |
| `npm run dev` | Web 开发模式 |
| `npm run server` | 运行本地服务 |
| `npm run electron:dev` | 构建后启动 Electron |
| `npm run electron:pack` | 生成 Electron 目录包 |
| `npm run electron:dist` | 生成 Windows 便携版 EXE |
| `npm run electron:msi` | 生成 Windows MSI 安装包 |

---

## 项目架构

```
Project-X/
├── src/
│   ├── apps/answer-card/
│   │   ├── client/                      # React 前端
│   │   │   ├── App.tsx                  # 主应用（设计/阅卷双模式）
│   │   │   ├── main.tsx                 # 入口
│   │   │   ├── styles.css               # 全局样式
│   │   │   └── components/
│   │   │       └── ScannerPanel.tsx      # 扫描仪控制面板
│   │   └── server/                      # Express 后端
│   │       ├── index.ts                 # 主路由（卡片/识别/阅卷 API）
│   │       ├── recognition.ts           # C++ 识别引擎子进程管理
│   │       ├── storage.ts               # JSON 文件存储层
│   │       ├── pdf.ts                   # PDF 生成（pdfkit）
│   │       ├── database/                # SQLite 数据库层
│   │       │   ├── index.ts             # 初始化（WAL + 外键）
│   │       │   ├── schema.ts            # 表结构 + 版本迁移
│   │       │   └── scan-store.ts        # 扫描记录 CRUD
│   │       └── scanner/                 # 扫描仪子系统
│   │           ├── index.ts             # 扫描仪 REST API + SSE
│   │           ├── scanner-service.ts    # 扫描+自动OCR 工作流
│   │           ├── scanner-types.ts      # 扫描类型定义
│   │           └── twain-bridge.ts       # TWAIN C++ 桥接管理
│   └── shared/                          # 前后端共享
│       ├── types.ts                     # 全部类型定义（~290行）
│       ├── grading.ts                   # 评分引擎（客观+主观+综合）
│       ├── layout.ts                    # 答题卡坐标布局引擎（~680行）
│       ├── blankLabels.ts               # 填空序号格式化
│       └── defaultCard.ts               # 默认答题卡工厂
├── native/
│   ├── AnswerCardRecognizer/            # C++ 识别引擎（OpenCV）
│   │   └── answer-card-recognizer/
│   │       ├── main.cpp                 # CLI 入口
│   │       ├── answer_recognition.cpp   # 核心识别（选项/学号/分数格）
│   │       ├── vision_utils.cpp         # 视觉处理（标记检测/匹配/单应）
│   │       ├── layout_io.cpp            # 布局 JSON 读写（nlohmann）
│   │       └── common.cpp               # 工具函数
│   └── ScannerBridge/                   # C++ 扫描仪桥接（TWAIN）
│       └── scanner-bridge/
│           ├── main.cpp                 # CLI 入口（list/scan）
│           ├── twain_controller.cpp     # TWAIN 状态机 + DIB→JPEG
│           └── scanner-bridge.vcxproj   # VS2022 项目
├── scripts/
│   ├── build-server.ts                  # esbuild 后端打包
│   ├── build-scanner-bridge.bat         # 扫描仪桥接一键编译
│   └── image_processing/                # Python 原型脚本（研究用）
├── electron/
│   └── main.cjs                         # Electron 主进程
├── data/answer-card/                    # 运行时数据（需 .gitignore）
│   ├── cards/                           # 答题卡 JSON
│   ├── layouts/                         # 布局坐标 JSON
│   ├── scans/                           # 扫描图片（按 cardId 分子目录）
│   ├── assets/                          # 答题卡嵌入图片
│   └── scanner.db                       # SQLite 扫描记录数据库
├── dist/                                # 构建产物
│   ├── client/                          # Vite 前端输出
│   └── server/                          # esbuild 后端输出
├── resources/native/win-x64/            # 原生模块打包目录
├── build/                               # 构建配置与图标
└── release/                             # Electron 打包输出
```

---

## 数据流

```
用户创建答题卡 → storage.ts (JSON文件)
      │
用户打印/考试 → PDF 导出
      │
扫描录入 ← ScannerPanel → TWAIN桥(C++) → SQLite (scan_records)
      │                                        │
      └──→ 批量阅卷 ← 图片上传                  │
              │                                │
       recognition.ts → C++识别引擎(OpenCV)    │
              │                                │
       grading.ts → 客观判分 + 主观计分          │
              │                                │
       CombinedGradingBatchResult              │
       (CSV导出 / 前端表格)                      │
              │                                │
              └──→ [即将推出] → SQLite落库       │
                              → 成绩分析API      │
                              → 分析面板        │
```

---

## 数据库表结构

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `scan_sessions` | 扫描会话 | card_id, dpi, duplex, status |
| `scan_records` | 扫描记录 | session_id, ✅ student_id ↔ image_path 挂钩 |
| `recognition_results` | 识别结果 | scan_record_id, objective_json, subjective_json, total_score |
| `exams` | 考试（即将推出） | name, card_id |
| `students` | 学生身份（即将推出） | student_number, name |
| `student_scores` | 学生总分（即将推出） | exam_id, student_id, total_score |
| `question_scores` | 题目得分（即将推出） | exam_id, student_id, question_number, score |

---

## 技术栈

- **前端**：React 19 + TypeScript + Vite 7 + Lucide React 图标
- **后端**：Node.js + Express 5 + multer（文件上传）
- **识别引擎**：C++ + OpenCV 4.13 + nlohmann/json（子进程调用）
- **扫描仪**：C++ TWAIN API + GDI+（子进程调用）
- **数据库**：SQLite via better-sqlite3（WAL 模式，外键约束）
- **PDF**：pdfkit（毫米级精确排版）
- **桌面**：Electron 39 + electron-builder + WiX Toolset
- **构建**：Vite（前端）+ esbuild（后端）

---

## 贡献者

本项目由大连市第五中学信息化部（I.T.C.）成员发起并维护：

| 昵称 | 角色 | 备注 |
|------|------|------|
| **1g NaOH** | 项目牵头人 | 核心架构与后端开发 |
| **火箭** | 项目牵头人 | 前端与 Electron 桌面端 |
| **云墨丹心** | 项目牵头人 | UI/UX 设计与答题卡版式 |
| **近代先人** | 项目牵头人 | 算法与识别模块预研 |
| **CH** | 往届学长 | 项目奠基与经验传承 |

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
