#include <windows.h>
#include <twain.h>

#include <gdiplus.h>
#pragma comment(lib, "gdiplus.lib")

#include "twain_controller.hpp"
#include <cstdio>
#include <cstring>
#include <algorithm>

using DsmEntryProc = TW_UINT16(TW_CALLINGSTYLE*)(
    pTW_IDENTITY,
    pTW_IDENTITY,
    TW_UINT32,
    TW_UINT16,
    TW_UINT16,
    TW_MEMREF
);

// DSM 加载诊断（文件级静态）：供 list 诊断与 scan 错误信息复用。
// 旧实现只看「枚举结果为空」，无法区分「DSM 没加载」和「DSM 正常但这台机器没装扫描仪驱动」。
static std::string g_dsmLoadedPath;
static std::string g_dsmLoadLog;
static bool g_dsmLoaded = false;

/** 宽字符路径转 UTF-8，仅供诊断日志使用（加载一律走 LoadLibraryW）。 */
static std::string wideToUtf8(const wchar_t* w) {
    if (!w) return {};
    int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (len <= 0) return {};
    std::string out(static_cast<size_t>(len - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), len, nullptr, nullptr);
    return out;
}

namespace ScannerBridge {
bool dsmLoaded() { return g_dsmLoaded; }
const std::string& dsmLoadedPath() { return g_dsmLoadedPath; }
const std::string& dsmLoadLog() { return g_dsmLoadLog; }

/** 当前进程位宽：决定能枚举到 32 位还是 64 位 TWAIN 驱动。 */
const char* bridgeArchName() {
    return sizeof(void*) == 4 ? "ia32" : "x64";
}

/** 位宽相关的可操作提示：32 位驱动只能被 32 位 DSM 枚举，反之亦然。 */
static std::string archHint() {
    if (sizeof(void*) == 4) {
        return "当前为 32 位扫描端，只能枚举 32 位 TWAIN 驱动。"
               "若扫描仪只提供 64 位驱动，请改装 x64 版扫描端。";
    }
    return "当前为 64 位扫描端，只能枚举 64 位 TWAIN 驱动。"
           "老旧扫描仪多为 32 位驱动，此时请改装 ia32 版扫描端（资源目录 win-ia32）。";
}

std::string dsmDiagnosticSuffix() {
    if (g_dsmLoaded) {
        return "（TWAIN 数据源管理器已加载：" + g_dsmLoadedPath + "）";
    }
    return "（TWAIN 数据源管理器未加载：" + (g_dsmLoadLog.empty() ? "未找到可用 TWAINDSM.dll" : g_dsmLoadLog) + "）";
}
} // namespace ScannerBridge

extern "C" TW_UINT16 TW_CALLINGSTYLE DSM_Entry(
    pTW_IDENTITY pOrigin,
    pTW_IDENTITY pDest,
    TW_UINT32 DG,
    TW_UINT16 DAT,
    TW_UINT16 MSG,
    TW_MEMREF pData)
{
    static HMODULE dsmModule = nullptr;
    static DsmEntryProc dsmEntry = nullptr;

    if (!dsmEntry) {
        wchar_t envPath[MAX_PATH] = {};
        DWORD envLen = GetEnvironmentVariableW(L"TWAIN_DSM_DLL", envPath, MAX_PATH);
        const wchar_t* envCandidate = (envLen > 0 && envLen < MAX_PATH) ? envPath : nullptr;

        // exe 同目录的 TWAINDSM.dll（build-scanner-bridge.bat 会把仓库内
        // third_party 的 DSM 复制到产物目录）；不再硬编码 D:\ 绝对路径
        wchar_t exeDir[MAX_PATH] = {};
        GetModuleFileNameW(nullptr, exeDir, MAX_PATH);
        if (wchar_t* slash = wcsrchr(exeDir, L'\\')) *slash = L'\0';
        wchar_t dsmPathW[MAX_PATH] = {};
        wsprintfW(dsmPathW, L"%s\\TWAINDSM.dll", exeDir);
        // Windows paths stay UTF-16. LoadLibraryA interprets UTF-8 bytes as the
        // system ANSI code page and cannot load a bundled DLL from Chinese paths.
        const wchar_t* candidates[] = {
            envCandidate,
            dsmPathW,
            L"TWAINDSM.dll",
            L"twain_32.dll"
        };

        std::string tried;
        for (const wchar_t* candidate : candidates) {
            if (!candidate || !candidate[0]) continue;
            SetLastError(0);
            dsmModule = LoadLibraryW(candidate);
            if (!dsmModule) {
                DWORD err = GetLastError();
                char line[64] = {};
                sprintf_s(line, "err=%lu", static_cast<unsigned long>(err));
                if (!tried.empty()) tried += "; ";
                tried += wideToUtf8(candidate) + " -> LoadLibrary 失败(" + line + ")";
                continue;
            }

            dsmEntry = reinterpret_cast<DsmEntryProc>(GetProcAddress(dsmModule, "DSM_Entry"));
            if (dsmEntry) {
                g_dsmLoadedPath = wideToUtf8(candidate);
                g_dsmLoaded = true;
                break;
            }

            if (!tried.empty()) tried += "; ";
            tried += wideToUtf8(candidate) + " -> 已加载但缺少 DSM_Entry 导出";
            FreeLibrary(dsmModule);
            dsmModule = nullptr;
        }
        g_dsmLoadLog = tried;
    }

    if (!dsmEntry) {
        return TWRC_FAILURE;
    }

    return dsmEntry(pOrigin, pDest, DG, DAT, MSG, pData);
}

