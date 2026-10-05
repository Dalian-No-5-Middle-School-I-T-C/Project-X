#pragma once

#include <filesystem>
#include <string>
#include <vector>

/**
 * 安全 R19：原生识别器的资源边界。
 *
 * 识别器是服务端/扫描端拉起的子进程，输入（答题卡图片、布局 JSON、DPI）来自文件与 HTTP 请求，
 * 在解码与 OpenCV 分配之前必须自己先把边界收住：一张几十 KB 的 PNG 可以声明 60000×60000，
 * 一份布局 JSON 可以写 width=1e9 或十万个 items，`--dpi 1e9` 会让 mm→px 溢出成负尺寸。
 * 越界一律抛 std::runtime_error，由 wmain 统一转成 {"status":"failed"} JSON + 退出码 2。
 *
 * 档位与服务端其他上限一致：**默认值 + PROJECTX_RECOGNIZER_* 环境变量覆盖 + 安全天花板**。
 */
struct RecognizerLimits {
    long long max_image_bytes = 0;
    long long max_image_pixels = 0;
    long long max_layout_bytes = 0;
    long long max_layout_items = 0;
    long long max_layout_mm = 0;
    int min_dpi = 0;
    int max_dpi = 0;
};

/** 生效档位；进程内只解析一次，首次调用时把摘要写到 stderr。 */
const RecognizerLimits& recognizer_limits();

/** 全部可覆盖的环境变量名（顺序与 README 表格一致，验收脚本按此比对）。 */
const std::vector<std::string>& recognizer_limit_env_vars();

/** 一行生效摘要。 */
std::string describe_recognizer_limits();

/** 整份读入文件并校验大小上限；不存在、打不开、超限都抛 std::runtime_error。 */
std::vector<unsigned char> read_capped_file(const std::filesystem::path& path, long long max_bytes, const std::string& what);

/** 像素预算校验：pixels ≤ max_image_pixels，否则抛（含如何调整档位的提示）。 */
void assert_pixel_budget(long long pixels, const std::string& what);

/** DPI 必须落在 [min_dpi, max_dpi]；越界抛错而不是静默夹紧——夹紧会让 mm→px 缩放失真。 */
void assert_recognizer_dpi(int dpi);
