# 08 无上限批注可持续阻断布局与PDF生成

- 原标题：Unbounded annotations enable persistent layout and PDF DoS
- 云端级别：High
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/ae21198237b08191be712769f9ad01be?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=)
- 关联提交：[81ad500](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/81ad50044fd0a070c9570742a60cf270cb31f08b)

## 概要

本提交新增持久化 annotation 和逐行布局／渲染，仅在客户端设置 maxLength=160。PUT /api/cards/:cardId 接收自由格式卡片体，normalizeCard() 展开主观题 ...q 时未校验批注类型或长度；已有作文网格、目标字数等放大参数限制也未覆盖该字段。

布局规范化整个字符串，按单元格宽度切行，为每行分配文本与矩形对象。填空题分页在估高和最终构造时重复执行；saveCardWithLayout() 随后序列化放大后的布局到磁盘。约 8 MB ASCII 可生成约十万对象、大量瞬时分配及事件循环工作。SQLite TEXT 可保留长值，后续布局、识别准备及 PDF 再次触发，PDFKit 还逐行渲染。普通教师默认有写权限，缺通用限流，并发可能耗尽堆或垄断 Node。

原报告建议在 buildLayout() 前将 annotation 限制为短字符串，并限制布局总行数与输出大小。

## 验证及证据

真实认证 Express 接口接受普通教师 7500000 字符批注并返回 200，完整保存，生成 108696 行对象及 34315466 字节布局文件，后续布局响应 14618017 字节。生产 createPdf() 函数基准耗时 35.07 秒、输出 57801015 字节，峰值 RSS 约 2.84 GB（约 2.64 GiB）。存储后真实 API 重载再次触发布局工作。

代码证据：160 字限制只在编辑器；服务端 ...q 不限批注；写库之前已构建布局；整段文本切成无界行数组，每行独立对象；分页反复估算；PDFKit 每行执行文本绘制。

## 攻击路径与分级

普通教师 → 小于全局 8 MiB 的超长批注 PUT → 通用 grade:write 门禁 → normalizeCard 无字段限制 → buildLayout 多次切行分配 → SQLite 与格式化布局 JSON 存储 → 后续 layout/pdf 请求反复处理 → 共享 Node 的 CPU、内存、磁盘、带宽及事件循环承压。

发生可能性高：一次正常授权写入、无需竞态或复杂链，浏览器限制易由直接 API 绕过；发生在支持的 SQLite＋隧道／代理部署。影响程度高：单卡放大为十万对象、数十 MB 持久化／输出和数 GiB 进程内存，可能影响其他用户的卡片、扫描、阅卷和分析。设计卡片权限不等于消耗共享服务的授权，不属仅自身或运维专属问题。没有 RCE、管理员接管、整库泄漏或隐蔽系统性改分，故高危。

## 假设条件及已有控制

默认认证开启，攻击者是普通或被攻陷教师会话，有 grade:write，可提交带填空主观题长批注的卡。Node 监听 127.0.0.1:5174，远程需运维代理或可选 Cloudflare Quick Tunnel；持续重放已在 SQLite 证明。MariaDB TEXT 容量可能拒绝长值，但构建布局发生在数据库更新前，因此不能阻止前置计算放大。

控制包括默认身份校验、教师写权限、8 MiB JSON 上限、客户端 160 字限制、回环监听、CORS 允许列表和 MariaDB 字段容量。无服务端批注校验、总元素／输出限制、布局或 PDF 专属限流和并发上限。带认证的非浏览器请求不受 CORS 防护。受限 JS 堆的纯布局测试未崩溃，但 PDF 主要外部／ArrayBuffer 分配不受那些堆上限充分限制。

## 盲点

没有实际进程终止、主机 OOM、磁盘耗尽或并发压力证明；阈值受硬件、Node、PDFKit 和进程监管影响。PDF 基准直接调用生产 createPdf 并排空流，没有并发完整 HTTP PDF 测试。持久化重放仅在 SQLite，MariaDB 可能拒绝持久化。未知部署是否开放公网或添加了容器限额、自动扩容、工作进程隔离、反代限额和外部限流。未量化每种生产环境致死所需并发数，也不主张泄密或改分。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/apps/answer-card/client/pages/DesignEditors.tsx#L763-L772)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/apps/answer-card/server/index.ts#L179-L205)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/apps/answer-card/server/pdf.ts#L421-L423)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/shared/layout.ts#L712-L719)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-8)。