namespace ScannerBridge {

// ── Globals ───────────────────────────────────────────

TwainController* TwainController::s_instance = nullptr;

static const char* WINDOW_CLASS = "ScannerBridgeTwainClass";

// ── Window Procedure ──────────────────────────────────

// TWAIN DSM 通过注册窗口消息把 MSG_XFERREADY 等状态投递到本窗口，
// 因此 WndProc 必须把每一条消息都转发给 DAT_EVENT/MSG_PROCESSEVENT，
// 并传入真实 MSG 结构（pEvent），DSM 回填 TWMessage 后驱动状态机。
static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    // 仅当源已打开（m_state >= 2）才转发：pDest 传 &m_sourceId，
    // DSM 的 AppValidateIds 对 NULL pDest 直接返回失败，事件永远不会被处理
    if (TwainController::current() && TwainController::current()->canProcessEvents()) {
        MSG m = { hwnd, msg, wParam, lParam, 0, { 0, 0 } };
        TW_UINT16 rc = TwainController::current()->processTwainEvent(m);
        if (rc == TWRC_DSEVENT) {
            return 0;   // DSM 已消费该消息
        }
    }
    return DefWindowProcA(hwnd, msg, wParam, lParam);
}

static HWND createHiddenWindow(HINSTANCE hInstance) {
    WNDCLASSEXA wc = {};
    wc.cbSize = sizeof(WNDCLASSEXA);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.lpszClassName = WINDOW_CLASS;
    RegisterClassExA(&wc);
    
    return CreateWindowExA(
        0, WINDOW_CLASS, "ScannerBridge",
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT,
        100, 100,
        nullptr, nullptr, hInstance, nullptr
    );
}

// ── TwainController ───────────────────────────────────

TwainController::TwainController()
    : m_state(0), m_cancelRequested(false), m_hwnd(nullptr),
      m_lastOpenDsmRc(0), m_lastConditionCode(0), m_hasOpenDsmAttempt(false)
{
    s_instance = this;
    
    // Initialize GDI+
    Gdiplus::GdiplusStartupInput gdiInput;
    ULONG_PTR gdiToken;
    Gdiplus::GdiplusStartup(&gdiToken, &gdiInput, nullptr);
    
    // Initialize app identity
    memset(&m_appId, 0, sizeof(m_appId));
    m_appId.Id = 0;
    m_appId.Version.MajorNum = 1;
    m_appId.Version.MinorNum = 0;
    m_appId.Version.Language = TWLG_CHINESE_SIMPLIFIED;
    m_appId.Version.Country = TWCY_CHINA;
    strcpy_s(m_appId.Version.Info, sizeof(m_appId.Version.Info), "Project-X Scanner Bridge 1.0");
    m_appId.ProtocolMajor = TWON_PROTOCOLMAJOR;
    m_appId.ProtocolMinor = TWON_PROTOCOLMINOR;
    m_appId.SupportedGroups = DG_IMAGE | DG_CONTROL;
    strcpy_s(m_appId.Manufacturer, sizeof(m_appId.Manufacturer), "Project-X");
    strcpy_s(m_appId.ProductFamily, sizeof(m_appId.ProductFamily), "ScannerBridge");
    strcpy_s(m_appId.ProductName, sizeof(m_appId.ProductName), "ScannerBridge");
    
    // Create hidden window
    HINSTANCE hInstance = GetModuleHandle(nullptr);
    m_hwnd = createHiddenWindow(hInstance);
    ShowWindow(m_hwnd, SW_HIDE);
    if (!m_hwnd) {
        // OPENDSM 的 hParent 必须有效，否则 DSM 直接返回失败且原因不可见
        logError("CreateWindowExA failed: TWAIN OPENDSM 需要有效父窗口，检测将无法进行");
    }
}

TwainController::~TwainController() {
    cancel();
    if (m_state >= 3) disableSource();
    if (m_state >= 2) closeSource();
    if (m_state >= 1) closeDSM();
    if (m_hwnd) DestroyWindow(m_hwnd);
    s_instance = nullptr;
}

TwainController* TwainController::current() {
    return s_instance;
}

TW_UINT16 TwainController::processTwainEvent(MSG& msg) {
    TW_EVENT event;
    memset(&event, 0, sizeof(event));
    event.pEvent = &msg;   // 必须传入真实 MSG 结构，TWMessage 由 DSM 回填

    // pDest 必须传源 ID：DSM 对 DAT_EVENT/MSG_PROCESSEVENT 第一步做
    // AppValidateIds(pAppId, pDSId)，pDest 为 NULL 时直接返回 TWRC_FAILURE，
    // 事件永远不会到达源、TWMessage 也不会回填（调用方保证 m_state >= 2）
    TW_UINT16 rc = DSM_Entry(
        &m_appId,
        &m_sourceId,
        DG_CONTROL,
        DAT_EVENT,
        MSG_PROCESSEVENT,
        reinterpret_cast<TW_MEMREF>(&event)
    );

    if (rc == TWRC_DSEVENT) {
        if (event.TWMessage == MSG_XFERREADY) {
            m_state = 6;
        } else if (event.TWMessage == MSG_CLOSEDSREQ || event.TWMessage == MSG_CLOSEDSOK) {
            m_state = 0;
        }
    }

    return rc;
}

// ── Source Enumeration ────────────────────────────────

