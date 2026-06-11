# Project-X 答题卡设计系统

五中信息化部自主开发的智能试卷管理工具，集答题卡设计、扫描录入、机器阅卷和成绩统计于一体。支持 Windows 桌面端分发，通过 Electron 打包为便携版 EXE 或 MSI 安装包。

## 功能概览

### 答题卡设计
- **客观题**：单选、多选、不定项三种题型，2-8 个选项，四种密度预设（宽松/标准/紧凑/高密），支持部分得分配置。
- **主观题**：分数格评分样式（manual_score_grid）和纯书写框（plain_subjective）。支持填空横线、横线格、空白大框，可插入图片和设置最小高度。
- **学号填涂**：可配置 1-10 位数字，每位 0-9 共 10 格。
- **题块排序**：客观题块可自由插入到主观题之间，不受固定顺序限制。
- **A4 版面**：210×297mm 标准 A4，17mm 页边距，6 个定位标记，含标题、学生信息区和页脚。

### 扫描录入
- **文件夹监听**：通过 chokidar 实时监听扫描仪输出目录，自动发现并导入新图片。
- **拖拽上传**：支持拖拽图片或文件夹到界面，批量导入。
- **文件选择器**：调用系统文件管理器选取图片文件或整个文件夹。
- **柯达 i3000 直连**：通过 Windows WIA 协议直连柯达 i3000/i2000 系列扫描仪，支持 ADF 自动进纸器、双面扫描、DPI/色彩模式配置（需安装 pywin32）。
- **TWAIN / WIA**：预留接口，待接入。

### 机器阅卷
- **C++ 原生识别引擎**：基于 OpenCV，完成定位标记检测 → 透视校正 → 填涂判定 → 学号识别全流程。
- **客观题自动评分**：对照标准答案逐题判分，支持多选部分得分、置信度阈值复核标记。
- **批量阅卷**：最多 200 张，生成成绩表（总分、客观题分、异常数、待复核数）。
- **CSV 导出**：支持成绩表导出，异常题保留行数据。

### PDF 导出
- 生成 A4 PDF，包含完整的答题卡版式、定位标记和填涂坐标，可直接打印。

## 技术架构

```
┌─────────────────────────────────────────────────┐
│                  Electron Shell                   │
│  ┌─────────────────┐  ┌───────────────────────┐ │
│  │   React 前端     │  │   Express 服务端       │ │
│  │  (Vite 构建)     │  │  (tsx 运行)           │ │
│  │  答题卡设计       │  │  存储 / 识别调度 /    │ │
│  │  扫描面板         │  │  PDF 生成 / API       │ │
│  └────────┬────────┘  └───────────┬───────────┘ │
│           │         HTTP API        │             │
│           └─────────────────────────┘             │
│                         │                         │
│              ┌──────────┴──────────┐              │
│              │  C++ 原生识别引擎    │              │
│              │  (OpenCV + JSON)     │              │
│              │  spawn 子进程调用     │              │
│              └─────────────────────┘              │
│                         │                         │
│              ┌──────────┴──────────┐              │
│              │  Python 扫描桥接     │              │
│              │  (WIA + pywin32)     │              │
│              │  Kodak i3000 直连    │              │
│              └─────────────────────┘              │
└─────────────────────────────────────────────────┘
```

**前端**：React 19 + TypeScript + Vite 7，lucide-react 图标库  
**后端**：Express 5 + TypeScript，tsx 运行  
**数据库**：sql.js（SQLite WASM），数据存储在 `data/answer-card/answer-card.db`  
**图像处理**：sharp（缩略图生成）、OpenCV（C++ 识别引擎）  
**PDF 生成**：pdfkit  
**桌面打包**：electron-builder（便携版 EXE / MSI）

## 项目结构

```
Project-X/
├── src/
│   ├── apps/answer-card/
│   │   ├── client/           # React 前端
│   │   │   ├── App.tsx         # 主入口（设计/扫描两个视图）
│   │   │   ├── ScanPanel.tsx   # 扫描面板
│   │   │   ├── main.css        # 全局样式
│   │   │   └── styles.css      # 扫描面板样式
│   │   └── server/             # Express 服务端
│   │       ├── index.ts        # 路由和 API
│   │       ├── scanner.ts      # 扫描模块（文件夹监听 + 柯达驱动）
│   │       ├── recognition.ts  # C++ 识别引擎调度
│   │       ├── database.ts     # SQLite 数据层
│   │       ├── pdf.ts          # PDF 导出
│   │       └── storage.ts      # 文件存储
│   └── shared/                 # 前后端共享
│       ├── types.ts            # 核心类型定义
│       ├── layout.ts           # 答题卡布局生成
│       ├── grading.ts          # 客观题评分逻辑
│       ├── defaultCard.ts      # 默认答题卡模板
│       └── blankLabels.ts      # 题号标签
├── native/                     # C++ 原生代码
│   └── AnswerCardRecognizer/
│       └── answer-card-recognizer/
│           ├── main.cpp                  # CLI 入口
│           ├── answer_recognition.cpp    # 客观题/学号识别
│           ├── vision_utils.cpp          # 图像处理工具
│           ├── layout_io.cpp             # 布局文件读写
│           └── common.cpp                # 公共函数
├── scripts/
│   ├── scanner/
│   │   └── kodak_scan.py       # 柯达 i3000 WIA 扫描脚本
│   ├── image_processing/       # Python 版识别原型
│   │   ├── answer_recognition.py
│   │   ├── vision_utils.py
│   │   └── layout_io.py
│   └── build-server.ts         # 服务端构建脚本
├── electron/
│   └── main.cjs                # Electron 主进程
├── data/answer-card/           # 运行时数据（.gitignore）
│   ├── answer-card.db          # SQLite 数据库
│   ├── cards/                  # 答题卡定义 JSON
│   ├── layouts/                # 布局坐标 JSON
│   ├── assets/                 # 图片资源
│   ├── scans/                  # 扫描文件
│   └── thumbnails/             # 缩略图
├── build/
│   └── icon.svg                # 应用图标
└── resources/native/win-x64/
    └── answer-card-recognizer.exe  # C++ 识别引擎
```

