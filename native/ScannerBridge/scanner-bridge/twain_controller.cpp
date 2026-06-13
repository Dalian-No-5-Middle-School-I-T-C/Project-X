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

#include <gdiplus.h>
#pragma comment(lib, "gdiplus.lib")

#include "twain_controller.hpp"
#include <cstdio>
#include <cstring>
#include <algorithm>

namespace ScannerBridge {

// ── Globals ───────────────────────────────────────────

TwainController* TwainController::s_instance = nullptr;

static const char* WINDOW_CLASS = "ScannerBridgeTwainClass";
static const DWORD TWAIN_MSG = WM_USER + 1;

// ── Window Procedure ──────────────────────────────────

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == TWAIN_MSG && TwainController::s_instance) {
        TW_EVENT event;
        event.pEvent = (TW_MEMREF)&msg;
        event.TWMessage = (TW_UINT16)wParam;
        
        TW_UINT16 rc = DSM_Entry(
            &TwainController::s_instance->m_appId,
            nullptr,
            DG_CONTROL,
            DAT_EVENT,
            MSG_PROCESSEVENT,
            (TW_MEMREF)&event
        );
        return rc == TWRC_DSEVENT ? 0 : 1;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

static HWND createHiddenWindow(HINSTANCE hInstance) {
    WNDCLASSEX wc = {};
    wc.cbSize = sizeof(WNDCLASSEX);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.lpszClassName = WINDOW_CLASS;
    RegisterClassEx(&wc);
    
    return CreateWindowEx(
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
    setPaperSize(config.paperSize);
    enableADF();
    
    // 5. Enable source (shows scanner UI or goes to ready state)
    if (!enableSource(config.showUi)) {
        result.errorMessage = "Failed to enable scanner";
        closeSource();
        closeDSM();
        return result;
    }
    
    // 6. Capture loop - handle ADF multi-page
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
            
            if (captureNativeTransfer(filePath, pageNum, "front", pageResult)) {
                result.pages.push_back(pageResult);
            } else {
                result.errorMessage = "Failed to capture page " + std::to_string(pageNum);
                break;
            }
        }
        
        // Back side (duplex)
        if (config.duplex) {
            if (!waitForState(6, 30000)) {
                hasMorePages = false;
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
            
            if (captureNativeTransfer(filePath, pageNum, "back", pageResult)) {
                result.pages.push_back(pageResult);
            }
        }
        
        // Check for more pages in ADF
        TW_PENDINGXFERS pending;
        memset(&pending, 0, sizeof(pending));
        TW_UINT16 rc = DSM_Entry(
            &m_appId, &m_sourceId,
            DG_CONTROL, DAT_PENDINGXFERS, MSG_ENDXFER,
            (TW_MEMREF)&pending
        );
        
        if (rc == TWRC_SUCCESS && pending.Count > 0) {
            hasMorePages = true;
        } else {
            hasMorePages = false;
        }
    }
    
    // 7. Cleanup
    disableSource();
    closeSource();
    closeDSM();
    
    result.success = result.pages.size() > 0;
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
    
    if (rc == TWRC_SUCCESS) {
        m_state = 3;
        return true;
    }
    
    if (rc == TWRC_CHECKSTATUS) {
        // Consume the pending condition code
        TW_STATUS status;
        memset(&status, 0, sizeof(status));
        TW_UINT16 rc2 = DSM_Entry(
            &m_appId, &m_sourceId,
            DG_CONTROL, DAT_STATUS, MSG_GET,
            (TW_MEMREF)&status
        );
        if (rc2 == TWRC_SUCCESS && status.ConditionCode == TWCC_SUCCESS) {
            m_state = 3;
            return true;
        }
        logError("DSM_Entry MSG_ENABLEDS returned CHECKSTATUS with ConditionCode=" + 
                 std::to_string(status.ConditionCode));
    }
    
    // If ShowUI was FALSE, retry with ShowUI = TRUE (unless explicitly requested UI-less)
    if (!showUi) {
        logError("DSM_Entry MSG_ENABLEDS (no UI) failed: " + twainResultToString(rc) + ", retrying with UI...");
        
        memset(&ui, 0, sizeof(ui));
        ui.ShowUI = TRUE;
        ui.ModalUI = TRUE;
        ui.hParent = m_hwnd;
        
        rc = DSM_Entry(
            &m_appId, &m_sourceId,
            DG_CONTROL, DAT_USERINTERFACE, MSG_ENABLEDS,
            (TW_MEMREF)&ui
        );
        
        if (rc == TWRC_SUCCESS || rc == TWRC_CHECKSTATUS) {
            m_state = 3;
            return true;
        }
        
        logError("DSM_Entry MSG_ENABLEDS (with UI) also failed: " + twainResultToString(rc));
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
    
    // Use native transfer
    TW_UINT32 handle = 0;
    rc = DSM_Entry(
        &m_appId, &m_sourceId,
        DG_IMAGE, DAT_IMAGENATIVEXFER, MSG_GET,
        (TW_MEMREF)&handle
    );
    
    if (rc != TWRC_XFERDONE) {
        logError("Native transfer failed: " + twainResultToString(rc));
        return false;
    }
    
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
    setup.Priority = TWPR_GROUP1;
    
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
        
        // Check if state already reached (e.g. set by a previous event)
        if (m_state >= targetState) return true;
        
        // Peek messages for TWAIN
        while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessage(&msg);
            
            // Check if TWAIN event (MSG_XFERREADY) set the target state
            if (m_state >= targetState) return true;
        }
        
        Sleep(50);
    }
    
    // Timeout
    logError("waitForState timeout after " + std::to_string(timeoutMs) + "ms waiting for state " + std::to_string(targetState) + " (current=" + std::to_string(m_state) + ")");
    return false;
}

// ── TWAIN Callback ────────────────────────────────────

TW_UINT16 TW_CALLBACK TwainController::dsmCallback(
    pTW_IDENTITY origin,
    pTW_IDENTITY dest,
    TW_UINT32 dg,
    TW_UINT16 dat,
    TW_UINT16 msg,
    TW_MEMREF data)
{
    // Handle TWAIN events
    if (dg == DG_CONTROL && dat == DAT_EVENT && msg == MSG_PROCESSEVENT) {
        TW_EVENT* event = (TW_EVENT*)data;
        if (event->TWMessage == MSG_XFERREADY) {
            if (s_instance) {
                s_instance->m_state = 4;  // transfer ready
            }
            return TWRC_DSEVENT;
        }
        if (event->TWMessage == MSG_CLOSEDSOK) {
            return TWRC_DSEVENT;
        }
        if (event->TWMessage == MSG_CLOSEDSREQ) {
            if (s_instance) {
                s_instance->m_state = 0;
            }
            return TWRC_DSEVENT;
        }
    }
    return TWRC_NOTDSEVENT;
}

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
