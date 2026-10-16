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
static int normalMessageOffers, defaultWindowMessages;
static bool notifyDuringDispatch, repeatDuringDefault;
static constexpr UINT normalMessage = 0x8001, readyMessage = 0x8002, closeMessage = 0x8003;
static HWND testWindow = reinterpret_cast<HWND>(1);
static HWND normalTarget;
static bool directNormalOnEnable;
namespace ScannerBridge { static LRESULT CALLBACK WndProc(HWND, UINT, WPARAM, LPARAM); }
static int readyEvents;
static DWORD nextReady;
static std::vector<DWORD> delays;
static std::vector<TW_UINT16> counts;
static bool feederSetAccepted, feederReadSupported, feederEnabled;
static bool badFeederType;
static bool sourceEnabled;
static int invalidFeederQueries;
static bool duplexSetAccepted, duplexReadSupported, duplexEffective, duplexSubstitute;
static bool duplexCapabilitySupported;
static bool duplexChangesOnEnable, duplexChangesOnReady, duplexChangesAfterFirstFrame, duplexReadFailsAfterEnable;
static bool failNoUiEnable, forceUiCheckStatus;
static int enableCalls;
static TW_UINT16 duplexHardware;
static bool synchronousReady;
static bool duplexReadUnsupported, duplexCapabilityUnsupported, lastCapUnsupported;
static bool unitsAccepted, xResolutionAccepted, yResolutionAccepted, resolutionSubstitute, resolutionReadable;
static bool resolutionChangesOnEnable;
static bool pixelSetAccepted, pixelReadable, pixelSubstitute, pixelChangesOnEnable, pixelChangesAfterFirstFrame;
static TW_UINT16 effectivePixelType;
static TW_UINT16 effectiveUnits;
static int effectiveX, effectiveY;
static std::vector<TW_UINT16> configuredCaps;
static bool pendingTransfers, closeAfterFrames, closeDelivered, saveFails;
static int resetCalls, disableCalls;
// 每次 MSG_ENDXFER 的返回码（按帧序），缺省 TWRC_SUCCESS；驱动可用同值的
// TWRC_ENDOFLIST/TWRC_ENDOFLJOB 表示「本次作业再无待传输图像」，属正常收尾。
static std::vector<TW_UINT16> endXferCodes;
static TW_ONEVALUE capabilityValue;

