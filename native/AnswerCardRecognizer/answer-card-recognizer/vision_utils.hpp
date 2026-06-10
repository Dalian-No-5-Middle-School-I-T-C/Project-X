#pragma once

#include "layout_io.hpp"

#include <filesystem>
#include <map>
#include <string>
#include <tuple>
#include <vector>

#include <nlohmann/json.hpp>
#include <opencv2/opencv.hpp>

struct MarkerScore {
    std::string role;
    double expected_width_px = 0;
    double expected_height_px = 0;
    double position_cost = 0;
    double size_penalty = 0;
    double shape_penalty = 0;
    double rectangularity_penalty = 0;
    double thin_penalty = 0;
    double total_cost = 0;
    bool eligible = false;
    std::vector<std::string> rejection_reasons;

    nlohmann::json to_json() const;
};

struct MarkerCandidate {
    int index = 0;
    cv::Point2d center;
    cv::Rect bbox;
    double area = 0;
    double fill_ratio = 0;
    double aspect_ratio = 0;
    double rectangularity = 0;
    std::map<std::string, MarkerScore> scores;

    const MarkerScore* best_score() const;
    nlohmann::json to_json() const;
};

struct MarkerMatch {
    std::string role;
    MarkerCandidate candidate;
    cv::Point2d expected_px;
    double cost = 0;
    bool has_score = false;
    MarkerScore score;

    nlohmann::json to_json() const;
};

cv::Mat read_image(const std::filesystem::path& path);
void write_image(const std::filesystem::path& path, const cv::Mat& image);
cv::Mat preprocess_for_markers(const cv::Mat& image);
std::pair<std::vector<MarkerCandidate>, cv::Mat> find_marker_candidates(const cv::Mat& image);
std::vector<MarkerMatch> match_markers(std::vector<MarkerCandidate>& candidates, const cv::Size& image_size, const LayoutPage& layout_page, int output_dpi);
std::tuple<cv::Mat, std::vector<double>, std::vector<int>> estimate_homography(const std::vector<MarkerMatch>& matches);
cv::Mat warp_to_layout(const cv::Mat& image, const cv::Mat& homography, std::pair<int, int> output_size);
cv::Mat draw_debug_markers(const cv::Mat& image, const std::vector<MarkerCandidate>& candidates, const std::vector<MarkerMatch>& matches, const std::vector<std::string>& missing_roles);

