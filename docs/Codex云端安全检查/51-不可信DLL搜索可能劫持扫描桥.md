# 51 不可信DLL搜索可能劫持扫描桥

- 原标题：Untrusted DLL search can hijack Scanner Bridge
- 云端级别：信息提示（Informational）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/1869f3c8b46c81918c59372b8c21d212?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=3)
- 关联提交：[c8b993a](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/c8b993a799842d8e07207e291e74c388cee05663)

- 页面时间：2026 年 6 月 12 日 18:40（原页面未注明时区）。
- 操作者：chuh。

## 概要

此问题由本次修改引入：修改新增基于 LoadLibraryA 的自定义 DSM 解析器，以及不安全的候选路径顺序。基线直接调用 DSM_Entry，没有这种显式的开发者路径和裸文件名运行时加载逻辑。

提交用自定义加载器替换原先通过链接调用的 DSM_Entry。在首次 TWAIN 操作时，它把若干未经验证的候选项传给 LoadLibraryA，包括一个固定的 D: 盘开发者路径，以及之后的裸文件名 TWAINDSM.dll 和 twain_32.dll。固定路径先于打包 DLL 名称检查，而裸文件名加载可能搜索应用目录及其他进程搜索位置。LoadLibraryA 会在 GetProcAddress 检查 DSM_Entry 是否存在之前执行 DLL 初始化代码，因此只需在有效位置植入 DLL 就足够了。构建脚本通常把 TWAINDSM.dll 复制到 scanner-bridge.exe 旁边，这限制了裸文件名情形；但复制失败时打包只给出警告后继续，运行时加载器仍优先尝试硬编码 D: 路径。能够在该路径创建或替换 DLL，或在未附带 DLL 的安装中向有效搜索目录写入文件的低权限本地用户，可以在枚举扫描源或启动扫描时，以运行 Project-X 的账号执行代码。仅能通过互联网访问的攻击者无法创建这种本地文件，而且威胁模型明确假设扫描工作站受管理，因此项目特定严重性为低。扫描桥应将操作者配置或打包的 DLL 解析为规范绝对路径，使用 LoadLibraryEx 搜索标志限制加载，最好还验证发布者或摘要。

## 验证

1. 确认受影响提交引入自定义解析器、确切候选顺序，以及先 LoadLibraryA、后 GetProcAddress 的行为。
2. 确定攻击者控制的文件、最近的控制措施、存在问题的加载操作，以及文件系统和权限前提。
3. 确认正常扫描源枚举和扫描通过真实命令行及应用接口到达加载器。
4. 确认相邻 DSM 缺失时打包仍可继续，且打包 DLL 不会优先于更早的硬编码 D: 候选路径。
5. 在 Windows 上通过 scanner-bridge 动态加载验证 DLL：此步骤被阻塞，因为 Linux 环境没有 Windows SDK／工具链、Wine 或已构建扫描桥二进制。

## 证据注释

1. 引入未经验证的环境变量路径、硬编码开发者路径及裸文件名 DLL 候选，并在检查导出函数之前使用 LoadLibraryA 加载各候选。
2. 使用同一开发者专属默认 DLL 路径；预期相邻 TWAINDSM.dll 无法复制时，只给出警告并允许继续打包，因此运行时仍可能进入兜底搜索。

## 攻击路径分析

策略排除之前，条件性的原生代码执行具有高影响，但发生可能性低，按矩阵映射为低严重性。最终单独的策略阶段将其排除为 ignore，因为仓库证据没有建立现实、范围内的低权限攻击者路径：该攻击者既能写入硬编码或有效搜索路径，又能获得超出其现有账号的访问。文档中的产品部署是仅使用回环接口的 Electron 扫描应用，以启动用户的令牌运行，没有证据显示服务提权或跨用户 ACL 条件。受管理工作站假设进一步削弱了本地攻击情景。打包的相邻 DSM 并不能决定性地否定代码缺陷，因为硬编码 D: 路径先被尝试，打包也容忍缺少 DSM；但这些事实本身不能证明所需的额外权限收益，因此按所提供策略，这种本地文件植入问题不可报告。

