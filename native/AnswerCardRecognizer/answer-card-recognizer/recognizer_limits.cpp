#include "recognizer_limits.hpp"

#include "common.hpp"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <map>
#include <stdexcept>
#include <string>

#ifdef _WIN32
#include <windows.h>
#endif

std::string describe_recognizer_limits_raw(const RecognizerLimits& limits);

namespace {

enum class LimitKey {
    max_image_bytes,
    max_image_pixels,
    max_layout_bytes,
    max_layout_items,
    max_layout_mm,
    min_dpi,
    max_dpi,
};

struct LimitDef {
    LimitKey key;
    const char* env;
    const char* unit;
    long long fallback;
    long long ceiling;
};

constexpr bool kIs64Bit = sizeof(void*) == 8;

// 32 位扫描端只有 2GB 用户地址空间，像素档位必须比 x64 低一个量级，否则不是「拒绝」而是「崩」。
// 默认值按真实工作流取：A4/A3 @600DPI（34.8 / 69.6 Mpx）在 x64 默认档内，
// A4 @1200DPI（139 Mpx）只有 x64 放宽后才跑得动——扫描端界面最高只给到 600DPI。
constexpr long long kDefaultMaxImagePixels = kIs64Bit ? 100000000LL : 40000000LL;
constexpr long long kCeilingMaxImagePixels = kIs64Bit ? 400000000LL : 70000000LL;

const LimitDef LIMIT_DEFS[] = {
    {LimitKey::max_image_bytes, "PROJECTX_RECOGNIZER_MAX_IMAGE_BYTES", "字节", 67108864LL, 536870912LL},
    {LimitKey::max_image_pixels, "PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS", "像素", kDefaultMaxImagePixels, kCeilingMaxImagePixels},
    {LimitKey::max_layout_bytes, "PROJECTX_RECOGNIZER_MAX_LAYOUT_BYTES", "字节", 8388608LL, 67108864LL},
    {LimitKey::max_layout_items, "PROJECTX_RECOGNIZER_MAX_LAYOUT_ITEMS", "项", 20000LL, 200000LL},
    {LimitKey::max_layout_mm, "PROJECTX_RECOGNIZER_MAX_LAYOUT_MM", "毫米", 1200LL, 5000LL},
    {LimitKey::min_dpi, "PROJECTX_RECOGNIZER_MIN_DPI", "DPI", 50LL, 300LL},
    {LimitKey::max_dpi, "PROJECTX_RECOGNIZER_MAX_DPI", "DPI", 1200LL, 2400LL},
};

void log_notice(const std::string& message) {
    std::fprintf(stderr, "[recognizer-limits] %s\n", message.c_str());
    std::fflush(stderr);
}

std::string trim(const std::string& value) {
    const auto begin = value.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) {
        return "";
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    return value.substr(begin, end - begin + 1);
}

bool read_env(const char* name, std::string& out) {
#ifdef _WIN32
    char buffer[64] = {0};
    size_t required = 0;
    if (getenv_s(&required, buffer, sizeof(buffer), name) != 0 || required <= 1) {
        return false;
    }
    out = trim(std::string(buffer));
#else
    const char* value = std::getenv(name);
    if (value == nullptr) {
        return false;
    }
    out = trim(std::string(value));
#endif
    return !out.empty();
}

bool parse_positive_long_long(const std::string& raw, long long& out) {
    errno = 0;
    char* end = nullptr;
    const long long value = std::strtoll(raw.c_str(), &end, 10);
    if (errno == ERANGE || end == raw.c_str() || end == nullptr || *end != '\0' || value <= 0) {
        return false;
    }
    out = value;
    return true;
}

RecognizerLimits resolve_limits() {
    std::map<LimitKey, long long> values;
    for (const auto& def : LIMIT_DEFS) {
        values[def.key] = def.fallback;

        std::string raw;
        if (!read_env(def.env, raw)) {
            continue;
        }
        long long parsed = 0;
        if (!parse_positive_long_long(raw, parsed)) {
            log_notice(std::string(def.env) + "=\"" + raw + "\" 不是正整数，按默认值 " + std::to_string(def.fallback) + " " + def.unit + " 处理");
            continue;
        }
        if (parsed > def.ceiling) {
            values[def.key] = def.ceiling;
            log_notice(std::string(def.env) + "=\"" + raw + "\" 超过安全天花板 " + std::to_string(def.ceiling) + " " + def.unit + "，已按天花板夹紧");
            continue;
        }
        values[def.key] = parsed;
        log_notice(std::string(def.env) + " 覆盖为 " + std::to_string(parsed) + " " + def.unit + "（默认 " + std::to_string(def.fallback) + "，天花板 " + std::to_string(def.ceiling) + "）");
    }

    RecognizerLimits limits;
    limits.max_image_bytes = values[LimitKey::max_image_bytes];
    limits.max_image_pixels = values[LimitKey::max_image_pixels];
    limits.max_layout_bytes = values[LimitKey::max_layout_bytes];
    limits.max_layout_items = values[LimitKey::max_layout_items];
    limits.max_layout_mm = values[LimitKey::max_layout_mm];
    limits.min_dpi = static_cast<int>(values[LimitKey::min_dpi]);
    limits.max_dpi = static_cast<int>(values[LimitKey::max_dpi]);
    // 下限被调到上限之上会让每一次识别都失败，按上限回落并留痕
    if (limits.min_dpi > limits.max_dpi) {
        log_notice("min_dpi=" + std::to_string(limits.min_dpi) + " 大于 max_dpi=" + std::to_string(limits.max_dpi) + "，已按 max_dpi 回落");
        limits.min_dpi = limits.max_dpi;
    }
    return limits;
}

}  // namespace