## 开发

### 环境要求

- Windows 10/11
- Node.js ≥ 22
- npm
- Visual Studio 2022（构建 C++ 识别引擎时需要）
- Python ≥ 3.11 + pywin32（柯达扫描时需要）

### 安装依赖

```powershell
npm.cmd install
```

如果 Electron 安装遇到 SSL 证书问题：
```powershell
npm.cmd install --ignore-scripts
```

### Web 开发模式

```powershell
npm.cmd run dev
```

- 前端：http://127.0.0.1:5173
- 后端 API：http://127.0.0.1:5174

### 本地服务模式（生产构建预览）

```powershell
npm.cmd run build
npm.cmd run server
```

打开 http://127.0.0.1:5174

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm.cmd run dev` | Web 开发模式（前后端热重载） |
| `npm.cmd run build` | 类型检查 + 构建前端 + 构建服务端 |
| `npm.cmd run typecheck` | TypeScript 类型检查 |
| `npm.cmd run server` | 运行本地服务 |
| `npm.cmd run electron:dev` | 构建后启动 Electron 桌面应用 |
| `npm.cmd run electron:pack` | 生成 Electron 目录包（测试用） |
| `npm.cmd run electron:dist` | 生成 Windows 便携版 EXE |
| `npm.cmd run electron:msi` | 生成 Windows MSI 安装包 |

## 打包

### Windows 便携版 EXE

```powershell
npm.cmd run electron:dist
```

输出：`release/答题卡设计系统-0.1.0-x64.exe`

### Windows MSI 安装包

```powershell
npm.cmd run electron:msi
```

输出：`release/答题卡设计系统-0.1.0-x64.msi`

MSI 适合学校机房、域控、SCCM、Intune 等集中部署场景。单机使用优先选择便携版 EXE。

如果从旧构建缓存打包遇到 WiX 错误，清理后重试：
```powershell
Remove-Item -Recurse -Force .\release\__msi-x64
npm.cmd run electron:msi
```

## 柯达扫描仪接入

### 前置条件

```powershell
pip install pywin32
```

### 使用方法

1. 打开程序 → 扫描管理 → 设置
2. 扫描仪驱动选择「柯达 SDK 直连（WIA）」
3. 保存设置
4. 在扫描面板中配置 DPI、色彩模式和双面开关
5. 将纸张放入 ADF 进纸器
6. 点击「开始扫描」

扫描完成后图片自动导入、生成缩略图并可选自动触发识别。

### 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| 扫描仪未连接 | 设备未开机或 USB 未接 | 检查电源和 USB 连接 |
| 缺少 pywin32 | Python 环境未安装该库 | `pip install pywin32` |
| 扫描超时 | ADF 卡纸或纸张过多 | 检查进纸器，减少纸张数量 |
| 无法启动 Python | Python 不在 PATH 中 | 在设置中添加 `python_path` 配置 |

## C++ 识别引擎

### 构建

在 Visual Studio 2022 中打开 `native/AnswerCardRecognizer/answer-card-recognizer/` 解决方案，Release x64 构建。

构建产物：`answer-card-recognizer.exe`

产物需要复制到 `resources/native/win-x64/`，Electron 打包时通过 `extraResources` 包含。

### CLI 接口

```
answer-card-recognizer.exe \
  --image scan.jpg \
  --layout layout.json \
  --page 1 \
  --dpi 300 \
  --debug \
  --debug-dir ./debug_out/
```

输出 JSON 到 stdout，包含：
- `status`：识别状态（ok/partial/failed）
- `studentId`：学号识别结果
- `questions`：每题选项和置信度
- `quality`：定位标记匹配质量

## API 参考

### 答题卡管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/cards` | 列出所有答题卡 |
| POST | `/api/cards` | 创建新答题卡 |
| GET | `/api/cards/:id` | 读取答题卡 |
| PUT | `/api/cards/:id` | 保存答题卡 |
| GET | `/api/cards/:id/layout` | 获取布局 JSON |
| GET | `/api/cards/:id/pdf` | 生成 PDF |

### 扫描管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/scans` | 扫描记录列表 |
| GET | `/api/scans/:id` | 扫描详情 |
| POST | `/api/scans/upload-file` | 上传扫描文件 |
| POST | `/api/scans/folder` | 批量扫描文件夹 |
| POST | `/api/scans/:id/recognize` | 触发识别 |
| DELETE | `/api/scans/:id` | 删除扫描记录 |
| GET | `/api/scans/config` | 获取扫描配置 |
| PUT | `/api/scans/config` | 更新扫描配置 |
| GET | `/api/scanner/status` | 扫描仪状态 |
| POST | `/api/scanner/scan` | 柯达直连扫描 |
| POST | `/api/scanner/scan/cancel` | 取消柯达扫描 |

### 识别与评分

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/cards/:id/recognition/objective` | 单张客观题识别 |
| POST | `/api/cards/:id/grading/objective` | 批量客观题评分 |

## 使用流程

1. **设计答题卡**：左侧列表 → 新建 → 编辑标题、题块、选项 → 保存 → 导出 PDF 并打印。
2. **扫描录入**：切换到「扫描」视图 → 导入图片（拖拽/选择文件夹/柯达直连扫描）。
3. **机器阅卷**：选择答题卡并关联 → 触发识别 → 查看成绩表 → 导出 CSV。

## 许可

MIT License
