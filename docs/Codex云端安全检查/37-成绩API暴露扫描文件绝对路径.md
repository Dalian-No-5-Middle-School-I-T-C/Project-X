# 37 成绩API暴露扫描文件绝对路径

- 原标题：Score API exposes absolute scanner file paths
- 云端级别：Low
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/b4bf0da3256881919e1f6e8345eea83d?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[e6ba585](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/e6ba5853e31ff93b79ff52bc458bed762e78cb0c)

## 概要

本提交在原仅返回扫描 ID 和页码的成绩详情中新增 sr.file_path，直接别名 fileName 输出。正常 Multer file.path 来自绝对数据目录，可暴露部署目录和操作系统账号名。GET /api/exams/:examId/student/:studentId/scores 对 exam:read 教师可达；关闭认证兼容模式还可匿名。客户端再把整个路径 URL 编码放入图像请求，可能进入浏览器及代理日志。

图像服务立即 path.basename 后在固定上传目录解析，目录部分完全没必要，应仅返回 basename 或独立 file_name。该行为不导致任意文件读。

## 验证、路径与分级

真实生产 Express 测试中，认证开启的默认教师取得 /srv/project-x/private-data/recognition/uploads/12345678/scan_secret.png 原值；学生和匿名被拒；关闭认证后匿名成功。Multer 到数据库来源静态追踪，API 与图像服务动态执行。

扫描绝对路径入库 → 成绩详情原样 scans[].fileName → 客户端编码图像 URL → 可能日志扩散 → 图像路由 basename 限定读取。正常扫描状态、简单 GET、默认权限及支持的 Nginx 公网部署使可能性高；影响低，仅部署元数据，无秘密、文件内容、改分、提权、执行或停机。最终低危。

## 假设、控制与盲点

有效考试／卡片／学生／批次／非空 file_path，知道数值 IDs，有 exam:read 或关闭认证，服务可达。optionalAuth、强制模式 401/403、学生无 exam:read、数值及存在检查、null 路径过滤、固定目录 basename 和回环监听存在，无可执行 sink。

未跑完整原生 OCR；路径来源静态建立。实际公网、日志保留、路径中的账号名等依配置。不能从本项推导路径穿越或任意文件读。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e6ba5853e31ff93b79ff52bc458bed762e78cb0c/src/apps/answer-card/client/components/ScoreFixPage.tsx#L311-L315)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e6ba5853e31ff93b79ff52bc458bed762e78cb0c/src/apps/answer-card/server/scanner/index.ts#L312-L321)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e6ba5853e31ff93b79ff52bc458bed762e78cb0c/src/server/routes/score-editing.ts#L87-L99)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-37)。
