#pragma once
#include <opencv2/objdetect.hpp>
#include <opencv2/imgproc.hpp>
#include <nlohmann/json.hpp>
#include <set>
#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <optional>
#include "layout_io.hpp"

struct CardIdentityCheck {
    nlohmann::json identity;
    std::optional<cv::Point2f> center;
};

inline std::string decode_card_id(const std::string& text) {
    std::string result;
    for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] != '%') { result += text[i]; continue; }
        if (i + 2 >= text.size() || !std::isxdigit(static_cast<unsigned char>(text[i + 1])) ||
            !std::isxdigit(static_cast<unsigned char>(text[i + 2]))) throw std::runtime_error("Invalid encoded card ID");
        result += static_cast<char>(std::stoi(text.substr(i + 1, 2), nullptr, 16));
        i += 2;
    }
    if (result.empty()) throw std::runtime_error("Empty card ID");
    return result;
}

inline CardIdentityCheck check_card_identity(const cv::Mat& image, const LayoutPage& page, bool legacy) {
    using json = nlohmann::json;
    CardIdentityCheck result{json{{"status", "rejected"}, {"code", "QR_MISSING"}}, {}};
    std::set<std::string> payloads;
    bool detected = false;
    // Try both a bounded overview and original resolution: preserve small printed modules.
    const double overview = std::min(1.0, 1800.0 / std::max(image.cols, image.rows));
    for (const double scale : {overview, 1.0}) {
        cv::Mat input;
        if (scale < 1) cv::resize(image, input, {}, scale, scale, cv::INTER_AREA);
        else input = image;
        for (const int rotation : {0, 90, 180, 270}) {
            cv::Mat candidate;
            if (rotation == 90) cv::rotate(input, candidate, cv::ROTATE_90_CLOCKWISE);
            else if (rotation == 180) cv::rotate(input, candidate, cv::ROTATE_180);
            else if (rotation == 270) cv::rotate(input, candidate, cv::ROTATE_90_COUNTERCLOCKWISE);
            else candidate = input;
            cv::QRCodeDetector detector;
            std::vector<std::string> values;
            cv::Mat points;
            detector.detectAndDecodeMulti(candidate, values, points);
            detected = detected || !points.empty();
            cv::Point2f offset{};
            if (std::none_of(values.begin(), values.end(), [](const auto& value) { return !value.empty(); })) {
                // A large sheet can hide a small symbol from the multi-code detector.
                // Retry the expected header with extra margin for skew/crop displacement.
                const double sx = candidate.cols / page.width_mm, sy = candidate.rows / page.height_mm;
                const cv::Rect area(
                    static_cast<int>(std::max(0.0, page.qr_rect.x - 10) * sx),
                    static_cast<int>(std::max(0.0, page.qr_rect.y - 10) * sy),
                    static_cast<int>((page.qr_rect.width + 20) * sx),
                    static_cast<int>((page.qr_rect.height + 20) * sy));
                const auto clipped = area & cv::Rect(0, 0, candidate.cols, candidate.rows);
                if (clipped.width > 0 && clipped.height > 0) {
                    cv::Mat local_points;
                    const auto value = detector.detectAndDecode(candidate(clipped), local_points);
                    detected = detected || !local_points.empty();
                    if (!value.empty()) {
                        values = {value}; points = local_points;
                        offset = cv::Point2f(static_cast<float>(clipped.x), static_cast<float>(clipped.y));
                    }
                }
            }
            if (!points.empty()) {
                const auto* corners = points.ptr<cv::Point2f>();
                for (size_t i = 0; i < values.size(); ++i) {
                    if (values[i].empty()) continue;
                    payloads.insert(values[i]);
                    cv::Point2f center{};
                    for (int j = 0; j < 4; ++j) center += corners[i * 4 + j];
                    center = center * 0.25f + offset;
                    if (rotation == 90) center = {center.y, input.rows - 1.0f - center.x};
                    else if (rotation == 180) center = {input.cols - 1.0f - center.x, input.rows - 1.0f - center.y};
                    else if (rotation == 270) center = {input.cols - 1.0f - center.y, center.x};
                    result.center = center * static_cast<float>(1.0 / scale);
                }
            }
            if (!payloads.empty()) break;
        }
        if (scale == 1.0) break;
    }
    if (payloads.empty()) {
        result.identity["code"] = detected ? "QR_UNREADABLE" : "QR_MISSING";
        if (legacy) result.identity["status"] = "unverified";
        return result;
    }
    if (payloads.size() != 1) {
        result.identity["code"] = "QR_CONFLICT";
        return result;
    }
    const auto& payload = *payloads.begin();
    result.identity["code"] = "QR_INVALID";
    if (payload.rfind("PXAC:1:", 0) != 0) return result;
    const auto split = payload.find(':', 7);
    if (split == std::string::npos) return result;
    try {
        const auto id = decode_card_id(payload.substr(7, split - 7));
        const auto number = payload.substr(split + 1);
        if (number.empty() || number[0] == '0' || number.find_first_not_of("0123456789") != std::string::npos) return result;
        const int page_number = std::stoi(number);
        result.identity["cardId"] = id;
        result.identity["pageNumber"] = page_number;
        if (id != page.card_id) result.identity["code"] = "CARD_MISMATCH";
        else if (page_number != page.page_number) result.identity["code"] = "PAGE_MISMATCH";
        else { result.identity["status"] = "verified"; result.identity["code"] = "QR_VERIFIED"; }
    } catch (const std::exception&) { }
    return result;
}
