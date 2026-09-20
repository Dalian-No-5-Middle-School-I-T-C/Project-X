# 04 PDF渲染可耗尽已认证模型辅助服务资源

- 原标题：PDF rendering enables authenticated sidecar resource exhaustion
- 云端级别：高危（High）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/8abd069173b88191a6aa18aebf56ebfd?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=)
- 关联提交：[20e4e08](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/20e4e085ec293c3f27f6d6ae7c6af5be63015681)

- 页面时间：2026 年 8 月 31 日 13:33（原页面未注明时区）。
- 操作者：火箭。

## 概要

本提交引入了存在问题的本地解析入口。此前，直接多模态路径将上传文件转发给配置的提供商；现在它无条件调用 normalize_direct_files，在 Project-X 辅助服务内部解码和渲染 PDF，没有资源隔离或复杂度限制。

配置支持视觉的提供商时，具有普通判分权限的教师可以上传 PDF 并调用知识点分析端点。上传验证只限制单文件 50 MB，并检查扩展名，不验证 PDF 魔数，也不限制压缩流大小、对象数量、页面复杂度或请求总大小。新增 normalize_direct_files 路径对每份 PDF 做 base64 解码，再用 PyMuPDF 同步打开并渲染每一页。40 页上限和 2048 像素输出目标不能限制解压、解释页面内容流所需的工作；单页 PDF 也可能包含高度压缩或病态复杂的图形。实现还会将每张渲染后的 JPEG 保存为另一份 base64 字符串，直到所有页面处理结束。FastAPI 处理函数为同步函数，因此 Node 请求在 60 秒后终止，并不能可靠中断正在运行的原生渲染。重复分析请求可占用辅助服务工作线程、CPU 和内存，在判分期间干扰 AI 功能或宿主机。转换应放入有资源限制的子进程，设置硬执行超时，验证 PDF 魔数并限制总输入/解压内容，同时限制分析请求频率。

## 验证

1. 可达性与控制：配置视觉提供商后，默认非管理员教师具有上传可接受 PDF 并调用多模态知识点路径所需权限。
2. 数据流与危险入口：攻击者控制的已存 PDF 字节以 base64 转发给 normalize_direct_files，并在向提供商发送数据前由 PyMuPDF 在进程内同步渲染。
3. 缺失的有效控制：页数、DPI 和输出尺寸不限制内容流绘制复杂度、渲染 CPU 时间，也不提供隔离的硬超时。
4. 现实影响：一份有效的 940 字节单页 PDF，通过真实归一化实现可重复耗时 64.643 秒，超过 Node 调用方的 60 秒超时。
5. 操作持续性：真实 HTTP 测试显示客户端取消后仍继续渲染；三个并发且已经断开的请求仍在不同辅助服务线程中运行，没有分析专用频率/并发限制。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 受攻击者影响的 PDF 被打开，每个允许页面都在进程内同步渲染；只限制页数和输出 DPI，不限制解压流复杂度、执行时间或内存。
2. 每份 PDF 完整 base64 解码，所有渲染页图像累计保存为 base64 字符串，没有总字节上限。
3. 修改后的直接多模态路径无条件归一化文件，在提供商调用之前引入本地 PDF 解码和渲染。
4. 上传端验证按扩展名和 50 MB 单文件上限放行，没有 PDF 内容或解压复杂度检查。
5. 已认证知识点请求将已存 PDF 转发至同步转换路径；60 秒客户端超时不是渲染的硬执行上限。

## 攻击路径分析

已确认影响为高，因为可执行验证展示了客户端取消后仍持续占用共享 CPU 和工作线程，符合威胁模型中判分期间已认证资源耗尽的高影响可用性类别。可能性为高，因为默认具有 GRADE_WRITE 的普通教师可以远程使用受支持的上传和分析流程，恶意文档可以合法且极小，也不存在渲染限流或并发控制。按矩阵，影响高、可能性高得到高危，除非另外满足严重条件。本问题不应定为严重，因为已证明效果限于单一部署可用性，需要教师认证与视觉提供商配置，没有证明 RCE、数据失陷、成绩破坏或整个客户端群体受影响。不适用强制排除：并非仅影响本人，也不是仅操作者、开发者或物理访问能触发；教师正常的受保护写入权限是预期低权限业务流程，而非管理员前提。

### 路径

具有 GRADE_WRITE 的认证教师 → 上传通过扩展名及单文件大小检查的 .pdf → 5174 端口 Express POST /api/cards/:cardId/paper → PDF 原样复制到答题卡试卷存储 → 攻击者控制的有效 PDF → 路由把已存 original*.pdf 读为 base64 → POST /api/cards/:cardId/knowledge-points/analyze → 配置提供商支持视觉时选择 direct 模式 → Node fetchLlmClient，带 60 秒 AbortController 超时 → 携内部辅助服务 Bearer 密钥转发文件 → localhost:8766 上的 FastAPI /analysis/knowledge-points → 同步处理函数在提供商出站调用前执行归一化 → normalize_direct_files 与 PyMuPDF page.get_pixmap → 无上限内容流解释在客户端取消后继续 → 持续消耗 CPU 和并发工作线程。

