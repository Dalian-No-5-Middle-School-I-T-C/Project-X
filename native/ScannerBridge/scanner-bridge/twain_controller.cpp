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
        char envPath[MAX_PATH] = {};
        DWORD envLen = GetEnvironmentVariableA("TWAIN_DSM_DLL", envPath, static_cast<DWORD>(sizeof(envPath)));
        const char* envCandidate = (envLen > 0 && envLen < sizeof(envPath)) ? envPath : nullptr;
#if defined(_WIN64)
        const char* defaultDsmPath = "D:\\twain-dsm-2.5.1\\twain-dsm-2.5.1\\Releases\\dsm_020403\\windows\\64\\TWAINDSM.dll";
#else
        const char* defaultDsmPath = "D:\\twain-dsm-2.5.1\\twain-dsm-2.5.1\\Releases\\dsm_020403\\windows\\32\\TWAINDSM.dll";
#endif
        const char* candidates[] = {
            envCandidate,
            defaultDsmPath,
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
        }
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
    if (TwainController::current()) {
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
    : m_state(0), m_cancelRequested(false), m_hwnd(nullptr)
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

    TW_UINT16 rc = DSM_Entry(
        &m_appId,
        nullptr,
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

std::vector<SourceInfo> TwainController::listSources() {
    std::vector<SourceInfo> sources;
    
    if (!openDSM()) return sources;
    
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
    
    closeDSM();
    return sources;
}

// ── Scan Execution ────────────────────────────────────

ScanResult TwainController::scan(const ScanConfig& config) {
    ScanResult result;
    result.success = false;
    m_config = config;
    m_cancelRequested = false;
    
    // 1. Open DSM
    if (!openDSM()) {
        result.errorMessage = "Failed to open TWAIN Data Source Manager";
        return result;
    }
    
    // 2. Find and open source
    auto sources = listSources();
    
    // Re-open DSM since listSources closed it
    if (!openDSM()) {
        result.errorMessage = "Failed to re-open TWAIN DSM";
        return result;
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
            result.errorMessage = "Scanner not found: " + config.sourceName;
            closeDSM();
            return result;
        }
        memcpy(&m_sourceId, &defaultSource, sizeof(m_sourceId));
    } else {
        memcpy(&m_sourceId, targetSource, sizeof(m_sourceId));
    }
    
    // 3. Open source
    if (!openSource(m_sourceId)) {
        result.errorMessage = "Failed to open scanner: " + std::string(m_sourceId.ProductName);
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
            ? "Scanner does not support native A3 paper size"
            : "Scanner rejected requested paper size: " + config.paperSize;
        disableSource();
        closeSource();
        closeDSM();
        return result;
    }
    enableADF();
    
    // 5. Enable source (shows scanner UI or goes to ready state)
    if (!enableSource(m_config.showUi)) {
        result.errorMessage = "Failed to enable scanner";
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
        if (!waitForState(6, 60000)) {
            // No more pages or timeout
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
            hasMorePages = false;
            break;
        }
        
        // Back side (duplex) — 由 pending.Count 决定是否还有背面，避免干等 30 秒
        if (config.duplex && pending.Count > 0) {
            if (!waitForState(6, 30000)) {
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
    TW_UINT16 rc = DSM_Entry(
        &m_appId, nullptr,
        DG_CONTROL, DAT_PARENT, MSG_OPENDSM,
        (TW_MEMREF)&m_hwnd
    );
    if (rc == TWRC_SUCCESS) {
        m_state = 1;
        return true;
    }
    logError("DSM_Entry MSG_OPENDSM failed: " + twainResultToString(rc));
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
    return setCapability(ICAP_SUPPORTEDSIZES, TWTY_UINT16, &paperSize);
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
        colorTableEntries = (bitCount == 4) ? 16 : (bitCount == 8) ? 256 : 2;
        pixels += colorTableEntries * sizeof(RGBQUAD);
    }
    
    // For 24-bit or compressed images, find pixel data via biSizeImage
    if (bitCount > 8 && pDib->biCompression == BI_RGB) {
        // pixels already correct for top-down
    }
    
    // Create a GDI+ bitmap from the DIB data
    Gdiplus::PixelFormat format;
    if (bitCount == 24) {
        format = PixelFormat24bppRGB;
    } else if (bitCount == 8) {
        format = PixelFormat8bppIndexed;
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
    std::string json = "{\n  \"status\": \"ok\",\n  \"sources\": [\n";
    for (size_t i = 0; i < sources.size(); ++i) {
        json += "    { \"name\": \"" + escapeJson(sources[i].name) + "\" }";
        if (i < sources.size() - 1) json += ",";
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
