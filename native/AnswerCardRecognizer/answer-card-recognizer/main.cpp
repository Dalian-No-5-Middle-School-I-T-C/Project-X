#include "answer_recognition.hpp"
#include "common.hpp"

#include <filesystem>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>

#include <nlohmann/json.hpp>
#include <opencv2/core/utils/logger.hpp>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

namespace {
struct CliOptions {
    std::filesystem::path image_path;
    std::filesystem::path layout_path;
    std::filesystem::path debug_dir;
    std::filesystem::path crops_dir;
    int page = 1;
    int dpi = 300;
    bool debug = false;
};

void configure_utf8_output() {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    cv::utils::logging::setLogLevel(cv::utils::logging::LOG_LEVEL_SILENT);
}

std::string usage() {
    return "Usage: answer-card-recognizer.exe --image <path> --layout <path> [--page <n>] [--dpi <n>] [--debug-dir <path>] [--crops-dir <path>]";
}

CliOptions parse_args(int argc, wchar_t* argv[]) {
    CliOptions options;
    for (int index = 1; index < argc; ++index) {
        const std::wstring name = argv[index];
        auto require_value = [&](const std::wstring& flag) -> std::wstring {
            if (index + 1 >= argc) {
                throw std::runtime_error("Missing value for " + wide_to_utf8(flag));
            }
            ++index;
            return argv[index];
        };

        if (name == L"--image") {
            options.image_path = std::filesystem::path(require_value(name));
        } else if (name == L"--layout") {
            options.layout_path = std::filesystem::path(require_value(name));
        } else if (name == L"--page") {
            options.page = std::stoi(require_value(name));
        } else if (name == L"--dpi") {
            options.dpi = std::stoi(require_value(name));
        } else if (name == L"--debug-dir") {
            options.debug = true;
            options.debug_dir = std::filesystem::path(require_value(name));
        } else if (name == L"--crops-dir") {
            options.crops_dir = std::filesystem::path(require_value(name));
        } else if (name == L"--debug") {
            options.debug = true;
        } else if (name == L"--help" || name == L"-h") {
            throw std::runtime_error(usage());
        } else {
            throw std::runtime_error("Unknown argument: " + wide_to_utf8(name));
        }
    }

    if (options.image_path.empty() || options.layout_path.empty()) {
        throw std::runtime_error(usage());
    }
    return options;
}

nlohmann::json cli_failed_result(const std::string& message) {
    return {
        {"status", "failed"},
        {"message", message},
        {"quality", nlohmann::json::object()},
        {"questions", nlohmann::json::array()},
        {"subjectiveQuestions", nlohmann::json::array()},
    };
}
}

int wmain(int argc, wchar_t* argv[]) {
    configure_utf8_output();
    try {
        const CliOptions options = parse_args(argc, argv);
        const nlohmann::json result = recognize_objective_answers(
            options.image_path,
            options.layout_path,
            options.page,
            options.dpi,
            options.debug,
            options.debug_dir,
            options.crops_dir
        );
        std::cout << result.dump(2) << '\n';
        return result.value("status", "failed") == "failed" ? 2 : 0;
    } catch (const std::exception& error) {
        std::cout << cli_failed_result(error.what()).dump(2) << '\n';
        return 2;
    }
}
