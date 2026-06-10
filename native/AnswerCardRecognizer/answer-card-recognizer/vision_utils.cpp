#include "vision_utils.hpp"

#include "common.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <functional>
#include <limits>
#include <numeric>
#include <stdexcept>

using json = nlohmann::json;

json MarkerScore::to_json() const {
    return {
        {"role", role},
        {"expectedWidthPx", round_to(expected_width_px, 3)},
        {"expectedHeightPx", round_to(expected_height_px, 3)},
        {"positionCost", round_to(position_cost, 6)},
        {"sizePenalty", round_to(size_penalty, 6)},
        {"shapePenalty", round_to(shape_penalty, 6)},
        {"rectangularityPenalty", round_to(rectangularity_penalty, 6)},
        {"thinPenalty", round_to(thin_penalty, 6)},
        {"totalCost", round_to(total_cost, 6)},
        {"eligible", eligible},
        {"rejectionReasons", rejection_reasons},
    };
}

const MarkerScore* MarkerCandidate::best_score() const {
    if (scores.empty()) {
        return nullptr;
    }
    return &std::min_element(scores.begin(), scores.end(), [](const auto& left, const auto& right) {
        return left.second.total_cost < right.second.total_cost;
    })->second;
}

json MarkerCandidate::to_json() const {
    json data = {
        {"index", index},
        {"center", {round_to(center.x, 3), round_to(center.y, 3)}},
        {"bbox", {bbox.x, bbox.y, bbox.width, bbox.height}},
        {"area", round_to(area, 3)},
        {"fillRatio", round_to(fill_ratio, 4)},
        {"aspectRatio", round_to(aspect_ratio, 4)},
        {"rectangularity", round_to(rectangularity, 4)},
    };
    if (const MarkerScore* best = best_score()) {
        json scores_by_role = json::object();
        for (const auto& [role, score] : scores) {
            scores_by_role[role] = score.to_json();
        }
        data.update({
            {"bestRole", best->role},
            {"expectedWidthPx", round_to(best->expected_width_px, 3)},
            {"expectedHeightPx", round_to(best->expected_height_px, 3)},
            {"positionCost", round_to(best->position_cost, 6)},
            {"sizePenalty", round_to(best->size_penalty, 6)},
            {"shapePenalty", round_to(best->shape_penalty, 6)},
            {"rectangularityPenalty", round_to(best->rectangularity_penalty, 6)},
            {"thinPenalty", round_to(best->thin_penalty, 6)},
            {"totalCost", round_to(best->total_cost, 6)},
            {"eligible", best->eligible},
            {"rejectionReasons", best->rejection_reasons},
            {"scoresByRole", scores_by_role},
        });
    }
    return data;
}

json MarkerMatch::to_json() const {
    json data = {
        {"role", role},
        {"candidateIndex", candidate.index},
        {"detectedCenter", {round_to(candidate.center.x, 3), round_to(candidate.center.y, 3)}},
        {"expectedCenter", {round_to(expected_px.x, 3), round_to(expected_px.y, 3)}},
        {"cost", round_to(cost, 6)},
    };
    if (has_score) {
        data["score"] = score.to_json();
    }
    return data;
}

