# Project-X 答题卡设计系统

五中信息化部自主开发的智能试卷管理工具。当前版本聚焦答题卡设计、A4 PDF 导出和 Windows 桌面端分发，后续可继续接入扫描识别、自动阅卷和成绩统计。

## 当前版本

当前版本：`0.1.0`

推荐 GitHub Release tag：

```text
v0.1.0
```

推荐 Release 标题：

```text
答题卡设计系统 v0.1.0
```

如果只是校内灰度试用，可以使用 `v0.1.0-beta.1`；如果作为第一个可安装版本发布，建议直接使用 `v0.1.0`。

## 功能概览

- 答题卡设计：新建、保存、读取答题卡，每张答题卡自动生成唯一 ID。
- A4 版式：包含答题卡 ID、标题、六个定位方块、学生信息区、学号填涂区、正文题块和页脚页码。
- 客观题：始终按机器阅卷填涂框生成，支持单选、多选、不定项、选项数、题量、分值和密度预设。
- 客观题密度：支持宽松、标准、紧凑、高密，最高密度控制在现有参考图 `image_2/3/4` 的水平。
- 题块排序：客观题块不固定在最前面，可以插入到主观题之间。
- 主观题：支持带顶部分数填涂区的手工给分样式，也支持无顶部分数填涂区的纯书写块。
- 主观题内容：支持填空、横线格、空白大框、最小高度设置和图片插入。
- PDF 导出：生成 A4 PDF，适合直接打印。
- 坐标数据：保存定位块、学号填涂点、客观题填涂点、主观题框、分数格和图片区域的毫米坐标，为后续自动阅卷预留。
- 桌面端：支持 Windows 便携版 EXE 和 MSI 安装包。

## 待实现功能

- 填空题分值是单空分值的倍数
- 主观题分数超过16分后改为分别填涂十位、个位、十分位

## 普通用户使用

### 便携版 EXE

从 GitHub Release 下载：

```text
答题卡设计系统-0.1.0-x64.exe
```

双击即可运行，不需要安装。

### MSI 安装包

从 GitHub Release 下载：

```text
答题卡设计系统-0.1.0-x64.msi
```

MSI 适合学校机房、域控、SCCM、Intune、组策略等集中部署场景。单机临时使用优先选择便携版 EXE。

### 基本流程

1. 打开程序。
2. 点击“新建答题卡”。
3. 编辑标题、学生信息、客观题块和主观题块。
4. 调整客观题密度和主观题样式。
5. 点击保存。
6. 导出 PDF 并打印。

桌面版会把答题卡数据保存到当前 Windows 用户的应用数据目录，不会写入安装目录。

## 开发人员使用

### 环境要求

- Windows
- Node.js
- npm

PowerShell 下建议使用 `npm.cmd`。

### 安装依赖

```powershell
npm.cmd install
```

### Web 开发模式

```powershell
npm.cmd run dev
```

打开：

```text
http://127.0.0.1:5173
```

前端默认端口是 `5173`，后端 API 默认端口是 `5174`。

### 本地服务模式

```powershell
npm.cmd run build
npm.cmd run server
```

打开：

```text
http://127.0.0.1:5174
```

## 打包

### 构建 Web 和服务端产物

```powershell
npm.cmd run build
```

输出：

- `dist/client/`
- `dist/server/index.mjs`

### Electron 目录包

```powershell
npm.cmd run electron:pack
```

输出：

```text
release/win-unpacked/答题卡设计系统.exe
```

目录包主要用于本机测试。

### Windows 便携版 EXE

```powershell
npm.cmd run electron:dist
```

输出：

```text
release/答题卡设计系统-0.1.0-x64.exe
```

### Windows MSI

```powershell
npm.cmd run electron:msi
```

输出：

```text
release/答题卡设计系统-0.1.0-x64.msi
```

也可以直接运行：

```powershell
npm.cmd run build
npx electron-builder --win msi
```

MSI 目标由 electron-builder 调用 WiX Toolset 生成。项目已配置 `build/icon.svg` 和 `msi.shortcutName`，用于生成应用图标和快捷方式图标。

如果从旧构建缓存继续打包时遇到 WiX 图标引用错误，可以删除旧的 MSI 临时目录后重新打包：

```powershell
Remove-Item -Recurse -Force .\release\__msi-x64
npm.cmd run electron:msi
```

## 常用脚本

```powershell
npm.cmd run typecheck      # TypeScript 类型检查
npm.cmd run build          # 构建前端和服务端
npm.cmd run dev            # Web 开发模式
npm.cmd run server         # 运行本地服务
npm.cmd run electron:dev   # 构建后启动 Electron
npm.cmd run electron:pack  # 生成 Electron 目录包
npm.cmd run electron:dist  # 生成 Windows 便携版 EXE
npm.cmd run electron:msi   # 生成 Windows MSI 安装包
```