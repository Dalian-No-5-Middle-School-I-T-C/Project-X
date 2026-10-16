#include <windows.h>
#include <twain.h>

#include <gdiplus.h>
#pragma comment(lib, "gdiplus.lib")

#include "twain_controller.hpp"
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <cmath>
#include <cwctype>
#include <iterator>
#include <string>
#include <vector>

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

// ── 安全 R40：DSM 只从「规范化后的受信绝对路径」加载 ──────────────────────
// 旧实现最后两个候选是裸名 TWAINDSM.dll / twain_32.dll，交给 LoadLibraryW 按默认
// 搜索顺序解析（当前工作目录、PATH 都在里面）。扫描端的工作目录取决于启动方式，
// 于是「往 CWD 或任何可写搜索目录丢一个同名 DLL」就能让扫描端加载并执行任意代码。
// 现在候选一律先解析成绝对路径、确认是非空常规文件，再用 LoadLibraryExW 限制依赖搜索。
namespace {

std::wstring lowerW(std::wstring text) {
    for (wchar_t& ch : text) ch = static_cast<wchar_t>(std::towlower(ch));
    return text;
}

/** 只认「盘符:\…」与 UNC；相对路径一律拒绝，否则又会退回 CWD/搜索目录。 */
bool isAbsoluteWinPath(const wchar_t* path) {
    if (!path) return false;
    if (path[0] == L'\\' && path[1] == L'\\') return true;
    return path[0] != L'\0' && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
}

/** 规范化成绝对路径（解掉 . / .. 与多余分隔符）；失败返回空串。 */
std::wstring absolutePath(const std::wstring& path) {
    if (path.empty()) return {};
    DWORD need = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
    if (need == 0 || need >= 32768) return {};
    std::wstring out(need, L'\0');
    DWORD written = GetFullPathNameW(path.c_str(), need, out.data(), nullptr);
    if (written == 0 || written >= need) return {};
    out.resize(written);
    return out;
}

/** 必须是存在且非空的常规文件；大小交给调用方写进诊断日志（打包完整性的最小证据）。 */
bool isUsableDllFile(const std::wstring& path, unsigned long long* sizeOut) {
    WIN32_FILE_ATTRIBUTE_DATA info{};
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &info)) return false;
    if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) return false;
    const unsigned long long size =
        (static_cast<unsigned long long>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
    if (size == 0) return false;
    if (sizeOut) *sizeOut = size;
    return true;
}

/**
 * 解析 junction / 符号链接之后的真实路径（小写、去掉 \\?\ 前缀）；失败返回空串。
 *
 * 打开方式必须是 `FILE_READ_ATTRIBUTES + FILE_FLAG_BACKUP_SEMANTICS`：目录句柄不带
 * backup 语义时 CreateFileW 一律失败（实测 ERROR_ACCESS_DENIED / gle=5），而这里既要解析
 * DLL 也要解析安装目录。只读属性不需要任何特权，也不会因此获得文件内容的访问权。
 */
