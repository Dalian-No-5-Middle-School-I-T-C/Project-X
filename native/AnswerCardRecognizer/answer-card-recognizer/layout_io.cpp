#include "layout_io.hpp"

#include "common.hpp"
#include "recognizer_limits.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <string>

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

namespace {

/**
 * 安全 R19：布局里的数组长度由文件自己声明，不设上限就等于把「解析 + 后续按项分配」交给输入方控制。
 * 一份十万项的 items/options 列表足以让识别进程在采样阶段耗光内存。
 */
void assert_array_size(const json& value, const std::string& what) {
    if (!value.is_array()) {
        return;
    }
    const long long limit = recognizer_limits().max_layout_items;
    if (static_cast<long long>(value.size()) > limit) {
        throw std::runtime_error(what + " 有 " + std::to_string(value.size()) + " 项，超过识别器上限 " + std::to_string(limit)
            + " 项（安全 R19：布局数组长度必须设界；可用 PROJECTX_RECOGNIZER_MAX_LAYOUT_ITEMS 在天花板内调整）");
    }
}

/** 安全 R19：mm 数值必须是有限正数且不超档位，否则 mm→px 换算会溢出成负尺寸。 */
void assert_layout_mm(double value, const std::string& what) {
    const long long limit = recognizer_limits().max_layout_mm;
    if (!std::isfinite(value) || value <= 0 || value > static_cast<double>(limit)) {
        throw std::runtime_error(what + " = " + std::to_string(value) + " 毫米不是 (0, " + std::to_string(limit)
            + "] 内的有限数（安全 R19：布局尺寸参与像素分配换算；可用 PROJECTX_RECOGNIZER_MAX_LAYOUT_MM 在天花板内调整）");
    }
}

}  // namespace

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
    const double limit_mm = static_cast<double>(recognizer_limits().max_layout_mm);
    auto finite_mm = [&](const char* key) {
        if (!value.at(key).is_number()) {
            throw std::runtime_error(std::string("Rect field is not a number: ") + key);
        }
        const double number = value.at(key).get<double>();
        if (!std::isfinite(number) || std::fabs(number) > limit_mm) {
            throw std::runtime_error(std::string("Rect field ") + key + " = " + std::to_string(number)
                + " 超出 ±" + std::to_string(recognizer_limits().max_layout_mm) + " 毫米（安全 R19：非有限或越界的坐标会让 mm→px 换算溢出）");
        }
        return number;
    };
    Rect rect{finite_mm("x"), finite_mm("y"), finite_mm("width"), finite_mm("height")};
    if (rect.width < 0 || rect.height < 0) {
        throw std::runtime_error("Rect width/height must not be negative（安全 R19）");
    }
    return rect;
}


static std::string question_number_from_json(const json& value) {
    if (value.is_string()) {
        return value.get<std::string>();
    }
    if (value.is_number_integer()) {
        return std::to_string(value.get<int>());
    }
    if (value.is_number_float()) {
        return std::to_string(value.get<double>());
    }
    return "";
}

