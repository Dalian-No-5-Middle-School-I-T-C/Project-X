# 24 无上限OCR分辨率允许未认证内存耗尽

- 原标题：Unbounded OCR DPI enables unauthenticated memory exhaustion
- 云端级别：高危（High）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/dd298a78fd4c81918f01179a624f42b8?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[577623c](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/577623c7269489e827fdcd523f409c9677b2c387)

- 页面时间：2026 年 6 月 10 日 20:04（原页面未注明时区）。
- 操作者：chuh。

## 概要

本次提交新增存在问题的识别路由及原生处理路径。此前服务端不会将请求控制的 DPI 传入 OpenCV 内存分配。新路由只检查数值为正，原生尺寸计算没有校验，进程启动也没有限制，因此引入拒绝服务条件。

/api/cards/:cardId/recognition/objective 不要求认证，从 multipart 请求或查询参数读取 dpi，只验证它是有限正数。匿名用户可通过同样不要求认证的答题卡创建接口取得可用答题卡，上传包含预期六个标记的小图片，并指定过大的合法整数 DPI。该值直接传给原生识别器，按 page_mm/25.4*dpi 计算尺寸，再由 cv::warpPerspective 分配彩色目标图及中间数据。例如，3000 DPI 对应约 24,803×35,079 像素，仅三通道输出就约为 2.6 GB。Node 允许无限并行子进程，30 秒超时发生在内存分配之后，不限制内存、进程数或并发。重复并发请求可耗尽 RAM 和 CPU，引发系统级换页或内存耗尽终止，使考试服务不可用。应将 DPI 限制在较小范围，分配前检查总像素数，限制识别并发，并要求适当授权及限流。

## 验证

1. 通过真实 Express 确认，无凭据即可创建答题卡并调用识别；默认布局包含所需标记及客观题字段。
2. dpi=3000 通过有限正数检查，以精确的 --dpi 3000 参数传给子进程，原生代码没有上限。
3. 追踪 24,803×35,079 尺寸到 warpPerspective，计算出三通道目标图需要 2,610,193,311 字节。
4. 三个 HTTP 请求产生三个同时存活的进程 ID，没有并发、进程、内存、请求频率或像素限制；30 秒计时在进程启动后开始。
5. 由于没有可用二进制或兼容构建环境，未执行真实 Windows／OpenCV，也未观察实际内存耗尽或服务故障；对宿主机的实际干扰取决于环境。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 未经检查的 DPI 尺寸用于 OpenCV 变换后图像的内存分配。
2. 原生代码接受任意正 DPI，可能产生巨大尺寸，没有最大尺寸或像素检查。
3. 匿名调用方可创建识别所需的有效答题卡。
4. 新增匿名路由只检查可控 DPI 有限且大于零，然后调用原生程序。
5. 每个请求携带指定 DPI 启动新进程，没有并发或资源配额；超时要到 30 秒后才生效。

## 攻击路径分析

事实校准为高影响、高发生可能性；只有满足需要立即处理的严重级别标准时才映射为严重，否则为高危。这里仅涉及单服务或宿主机可用性，没有执行真实原生内存耗尽，远程可达性也依赖所提供的代理／隧道模型，因此不评为严重。不适用强制排除：影响不限于本人，不是高权限或操作者专用路径，前提现实，威胁模型建立了现实的匿名远程路径。最终为可报告的高危。

### 路径

匿名远程用户 → 不带凭据的 HTTP 请求 → 生产代理或隧道 → 回环服务 → 匿名创建答题卡及调用识别 → 接受 dpi>0 → Node 为每个请求启动无资源约束子进程并传入 --dpi → 原生代码执行未经检查的尺寸计算 → OpenCV warpPerspective → 并发分配数 GB 矩阵 → 服务或宿主机资源耗尽。

这是答题卡识别产品真实运行路径中的资源漏洞。Express 路由组合没有认证，创建答题卡和客观题识别都允许匿名调用。可控 dpi 经 Number 转换后，只要是有限正数就被接受；封装器为每个请求启动独立进程并原样传入参数。原生代码只拒绝非正数，根据纸张物理尺寸计算后分配图像。默认 A4 在 3000 DPI 下，仅三通道目标图就约为 2.43 GiB，尚未计入中间数据。可执行验证确认匿名创建答题卡、精确参数传递及三个并发子进程，但有意使用无害替身，没有复现实际内存耗尽。20 MiB 上传限制、标记及单应性前提、异常捕获、30 秒终止进程，都不能约束目标尺寸或并发分配。不涉及秘密数据流；被跨越的边界是匿名网络输入进入宿主机原生资源。关于暴露的最强反向证据是明确的回环监听，以及 README／Electron 中的本地流程；远程报告依赖所提供生产模型，若没有该部署，通常只是低可能性的本机问题。

## 发生可能性

高。在代理或隧道模型下，远程匿名用户可以访问。答题卡创建、布局及 PDF 也允许匿名调用，使构造标记图的前提可实现。DPI 和并发直接可控，验证证明了 HTTP 到子进程的参数传递及进程重叠。纯回环的打包 Electron 部署会降低可能性；外部代理或操作系统配额未知，但仓库中没有这些控制。攻击向量为远程网络。

## 影响程度

高。单次 3000 DPI A4 处理在计算中间数据之前就需要约 2.43 GiB。重叠进程进一步放大内存和 CPU 消耗，可能引起换页、内存耗尽，并干扰识别及同机其他服务。扫描和判分可用性在威胁模型中具有重要价值。实际失败取决于宿主机，没有执行真实内存耗尽，也没有证明整个设备群或持续失陷。