std::wstring finalLowerPath(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (file == INVALID_HANDLE_VALUE) return {};
    wchar_t buffer[MAX_PATH * 2] = {};
    const DWORD len = GetFinalPathNameByHandleW(file, buffer,
                                                static_cast<DWORD>(std::size(buffer)),
                                                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    CloseHandle(file);
    if (len == 0 || len >= std::size(buffer)) return {};
    std::wstring out(buffer, len);
    static const std::wstring prefix = L"\\\\?\\";
    if (out.size() > prefix.size() && out.compare(0, prefix.size(), prefix) == 0) {
        out.erase(0, prefix.size());
    }
    return lowerW(out);
}

/** dir 必须是 path 的一个真实目录前缀（按路径分隔符断句，避免 C:\app 命中 C:\appdata）。 */
bool isUnderDir(const std::wstring& pathLower, const std::wstring& dirLower) {
    if (dirLower.empty() || pathLower.size() <= dirLower.size()) return false;
    if (pathLower.compare(0, dirLower.size(), dirLower) != 0) return false;
    return pathLower[dirLower.size()] == L'\\';
}

/**
 * 安装目录的真实路径（CR #313 P2-6）。
 *
 * 整个安装目录本身就可能合法地挂在 junction 上（`D:\Apps\ProjectX -> E:\ProjectX`、
 * 迁移到第二块盘的 Program Files、漫游目录重定向），此时只把 DLL 解析成真实路径、
 * 却拿逻辑目录去比，随包 DSM 必然「落在目录外」——把正常安装误判成链接替换，现场直接扫不了。
 * 解析失败时退回逻辑路径继续判定：宁可沿用旧的收紧口径，也不要因为一次目录解析失败
 * 就把包内 DSM 判死；DLL 自身解析失败仍然是拒绝（调用方处理那条分支）。
 */
std::wstring realInstallDirLower(const std::wstring& dirLower) {
    if (dirLower.empty()) return {};
    const std::wstring real = finalLowerPath(dirLower);
    return real.empty() ? dirLower : real;
}

/** 安装包把 TWAINDSM.dll 与 scanner-bridge.exe 放在同一目录（build-scanner-bridge.bat）。 */
std::wstring executableDirLower() {
    wchar_t buffer[MAX_PATH] = {};
    const DWORD len = GetModuleFileNameW(nullptr, buffer, static_cast<DWORD>(std::size(buffer)));
    if (len == 0 || len >= std::size(buffer)) return {};
    const std::wstring path(buffer, len);
    const size_t slash = path.find_last_of(L"\\/");
    if (slash == std::wstring::npos) return {};
    return lowerW(path.substr(0, slash));
}

/** Windows 目录：系统自带或 TWAIN 工作组安装的 DSM 落在这里。 */
std::wstring windowsDirLower() {
    wchar_t buffer[MAX_PATH] = {};
    const UINT len = GetSystemWindowsDirectoryW(buffer, static_cast<UINT>(std::size(buffer)));
    if (len == 0 || len >= std::size(buffer)) return {};
    return lowerW(std::wstring(buffer, len));
}

} // namespace

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
        std::string tried;
        auto note = [&tried](const std::string& text) {
            if (!tried.empty()) tried += "; ";
            tried += text;
        };

        // 候选顺序：显式环境覆盖 > 安装包自带 > 系统安装。全部是绝对路径。
        std::vector<std::wstring> candidates;

        wchar_t envPath[MAX_PATH] = {};
        const DWORD envLen = GetEnvironmentVariableW(L"TWAIN_DSM_DLL", envPath,
                                                     static_cast<DWORD>(std::size(envPath)));
        if (envLen > 0 && envLen < std::size(envPath)) {
            // 安全 R40：环境覆盖只接受绝对路径。相对值/裸名会被默认搜索顺序解释成
            // 「CWD 或 PATH 里的同名 DLL」，正是要堵掉的那条路。
            if (isAbsoluteWinPath(envPath)) {
                const std::wstring resolved = absolutePath(envPath);
                if (resolved.empty()) note("TWAIN_DSM_DLL -> 路径过长或无法规范化，已忽略");
                else candidates.push_back(resolved);
            } else {
                note(std::string("TWAIN_DSM_DLL=") + wideToUtf8(envPath) +
                     " -> 不是绝对路径，已忽略");
            }
        }

        const std::wstring exeDir = executableDirLower();
        const std::wstring realExeDir = realInstallDirLower(exeDir);
        const std::wstring winDir = windowsDirLower();
        if (!exeDir.empty()) candidates.push_back(absolutePath(exeDir + L"\\TWAINDSM.dll"));
        if (!winDir.empty()) {
            candidates.push_back(absolutePath(winDir + L"\\TWAINDSM.dll"));
            candidates.push_back(absolutePath(winDir + L"\\twain_32.dll"));
        }

        for (const std::wstring& candidate : candidates) {
            if (candidate.empty()) continue;
            unsigned long long size = 0;
            if (!isUsableDllFile(candidate, &size)) {
                note(wideToUtf8(candidate.c_str()) + " -> 不存在或不是非空常规文件，已跳过");
                continue;
            }
            // 打包完整性：包内那份 DSM 必须真的还在包里。用 junction / 符号链接把它
            // 指到别处时，规范化后的真实路径会落到安装目录之外，此时拒绝加载。
            // 两边都要先解析成真实路径再比（CR #313 P2-6）——安装目录自己就挂在 junction 上
            // 是合法安装，只解析 DLL 会把这种安装误判成链接替换。
            const std::wstring candidateLower = lowerW(candidate);
            if (!exeDir.empty() && isUnderDir(candidateLower, exeDir)) {
                const std::wstring real = finalLowerPath(candidate);
                if (real.empty() || !isUnderDir(real, realExeDir)) {
                    note(wideToUtf8(candidate.c_str()) +
                         " -> 解析后的真实路径已离开安装目录（疑似链接替换），已跳过");
                    continue;
                }
            }

            SetLastError(0);
            // 限制依赖搜索：DSM 自己的依赖也不再走 CWD / PATH
            HMODULE module = LoadLibraryExW(candidate.c_str(), nullptr,
                                            LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR);
            if (!module && GetLastError() == ERROR_INVALID_PARAMETER) {
                // 缺少 LOAD_LIBRARY_SEARCH_* 支持的老系统退回「按 DLL 自身目录改搜索顺序」，
                // 它同样不搜 CWD。
                SetLastError(0);
                module = LoadLibraryExW(candidate.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
            }
            if (!module) {
                char line[64] = {};
                sprintf_s(line, "err=%lu", static_cast<unsigned long>(GetLastError()));
                note(wideToUtf8(candidate.c_str()) + " -> LoadLibraryEx 失败(" + line + ")");
                continue;
            }

            DsmEntryProc entry = reinterpret_cast<DsmEntryProc>(GetProcAddress(module, "DSM_Entry"));
            if (!entry) {
                note(wideToUtf8(candidate.c_str()) + " -> 已加载但缺少 DSM_Entry 导出");
                FreeLibrary(module);
                continue;
            }

            dsmModule = module;
            dsmEntry = entry;
            char sizeText[48] = {};
            sprintf_s(sizeText, "%llu", size);
            g_dsmLoadedPath = wideToUtf8(candidate.c_str()) + "（" + sizeText + " 字节）";
            g_dsmLoaded = true;
            break;
        }
        if (!g_dsmLoaded && tried.empty()) {
            tried = "没有可用的 TWAINDSM.dll 绝对路径候选";
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
            fprintf(stderr, "[ScannerBridge] MSG_XFERREADY received (state=%d)\n", m_state);
            m_state = 6;
        } else if (event.TWMessage == MSG_CLOSEDSREQ || event.TWMessage == MSG_CLOSEDSOK) {
            m_sourceCloseRequested = true;
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
                          "/TWAINDSM.dll 存在；仍失败时重装扫描端安装包。"
                          "（安全 R40：只在安装目录与 Windows 目录内查找绝对路径，"
                          "不再按当前目录或 PATH 搜索同名 DLL。）";
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
    m_sourceCloseRequested = false;
    
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
        result.errorMessage = "扫描仪未应用所设置的色彩模式，请检查驱动支持的模式后重试";
        closeSource();
        closeDSM();
        return result;
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
    // 送纸器配置可能改变单双面状态；在所有配置完成后确认配对契约，再启动走纸。
    if (!setDuplex(config.duplex)) {
        result.errorMessage = config.duplex
            ? "扫描仪未确认启用双面扫描，请检查设备双面能力或改用单面扫描"
            : "扫描仪未确认关闭双面扫描，请在驱动中关闭双面后重试";
        closeSource();
        closeDSM();
        return result;
    }
    setXferCount();   // 必须在 ENABLEDS 之前；不设时驱动默认只交付 1 页
    // 纸型、色彩、ADF 等能力可能重置分辨率；最后设置英寸单位及 X/Y DPI 并回读确认。
    if (!setResolution(config.dpi)) {
        result.errorMessage = "扫描仪未应用所设置的 " + std::to_string(config.dpi) +
            " DPI，请检查驱动支持的分辨率及扫描设置";
        closeSource();
        closeDSM();
        return result;
    }
    
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
    // XFERDONE 后立即 ENDXFER；剩余数非零则回状态 6 直接继续传输，
    // 剩余数为零才回状态 5 等待新的 XFERREADY。
    int pageNum = 0;
    bool hasMorePages = true;
    
    while (hasMorePages && !m_cancelRequested) {
        if (config.maxPages > 0 && pageNum >= config.maxPages) break;
        
        // Check if transfer is ready
        if (!waitForState(6, config.pageTimeoutMs)) {
            if (m_cancelRequested || m_sourceCloseRequested) {
                fprintf(stderr, "[ScannerBridge] Scan ended: %s (pages=%d)\n",
                    m_cancelRequested ? "cancel requested" : "source close requested", pageNum);
            } else {
                fprintf(stderr, "[ScannerBridge] Scan ended: no more pages after %dms idle (pages=%d)\n",
                    config.pageTimeoutMs, pageNum);
            }
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
                result.errorMessage = m_transferError.empty()
                    ? "Failed to capture page " + std::to_string(pageNum) + " (front)" : m_transferError;
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
        // 非零（含 0xffff 未知数量）表示 DS 已在状态 6，可直接取下一帧，不会再发 XFERREADY。
        m_state = pending.Count > 0 ? 6 : 5;
        
        // 背面也可能在 Count=0 后到达；必须在当前物理张内等待，不能交给下轮正面。
        if (config.duplex) {
            if (!shouldWaitForTransfer(pending.Count)) break;
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
                result.errorMessage = m_transferError.empty()
                    ? "Failed to capture page " + std::to_string(pageNum) + " (back)" : m_transferError;
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
            m_state = pending.Count > 0 ? 6 : 5;
        }
        
        fprintf(stderr, "[ScannerBridge] page %d done, pending=%d\n",
            pageNum, static_cast<int>(pending.Count));
        if (config.maxPages > 0 && pageNum >= config.maxPages) break;
        hasMorePages = shouldWaitForTransfer(pending.Count);
    }
    
    // 7. Cleanup
    const bool disabled = disableSource();
    const bool sourceClosed = closeSource();
    const bool dsmClosed = closeDSM();
    if ((!disabled || !sourceClosed || !dsmClosed) && result.errorMessage.empty()) {
        result.errorMessage = "扫描图像已保留，但扫描仪会话未正常关闭，请检查驱动后重试";
    }
    
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
        // 驱动可在 ENABLEDS 内泵消息并同步送达 XFERREADY；保留已经到达的就绪状态。
        fprintf(stderr, "[ScannerBridge] source enabled (state=%d)\n", m_state);
        m_state = std::max(m_state, 3);
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
            fprintf(stderr, "[ScannerBridge] source enabled with UI (state=%d)\n", m_state);
            m_state = std::max(m_state, 3);
            return true;
        }
    }
    
    logError("DSM_Entry MSG_ENABLEDS failed: " + twainResultToString(rc));
    return false;
}