static std::vector<ObjectiveOption> objective_options_from_page(const json& page_data) {
    std::vector<ObjectiveOption> options;

    if (page_data.contains("blocks") && page_data.at("blocks").is_array()) {
        assert_array_size(page_data.at("blocks"), "布局 blocks");
        for (const auto& block : page_data.at("blocks")) {
            if (!block.is_object() || block.value("type", "") != "objective") {
                continue;
            }
            const std::string block_id = block.value("blockId", "");
            if (!block.contains("items") || !block.at("items").is_array()) {
                continue;
            }
            assert_array_size(block.at("items"), "客观题大题 items");
            for (const auto& item : block.at("items")) {
                if (!item.is_object()) {
                    continue;
                }
                const int question_number = item.value("questionNumber", 0);
                if (question_number <= 0 || !item.contains("options") || !item.at("options").is_array()) {
                    continue;
                }
                assert_array_size(item.at("options"), "客观题选项 options");
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
        assert_array_size(page_data.at("elements"), "布局 elements");
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

static std::vector<SubjectiveScoreCell> subjective_score_cells_from_page(const json& page_data) {
    std::vector<SubjectiveScoreCell> cells;

    if (page_data.contains("blocks") && page_data.at("blocks").is_array()) {
        assert_array_size(page_data.at("blocks"), "布局 blocks");
        for (const auto& block : page_data.at("blocks")) {
            if (!block.is_object() || block.value("type", "") != "subjective") {
                continue;
            }
            const std::string block_id = block.value("blockId", "");
            if (!block.contains("questions") || !block.at("questions").is_array()) {
                continue;
            }
            assert_array_size(block.at("questions"), "主观题大题 questions");
            for (const auto& question : block.at("questions")) {
                if (!question.is_object() || !question.contains("scoreCells") || !question.at("scoreCells").is_array()) {
                    continue;
                }
                assert_array_size(question.at("scoreCells"), "主观题分数格 scoreCells");
                const std::string question_id = question.value("questionId", "");
                const std::string question_number = question.contains("questionNumber") ? question_number_from_json(question.at("questionNumber")) : "";
                const double max_score = question.value("score", 0.0);
                for (const auto& cell : question.at("scoreCells")) {
                    if (!cell.is_object() || !cell.contains("rect") || !cell.at("rect").is_object()) {
                        continue;
                    }
                    cells.push_back(SubjectiveScoreCell{
                        block_id,
                        question_id,
                        question_number,
                        cell.value("score", 0.0),
                        max_score,
                        rect_from_json(cell.at("rect")),
                    });
                }
            }
        }
    }

    if (!cells.empty()) {
        std::sort(cells.begin(), cells.end(), [](const auto& left, const auto& right) {
            return std::tie(left.block_id, left.question_id, left.score) < std::tie(right.block_id, right.question_id, right.score);
        });
        return cells;
    }

    if (page_data.contains("elements") && page_data.at("elements").is_array()) {
        assert_array_size(page_data.at("elements"), "布局 elements");
        for (const auto& element : page_data.at("elements")) {
            if (!element.is_object() || element.value("type", "") != "score_cell") {
                continue;
            }
            if (!element.contains("rect") || !element.at("rect").is_object()) {
                continue;
            }
            cells.push_back(SubjectiveScoreCell{
                element.value("blockId", ""),
                element.value("questionId", ""),
                element.contains("questionNumber") ? question_number_from_json(element.at("questionNumber")) : "",
                element.value("score", 0.0),
                0.0,
                rect_from_json(element.at("rect")),
            });
        }
    }

    std::sort(cells.begin(), cells.end(), [](const auto& left, const auto& right) {
        return std::tie(left.block_id, left.question_id, left.score) < std::tie(right.block_id, right.question_id, right.score);
    });
    return cells;
}

static std::vector<StudentDigit> student_digits_from_page(const json& page_data) {
    std::vector<StudentDigit> digits;
    if (!page_data.contains("elements") || !page_data.at("elements").is_array()) {
        return digits;
    }
    assert_array_size(page_data.at("elements"), "布局 elements");

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

static std::vector<LayoutBlockCrop> block_crops_from_page(const json& page_data) {
    std::vector<LayoutBlockCrop> crops;
    if (!page_data.contains("blocks") || !page_data.at("blocks").is_array()) {
        return crops;
    }
    assert_array_size(page_data.at("blocks"), "布局 blocks");

    for (const auto& block : page_data.at("blocks")) {
        if (!block.is_object()) {
            continue;
        }
        const std::string block_id = block.value("blockId", "");
        const std::string block_type = block.value("type", "");
        if (block_id.empty() || block_type.empty()) {
            continue;
        }

        std::vector<std::string> question_numbers;
        if (block_type == "objective" && block.contains("items") && block.at("items").is_array()) {
            for (const auto& item : block.at("items")) {
                if (!item.is_object() || !item.contains("questionNumber")) {
                    continue;
                }
                const std::string number = question_number_from_json(item.at("questionNumber"));
                if (!number.empty()) {
                    question_numbers.push_back(number);
                }
            }
        } else if (block_type == "subjective" && block.contains("questions") && block.at("questions").is_array()) {
            for (const auto& question : block.at("questions")) {
                if (!question.is_object() || !question.contains("questionNumber")) {
                    continue;
                }
                const std::string number = question_number_from_json(question.at("questionNumber"));
                if (!number.empty()) {
                    question_numbers.push_back(number);
                }
            }
        }

        if (question_numbers.empty()) {
            continue;
        }
        const json* rect_value = nullptr;
        if (block.contains("frameRect") && block.at("frameRect").is_object()) {
            rect_value = &block.at("frameRect");
        } else if (block.contains("rect") && block.at("rect").is_object()) {
            rect_value = &block.at("rect");
        }
        if (!rect_value) {
            continue;
        }

        std::sort(question_numbers.begin(), question_numbers.end());
        question_numbers.erase(std::unique(question_numbers.begin(), question_numbers.end()), question_numbers.end());
        crops.push_back(LayoutBlockCrop{
            block_id,
            block.value("title", ""),
            block_type,
            rect_from_json(*rect_value),
            question_numbers,
        });
    }

    return crops;
}

LayoutPage load_layout_page(const std::filesystem::path& layout_path, int page_number) {
    // 安全 R19：布局 JSON 也是外部输入，先按字节上限读入再解析，别让 nlohmann 在几十 MB 的文本上建 DOM
    const std::vector<unsigned char> raw = read_capped_file(layout_path, recognizer_limits().max_layout_bytes, "布局 JSON");

    json layout = json::parse(std::string(reinterpret_cast<const char*>(raw.data()), raw.size()));

    const std::string card_id = layout.value("cardId", "");
    if (card_id.empty()) {
        throw std::runtime_error("Layout JSON has no cardId: " + path_to_utf8(layout_path));
    }

    if (!layout.contains("pages") || !layout.at("pages").is_array()) {
        throw std::runtime_error("Layout JSON pages must be a list: " + path_to_utf8(layout_path));
    }
    assert_array_size(layout.at("pages"), "布局 pages");

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
    assert_array_size(page_data->at("markers"), "定位标记 markers");

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

    // 安全 R19：页宽高直接决定「mm×DPI」要分配多少像素，必须在进 OpenCV 之前收口
    const double width_mm = page_data->value("width", layout.value("width", 210.0));
    const double height_mm = page_data->value("height", layout.value("height", 297.0));
    assert_layout_mm(width_mm, "布局页宽");
    assert_layout_mm(height_mm, "布局页高");

    return LayoutPage{
        card_id,
        page_number,
        width_mm,
        height_mm,
        required_markers,
        objective_options_from_page(*page_data),
        student_digits_from_page(*page_data),
        subjective_score_cells_from_page(*page_data),
        block_crops_from_page(*page_data),
        page_data->contains("header") && page_data->at("header").contains("qrCode")
            ? rect_from_json(page_data->at("header").at("qrCode").at("rect")) : Rect{58, 12, 18, 18},
    };
}

std::pair<int, int> layout_pixel_size(double width_mm, double height_mm, int dpi) {
    // 安全 R19：DPI 与 mm 都来自外部输入，两者相乘再转 int 时任何一端越界都会得到负尺寸或溢出，
    // 交给 cv::warpPerspective 就是不可控行为；这里先把三个维度（DPI 档位、mm 档位、像素预算）都校一遍。
    assert_recognizer_dpi(dpi);
    assert_layout_mm(width_mm, "布局页宽");
    assert_layout_mm(height_mm, "布局页高");

    const double max_side = static_cast<double>(std::numeric_limits<int>::max());
    for (const auto& [name, mm] : {std::pair<const char*, double>{"宽", width_mm}, {"高", height_mm}}) {
        if (!(mm / 25.4 * dpi < max_side)) {
            throw std::runtime_error(std::string("布局页") + name + " " + std::to_string(mm) + " 毫米在 " + std::to_string(dpi)
                + " DPI 下超过 " + std::to_string(std::numeric_limits<int>::max()) + " 像素，无法安全换算（安全 R19）");
        }
    }

    // 保持与历史实现一致的运算次序（mm / 25.4 * dpi），避免边界上四舍五入差一个像素
    const long long width_px = std::llround(width_mm / 25.4 * dpi);
    const long long height_px = std::llround(height_mm / 25.4 * dpi);
    assert_pixel_budget(width_px * height_px,
        "按 " + std::to_string(dpi) + " DPI 还原的整页布局 " + std::to_string(width_px) + "×" + std::to_string(height_px) + " 尺寸");
    return {static_cast<int>(width_px), static_cast<int>(height_px)};
}

std::map<std::string, std::pair<double, double>> marker_centers_px(const LayoutPage& page, int dpi) {
    assert_recognizer_dpi(dpi);
    const double scale = static_cast<double>(dpi) / 25.4;
    std::map<std::string, std::pair<double, double>> centers;
    for (const auto& [role, marker] : page.markers) {
        const auto [x, y] = marker.center_mm();
        centers[role] = {x * scale, y * scale};
    }
    return centers;
}
