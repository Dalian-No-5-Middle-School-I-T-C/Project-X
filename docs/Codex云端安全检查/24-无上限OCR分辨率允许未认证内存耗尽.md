# 24 无上限OCR分辨率允许未认证内存耗尽

- 原标题：Unbounded OCR DPI enables unauthenticated memory exhaustion
- 云端级别：High
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/dd298a78fd4c81918f01179a624f42b8?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[577623c](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/577623c7269489e827fdcd523f409c9677b2c387)

## 概要

本提交新增无认证 /api/cards/:cardId/recognition/objective，并把 multipart 或查询字符串中的 dpi 传给原生识别。路由只要求有限且正，原生也只拒非正数。尺寸按 page_mm/25.4*dpi 计算后直接用于 cv::warpPerspective，无像素、维度、进程并发或内存限制。

匿名调用者可先通过无认证创建卡片，再提交可解码且含定位标记的图像。默认 A4 在 3000 DPI 下约 24803×35079 像素，单三通道目标矩阵需要 2610193311 字节（约 2.43 GiB），尚不计中间结果。每请求独立子进程，30 秒 kill 发生在启动后，不能防提前分配；并发可造成换页／OOM。建议合理 DPI 上限、分配前像素总量检查、识别并发额度、授权与限速。

## 验证及证据

真实 Express 无凭据创建卡片和请求识别，默认布局含所需标记／客观题；dpi=3000 精确进入 --dpi 3000 参数，三个请求产生三个重叠 PID。源码追踪像素计算及 warpPerspective，并计算上述字节数。使用无害识别器替身，未执行 Windows/OpenCV 生产二进制，也未观察真实 OOM 或服务故障。

## 攻击路径与分级

匿名网络请求 → 公开代理／回环服务 → 无认证建卡和识别 → 正值 DPI 校验 → 每请求 spawn → 原生无上限尺寸 → OpenCV 多 GiB 分配并发 → 主机／服务资源压力。

发生可能性按给定公开模型为高：卡片、布局、PDF 都可匿名取得，标记图像前提合理，无账号或特权要求。影响程度高：多进程放大内存与 CPU，可扰乱同机业务。没有真实原生 OOM、远程依赖部署模型、仅可用性单实例影响，所以高危而非严重；严格本地模式会显著降低报告性。

## 假设、控制与盲点

原生识别器已安装或配置 ANSWER_CARD_RECOGNIZER_EXE；卡片有客观选项；上传图像可解码，至少四个适当标记和有效单应性；请求大正整数 DPI；服务公开且无仓库外资源配额。

已有控制含回环监听、源图 20 MiB、卡片及客观布局存在检查、标记／单应性要求、30 秒 kill、捕获 std::exception（部分分配失败可变为失败结果）。没有认证、DPI／输出像素上限、全局并发／进程／内存配额。

历史提交无公开入口 manifest；README/Electron 只证明本地监听。Linux 环境无可运行 Windows 二进制且缺 OpenCV 开发依赖，替身仅证明参数传播和并发创建，不证明实际分配失败。OpenCV／Windows、RAM／pagefile、请求数量、外部反代限速、防护软件、Job Object／cgroup 及容器配额均影响实际后果。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/577623c7269489e827fdcd523f409c9677b2c387/native/AnswerCardRecognizer/answer-card-recognizer/answer_recognition.cpp#L341-L345)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/577623c7269489e827fdcd523f409c9677b2c387/native/AnswerCardRecognizer/answer-card-recognizer/layout_io.cpp#L221-L228)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/577623c7269489e827fdcd523f409c9677b2c387/src/apps/answer-card/server/index.ts#L92-L98)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/577623c7269489e827fdcd523f409c9677b2c387/src/apps/answer-card/server/recognition.ts#L44-L75)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-24)。