bool TwainController::disableSource() {
    if (m_state < 3) return true;
    if (m_state >= 7) {
        TW_PENDINGXFERS pending{};
        const TW_UINT16 endRc = DSM_Entry(&m_appId, &m_sourceId,
            DG_CONTROL, DAT_PENDINGXFERS, MSG_ENDXFER, &pending);
        fprintf(stderr, "[ScannerBridge] end unfinished transfer before disable rc=%u\n", static_cast<unsigned>(endRc));
        if (endRc != TWRC_SUCCESS) return false;
        m_state = pending.Count > 0 ? 6 : 5;
    }
    if (m_state >= 6) {
        TW_PENDINGXFERS pending{};
        const TW_UINT16 resetRc = DSM_Entry(&m_appId, &m_sourceId,
            DG_CONTROL, DAT_PENDINGXFERS, MSG_RESET, &pending);
        fprintf(stderr, "[ScannerBridge] reset pending transfers before disable rc=%u\n", static_cast<unsigned>(resetRc));
        if (resetRc != TWRC_SUCCESS) return false;
        m_state = 5;
    }
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
    if (rc == TWRC_SUCCESS) m_state = 2;
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
        case TWTY_INT16:
            *(TW_INT16*)&pVal->Item = *(TW_INT16*)value;
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

    return rc == TWRC_SUCCESS;
}

