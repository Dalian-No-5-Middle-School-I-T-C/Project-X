#include "layout_io.hpp"

#include "common.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <stdexcept>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

const std::vector<std::string> REQUIRED_MARKER_ROLES = {
    "top-left",
    "top-right",
    "middle-left",
    "middle-right",
    "bottom-left",
    "bottom-right",
};

std::pair<double, double> Rect::center() const {
    return {x + width / 2.0, y + height / 2.0};
}

std::pair<double, double> LayoutMarker::center_mm() const {
    return rect.center();
}

static Rect rect_from_json(const json& value) {
    if (!value.is_object()) {
        throw std::runtime_error("Rect must be an object");
    }
    for (const auto* key : {"x", "y", "width", "height"}) {
        if (!value.contains(key)) {
            throw std::runtime_error(std::string("Rect missing field: ") + key);
        }
    }
    return Rect{
        value.at("x").get<double>(),
        value.at("y").get<double>(),
        value.at("width").get<double>(),
        value.at("height").get<double>(),
    };
}

static std::vector<ObjectiveOption> objective_options_from_page(const json& page_data) {
    std::vector<ObjectiveOption> options;

    if (page_data.contains("blocks") && page_data.at("blocks").is_array()) {
        for (const auto& block : page_data.at("blocks")) {
            if (!block.is_object() || block.value("type", "") != "objective") {
                continue;
            }
            const std::string block_id = block.value("blockId", "");
            if (!block.contains("items") || !block.at("items").is_array()) {
                continue;
            }
            for (const auto& item : block.at("items")) {
                if (!item.is_object()) {
                    continue;
                }
                const int question_number = item.value("questionNumber", 0);
                if (question_number <= 0 || !item.contains("options") || !item.at("options").is_array()) {
                    continue;
                }
                for (const auto& option : item.at("options")) {
                    if (!option.is_object()) {
                        continue;
                    }
                    const std::string label = option.value("label", "");
                    if (label.empty() || !option.contains("rect") || !option.at("rect").is_object()) {
                        continue;
                    }
                    options.push_back(ObjectiveOption{block_id, question_number, label, rect_from_json(option.at("rect"))});
                }
            }
        }
    }

    if (!options.empty()) {
        std::sort(options.begin(), options.end(), [](const auto& left, const auto& right) {
            return std::tie(left.question_number, left.label) < std::tie(right.question_number, right.label);
        });
        return options;
    }

    if (page_data.contains("elements") && page_data.at("elements").is_array()) {
        for (const auto& element : page_data.at("elements")) {
            if (!element.is_object() || element.value("type", "") != "objective_option") {
                continue;
            }
            const std::string label = element.value("option", "");
            const int question_number = element.value("questionNumber", 0);
            if (label.empty() || question_number <= 0 || !element.contains("rect") || !element.at("rect").is_object()) {
                continue;
            }
            options.push_back(ObjectiveOption{
                element.value("blockId", ""),
                question_number,
                label,
                rect_from_json(element.at("rect")),
            });
        }
    }

    std::sort(options.begin(), options.end(), [](const auto& left, const auto& right) {
        return std::tie(left.question_number, left.label) < std::tie(right.question_number, right.label);
    });
    return options;
}

static std::vector<StudentDigit> student_digits_from_page(const json& page_data) {
    std::vector<StudentDigit> digits;
    if (!page_data.contains("elements") || !page_data.at("elements").is_array()) {
        return digits;
    }

    for (const auto& element : page_data.at("elements")) {
        if (!element.is_object() || element.value("type", "") != "student_digit") {
            continue;
        }
        if (!element.contains("rect") || !element.at("rect").is_object()) {
            continue;
        }
        digits.push_back(StudentDigit{
            element.value("digitIndex", 0),
            element.value("digit", 0),
            rect_from_json(element.at("rect")),
        });
    }

    std::sort(digits.begin(), digits.end(), [](const auto& left, const auto& right) {
        return std::tie(left.digit_index, left.digit) < std::tie(right.digit_index, right.digit);
    });
    return digits;
}

LayoutPage load_layout_page(const std::filesystem::path& layout_path, int page_number) {
    if (!std::filesystem::exists(layout_path)) {
        throw std::runtime_error("Layout JSON not found: " + path_to_utf8(layout_path));
    }

    std::ifstream input(layout_path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("Failed to open layout JSON: " + path_to_utf8(layout_path));
    }

    json layout;
    input >> layout;

    const std::string card_id = layout.value("cardId", "");
    if (card_id.empty()) {
        throw std::runtime_error("Layout JSON has no cardId: " + path_to_utf8(layout_path));
    }

    if (!layout.contains("pages") || !layout.at("pages").is_array()) {
        throw std::runtime_error("Layout JSON pages must be a list: " + path_to_utf8(layout_path));
    }

    const json* page_data = nullptr;
    for (const auto& page : layout.at("pages")) {
        if (page.is_object() && page.value("pageNumber", -1) == page_number) {
            page_data = &page;
            break;
        }
    }
    if (!page_data) {
        throw std::runtime_error("Page " + std::to_string(page_number) + " not found in layout JSON: " + path_to_utf8(layout_path));
    }
    if (!page_data->contains("markers") || !page_data->at("markers").is_array()) {
        throw std::runtime_error("Page " + std::to_string(page_number) + " has no marker list: " + path_to_utf8(layout_path));
    }

    std::map<std::string, LayoutMarker> markers;
    for (const auto& marker : page_data->at("markers")) {
        if (!marker.is_object()) {
            continue;
        }
        const std::string role = marker.value("role", "");
        if (role.empty() || !marker.contains("rect")) {
            continue;
        }
        markers[role] = LayoutMarker{role, rect_from_json(marker.at("rect"))};
    }

    std::vector<std::string> missing;
    for (const auto& role : REQUIRED_MARKER_ROLES) {
        if (!markers.contains(role)) {
            missing.push_back(role);
        }
    }
    if (!missing.empty()) {
        std::string message = "Page " + std::to_string(page_number) + " is missing markers: ";
        for (size_t index = 0; index < missing.size(); ++index) {
            if (index > 0) {
                message += ", ";
            }
            message += missing[index];
        }
        throw std::runtime_error(message);
    }

    std::map<std::string, LayoutMarker> required_markers;
    for (const auto& role : REQUIRED_MARKER_ROLES) {
        required_markers[role] = markers.at(role);
    }

    return LayoutPage{
        card_id,
        page_number,
        page_data->value("width", layout.value("width", 210.0)),
        page_data->value("height", layout.value("height", 297.0)),
        required_markers,
        objective_options_from_page(*page_data),
        student_digits_from_page(*page_data),
    };
}

std::pair<int, int> a4_pixel_size(double width_mm, double height_mm, int dpi) {
    if (dpi <= 0) {
        throw std::runtime_error("DPI must be positive");
    }
    return {
        static_cast<int>(std::llround(width_mm / 25.4 * dpi)),
        static_cast<int>(std::llround(height_mm / 25.4 * dpi)),
    };
}

std::map<std::string, std::pair<double, double>> marker_centers_px(const LayoutPage& page, int dpi) {
    const double scale = static_cast<double>(dpi) / 25.4;
    std::map<std::string, std::pair<double, double>> centers;
    for (const auto& [role, marker] : page.markers) {
        const auto [x, y] = marker.center_mm();
        centers[role] = {x * scale, y * scale};
    }
    return centers;
}
