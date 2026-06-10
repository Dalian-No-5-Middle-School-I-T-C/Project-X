#pragma once

#include <filesystem>
#include <map>
#include <string>
#include <utility>
#include <vector>

extern const std::vector<std::string> REQUIRED_MARKER_ROLES;

struct Rect {
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;

    std::pair<double, double> center() const;
};

struct LayoutMarker {
    std::string role;
    Rect rect;

    std::pair<double, double> center_mm() const;
};

struct ObjectiveOption {
    std::string block_id;
    int question_number = 0;
    std::string label;
    Rect rect;
};

struct StudentDigit {
    int digit_index = 0;
    int digit = 0;
    Rect rect;
};

struct LayoutPage {
    std::string card_id;
    int page_number = 1;
    double width_mm = 210;
    double height_mm = 297;
    std::map<std::string, LayoutMarker> markers;
    std::vector<ObjectiveOption> objective_options;
    std::vector<StudentDigit> student_digits;
};

LayoutPage load_layout_page(const std::filesystem::path& layout_path, int page_number);
std::pair<int, int> a4_pixel_size(double width_mm, double height_mm, int dpi);
std::map<std::string, std::pair<double, double>> marker_centers_px(const LayoutPage& page, int dpi);