TW_UINT16 TwainController::requestedPixelType() const {
    if (m_config.colorMode == "bw") {
        return TWPT_BW;
    } else if (m_config.colorMode == "color") {
        return TWPT_RGB;
    }
    return TWPT_GRAY;
}

bool TwainController::setPixelType() {
    TW_UINT16 pixelType = requestedPixelType();
    const bool accepted = setCapability(ICAP_PIXELTYPE, TWTY_UINT16, &pixelType);
    TW_UINT16 effective = 0;
    const bool readable = readCurrentUInt16Capability(ICAP_PIXELTYPE, TWTY_UINT16, &effective);
    fprintf(stderr, "[ScannerBridge] ICAP_PIXELTYPE requested=%u set=%s effective=%d\n",
        static_cast<unsigned>(pixelType), accepted ? "ok" : "rejected",
        readable ? static_cast<int>(effective) : -1);
    return readable && effective == pixelType;
}

bool TwainController::setResolution(int dpi) {
    TW_UINT16 units = TWUN_INCHES;
    const bool unitsSet = setCapability(ICAP_UNITS, TWTY_UINT16, &units);
    TW_UINT16 effectiveUnits = 0;
    const bool unitsRead = readCurrentUInt16Capability(ICAP_UNITS, TWTY_UINT16, &effectiveUnits);
    fprintf(stderr, "[ScannerBridge] ICAP_UNITS requested=inches set=%s effective=%d\n",
        unitsSet ? "ok" : "rejected", unitsRead ? static_cast<int>(effectiveUnits) : -1);
    if (!unitsRead || effectiveUnits != TWUN_INCHES) return false;
    TW_FIX32 res;
    res.Whole = (TW_INT16)dpi;
    res.Frac = 0;
    const bool xSet = setCapability(ICAP_XRESOLUTION, TWTY_FIX32, &res);
    const bool ySet = setCapability(ICAP_YRESOLUTION, TWTY_FIX32, &res);
    double x = 0, y = 0;
    const bool xRead = readCurrentResolution(ICAP_XRESOLUTION, &x);
    const bool yRead = readCurrentResolution(ICAP_YRESOLUTION, &y);
    fprintf(stderr, "[ScannerBridge] DPI requested=%d X(set=%s effective=%.4f) Y(set=%s effective=%.4f)\n",
        dpi, xSet ? "ok" : "rejected", xRead ? x : -1, ySet ? "ok" : "rejected", yRead ? y : -1);
    return xRead && yRead && std::abs(x - dpi) < 0.01 && std::abs(y - dpi) < 0.01;
}

