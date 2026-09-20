#pragma once

#include <windows.h>
#include <twain.h>

#include <string>
#include <vector>
#include <functional>
#include <cstdint>

namespace ScannerBridge {

struct SourceInfo {
    std::string name;
    TW_IDENTITY identity;
};

struct ScanConfig {
    std::string sourceName;   // TWAIN source product name
    int dpi = 300;
    bool duplex = false;
    bool showUi = false;     // Show scanner's native UI
    std::string colorMode = "gray";  // "gray", "color", "bw"
    std::string paperSize = "A4";    // "A4", "Letter"
    std::string outputDir;
    std::string filePrefix = "scan";
    int maxPages = 0;  // 0 = unlimited (use ADF until empty)
    // 等下一页 XFERREADY(ADF 送纸)的超时。ADF 无纸时驱动不再发事件,
    // 旧实现固定 60s 干等,实测「扫描仪没纸停了软件还不知道」;
    // 默认 15s(连续进纸间隔通常 <3s),可经 --page-timeout-ms 覆盖。
    int pageTimeoutMs = 15000;
};

struct PageResult {
    std::string filePath;
    int pageNumber;
    std::string side;  // "front" or "back"
    int width;
    int height;
};

struct ScanResult {
    bool success;
    std::string errorMessage;
    std::vector<PageResult> pages;
};

/**
 * 数据源枚举的「带因诊断」结果。
 *
 * 旧实现里 listSources() 返回空数组时无法区分 5 种根因（DSM 未加载 / 窗口创建失败 /
 * OPENDSM 失败 / 位宽不匹配 / 真的没接扫描仪），上层只能笼统提示「未检测到扫描仪」，
 * 现场无法自证。这里把每一步的真实结果带出来，供 UI 直接展示可操作的建议。
 */
struct SourceEnumeration {
    std::vector<SourceInfo> sources;
    // "OK" | "WINDOW_CREATE_FAILED" | "DSM_LOAD_FAILED" | "OPENDSM_FAILED" | "NO_SOURCES"
    std::string code = "OK";
    std::string message;          // 面向用户的中文说明
    std::string hint;             // 可操作建议（按位宽给出）
    std::string dsmPath;          // 实际成功加载的 TWAINDSM.dll 路径，空表示未加载
    std::string dsmSearchLog;     // 加载失败时各候选路径的探试记录
    int openDsmRc = -1;           // DSM_Entry(MSG_OPENDSM) 返回码，-1 = 未执行
    int conditionCode = -1;       // DAT_STATUS ConditionCode，-1 = 未取得
    bool windowCreated = false;   // 隐藏窗口是否创建成功（OPENDSM 需要有效 hParent）
};

class TwainController {
public:
    TwainController();
    ~TwainController();

    // Enumerate available TWAIN sources（仅返回数据源，失败原因丢失；保留给内部调用方）
    std::vector<SourceInfo> listSources();

    // Enumerate with full diagnostics（list 命令与 UI 用它）
    SourceEnumeration listSourceDetails();

    // Execute a scan session
    ScanResult scan(const ScanConfig& config);

    // Progress callback: (pageNum, side, status)
    using ProgressCallback = std::function<void(int, const std::string&, const std::string&)>;
    void setProgressCallback(ProgressCallback cb);

    // Cancel an in-progress scan
    void cancel();

    TW_UINT16 processTwainEvent(MSG& msg);
    static TwainController* current();

    // WndProc 守卫：仅当源已打开（m_state >= 2）才把窗口消息转发给 DSM，
    // 窗口创建/销毁期间 m_sourceId 无效，转发只会得到 TWRC_FAILURE
    bool canProcessEvents() const { return m_state >= 2; }

private:
    // TWAIN state machine
    bool openDSM();
    bool closeDSM();
    bool openSource(const TW_IDENTITY& sourceId);
    bool closeSource();
    bool enableSource(bool showUi = false);
    bool disableSource();
    bool startTransfer();
    bool endTransfer();
    
    // Image capture
    bool captureNativeTransfer(const std::string& outputPath, int pageNum, const std::string& side, PageResult& result);
    bool captureFileTransfer(const std::string& outputDir, int pageNum, const std::string& side, PageResult& result);
    
    // Capability negotiation
    bool setCapability(TW_UINT16 cap, TW_UINT16 type, void* value);
    bool setPixelType();
    bool setResolution(int dpi);
    bool setDuplex(bool duplex);
    bool setPaperSize(const std::string& size);
    bool enableADF();
    
    // Image saving
    bool saveDIBToFile(HANDLE hbitmap, const std::string& filePath, PageResult& result);
    
    // Utility
    std::string twainResultToString(TW_UINT16 rc);
    void logError(const std::string& msg);
    bool waitForState(int targetState, DWORD timeoutMs = 30000);

    // TWAIN identities
    TW_IDENTITY m_appId;
    TW_IDENTITY m_sourceId;
    
    // State
    int m_state;  // 1=DSM open, 2=DS open, 3=DS enabled, 4=transferring, 5=transfer done
    bool m_cancelRequested;
    HWND m_hwnd;

    // 最近一次 OPENDSM 失败的真实返回码与条件码（诊断用，避免只报「失败」）
    TW_UINT16 m_lastOpenDsmRc;
    TW_UINT16 m_lastConditionCode;
    bool m_hasOpenDsmAttempt;
    
    // Callbacks
    ProgressCallback m_progressCallback;
    
    // Current scan config
    ScanConfig m_config;
    
    // Single instance for callback
    static TwainController* s_instance;
};

// ── JSON Helpers ──────────────────────────────────────

std::string escapeJson(const std::string& s);
std::string sourcesToJson(const std::vector<SourceInfo>& sources);
std::string sourceEnumerationToJson(const SourceEnumeration& snapshot, const char* arch);
std::string scanResultToJson(const ScanResult& result);

// ── DSM 加载诊断 ──────────────────────────────────────

/** 当前扫描桥接进程的位宽（"ia32" / "x64"），用于位宽不匹配提示 */
const char* bridgeArchName();
/** TWAINDSM.dll 是否已成功加载（含 DSM_Entry 导出解析成功） */
bool dsmLoaded();
/** 成功加载的 DSM 路径；未加载时为空 */
const std::string& dsmLoadedPath();
/** 加载失败时的候选路径探试记录（含 LoadLibraryA 错误码） */
const std::string& dsmLoadLog();
/** 面向用户的一句话 DSM 状态说明（含位宽提示），用于拼进 scan 错误信息 */
std::string dsmDiagnosticSuffix();

} // namespace ScannerBridge