SourceEnumeration TwainController::listSourceDetails() {
    SourceEnumeration result;
    result.windowCreated = (m_hwnd != nullptr);
    result.dsmPath = g_dsmLoadedPath;

    if (!result.windowCreated) {
        result.code = "WINDOW_CREATE_FAILED";
        result.message = "扫描桥接程序无法创建 TWAIN 所需的宿主窗口（常见于会话被限制的远程/服务环境）";
        result.hint = "请在教师的桌面会话中直接运行扫描端，不要通过远程会话或计划任务启动。";
        return result;
    }

    // DSM 由 DSM_Entry 惰性加载：只有真正调用过 DSM_Entry 才能区分「DLL 加载失败」与
    // 「DSM 打开失败」。此前在调用前就按 g_dsmLoaded 判定，DLL/设备完全正常时检测也会
    // 一律报 DSM_LOAD_FAILED（评审 P1）。先 openDSM()（内部即触发加载）再按状态归类。
    if (!openDSM()) {
        if (!g_dsmLoaded) {
            result.code = "DSM_LOAD_FAILED";
            result.message = "无法加载 TWAIN 数据源管理器（TWAINDSM.dll）";
            result.dsmSearchLog = g_dsmLoadLog;
            result.hint = "通常是 TWAINDSM.dll 缺失或被安全软件隔离。"
                          "请确认安装目录下 resources/native/win-" + std::string(bridgeArchName()) +
                          "/TWAINDSM.dll 存在；仍失败时重装扫描端安装包。";
            return result;
        }
        result.code = "OPENDSM_FAILED";
        result.openDsmRc = m_hasOpenDsmAttempt ? static_cast<int>(m_lastOpenDsmRc) : -1;
        result.conditionCode = m_hasOpenDsmAttempt ? static_cast<int>(m_lastConditionCode) : -1;
        result.message = "TWAIN 数据源管理器打开失败"
                         "（DSM_Entry 返回 " + twainResultToString(m_lastOpenDsmRc) +
                         "，条件码 " + std::to_string(m_lastConditionCode) + "）";
        result.hint = archHint() + " 若提示扫描仪离线，请确认设备已开机并已连接。";
        return result;
    }
    result.dsmPath = g_dsmLoadedPath;

    // DSM 已打开：直接枚举，避免二次 OPEN/CLOSE 引发 SEQERROR（与 scan() 保持一致）
    {
        TW_IDENTITY sourceId;
        memset(&sourceId, 0, sizeof(sourceId));
        TW_UINT16 rc = DSM_Entry(
            &m_appId, nullptr,
            DG_CONTROL, DAT_IDENTITY, MSG_GETFIRST,
            (TW_MEMREF)&sourceId
        );
        while (rc == TWRC_SUCCESS) {
            SourceInfo info;
            info.name = sourceId.ProductName;
            info.identity = sourceId;
            result.sources.push_back(info);

            memset(&sourceId, 0, sizeof(sourceId));
            rc = DSM_Entry(
                &m_appId, nullptr,
                DG_CONTROL, DAT_IDENTITY, MSG_GETNEXT,
                (TW_MEMREF)&sourceId
            );
        }
    }

    closeDSM();

    if (result.sources.empty()) {
        result.code = "NO_SOURCES";
        result.message = "TWAIN 数据源管理器正常，但未枚举到任何扫描仪驱动";
        result.hint = archHint() + " 也可能是扫描仪驱动未安装或设备未连接。";
        return result;
    }

    result.code = "OK";
    result.message = "";
    return result;
}

std::vector<SourceInfo> TwainController::listSources() {
    return listSourceDetails().sources;
}

// ── Scan Execution ────────────────────────────────────