攻击过程：恶意或失陷教师通过正常原始试卷流程上传包含大量昂贵绘制操作的有效、高压缩 PDF，然后在配置视觉提供商的情况下启动知识点分析。答题卡路由将已存 PDF 读为 base64，转发到内部 LLM 辅助服务。在选择或联系外部提供商之前，run_direct_multimodal 调用 normalize_direct_files，完整解码 PDF 并用 PyMuPDF 同步渲染每页。页数、DPI 和栅格长边限制并不约束页面内容流解释的复杂度。所提供可执行验证使用仓库真实实现：含 10,000 次重复描边操作的有效 940 字节单页 PDF，归一化耗时 64.643 秒，RSS 约 85,844 KiB。另一个 722 字节版本发送到真实 FastAPI 端点后，客户端在一秒时断开，此后五秒进程 CPU tick 从 268 增至 775。三个断开的并发请求使服务保持四个活动线程并继续消耗 CPU。这证明影响共享可用性，而不只是让攻击者自己的响应变慢。最重要的范围反向证据是 Node 监听 127.0.0.1，辅助服务默认 127.0.0.1:8766 且需要 LLMCLIENT_INTERNAL_API_KEY，外层路由受 GRADE_WRITE 保护。这些阻止未认证者直接访问辅助服务，但不能否定漏洞：受支持 Node 产品路由会有意将教师请求桥接到辅助服务，仓库也描述公开流量的代理/隧道入口。最强技术防护为单文件 50 MiB、总计 40 页、300 DPI 上限、2048 像素长边及 Node 60 秒超时；但输入是合法、不到 1 KB 的单页 PDF，断开后渲染仍继续，因此这些控制不足。证明范围为持续 CPU 和并发线程消耗，没有证明原生代码执行、秘密披露、成绩破坏、崩溃或完整宿主机停机。

## 发生可能性

**高。** 路径是默认教师可用的正常远程产品流程，无需受害者交互，接收有效且不足 1 KB 的单页 PDF，没有分析限流或并发限制。认证、已有答题卡和已配置视觉提供商是有意义但普通的运行前提，并非难以实现的高权限准备。辅助服务回环监听不能阻止利用，因为 Express 会有意转发请求。**攻击向量：远程网络。**

## 影响程度

**高。** 重复已认证请求可在调用者断开后持续消耗共享辅助服务 CPU 和执行线程，干扰判分时的 AI 功能，并可能与同机其他服务争用资源。可执行证明确认了长时间 CPU 和并发线程占用。影响限于可用性，没有代码执行、凭据披露、成绩修改或跨机器传播证据。

## 假设条件

- 生产采用仓库默认开启的认证，未显式关闭 PROJECTX_AUTH_ENFORCE。
- 合法或失陷教师具有默认 GRADE_WRITE，且能访问一张可保存原始试卷的答题卡。
- 已配置支持视觉的知识点提供商，使 resolveKnowledgePointMode 选择直接多模态路径。
- 部署通过仓库及给定威胁模型所述反向代理/隧道公开回环 Node 服务。
- PyMuPDF 耗时依硬件和版本而变，但可执行验证证明合法不足 1 KB 输入可超过应用 60 秒超时。

原文另列的利用前提：

- 有 GRADE_WRITE 的已认证教师会话。
- 一张允许教师上传原始试卷的既有答题卡。
- 已配置支持视觉的 AI 提供商。
- 上传有效但病态复杂的 PDF，然后发起知识点分析。
- 若要更广泛降低服务性能，需要重复或并发请求。

## 控制措施

- 认证默认开启，外层 POST 路由需要 GRADE_WRITE。
- 辅助服务默认 localhost，/analysis/knowledge-points 要求 LLMCLIENT_INTERNAL_API_KEY。
- 试卷上传最多 40 个文件，单个 50 MiB。
- PDF 转换总计最多 40 页、最高 300 DPI，栅格长边名义上限为 2048 像素。
- Node 到辅助服务请求采用 60 秒 AbortController 超时。
- CORS 有允许列表，但不能防御恶意已认证 API 客户端。
- 只发现登录专用限流，没有分析限流、队列或渲染并发控制。
- PyMuPDF 渲染没有子进程硬超时、CPU 配额、内存限制、解压内容上限或取消机制。

## 盲点

