# Project-X | 五中智能试卷管理系统

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/platform-Windows-green.svg" alt="Platform">
  <img src="https://img.shields.io/badge/license-GPLV3.0-yellow.svg" alt="License">
  <img src="https://img.shields.io/badge/tech-Electron%20%7C%20React%20%7C%20Node.js-9cf.svg" alt="Tech Stack">
</p>

## 项目简介

**Project-X** 是大连市第五中学信息化部（I.T.C.）自主开发的智能试卷管理工具，旨在解决学校长期依赖外包扫描答题卡与阅卷系统所带来的**报错频繁、费用高昂、受制于人**等核心痛点。

本项目由信息化部成员 **1g NaOH、火箭、云墨丹心、近代先人、CH（往届学长）** 牵头推进，从零开始构建一套属于学校自己的、可自主可控的答题卡设计与阅卷解决方案。

> **当前版本**：v0.1.0（答题卡设计系统）  
> **核心能力**：答题卡设计 → A4 PDF 导出 → Windows 桌面端分发  
> **未来规划**：扫描识别 → 自动阅卷 → 成绩统计

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

### 当前已实现（v0.1.0）

- **答题卡设计**：新建、保存、读取答题卡，每张答题卡自动生成唯一 ID
- **A4 标准版式**：包含答题卡 ID、标题、六个定位方块、学生信息区、学号填涂区、正文题块和页脚页码
- **客观题设计**：
  - 支持单选、多选、不定项
  - 可配置选项数、题量、分值
  - 四种密度预设：宽松、标准、紧凑、高密
  - 题块可灵活插入主观题之间，不固定在最前
- **主观题设计**：
  - 支持带顶部分数填涂区的手工给分样式
  - 支持无顶部分数填涂区的纯书写块
  - 内容支持：填空、横线格、空白大框、最小高度设置、图片插入
- **PDF 导出**：生成标准 A4 PDF，适合直接打印
- **坐标数据保存**：保存定位块、学号填涂点、客观题填涂点、主观题框、分数格和图片区域的毫米坐标，为后续自动阅卷预留接口
- **Windows 桌面端**：支持便携版 EXE 和 MSI 安装包两种分发方式

### 待实现功能

- [ ] 填空题分值支持设置为单空分值的倍数
- [ ] 主观题分数超过 16 分后，改为分别填涂十位、个位、十分位
- [ ] 扫描识别模块（摄像头/扫描仪接入）
- [ ] 自动阅卷算法（客观题自动判分）
- [ ] 成绩统计与数据分析面板

---

## 快速开始

### 普通用户

#### 方式一：便携版 EXE（推荐临时使用）

1. 前往 [GitHub Releases](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/releases) 下载：
   ```
   答题卡设计系统-0.1.0-x64.exe
   ```
2. 双击即可运行，无需安装，不写注册表

#### 方式二：MSI 安装包（推荐机房部署）

1. 下载：
   ```
   答题卡设计系统-0.1.0-x64.msi
   ```
2. 适合学校机房、域控、SCCM、Intune、组策略等集中部署场景

#### 基本使用流程

1. 打开程序
2. 点击「新建答题卡」
3. 编辑标题、学生信息、客观题块和主观题块
4. 调整客观题密度和主观题样式
5. 点击保存
6. 导出 PDF 并打印
7. 答题卡的 JSON 文件保存在 `%APPDATA%\answer-card-designer\data\answer-card\`

> **数据存储说明**：桌面版会把答题卡数据保存到当前 Windows 用户的应用数据目录，不会写入安装目录，保障多用户环境下的数据隔离。

---

### 开发人员

#### 环境要求

- Windows 操作系统
- Node.js v25.8.2

#### 安装依赖

```powershell
npm install
```

#### 提示

现在 `node_modules` 是 `Electron ABI`。如果之后要直接跑 `npm run server`，先执行

```powershell
npm run native:rebuild:node
```

#### 开发模式

**Web 开发模式**（前端热更新）：
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

#### 打包发布

```powershell
# 构建前端和服务端产物
npm run build

# 生成 Electron 目录包（本机测试）
npm run electron:pack
# 输出：release/win-unpacked/答题卡设计系统.exe

# 生成 Windows 便携版 EXE
npm run electron:dist
# 输出：release/答题卡设计系统-0.1.0-x64.exe

# 生成 Windows MSI 安装包
npm run electron:msi
# 输出：release/答题卡设计系统-0.1.0-x64.msi
```

> **打包提示**：MSI 由 electron-builder 调用 WiX Toolset 生成。若从旧构建缓存继续打包时遇到 WiX 图标引用错误，可删除旧的 MSI 临时目录后重新打包：
> ```powershell
> Remove-Item -Recurse -Force .\release\__msi-x64
> npm.cmd run electron:msi
> ```

#### 常用脚本速查

| 命令 | 说明 |
|------|------|
| `npm. run typecheck` | TypeScript 类型检查 |
| `npm. run build` | 构建前端和服务端 |
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
├── src/                    # 源代码
│   ├── client/             # 前端（React + Electron）
│   ├── server/             # 后端服务（Node.js）
│   └── shared/             # 共享类型与工具
├── dist/                   # 构建产物
│   ├── client/             # 前端构建输出
│   └── server/             # 服务端构建输出
├── release/                # 打包输出（EXE / MSI）
├── build/                  # 构建配置与图标资源
└── docs/                   # 文档与 Wiki 资源
```

---

## 技术栈

- **前端**：React + TypeScript + Electron
- **后端**：Node.js + Express/Fastify
- **构建工具**：Vite
- **打包工具**：electron-builder + WiX Toolset（MSI）
- **PDF 生成**：客户端原生支持
- **数据存储**：本地 JSON / SQLite（后续版本）

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