ScanResult TwainController::scan(const ScanConfig& config) {
    ScanResult result;
    result.success = false;
    m_config = config;
    m_cancelRequested = false;
    
    // 1. Open DSM（幂等：已打开则直接复用，避免二次 OPENDSM 导致 SEQERROR）
    if (!openDSM()) {
        result.errorMessage = "无法打开 TWAIN 数据源管理器（DSM_Entry 返回 " +
            twainResultToString(m_lastOpenDsmRc) + "，条件码 " +
            std::to_string(m_lastConditionCode) + "）" + dsmDiagnosticSuffix();
        return result;
    }
    
    // 2. Find and open source — DSM 已打开，直接枚举，不再经过 listSources() 的 open/close
    // 避免 scan() 中 openDSM -> listSources().openDSM 二次 OPENDSM 失败，
    // 随后 re-open 也因状态不一致而触发视频中的 "Failed to re-open TWAIN DSM"
    std::vector<SourceInfo> sources;
    {
        TW_IDENTITY sourceId;
        memset(&sourceId, 0, sizeof(sourceId));
        TW_UINT16 rc = DSM_Entry(
            &m_appId, nullptr,
            DG_CONTROL, DAT_IDENTITY, MSG_GETFIRST,
            (TW_MEMREF)&sourceId
        );
        while (rc == TWRC_SUCCESS) {
            SourceInfo info;
            info.name = sourceId.ProductName;
            info.identity = sourceId;
            sources.push_back(info);
            memset(&sourceId, 0, sizeof(sourceId));
            rc = DSM_Entry(
                &m_appId, nullptr,
                DG_CONTROL, DAT_IDENTITY, MSG_GETNEXT,
                (TW_MEMREF)&sourceId
            );
        }
    }
    
    TW_IDENTITY* targetSource = nullptr;
    for (auto& src : sources) {
        std::string srcLower = src.name;
        std::string targetLower = config.sourceName;
        std::transform(srcLower.begin(), srcLower.end(), srcLower.begin(), ::tolower);
        std::transform(targetLower.begin(), targetLower.end(), targetLower.begin(), ::tolower);
        
        if (srcLower.find(targetLower) != std::string::npos) {
            targetSource = &src.identity;
            break;
        }
    }
    
    if (!targetSource) {
        // Use default source if specific not found
        TW_IDENTITY defaultSource;
        memset(&defaultSource, 0, sizeof(defaultSource));
        TW_UINT16 rc = DSM_Entry(
            &m_appId, nullptr,
            DG_CONTROL, DAT_IDENTITY, MSG_GETDEFAULT,
            (TW_MEMREF)&defaultSource
        );
        if (rc != TWRC_SUCCESS) {
            result.errorMessage = "未找到可用扫描仪：请求「" + config.sourceName +
                "」，DSM 本次枚举到 " + std::to_string(sources.size()) + " 台设备" +
                (sources.empty() ? "（" + archHint() + "）" : "");
            closeDSM();
            return result;
        }
        memcpy(&m_sourceId, &defaultSource, sizeof(m_sourceId));
    } else {
        memcpy(&m_sourceId, targetSource, sizeof(m_sourceId));
    }
    
    // 3. Open source
    if (!openSource(m_sourceId)) {
        result.errorMessage = "无法打开扫描仪：" + std::string(m_sourceId.ProductName) +
            "（可能被其他程序占用，请关闭其它扫描软件后重试）";
        closeDSM();
        return result;
    }
    
    // 4. Configure capabilities
    if (!setPixelType()) {
        // Continue anyway - some scanners don't support all caps
    }
    if (!setResolution(config.dpi)) {
        // Continue
    }
    if (config.duplex) {
        setDuplex(true);
    }
    if (!setPaperSize(config.paperSize)) {
        result.errorMessage = config.paperSize == "A3"
            ? "该扫描仪不支持 A3 原稿（请在扫描设置中改选 A4）"
            : "该扫描仪不接受所请求的纸张尺寸：" + config.paperSize;
        disableSource();
        closeSource();
        closeDSM();
        return result;
    }
    enableADF();
    
    // 5. Enable source (shows scanner UI or goes to ready state)
    if (!enableSource(m_config.showUi)) {
        result.errorMessage = "扫描仪拒绝启动（MSG_ENABLEDS 失败）。"
                              "常见原因：设备离线、被其它程序占用，或驱动与当前扫描端位宽不匹配";
        closeSource();
        closeDSM();
        return result;
    }
    
    // 6. Capture loop - handle ADF multi-page
    // 状态机约定：waitForState(6) 等 MSG_XFERREADY（processTwainEvent 置 m_state=6）；
    // captureNativeTransfer 收到 XFERDONE 后把 m_state 复位为 5，使下一轮 waitForState(6)
    // 真正等待新一页的 XFERREADY；XFERDONE 后必须立即 ENDXFER 才能推进 TWAIN 状态机。
    int pageNum = 0;
    bool hasMorePages = true;
    
    while (hasMorePages && !m_cancelRequested) {
        if (config.maxPages > 0 && pageNum >= config.maxPages) break;
        
        // Check if transfer is ready
        if (!waitForState(6, config.pageTimeoutMs)) {
            // ADF 无纸或空闲超时：立即结束，不再干等固定 60s
            fprintf(stderr, "[ScannerBridge] Scan ended: no more pages after %dms idle (pages=%d)\n",
                config.pageTimeoutMs, pageNum);
            hasMorePages = false;
            break;
        }
        
        pageNum++;
        
        // Front side
        {
            PageResult pageResult;
            pageResult.pageNumber = pageNum;
            pageResult.side = "front";
            
            char filename[512];
            snprintf(filename, sizeof(filename), "%s_%04d_front.jpg",
                config.filePrefix.c_str(), pageNum);
            std::string filePath = config.outputDir + "\\" + filename;
            
            if (m_progressCallback) {
                m_progressCallback(pageNum, "front", "capturing");
            }
            
            if (!captureNativeTransfer(filePath, pageNum, "front", pageResult)) {
                result.errorMessage = "Failed to capture page " + std::to_string(pageNum) + " (front)";
                break;
            }
            result.pages.push_back(pageResult);
        }
        
        // XFERDONE 后立即 ENDXFER，查询剩余张数
        TW_PENDINGXFERS pending;
        memset(&pending, 0, sizeof(pending));
        TW_UINT16 endRc = DSM_Entry(&m_appId, &m_sourceId,
            DG_CONTROL, DAT_PENDINGXFERS, MSG_ENDXFER,
            (TW_MEMREF)&pending);
        if (endRc != TWRC_SUCCESS) {
            logError("ENDXFER failed: " + twainResultToString(endRc));
            result.errorMessage = "ENDXFER failed: " + twainResultToString(endRc);
            hasMorePages = false;
            break;
        }
        
        // Back side (duplex) — 由 pending.Count 决定是否还有背面，避免干等 30 秒
        if (config.duplex && pending.Count > 0) {
            if (!waitForState(6, config.pageTimeoutMs)) {
                result.errorMessage = "Timeout waiting for back side of page " + std::to_string(pageNum);
                break;
            }
            
            PageResult pageResult;
            pageResult.pageNumber = pageNum;
            pageResult.side = "back";
            
            char filename[512];
            snprintf(filename, sizeof(filename), "%s_%04d_back.jpg",
                config.filePrefix.c_str(), pageNum);
            std::string filePath = config.outputDir + "\\" + filename;
            
            if (m_progressCallback) {
                m_progressCallback(pageNum, "back", "capturing");
            }
            
            if (!captureNativeTransfer(filePath, pageNum, "back", pageResult)) {
                result.errorMessage = "Failed to capture page " + std::to_string(pageNum) + " (back)";
                break;
            }
            result.pages.push_back(pageResult);
            
            // 背面传输完成后再次 ENDXFER，推进到下一页
            memset(&pending, 0, sizeof(pending));
            endRc = DSM_Entry(&m_appId, &m_sourceId,
                DG_CONTROL, DAT_PENDINGXFERS, MSG_ENDXFER,
                (TW_MEMREF)&pending);
            if (endRc != TWRC_SUCCESS) {
                logError("ENDXFER (back) failed: " + twainResultToString(endRc));
                result.errorMessage = "ENDXFER (back) failed: " + twainResultToString(endRc);
                hasMorePages = false;
                break;
            }
        }
        
        hasMorePages = pending.Count > 0;
    }
    
    // 7. Cleanup
    disableSource();
    closeSource();
    closeDSM();
    
    // 成功 = 无中途失败且至少捕获到一页（部分失败的批次不再被当作成功）
    result.success = result.errorMessage.empty() && result.pages.size() > 0;
    if (!result.success && result.errorMessage.empty()) {
        result.errorMessage = "No pages captured";
    }
    
    return result;
}

// ── Progress Callback ─────────────────────────────────

void TwainController::setProgressCallback(ProgressCallback cb) {
    m_progressCallback = cb;
}

void TwainController::cancel() {
    m_cancelRequested = true;
}

// ── TWAIN State Machine Internals ─────────────────────