bool TwainController::setDuplex(bool duplex) {
    TW_BOOL val = duplex ? TRUE : FALSE;
    const bool accepted = setCapability(CAP_DUPLEXENABLED, TWTY_BOOL, &val);
    return verifyDuplexMode(duplex, accepted ? "ok" : "rejected");
}

bool TwainController::verifyDuplexMode(bool duplex, const char* setStatus) {
    TW_UINT16 effective = 0;
    bool enabledUnsupported = false;
    const bool readable = readCurrentUInt16Capability(CAP_DUPLEXENABLED, TWTY_BOOL, &effective, &enabledUnsupported);
    fprintf(stderr, "[ScannerBridge] CAP_DUPLEXENABLED requested=%d set=%s effective=%d\n",
        duplex ? 1 : 0, setStatus, readable ? (effective != 0 ? 1 : 0) : -1);
    if (readable) return (effective != 0) == duplex;
    // 单面设备可完全不支持 CAP_DUPLEXENABLED；用 CAP_DUPLEX 确认其硬件为单面。
    if (!duplex) {
        TW_UINT16 capability = 0;
        bool capabilityUnsupported = false;
        if (readCurrentUInt16Capability(CAP_DUPLEX, TWTY_UINT16, &capability, &capabilityUnsupported)) {
            return capability == TWDX_NONE;
        }
        // 两项可选能力均明确不支持是合法的单面设备；通信失败和容器异常不走此回退。
        if (enabledUnsupported && capabilityUnsupported) {
            fprintf(stderr, "[ScannerBridge] duplex capabilities unsupported; using simplex source\n");
            return true;
        }
    }
    return false;
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
    const bool accepted = setCapability(CAP_FEEDERENABLED, TWTY_BOOL, &adf);

    TW_BOOL autoFeed = TRUE;
    setCapability(CAP_AUTOFEED, TWTY_BOOL, &autoFeed);

    // 回读确认送纸器真的启用了：SET 可能被静默拒绝（平板机型、驱动差异），
    // 后续 Count=0 后的 ADF 事件等待只在送纸器启用时才有意义。
    TW_UINT16 effective = 0;
    const bool readable = readCurrentUInt16Capability(CAP_FEEDERENABLED, TWTY_BOOL, &effective);
    // 读回失败（含容器格式不符）时仅信任成功的 SET；SET 也失败的平板机不续等。
    m_feederEnabled = readable ? effective != 0 : accepted;
    fprintf(stderr, "[ScannerBridge] CAP_FEEDERENABLED set=%s effective=%d source=%s CAP_AUTOFEED requested=1\n",
        accepted ? "ok" : "rejected", m_feederEnabled ? 1 : 0,
        readable ? "GETCURRENT" : "SET fallback");
    return true;  // Best effort
}

