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

class TwainController {
public:
    TwainController();
    ~TwainController();

    // Enumerate available TWAIN sources
    std::vector<SourceInfo> listSources();

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
std::string scanResultToJson(const ScanResult& result);

} // namespace ScannerBridge