bool TwainController::openDSM() {
    if (m_state >= 1) return true;
    m_hasOpenDsmAttempt = true;
    TW_UINT16 rc = DSM_Entry(
        &m_appId, nullptr,
        DG_CONTROL, DAT_PARENT, MSG_OPENDSM,
        (TW_MEMREF)&m_hwnd
    );
    m_lastOpenDsmRc = rc;
    if (rc == TWRC_SUCCESS) {
        m_state = 1;
        return true;
    }
    logError("DSM_Entry MSG_OPENDSM failed: " + twainResultToString(rc));
    // 查询 Condition Code，便于诊断 SEQERROR 等时序错误（对应视频中 Failed to re-open TWAIN DSM）
    TW_STATUS status;
    memset(&status, 0, sizeof(status));
    DSM_Entry(&m_appId, nullptr, DG_CONTROL, DAT_STATUS, MSG_GET, (TW_MEMREF)&status);
    m_lastConditionCode = status.ConditionCode;
    logError("DSM OPENDSM ConditionCode=" + std::to_string(status.ConditionCode));
    return false;
}

bool TwainController::closeDSM() {
    if (m_state < 1) return true;
    TW_UINT16 rc = DSM_Entry(
        &m_appId, nullptr,
        DG_CONTROL, DAT_PARENT, MSG_CLOSEDSM,
        (TW_MEMREF)&m_hwnd
    );
    m_state = 0;
    return rc == TWRC_SUCCESS;
}

bool TwainController::openSource(const TW_IDENTITY& sourceId) {
    TW_UINT16 rc = DSM_Entry(
        &m_appId, nullptr,
        DG_CONTROL, DAT_IDENTITY, MSG_OPENDS,
        (TW_MEMREF)&const_cast<TW_IDENTITY&>(sourceId)
    );
    if (rc == TWRC_SUCCESS) {
        m_state = 2;
        memcpy(&m_sourceId, &sourceId, sizeof(m_sourceId));
        return true;
    }
    logError("DSM_Entry MSG_OPENDS failed: " + twainResultToString(rc));
    return false;
}

bool TwainController::closeSource() {
    if (m_state < 2) return true;
    TW_UINT16 rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_CONTROL, DAT_IDENTITY, MSG_CLOSEDS,
        (TW_MEMREF)&m_sourceId
    );
    m_state = 1;
    return rc == TWRC_SUCCESS;
}

bool TwainController::enableSource(bool showUi) {
    TW_USERINTERFACE ui;
    memset(&ui, 0, sizeof(ui));
    ui.ShowUI = showUi ? TRUE : FALSE;
    ui.ModalUI = showUi ? TRUE : FALSE;
    ui.hParent = m_hwnd;
    
    TW_UINT16 rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_CONTROL, DAT_USERINTERFACE, MSG_ENABLEDS,
        (TW_MEMREF)&ui
    );
    
    if (rc == TWRC_SUCCESS || rc == TWRC_CHECKSTATUS) {
        if (rc == TWRC_CHECKSTATUS) {
            // Consume pending condition code per TWAIN spec
            TW_STATUS status;
            memset(&status, 0, sizeof(status));
            DSM_Entry(&m_appId, &m_sourceId,
                DG_CONTROL, DAT_STATUS, MSG_GET,
                (TW_MEMREF)&status);
        }
        m_state = 3;
        return true;
    }
    
    // Fallback: if no-UI didn't work, try with UI (unless UI was explicitly requested)
    if (!showUi) {
        ui.ShowUI = TRUE;
        ui.ModalUI = TRUE;
        rc = DSM_Entry(
            &m_appId, &m_sourceId,
            DG_CONTROL, DAT_USERINTERFACE, MSG_ENABLEDS,
            (TW_MEMREF)&ui
        );
        
        if (rc == TWRC_SUCCESS || rc == TWRC_CHECKSTATUS) {
            if (rc == TWRC_CHECKSTATUS) {
                TW_STATUS status;
                memset(&status, 0, sizeof(status));
                DSM_Entry(&m_appId, &m_sourceId,
                    DG_CONTROL, DAT_STATUS, MSG_GET,
                    (TW_MEMREF)&status);
            }
            m_state = 3;
            return true;
        }
    }
    
    logError("DSM_Entry MSG_ENABLEDS failed: " + twainResultToString(rc));
    return false;
}

bool TwainController::disableSource() {
    if (m_state < 3) return true;
    TW_USERINTERFACE ui;
    memset(&ui, 0, sizeof(ui));
    ui.ShowUI = FALSE;
    ui.ModalUI = FALSE;
    ui.hParent = m_hwnd;
    
    TW_UINT16 rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_CONTROL, DAT_USERINTERFACE, MSG_DISABLEDS,
        (TW_MEMREF)&ui
    );
    m_state = 2;
    return rc == TWRC_SUCCESS;
}

// ── Capability Setting ────────────────────────────────

