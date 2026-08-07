#include "twain_controller.hpp"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace ScannerBridge;

static void printUsage() {
    fprintf(stderr, "Project-X Scanner Bridge\n");
    fprintf(stderr, "Usage:\n");
    fprintf(stderr, "  scanner-bridge list\n");
    fprintf(stderr, "  scanner-bridge scan [options]\n");
    fprintf(stderr, "\nScan options:\n");
    fprintf(stderr, "  --source <name>     Scanner name (default: first available)\n");
    fprintf(stderr, "  --dpi <number>      Resolution (default: 300)\n");
    fprintf(stderr, "  --duplex            Enable duplex scanning\n");
    fprintf(stderr, "  --mode <mode>       Color mode: gray, color, bw (default: gray)\n");
    fprintf(stderr, "  --size <size>       Paper size: A4, Letter, A3 (default: A4)\n");
    fprintf(stderr, "  --output <dir>      Output directory (required for scan)\n");
    fprintf(stderr, "  --prefix <str>      File name prefix (default: scan)\n");
    fprintf(stderr, "  --max-pages <num>   Max pages to scan (default: unlimited)\n");
    fprintf(stderr, "  --show-ui           Show scanner's native UI\n");
}

// 宽字符参数转 UTF-8：wmain 拿到的是 UTF-16 命令行（Node spawn 按 UTF-16 传参），
// 转成 UTF-8 std::string 后，输出路径经过 saveDIBToFile 的 CP_UTF8 转换不会乱码
// （旧实现用 ANSI main，中文系统下 argv 是 GBK 字节，路径解码必然出错）
static std::string toUtf8(const wchar_t* wstr) {
    if (!wstr || !*wstr) return "";
    int len = WideCharToMultiByte(CP_UTF8, 0, wstr, -1, nullptr, 0, nullptr, nullptr);
    if (len <= 1) return "";
    std::string utf8(len - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wstr, -1, &utf8[0], len, nullptr, nullptr);
    return utf8;
}

int wmain(int argc, wchar_t* argv[]) {
    // 统一转为 UTF-8 参数
    std::vector<std::string> args;
    args.reserve(argc > 0 ? static_cast<size_t>(argc) : 0);
    for (int i = 0; i < argc; ++i) {
        args.push_back(toUtf8(argv[i]));
    }

    if (argc < 2) {
        printUsage();
        return 1;
    }

    std::string command = args[1];

    if (command == "list") {
        TwainController controller;
        auto sources = controller.listSources();
        
        std::string json = sourcesToJson(sources);
        printf("%s\n", json.c_str());
        fflush(stdout);
        
        return sources.empty() ? 1 : 0;
    }

    if (command == "scan") {
        ScanConfig config;
        config.sourceName = "";
        bool hasOutput = false;

        // Parse arguments
        for (int i = 2; i < argc; ++i) {
            std::string arg = args[i];
            
            if (arg == "--source" && i + 1 < argc) {
                config.sourceName = args[++i];
            } else if (arg == "--dpi" && i + 1 < argc) {
                config.dpi = atoi(args[++i].c_str());
            } else if (arg == "--duplex") {
                config.duplex = true;
            } else if (arg == "--mode" && i + 1 < argc) {
                config.colorMode = args[++i];
            } else if (arg == "--size" && i + 1 < argc) {
                config.paperSize = args[++i];
            } else if (arg == "--output" && i + 1 < argc) {
                config.outputDir = args[++i];
                hasOutput = true;
            } else if (arg == "--prefix" && i + 1 < argc) {
                config.filePrefix = args[++i];
            } else if (arg == "--max-pages" && i + 1 < argc) {
                config.maxPages = atoi(args[++i].c_str());
            } else if (arg == "--show-ui") {
                config.showUi = true;
            } else if (arg == "--help" || arg == "-h") {
                printUsage();
                return 0;
            } else {
                fprintf(stderr, "Unknown option: %s\n", arg.c_str());
                return 1;
            }
        }

        if (!hasOutput) {
            fprintf(stderr, "Error: --output <dir> is required for scan command\n");
            return 1;
        }

        // If no source specified, list and pick first
        if (config.sourceName.empty()) {
            TwainController listController;
            auto sources = listController.listSources();
            if (sources.empty()) {
                fprintf(stderr, "Error: No TWAIN scanners found\n");
                std::string json = "{\"status\":\"error\",\"message\":\"No TWAIN scanners found\"}";
                printf("%s\n", json.c_str());
                return 1;
            }
            config.sourceName = sources[0].name;
            fprintf(stderr, "[ScannerBridge] Auto-selected source: %s\n", config.sourceName.c_str());
        }

        TwainController controller;
        controller.setProgressCallback([](int page, const std::string& side, const std::string& status) {
            fprintf(stderr, "[ScannerBridge] Page %d %s: %s\n", page, side.c_str(), status.c_str());
            fflush(stderr);
        });

        ScanResult result = controller.scan(config);
        std::string json = scanResultToJson(result);
        printf("%s\n", json.c_str());
        fflush(stdout);

        return result.success ? 0 : 1;
    }

    fprintf(stderr, "Unknown command: %s\n", command.c_str());
    printUsage();
    return 1;
}