## 假设条件

- 按威胁模型通过代理或 Cloudflare 转发回环服务；提交内没有入口配置。
- 按打包生产预期安装原生程序，或通过 ANSWER_CARD_RECOGNIZER_EXE 配置它。
- 能提交可解码且至少具有四个位置适当标记的图片；匿名创建答题卡、布局和 PDF 使此前提现实可行。
- 不存在仓库之外的代理限流、操作系统作业对象、cgroup 或同等内存／进程配额；工作区代码无法确认这些外部控制。

原文另列前提：

- 威胁模型中的代理或隧道使回环服务远程可达。
- 已安装原生识别器。
- 创建或找到包含客观题选项的答题卡。
- 上传可解码且至少有四个匹配标记的图片。
- 在一个或多个请求中指定很大的正整数 DPI。

## 控制措施

- 服务绑定回环地址，远程访问需要威胁模型中的入口。
- 单张源图片限制为 20 MiB。
- 需要已有答题卡及包含客观题选项的布局。
- 原生识别需要图片可解码、存在合适标记候选、至少四个匹配标记及有效单应矩阵。
- 封装器在 30 秒后尝试终止进程，但内存可能早已分配。
- 原生代码捕获 std::exception，部分分配失败可返回失败结果。
- 没有应用认证或授权、DPI 最大值、像素上限、限流、并发限制、进程配额或内存配额。

## 盲点

- 提交没有公共入口清单，远程暴露判断来自所提供威胁模型。
- 已提交服务及 Electron 仅绑定回环地址；严格只按这些配置运行时，不会直接向远程暴露。
- 没有可运行 Windows 二进制，Linux 又缺少 OpenCV 开发依赖，无法构建。
- 无害替身只证明匿名参数传播和并发，没有证明实际分配失败、内存耗尽终止或停机。
- OpenCV／Windows 分配行为、RAM、页文件及所需请求数取决于部署。
- 外部代理限流、终端保护、Windows 作业对象、容器或宿主机配额可能降低可利用性，但仓库没有体现。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [native/AnswerCardRecognizer/answer-card-recognizer/answer_recognition.cpp:341](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/577623c7269489e827fdcd523f409c9677b2c387/native/AnswerCardRecognizer/answer-card-recognizer/answer_recognition.cpp#L341)

~~~~cpp
        const auto [homography, reprojection_errors, inliers] = estimate_homography(matches);
        const json quality = quality_payload(candidates, matches, missing_roles, reprojection_errors, inliers);

        const auto output_size = a4_pixel_size(layout_page.width_mm, layout_page.height_mm, output_dpi);
        cv::Mat warped = warp_to_layout(image, homography, output_size);
~~~~

### [native/AnswerCardRecognizer/answer-card-recognizer/layout_io.cpp:221](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/577623c7269489e827fdcd523f409c9677b2c387/native/AnswerCardRecognizer/answer-card-recognizer/layout_io.cpp#L221)

~~~~cpp
std::pair<int, int> a4_pixel_size(double width_mm, double height_mm, int dpi) {
    if (dpi <= 0) {
        throw std::runtime_error("DPI must be positive");
    }
    return {
        static_cast<int>(std::llround(width_mm / 25.4 * dpi)),
        static_cast<int>(std::llround(height_mm / 25.4 * dpi)),
    };
~~~~

### [src/apps/answer-card/server/index.ts:92](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/577623c7269489e827fdcd523f409c9677b2c387/src/apps/answer-card/server/index.ts#L92)

~~~~typescript
  app.post("/api/cards", async (_req, res, next) => {
    try {
      res.status(201).json(await createCard());
    } catch (error) {
      next(error);
    }
  });
~~~~

### [src/apps/answer-card/server/index.ts:136](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/577623c7269489e827fdcd523f409c9677b2c387/src/apps/answer-card/server/index.ts#L136)

~~~~typescript
  app.post("/api/cards/:cardId/recognition/objective", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await readCard(cardId);
      if (!card) {
        res.status(404).json({ message: "绛旈鍗′笉瀛樺湪" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "娌℃湁鏀跺埌鍥剧墖鏂囦欢" });
        return;
      }

      await readLayout(cardId);
      const pageNumber = Number(fieldValue(req.body.page || req.query.page) || "1");
      const dpi = Number(fieldValue(req.body.dpi || req.query.dpi) || "300");
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug ? path.join(dataDir, "processed", "recognition-debug", cardId, String(Date.now())) : undefined;
      if (debugDir) {
        await mkdir(debugDir, { recursive: true });
      }

      const result = await recognizeObjectiveAnswers({
        imagePath: req.file.path,
        layoutPath: layoutPath(cardId),
        pageNumber: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1,
        dpi: Number.isFinite(dpi) && dpi > 0 ? dpi : 300,
        debugDir
      });
~~~~

### [src/apps/answer-card/server/recognition.ts:44](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/577623c7269489e827fdcd523f409c9677b2c387/src/apps/answer-card/server/recognition.ts#L44)

~~~~typescript
export async function recognizeObjectiveAnswers(request: RecognitionRequest): Promise<RecognitionResult> {
  const exePath = resolveRecognizerExe();
  const args = [
    "--image",
    request.imagePath,
    "--layout",
    request.layoutPath,
    "--page",
    String(request.pageNumber),
    "--dpi",
    String(request.dpi)
  ];
  if (request.debugDir) {
    args.push("--debug-dir", request.debugDir);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
~~~~