- 没有部署清单证明某实例确有互联网代理/隧道；源代码注释及给定生产威胁模型支持这种暴露，但仍依具体部署。
- 可执行验证执行真实归一化函数及已认证 FastAPI 端点，没有覆盖完整浏览器/Node/数据库/提供商端到端部署。
- 完全阻断辅助服务或宿主机所需请求量取决于 CPU、Uvicorn/AnyIO 线程池行为、PyMuPDF 版本及仓库未体现的外部进程/容器限制。
- 证明测量了持续 CPU、线程占用和适度 RSS，而不是进程崩溃、灾难性内存耗尽或 Node 连带故障。
- 视觉提供商与可用答题卡是否存在属于运行状态，不能从仓库确定。
- 仓库没有 IaC 证明主机 cgroup、服务管理器限制、反向代理请求限制或外部 WAF/限流。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [llmclient/pdf_to_images.py:25](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/20e4e085ec293c3f27f6d6ae7c6af5be63015681/llmclient/pdf_to_images.py#L25)

~~~~python
def pdf_bytes_to_images(pdf_bytes: bytes, max_pages: int = MAX_AI_PAGES) -> list[dict[str, str]]:
    """把一份 PDF 渲染成压缩 JPEG 页图（base64），每页长边 <= 2048。"""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page_count = doc.page_count
        if page_count > max_pages:
            raise PdfPageLimitError(
                f"PDF 共 {page_count} 页，超过多模态直传上限 {max_pages} 页"
            )
        images: list[dict[str, str]] = []
        for page in doc:
            long_pt = max(page.rect.width, page.rect.height)
            dpi = min(MAX_DPI, int(LONG_EDGE * 72 / long_pt))
            pix = page.get_pixmap(dpi=dpi)
            data = pix.tobytes("jpeg", jpg_quality=JPEG_QUALITY)
            images.append({"mimeType": "image/jpeg", "base64": base64.b64encode(data).decode()})
        return images
    finally:
        doc.close()
~~~~

### [llmclient/pdf_to_images.py:46](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/20e4e085ec293c3f27f6d6ae7c6af5be63015681/llmclient/pdf_to_images.py#L46)

~~~~python
def normalize_direct_files(files: list[dict[str, str]], max_pages: int = MAX_AI_PAGES) -> list[dict[str, str]]:
    """直传前归一化：PDF 转压缩页图，图片原样保留。"""
    out: list[dict[str, str]] = []
    pdf_pages_used = 0
    for f in files:
        mime = (f.get("mimeType") or "").lower()
        if mime == "application/pdf":
            page_images = pdf_bytes_to_images(
                base64.b64decode(f["base64"]),
                max_pages=max_pages - pdf_pages_used,
            )
            out.extend(page_images)
            pdf_pages_used += len(page_images)
        else:
            out.append(f)
    return out
~~~~

### [llmclient/providers_knowledge_points.py:103](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/20e4e085ec293c3f27f6d6ae7c6af5be63015681/llmclient/providers_knowledge_points.py#L103)

~~~~python
def run_direct_multimodal(
    model: ModelConfig,
    files: list[dict[str, str]],
    subject: str,
    question_range: str,
    extra_notes: str,
    answer_card_json: str = "",
    provider_override: dict[str, str] | None = None,
) -> dict[str, Any]:
    """直传图片给多模态模型 (Gemini / GPT)."""
    # PDF 原卷先转压缩页图（OpenAI 兼容接口不接受 PDF data URL）
    files = normalize_direct_files(files)
~~~~

### [src/apps/answer-card/server/paper-converter.ts:23](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/20e4e085ec293c3f27f6d6ae7c6af5be63015681/src/apps/answer-card/server/paper-converter.ts#L23)

~~~~typescript
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export function validatePaperFile(filename: string, size: number): string | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".doc") return "不支持 .doc 格式，请转为 .docx 后上传";
  if (!ALLOWED_EXTENSIONS.has(ext)) return `不支持 ${ext} 格式，请上传 DOCX/PDF/图片文件`;
  if (size > MAX_FILE_SIZE) return `文件过大（${(size / 1024 / 1024).toFixed(1)}MB），最大 50MB`;
  return null;
~~~~

### [src/apps/answer-card/server/routes/paper-routes.ts:515](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/20e4e085ec293c3f27f6d6ae7c6af5be63015681/src/apps/answer-card/server/routes/paper-routes.ts#L515)

~~~~typescript
      if (isMultimodal) {
        // 多模态：读取文件 → base64 → 直传
        const files = await getPaperFiles(cardId);
        if (files.length === 0) {
          await finalizeAiRun(runId, { success: false, errorCode: "NO_FILES" });
          res.status(400).json({ error: "NO_FILES", message: "未找到原卷文件" });
          return;
        }

        const resp = await fetchLlmClient("/analysis/knowledge-points", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode, providerId: provider.providerId, model: provider.model, providerOverride: provider.providerOverride,
            subject, questionRange: range, extraNotes: notes, files, answerCardJson,
          }),
        }, 60_000, { runId, provider: "llmclient", model: provider.model ?? null, stage: "knowledge_points" });
~~~~
