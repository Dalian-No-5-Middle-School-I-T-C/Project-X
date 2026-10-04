// Local recognition and remote page storage must accept the same original image.
// MAX_SCAN_IMAGE_BYTES is a per-file limit; the *TOTAL* constants below bound the
// whole multipart request (安全 R28)，两者必须同时成立。
export const MAX_SCAN_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * 安全（R22）：一个远程扫描会话允许的最大页数。
 * pageCount 由扫描端上报，直接决定会话创建时写入的待上传记录与令牌数量。
 * 200 页 = A4 双面一次连扫 100 张卡，明显高于真实使用上限。
 */
export const MAX_SCAN_SESSION_PAGES = 200;

/** 安全（R07/R28）：一次页面上传请求最多携带的切块数量（扫描端单页题块数远小于此）。 */
export const MAX_CROPS_PER_REQUEST = 50;

/** 单张切块是题块裁图，不是整页原卷；12 MiB 足够容纳 300dpi 的整栏主观题大块。 */
export const MAX_CROP_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * 安全（R28）：一次切块上传请求的累计字节预算。
 * 此前是 MAX_CROPS_PER_REQUEST × MAX_SCAN_IMAGE_BYTES = 2.5 GiB 全部进服务端内存。
 */
export const MAX_CROPS_TOTAL_BYTES = 160 * 1024 * 1024;

/** 安全（R28）：一次扫描页上传请求只允许一张原卷图，累计预算留出余量。 */
export const MAX_SCAN_PAGE_REQUEST_TOTAL_BYTES = 64 * 1024 * 1024;

/** 安全（R28）：批量判分/识别上传的文件数上限（整场扫描一次提交仍有余量）。 */
export const MAX_GRADING_BATCH_FILES = 300;

/**
 * 安全（R28）：批量判分/识别上传的累计字节预算（落盘，非内存）。
 * 取 1 GiB：历史验收用例是 24 张 × 3 MiB（72 MiB）必须通过，300 张真实 300dpi
 * 原卷约 1 GiB 已覆盖一整场考试；再大就是磁盘占用与处理时间风险，需要分批上传。
 */
export const MAX_GRADING_BATCH_TOTAL_BYTES = 1024 * 1024 * 1024;
