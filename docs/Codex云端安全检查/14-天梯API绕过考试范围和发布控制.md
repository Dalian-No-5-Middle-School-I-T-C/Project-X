# 14 天梯API绕过考试范围和发布控制

- 原标题：Ladder API bypasses exam scope and publication controls
- 云端级别：High
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/48b9de7cd8788191a657d4c51234340b?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=)
- 关联提交：[b1ac782](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/b1ac78210777fb697a37248af724053c81fe7c2b)

## 概要

本提交第 403 行首次挂载此前不可达的 /api/ladder 处理器。路由仅有 authMiddleware 与默认开启的全局开关；未用考试／分析权限门禁。只有 score:read 的学生及受班级／学科限制的教师，都能传入递增考试 ID 给 getScoreTableData。

单考不检查 requireExamAccess、班级／年级、学生是否参考或考试发布／关闭状态；仓储读取所有学生姓名、学号、班级、年级和分数，并返回前十。考试组接口读取所有成员考试并额外返回分科分数；跨考试接口未用 validateExamIdsAccess。学生可枚举草稿／阅卷中考试的同学结果，教师可跨范围。原报告建议学生路径落实发布及参考规则，教师路径在查分前调用现有考试范围校验。

## 验证及证据

真实路由、认证服务、schema、迁移、仓储和响应服务的 HTTP PoC：匿名 401；只有 score:read、没有目标参考关系也没有自身成绩的学生，读取另一班草稿考试得到 200，含两名同学身份、原始及赋分成绩。SQLite 和 MariaDB 初始化默认开启天梯。全局禁用确实生效，但不等于对象授权。

挂载位置在考试／分析门禁外；开关缺设置时也默认开放；任意 ID 进入无状态、身份范围约束的查询。返回字段含内部 ID、学号、姓名、班级、年级、原始分、赋分、排名。组和跨考的同类遗漏由源码追踪。

## 攻击路径与分级

低权限账号 → 公开支持入口 → 任意考试 ID 的 GET /api/ladder/exams/:examId → 身份及开关通过 → 无范围／参考／发布校验的全量分数查询 → 前十可识别他人教育记录。

发生可能性高：默认开启、数值 ID、单次认证请求，已动态证明。影响程度高：可跨班级和发布边界披露未发布成绩，跨组／跨考可重复扩大范围。非仅自身、管理员或主机权限前提；只读、每次前十，没有接管、RCE、整库提取或改分，最终高危。

## 假设、控制与盲点

账号有效、天梯开启、目标有成绩且 ID 可知／可猜，Web API 可达。认证支持 Bearer、Cookie 或受支持查询令牌；管理员可关闭功能；ID 要求有限数值；单考／考试组结果最多十人；回环监听经支持代理公开。没有专属限流、发布／参考／班级年级／教师范围校验。

未证明任何具体部署公网状态。完整 createApp 因缺 expr-eval 无法导入，动态挂载的是原生产路由及其依赖，正式挂载由源码证明。只动态验证单考，组和跨考未分别执行。学校榜单身份展示政策没有独立文档，但无法解释非考生读取别班草稿成绩。实际枚举速度和考试数量取决于数据。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/apps/answer-card/server/index.ts#L386-L403)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/db/schema.mariadb.sql#L622-L623)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/repositories/AnalysisRepository.ts#L249-L284)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/routes/ladder.ts#L20-L37)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/services/LadderService.ts#L29-L49)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-14)。
