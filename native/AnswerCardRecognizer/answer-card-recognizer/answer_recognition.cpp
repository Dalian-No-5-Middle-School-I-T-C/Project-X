#include "answer_recognition.hpp"

#include "common.hpp"
#include "layout_io.hpp"
#include "vision_utils.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
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
constexpr double SCORE_CELL_MARGIN_RATIO = 0.03;
constexpr double MIN_RED_RATIO = 0.012;
constexpr double MIN_LINE_EXTENT_RATIO = 0.52;
constexpr double MAX_LINE_MEAN_ERROR_RATIO = 0.075;
constexpr double MAX_LINE_MAX_ERROR_RATIO = 0.22;

struct ScoreCellSample {
    SubjectiveScoreCell cell;
    bool has_red = false;
    bool valid = false;
    double confidence = 0;
    json metrics = json::object();
    std::string reason;
};

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

std::tuple<int, int, int, int> rect_to_outer_bounds(const Rect& rect, int dpi, int image_width, int image_height, double padding_ratio) {
    const double scale = static_cast<double>(dpi) / 25.4;
    double x1 = rect.x * scale;
    double y1 = rect.y * scale;
    double x2 = (rect.x + rect.width) * scale;
    double y2 = (rect.y + rect.height) * scale;

    const double pad_x = std::max(1.0, (x2 - x1) * padding_ratio);
    const double pad_y = std::max(1.0, (y2 - y1) * padding_ratio);
    x1 -= pad_x;
    y1 -= pad_y;
    x2 += pad_x;
    y2 += pad_y;

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

bool is_half_score(double value) {
    return std::abs(value - 0.5) < 0.001;
}

bool is_tens_score(double value) {
    return value >= 10.0 && std::abs(std::fmod(value, 10.0)) < 0.001;
}

bool is_whole_score(double value) {
    return std::abs(value - std::round(value)) < 0.001;
}

json score_cell_to_json(const SubjectiveScoreCell& cell, const json& metrics = json::object(), const std::string& reason = "") {
    json payload = {
        {"blockId", cell.block_id},
        {"questionId", cell.question_id},
        {"questionNumber", cell.question_number},
        {"score", round_to(cell.score, 3)},
        {"rect", rect_to_json(cell.rect)},
    };
    if (!metrics.empty()) {
        payload["metrics"] = metrics;
    }
    if (!reason.empty()) {
        payload["reason"] = reason;
    }
    return payload;
}

ScoreCellSample sample_score_cell(const cv::Mat& warped, const SubjectiveScoreCell& cell, int dpi) {
    ScoreCellSample sample;
    sample.cell = cell;

    cv::Mat bgr;
    if (warped.channels() == 1) {
        cv::cvtColor(warped, bgr, cv::COLOR_GRAY2BGR);
    } else {
        bgr = warped;
    }

    const auto [left, top, right, bottom] = rect_to_outer_bounds(cell.rect, dpi, bgr.cols, bgr.rows, SCORE_CELL_MARGIN_RATIO);
    const cv::Mat roi = bgr(cv::Rect(left, top, right - left, bottom - top));
    if (roi.empty()) {
        sample.reason = "empty_roi";
        return sample;
    }

    cv::Mat hsv;
    cv::cvtColor(roi, hsv, cv::COLOR_BGR2HSV);
    cv::Mat red_low;
    cv::Mat red_high;
    cv::inRange(hsv, cv::Scalar(0, 55, 55), cv::Scalar(12, 255, 255), red_low);
    cv::inRange(hsv, cv::Scalar(165, 55, 55), cv::Scalar(180, 255, 255), red_high);
    cv::Mat red_mask = red_low | red_high;

    cv::Mat kernel = cv::getStructuringElement(cv::MORPH_ELLIPSE, cv::Size(3, 3));
    cv::morphologyEx(red_mask, red_mask, cv::MORPH_OPEN, kernel);
    cv::morphologyEx(red_mask, red_mask, cv::MORPH_CLOSE, kernel);

    const int red_pixels = cv::countNonZero(red_mask);
    const double red_ratio = static_cast<double>(red_pixels) / static_cast<double>(red_mask.total());
    sample.has_red = red_ratio >= MIN_RED_RATIO;

    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(red_mask, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

    std::vector<cv::Point> points;
    int component_count = 0;
    const double min_area = std::max(6.0, static_cast<double>(red_mask.total()) * 0.0025);
    for (const auto& contour : contours) {
        const double area = cv::contourArea(contour);
        if (area < min_area) {
            continue;
        }
        component_count += 1;
        for (const auto& point : contour) {
            points.push_back(point);
        }
    }

    if (red_pixels > 0 && points.size() < static_cast<size_t>(red_pixels)) {
        std::vector<cv::Point> mask_points;
        cv::findNonZero(red_mask, mask_points);
        points = mask_points;
    }

    double extent_ratio = 0;
    double mean_error_ratio = 1;
    double max_error_ratio = 1;
    double line_quality = 0;
    if (points.size() >= 8) {
        cv::Vec4f line;
        cv::fitLine(points, line, cv::DIST_L2, 0, 0.01, 0.01);
        const double vx = line[0];
        const double vy = line[1];
        const double x0 = line[2];
        const double y0 = line[3];
        double min_projection = std::numeric_limits<double>::max();
        double max_projection = std::numeric_limits<double>::lowest();
        double error_sum = 0;
        double max_error = 0;
        for (const auto& point : points) {
            const double dx = point.x - x0;
            const double dy = point.y - y0;
            const double projection = dx * vx + dy * vy;
            const double distance = std::abs(dx * vy - dy * vx);
            min_projection = std::min(min_projection, projection);
            max_projection = std::max(max_projection, projection);
            error_sum += distance;
            max_error = std::max(max_error, distance);
        }
        const double diagonal = std::hypot(static_cast<double>(roi.cols), static_cast<double>(roi.rows));
        extent_ratio = diagonal > 0 ? (max_projection - min_projection) / diagonal : 0;
        mean_error_ratio = diagonal > 0 ? (error_sum / static_cast<double>(points.size())) / diagonal : 1;
        max_error_ratio = diagonal > 0 ? max_error / diagonal : 1;
        const double error_quality = std::max(0.0, 1.0 - mean_error_ratio / MAX_LINE_MEAN_ERROR_RATIO);
        const double extent_quality = std::min(1.0, extent_ratio / MIN_LINE_EXTENT_RATIO);
        line_quality = std::max(0.0, std::min(1.0, (error_quality + extent_quality) / 2.0));
    }

    sample.metrics = {
        {"redRatio", round_to(red_ratio, 4)},
        {"componentCount", component_count},
        {"pointCount", points.size()},
        {"extentRatio", round_to(extent_ratio, 4)},
        {"meanErrorRatio", round_to(mean_error_ratio, 4)},
        {"maxErrorRatio", round_to(max_error_ratio, 4)},
        {"sampleBounds", {{"left", left}, {"top", top}, {"right", right}, {"bottom", bottom}}},
    };

    if (!sample.has_red) {
        sample.reason = "no_red_line";
        return sample;
    }
    if (component_count != 1) {
        sample.reason = component_count == 0 ? "red_noise_only" : "multiple_red_components";
        return sample;
    }
    if (extent_ratio < MIN_LINE_EXTENT_RATIO) {
        sample.reason = "red_mark_does_not_cross_cell";
        return sample;
    }
    if (mean_error_ratio > MAX_LINE_MEAN_ERROR_RATIO || max_error_ratio > MAX_LINE_MAX_ERROR_RATIO) {
        sample.reason = "red_mark_is_not_single_straight_line";
        return sample;
    }

    sample.valid = true;
    sample.confidence = round_to(line_quality, 4);
    return sample;
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

json build_subjective_questions(const std::vector<ScoreCellSample>& samples) {
    std::map<std::string, std::vector<ScoreCellSample>> by_question;
    for (const auto& sample : samples) {
        const std::string key = sample.cell.block_id + "\n" + sample.cell.question_id + "\n" + sample.cell.question_number;
        by_question[key].push_back(sample);
    }

    json questions = json::array();
    for (auto& [_, question_samples] : by_question) {
        if (question_samples.empty()) {
            continue;
        }
        std::sort(question_samples.begin(), question_samples.end(), [](const auto& left, const auto& right) {
            return left.cell.score > right.cell.score;
        });

        const auto& first = question_samples.front().cell;
        const double max_score = first.max_score;
        json valid_cells = json::array();
        json invalid_cells = json::array();
        std::vector<ScoreCellSample> valid_samples;
        for (const auto& sample : question_samples) {
            if (sample.valid) {
                valid_samples.push_back(sample);
                valid_cells.push_back(score_cell_to_json(sample.cell, sample.metrics));
            } else if (sample.has_red) {
                invalid_cells.push_back(score_cell_to_json(sample.cell, sample.metrics, sample.reason));
            }
        }

        std::string status = "ok";
        std::optional<std::string> message;
        double score = 0;

        if (valid_samples.empty()) {
            status = "invalid";
            message = "no_valid_subjective_score";
        } else {
            std::vector<double> half_scores;
            std::vector<double> base_scores;
            std::vector<double> tens_scores;
            std::vector<double> ones_scores;

            for (const auto& sample : valid_samples) {
                const double value = sample.cell.score;
                if (is_half_score(value)) {
                    half_scores.push_back(value);
                } else if (max_score > 16.0) {
                    if (is_tens_score(value)) {
                        tens_scores.push_back(value);
                    } else if (value >= 0.0 && value <= 9.0 && is_whole_score(value)) {
                        ones_scores.push_back(value);
                    } else {
                        base_scores.push_back(value);
                    }
                } else {
                    base_scores.push_back(value);
                }
            }

            if (max_score > 16.0) {
                if (tens_scores.size() > 1 || ones_scores.size() > 1 || half_scores.size() > 1 || !base_scores.empty()) {
                    status = "invalid";
                    message = "invalid_subjective_score_combination";
                } else {
                    score =
                        (tens_scores.empty() ? 0.0 : tens_scores.front()) +
                        (ones_scores.empty() ? 0.0 : ones_scores.front()) +
                        (half_scores.empty() ? 0.0 : half_scores.front());
                }
            } else {
                if (base_scores.size() > 1 || half_scores.size() > 1) {
                    status = "invalid";
                    message = "invalid_subjective_score_combination";
                } else {
                    score =
                        (base_scores.empty() ? 0.0 : base_scores.front()) +
                        (half_scores.empty() ? 0.0 : half_scores.front());
                }
            }

            if (status == "ok" && score > max_score + 0.001) {
                status = "invalid";
                message = "subjective_score_exceeds_max";
            }
        }

        double confidence = 0.0;
        if (!valid_samples.empty()) {
            confidence = std::accumulate(valid_samples.begin(), valid_samples.end(), 0.0, [](double sum, const auto& sample) {
                return sum + sample.confidence;
            }) / static_cast<double>(valid_samples.size());
        }

        json question = {
            {"blockId", first.block_id},
            {"questionId", first.question_id},
            {"questionNumber", first.question_number},
            {"score", status == "ok" ? json(round_to(score, 3)) : json(0)},
            {"maxScore", round_to(max_score, 3)},
            {"status", status},
            {"validCells", valid_cells},
            {"invalidCells", invalid_cells},
            {"confidence", round_to(confidence, 4)},
        };
        if (message) {
            question["message"] = *message;
        }
        questions.push_back(question);
    }
    return questions;
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
        {"subjectiveQuestions", json::array()},
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

static bool is_inverted(const std::vector<MarkerMatch>& matches) {
    return (((matches[0].candidate.center.y + matches[4].candidate.center.y) / 2 > matches[2].candidate.center.y) ||
        ((matches[1].candidate.center.y + matches[5].candidate.center.y) / 2 > matches[3].candidate.center.y));
}

static void invert_correct(std::vector<MarkerMatch>& matches) {
    if (!is_inverted(matches)) {
        return;
    }
    std::unordered_map<std::string, int> idx;
    for (size_t i = 0; i < matches.size(); ++i) {
        idx[matches[i].role] = static_cast<int>(i);
    }
    const std::vector<std::pair<std::string, std::string>> role_swaps = {
        {"bottom-left", "top-right"},
        {"bottom-right", "top-left"},
        {"middle-left", "middle-right"},
    };
    for (const auto& pr : role_swaps) {
        auto itA = idx.find(pr.first);
        auto itB = idx.find(pr.second);
        if (itA != idx.end() && itB != idx.end()) {
            int a = itA->second;
            int b = itB->second;
            std::swap(matches[a].expected_px, matches[b].expected_px);
            std::swap(matches[a].role, matches[b].role);
        }
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
        if (layout_page.objective_options.empty() && layout_page.subjective_score_cells.empty()) {
            return failed_result("Layout page has no recognizable answer or score cells.", image_path, layout_path, page_number);
        }

        cv::Mat image = read_image(image_path);
        auto [candidates, binary] = find_marker_candidates(image);
        std::vector<MarkerMatch> matches = match_markers(candidates, image.size(), layout_page, output_dpi);

   //     if (matches.size() == 6) {
			//invert_correct(matches);
   //     }

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

        std::vector<ScoreCellSample> score_cell_results;
        for (const auto& cell : layout_page.subjective_score_cells) {
            score_cell_results.push_back(sample_score_cell(warped, cell, output_dpi));
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
            {"subjectiveQuestions", build_subjective_questions(score_cell_results)},
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