### 路径

低权限本地 Windows 用户 → 需要文件系统写入权限 → 在选定候选路径放置攻击者控制的 DLL → 该路径被优先选中，或通过裸文件名兜底选中 → LoadLibraryA 候选循环 → LoadLibraryA 在 GetProcAddress 之前运行 DLL 初始化 → scanner-bridge.exe 进程 → 继承启动进程的账号令牌 → 以扫描桥账号的访问权限执行原生代码。

这是生产扫描流程中真实的条件性 DLL 劫持漏洞。native/ScannerBridge/scanner-bridge/twain_controller.cpp:40–60 使用 LoadLibraryA 加载环境变量选定的路径、固定 D: 盘开发者路径、TWAINDSM.dll 和 twain_32.dll。固定 D: 路径先于打包 DLL 名称尝试，最后两个候选使用不受限制的裸文件名解析。由于 LoadLibraryA 在 GetProcAddress 检查 DSM_Entry 之前初始化模块，即使植入 DLL 不导出预期函数，也可以执行。正常源枚举通过 main.cpp:31–41、twain_controller.cpp:180–184 的 listSources，以及第 400–405 行的 openDSM 到达该操作。回环 GET /api/scanner/sources 路由也会以 list 参数调用 scanner-bridge，扫描同样进入该加载器。最强反向证据来自运行条件：Electron 将 API 绑定 127.0.0.1，构建通常将合法 TWAINDSM.dll 放在扫描桥旁，假设扫描工作站受管理，仓库也没有证明攻击者可写 D: 的 ACL，或扫描桥使用提权或独立账号。相邻 DLL 不能消除更早硬编码候选的影响，DSM 复制失败也只是警告，但没有建立现实的跨账号权限边界。由于提供的环境缺少所需 Windows 运行时和工具链，没有执行 Windows 可运行验证。

## 发生可能性

低（Low）。利用是本地且有条件的，需要 Windows 部署、候选 DLL 路径写入权限、没有更早有效 DSM 候选，以及后续枚举或扫描操作。API 仅绑定回环地址，扫描工作站被假设为受管理，构建通常打包相邻 DSM。硬编码 D: 候选仍会先被尝试，打包也可以在没有 DSM 时继续，但仓库文件无法确定生产 ACL、D: 盘是否存在或可写，以及扫描桥是否使用提权身份。这些条件支持较低的技术发生可能性，而不是现实的远程或局域网攻击路径。

## 影响程度

高（High）。如果低权限攻击者控制选中 DLL 路径，而扫描桥以权限更高或能够访问更多数据的账号运行，DLL 初始化可赋予该账号访问范围内的任意原生代码执行，影响本地扫描操作及可访问应用数据的机密性、完整性和可用性。因此，成功跨账号利用的影响为高，但仓库没有证明这种权限差异实际存在。

## 假设条件

- 受影响部署为 Windows，并包含 scanner-bridge.exe。
- 低权限本地攻击者能够在硬编码路径 D:\twain-dsm-2.5.1\twain-dsm-2.5.1\Releases\dsm_020403\windows\64\TWAINDSM.dll，或有效 Windows 裸文件名 DLL 搜索位置创建或替换 DLL。
- 在攻击者控制的候选之前，没有选中有效的 TWAIN_DSM_DLL 环境变量候选。
- 用户或本地请求随后执行扫描源枚举或扫描。
- 植入文件的攻击者与运行 Project-X 的账号之间，存在有意义的权限或数据访问差异；仓库没有证明这种差异。

原文另列前提：

- 使用 Windows 扫描工作站。
- 对硬编码 D: 候选路径或其他有效 DLL 搜索目录具有写入权限。
- 不存在更早且有效的环境变量所选 DSM。
- 执行扫描源枚举或扫描。
- 若要产生超出自我执行的安全影响，攻击者与扫描桥账号之间必须存在权限或数据访问差异。

## 控制措施