bool TwainController::setCapability(TW_UINT16 cap, TW_UINT16 type, void* value) {
    TW_CAPABILITY twCap;
    memset(&twCap, 0, sizeof(twCap));
    twCap.Cap = cap;
    twCap.ConType = TWON_ONEVALUE;
    twCap.hContainer = GlobalAlloc(GHND, sizeof(TW_ONEVALUE) + sizeof(TW_UINT32));
    
    if (!twCap.hContainer) return false;
    
    pTW_ONEVALUE pVal = (pTW_ONEVALUE)GlobalLock(twCap.hContainer);
    pVal->ItemType = type;
    
    switch (type) {
        case TWTY_UINT16:
            *(TW_UINT16*)&pVal->Item = *(TW_UINT16*)value;
            break;
        case TWTY_INT32:
            *(TW_INT32*)&pVal->Item = *(TW_INT32*)value;
            break;
        case TWTY_BOOL:
            *(TW_BOOL*)&pVal->Item = *(TW_BOOL*)value;
            break;
        case TWTY_FIX32: {
            TW_FIX32* src = (TW_FIX32*)value;
            TW_FIX32* dst = (TW_FIX32*)&pVal->Item;
            dst->Whole = src->Whole;
            dst->Frac = src->Frac;
            break;
        }
        default:
            GlobalUnlock(twCap.hContainer);
            GlobalFree(twCap.hContainer);
            return false;
    }
    
    GlobalUnlock(twCap.hContainer);
    
    TW_UINT16 rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_CONTROL, DAT_CAPABILITY, MSG_SET,
        (TW_MEMREF)&twCap
    );
    
    GlobalFree(twCap.hContainer);

    // TWRC_CHECKSTATUS 表示「能力被接受，但驱动改用了它自己的取值」（条件码
    // TWCC_CAPGREATER/CAPLOWER/CAPBADVALUE 之一），按 TWAIN 规范属于成功。
    // 旧实现只认 TWRC_SUCCESS，把驱动正常的协商结果当失败 → setPaperSize 返回 false
    // → 整个扫描会话被中止，报「Scanner rejected requested paper size」，这是
    // 「换一台扫描仪就扫不动」的高频根因。
    if (rc == TWRC_CHECKSTATUS) {
        TW_STATUS status;
        memset(&status, 0, sizeof(status));
        DSM_Entry(&m_appId, &m_sourceId,
            DG_CONTROL, DAT_STATUS, MSG_GET,
            (TW_MEMREF)&status);
        return true;
    }

    if (rc != TWRC_SUCCESS) {
        // Try MSG_RESET to check if cap is settable
        TW_CAPABILITY checkCap;
        memset(&checkCap, 0, sizeof(checkCap));
        checkCap.Cap = cap;
        TW_UINT16 rc2 = DSM_Entry(
            &m_appId, &m_sourceId,
            DG_CONTROL, DAT_CAPABILITY, MSG_GETCURRENT,
            (TW_MEMREF)&checkCap
        );
        // Ignore - scanner may not support this cap
    }
    
    return rc == TWRC_SUCCESS;
}

bool TwainController::setPixelType() {
    TW_UINT16 pixelType;
    if (m_config.colorMode == "bw") {
        pixelType = TWPT_BW;
    } else if (m_config.colorMode == "color") {
        pixelType = TWPT_RGB;
    } else {
        pixelType = TWPT_GRAY;
    }
    return setCapability(ICAP_PIXELTYPE, TWTY_UINT16, &pixelType);
}

bool TwainController::setResolution(int dpi) {
    TW_FIX32 res;
    res.Whole = (TW_INT16)dpi;
    res.Frac = 0;
    return setCapability(ICAP_XRESOLUTION, TWTY_FIX32, &res) &&
           setCapability(ICAP_YRESOLUTION, TWTY_FIX32, &res);
}

bool TwainController::setDuplex(bool duplex) {
    TW_BOOL val = duplex ? TRUE : FALSE;
    return setCapability(CAP_DUPLEXENABLED, TWTY_BOOL, &val);
}

bool TwainController::setPaperSize(const std::string& size) {
    TW_UINT16 paperSize;
    if (size == "A4") {
        paperSize = TWSS_A4;
    } else if (size == "Letter") {
        paperSize = TWSS_USLETTER;
    } else if (size == "A3") {
        paperSize = TWSS_A3;
    } else {
        paperSize = TWSS_A4;
    }
    if (!setCapability(ICAP_SUPPORTEDSIZES, TWTY_UINT16, &paperSize)) return false;

    // TWRC_CHECKSTATUS 是驱动正常的协商结果，但驱动可能改用自己的取值（请求 A3 却
    // 替代为 A4）。版面与识别按请求尺寸进行，静默继续会得到裁切/错位的识别结果
    // （评审 P2），故核对 MSG_GETCURRENT 确认实际生效值；读取失败时按旧行为放行。
    TW_CAPABILITY current;
    memset(&current, 0, sizeof(current));
    current.Cap = ICAP_SUPPORTEDSIZES;
    TW_UINT16 rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_CONTROL, DAT_CAPABILITY, MSG_GETCURRENT,
        (TW_MEMREF)&current
    );
    if (rc == TWRC_SUCCESS && current.hContainer) {
        TW_UINT16 effective = paperSize;
        bool readable = false;
        pTW_ONEVALUE value = static_cast<pTW_ONEVALUE>(GlobalLock(current.hContainer));
        if (value && value->ItemType == TWTY_UINT16) {
            effective = static_cast<TW_UINT16>(value->Item);
            readable = true;
        }
        if (value) GlobalUnlock(current.hContainer);
        GlobalFree(current.hContainer);
        if (readable && effective != paperSize) {
            fprintf(stderr, "[ScannerBridge] Driver substituted paper size (requested %u, effective %u); aborting to avoid misaligned recognition\n",
                    static_cast<unsigned>(paperSize), static_cast<unsigned>(effective));
            return false;
        }
    }
    return true;
}

bool TwainController::enableADF() {
    TW_BOOL adf = TRUE;
    setCapability(CAP_FEEDERENABLED, TWTY_BOOL, &adf);
    
    TW_BOOL autoFeed = TRUE;
    setCapability(CAP_AUTOFEED, TWTY_BOOL, &autoFeed);
    
    return true;  // Best effort
}

// ── Image Capture ─────────────────────────────────────

bool TwainController::captureNativeTransfer(
    const std::string& outputPath, int pageNum,
    const std::string& side, PageResult& result)
{
    TW_IMAGEINFO imageInfo;
    memset(&imageInfo, 0, sizeof(imageInfo));
    
    TW_UINT16 rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_IMAGE, DAT_IMAGEINFO, MSG_GET,
        (TW_MEMREF)&imageInfo
    );
    
    if (rc != TWRC_SUCCESS) {
        logError("Failed to get image info: " + twainResultToString(rc));
        return false;
    }
    
    // Use native transfer — DAT_IMAGENATIVEXFER 返回的句柄是指针宽（x64 下 8 字节），
    // 必须用 TW_HANDLE（=HANDLE）接收，否则会截断句柄并污染栈
    TW_HANDLE handle = nullptr;
    rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_IMAGE, DAT_IMAGENATIVEXFER, MSG_GET,
        (TW_MEMREF)&handle
    );
    
    if (rc != TWRC_XFERDONE) {
        logError("Native transfer failed: " + twainResultToString(rc));
        return false;
    }
    
    // 复位状态机：XFERDONE 表示当前帧已取走，下一帧的 MSG_XFERREADY
    // 会在 ENDXFER 后重新到达，waitForState(6) 必须重新等待
    m_state = 5;
    
    // Convert DIB handle to file
    bool saved = saveDIBToFile((HANDLE)(uintptr_t)handle, outputPath, result);
    
    // Free the DIB
    if (handle) {
        GlobalFree((HGLOBAL)(uintptr_t)handle);
    }
    
    return saved;
}

