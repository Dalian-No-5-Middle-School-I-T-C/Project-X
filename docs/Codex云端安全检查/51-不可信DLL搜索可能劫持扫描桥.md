# 51 不可信DLL搜索可能劫持扫描桥

- 原标题：Untrusted DLL search can hijack Scanner Bridge
- 云端级别：Informational
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/1869f3c8b46c81918c59372b8c21d212?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=3)
- 关联提交：[c8b993a](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/c8b993a799842d8e07207e291e74c388cee05663)

## 概要

提交以自定义 LoadLibraryA 解析器替代直接 DSM_Entry 链接。候选顺序包含环境指定路径、固定 D 盘开发路径、裸名称 TWAINDSM.dll 和 twain_32.dll。固定开发路径优先于打包 DLL，裸名称会使用进程 DLL 搜索位置。

LoadLibraryA 在 GetProcAddress 检查 DSM_Entry 前执行 DLL 初始化，因此恶意 DLL 即使不导出该函数也能执行。构建通常复制合法 DLL 到 scanner-bridge.exe 旁，但复制失败只警告，且无法消除更早的固定 D 盘候选。

建议将配置或打包 DLL 解析为规范绝对路径，使用受限 LoadLibraryEx 搜索标志，并优先校验发布者或摘要。

## 验证与路径

静态确认新增候选顺序与加载行为，源枚举经 main.cpp、listSources、openDSM 到达加载器；GET /api/scanner/sources 以 list 参数启动扫描桥，扫描也触发相同路径。Windows DLL 动态证明未执行：原 Linux 环境没有 Windows SDK、工具链、Wine 或已构建扫描桥。

本地人可写候选路径 → 放置 DLL → 没有更早有效环境 DSM → 用户枚举扫描源或开始扫描 → 初始化代码以启动扫描桥的账号执行。

## 等级判断

跨账号执行若成立，影响高、可能性低，技术矩阵为低危；最终为信息提示。仓库没有证明实际 D 盘/搜索目录可被低权限人写入，也没有证明扫描桥提权、服务账号或攻击者与运行者之间的权限差。受管理扫描工作站与回环桌面部署进一步限制现实路径。仅远程触发不能提供本地 DLL 写入能力。

## 前提与防护

Windows 工作站，攻击者可写固定开发路径或有效搜索目录，没有先于恶意 DLL 的有效 TWAIN_DSM_DLL，后续触发枚举/扫描，并存在权限或数据访问差异，才产生超出本人执行的安全影响。

原固定路径为 D:\twain-dsm-2.5.1\twain-dsm-2.5.1\Releases\dsm_020403\windows\64\TWAINDSM.dll。服务监听回环，Electron 用动态端口，桥通过参数数组而非 shell 启动，未发现主动提权。扫描路由本身无认证。未发现受限搜索目录设置、签名或摘要验证。

## 盲点

未检查真实发布包、DLL 位置/签名、Windows ACL、运行账号、系统级搜索配置或是否提权启动。固定路径是否存在及可写未知，也未运行 Windows PoC。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c8b993a799842d8e07207e291e74c388cee05663/native/ScannerBridge/scanner-bridge/twain_controller.cpp#L40-L60)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c8b993a799842d8e07207e291e74c388cee05663/scripts/build-scanner-bridge.bat#L145-L165)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-51)。
