# 答题卡设计系统 — 扫描输入模块

## 概述

本模块为 Project-X 答题卡设计系统提供**扫描输入**能力，支持从柯达 i3000 系列（及其他品牌）扫描仪获取答题卡图片，自动识别学号与客观题答案，并持久化存储。

## 架构

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────────────┐
│  柯达 i3000     │────▶│  input/ 文件夹    │────▶│  chokidar 监听    │
│  扫描仪         │     │  (可配置)         │     │  (scanner.ts)     │
└─────────────────┘     └──────────────────┘     └────────┬──────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌───────────────────┐
│  React 前端      │◀────│  Express API     │◀────│  SQLite 数据库     │
│  ScanPanel.tsx  │     │  index.ts        │     │  database.ts      │
└─────────────────┘     └────────┬─────────┘     └───────────────────┘
                                 │
                                 ▼
                        ┌───────────────────┐
                        │  C++ 识别引擎      │
                        │  answer-card-      │
                        │  recognizer.exe    │
                        └───────────────────┘
```

## 两种工作模式

### 方案二（当前实现）：文件夹监听

扫描仪将图片输出到指定文件夹 → chokidar 自动检测新文件 → 复制到内部存储 → 生成缩略图 → SQLite 记录 → 自动触发识别。

**优点**：不依赖扫描仪驱动，通用性强，柯达自带软件即支持"扫描到文件夹"。

### 方案一（预留接口）：扫描仪直连

通过 `ScannerDriver` 接口预留了 TWAIN/WIA/柯达 SDK 的扩展点。后续实现只需：

1. 编写实现 `ScannerDriver` 接口的驱动类
2. 在设置中将 `scanner_driver` 配置为对应驱动名
3. 前端调用 `/api/scanner/status` 获取状态

```typescript
// 预留接口（src/apps/answer-card/server/scanner.ts）
interface ScannerDriver {
  scan(options: ScanOptions): Promise<ScanResult>;
  getStatus(): Promise<ScannerStatus>;
  cancel(): Promise<void>;
}
```

## 目录结构

```
src/apps/answer-card/
├── server/
│   ├── database.ts      # SQLite 数据库层（替代旧 storage.ts）
│   ├── scanner.ts        # 扫描输入模块（文件夹监听 + 识别触发）
│   ├── recognition.ts    # C++ 识别引擎调用（已有）
│   ├── index.ts          # Express API 路由（已扩展扫描端点）
│   ├── pdf.ts            # PDF 生成（已有，未改动）
│   └── storage.ts        # 旧 JSON 存储（保留兼容，数据已迁移到 SQLite）
├── client/
│   ├── ScanPanel.tsx     # 扫描管理前端面板
│   ├── App.tsx           # 主应用（新增"设计/扫描"导航）
│   └── styles.css        # 样式（新增扫描面板相关 CSS）
└── input/                # 扫描仪默认输入文件夹
    └── .gitkeep
```

## 数据库表结构（SQLite）

文件：`data/answer-card/answer-card.db`

### cards — 答题卡
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 答题卡 ID（8位数字） |
| title | TEXT | 标题 |
| data_json | TEXT | 完整答题卡 JSON |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

### layouts — 布局缓存
| 字段 | 类型 | 说明 |
|------|------|------|
| card_id | TEXT PK | 答题卡 ID |
| data_json | TEXT | 布局坐标 JSON |
| updated_at | TEXT | 更新时间 |

### scans — 扫描记录
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 扫描 ID（scan_xxxxxxxx） |
| file_name | TEXT | 原始文件名 |
| original_path | TEXT | 原始路径 |
| stored_path | TEXT | 内部存储路径 |
| thumbnail_path | TEXT | 缩略图路径（可空） |
| file_size | INTEGER | 文件大小（字节） |
| width | INTEGER | 图片宽度（像素） |
| height | INTEGER | 图片高度（像素） |
| dpi | INTEGER | 扫描 DPI（默认 300） |
| status | TEXT | 状态：pending/processing/recognized/error |
| card_id | TEXT | 关联的答题卡 ID |
| page_number | INTEGER | 页码 |
| **student_id** | TEXT | **学生考号（从识别结果提取）** |
| student_name | TEXT | 学生姓名（可手动填入） |
| class_name | TEXT | 班级（可手动填入） |
| recognition_json | TEXT | 识别结果 JSON |
| error_message | TEXT | 错误信息 |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

### scan_config — 配置
| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT PK | 配置键 |
| value | TEXT | 配置值 |

**默认配置项**：
- `input_folder` — 输入文件夹路径（默认 `./input`）
- `auto_recognize` — 是否自动识别（默认 `true`）
- `default_dpi` — 默认 DPI（默认 `300`）
- `scanner_driver` — 扫描仪驱动类型（预留）

## API 端点

### 扫描管理（新增）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/scans` | 扫描列表（支持 ?cardId=&status=&studentId=&limit=&offset=） |
| GET | `/api/scans/:scanId` | 扫描详情 |
| POST | `/api/scans/import` | 手动导入文件 { path, cardId?, dpi?, skipRecognition? } |
| POST | `/api/scans/:scanId/recognize` | 触发识别 { cardId, dpi? } |
| PATCH | `/api/scans/:scanId` | 更新记录 { student_id?, student_name?, class_name?, ... } |
| DELETE | `/api/scans/:scanId` | 删除记录 |
| GET | `/api/scans/config` | 获取配置 + 监听状态 |
| PUT | `/api/scans/config` | 更新配置 { input_folder?, auto_recognize?, default_dpi? } |

