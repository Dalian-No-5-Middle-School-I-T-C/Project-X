#include "answer_recognition.hpp"

#include "common.hpp"
#include "layout_io.hpp"
#include "vision_utils.hpp"

#include <algorithm>
#include <fstream>
#include <map>
#include <numeric>
#include <optional>
#include <stdexcept>

using json = nlohmann::json;

namespace {
constexpr double MIN_SELECTED_FILL_RATIO = 0.32;
constexpr double MIN_SELECTED_OVER_BACKGROUND = 0.10;
constexpr double MAX_DYNAMIC_SELECTION_THRESHOLD = 0.75;
constexpr double MIN_LEAD_GAP = 0.06;
constexpr double OPTION_INNER_MARGIN_RATIO = 0.18;

json rect_to_json(const Rect& rect) {
    return {
        {"x", round_to(rect.x, 3)},
        {"y", round_to(rect.y, 3)},
        {"width", round_to(rect.width, 3)},
        {"height", round_to(rect.height, 3)},
    };
}

std::tuple<int, int, int, int> rect_to_bounds(const Rect& rect, int dpi, int image_width, int image_height, double margin_ratio) {
    const double scale = static_cast<double>(dpi) / 25.4;
    double x1 = rect.x * scale;
    double y1 = rect.y * scale;
    double x2 = (rect.x + rect.width) * scale;
    double y2 = (rect.y + rect.height) * scale;

    const double inset_x = std::max(1.0, (x2 - x1) * margin_ratio);
    const double inset_y = std::max(1.0, (y2 - y1) * margin_ratio);
    x1 += inset_x;
    y1 += inset_y;
    x2 -= inset_x;
    y2 -= inset_y;

    const int left = std::max(0, std::min(image_width - 1, static_cast<int>(std::llround(x1))));
    const int top = std::max(0, std::min(image_height - 1, static_cast<int>(std::llround(y1))));
    const int right = std::max(left + 1, std::min(image_width, static_cast<int>(std::llround(x2))));
    const int bottom = std::max(top + 1, std::min(image_height, static_cast<int>(std::llround(y2))));
    return {left, top, right, bottom};
}

double count_less_than_ratio(const cv::Mat& roi, double threshold) {
    cv::Mat mask;
    cv::compare(roi, threshold, mask, cv::CMP_LT);
    return static_cast<double>(cv::countNonZero(mask)) / static_cast<double>(roi.total());
}

json sample_rect(const cv::Mat& warped, const Rect& rect, int dpi, double margin_ratio) {
    cv::Mat gray;
    if (warped.channels() == 3) {
        cv::cvtColor(warped, gray, cv::COLOR_BGR2GRAY);
    } else {
        gray = warped;
    }

    const auto [left, top, right, bottom] = rect_to_bounds(rect, dpi, gray.cols, gray.rows, margin_ratio);
    const cv::Mat roi = gray(cv::Rect(left, top, right - left, bottom - top));

    double fill_ratio = 0.0;
    double dark_ratio = 0.0;
    double mean_gray = 255.0;
    double threshold = 180.0;

    if (!roi.empty()) {
        cv::Scalar mean;
        cv::Scalar stddev;
        cv::meanStdDev(roi, mean, stddev);
        mean_gray = mean[0];
        if (stddev[0] >= 4.0) {
            cv::Mat binary;
            const double otsu_threshold = cv::threshold(roi, binary, 0, 255, cv::THRESH_BINARY_INV | cv::THRESH_OTSU);
            threshold = std::min(190.0, std::max(95.0, otsu_threshold));
        }
        fill_ratio = count_less_than_ratio(roi, threshold);
        dark_ratio = count_less_than_ratio(roi, 180.0);
    }

    return {
        {"fillRatio", round_to(fill_ratio, 4)},
        {"darkRatio", round_to(dark_ratio, 4)},
        {"meanGray", round_to(mean_gray, 2)},
        {"threshold", round_to(threshold, 2)},
        {"rect", rect_to_json(rect)},
        {"sampleBounds", {{"left", left}, {"top", top}, {"right", right}, {"bottom", bottom}}},
    };
}

json sample_option(const cv::Mat& warped, const ObjectiveOption& option, int dpi) {
    json result = sample_rect(warped, option.rect, dpi, OPTION_INNER_MARGIN_RATIO);
    result["label"] = option.label;
    return result;
}

json sample_student_digit(const cv::Mat& warped, const StudentDigit& digit, int dpi) {
    json result = sample_rect(warped, digit.rect, dpi, OPTION_INNER_MARGIN_RATIO);
    result["digit"] = digit.digit;
    return result;
}

std::tuple<std::vector<std::string>, double, json> selected_options(const std::vector<json>& options) {
    if (options.empty()) {
        return {{}, 0.0, json::object()};
    }

    std::map<std::string, double> scores;
    for (const auto& option : options) {
        scores[option.at("label").get<std::string>()] = option.at("fillRatio").get<double>();
    }

    std::vector<std::pair<std::string, double>> ordered(scores.begin(), scores.end());
    std::sort(ordered.begin(), ordered.end(), [](const auto& left, const auto& right) {
        return left.second > right.second;
    });
    const double top_score = ordered.front().second;
    const double second_score = ordered.size() > 1 ? ordered[1].second : 0.0;

    std::vector<double> score_values;
    for (const auto& [_, score] : scores) {
        score_values.push_back(score);
    }
    std::sort(score_values.begin(), score_values.end());
    const size_t low_count = std::max<size_t>(1, score_values.size() / 2);
    const double background = std::accumulate(score_values.begin(), score_values.begin() + static_cast<std::ptrdiff_t>(low_count), 0.0) / static_cast<double>(low_count);
    const double threshold = std::max(MIN_SELECTED_FILL_RATIO, std::min(background + MIN_SELECTED_OVER_BACKGROUND, MAX_DYNAMIC_SELECTION_THRESHOLD));

    std::vector<std::string> selected;
    for (const auto& [label, score] : scores) {
        if (score >= threshold) {
            selected.push_back(label);
        }
    }
    if (top_score < threshold || (selected.size() <= 1 && top_score - second_score < MIN_LEAD_GAP)) {
        selected.clear();
    }

    std::vector<double> selected_scores;
    std::vector<double> rejected_scores;
    for (const auto& [label, score] : scores) {
        if (std::find(selected.begin(), selected.end(), label) != selected.end()) {
            selected_scores.push_back(score);
        } else {
            rejected_scores.push_back(score);
        }
    }

    double confidence = 0.0;
    if (!selected_scores.empty()) {
        const double min_selected = *std::min_element(selected_scores.begin(), selected_scores.end());
        const double max_rejected = rejected_scores.empty() ? background : *std::max_element(rejected_scores.begin(), rejected_scores.end());
        confidence = std::max(0.0, std::min(1.0, min_selected - max_rejected));
    }

    json score_payload = json::object();
    for (const auto& [label, score] : scores) {
        score_payload[label] = round_to(score, 4);
    }
    return {selected, round_to(confidence, 4), score_payload};
}

json build_questions(const std::vector<std::pair<ObjectiveOption, json>>& option_results) {
    std::map<int, std::vector<json>> by_question;
    for (const auto& [option, result] : option_results) {
        by_question[option.question_number].push_back(result);
    }

    json questions = json::array();
    for (auto& [question_number, options] : by_question) {
        std::sort(options.begin(), options.end(), [](const auto& left, const auto& right) {
            return left.at("label").get<std::string>() < right.at("label").get<std::string>();
        });
        const auto [selected, confidence, option_scores] = selected_options(options);
        questions.push_back({
            {"questionNumber", question_number},
            {"selectedOptions", selected},
            {"confidence", confidence},
            {"optionScores", option_scores},
        });
    }
    return questions;
}

std::tuple<std::optional<int>, std::vector<std::string>, json> selected_digit(const std::vector<json>& samples) {
    std::map<std::string, double> scores;
    for (const auto& sample : samples) {
        scores[std::to_string(sample.at("digit").get<int>())] = sample.at("fillRatio").get<double>();
    }

    json score_payload = json::object();
    for (const auto& [digit, score] : scores) {
        score_payload[digit] = round_to(score, 4);
    }

    if (scores.size() != 10) {
        return {std::nullopt, {"expected_10_candidates_got_" + std::to_string(scores.size())}, score_payload};
    }

    std::vector<std::string> selected;
    for (const auto& [digit, score] : scores) {
        if (score >= MIN_SELECTED_FILL_RATIO) {
            selected.push_back(digit);
        }
    }
    if (selected.size() != 1) {
        return {std::nullopt, {selected.empty() ? "no_digit_selected" : "multiple_digits_selected"}, score_payload};
    }
    return {std::stoi(selected.front()), {}, score_payload};
}

json build_student_id(const std::vector<std::pair<StudentDigit, json>>& digit_results) {
    std::map<int, std::vector<json>> by_index;
    for (const auto& [digit, result] : digit_results) {
        by_index[digit.digit_index].push_back(result);
    }

    json digits = json::array();
    json failures = json::array();
    for (const auto& [digit_index, samples] : by_index) {
        const auto [selected, reasons, digit_scores] = selected_digit(samples);
        json digit_result = {
            {"digitIndex", digit_index},
            {"selectedDigit", selected ? json(*selected) : json(nullptr)},
            {"digitScores", digit_scores},
        };
        if (!reasons.empty()) {
            digit_result["reasons"] = reasons;
            failures.push_back(digit_result);
        }
        digits.push_back(digit_result);
    }

    if (by_index.empty()) {
        failures.push_back({
            {"digitIndex", nullptr},
            {"selectedDigit", nullptr},
            {"reasons", {"no_student_digit_candidates"}},
        });
    }

    std::string value;
    for (const auto& item : digits) {
        if (!item.at("selectedDigit").is_null()) {
            value += std::to_string(item.at("selectedDigit").get<int>());
        }
    }

    return {
        {"status", failures.empty() ? "ok" : "failed"},
        {"value", failures.empty() ? json(value) : json(nullptr)},
        {"digits", digits},
        {"failures", failures},
    };
}

json quality_payload(const std::vector<MarkerCandidate>& candidates, const std::vector<MarkerMatch>& matches, const std::vector<std::string>& missing_roles, const std::vector<double>& reprojection_errors, const std::vector<int>& inliers) {
    json errors = json::array();
    for (const double error : reprojection_errors) {
        errors.push_back(round_to(error, 4));
    }

    json mean_error = nullptr;
    if (!reprojection_errors.empty()) {
        const double mean = std::accumulate(reprojection_errors.begin(), reprojection_errors.end(), 0.0) / static_cast<double>(reprojection_errors.size());
        mean_error = round_to(mean, 4);
    }

    return {
        {"candidateCount", candidates.size()},
        {"matchCount", matches.size()},
        {"missingRoles", missing_roles},
        {"reprojectionErrorsPx", errors},
        {"meanReprojectionErrorPx", mean_error},
        {"inliers", inliers},
    };
}

json failed_result(const std::string& message, const std::filesystem::path& image_path, const std::filesystem::path& layout_path, int page_number, const json& quality = json::object()) {
    return {
        {"status", "failed"},
        {"imagePath", path_to_utf8(image_path)},
        {"layoutPath", path_to_utf8(layout_path)},
        {"pageNumber", page_number},
        {"message", message},
        {"quality", quality},
        {"questions", json::array()},
    };
}

void write_debug_artifacts(const std::filesystem::path& debug_dir, const json& result, const cv::Mat& warped, const cv::Mat& source_image, const std::vector<MarkerCandidate>& candidates, const std::vector<MarkerMatch>& matches, const std::vector<std::string>& missing_roles) {
    std::filesystem::create_directories(debug_dir);
    if (!warped.empty()) {
        write_image(debug_dir / "warped.png", warped);
    }
    if (!source_image.empty()) {
        write_image(debug_dir / "debug_markers.png", draw_debug_markers(source_image, candidates, matches, missing_roles));
    }
    std::ofstream output(debug_dir / "debug.json", std::ios::binary);
    output << result.dump(2);
}
}

