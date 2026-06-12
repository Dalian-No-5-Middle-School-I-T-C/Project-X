#pragma once

#ifndef TWH_CMP_MSC
#pragma push_macro("_MSC_VER")
#undef _MSC_VER
#include <windows.h>
#include <twain.h>
#pragma pop_macro("_MSC_VER")
#else
#include <windows.h>
#include <twain.h>
#endif

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

private:
    // TWAIN state machine
    bool openDSM();
    bool closeDSM();
    bool openSource(const TW_IDENTITY& sourceId);
    bool closeSource();
    bool enableSource();
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
    
    // TWAIN callback (static, dispatches to instance)
    static TW_UINT16 TW_CALLBACK dsmCallback(
        pTW_IDENTITY origin,
        pTW_IDENTITY dest,
        TW_UINT32 dg,
        TW_UINT16 dat,
        TW_UINT16 msg,
        TW_MEMREF data
    );
    
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
