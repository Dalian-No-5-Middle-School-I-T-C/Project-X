#include <cassert>
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>
#include "twain_controller.hpp"

using namespace ScannerBridge;
static std::string g_dsmLoadedPath = "fixture";
static DWORD clockMs;
static int frameIndex;
static bool announced;
static bool normalMessagePending;
static int dispatchedMessages;
static int readyEvents;
static DWORD nextReady;
static std::vector<DWORD> delays;
static std::vector<TW_UINT16> counts;
static bool feederLoaded, feederSupported, feederSetAccepted, feederReadSupported, feederEnabled;
static bool badFeederType;
static bool duplexSetAccepted, duplexReadSupported, duplexEffective, duplexSubstitute;
static bool duplexCapabilitySupported;
static TW_UINT16 duplexHardware;
static bool synchronousReady;
static bool duplexReadUnsupported, duplexCapabilityUnsupported, lastCapUnsupported;
static bool unitsAccepted, xResolutionAccepted, yResolutionAccepted, resolutionSubstitute, resolutionReadable;
static bool resolutionChangesOnEnable;
static TW_UINT16 effectiveUnits;
static int effectiveX, effectiveY;
static std::vector<TW_UINT16> configuredCaps;
static bool pendingTransfers, closeAfterFrames, closeDelivered, saveFails;
static int resetCalls, disableCalls;
static TW_ONEVALUE capabilityValue;

DWORD GetTickCount() { return clockMs; }
void Sleep(DWORD ms) { clockMs += ms; }
bool PeekMessage(MSG*, void*, int, int, int) {
    return normalMessagePending || (!announced && frameIndex < static_cast<int>(delays.size()) && clockMs >= nextReady)
        || (closeAfterFrames && !closeDelivered && frameIndex >= static_cast<int>(delays.size()));
}
void TranslateMessage(MSG*) {}
void DispatchMessage(MSG*) { ++dispatchedMessages; }
void* GlobalLock(void* p) { return p; }
void GlobalUnlock(void*) {}
void GlobalFree(void*) {}