const RecognizerLimits& recognizer_limits() {
    static const RecognizerLimits limits = [] {
        RecognizerLimits resolved = resolve_limits();
        log_notice("生效档位（" + std::string(kIs64Bit ? "x64" : "ia32") + "）：" + describe_recognizer_limits_raw(resolved));
        return resolved;
    }();
    return limits;
}

const std::vector<std::string>& recognizer_limit_env_vars() {
    static const std::vector<std::string> names = [] {
        std::vector<std::string> result;
        result.reserve(std::size(LIMIT_DEFS));
        for (const auto& def : LIMIT_DEFS) {
            result.emplace_back(def.env);
        }
        return result;
    }();
    return names;
}

std::string describe_recognizer_limits_raw(const RecognizerLimits& limits) {
    return "图片 ≤" + std::to_string(limits.max_image_bytes) + " 字节 / ≤" + std::to_string(limits.max_image_pixels) + " 像素"
        + " | 布局 ≤" + std::to_string(limits.max_layout_bytes) + " 字节 / 数组 ≤" + std::to_string(limits.max_layout_items) + " 项 / 尺寸 ≤" + std::to_string(limits.max_layout_mm) + " 毫米"
        + " | DPI ∈ [" + std::to_string(limits.min_dpi) + ", " + std::to_string(limits.max_dpi) + "]";
}

std::string describe_recognizer_limits() {
    return describe_recognizer_limits_raw(recognizer_limits());
}

std::vector<unsigned char> read_capped_file(const std::filesystem::path& path, long long max_bytes, const std::string& what) {
    std::error_code ec;
    if (!std::filesystem::exists(path, ec) || ec) {
        throw std::runtime_error(what + "不存在: " + path_to_utf8(path));
    }
    const auto file_size = std::filesystem::file_size(path, ec);
    if (ec) {
        throw std::runtime_error("无法读取" + what + "大小: " + path_to_utf8(path));
    }
    if (static_cast<long long>(file_size) > max_bytes) {
        throw std::runtime_error(what + " " + std::to_string(file_size) + " 字节超过识别器上限 " + std::to_string(max_bytes)
            + " 字节（安全 R19：解码前就要挡住超大文件，否则原生进程会先分配几百 MB 再失败；上限可用 "
            + (what.find("布局") != std::string::npos ? "PROJECTX_RECOGNIZER_MAX_LAYOUT_BYTES" : "PROJECTX_RECOGNIZER_MAX_IMAGE_BYTES")
            + " 在天花板内调整）");
    }
    if (file_size == 0) {
        throw std::runtime_error(what + "是空文件: " + path_to_utf8(path));
    }

    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("无法打开" + what + ": " + path_to_utf8(path));
    }
    std::vector<unsigned char> buffer(static_cast<size_t>(file_size));
    input.read(reinterpret_cast<char*>(buffer.data()), static_cast<std::streamsize>(file_size));
    const auto got = input.gcount();
    if (got <= 0) {
        throw std::runtime_error("无法读取" + what + ": " + path_to_utf8(path));
    }
    buffer.resize(static_cast<size_t>(got));
    return buffer;
}

void assert_pixel_budget(long long pixels, const std::string& what) {
    const auto& limits = recognizer_limits();
    if (pixels > limits.max_image_pixels) {
        throw std::runtime_error(what + " 需要 " + std::to_string(pixels) + " 像素，超过识别器上限 " + std::to_string(limits.max_image_pixels)
            + " 像素（安全 R19：像素数直接决定 OpenCV 要分配多少内存；上限可用 PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS 在 "
            + std::to_string(kCeilingMaxImagePixels) + " 像素内调整）");
    }
}

void assert_recognizer_dpi(int dpi) {
    const auto& limits = recognizer_limits();
    if (dpi < limits.min_dpi || dpi > limits.max_dpi) {
        throw std::runtime_error("DPI " + std::to_string(dpi) + " 超出识别器允许范围 [" + std::to_string(limits.min_dpi) + ", " + std::to_string(limits.max_dpi)
            + "]（安全 R19：DPI 参与 mm→px 换算，越界会让原生进程按天文数字分配内存；范围可用 PROJECTX_RECOGNIZER_MIN_DPI / PROJECTX_RECOGNIZER_MAX_DPI 调整）");
    }
}
