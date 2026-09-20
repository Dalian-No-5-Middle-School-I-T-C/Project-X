# 04 PDF渲染可耗尽已认证模型辅助服务资源

- 原标题：PDF rendering enables authenticated sidecar resource exhaustion
- 云端级别：High
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/8abd069173b88191a6aa18aebf56ebfd?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=)
- 关联提交：[20e4e08](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/20e4e085ec293c3f27f6d6ae7c6af5be63015681)

## 概要

本提交新增本地解析危险处理点：直接多模态路径此前向提供商转发文件，现在无条件调用 normalize_direct_files，在 Project-X Python 辅助服务内解码并渲染 PDF，缺少资源隔离和复杂度限制。

普通阅卷权限教师在配置视觉模型后，可上传 PDF 并调用知识点分析。上传只查扩展名及单文件 50 MB，不验证 PDF 魔数、压缩流大小、对象数量、页面复杂度或请求总量。函数完整 base64 解码后，以 PyMuPDF 在进程内同步打开、渲染每页，并保留所有 JPEG 的 base64 字符串直至结束。40 页及 2048 像素目标不能限制单页压缩／绘图复杂度。同步 FastAPI 处理中的原生渲染不会因 Node 60 秒请求超时可靠终止，重复调用可占满线程、CPU 和内存。

原报告建议在受资源约束的子进程中转换，设置硬超时，校验 PDF 魔数、输入总量和解压内容总量，并限制分析调用频率。

## 验证

确认默认非管理员教师有 GRADE_WRITE，能上传并调用配置视觉模型时的多模态路径；存储的 PDF 在提供商调用前被 base64 转发到本地 PyMuPDF。真实 normalize_direct_files 处理一个 940 字节、单页、含 10000 次重复描边的有效 PDF 耗时 64.643 秒，约 85844 KiB RSS，超过 Node 的 60 秒超时。

真实 FastAPI HTTP 请求使用 722 字节变体，在客户端 1 秒后断开后，随后 5 秒 CPU ticks 仍从 268 增至 775；三个断开的并发请求让四个服务线程继续活跃。证明共享资源持续消耗，并非只让攻击者自己等待。

## 证据说明与攻击路径

扩展名／单文件大小校验通过 → POST /api/cards/:cardId/paper 存储原始 PDF → POST /api/cards/:cardId/knowledge-points/analyze 读取 original*.pdf 为 base64 → resolveKnowledgePointMode 选择 direct → 带内部密钥和 60 秒 AbortController 的 fetchLlmClient → 回环 8766 的 /analysis/knowledge-points → run_direct_multimodal 无条件 normalize_direct_files → PyMuPDF page.get_pixmap 长时间解释内容流 → 客户端取消后 CPU 与线程继续占用。

所有 PDF 完整解码、所有输出图片累计驻留；限制页数／DPI 不等于限制解压复杂度、耗时或内存，Node 超时也不是渲染硬上限。

## 分级、前提与已有控制

发生可能性高：普通教师正常工作流、无需受害者交互，恶意 PDF 可小于 1 KB，且没有分析专属限速／并发控制。影响程度高：持续占用共享辅助服务 CPU 和线程，可扰乱阅卷期间 AI 功能或争抢同机资源。需要已认证教师、现有可上传试卷的卡片、视觉提供商及可达 Node 入口；这是正常业务前提，不是主机管理员前提。未证明 RCE、窃密、成绩篡改或跨实例传播，所以归高危而非严重。

认证默认启用，外层 POST 要求 GRADE_WRITE；辅助服务默认回环地址并要求 LLMCLIENT_INTERNAL_API_KEY；上传最多 40 文件、每份 50 MiB；PDF 总页数 40，最高 300 DPI，名义最长边 2048 像素；Node 请求 60 秒超时；CORS 有允许列表。上述控制防止匿名直接调用，但 Express 会合法桥接教师请求，且小型单页恶意内容仍可通过。未发现分析队列、渲染并发限制、硬子进程超时、CPU／内存配额、解压总量限制或有效取消机制，只有登录限流。

## 盲点

未证明任何具体实例对公网开放；运行时是否有视觉模型和可用答题卡未知。动态验证涵盖真实规范化函数和带认证 FastAPI 端点，没有执行完整浏览器／Node／数据库／提供商链。耗时及达到完整停机所需请求量取决于硬件、PyMuPDF、Uvicorn／AnyIO 线程池和外部容器限制。测得持续 CPU、线程占用及中等 RSS，没有证明进程崩溃、灾难性内存耗尽或 Node 连带停机。仓库没有基础设施代码证明存在 cgroup、服务管理器配额、反代限额或外部 WAF。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/20e4e085ec293c3f27f6d6ae7c6af5be63015681/llmclient/pdf_to_images.py#L25-L43)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/20e4e085ec293c3f27f6d6ae7c6af5be63015681/llmclient/providers_knowledge_points.py#L103-L114)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/20e4e085ec293c3f27f6d6ae7c6af5be63015681/src/apps/answer-card/server/paper-converter.ts#L23-L30)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/20e4e085ec293c3f27f6d6ae7c6af5be63015681/src/apps/answer-card/server/routes/paper-routes.ts#L515-L531)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-4)。