bool TwainController::readCurrentUInt16Capability(TW_UINT16 cap, TW_UINT16 type, TW_UINT16* effective, bool* unsupported) {
    if (unsupported) *unsupported = false;
    TW_CAPABILITY current;
    memset(&current, 0, sizeof(current));
    current.Cap = cap;
    TW_UINT16 rc = DSM_Entry(&m_appId, &m_sourceId,
        DG_CONTROL, DAT_CAPABILITY, MSG_GETCURRENT,
        (TW_MEMREF)&current);
    if (rc != TWRC_SUCCESS || !current.hContainer) {
        if (unsupported && rc == TWRC_FAILURE) {
            TW_STATUS status{};
            if (DSM_Entry(&m_appId, &m_sourceId, DG_CONTROL, DAT_STATUS, MSG_GET, &status) == TWRC_SUCCESS) {
                *unsupported = status.ConditionCode == TWCC_CAPUNSUPPORTED || status.ConditionCode == TWCC_BADCAP;
            }
        }
        fprintf(stderr, "[ScannerBridge] GETCURRENT cap=%u failed rc=%u container=%s\n",
            static_cast<unsigned>(cap), static_cast<unsigned>(rc), current.hContainer ? "present" : "missing");
        if (current.hContainer) GlobalFree(current.hContainer);
        return false;
    }
    bool readable = false;
    pTW_ONEVALUE value = current.ConType == TWON_ONEVALUE
        ? static_cast<pTW_ONEVALUE>(GlobalLock(current.hContainer)) : nullptr;
    if (value && value->ItemType == type) {
        *effective = static_cast<TW_UINT16>(value->Item);
        readable = true;
    }
    if (!readable) {
        fprintf(stderr, "[ScannerBridge] GETCURRENT cap=%u unreadable containerType=%u itemType=%d expected=%u\n",
            static_cast<unsigned>(cap), static_cast<unsigned>(current.ConType),
            value ? static_cast<int>(value->ItemType) : -1, static_cast<unsigned>(type));
    }
    if (value) GlobalUnlock(current.hContainer);
    GlobalFree(current.hContainer);
    return readable;
}

