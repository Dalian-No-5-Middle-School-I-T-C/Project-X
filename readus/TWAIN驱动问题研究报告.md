# TWAIN 驱动问题研究报告

- 研究对象：`Project-X/native/ScannerBridge/scanner-bridge/`（C++ 原生 TWAIN 驱动）
- 审计日期：2026-07-26
- 结论：**该 TWAIN 驱动存在多处严重缺陷，目前基本无法在常规 64 位部署下正常工作**，且与官方《快速问题处置报告》中的 PX-COR-009 完全吻合，属于**未修复的开放问题**。

## 一、整体结论

| 等级 | 问题 | 影响 |
| --- | --- | --- |
| 严重 | 事件消息泵监听了错误的窗口消息，且转发给 DSM 的事件结构为空 | 扫描永远收不到 `MSG_XFERREADY`，每次扫描卡 60 秒后失败（最常见的"扫描仪起不来"根因） |
| 严重 | x64 原生传输把 8 字节 `HBITMAP` 写进 4 字节 `TW_UINT32` | x64 下句柄截断 / 栈越界 / 崩溃 / 空白图 |
| 严重 | 仓库只提交了 `win-ia32`，缺 `win-x64` 产物 | 64 位 Electron 默认找不到 `scanner-bridge.exe` 与 `TWAINDSM.dll`，扫描直接不可用 |
| 严重 | 工程硬编码 `D:\twain-dsm-2.5.1\...` 包含路径（`twain.h` 不在仓库） | 换机器或 CI 无法编译 |
| 重要 | 8bpp/1bpp（灰度/黑白，默认 gray 模式）GDI+ 保存未设调色板 | 最常见的扫描模式输出错误配色或保存失败 |
| 重要 | 双面扫描状态机未复位，`waitForState(6)` 立即返回 | 背面页丢失或抢拍 |
| 重要 | `success = pages.size()>0` | 部分页失败的批次被当作成功，下游用不完整数据评分 |
| 次要 | 取消不杀原生子进程、GDI+ 未 Shutdown、ANSI 参数中文路径解码错误等 | 孤儿进程、资源泄漏、含中文输出目录保存失败 |

## 二、严重问题（逐项已对照源码验证）

### C1. TWAIN 事件消息泵监听了错误的消息（twain_controller.cpp:75, 79-85, 150-173, 792-813）

- `twain_controller.cpp:75` 自定义了 `TWAIN_MSG = WM_USER + 1`，并在 `WndProc` 中**只处理**该消息（`msg == TWAIN_MSG`）。
- 但 TWAIN DSM 是通过自己的注册窗口消息（通常是 `RegisterWindowMessage("Twain_32_Message")`）把 `MSG_XFERREADY` 等状态投递给父窗口的，**永远不会发 `WM_USER+1`**。因此 `processTwainEvent` 基本从未收到真实的 TWAIN 消息。
- `processTwainEvent`（150-173 行）还把 `event.pEvent = nullptr`，并把 `event.TWMessage` 设成伪造的 `wParam`。按规范必须传入**真实** `MSG` 结构指针（`pEvent = &msg`，其中 `msg.message/wParam/lParam` 来自消息循环）。
- 结果：`waitForState(6, 60000)` 在消息循环中即便 `DispatchMessage` 也永远等不到 `m_state==6`，直到 60 秒超时 → 扫描整体失败。

> 这是"扫描仪点开始一直转、最后报错"最可能的根本原因。

### C2. x64 原生传输句柄宽度错误（twain_controller.cpp:659-677）

```cpp
TW_UINT32 handle = 0;                       // 仅 4 字节
rc = DSM_Entry(..., DAT_IMAGENATIVEXFER, MSG_GET, (TW_MEMREF)&handle); // 实际写入 8 字节 HBITMAP
...
if (handle) GlobalFree((HGLOBAL)(uintptr_t)handle);
```

`DAT_IMAGENATIVEXFER` 返回的是 Windows `HBITMAP`（指针，x64 下 8 字节）。写入 4 字节变量会**污染相邻栈内存并截断句柄**；随后 `GlobalLock`/`GlobalFree` 作用在失效指针上 → 崩溃、越界或空白/垃圾图。64 位构建必现。应按 TWAIN 规范把 `pData` 指向一个指针宽变量（`HBITMAP`/`TW_HANDLE`）。

### C3. 缺少 win-x64 原生产物（resources/native 目录确认）