- 应用服务绑定 127.0.0.1，而非公共接口。
- Electron 在临时端口启动本地服务。
- 构建通常将 TWAINDSM.dll 复制到 scanner-bridge.exe 旁边，降低裸文件名 TWAINDSM.dll 情形的实际风险。
- 通过参数数组启动扫描桥可执行文件，而非通过命令 shell。
- 扫描桥以启动账号令牌运行，没有证据显示刻意提权。
- 所提供威胁模型假设扫描工作站在物理上受管理。
- 没有发现该加载器使用 SetDefaultDllDirectories、AddDllDirectory、SetDllDirectory、受限 LoadLibraryEx 标志、签名验证或摘要验证。
- 扫描路由本身不提供认证或授权，不过其服务绑定回环地址。

## 盲点

- 工作区没有已构建的 scanner-bridge.exe 或具体发布包，因此无法检查实际打包 DLL 位置及签名。
- 仓库文件没有定义 D: 路径、应用目录、当前目录或其他 DLL 搜索位置的生产 Windows ACL。
- 仓库无法确定 Project-X 是否曾以提升权限、Windows 服务或能够访问本地攻击者不可访问数据的专用账号启动。
- 没有 Windows 运行时、Wine 环境、Windows SDK 或交叉工具链可用于执行验证 DLL。
- 实际 Windows DLL 搜索顺序可能随操作系统配置及仓库之外的进程级设置变化。
- 工作区没有外部反向代理或隧道配置；不过，远程触发本身也不能提供所需本地 DLL 写入权限。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [native/ScannerBridge/scanner-bridge/twain_controller.cpp:40](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c8b993a799842d8e07207e291e74c388cee05663/native/ScannerBridge/scanner-bridge/twain_controller.cpp#L40)

~~~~cpp
    if (!dsmEntry) {
        char envPath[MAX_PATH] = {};
        DWORD envLen = GetEnvironmentVariableA("TWAIN_DSM_DLL", envPath, static_cast<DWORD>(sizeof(envPath)));
        const char* envCandidate = (envLen > 0 && envLen < sizeof(envPath)) ? envPath : nullptr;
        const char* candidates[] = {
            envCandidate,
            "D:\\twain-dsm-2.5.1\\twain-dsm-2.5.1\\Releases\\dsm_020403\\windows\\64\\TWAINDSM.dll",
            "TWAINDSM.dll",
            "twain_32.dll"
        };

        for (const char* candidate : candidates) {
            if (!candidate || !candidate[0]) continue;
            dsmModule = LoadLibraryA(candidate);
            if (!dsmModule) continue;

            dsmEntry = reinterpret_cast<DsmEntryProc>(GetProcAddress(dsmModule, "DSM_Entry"));
            if (dsmEntry) break;

            FreeLibrary(dsmModule);
            dsmModule = nullptr;
~~~~

### [scripts/build-scanner-bridge.bat:145](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c8b993a799842d8e07207e291e74c388cee05663/scripts/build-scanner-bridge.bat#L145)

~~~~text
set "TWAIN_DSM_DLL=%TWAIN_DSM_DLL%"
if not defined TWAIN_DSM_DLL set "TWAIN_DSM_DLL=D:\twain-dsm-2.5.1\twain-dsm-2.5.1\Releases\dsm_020403\windows\64\TWAINDSM.dll"

if exist "%OUTPUT%" (
    echo Output: %OUTPUT%
    echo.

    if not exist "%DEST%" mkdir "%DEST%"
    copy /Y "%OUTPUT%" "%DEST%\scanner-bridge.exe" >nul
    if !ERRORLEVEL! EQU 0 (
        echo Copied to: %DEST%\scanner-bridge.exe
        if exist "%TWAIN_DSM_DLL%" (
            copy /Y "%TWAIN_DSM_DLL%" "%DEST%\TWAINDSM.dll" >nul
            if !ERRORLEVEL! EQU 0 (
                echo Copied to: %DEST%\TWAINDSM.dll
            ) else (
                echo [WARNING] Failed to copy TWAINDSM.dll from: %TWAIN_DSM_DLL%
            )
        ) else (
            echo [WARNING] TWAINDSM.dll not found: %TWAIN_DSM_DLL%
        )
~~~~