bool TwainController::readCurrentResolution(TW_UINT16 cap, double* effective) {
    TW_CAPABILITY current{};
    current.Cap = cap;
    const TW_UINT16 rc = DSM_Entry(&m_appId, &m_sourceId, DG_CONTROL, DAT_CAPABILITY, MSG_GETCURRENT, &current);
    bool readable = false;
    if (rc == TWRC_SUCCESS && current.hContainer && current.ConType == TWON_ONEVALUE) {
        const auto* value = static_cast<pTW_ONEVALUE>(GlobalLock(current.hContainer));
        if (value && value->ItemType == TWTY_FIX32) {
            TW_FIX32 resolution{};
            memcpy(&resolution, &value->Item, sizeof(resolution));
            *effective = resolution.Whole + resolution.Frac / 65536.0;
            readable = true;
        }
        if (value) GlobalUnlock(current.hContainer);
    }
    if (current.hContainer) GlobalFree(current.hContainer);
    return readable;
}

bool TwainController::validateImageSettings(const TW_IMAGEINFO& info) {
    const double x = info.XResolution.Whole + info.XResolution.Frac / 65536.0;
    const double y = info.YResolution.Whole + info.YResolution.Frac / 65536.0;
    fprintf(stderr, "[ScannerBridge] image DPI requested=%d actualX=%.4f actualY=%.4f pixels=%ldx%ld pixelType=%d bitsPerPixel=%d\n",
        m_config.dpi, x, y, static_cast<long>(info.ImageWidth), static_cast<long>(info.ImageLength),
        static_cast<int>(info.PixelType), static_cast<int>(info.BitsPerPixel));
    const TW_UINT16 pixelType = requestedPixelType();
    fprintf(stderr, "[ScannerBridge] image pixel mode requested=%u actual=%d\n",
        static_cast<unsigned>(pixelType), static_cast<int>(info.PixelType));
    if (info.PixelType != pixelType) {
        m_transferError = "扫描仪实际输出色彩模式与设置不一致，请检查驱动设置后重试";
        return false;
    }
    if (std::abs(x - m_config.dpi) >= 0.01 || std::abs(y - m_config.dpi) >= 0.01) {
        m_transferError = "扫描仪实际输出分辨率与所设置的 " + std::to_string(m_config.dpi) +
            " DPI 不一致，请检查驱动设置后重试";
        return false;
    }
    // 驱动界面（含 ENABLEDS 回退或 CHECKSTATUS 隐式显示）可在启动后改变单双面。
    // 每帧在状态 6 回读、只校验不 SET，防止背面被按下一张正面入库。
    const bool duplexVerified = verifyDuplexMode(m_config.duplex, "not-requested");
    fprintf(stderr, "[ScannerBridge] transfer duplex contract requested=%d state=%d verified=%d\n",
        m_config.duplex ? 1 : 0, m_state, duplexVerified ? 1 : 0);
    if (!duplexVerified) {
        m_transferError = "扫描仪实际单双面模式与设置不一致或无法确认，请检查驱动设置后重试";
        return false;
    }
    return true;
}

bool TwainController::shouldWaitForTransfer(TW_UINT16 pendingCount) {
    if (m_state >= 6) return true;
    if (pendingCount > 0) return true;
    if (!m_feederEnabled) return false;
    // ENDXFER 的 Count=0 使 DS 回到状态 5，后续仍可发送 XFERREADY / CLOSEDSREQ。
    // CAP_FEEDERLOADED 应在状态 4 查询，且托盘空也可能是纸已在通道内；
    // 因此续扫仅依赖启用前确认的 ADF 状态，在事件循环中等满配置的空闲超时。
    fprintf(stderr, "[ScannerBridge] pending=0 ADF enabled; waiting up to %dms for next transfer event\n",
        m_config.pageTimeoutMs);
    return true;
}