### 答题卡（保持不变）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/cards` | 列表 |
| POST | `/api/cards` | 创建 |
| GET | `/api/cards/:cardId` | 详情 |
| PUT | `/api/cards/:cardId` | 更新 |
| GET | `/api/cards/:cardId/layout` | 布局坐标 |
| POST | `/api/cards/:cardId/recognition/objective` | 上传图片 + 识别 |
| GET | `/api/cards/:cardId/pdf` | 导出 PDF |

### 扫描仪（预留）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/scanner/status` | 扫描仪状态（当前仅返回 folder 模式） |

## 使用步骤

### 1. 安装依赖

```bash
npm install
```

新增依赖：`better-sqlite3`、`chokidar`、`sharp`、`uuid` 及其类型定义。

### 2. 配置扫描仪输出目录

在柯达 i3000 扫描仪软件中，将输出目录设置为项目的 `input/` 文件夹。

或者在前端"扫描"页面的设置中，自定义输入文件夹路径（支持绝对路径如 `D:\Scans\AnswerCards`）。

### 3. 启动程序

```bash
npm run dev
```

### 4. 扫描答题卡

1. 使用扫描仪扫描答题卡到 `input/` 文件夹
2. 程序自动检测新文件并导入
3. 如有匹配的答题卡，自动触发 C++ 识别引擎
4. 识别完成后，学生考号自动写入数据库
5. 在前端"扫描"页面查看和管理所有扫描记录

### 5. 手动导入

也可在前端手动输入文件路径，指定答题卡后导入。

## 数据迁移

首次启动时，程序会自动检测 `data/answer-card/cards/*.json` 中的旧数据，并迁移到 SQLite 数据库。迁移完成后设置 `json_migrated=true` 标记，不会重复迁移。

## 注意事项

1. **C++ 识别引擎**：需将 `answer-card-recognizer.exe` 编译后放入 `native/AnswerCardRecognizer/x64/Release/`，或设置环境变量 `ANSWER_CARD_RECOGNIZER_EXE`
2. **sharp 依赖**：Windows 上安装 `sharp` 可能需要 Visual C++ Redistributable
3. **better-sqlite3**：Electron 打包时需配置 `asarUnpack` 或使用 `electron-rebuild`
4. **文件清理**：当前不会自动删除 `input/` 中的原始文件，如需清理可在 `scanner.ts` 中取消注释相关代码
5. **数据库文件**：位于 `data/answer-card/answer-card.db`，可用任何 SQLite 工具直接查看

## 扩展指南

### 接入新扫描仪驱动

1. 在 `scanner.ts` 中新建类实现 `ScannerDriver` 接口
2. 在 `index.ts` 的 `/api/scanner/status` 中注册驱动
3. 前端设置页面自动显示新驱动选项

### 扩展识别能力

C++ 识别引擎位于 `native/AnswerCardRecognizer/`，修改后重新编译 EXE 即可。TypeScript 侧通过 `spawn()` 调用，接口不变。
