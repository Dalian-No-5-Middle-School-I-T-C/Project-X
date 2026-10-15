#include "answer_recognition.hpp"
#include "common.hpp"
#include "recognizer_limits.hpp"

#include <cstdio>
#include <filesystem>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <opencv2/core/utils/logger.hpp>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#define WIN32_LEAN_AND_MEAN
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
    bool legacy = false;
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

CliOptions parse_args(const std::vector<std::string>& argv) {
    const int argc = static_cast<int>(argv.size());
    CliOptions options;
    for (int index = 1; index < argc; ++index) {
        const std::string name = argv[index];
        auto require_value = [&](const std::string& flag) -> std::string {
            if (index + 1 >= argc) {
                throw std::runtime_error("Missing value for " + flag);
            }
            ++index;
            return argv[index];
        };

        if (name == "--image") {
            options.image_path = std::filesystem::u8path(require_value(name));
        } else if (name == "--layout") {
            options.layout_path = std::filesystem::u8path(require_value(name));
        } else if (name == "--identity-mode") {
            const auto mode = require_value(name);
            if (mode != "strict" && mode != "legacy") throw std::runtime_error("Invalid identity mode");
            options.legacy = mode == "legacy";
        } else if (name == "--page") {
            options.page = std::stoi(require_value(name));
        } else if (name == "--dpi") {
            options.dpi = std::stoi(require_value(name));
        } else if (name == "--debug-dir") {
            options.debug = true;
            options.debug_dir = std::filesystem::u8path(require_value(name));
        } else if (name == "--crops-dir") {
            options.crops_dir = std::filesystem::u8path(require_value(name));
        } else if (name == "--debug") {
            options.debug = true;
        } else if (name == "--help" || name == "-h") {
            throw std::runtime_error(usage());
        } else {
            throw std::runtime_error("Unknown argument: " + name);
        }
    }

    if (options.image_path.empty() || options.layout_path.empty()) {
        throw std::runtime_error(usage());
    }
    // 安全 R19：--page / --dpi 直接参与像素换算，越界就地报错，别等 OpenCV 分配时才失败
    if (options.page < 1 || options.page > 100000) {
        throw std::runtime_error("--page must be between 1 and 100000");
    }
    assert_recognizer_dpi(options.dpi);
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

int run_cli(const std::vector<std::string>& argv) {
    configure_utf8_output();
#ifdef _WIN32
    // 安全 R19：本进程是服务端/扫描端拉起的子进程，弹一个「找不到磁盘或 DLL」的模态框
    // 只会让调用方白等满 30 秒超时——直接失败返回更有用。
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
#endif
    try {
        // stdout 只留给 JSON 结果，生效档位写 stderr：现场排查「为什么这张图被拒」时不用猜默认值
        std::fprintf(stderr, "[recognizer-limits] %s\n", describe_recognizer_limits().c_str());
        const CliOptions options = parse_args(argv);
        const nlohmann::json result = recognize_objective_answers(
            options.image_path,
            options.layout_path,
            options.page,
            options.dpi,
            options.debug,
            options.debug_dir,
            options.crops_dir,
            options.legacy
        );
        std::cout << result.dump(2) << '\n';
        return result.value("status", "failed") == "failed" ? 2 : 0;
    } catch (const std::exception& error) {
        std::cout << cli_failed_result(error.what()).dump(2) << '\n';
        return 2;
    }
}

#ifdef _WIN32
int wmain(int argc, wchar_t* argv[]) {
    std::vector<std::string> args;
    for (int i = 0; i < argc; ++i) args.push_back(wide_to_utf8(argv[i]));
    return run_cli(args);
}
#else
int main(int argc, char* argv[]) {
    return run_cli(std::vector<std::string>(argv, argv + argc));
}
#endif
