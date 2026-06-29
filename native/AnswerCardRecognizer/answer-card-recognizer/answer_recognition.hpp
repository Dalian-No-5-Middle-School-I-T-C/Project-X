#pragma once

#include <filesystem>

#include <nlohmann/json.hpp>

nlohmann::json recognize_objective_answers(
    const std::filesystem::path& image_path,
    const std::filesystem::path& layout_path,
    int page_number,
    int output_dpi,
    bool debug,
    const std::filesystem::path& debug_dir,
    const std::filesystem::path& crops_dir = {}
);