extern "C" TW_UINT16 TW_CALLINGSTYLE DSM_Entry(pTW_IDENTITY, pTW_IDENTITY,
    TW_UINT32, TW_UINT16 dat, TW_UINT16 msg, TW_MEMREF data) {
    if (dat == DAT_IDENTITY && msg == MSG_GETFIRST) {
        std::strcpy(static_cast<pTW_IDENTITY>(data)->ProductName, "fixture");
        return TWRC_SUCCESS;
    }
    if (dat == DAT_IDENTITY && msg == MSG_GETNEXT) return TWRC_ENDOFLIST;
    if (dat == DAT_PENDINGXFERS && msg == MSG_ENDXFER) {
        static_cast<pTW_PENDINGXFERS>(data)->Count = counts.at(frameIndex - 1);
        pendingTransfers = counts.at(frameIndex - 1) > 0;
        return TWRC_SUCCESS;
    }
    if (dat == DAT_PENDINGXFERS && msg == MSG_RESET) {
        ++resetCalls; pendingTransfers = false;
        return TWRC_SUCCESS;
    }
    if (dat == DAT_EVENT) {
        if (normalMessagePending) {
            normalMessagePending = false;
            return TWRC_NOTDSEVENT;
        }
        if (closeAfterFrames && frameIndex >= static_cast<int>(delays.size())) {
            closeDelivered = true;
            static_cast<pTW_EVENT>(data)->TWMessage = MSG_CLOSEDSREQ;
            return TWRC_DSEVENT;
        }
        announced = true;
        pendingTransfers = true;
        ++readyEvents;
        static_cast<pTW_EVENT>(data)->TWMessage = MSG_XFERREADY;
        return TWRC_DSEVENT;
    }
    if (dat == DAT_USERINTERFACE && msg == MSG_ENABLEDS) {
        if (resolutionChangesOnEnable) effectiveX = effectiveY = 150;
        if (synchronousReady) {
            normalMessagePending = false;
            MSG event;
            TwainController::current()->processTwainEvent(event);
        }
        return TWRC_SUCCESS;
    }
    if (dat == DAT_USERINTERFACE && msg == MSG_DISABLEDS) {
        assert(!pendingTransfers && "Reset pending frames before disabling a source");
        ++disableCalls;
        return TWRC_SUCCESS;
    }
    if (dat == DAT_STATUS && msg == MSG_GET) {
        static_cast<pTW_STATUS>(data)->ConditionCode = lastCapUnsupported ? TWCC_CAPUNSUPPORTED : TWCC_OPERATIONERROR;
        return TWRC_SUCCESS;
    }
    if (dat == DAT_CAPABILITY && msg == MSG_GETCURRENT) {
        auto cap = static_cast<pTW_CAPABILITY>(data);
        lastCapUnsupported = (cap->Cap == CAP_DUPLEXENABLED && duplexReadUnsupported)
            || (cap->Cap == CAP_DUPLEX && duplexCapabilityUnsupported);
        if ((cap->Cap == CAP_FEEDERLOADED && !feederSupported)
            || (cap->Cap == CAP_FEEDERENABLED && !feederReadSupported)
            || (cap->Cap == CAP_DUPLEXENABLED && !duplexReadSupported)
            || (cap->Cap == CAP_DUPLEX && !duplexCapabilitySupported)) return TWRC_FAILURE;
        if (cap->Cap == ICAP_XRESOLUTION || cap->Cap == ICAP_YRESOLUTION) {
            if (!resolutionReadable) return TWRC_FAILURE;
            cap->ConType = TWON_ONEVALUE;
            capabilityValue.ItemType = TWTY_FIX32;
            TW_FIX32 value{};
            value.Whole = cap->Cap == ICAP_XRESOLUTION ? effectiveX : effectiveY;
            memcpy(&capabilityValue.Item, &value, sizeof(value));
            cap->hContainer = &capabilityValue;
            return TWRC_SUCCESS;
        }
        cap->ConType = TWON_ONEVALUE;
        capabilityValue.ItemType = cap->Cap == ICAP_PIXELTYPE || cap->Cap == CAP_DUPLEX || cap->Cap == ICAP_UNITS || (cap->Cap == CAP_FEEDERENABLED && badFeederType)
            ? TWTY_UINT16 : TWTY_BOOL;
        capabilityValue.Item = cap->Cap == ICAP_UNITS ? effectiveUnits : cap->Cap == CAP_DUPLEXENABLED ? duplexEffective
            : cap->Cap == CAP_DUPLEX ? duplexHardware : cap->Cap == CAP_FEEDERENABLED ? feederEnabled
            : cap->Cap == CAP_FEEDERLOADED ? feederLoaded : TWPT_RGB;
        cap->hContainer = &capabilityValue;
        return TWRC_SUCCESS;
    }
    assert(false && "Unexpected DSM request");
    return TWRC_FAILURE;
}

namespace ScannerBridge {
TwainController* TwainController::s_instance = nullptr;
TwainController::TwainController() : m_state(0), m_cancelRequested(false), m_hwnd(nullptr) { s_instance = this; }
TwainController::~TwainController() { s_instance = nullptr; }
TwainController* TwainController::current() { return s_instance; }
bool TwainController::openDSM() { m_state = 1; return true; }
bool TwainController::closeDSM() { m_state = 0; return true; }
bool TwainController::openSource(const TW_IDENTITY&) { m_state = 2; return true; }
bool TwainController::closeSource() { m_state = 1; return true; }
bool TwainController::setCapability(TW_UINT16 cap, TW_UINT16, void* value) {
    configuredCaps.push_back(cap);
    if (cap == ICAP_UNITS) { if (unitsAccepted) effectiveUnits = *static_cast<TW_UINT16*>(value); return unitsAccepted; }
    if (cap == ICAP_XRESOLUTION || cap == ICAP_YRESOLUTION) {
        const bool accepted = cap == ICAP_XRESOLUTION ? xResolutionAccepted : yResolutionAccepted;
        if (accepted && !resolutionSubstitute) {
            (cap == ICAP_XRESOLUTION ? effectiveX : effectiveY) = static_cast<TW_FIX32*>(value)->Whole;
        }
        return accepted;
    }
    if (cap == CAP_FEEDERENABLED) effectiveX = effectiveY = 75; // Simulate a driver's capability dependency reset.
    if (cap == CAP_DUPLEXENABLED) {
        if (duplexSetAccepted && !duplexSubstitute) duplexEffective = *static_cast<TW_BOOL*>(value) != 0;
        return duplexSetAccepted;
    }
    return cap == CAP_FEEDERENABLED ? feederSetAccepted : true;
}
bool TwainController::setPaperSize(const std::string&) { return true; }
bool TwainController::setXferCount() { return true; }
std::string TwainController::twainResultToString(TW_UINT16) { return "fixture failure"; }
void TwainController::logError(const std::string&) {}
std::string archHint() { return "fixture"; }
std::string dsmDiagnosticSuffix() { return "fixture"; }
bool TwainController::captureNativeTransfer(const std::string& output, int page, const std::string& side, PageResult& result) {
    m_transferError.clear();
    assert(m_state == 6);
    TW_IMAGEINFO info{};
    info.XResolution.Whole = effectiveX; info.YResolution.Whole = effectiveY;
    if (!validateImageResolution(info)) return false;
    result = { output, page, side, 1, 1 };
    ++frameIndex;
    m_state = 7;
    if (saveFails) return false;
    announced = false;
    if (frameIndex < static_cast<int>(delays.size())) nextReady = clockMs + delays[frameIndex];
    return true;
}
}