bool TwainController::setXferCount() {
    // TWAIN 规范中 CAP_XFERCOUNT 默认值为 1：不显式设置时 DS 只向应用交付 1 页
    // 就结束会话（柯达 i3000 实测：ADF 照常走纸但只收到 1 张）。
    // -1 表示不限张数，是 ADF 批量扫描的标准做法，必须在 ENABLEDS 前设置。
    // 规范规定 CAP_XFERCOUNT 为 TWON_ONEVALUE/TWTY_INT16：用 INT32 协商会被严格
    // 数据源拒绝，而调用方忽略返回值 → 修复静默失效，故必须按 INT16 收发。
    TW_INT16 unlimited = -1;
    bool ok = setCapability(CAP_XFERCOUNT, TWTY_INT16, &unlimited);
    // 回读确认实际生效值（同 setPaperSize 的做法）：驱动拒绝时至少留下诊断日志
    TW_CAPABILITY current;
    memset(&current, 0, sizeof(current));
    current.Cap = CAP_XFERCOUNT;
    TW_UINT16 rc = DSM_Entry(&m_appId, &m_sourceId,
        DG_CONTROL, DAT_CAPABILITY, MSG_GETCURRENT,
        (TW_MEMREF)&current);
    TW_INT16 effective = -1;
    if (rc == TWRC_SUCCESS && current.hContainer) {
        pTW_ONEVALUE value = static_cast<pTW_ONEVALUE>(GlobalLock(current.hContainer));
        if (value && value->ItemType == TWTY_INT16) effective = static_cast<TW_INT16>(value->Item);
        if (value) GlobalUnlock(current.hContainer);
        GlobalFree(current.hContainer);
    }
    fprintf(stderr, "[ScannerBridge] CAP_XFERCOUNT set=%s effective=%d\n",
        ok ? "ok" : "rejected", static_cast<int>(effective));
    return ok;
}

// ── Image Capture ─────────────────────────────────────

bool TwainController::captureNativeTransfer(
    const std::string& outputPath, int pageNum,
    const std::string& side, PageResult& result)
{
    m_transferError.clear();
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
    if (!validateImageSettings(imageInfo)) return false;
    result.dpiX = imageInfo.XResolution.Whole + imageInfo.XResolution.Frac / 65536.0;
    result.dpiY = imageInfo.YResolution.Whole + imageInfo.YResolution.Frac / 65536.0;
    
    // Use native transfer — DAT_IMAGENATIVEXFER 返回的句柄是指针宽（x64 下 8 字节），
    // 必须用 TW_HANDLE（=HANDLE）接收，否则会截断句柄并污染栈
    TW_HANDLE handle = nullptr;
    m_state = 7; // 原生传输成功、取消或失败后均需 ENDXFER，再按 Count 复位。
    rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_IMAGE, DAT_IMAGENATIVEXFER, MSG_GET,
        (TW_MEMREF)&handle
    );
    
    if (rc != TWRC_XFERDONE) {
        logError("Native transfer failed: " + twainResultToString(rc));
        return false;
    }
    
    // 当前帧已取走；调用方立即 ENDXFER，并依据剩余数恢复就绪或等待新事件。
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
    if (bitmap->SetResolution(static_cast<Gdiplus::REAL>(result.dpiX), static_cast<Gdiplus::REAL>(result.dpiY)) != Gdiplus::Ok) {
        delete bitmap;
        return false;
    }
    
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
        if (m_cancelRequested || m_sourceCloseRequested) return false;
        if (m_state >= targetState) return true;
        if (m_state == 0) return false;
        
        // Peek messages for TWAIN
        while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
            // DSM 通知可能使用线程消息或其它窗口；在普通派发前将每条消息交给 DSM。
            // 仅靠本程序 WndProc 转发无法覆盖所有 XFERREADY 投递方式。
            const TW_UINT16 eventRc = processTwainEvent(msg);
            if (m_cancelRequested || m_sourceCloseRequested) return false;
            if (eventRc != TWRC_DSEVENT) {
                TranslateMessage(&msg);
                DispatchMessage(&msg);
            }
            
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
        json += "      \"height\": " + std::to_string(page.height) + ",\n";
        json += "      \"dpi_x\": " + std::to_string(page.dpiX) + ",\n";
        json += "      \"dpi_y\": " + std::to_string(page.dpiY) + "\n";
        json += "    }";
        if (i < result.pages.size() - 1) json += ",";
        json += "\n";
    }
    
    json += "  ]\n}";
    return json;
}

} // namespace ScannerBridge