json recognize_objective_answers(
    const std::filesystem::path& image_path,
    const std::filesystem::path& layout_path,
    int page_number,
    int output_dpi,
    bool debug,
    const std::filesystem::path& debug_dir
) {
    try {
        const LayoutPage layout_page = load_layout_page(layout_path, page_number);
        if (layout_page.objective_options.empty()) {
            return failed_result("Layout page has no objective options.", image_path, layout_path, page_number);
        }

        cv::Mat image = read_image(image_path);
        auto [candidates, binary] = find_marker_candidates(image);
        std::vector<MarkerMatch> matches = match_markers(candidates, image.size(), layout_page, output_dpi);

        std::vector<std::string> matched_roles;
        for (const auto& match : matches) {
            matched_roles.push_back(match.role);
        }
        std::vector<std::string> missing_roles;
        for (const auto& role : REQUIRED_MARKER_ROLES) {
            if (std::find(matched_roles.begin(), matched_roles.end(), role) == matched_roles.end()) {
                missing_roles.push_back(role);
            }
        }

        const auto [homography, reprojection_errors, inliers] = estimate_homography(matches);
        const json quality = quality_payload(candidates, matches, missing_roles, reprojection_errors, inliers);

        const auto output_size = a4_pixel_size(layout_page.width_mm, layout_page.height_mm, output_dpi);
        cv::Mat warped = warp_to_layout(image, homography, output_size);

        std::vector<std::pair<ObjectiveOption, json>> option_results;
        for (const auto& option : layout_page.objective_options) {
            option_results.emplace_back(option, sample_option(warped, option, output_dpi));
        }

        std::vector<std::pair<StudentDigit, json>> student_digit_results;
        for (const auto& digit : layout_page.student_digits) {
            student_digit_results.emplace_back(digit, sample_student_digit(warped, digit, output_dpi));
        }

        const json student_id = build_student_id(student_digit_results);
        std::string status = missing_roles.empty() ? "ok" : "partial";
        std::optional<std::string> message;
        if (student_id.at("status").get<std::string>() != "ok") {
            status = "failed";
            message = "Student ID recognition failed.";
        }

        json result = {
            {"status", status},
            {"imagePath", path_to_utf8(image_path)},
            {"layoutPath", path_to_utf8(layout_path)},
            {"cardId", layout_page.card_id},
            {"pageNumber", layout_page.page_number},
            {"output", {{"dpi", output_dpi}, {"widthPx", output_size.first}, {"heightPx", output_size.second}}},
            {"quality", quality},
            {"studentId", student_id},
            {"questions", build_questions(option_results)},
        };
        if (message) {
            result["message"] = *message;
        }

        if (debug) {
            const std::filesystem::path output_dir = debug_dir.empty() ? image_path.parent_path() / "recognition_debug" : debug_dir;
            write_debug_artifacts(output_dir, result, warped, image, candidates, matches, missing_roles);
        }
        return result;
    } catch (const std::exception& error) {
        json result = failed_result(error.what(), image_path, layout_path, page_number);
        if (debug && !debug_dir.empty()) {
            write_debug_artifacts(debug_dir, result, cv::Mat(), cv::Mat(), {}, {}, {});
        }
        return result;
    }
}