- 仓库仅提交 `resources/native/win-ia32/{scanner-bridge.exe, TWAINDSM.dll, answer-card-recognizer.exe, opencv_world4130.dll}`。
- `win-x64` 目录**不存在**。而 64 位 Electron 默认解析 `win-x64`，找不到 `scanner-bridge.exe` 会直接抛"未找到扫描仪桥接程序"，扫描在启动前就已失效。
- 需要重新构建并提交 x64 产物（见 C4 编译障碍）。

### C4. 工程与构建脚本的硬约束（scanner-bridge.vcxproj:82,101,117,136；:32）

- 四个配置均硬编码 `AdditionalIncludeDirectories=D:\twain-dsm-2.5.1\twain-dsm-2.5.1\TWAIN_DSM\src;...`，`twain.h` 不在仓库内。换机器/CI 无此路径即编译失败。
- `PlatformToolset=v145`（VS2019），而 `build-scanner-bridge.bat` 优先查找 VS2022（v143）。若只装 VS2022，MSBuild 可能因找不到 v145 工具集而失败。
- 构建脚本本身未覆盖该包含路径，也未提供可配置入口（仅 `TWAIN_DSM_DLL` 环境变量可被脚本读取）。

## 三、重要问题

### M1. 8bpp / 1bpp 保存缺少调色板（twain_controller.cpp:702-735）

默认 `colorMode="gray"` 走 `TWPT_GRAY` → 8 位 DIB。`saveDIBToFile` 已计算 `colorTableEntries`（702-705 行），却**没有**把它通过 `bitmap->SetPalette(...)` 注入 GDI+ 的 `Bitmap`。`Bitmap` 从外部缓冲构造索引图时本就没有调色板，`Save` 使用 GDI+ 默认（halftone）调色板 → 灰度/黑白扫描出现假彩色或 `status != Ok` 保存失败。这是最常用扫描模式的真实出坏图来源。

### M2. 双面扫描状态机未复位（twain_controller.cpp:340-344, 308）

首面传输后 `m_state` 停在 `6`（在 `processTwainEvent` 中设），代码从未将其复位到 3/5。于是：
- 双面的"背面"分支 `if (!waitForState(6, 30000))` 立即返回 true，不再泵消息等待背面 `MSG_XFERREADY` → 背面被抢拍或丢页。
- 多页 ADF 的下一页外层循环 `waitForState(6, 60000)` 也立即返回，与驱动实际状态竞争。

（`m_state` 注释称 4=传输中/5=传输完成，但代码实际只用 6，状态机从未完整对账。）

### M3. 部分失败被记为成功（twain_controller.cpp:385-388）

```cpp
result.success = result.pages.size() > 0;
```
若第 2 页捕获失败 `break`，但第 1 页已 `push_back`，则 `success=true`。上游 `scanner-service.ts` 仅在 0 页时报错 → 被截断的扫描被当成"完成扫描"，下游基于不完整数据评分。这正是 PX-COR-009 提到的"失败扫描却可能被当作完成"。

### M4（关联整合层，PX-COR-015）概要

整合层另有独立缺陷，虽非原生驱动本身，但直接决定"扫描最终能不能用"：
- `POST /api/scanner/scan` 先 `await` 整个 `runScanSession`（含扫描+OCR+评分，最长 10 分钟）再返回 202，导致 SSE 进度事件在客户端订阅前全部丢失、界面卡在"扫描中"。
- 取消只关闭 SSE/前端状态，**不终止 `scanner-bridge.exe` 子进程**；`child.kill()` 无强制兜底 → 孤儿进程、ADF 持续送纸。
- 原生模块全程用 ANSI `argv` + `MultiByteToWideChar(CP_UTF8,...)` 解析输出路径，项目目录含中文（"五中自研试卷星"）时路径解码错误 → 保存失败。

## 四、建议修复优先级

1. **C1**：删除 `WM_USER+1` 监听；`WndProc` 把每一条消息都转发给 `DG_CONTROL/DAT_EVENT/MSG_PROCESSEVENT`，并传入真实 `MSG`（`event.pEvent = &msg`）。这一步很可能单独解除"扫描卡死"。
2. **C2**：将 `handle` 改为指针宽类型（如 `HBITMAP`/`TW_HANDLE`），`pData` 指向它。
3. **C3 + C4**：新增 `resources/native/win-x64` 产物；将 `twain.h` 包含路径改为仓库内或可配置（环境变量/相对路径），并使 `PlatformToolset` 与 `build-scanner-bridge.bat` 一致（VS2022→v143 或统一 v145）。
4. **M1**：`saveDIBToFile` 中对 8bpp/1bpp 用 DIB 自带颜色表 `SetPalette` 后再 `Save`。
5. **M2**：每次传输后 `m_state` 复位，并基于 `TW_PENDINGXFERS` 循环等待下一页 `MSG_XFERREADY`。
6. **M3**：`success` 应要求"达到预期页数且无中途失败"，而非只要非空。
7. **M4**：POST 处理器立即返回 202 后再跑 `runScanSession`；取消接口真正终止 `scanner-bridge.exe`；改用 `wmain`/`GetCommandLineW` + UTF-16 路径。

