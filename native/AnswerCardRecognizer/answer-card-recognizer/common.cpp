#include "common.hpp"

#include <cmath>

#ifdef _WIN32
#include <windows.h>
#endif

std::string wide_to_utf8(const std::wstring& value) {
#ifdef _WIN32
    if (value.empty()) {
        return "";
    }
    const int size = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
#else
    return std::string(value.begin(), value.end());
#endif
}

std::string path_to_utf8(const std::filesystem::path& path) {
#ifdef _WIN32
    return wide_to_utf8(path.wstring());
#else
    const auto value = path.u8string();
    return std::string(value.begin(), value.end());
#endif
}

double round_to(double value, int digits) {
    const double scale = std::pow(10.0, digits);
    return std::round(value * scale) / scale;
}