// ── DIB to JPEG via GDI+ ──────────────────────────────

bool TwainController::saveDIBToFile(HANDLE hDib, const std::string& filePath, PageResult& result) {
    if (!hDib) return false;
    
    BITMAPINFOHEADER* pDib = (BITMAPINFOHEADER*)GlobalLock(hDib);
    if (!pDib) return false;
    
    int width = pDib->biWidth;
    int height = abs(pDib->biHeight);
    int bitCount = pDib->biBitCount;
    
    result.width = width;
    result.height = height;
    
    // Calculate pixel data offset
    BYTE* pixels = (BYTE*)pDib + pDib->biSize;
    
    // Handle color table for paletted images
    int colorTableEntries = 0;
    if (bitCount <= 8) {
        // 以 biClrUsed 为准（为 0 时按 bitCount 推算），8bpp 表不足 256 项时像素偏移才不会错
        colorTableEntries = pDib->biClrUsed;
        if (colorTableEntries == 0) {
            colorTableEntries = (bitCount == 4) ? 16 : (bitCount == 8) ? 256 : 2;
        }
        pixels += colorTableEntries * sizeof(RGBQUAD);
    }
    
    // For 24-bit or compressed images, find pixel data via biSizeImage
    if (bitCount > 8 && pDib->biCompression == BI_RGB) {
        // pixels already correct for top-down
    }
    
    // Create a GDI+ bitmap from the DIB data
    Gdiplus::PixelFormat format;
    if (bitCount == 32) {
        format = PixelFormat32bppRGB;
    } else if (bitCount == 24) {
        format = PixelFormat24bppRGB;
    } else if (bitCount == 8) {
        format = PixelFormat8bppIndexed;
    } else if (bitCount == 4) {
        format = PixelFormat4bppIndexed;
    } else if (bitCount == 1) {
        format = PixelFormat1bppIndexed;
    } else {
        format = PixelFormat24bppRGB;
    }
    
    Gdiplus::Bitmap* bitmap = nullptr;
    
    if (pDib->biHeight > 0) {
        // Bottom-up DIB
        int stride = ((width * bitCount + 31) / 32) * 4;
        bitmap = new Gdiplus::Bitmap(width, height, stride, format, pixels);
        bitmap->RotateFlip(Gdiplus::RotateNoneFlipY);
    } else {
        // Top-down DIB
        int stride = ((width * bitCount + 31) / 32) * 4;
        bitmap = new Gdiplus::Bitmap(width, height, stride, format, pixels);
    }
    
    // 8bpp/1bpp 索引位图：GDI+ 从外部缓冲构造时没有调色板，必须用 DIB 自带颜色表
    // SetPalette，否则 Save 会套用 GDI+ 默认（halftone）调色板 → 灰度/黑白图假彩色或保存失败
    if (bitCount <= 8 && colorTableEntries > 0) {
        const RGBQUAD* colorTable = reinterpret_cast<const RGBQUAD*>(
            reinterpret_cast<const BYTE*>(pDib) + pDib->biSize);
        const UINT paletteBytes = sizeof(Gdiplus::ColorPalette) +
            (colorTableEntries - 1) * sizeof(DWORD);   // ARGB == DWORD
        std::vector<BYTE> paletteBuf(paletteBytes);
        auto* palette = reinterpret_cast<Gdiplus::ColorPalette*>(paletteBuf.data());
        palette->Flags = Gdiplus::PaletteFlagsHasAlpha;
        palette->Count = colorTableEntries;
        for (int i = 0; i < colorTableEntries; ++i) {
            palette->Entries[i] = static_cast<DWORD>(0xFF000000) |
                (static_cast<DWORD>(colorTable[i].rgbRed) << 16) |
                (static_cast<DWORD>(colorTable[i].rgbGreen) << 8) |
                static_cast<DWORD>(colorTable[i].rgbBlue);
        }
        bitmap->SetPalette(palette);
    }

    GlobalUnlock(hDib);
    
    if (!bitmap) return false;
    
    // Save as JPEG
    CLSID jpegClsid;
    CLSIDFromString(L"{557cf401-1a04-11d3-9a73-0000f81ef32e}", &jpegClsid);
    
    Gdiplus::EncoderParameters encoderParams;
    encoderParams.Count = 1;
    encoderParams.Parameter[0].Guid = Gdiplus::EncoderQuality;
    encoderParams.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
    encoderParams.Parameter[0].NumberOfValues = 1;
    LONG quality = 90;
    encoderParams.Parameter[0].Value = &quality;
    
    // Convert path to wide string
    int wlen = MultiByteToWideChar(CP_UTF8, 0, filePath.c_str(), -1, nullptr, 0);
    std::wstring wpath(wlen, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, filePath.c_str(), -1, &wpath[0], wlen);
    
    Gdiplus::Status status = bitmap->Save(wpath.c_str(), &jpegClsid, &encoderParams);
    
    delete bitmap;
    
    result.filePath = filePath;
    return status == Gdiplus::Ok;
}