#include "production.inc"

static void reset(std::vector<DWORD> frameDelays, std::vector<TW_UINT16> pending) {
    clockMs = 0; frameIndex = 0; announced = false;
    normalMessagePending = true; dispatchedMessages = 0;
    readyEvents = 0;
    delays = frameDelays; counts = pending; nextReady = delays.at(0);
    feederLoaded = false; feederSupported = true; feederSetAccepted = true;
    feederReadSupported = true; feederEnabled = true; badFeederType = false;
    duplexSetAccepted = true; duplexReadSupported = true; duplexEffective = false;
    duplexSubstitute = false; duplexCapabilitySupported = true; duplexHardware = TWDX_1PASSDUPLEX;
    synchronousReady = false;
    duplexReadUnsupported = duplexCapabilityUnsupported = true; lastCapUnsupported = false;
    unitsAccepted = xResolutionAccepted = yResolutionAccepted = resolutionReadable = true;
    resolutionSubstitute = resolutionChangesOnEnable = false;
    effectiveUnits = TWUN_CENTIMETERS; effectiveX = effectiveY = 75; configuredCaps.clear();
    pendingTransfers = closeAfterFrames = closeDelivered = saveFails = false; resetCalls = disableCalls = 0;
}
static ScanResult run(bool duplex = false, int maxPages = 0) {
    TwainController controller;
    ScanConfig config;
    config.sourceName = "fixture"; config.outputDir = "fixture";
    config.duplex = duplex; config.maxPages = maxPages;
    return controller.scan(config);
}
int main() {
    // The last sheet is already past the tray sensor and needs 25 seconds before XFERREADY.
    reset({0, 25000}, {0, 0});
    auto result = run();
    assert(result.success && result.pages.size() == 2);
    assert(dispatchedMessages == 1); // Normal messages dispatch; DSM thread messages are consumed by the pump.
    assert(clockMs == 85000); // full 60-second end-of-batch wait, no short grace cutoff
    // Count=0 before every side; a 45-second back must stay paired with its original front.
    reset({0, 45000, 1000, 30000}, {0, 0, 0, 0});
    result = run(true, 2);
    assert(result.success && result.pages.size() == 4);
    for (int i = 0; i < 4; ++i) {
        assert(result.pages[i].pageNumber == i / 2 + 1);
        assert(result.pages[i].side == (i % 2 ? "back" : "front"));
    }
    assert(clockMs == 76000); // maxPages stops after the complete final physical sheet
    reset({0, 65000}, {0, 0});
    result = run(true);
    assert(!result.success && result.pages.size() == 1);
    assert(result.errorMessage.find("back side of page 1") != std::string::npos);
    // Unsupported feeder capability and flatbed fall back to the reported count.
    reset({0, 1000}, {0, 0}); feederSupported = false;
    assert(run().pages.size() == 1 && clockMs == 0);
    reset({0, 1000}, {0, 0}); feederSetAccepted = false; feederReadSupported = false;
    assert(run().pages.size() == 1 && clockMs == 0);
    reset({0, 1000}, {0, 0}); feederEnabled = false;
    assert(run().pages.size() == 1 && clockMs == 0);
    // Unreadable GETCURRENT consistently falls back to a successful SET.
    reset({0, 1000}, {0, 0}); badFeederType = true;
    assert(run(false, 2).pages.size() == 2);
    reset({0, 1000}, {0, 0}); feederReadSupported = false; feederLoaded = true;
    assert(run(false, 2).pages.size() == 2);
    reset({0, 1000}, {1, 0}); feederSupported = false;
    assert(run(false, 2).pages.size() == 2);
    // Refuse pairing before starting acquisition when the driver rejects/substitutes duplex.
    reset({0, 1000}, {0, 0}); duplexSetAccepted = false;
    result = run(true);
    assert(!result.success && result.pages.empty() && frameIndex == 0);
    reset({0, 1000}, {0, 0}); duplexSubstitute = true;
    result = run(true);
    assert(!result.success && result.pages.empty() && frameIndex == 0);
    reset({0, 1000}, {0, 0}); duplexReadSupported = false;
    result = run(true);
    assert(!result.success && result.pages.empty() && frameIndex == 0);
    // GETCURRENT confirming enabled is sufficient even if SET was rejected as redundant.
    reset({0, 1000}, {0, 0}); duplexSetAccepted = false; duplexEffective = true;
    assert(run(true, 1).pages.size() == 2);
    // Explicit simplex must disable a duplex state left by an earlier application.
    reset({0, 1000}, {0, 0}); duplexEffective = true;
    assert(run(false, 2).pages.size() == 2 && !duplexEffective);
    reset({0, 1000}, {0, 0}); duplexEffective = true; duplexSubstitute = true;
    assert(!run(false).success && frameIndex == 0);
    // A hardware simplex source can omit DUPLEXENABLED if CAP_DUPLEX confirms TWDX_NONE.
    reset({0}, {0}); duplexReadSupported = false; duplexHardware = TWDX_NONE;
    assert(run(false, 1).success);
    reset({0}, {0}); duplexReadSupported = false; duplexCapabilitySupported = false;
    assert(run(false, 1).success && frameIndex == 1);
    reset({0}, {0}); duplexReadSupported = false; duplexCapabilitySupported = false;
    duplexReadUnsupported = duplexCapabilityUnsupported = false;
    assert(!run(false, 1).success && frameIndex == 0);
    reset({0}, {0}); synchronousReady = true;
    result = run(false, 1);
    assert(result.success && result.pages.size() == 1 && clockMs == 0);
    reset({0, 0, 0}, {TWON_DONTCARE16, TWON_DONTCARE16, 0});
    result = run(false, 3);
    assert(result.success && result.pages.size() == 3 && readyEvents == 1);
    assert(effectiveUnits == TWUN_INCHES && effectiveX == 300 && effectiveY == 300);
    assert(configuredCaps[configuredCaps.size()-2] == ICAP_XRESOLUTION && configuredCaps.back() == ICAP_YRESOLUTION);
    reset({0}, {0}); xResolutionAccepted = false;
    assert(!run(false, 1).success && effectiveY == 300 && frameIndex == 0);
    reset({0}, {0}); resolutionSubstitute = true;
    assert(!run(false, 1).success && frameIndex == 0);
    reset({0}, {0}); unitsAccepted = false;
    assert(!run(false, 1).success && frameIndex == 0);
    reset({0}, {0}); resolutionReadable = false;
    assert(!run(false, 1).success && frameIndex == 0);
    reset({0}, {0}); resolutionChangesOnEnable = true;
    result = run(false, 1);
    assert(!result.success && result.pages.empty() && result.errorMessage.find("DPI") != std::string::npos);
    assert(resetCalls == 1 && disableCalls == 1);
    reset({0}, {0}); saveFails = true;
    result = run(false, 1);
    assert(!result.success && result.pages.empty() && resetCalls == 0 && disableCalls == 1);
    reset({0, 0, 0}, {TWON_DONTCARE16, TWON_DONTCARE16, 0});
    result = run(false, 1);
    assert(result.success && result.pages.size() == 1 && resetCalls == 1 && disableCalls == 1);
    reset({0}, {0}); closeAfterFrames = true;
    result = run();
    assert(result.success && result.pages.size() == 1 && clockMs == 0 && disableCalls == 1);
    std::puts("PASS production scan loop: in-flight final sheet, duplex pairing, timeout, capability fallbacks and page limit");
}