cv::Mat read_image(const std::filesystem::path& path) {
    if (!std::filesystem::exists(path)) {
        throw std::runtime_error("Image not found: " + path_to_utf8(path));
    }
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("Failed to read image: " + path_to_utf8(path));
    }
    std::vector<unsigned char> buffer((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    cv::Mat image = cv::imdecode(buffer, cv::IMREAD_COLOR);
    if (image.empty()) {
        throw std::runtime_error("Failed to read image: " + path_to_utf8(path));
    }
    return image;
}

void write_image(const std::filesystem::path& path, const cv::Mat& image) {
    std::filesystem::create_directories(path.parent_path());
    const std::string ext = path.extension().empty() ? ".png" : path.extension().string();
    std::vector<unsigned char> encoded;
    if (!cv::imencode(ext, image, encoded)) {
        throw std::runtime_error("Failed to encode image as " + ext + ": " + path_to_utf8(path));
    }
    std::ofstream output(path, std::ios::binary);
    if (!output) {
        throw std::runtime_error("Failed to write image: " + path_to_utf8(path));
    }
    output.write(reinterpret_cast<const char*>(encoded.data()), static_cast<std::streamsize>(encoded.size()));
}

cv::Mat preprocess_for_markers(const cv::Mat& image) {
    cv::Mat gray;
    cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
    cv::Mat blurred;
    cv::GaussianBlur(gray, blurred, cv::Size(5, 5), 0);
    cv::Mat binary;
    cv::threshold(blurred, binary, 0, 255, cv::THRESH_BINARY_INV | cv::THRESH_OTSU);
    const cv::Mat kernel = cv::getStructuringElement(cv::MORPH_RECT, cv::Size(3, 3));
    cv::Mat closed;
    cv::morphologyEx(binary, closed, cv::MORPH_CLOSE, kernel, cv::Point(-1, -1), 1);
    cv::Mat opened;
    cv::morphologyEx(closed, opened, cv::MORPH_OPEN, kernel, cv::Point(-1, -1), 1);
    return opened;
}

std::pair<std::vector<MarkerCandidate>, cv::Mat> find_marker_candidates(const cv::Mat& image) {
    cv::Mat binary = preprocess_for_markers(image);
    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(binary, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

    const double image_area = static_cast<double>(image.rows) * static_cast<double>(image.cols);
    const double min_area = std::max(25.0, image_area * 0.000015);
    const double max_area = image_area * 0.002;
    std::vector<MarkerCandidate> candidates;

    for (const auto& contour : contours) {
        const double area = cv::contourArea(contour);
        if (area < min_area || area > max_area) {
            continue;
        }

        const cv::Rect bbox = cv::boundingRect(contour);
        if (bbox.width <= 0 || bbox.height <= 0) {
            continue;
        }

        const double aspect_ratio = static_cast<double>(bbox.height) / static_cast<double>(bbox.width);
        if (aspect_ratio < 1.45 || aspect_ratio > 4.5) {
            continue;
        }

        const double rectangularity = area / static_cast<double>(bbox.width * bbox.height);
        if (rectangularity < 0.45) {
            continue;
        }

        const cv::Mat roi = binary(bbox);
        const double fill_ratio = static_cast<double>(cv::countNonZero(roi)) / static_cast<double>(bbox.width * bbox.height);
        if (fill_ratio < 0.45) {
            continue;
        }

        candidates.push_back(MarkerCandidate{
            static_cast<int>(candidates.size()),
            cv::Point2d(bbox.x + bbox.width / 2.0, bbox.y + bbox.height / 2.0),
            bbox,
            area,
            fill_ratio,
            aspect_ratio,
            rectangularity,
            {},
        });
    }

    std::sort(candidates.begin(), candidates.end(), [](const auto& left, const auto& right) {
        return std::tie(left.center.y, left.center.x) < std::tie(right.center.y, right.center.x);
    });
    for (size_t index = 0; index < candidates.size(); ++index) {
        candidates[index].index = static_cast<int>(index);
    }
    return {candidates, binary};
}

static std::pair<double, double> expected_marker_size_px(const LayoutPage& layout_page, const std::string& role, int image_width, int image_height) {
    const auto& marker = layout_page.markers.at(role);
    return {
        marker.rect.width / layout_page.width_mm * image_width,
        marker.rect.height / layout_page.height_mm * image_height,
    };
}

static MarkerScore score_candidate_for_role(const MarkerCandidate& candidate, const std::string& role, int image_width, int image_height, const LayoutPage& layout_page) {
    const auto& marker = layout_page.markers.at(role);
    const auto [expected_width, expected_height] = expected_marker_size_px(layout_page, role, image_width, image_height);
    const double expected_aspect_ratio = expected_height / std::max(expected_width, 1e-6);
    const auto [marker_center_x, marker_center_y] = marker.center_mm();
    const double expected_x = marker_center_x / layout_page.width_mm;
    const double expected_y = marker_center_y / layout_page.height_mm;
    const double actual_x = candidate.center.x / static_cast<double>(image_width);
    const double actual_y = candidate.center.y / static_cast<double>(image_height);
    const double position_cost = std::abs(actual_y - expected_y) + 0.35 * std::abs(actual_x - expected_x);
    const double size_penalty =
        std::abs(std::log(std::max(candidate.bbox.width, 1) / std::max(expected_width, 1e-6))) +
        std::abs(std::log(std::max(candidate.bbox.height, 1) / std::max(expected_height, 1e-6)));
    const double shape_penalty = std::abs(std::log(std::max(candidate.aspect_ratio, 1e-6) / std::max(expected_aspect_ratio, 1e-6)));
    const double rectangularity_penalty = std::max(0.0, 0.65 - candidate.rectangularity) * 0.2;
    const double thin_penalty = candidate.bbox.width < expected_width * 0.55 ? 0.25 : 0.0;
    std::vector<std::string> rejection_reasons;

    if (candidate.bbox.width < expected_width * 0.35) {
        rejection_reasons.push_back("width_too_small");
    }
    if (candidate.bbox.height < expected_height * 0.35) {
        rejection_reasons.push_back("height_too_small");
    }
    if (candidate.bbox.width > expected_width * 3.0) {
        rejection_reasons.push_back("width_too_large");
    }
    if (candidate.bbox.height > expected_height * 2.2) {
        rejection_reasons.push_back("height_too_large");
    }

    const double total_cost = position_cost + 0.08 * size_penalty + 0.04 * shape_penalty + rectangularity_penalty + thin_penalty;
    return MarkerScore{
        role,
        expected_width,
        expected_height,
        position_cost,
        size_penalty,
        shape_penalty,
        rectangularity_penalty,
        thin_penalty,
        total_cost,
        rejection_reasons.empty(),
        rejection_reasons,
    };
}

static void score_candidates(std::vector<MarkerCandidate>& candidates, const std::vector<std::string>& roles, int image_width, int image_height, const LayoutPage& layout_page) {
    for (auto& candidate : candidates) {
        candidate.scores.clear();
        for (const auto& role : roles) {
            candidate.scores[role] = score_candidate_for_role(candidate, role, image_width, image_height, layout_page);
        }
    }
}

static double candidate_cost(const MarkerCandidate& candidate, const std::string& role, int image_width, int image_height, const LayoutPage& layout_page) {
    const auto score = candidate.scores.find(role);
    if (score != candidate.scores.end()) {
        return score->second.total_cost;
    }
    return score_candidate_for_role(candidate, role, image_width, image_height, layout_page).total_cost;
}

static bool starts_with(const std::string& value, const std::string& prefix) {
    return value.rfind(prefix, 0) == 0;
}

static double side_geometry_penalty(const std::vector<std::string>& role_subset, const std::vector<const MarkerCandidate*>& candidate_subset, int image_width, const LayoutPage& layout_page) {
    std::map<std::string, const MarkerCandidate*> role_to_candidate;
    for (size_t index = 0; index < role_subset.size(); ++index) {
        role_to_candidate[role_subset[index]] = candidate_subset[index];
    }

    auto role_order = [](const std::string& role) {
        if (starts_with(role, "top")) {
            return 0;
        }
        if (starts_with(role, "middle")) {
            return 1;
        }
        if (starts_with(role, "bottom")) {
            return 2;
        }
        return 99;
    };

    std::vector<std::pair<std::string, const MarkerCandidate*>> ordered(role_to_candidate.begin(), role_to_candidate.end());
    std::sort(ordered.begin(), ordered.end(), [&](const auto& left, const auto& right) {
        return role_order(left.first) < role_order(right.first);
    });

    double penalty = 0.0;
    for (size_t index = 0; index + 1 < ordered.size(); ++index) {
        if (ordered[index].second->center.y >= ordered[index + 1].second->center.y) {
            penalty += 5.0;
            break;
        }
    }

    if (ordered.size() > 1) {
        double min_x = ordered.front().second->center.x;
        double max_x = min_x;
        for (const auto& item : ordered) {
            min_x = std::min(min_x, item.second->center.x);
            max_x = std::max(max_x, item.second->center.x);
        }
        const double x_spread = (max_x - min_x) / static_cast<double>(image_width);
        if (x_spread > 0.22) {
            penalty += (x_spread - 0.22) * 2.0;
        }
    }

    const MarkerCandidate* top = nullptr;
    const MarkerCandidate* middle = nullptr;
    const MarkerCandidate* bottom = nullptr;
    for (const auto& [role, candidate] : role_to_candidate) {
        if (starts_with(role, "top-")) {
            top = candidate;
        } else if (starts_with(role, "middle-")) {
            middle = candidate;
        } else if (starts_with(role, "bottom-")) {
            bottom = candidate;
        }
    }

    if (top && middle && bottom && bottom->center.y > top->center.y) {
        const double actual_ratio = (middle->center.y - top->center.y) / (bottom->center.y - top->center.y);
        const std::string side = role_subset.front().find("left") != std::string::npos ? "left" : "right";
        const double expected_top = layout_page.markers.at("top-" + side).center_mm().second;
        const double expected_middle = layout_page.markers.at("middle-" + side).center_mm().second;
        const double expected_bottom = layout_page.markers.at("bottom-" + side).center_mm().second;
        const double expected_ratio = (expected_middle - expected_top) / (expected_bottom - expected_top);
        penalty += std::abs(actual_ratio - expected_ratio) * 0.25;
    }

    return penalty;
}

static void generate_role_combinations(const std::vector<std::string>& roles, int count, size_t start, std::vector<std::string>& current, std::vector<std::vector<std::string>>& output) {
    if (static_cast<int>(current.size()) == count) {
        output.push_back(current);
        return;
    }
    for (size_t index = start; index < roles.size(); ++index) {
        current.push_back(roles[index]);
        generate_role_combinations(roles, count, index + 1, current, output);
        current.pop_back();
    }
}

static std::vector<MarkerMatch> assign_side(const std::vector<MarkerCandidate>& candidates, const std::vector<std::string>& roles, int image_width, int image_height, const LayoutPage& layout_page, const std::string& side) {
    std::vector<const MarkerCandidate*> side_pool;
    for (const auto& candidate : candidates) {
        if ((side == "left" && candidate.center.x > image_width * 0.45) || (side != "left" && candidate.center.x < image_width * 0.55)) {
            continue;
        }
        const bool eligible = std::any_of(roles.begin(), roles.end(), [&](const std::string& role) {
            const auto score = candidate.scores.find(role);
            return score != candidate.scores.end() && score->second.eligible;
        });
        if (eligible) {
            side_pool.push_back(&candidate);
        }
    }

    std::sort(side_pool.begin(), side_pool.end(), [&](const MarkerCandidate* left, const MarkerCandidate* right) {
        auto min_cost = [&](const MarkerCandidate* candidate) {
            double best = std::numeric_limits<double>::infinity();
            for (const auto& role : roles) {
                const auto score = candidate->scores.find(role);
                if (score != candidate->scores.end()) {
                    best = std::min(best, score->second.total_cost);
                }
            }
            return best;
        };
        return min_cost(left) < min_cost(right);
    });
    if (side_pool.size() > 18) {
        side_pool.resize(18);
    }
    if (side_pool.empty()) {
        return {};
    }

    const int full_match_count = std::min(static_cast<int>(roles.size()), static_cast<int>(side_pool.size()));
    std::vector<std::vector<std::string>> role_combinations;
    std::vector<std::string> current_roles;
    generate_role_combinations(roles, full_match_count, 0, current_roles, role_combinations);

    bool has_best = false;
    double best_cost = 0.0;
    std::vector<std::string> best_roles;
    std::vector<const MarkerCandidate*> best_candidates;

    std::vector<int> used(side_pool.size(), 0);
    std::vector<const MarkerCandidate*> current_candidates;
    std::function<void(const std::vector<std::string>&)> search = [&](const std::vector<std::string>& role_subset) {
        if (static_cast<int>(current_candidates.size()) == full_match_count) {
            double cost = 0.0;
            for (int index = 0; index < full_match_count; ++index) {
                cost += candidate_cost(*current_candidates[index], role_subset[index], image_width, image_height, layout_page);
            }
            cost += side_geometry_penalty(role_subset, current_candidates, image_width, layout_page);
            if (!has_best || cost < best_cost) {
                has_best = true;
                best_cost = cost;
                best_roles = role_subset;
                best_candidates = current_candidates;
            }
            return;
        }
        for (size_t index = 0; index < side_pool.size(); ++index) {
            if (used[index]) {
                continue;
            }
            used[index] = 1;
            current_candidates.push_back(side_pool[index]);
            search(role_subset);
            current_candidates.pop_back();
            used[index] = 0;
        }
    };

    for (const auto& role_subset : role_combinations) {
        std::fill(used.begin(), used.end(), 0);
        current_candidates.clear();
        search(role_subset);
    }

    if (!has_best) {
        return {};
    }

    std::vector<MarkerMatch> matches;
    const auto expected_px = marker_centers_px(layout_page, 300);
    for (size_t index = 0; index < best_roles.size(); ++index) {
        const auto& role = best_roles[index];
        const MarkerCandidate& candidate = *best_candidates[index];
        const auto score_it = candidate.scores.find(role);
        const MarkerScore score = score_it != candidate.scores.end() ? score_it->second : score_candidate_for_role(candidate, role, image_width, image_height, layout_page);
        matches.push_back(MarkerMatch{
            role,
            candidate,
            cv::Point2d(expected_px.at(role).first, expected_px.at(role).second),
            score.total_cost,
            true,
            score,
        });
    }
    return matches;
}

std::vector<MarkerMatch> match_markers(std::vector<MarkerCandidate>& candidates, const cv::Size& image_size, const LayoutPage& layout_page, int output_dpi) {
    const std::vector<std::string> left_roles = {"top-left", "middle-left", "bottom-left"};
    const std::vector<std::string> right_roles = {"top-right", "middle-right", "bottom-right"};
    std::vector<std::string> all_roles = left_roles;
    all_roles.insert(all_roles.end(), right_roles.begin(), right_roles.end());
    score_candidates(candidates, all_roles, image_size.width, image_size.height, layout_page);

    std::vector<MarkerMatch> matches = assign_side(candidates, left_roles, image_size.width, image_size.height, layout_page, "left");
    std::vector<MarkerMatch> right_matches = assign_side(candidates, right_roles, image_size.width, image_size.height, layout_page, "right");
    matches.insert(matches.end(), right_matches.begin(), right_matches.end());
    std::sort(matches.begin(), matches.end(), [](const auto& left, const auto& right) {
        return left.role < right.role;
    });

    const auto expected = marker_centers_px(layout_page, output_dpi);
    for (auto& match : matches) {
        match.expected_px = cv::Point2d(expected.at(match.role).first, expected.at(match.role).second);
        match.has_score = false;
    }
    return matches;
}

std::tuple<cv::Mat, std::vector<double>, std::vector<int>> estimate_homography(const std::vector<MarkerMatch>& matches) {
    if (matches.size() < 4) {
        throw std::runtime_error("Need at least 4 marker matches, got " + std::to_string(matches.size()));
    }

    std::vector<cv::Point2f> src;
    std::vector<cv::Point2f> dst;
    for (const auto& match : matches) {
        src.emplace_back(static_cast<float>(match.candidate.center.x), static_cast<float>(match.candidate.center.y));
        dst.emplace_back(static_cast<float>(match.expected_px.x), static_cast<float>(match.expected_px.y));
    }

    cv::Mat mask;
    cv::Mat homography = cv::findHomography(src, dst, cv::RANSAC, 8.0, mask);
    if (homography.empty()) {
        throw std::runtime_error("Failed to estimate homography from marker matches");
    }

    std::vector<cv::Point2f> projected;
    cv::perspectiveTransform(src, projected, homography);
    std::vector<double> errors;
    for (size_t index = 0; index < projected.size(); ++index) {
        const cv::Point2f delta = projected[index] - dst[index];
        errors.push_back(std::sqrt(delta.x * delta.x + delta.y * delta.y));
    }

    std::vector<int> inliers;
    if (!mask.empty()) {
        for (int index = 0; index < mask.rows; ++index) {
            inliers.push_back(mask.at<unsigned char>(index, 0) ? 1 : 0);
        }
    } else {
        inliers.assign(matches.size(), 1);
    }

    return {homography, errors, inliers};
}

cv::Mat warp_to_layout(const cv::Mat& image, const cv::Mat& homography, std::pair<int, int> output_size) {
    cv::Mat warped;
    cv::warpPerspective(image, warped, homography, cv::Size(output_size.first, output_size.second), cv::INTER_CUBIC);
    return warped;
}

cv::Mat draw_debug_markers(const cv::Mat& image, const std::vector<MarkerCandidate>& candidates, const std::vector<MarkerMatch>& matches, const std::vector<std::string>& missing_roles) {
    cv::Mat debug = image.clone();
    for (const auto& candidate : candidates) {
        cv::rectangle(debug, candidate.bbox, cv::Scalar(0, 220, 220), 2);
        cv::putText(
            debug,
            std::to_string(candidate.index),
            cv::Point(candidate.bbox.x, std::max(0, candidate.bbox.y - 6)),
            cv::FONT_HERSHEY_SIMPLEX,
            0.5,
            cv::Scalar(0, 180, 180),
            1,
            cv::LINE_AA
        );
    }

    for (const auto& match : matches) {
        const cv::Point center(static_cast<int>(std::round(match.candidate.center.x)), static_cast<int>(std::round(match.candidate.center.y)));
        cv::rectangle(debug, match.candidate.bbox, cv::Scalar(0, 0, 255), 3);
        cv::circle(debug, center, 6, cv::Scalar(255, 0, 0), -1);
        cv::putText(
            debug,
            match.role,
            cv::Point(match.candidate.bbox.x, match.candidate.bbox.y + match.candidate.bbox.height + 18),
            cv::FONT_HERSHEY_SIMPLEX,
            0.58,
            cv::Scalar(0, 0, 255),
            2,
            cv::LINE_AA
        );
    }

    if (!missing_roles.empty()) {
        std::string text = "Missing: ";
        for (size_t index = 0; index < missing_roles.size(); ++index) {
            if (index > 0) {
                text += ", ";
            }
            text += missing_roles[index];
        }
        cv::putText(debug, text, cv::Point(20, 40), cv::FONT_HERSHEY_SIMPLEX, 1.0, cv::Scalar(0, 0, 255), 2, cv::LINE_AA);
    }
    return debug;
}