bool TwainController::captureFileTransfer(
    const std::string& outputDir, int pageNum,
    const std::string& side, PageResult& result)
{
    // File transfer mode - scanner saves file itself
    TW_SETUPFILEXFER setup;
    memset(&setup, 0, sizeof(setup));
    strcpy_s(setup.FileName, sizeof(setup.FileName), "scantmp");
    setup.Format = TWFF_TIFF;
    
    TW_UINT16 rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_CONTROL, DAT_SETUPFILEXFER, MSG_SET,
        (TW_MEMREF)&setup
    );
    
    if (rc != TWRC_SUCCESS) {
        return captureNativeTransfer(outputDir + "\\fallback.jpg", pageNum, side, result);
    }
    
    // ... file transfer handling omitted (most scanners use native transfer)
    return false;
}

// ── Wait for State ────────────────────────────────────

bool TwainController::waitForState(int targetState, DWORD timeoutMs) {
    MSG msg;
    DWORD start = GetTickCount();
    
    while (GetTickCount() - start < timeoutMs) {
        // Check cancel
        if (m_cancelRequested) return false;
        
        // Peek messages for TWAIN
        while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessage(&msg);
            
            // Check if TWAIN event processing advanced our state
            if (m_state >= targetState) return true;
        }
        
        Sleep(50);
    }
    
    return false;
}

// ── TWAIN Callback ────────────────────────────────────

// ── Utilities ─────────────────────────────────────────

std::string TwainController::twainResultToString(TW_UINT16 rc) {
    switch (rc) {
        case TWRC_SUCCESS: return "SUCCESS";
        case TWRC_FAILURE: return "FAILURE";
        case TWRC_CHECKSTATUS: return "CHECKSTATUS";
        case TWRC_CANCEL: return "CANCEL";
        case TWRC_DSEVENT: return "DSEVENT";
        case TWRC_NOTDSEVENT: return "NOTDSEVENT";
        case TWRC_XFERDONE: return "XFERDONE";
        case TWRC_ENDOFLIST: return "ENDOFLIST";
        case TWRC_INFONOTSUPPORTED: return "INFONOTSUPPORTED";
        case TWRC_DATANOTAVAILABLE: return "DATANOTAVAILABLE";
        default: return "UNKNOWN(" + std::to_string(rc) + ")";
    }
}

void TwainController::logError(const std::string& msg) {
    // Output to stderr for diagnostics
    fprintf(stderr, "[ScannerBridge] %s\n", msg.c_str());
    fflush(stderr);
}

// ── JSON Helpers ──────────────────────────────────────

std::string escapeJson(const std::string& s) {
    std::string result;
    result.reserve(s.size() + 10);
    for (char c : s) {
        switch (c) {
            case '"': result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default: result += c;
        }
    }
    return result;
}

std::string sourcesToJson(const std::vector<SourceInfo>& sources) {
    SourceEnumeration snapshot;
    snapshot.sources = sources;
    snapshot.code = sources.empty() ? "NO_SOURCES" : "OK";
    snapshot.message = sources.empty() ? "未枚举到任何 TWAIN 扫描仪" : "";
    snapshot.windowCreated = true;
    snapshot.dsmPath = dsmLoadedPath();
    return sourceEnumerationToJson(snapshot, bridgeArchName());
}

std::string sourceEnumerationToJson(const SourceEnumeration& snapshot, const char* arch) {
    const bool ok = (snapshot.code == "OK");
    std::string json = "{\n";
    json += "  \"status\": \"" + std::string(ok ? "ok" : "error") + "\",\n";
    json += "  \"code\": \"" + escapeJson(snapshot.code) + "\",\n";
    if (!snapshot.message.empty()) {
        json += "  \"message\": \"" + escapeJson(snapshot.message) + "\",\n";
    }
    if (!snapshot.hint.empty()) {
        json += "  \"hint\": \"" + escapeJson(snapshot.hint) + "\",\n";
    }
    json += "  \"arch\": \"" + escapeJson(arch ? arch : "unknown") + "\",\n";
    json += "  \"dsm_loaded\": " + std::string(g_dsmLoaded ? "true" : "false") + ",\n";
    if (!snapshot.dsmPath.empty()) {
        json += "  \"dsm_path\": \"" + escapeJson(snapshot.dsmPath) + "\",\n";
    }
    if (!snapshot.dsmSearchLog.empty()) {
        json += "  \"dsm_search\": \"" + escapeJson(snapshot.dsmSearchLog) + "\",\n";
    }
    json += "  \"open_dsm_rc\": " + std::to_string(snapshot.openDsmRc) + ",\n";
    json += "  \"condition_code\": " + std::to_string(snapshot.conditionCode) + ",\n";
    json += "  \"window_created\": " + std::string(snapshot.windowCreated ? "true" : "false") + ",\n";
    json += "  \"sources\": [\n";
    for (size_t i = 0; i < snapshot.sources.size(); ++i) {
        json += "    { \"name\": \"" + escapeJson(snapshot.sources[i].name) + "\" }";
        if (i < snapshot.sources.size() - 1) json += ",";
        json += "\n";
    }
    json += "  ]\n}";
    return json;
}

std::string scanResultToJson(const ScanResult& result) {
    std::string json = "{\n";
    json += "  \"status\": \"" + std::string(result.success ? "ok" : "error") + "\",\n";
    
    if (!result.errorMessage.empty()) {
        json += "  \"message\": \"" + escapeJson(result.errorMessage) + "\",\n";
    }
    
    json += "  \"page_count\": " + std::to_string(result.pages.size()) + ",\n";
    json += "  \"pages\": [\n";
    
    for (size_t i = 0; i < result.pages.size(); ++i) {
        const auto& page = result.pages[i];
        json += "    {\n";
        json += "      \"path\": \"" + escapeJson(page.filePath) + "\",\n";
        json += "      \"page\": " + std::to_string(page.pageNumber) + ",\n";
        json += "      \"side\": \"" + page.side + "\",\n";
        json += "      \"width\": " + std::to_string(page.width) + ",\n";
        json += "      \"height\": " + std::to_string(page.height) + "\n";
        json += "    }";
        if (i < result.pages.size() - 1) json += ",";
        json += "\n";
    }
    
    json += "  ]\n}";
    return json;
}

} // namespace ScannerBridge