## 五、与官方处置报告的关系

本报告所述原生缺陷与 `readus/Project-X快速问题处置报告.md` 中的 **PX-COR-009**（"TWAIN 集成存在句柄宽度、缓冲区寿命、事件、双面扫描和成功状态缺陷"，置信度中高）完全一致。逐项比对当前源码，**这些缺陷仍然存在且未被修复**（例如 659 行的 `TW_UINT32 handle`、75/79-85 行的 `WM_USER+1`、150-153 行的 `pEvent=nullptr`、340-344 行的双面分支），因此 PX-COR-009 在源码层面是**开放状态**，不是已关闭事件。

> 验证方式：直接读取 `twain_controller.cpp` / `twain_controller.hpp` / `main.cpp` / `scanner-bridge.vcxproj` / `build-scanner-bridge.bat` 并核对 `resources/native` 实际目录；未运行真实扫描硬件或编译。

## 六、修复记录（2026-08-07，全部完成）

本节 8 项缺陷已于 2026-08-07 全部修复并通过编译验证（VS2026 / MSVC 14.51，x64 + ia32 双架构），TS 层通过 `verify:auth`（54 项）与 `verify:security-critical`（42 项）。

| 编号 | 状态 | 修复内容 |
| --- | --- | --- |
| C1 | ✅ 已修复 | `twain_controller.cpp`：删除 `WM_USER+1` 监听，`WndProc` 全量转发消息，`processTwainEvent` 接收真实 `MSG`（`pEvent=&msg`） |
| C2 | ✅ 已修复 | `captureNativeTransfer`：`TW_UINT32 handle` → `TW_HANDLE handle`（指针宽，x64 不再截断/栈污染） |
| C3 | ✅ 已修复 | 新构建并提交 `resources/native/win-x64/{scanner-bridge.exe, TWAINDSM.dll, answer-card-recognizer.exe}`（`.gitignore` 已收窄为只忽略 opencv DLL） |
| C4 | ✅ 已修复 | TWAIN 2.5.1 SDK（`twain.h` + 双架构 `TWAINDSM.dll`）入库 `native/ScannerBridge/third_party/twain-dsm-2.5.1/`；vcxproj 改用 `$(ProjectDir)` 相对路径；build 脚本 DSM 默认路径改仓库内（保留 `TWAIN_DSM_DLL` 覆盖）；另修好 vswhere 发现 MSBuild 的批处理解析 bug（`for /f` 引号剥离 + 块内变量展开时机） |
| M1 | ✅ 已修复 | `saveDIBToFile`：8bpp/1bpp 从 DIB 颜色表构造 `ColorPalette` 并 `SetPalette` 后再保存 |
| M2 | ✅ 已修复 | 捕获循环重写：每次 XFERDONE 后立即 ENDXFER 并复位 `m_state`，背面由 `DAT_PENDINGXFERS` 查询驱动（不再干等 30 秒也不抢拍） |
| M3 | ✅ 已修复 | `success = errorMessage.empty() && pages.size() > 0`；背面捕获失败也写 `errorMessage` |
| M4 | ✅ 已修复 | ① `POST /scan` 先 `createScanSession` 立即 202，扫描+OCR 后台执行，SSE 订阅时补发终态；② 新增 `POST /scan/:sessionId/cancel` 真正终止 `scanner-bridge.exe`（kill + `taskkill /F /T` 强杀兜底），前端取消按钮接入；③ `main.cpp` 改 `wmain` + `GetCommandLineW` 转 UTF-8，中文路径不再乱码 |

补充勘误：原报告 C4 所述"PlatformToolset=v145（VS2019）"有误——v145 实为 VS2026 的正式工具集名，本机（VS2026 / 18.7）直接编译通过，未改动工具集。

遗留验证项（需真实硬件）：C1/C2/M2 的真机扫描行为（消息泵收事件、双面/多页 ADF、灰度图输出）需接入扫描仪后实测；本次仅完成编译、冒烟（`list`/`--help` 正常）与代码审查。