DWORD GetTickCount() { return clockMs; }
void Sleep(DWORD ms) { clockMs += ms; }
bool PeekMessage(MSG* message, void*, int, int, int) {
    *message = {};
    if (normalMessagePending) {
        normalMessagePending = false;
        *message = { normalTarget, normalMessage, 17, 23, clockMs, { 0, 0 } };
        return true;
    }
    if (!announced && frameIndex < static_cast<int>(delays.size()) && clockMs >= nextReady) {
        message->message = readyMessage; // Thread notification: never dispatched to a window.
        return true;
    }
    if (closeAfterFrames && !closeDelivered && frameIndex >= static_cast<int>(delays.size())) {
        message->hwnd = testWindow;
        message->message = closeMessage;
        return true;
    }
    return false;
}
void TranslateMessage(MSG*) {}
void DispatchMessage(MSG* message) {
    ++dispatchedMessages;
    if (message->hwnd == testWindow) ScannerBridge::WndProc(message->hwnd, message->message, message->wParam, message->lParam);
    else if (notifyDuringDispatch) {
        notifyDuringDispatch = false;
        ScannerBridge::WndProc(testWindow, readyMessage, 0, 0);
    }
}
LRESULT DefWindowProcA(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    ++defaultWindowMessages;
    if (notifyDuringDispatch) {
        notifyDuringDispatch = false;
        ScannerBridge::WndProc(hwnd, readyMessage, 0, 0);
    }
    if (repeatDuringDefault) {
        repeatDuringDefault = false;
        ScannerBridge::WndProc(hwnd, message, wParam, lParam); // Distinct synchronous message, same fields.
    }
    return 0;
}
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
        return endXferCodes.size() > static_cast<size_t>(frameIndex - 1)
            ? endXferCodes[frameIndex - 1] : TWRC_SUCCESS;
    }
    if (dat == DAT_PENDINGXFERS && msg == MSG_RESET) {
        ++resetCalls; pendingTransfers = false;
        return TWRC_SUCCESS;
    }
    if (dat == DAT_EVENT) {
        const auto* message = static_cast<MSG*>(static_cast<pTW_EVENT>(data)->pEvent);
        if (message->message == normalMessage) {
            ++normalMessageOffers;
            return TWRC_NOTDSEVENT;
        }
        if (message->message == closeMessage) {
            closeDelivered = true;
            static_cast<pTW_EVENT>(data)->TWMessage = MSG_CLOSEDSREQ;
            return TWRC_DSEVENT;
        }
        assert(message->message == readyMessage);
        announced = true;
        pendingTransfers = true;
        if (duplexChangesOnReady && frameIndex == 0) duplexEffective = !duplexEffective;
        ++readyEvents;
        static_cast<pTW_EVENT>(data)->TWMessage = MSG_XFERREADY;
        return TWRC_DSEVENT;
    }
    if (dat == DAT_USERINTERFACE && msg == MSG_ENABLEDS) {
        ++enableCalls;
        if (failNoUiEnable && !static_cast<pTW_USERINTERFACE>(data)->ShowUI) return TWRC_FAILURE;
        sourceEnabled = true;
        if (directNormalOnEnable) ScannerBridge::WndProc(testWindow, normalMessage, 17, 23);
        if (duplexChangesOnEnable) duplexEffective = !duplexEffective;
        if (resolutionChangesOnEnable) effectiveX = effectiveY = 150;
        if (pixelChangesOnEnable) effectivePixelType = TWPT_GRAY;
        if (synchronousReady) {
            normalMessagePending = false;
            ScannerBridge::WndProc(testWindow, readyMessage, 0, 0);
        }
        return forceUiCheckStatus ? TWRC_CHECKSTATUS : TWRC_SUCCESS;
    }
    if (dat == DAT_USERINTERFACE && msg == MSG_DISABLEDS) {
        sourceEnabled = false;
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
        // A conforming source can reject FEEDERLOADED after ENABLEDS (including State 5).
        if (cap->Cap == CAP_FEEDERLOADED) {
            if (sourceEnabled) ++invalidFeederQueries;
            return TWRC_FAILURE;
        }
        lastCapUnsupported = (cap->Cap == CAP_DUPLEXENABLED && duplexReadUnsupported)
            || (cap->Cap == CAP_DUPLEX && duplexCapabilityUnsupported);
        if (cap->Cap == CAP_DUPLEXENABLED && sourceEnabled && duplexReadFailsAfterEnable) {
            lastCapUnsupported = false;
            return TWRC_FAILURE;
        }
        if ((cap->Cap == CAP_FEEDERENABLED && !feederReadSupported)
            || (cap->Cap == ICAP_PIXELTYPE && !pixelReadable)
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
            : cap->Cap == CAP_DUPLEX ? duplexHardware : cap->Cap == CAP_FEEDERENABLED ? feederEnabled : effectivePixelType;
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
    if (cap == ICAP_PIXELTYPE) {
        if (pixelSetAccepted && !pixelSubstitute) effectivePixelType = *static_cast<TW_UINT16*>(value);
        return pixelSetAccepted;
    }
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
        assert(!sourceEnabled && "Duplex validation after ENABLEDS must be read-only");
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
    if (duplexChangesAfterFirstFrame && frameIndex > 0) duplexEffective = false;
    info.PixelType = pixelChangesAfterFirstFrame && frameIndex > 0 ? TWPT_GRAY : effectivePixelType;
    info.XResolution.Whole = effectiveX; info.YResolution.Whole = effectiveY;
    if (!validateImageSettings(info)) return false;
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
    normalMessageOffers = defaultWindowMessages = 0;
    notifyDuringDispatch = repeatDuringDefault = false;
    normalTarget = testWindow; directNormalOnEnable = false;
    readyEvents = 0;
    delays = frameDelays; counts = pending; nextReady = delays.at(0);
    feederSetAccepted = true;
    feederReadSupported = true; feederEnabled = true; badFeederType = false;
    sourceEnabled = false; invalidFeederQueries = 0;
    duplexSetAccepted = true; duplexReadSupported = true; duplexEffective = false;
    duplexSubstitute = false; duplexCapabilitySupported = true; duplexHardware = TWDX_1PASSDUPLEX;
    duplexChangesOnEnable = duplexChangesOnReady = duplexChangesAfterFirstFrame = duplexReadFailsAfterEnable = false;
    failNoUiEnable = forceUiCheckStatus = false; enableCalls = 0;
    synchronousReady = false;
    duplexReadUnsupported = duplexCapabilityUnsupported = true; lastCapUnsupported = false;
    unitsAccepted = xResolutionAccepted = yResolutionAccepted = resolutionReadable = true;
    resolutionSubstitute = resolutionChangesOnEnable = false;
    pixelSetAccepted = pixelReadable = true;
    pixelSubstitute = pixelChangesOnEnable = pixelChangesAfterFirstFrame = false;
    effectivePixelType = TWPT_GRAY;
    effectiveUnits = TWUN_CENTIMETERS; effectiveX = effectiveY = 75; configuredCaps.clear();
    pendingTransfers = closeAfterFrames = closeDelivered = saveFails = false; resetCalls = disableCalls = 0;
    endXferCodes.clear();
}
static ScanResult run(bool duplex = false, int maxPages = 0, const std::string& mode = "color", bool showUi = false) {
    TwainController controller;
    ScanConfig config;
    config.sourceName = "fixture"; config.outputDir = "fixture";
    config.duplex = duplex; config.maxPages = maxPages;
    config.colorMode = mode;
    config.showUi = showUi;
    auto result = controller.scan(config);
    assert(invalidFeederQueries == 0 && "Do not query FEEDERLOADED after enabling the source");
    return result;
}
int main() {
    reset({0}, {0});
    { TwainController controller;
      ScannerBridge::WndProc(testWindow, normalMessage, 17, 23);
      assert(normalMessageOffers == 0 && defaultWindowMessages == 1); // No source: no DSM forwarding.
    }
    reset({0}, {0}); notifyDuringDispatch = true;
    assert(run(false, 1).success && readyEvents == 1 && normalMessageOffers == 1 && defaultWindowMessages == 1);
    reset({0}, {0}); repeatDuringDefault = true;
    assert(run(false, 1).success && normalMessageOffers == 2 && defaultWindowMessages == 2);
    reset({0}, {0}); directNormalOnEnable = true;
    assert(run(false, 1).success && normalMessageOffers == 2 && defaultWindowMessages == 2);
    reset({0}, {0}); normalTarget = nullptr;
    assert(run(false, 1).success && normalMessageOffers == 1 && defaultWindowMessages == 0);
    reset({0}, {0}); normalTarget = reinterpret_cast<HWND>(2); notifyDuringDispatch = true;
    assert(run(false, 1).success && normalMessageOffers == 1 && defaultWindowMessages == 0 && readyEvents == 1);
    reset({0, 0}, {1, 0}); duplexChangesOnEnable = true;
    auto overriddenDuplex = run(false, 2, "color", true);
    assert(!overriddenDuplex.success && overriddenDuplex.pages.empty() && frameIndex == 0);
    assert(overriddenDuplex.errorMessage.find("单双面") != std::string::npos && resetCalls == 1 && disableCalls == 1);
    reset({0, 0}, {1, 0}); duplexChangesOnEnable = true; failNoUiEnable = true;
    overriddenDuplex = run(false, 2);
    assert(!overriddenDuplex.success && overriddenDuplex.pages.empty() && frameIndex == 0 && enableCalls == 2);
    reset({0, 0}, {1, 0}); duplexChangesOnEnable = true; forceUiCheckStatus = true;
    assert(!run(false, 2).success && frameIndex == 0 && enableCalls == 1);
    // Nonmodal UI changes may arrive with XFERREADY, after ENABLEDS already returned.
    reset({0, 0}, {1, 0}); duplexChangesOnReady = true;
    assert(!run(false, 2, "color", true).success && frameIndex == 0 && readyEvents == 1);
    reset({0, 0}, {1, 0}); duplexChangesOnEnable = true; synchronousReady = true;
    assert(!run(true, 1, "color", true).success && frameIndex == 0 && readyEvents == 1);
    reset({0}, {0}); duplexReadFailsAfterEnable = true;
    assert(!run(false, 1).success && frameIndex == 0);
    reset({0, 0}, {1, 0}); duplexChangesAfterFirstFrame = true;
    overriddenDuplex = run(true, 1);
    assert(!overriddenDuplex.success && overriddenDuplex.pages.size() == 1 && frameIndex == 1);
    assert(overriddenDuplex.errorMessage.find("单双面") != std::string::npos && resetCalls == 1 && disableCalls == 1);
    reset({0, 0}, {1, 0}); failNoUiEnable = true;
    assert(run(true, 1).success && frameIndex == 2 && enableCalls == 2);
    reset({0, 0}, {1, 0});
    assert(run(true, 1, "color", true).success && frameIndex == 2);
    for (const auto& mode : {"color", "gray", "bw"}) {
        reset({0}, {0});
        assert(run(false, 1, mode).success && frameIndex == 1);
    }
    reset({0}, {0}); pixelSubstitute = true;
    auto rejectedPixel = run(false, 1);
    assert(!rejectedPixel.success && rejectedPixel.pages.empty() && !sourceEnabled && frameIndex == 0 && disableCalls == 0);
    assert(rejectedPixel.errorMessage.find("色彩模式") != std::string::npos);
    reset({0}, {0}); pixelSetAccepted = false;
    assert(!run(false, 1).success && frameIndex == 0 && disableCalls == 0);
    reset({0}, {0}); pixelReadable = false;
    assert(!run(false, 1).success && frameIndex == 0 && disableCalls == 0);
    reset({0}, {0}); pixelSetAccepted = false; effectivePixelType = TWPT_RGB;
    assert(run(false, 1).success && frameIndex == 1); // Redundant SET rejected, verified current value matches.
    reset({0}, {0}); pixelChangesOnEnable = true;
    rejectedPixel = run(false, 1);
    assert(!rejectedPixel.success && rejectedPixel.pages.empty() && frameIndex == 0);
    assert(rejectedPixel.errorMessage.find("色彩模式") != std::string::npos && resetCalls == 1 && disableCalls == 1);
    reset({0, 0}, {1, 0}); pixelChangesAfterFirstFrame = true;
    rejectedPixel = run(false, 2);
    assert(!rejectedPixel.success && rejectedPixel.pages.size() == 1 && frameIndex == 1);
    assert(rejectedPixel.errorMessage.find("色彩模式") != std::string::npos && resetCalls == 1 && disableCalls == 1);
    // The last sheet is already past the tray sensor and needs 25 seconds before XFERREADY.
    reset({0, 25000}, {0, 0});
    auto result = run();
    assert(result.success && result.pages.size() == 2);
    assert(dispatchedMessages == 1); // Normal messages dispatch; DSM thread messages are consumed by the pump.
    assert(normalMessageOffers == 1 && defaultWindowMessages == 1); // The dispatched window message is offered once.
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
    // TWAIN 2.x 驱动用 ENDOFLJOB(=TWRC_ENDOFLIST) 告知「最后一张已给完」，属正常收尾：
    // 曾经被当作 ENDXFER 失败，于是整批报「ENDXFER failed」，现场表现为「只能扫描一张」还全部失败。
    reset({0, 0, 0}, {0, 0, 0}); endXferCodes = {TWRC_SUCCESS, TWRC_SUCCESS, TWRC_ENDOFLIST};
    result = run();
    assert(result.success && result.errorMessage.empty() && result.pages.size() == 3 && clockMs == 0);
    // 单张批次同理：收尾码不能把已经到手的一张判成失败，也不该再空等一个空闲超时
    reset({0}, {0}); endXferCodes = {TWRC_ENDOFLIST};
    result = run();
    assert(result.success && result.pages.size() == 1 && clockMs == 0);
    // 双面在第 1 张的背面后结束作业
    reset({0, 0}, {1, 0}); endXferCodes = {TWRC_SUCCESS, TWRC_ENDOFLIST};
    result = run(true, 2);
    assert(result.success && result.errorMessage.empty() && result.pages.size() == 2 && frameIndex == 2 && clockMs == 0);
    // 收尾路径上的 ENDOFLJOB 也不能谎报「会话未正常关闭」，且必须真的走到 DISABLEDS
    reset({0}, {0}); saveFails = true; endXferCodes = {TWRC_ENDOFLIST};
    result = run(false, 1);
    assert(!result.success && result.pages.empty() && resetCalls == 0 && disableCalls == 1);
    assert(result.errorMessage.find("Failed to capture") != std::string::npos
        && result.errorMessage.find("未正常关闭") == std::string::npos);
    // Flatbed / rejected ADF does not add an ADF continuation wait.
    reset({0, 1000}, {0, 0}); feederSetAccepted = false; feederReadSupported = false;
    assert(run().pages.size() == 1 && clockMs == 0);
    reset({0, 1000}, {0, 0}); feederEnabled = false;
    assert(run().pages.size() == 1 && clockMs == 0);
    // Unreadable GETCURRENT consistently falls back to a successful SET.
    reset({0, 1000}, {0, 0}); badFeederType = true;
    assert(run(false, 2).pages.size() == 2);
    reset({0, 1000}, {0, 0}); feederReadSupported = false;
    assert(run(false, 2).pages.size() == 2);
    reset({0, 1000}, {1, 0});
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
    std::puts("PASS production scan loop/WndProc: one DSM offer per queued message, synchronous/nested notifications preserved; duplex/pixel/DPI, State 5, end-of-job closing, cleanup and limits");
}
