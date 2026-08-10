# Project-X 快速问题处置报告

- 报告类型：正式快速处置版
- 生成日期：2026-07-21
- 锁定修订：b6db5bec6482fd0eafb139cc5cf610bcb161a397
- 审计范围：Project-X 全仓库第一方源代码、配置、脚本、清单及关键运行边界
- 适用目的：快速分派、修复排序、回归验证和版本治理
- 与主报告关系：本报告不替代主任务正在生成的全面安全报告；全面报告继续保留逐项源码证据、candidate ledger、攻击路径、无害 PoC 和结构化加固方案

## 一、执行摘要

本次标准扫描已关闭 224/224 个文件审查回执。123 个原始安全候选均有验证关闭记录，121 个进入攻击路径阶段的候选均有攻击路径回执。最终去重得到 57 个独立安全问题：严重 1 个、高危 28 个、中危 23 个、低危 5 个。

此外，首轮审查保留了 248 条逻辑、正确性、兼容性和可靠性观察，并整理为 38 组高价值问题。它们不一定具备低权限攻击路径，但会直接影响成绩持久化、扫描识别、备份恢复、数据库迁移、阅卷一致性、权限状态、会话可靠性和部署结果，因此同样需要进入工程处理队列。

本报告面向快速处理：每项只保留编号、风险、关键位置和主要修复方向。需要复核攻击前提、完整调用链、反证、严重度校准和无害验证材料时，应转到主任务的 findings/、coverage.json、candidate ledger 及最终 report.md。

## 二、结论统计

| 类别 | 数量 | 处理口径 |
| --- | ---: | --- |
| 严重安全问题 | 1 | 立即阻断并安排紧急回归 |
| 高危安全问题 | 28 | 纳入最近安全修复版本 |
| 中危安全问题 | 23 | 按边界分批修复并加入资源/授权测试 |
| 低危安全问题 | 5 | 与秘密治理、部署加固或可观测性一并处理 |
| 高价值逻辑/可靠性问题组 | 38 | 按成绩、扫描、备份、迁移、阅卷和部署子系统分派 |
| 原始逻辑观察 | 248 | 保留为后续模块级排查索引 |

## 三、快速处理优先级

### A0：立即阻断

1. PX-SEC-028：学生可完整控制任意考试组，并可能级联删除关联考试、成绩和教学记录。
2. PX-SEC-001：固定默认管理员口令仍可签发完整管理员会话，并可能被便捷公网隧道放大。
3. PX-SEC-002：已登录学生可通过伪 X-Api-Key 分支绕过扫描器 Key 和 grade:write 校验。
4. PX-SEC-004：答题卡资产可作为同源活动 HTML 发布，形成已认证上下文中的存储型 XSS。
5. PX-SEC-005、006：跨考试写入与 teacher_role 缺失时的 fail-open 范围可造成大范围横向读取和修改。
6. PX-SEC-024：教师可控赋分公式进入受影响的 expr-eval 2.0.2 求值链。
7. PX-COR-001、002、003、006、007：成绩成功状态、SQLite WAL 备份、跨考试扫描写入和恢复/扫描事务边界可能直接产生错误或不可恢复数据。

### A1：最近安全修复版本

- 完成考试、答题卡、班级、学生、扫描会话、阅卷分配、成绩和分析历史的统一对象授权。
- 修复所有秘密/令牌进入 URL、响应、普通配置、子进程参数或明文传输的路径。
- 限制 AI/OCR 出站目标、凭据受众、DNS/IP、重定向和 TLS。
- 对同源渲染、移动端 innerHTML 和用户上传活动内容执行真实类型与非执行源隔离。
- 为路径写入、扫描切块和文件绑定加入最终规范化与根目录包含校验。
- 优先处理 PX-COR-009、010、014、021、023、025、028、029、031、033、035、037、038 等可能造成扫描失败、迁移丢数、阅卷错误、最终管理员失效或脚本假成功的问题。

### A2：一至两个迭代内完成

- 建立统一 WorkBudget，限制文件数、总字节、像素、解压膨胀、查询数、批量写入、时间和并发。
- 为扫描、阅卷、仲裁、改分、备份与恢复引入事务、期望版本、幂等键和失败补偿。
- 清理临时文件、孤儿资产、陈旧缓存、无界历史和数据库增长。
- 完成 SQLite/MariaDB 语义一致性测试、生产 TLS/Secret Store 检查和依赖升级。
- 将其余中危、低危与逻辑问题按组件归并处理，避免逐路由重复补丁继续漂移。

## 四、建议的分派方式

| 工作流 | 主要编号 | 负责人建议 | 验收核心 |
| --- | --- | --- | --- |
| 认证、RBAC 与对象授权 | PX-SEC-001, 002, 005-007, 011-014, 022, 028-036, 039, 049, 051-054, 056-057 | 后端权限/数据域负责人 | 角色-动作-对象矩阵；所有副作用前 fail closed |
| 上传、文件、原生与资源预算 | PX-SEC-003, 004, 009, 015, 023, 025, 038, 040, 043, 044, 050, 055 | 文件/扫描/原生负责人 | 数量、总字节、像素、路径、解压和并发边界测试 |
| 秘密、Token、数据库与出站 | PX-SEC-008, 010, 016-020, 026-027, 037, 041-042, 045, 047 | 平台/运维/AI 集成负责人 | 不可回读秘密、TLS、目的地策略、轮换与日志脱敏 |
| 扫描、阅卷与成绩事务 | PX-COR-001-007, 014-018, 021-023, 026, 029-037 | 成绩/阅卷/扫描负责人 | 事务、幂等、状态机、回滚、跨数据库一致性 |
| 迁移、备份与部署 | PX-COR-002, 006, 010-013, 019-020, 024-025, 038 | 数据库/发布负责人 | 可恢复迁移、WAL 一致快照、dry-run 无副作用、真实退出码 |

## 五、处理规则

- 每个安全问题必须保留原编号，避免修复合并后丢失独立回归路径。
- 优先修复共享根控制，但每个独立端点、解析器和对象操作仍需单独负向测试。
- 不以隐藏按钮、前端过滤、随机 ID 或部署约定替代服务端控制。
- 对资源问题只使用小型边界样例验证，不运行 OOM、磁盘填充或真实拒绝服务载荷。
- 对凭据和出站问题使用占位秘密和离线 URL 分类测试，不接触真实供应商或生产凭据。
- 修复前后均运行 SQLite 与 MariaDB 语义套件；涉及扫描器原生行为时，在批准的硬件实验环境另行验证。
- 对逻辑问题，验收应证明失败状态可见、部分写入可回滚、完成状态代表持久化完成，而不是仅证明接口返回 200。

## 六、57 个独立安全问题

### PX-SEC-001：固定默认管理员口令仍可直接登录（高危）

启动初始化会在管理员不存在时创建 admin/admin123。登录服务在口令
仍为默认值时只返回警告，仍然签发完整管理员令牌；便捷启动脚本还会
无条件建立 Cloudflare Quick Tunnel。未认证用户若在新建、重置或尚未
改密的部署中获得入口，即可取得用户、成绩、备份、数据库配置、API Key
和全校数据的管理员权限。

关键位置：

- src/apps/answer-card/server/index.ts:435-452
- src/server/db/index.ts:78-113
- src/server/services/AuthService.ts:139-158
- src/server/routes/auth.ts:41-67
- start-server.sh:8-28

最小修复是删除固定口令，使用一次性随机引导秘密，并在强制改密完成前
拒绝正常管理员会话和公网暴露。详细说明：
findings/known-default-administrator/known-default-administrator.md。

### PX-SEC-002：任意已登录学生可用伪 API Key 绕过扫描权限（高危）

optionalAuth 会先把任意有效账号附加到请求。dualAuth 只根据是否存在
X-Api-Key 选择 apiKeyAuth；apiKeyAuth 又在 req.user 已存在时直接
next，不再验证 Key，也不执行 grade:write。普通学生因此可创建扫描
会话、读取扫描记录/图片，部分路径还可执行删除。

关键位置：

- src/apps/answer-card/server/index.ts:477-478
- src/server/middleware/scanner-auth.ts:13-18,33-43
- src/server/middleware/api-key.ts:19-24
- src/server/routes/scanner-upload.ts:43-84
- src/apps/answer-card/server/scanner/index.ts:147-212,457-472

修复时必须明确区分“API Key 模式”和“JWT 模式”：选择 Key 就完整验证
Key 及 scanner/full scope；选择 JWT 就完整执行认证与 grade:write，
两者不能互相短路。详细说明：
findings/scanner-dummy-header-auth-bypass/scanner-dummy-header-auth-bypass.md。

### PX-SEC-003：扫描端点缺少数量和总工作量上限（中危）

pageCount 没有类型、正整数或最大值校验，小体积 JSON 数字可驱动大量
顺序 INSERT 和上传令牌分配。crops 使用内存型 multer，只有单文件
50 MiB 限制，没有 maxCount、总字节或 parts 上限；所有文件会在业务
处理前进入内存。与 PX-SEC-002 组合时，触发者范围扩大到任意登录用户。

关键位置：

- src/server/routes/scanner-upload.ts:23-24,43-78,146-175
- src/server/middleware/api-key.ts:19-24

应在缓冲和循环前限制页数、文件数、总字节、总像素、并发和总数据库
操作，使用流式处理、背压、取消和确定性清理。详细说明：
findings/scanner-unbounded-counts/scanner-unbounded-counts.md。

### PX-SEC-004：答题卡资产可发布同源活动 HTML（高危）

具有答题卡写权限的教师可上传或导入内容与声明类型不一致的 .html
资产。服务随后由同源 Express static 以 text/html 发布。管理员或教师
打开返回 URL 后，脚本运行在 Project-X 源中，可调用其当前会话允许的
API 并读取可访问的学校数据。

关键位置：

- src/apps/answer-card/server/index.ts:470,677-699,1155-1172
- src/apps/answer-card/server/storage.ts 中的资产命名/落盘路径

应验证真实文件格式，拒绝可执行扩展名，将用户资产放到无 Cookie 的
独立下载源，并使用 nosniff、严格 CSP 与 attachment。详细说明：
findings/card-assets-stored-xss/card-assets-stored-xss.md。

### PX-SEC-005：答题卡写路由可跨考试修改和关闭成绩（高危）

已登录教师只要具有 grade:write，就可以让客户端 body.examId 进入
成绩写入和考试关闭流程；该 examId 没有经过 requireExamAccess 或
validateExamIdsAccess。攻击者可横向改写其他班级学生成绩、创建扫描
证据并提前关闭受害考试。相关答题卡重绑和删除路径也存在相同的对象
归属缺口。

关键位置：

- src/apps/answer-card/server/index.ts:656-663,1006-1095
- src/apps/answer-card/server/index.ts:289-390
- src/apps/answer-card/server/routes/cards.ts 中的重绑/删除路径

修复必须先加载考试/答题卡的拥有关系并校验教师可见范围，在第一次
副作用前完成所有目标预检，并用事务提交。详细说明：
findings/card-cross-exam-destructive-idor/card-cross-exam-destructive-idor.md。

### PX-SEC-006：缺少 teacher_role 时考试范围默认放开（高危）

普通教师账号若没有 teacher_role，getVisibleExamIds 等路径把缺失元数据
解释为 null/all，而不是拒绝或仅限创建者。CSV 导入等正常路径可以产生
这种账号。结果是教师可广泛读取和修改跨班考试、成绩、赋分公式并执行
删除操作。

关键位置：

- src/apps/answer-card/server/middleware.ts:55-60,172-179
- src/server/routes/users.ts:69-120

缺少角色元数据必须 fail closed；导入时强制生成完整角色/范围记录，
并对历史账号执行可审计迁移。详细说明：
findings/teacher-role-fail-open-scope/teacher-role-fail-open-scope.md。

### PX-SEC-007：答题卡写操作错误使用 grade:write 权限域（中危）

答题卡创建、替换、导入、资产上传和删除本应要求 card:write，却把
grade:write 作为写权限传入。管理员精细配置“可阅卷、不可设计答题卡”
时，该策略会被服务端错误权限域绕过。

关键位置：

- src/server/auth/permissions.ts:14-24
- src/apps/answer-card/server/index.ts:656-663,726-766

应为每个动作使用明确权限常量，并增加权限矩阵测试，覆盖只有
grade:write、只有 card:write、两者皆有和两者皆无。详细说明：
findings/card-permission-domain-confusion/card-permission-domain-confusion.md。

### PX-SEC-008：可复用 Bearer Token 被放入查询字符串（中危）

认证中间件接受查询参数 token，前端媒体/SSE 等路径也会把长期可复用
令牌拼入 URL。URL 会进入代理访问日志、浏览器历史、监控、错误报告和
复制链接，泄露后可在剩余有效期内冒充对应教师或管理员。

关键位置：

- src/server/middleware/auth.ts:37-51
- src/apps/answer-card/server/index.ts:477-478
- src/apps/answer-card/client/auth/api.ts:97-114

应停止接受查询令牌，改用 Authorization 头或 Secure、HttpOnly、
SameSite Cookie；对流式/媒体请求使用一次性、短时、受众和对象绑定的
下载票据，并轮换可能已暴露的令牌。详细说明：
findings/bearer-token-query-leakage/bearer-token-query-leakage.md。

## 本分块处置建议

本批优先顺序为 PX-SEC-001、PX-SEC-002、PX-SEC-004、PX-SEC-005、
PX-SEC-006、PX-SEC-008、PX-SEC-003、PX-SEC-007。前五项直接影响
管理员权限、扫描控制、同源执行或跨考试完整性；修复时应同时补充服务端
负向授权测试，不能仅隐藏前端按钮。

### PX-SEC-009：阅卷上传文件数量缺少总上限（中危）

具有阅卷能力的账号可在一次操作中提交过多文件，使内存、CPU、磁盘和处理队列被放大占用。

- 关键位置：src/apps/answer-card/server/index.ts:701-716；src/apps/answer-card/server/index.ts:915-980；src/apps/answer-card/server/index.ts:701-716
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/grading-unbounded-file-count/grading-unbounded-file-count.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-010：扫描器 API Key 可被恢复或回读（低危）

扫描器长期凭据以可恢复形式跨越管理、存储或响应边界，一旦低权限读取链或日志泄露成立即可被重放。

- 关键位置：src/apps/answer-card/server/index.ts:435-441；src/server/db/index.ts:116-123；src/server/db/index.ts:125-131
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/scanner-api-key-recoverable-exposure/scanner-api-key-recoverable-exposure.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-011：答题卡与原卷读取缺少对象范围（高危）

部分读取接口只验证登录或粗粒度权限，没有证明调用者可访问对应考试、班级或答题卡。

- 关键位置：src/apps/answer-card/server/index.ts:718-724；src/apps/answer-card/server/index.ts:768-779；src/apps/answer-card/server/index.ts:1260-1300
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/global-card-and-paper-read/global-card-and-paper-read.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-012：创建考试时可绑定越权班级（中危）

教师创建考试时可提交其可见范围之外的班级标识，从而把后续考试和成绩处理扩展到未授权对象。

- 关键位置：src/apps/answer-card/server/index.ts:658-663；src/apps/answer-card/server/index.ts:1515-1535；src/apps/answer-card/server/middleware.ts:64-102
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/exam-create-class-scope-bypass/exam-create-class-scope-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-013：扫描记录在上传令牌校验前写入（高危）

上传能力尚未被完整验证时，服务器已经创建或修改扫描数据库状态，失败和重放会留下未授权副作用。

- 关键位置：src/server/routes/scanner-upload.ts:90-120；src/server/routes/scanner-upload.ts:122-129；src/server/routes/scanner-upload.ts:130-139
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/scanner-write-before-token-check/scanner-write-before-token-check.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-014：扫描切块删除未绑定会话所有权（高危）

切块或记录标识没有与当前会话、考试和授权主体重新绑定，攻击者可跨会话删除他人的扫描资产。

- 关键位置：src/server/routes/scanner-upload.ts:146-185；src/server/services/AnswerBlockCropService.ts:98-110；src/server/db/schema.sql:420-449
- 主要修复：把缺失不变量移到最近的共享边界强制执行，并补充正常、拒绝、边界和失败回滚测试。
- 逐项说明：findings/scanner-crop-cross-session-delete/scanner-crop-cross-session-delete.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-015：上传失败或中止会遗留临时文件（低危）

部分上传路径在验证失败、中止或后续处理异常时没有确定性清理，长期累积会泄露内容并占用磁盘。

- 关键位置：src/apps/answer-card/server/routes/paper-routes.ts:31-42；src/apps/answer-card/server/routes/paper-routes.ts:121-167；src/apps/answer-card/server/paper-converter.ts:24-29,49-65,96-122
- 主要修复：把缺失不变量移到最近的共享边界强制执行，并补充正常、拒绝、边界和失败回滚测试。
- 逐项说明：findings/upload-temporary-file-leaks/upload-temporary-file-leaks.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-016：MariaDB 密码进入进程可见边界（低危）

数据库维护命令把密码放入子进程参数或可记录的错误边界，本机进程、诊断或日志可观察到敏感值。

- 关键位置：src/server/routes/backup.ts:294-326；src/server/routes/backup.ts:389-420；scripts/setup-maria-db.sh:64-78
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/mariadb-password-process-exposure/mariadb-password-process-exposure.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-017：LLM 边车未配置密钥时认证默认放行（中危）

内部密钥为空时边车把认证解释为无需认证；一旦部署到非回环或被代理公开，调用者可直接使用数据与模型能力。

- 关键位置：llmclient/server.py:30-35；llmclient/server.py:80-116；llmclient/config.py:122-123
- 主要修复：把缺失不变量移到最近的共享边界强制执行，并补充正常、拒绝、边界和失败回滚测试。
- 逐项说明：findings/llm-sidecar-fail-open-auth/llm-sidecar-fail-open-auth.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-018：AI Provider Base URL 可造成服务端请求伪造（高危）

管理员或越权配置的 Base URL 会携带服务端网络权限和提供商凭据发起请求，缺少协议、目标、IP 和重定向约束。

- 关键位置：src/server/routes/ai-providers.ts:16-64；src/apps/answer-card/server/routes/analysis.ts:321-368；llmclient/server.py:85-112
- 主要修复：对协议、主机/IP、端口、DNS、重定向和凭据受众执行统一目的地策略。
- 逐项说明：findings/ai-provider-base-url-ssrf/ai-provider-base-url-ssrf.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-019：OCR 提供商选择混淆会把原卷发往非预期目标（中危）

OCR/分析调用对提供商身份与目标的绑定不一致，敏感原卷可能被发送到另一个已配置或攻击者影响的目标。

- 关键位置：src/apps/answer-card/server/routes/paper-routes.ts:399-424；llmclient/server.py:177-193；llmclient/providers_knowledge_points.py:190-218
- 主要修复：对协议、主机/IP、端口、DNS、重定向和凭据受众执行统一目的地策略。
- 逐项说明：findings/ocr-provider-confusion/ocr-provider-confusion.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-020：移动端 API Origin 可被改写并接收凭据（高危）

移动页面从不可信 URL 参数选择 API 根地址，现有或新输入的凭据随后被发送到该来源。

- 关键位置：Grade-Analysis-System-mobile.html:191-194；Grade-Analysis-System-mobile.html:204-213；Grade-Analysis-System-mobile.html:1549-1576
- 主要修复：对协议、主机/IP、端口、DNS、重定向和凭据受众执行统一目的地策略。
- 逐项说明：findings/mobile-api-origin-credential-diversion/mobile-api-origin-credential-diversion.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-021：移动页面考试名形成存储型 XSS（高危）

持久化考试名进入 innerHTML 拼接，打开页面的用户会在受信来源中执行由低权限数据携带的活动内容。

- 关键位置：src/apps/answer-card/server/validation.ts:48-60；src/apps/answer-card/server/index.ts:1515-1536；Grade-Analysis-System-mobile.html:326-338
- 主要修复：使用文本或框架转义，校验真实类型，并把用户活动内容移到无凭据的非执行下载源。
- 逐项说明：findings/mobile-exam-name-stored-xss/mobile-exam-name-stored-xss.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-022：AI 数据工具缺少班级范围校验（高危）

AI 工具调用可按客户端或模型提供的标识查询班级/学生数据，没有始终重用当前教师的可见范围。

- 关键位置：llmclient/schemas.py:14-19；llmclient/tools/registry.py:132-155；llmclient/tools/grades.py:167-193
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/ai-tool-class-scope-bypass/ai-tool-class-scope-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-023：原生图像尺寸可驱动无界内存分配（中危）

不可信图像尺寸、DPI 或变换参数进入原生分配和 warp 操作，应用层没有像素与总字节预算。

- 关键位置：src/apps/answer-card/server/index.ts:811-872；native/AnswerCardRecognizer/answer-card-recognizer/vision_utils.cpp:87-100；native/AnswerCardRecognizer/answer-card-recognizer/answer_recognition.cpp:718-733,816-817
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/native-image-allocation-dos/native-image-allocation-dos.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-024：赋分公式通过 expr-eval 形成代码执行链（高危）

教师可控公式进入已知受影响的 expr-eval 2.0.2 求值路径，表达式能力超过受限数值计算所需范围。

- 关键位置：package.json:46；src/apps/answer-card/server/index.ts:1568-1601；src/apps/answer-card/server/validation.ts:85-96
- 主要修复：升级或移除受影响求值器，以白名单 AST 只允许有界数值表达式。
- 逐项说明：findings/expr-eval-assigned-score-rce/expr-eval-assigned-score-rce.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-025：Multer 深层字段解析可导致拒绝服务（中危）

已知受影响的 multipart 解析版本与缺少字段深度/数量限制的入口组合，可消耗大量 CPU 或内存。

- 关键位置：package.json:50；src/apps/answer-card/server/index.ts:547-566；src/apps/answer-card/server/index.ts:568-581
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/multer-deep-field-dos/multer-deep-field-dos.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-026：扫描器远程模式允许明文 HTTP（中危）

远程扫描配置可通过 HTTP 传输登录令牌、API Key、图像和成绩相关数据，网络中间人可读取或篡改。

- 关键位置：src/apps/answer-card/client/components/LoginPageScanner.tsx:33-60, 113-164；src/apps/answer-card/client/components/LoginPageScanner.tsx:63-80, 168-200；src/apps/answer-card/client/auth/api.ts:3-20
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/scanner-remote-plaintext-http/scanner-remote-plaintext-http.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-027：数据库配置明文保存密码（低危）

数据库密码以可直接恢复的形式持久化在应用配置/数据库中，读取配置的主体即可取得远程数据库凭据。

- 关键位置：src/apps/answer-card/client/components/AccountMenu.tsx:60-69,104-125,764-792；src/apps/answer-card/server/index.ts:599-615；src/server/db/config.ts:23-27,48-72,126-148
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/database-config-plaintext-password/database-config-plaintext-password.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-028：学生可完整控制任意考试组（严重）

普通学生可到达考试组创建、修改或删除控制面，并可通过级联操作破坏关联考试、成绩和教学记录。

- 关键位置：src/apps/answer-card/server/index.ts:583-589；src/server/routes/exam-groups.ts:10-12；src/server/routes/exam-groups.ts:78-110
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/student-exam-group-full-control/student-exam-group-full-control.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-029：阅卷分配操作缺少对象所有权（高危）

调用者可按标识处理不属于自己的阅卷分配，未证明教师、考试、题目和分配之间的授权关系。

- 关键位置：src/apps/answer-card/client/components/BlockSelectPage.tsx:15-28,34-44；src/server/routes/review.ts:58-74；src/server/services/AnswerBlockCropService.ts:199-225
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/review-assignment-ownership-bypass/review-assignment-ownership-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-030：阅卷分配管理接口缺少管理权限（中危）

部分创建、分配、回收或重置操作仅验证粗粒度登录/阅卷能力，没有要求应有的管理动作权限。

- 关键位置：src/apps/answer-card/client/components/ExamDetailPage.tsx:21-31,40-50,95；src/apps/answer-card/client/components/ReviewAssignPage.tsx:63-80；src/server/routes/review-assign.ts:86-110
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/review-assignment-management-bypass/review-assignment-management-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-031：阅卷策略接口存在角色绕过（高危）

低于策略管理所需角色的账号可读取或修改双评、三评、仲裁等规则，影响最终成绩计算。

- 关键位置：src/apps/answer-card/client/components/ExamDetailPage.tsx:21-31,40-50,98；src/server/routes/block-grading-config.ts:51-73；src/apps/answer-card/client/components/ExamDetailPage.tsx:21-31,40-50,98
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/grading-policy-role-bypass/grading-policy-role-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-032：教师可见性拒绝未落实到数据查询（高危）

中间件或辅助函数得出不可见结论后，部分调用方仍继续使用全局对象或未过滤查询。

- 关键位置：src/apps/answer-card/client/components/PermissionManager.tsx:45-50,73-85,109-115,142-220；src/server/routes/admin-permissions.ts:15-44,64-86；src/apps/answer-card/server/middleware.ts:55-127,142-181
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/teacher-visibility-denials-not-enforced/teacher-visibility-denials-not-enforced.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-033：阅卷追踪接口缺少角色边界（高危）

阅卷轨迹和审计数据可被不具备相应管理/追踪能力的账号访问，泄露教师操作和成绩处理信息。

- 关键位置：src/apps/answer-card/client/components/ReviewTracePage.tsx:13-24,28-78；src/apps/answer-card/client/components/ExamDetailPage.tsx:21-50,95-98；src/server/routes/review.ts:118-132
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/review-trace-role-bypass/review-trace-role-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-034：多班考试可绕过班级范围（高危）

多班级考试的输入和查询只验证部分班级或合并后丢失范围约束，教师可影响不可见班级。

- 关键位置：src/apps/answer-card/client/components/ScoreDetailPage.tsx:31-59, 80-105, 152-163, 251-277；src/apps/answer-card/client/components/ScoreDetailPage.tsx:357-362, 471-497；src/apps/answer-card/client/components/ScoreFixPage.tsx:88-163, 186-202, 291-326, 430-474
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/multi-class-exam-class-scope-bypass/multi-class-exam-class-scope-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-035：扫描预览可跨考试读取图像（高危）

预览/记录标识没有重新绑定当前考试与调用者范围，已登录用户可读取其他考试的扫描图。

- 关键位置：src/apps/answer-card/client/components/ScoreTable.tsx:38-71, 200-251；src/server/middleware/scanner-auth.ts:30-53；src/apps/answer-card/server/scanner/index.ts:264-327
- 主要修复：把缺失不变量移到最近的共享边界强制执行，并补充正常、拒绝、边界和失败回滚测试。
- 逐项说明：findings/scanner-preview-cross-exam-images/scanner-preview-cross-exam-images.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-036：成绩编辑使用错误权限域（中危）

成绩修改接口混用阅卷、成绩或管理权限，精细 RBAC 配置下会授权本应禁止的改分动作。

- 关键位置：src/apps/answer-card/client/components/ScoreDetailPage.tsx:31-35, 315-326；src/apps/answer-card/client/components/ScoreFixPage.tsx:138-163, 186-202；src/apps/answer-card/server/index.ts:656-664, 1455-1458
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/score-editing-permission-confusion/score-editing-permission-confusion.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-037：初始密码以明文形式导出（中危）

批量创建/导出流程把可直接登录的初始密码写入可长期保存和转发的文件，缺少一次性和强制轮换。

- 关键位置：src/apps/answer-card/client/components/TeacherManagement.tsx:160-175, 202-218；src/server/repositories/UserRepository.ts:49-56, 135-158, 194-203, 286-311；src/server/repositories/UserRepository.ts:206-220
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/plaintext-initial-password-export/plaintext-initial-password-export.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-038：DOCX 解压缺少膨胀与条目预算（中危）

压缩体积受限的 DOCX 可在解压后形成大量条目或字节，解析前没有总展开量、压缩比和深度限制。

- 关键位置：src/apps/answer-card/server/paper-converter.ts:8-29,104-106；src/apps/answer-card/server/routes/paper-routes.ts:31-42,120-165；src/apps/answer-card/server/paper-ocr.ts:10-13,86-104
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/docx-decompression-dos/docx-decompression-dos.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-039：分析历史读取缺少对象范围（高危）

分析历史按客户端标识读取，但没有始终校验当前用户与考试、班级或学生的拥有关系。

- 关键位置：src/apps/answer-card/server/index.ts:656-665；src/apps/answer-card/server/routes/analysis.ts:60-72；src/server/repositories/AnalysisRepository.ts:260-268
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/analysis-history-scope-bypass/analysis-history-scope-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-040：答题卡布局参数可触发算法复杂度放大（中危）

不可信布局数量和嵌套参数进入重复布局/计算循环，缺少元素数、迭代和总工作量上限。

- 关键位置：src/apps/answer-card/server/index.ts:102-131, 781-790；src/apps/answer-card/server/validation.ts:36-44；src/shared/layout.ts:1027-1106
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/answer-card-layout-algorithmic-dos/answer-card-layout-algorithmic-dos.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-041：学生默认密码可预测且不强制轮换（高危）

账号初始化使用可从学生信息推导的默认密码，首次登录没有强制转换为唯一秘密。

- 关键位置：src/server/auth/passwordPolicy.ts:1-16；src/server/routes/users.ts:72-115；src/server/repositories/UserRepository.ts:135-158, 280-298
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/predictable-student-default-password/predictable-student-default-password.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-042：MariaDB 远程连接未强制 TLS（中危）

应用可在未验证服务端身份和未加密的连接上传输数据库凭据及全量教学数据。

- 关键位置：src/server/db/mysql.ts:165-217；node_modules/mysql2/lib/connection_config.js:144-150；readus/DATABASE.md:78-87
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/mariadb-no-tls/mariadb-no-tls.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-043：公开健康检查可放大数据库队列压力（中危）

无需认证的健康入口会触发数据库工作且缺少独立并发/缓存控制，重复调用可占用有限连接或任务队列。

- 关键位置：src/apps/answer-card/server/index.ts:447-478；src/server/db/mysql.ts:304-314；src/server/db/mysql.ts:195-217
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/public-health-db-queue-dos/public-health-db-queue-dos.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-044：分析查询存在无界扇出（中危）

单个分析请求可按班级、考试、学生或题目触发大量顺序/并行查询，缺少总查询预算和分页。

- 关键位置：src/apps/answer-card/server/index.ts:102-132, 781-793；src/apps/answer-card/server/index.ts:315-323, 339-370；src/server/repositories/AnalysisRepository.ts:53-57, 165-179
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/analysis-query-fanout-dos/analysis-query-fanout-dos.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-045：AI Provider Key 以可恢复形式持久化（低危）

AI 服务商长期密钥可被应用配置或管理读取路径直接恢复，扩大数据库/管理员读取泄露的后果。

- 关键位置：src/server/routes/ai-providers.ts:51-66, 69-104；src/server/db/schema.sql:561-575；src/server/routes/ai-providers.ts:18-36
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/plaintext-ai-provider-keys/plaintext-ai-provider-keys.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-046：AI Provider 配置可造成数据库无界增长（中危）

配置或调用历史缺少配额、去重、保留和清理策略，低权限或被绕过路径可持续写入。

- 关键位置：src/server/routes/ai-providers.ts:14-16, 51-66；src/server/routes/ai-providers.ts:52-64；src/server/db/schema.sql:561-575
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/ai-provider-database-growth/ai-provider-database-growth.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-047：认证 Cookie 缺少 Secure 属性（中危）

浏览器可能在允许的明文 HTTP 场景发送会话 Cookie，代理或同网段攻击者可截获并重放。

- 关键位置：src/server/routes/auth.ts:19-33, 41-67；deploy-guide.md:38-61
- 主要修复：使用受保护且不可回读的秘密存储，移除 URL/响应/日志/命令行暴露，强制安全传输并轮换已暴露凭据。
- 逐项说明：findings/auth-cookie-missing-secure/auth-cookie-missing-secure.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-048：登录限流使用全局共享桶（中危）

所有用户/IP 共享同一登录限流计数，攻击者可消耗全局配额并阻止合法用户登录。

- 关键位置：src/server/routes/auth.ts:7-17, 35-55；src/apps/answer-card/server/index.ts:432-469；deploy-guide.md:38-61
- 主要修复：把缺失不变量移到最近的共享边界强制执行，并补充正常、拒绝、边界和失败回滚测试。
- 逐项说明：findings/global-login-rate-limit-bucket/global-login-rate-limit-bucket.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-049：班级花名册读取缺少对象范围（高危）

已登录调用者可按班级标识读取全局学生名单，没有证明教师或学生可访问该班级。

- 关键位置：src/server/routes/classes.ts:16-24, 41-46, 67-76；src/server/repositories/ClassRepository.ts:92-100；src/apps/answer-card/server/middleware.ts:48-103
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/global-class-roster-read/global-class-roster-read.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-050：题块配置批量写入缺少上限（中危）

一次请求可携带过多题块并逐项执行数据库 upsert，造成长事务、队列占用和数据库增长。

- 关键位置：src/server/routes/block-grading-config.ts:75-99；src/apps/answer-card/server/index.ts:432-455；src/server/services/BlockGradingConfigService.ts:86-179
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/block-config-batch-upsert-dos/block-config-batch-upsert-dos.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-051：学生排行榜读取范围过宽（高危）

学生可读取超出产品允许群体的排名与成绩数据，客户端考试/班级标识没有被当前身份约束。

- 关键位置：src/server/routes/ladder.ts:21-37,114-158；src/apps/answer-card/server/middleware.ts:55-58,184-191；src/server/routes/ladder.ts:160-182,206-285
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/student-leaderboard-scope-bypass/student-leaderboard-scope-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-052：学生 AI 分析可泄露同群体数据（高危）

学生触发的 AI 分析把同班/同年级其他学生的聚合或明细数据带入响应/提示，而不是只使用本人数据。

- 关键位置：src/server/routes/scores.ts:107-160；llmclient/schemas.py:14-19；llmclient/tools/registry.py:132-155
- 主要修复：把缺失不变量移到最近的共享边界强制执行，并补充正常、拒绝、边界和失败回滚测试。
- 逐项说明：findings/student-ai-cohort-data-leak/student-ai-cohort-data-leak.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-053：学生可滥用 AI Provider 配额（中危）

学生可触发未受主体配额、并发和成本预算约束的外部模型调用，消耗管理员配置的付费额度。

- 关键位置：src/server/routes/scores.ts:110-160；llmclient/config.py:30-93；llmclient/server.py:80-112
- 主要修复：在工作开始前限制数量、总字节/像素、查询、时间和并发，增加流式处理、背压、取消与清理。
- 逐项说明：findings/student-ai-provider-quota-abuse/student-ai-provider-quota-abuse.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-054：教师可读取任意学生成绩（高危）

教师按学生标识直接读取成绩，服务端没有证明该学生属于其班级、学科或考试范围。

- 关键位置：src/server/routes/scores.ts:254-282；src/server/auth/permissions.ts:66-76；src/server/middleware/auth.ts:121-132
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/teacher-arbitrary-student-score-read/teacher-arbitrary-student-score-read.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-055：扫描切块页路径可遍历并覆盖文件（高危）

页号或文件片段进入目标路径时缺少规范化与根目录包含校验，可越出预期切块目录并覆盖可写文件。

- 关键位置：src/server/routes/scanner-upload.ts:146-183；src/server/services/AnswerBlockCropService.ts:93-124；src/server/services/AnswerBlockCropService.ts:83-90
- 主要修复：拒绝路径分隔符和点段，规范化最终路径并在写入前验证其仍位于预期根目录。
- 逐项说明：findings/crop-page-path-traversal-overwrite/crop-page-path-traversal-overwrite.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-056：赋分公式管理存在角色绕过（高危）

不具备公式管理角色的账号可创建或替换赋分公式，改变大量学生的计分规则。

- 关键位置：src/apps/answer-card/server/index.ts:1568-1607；src/server/services/AssignedScoreService.ts:47-65, 111-162；src/server/services/AssignedScoreService.ts:68-109
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/assigned-score-formula-role-bypass/assigned-score-formula-role-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

### PX-SEC-057：阅卷分数载荷缺少完整性校验（高危）

客户端可提交未严格绑定分配、题目、范围、总分与版本的分数载荷，服务器直接写入或合并。

- 关键位置：src/server/routes/review.ts:82-108；src/server/services/ReviewService.ts:147-180；src/server/services/ReviewService.ts:207-240
- 主要修复：在服务端统一执行角色、动作和对象范围校验，所有目标在首个副作用前预检，并加入负向权限矩阵测试。
- 逐项说明：findings/review-score-payload-integrity-bypass/review-score-payload-integrity-bypass.md（主任务详细证据报告生成中；本项已完成候选验证和攻击路径闭环）

## 七、38 组重点逻辑与可靠性问题

以下问题来自 248 条原始逻辑观察的高价值归并。它们不使用安全漏洞严重度，但应纳入同一工程问题队列。

### PX-COR-001：综合阅卷在持久化完成前返回成功并关闭考试

- 原始条目：PX-LOG-A-001, PX-LOG-A-002, PX-LOG-A-003
- 置信度：高
- 主要位置：src/apps/answer-card/server/index.ts:1083-1095；src/apps/answer-card/server/index.ts:294-372；src/server/repositories/ExamRepository.ts:31-36,144-184；src/server/db/mysql.ts:260-273；src/apps/answer-card/server/index.ts:333-389
- 影响：教师会误以为成绩已经保存，但数据库中可能没有持久化结果或只有部分结果。扫描记录、逐题分数、切块和考试状态可能相互矛盾，未完成的考试还会被标记为已关闭并发布错误结果。

### PX-COR-002：自动备份遗漏 SQLite WAL 中的实时已提交数据

- 原始条目：PX-LOG-A-004
- 置信度：高
- 主要位置：src/apps/answer-card/server/index.ts:266-285；src/server/db/index.ts:23-29
- 影响：自动备份只复制主数据库文件，没有包含仍位于 WAL 中的已提交成绩，备份可能陈旧、内部不一致，甚至正好遗漏触发本次备份的成绩。

### PX-COR-003：未缓存的扫描结果会写入所有复用同一答题卡的开放考试

- 原始条目：PX-LOG-A-005
- 置信度：高
- 主要位置：src/apps/answer-card/server/scanner/index.ts:25-83；src/apps/answer-card/server/scanner/index.ts:354-424
- 影响：同一学生扫描结果可能污染多个无关考试，并把草稿考试推进到阅卷状态；答题卡模板复用时尤其容易产生跨考试成绩和状态串写。

### PX-COR-004：非法扫描页数会创建永久不完整或畸形的会话

- 原始条目：PX-LOG-A-006
- 置信度：高
- 主要位置：src/server/routes/scanner-upload.ts:43-84
- 影响：零值、负数、非整数或异常大的页数会使扫描会话永远无法正确完成，报告页数与实际记录不一致，并可能附带资源耗尽。

### PX-COR-005：原卷替换和不存在答题卡的上传会遗留陈旧或孤儿文件

- 原始条目：PX-LOG-B-001, PX-LOG-B-002
- 置信度：高
- 主要位置：src/apps/answer-card/server/paper-converter.ts:96-122；src/apps/answer-card/server/routes/paper-routes.ts:176-223,511-530；src/apps/answer-card/server/paper-ocr.ts:86-119；src/apps/answer-card/server/routes/paper-routes.ts:121-167
- 影响：数据库可能显示新原卷，但教师和 AI 分析仍读取旧文件；失败上传还会留下无归属目录和文件，造成错误分析、状态误导和磁盘持续增长。

### PX-COR-006：SQLite 与 MariaDB 恢复缺少原子回滚，可能留下破坏性混合状态

- 原始条目：PX-LOG-B-003, PX-LOG-B-004
- 置信度：高
- 主要位置：src/server/routes/backup.ts:212-273；src/server/routes/backup.ts:367-425；src/server/routes/backup.ts:302-312
- 影响：恢复中途失败时，数据库行、扫描记录、原卷、布局和图像可能来自不同版本，且没有由恢复流程自动创建的可靠回滚点，只能人工修复。

### PX-COR-007：扫描完成、上传令牌创建和切块替换不是原子操作

- 原始条目：PX-LOG-B-005, PX-LOG-B-006, PX-LOG-B-007
- 置信度：高
- 主要位置：src/server/routes/scanner-upload.ts:91-139；src/server/routes/scanner-upload.ts:190-240；src/server/routes/scanner-upload.ts:51-78；src/server/services/AnswerBlockCropService.ts:98-176
- 影响：系统可能把缺页、重复或部分上传的扫描标记为完成；孤儿会话、令牌和切块会污染列表，并在后续识别、阅卷和人工复核中产生缺失或不一致结果。

### PX-COR-008：原卷和知识点 AI 流程在正常提供商与 JSON 输入下也可能失败

- 原始条目：PX-LOG-C-001, PX-LOG-C-002, PX-R005-L001, PX-R005-L002, PX-R005-L003, PX-R005-L005
- 置信度：中高
- 主要位置：src/apps/answer-card/server/routes/paper-routes.ts:509-530；llmclient/providers_knowledge_points.py:252-267；src/server/routes/ai-providers.ts:51-64；llmclient/schemas.py:8-19；llmclient/server.py:85-100；llmclient/config.py:18-27
- 影响：正常配置的 Gemini、OCR 或知识点分析会因参数、模型、密钥和响应结构契约不一致而返回 502，消耗供应商请求却得不到结果，界面选择的提供商也可能完全不生效。

### PX-COR-009：TWAIN 集成存在句柄宽度、缓冲区寿命、事件、双面扫描和成功状态缺陷

- 原始条目：PX-R010-L001, PX-R010-L002, PX-R010-L003, PX-R010-L004, PX-R010-L005, PX-R010-L006, PX-R010-L007, PX-R010-L008
- 置信度：中高
- 主要位置：native/ScannerBridge/scanner-bridge/twain_controller.cpp:177-206,211-230；native/ScannerBridge/scanner-bridge/twain_controller.cpp:79-84,150-172,792-812；native/ScannerBridge/scanner-bridge/twain_controller.cpp:658-677；package.json:25-30,94-108；native/ScannerBridge/scanner-bridge/twain_controller.cpp:684-763；native/ScannerBridge/scanner-bridge/twain_controller.cpp:684-735
- 影响：原生扫描可能无法打开设备或进入传输状态；在 x64 下还可能错误释放句柄、读取失效指针或越界访问。双面页可能丢失，失败扫描却可能被当作完成，最终导致错误识别和评分。

### PX-COR-010：数据库迁移遗漏运行表、破坏版本状态、使用覆盖式写入且缺少原子标记

- 原始条目：PX-R011-L001, PX-R011-L002, PX-R011-L003, PX-R011-L004, PX-R031-L007, PX-R031-L008
- 置信度：中高
- 主要位置：scripts/migrate-to-mariadb.ts:53-108,154-238；src/server/db/schema.sql:390-418,582-634；src/server/db/migrations.ts:453-507,528-548,558-646；scripts/migrate-to-mariadb.ts:42-49,161-170,193-199,226-237；src/server/db/migrations.ts:434-466；src/server/db/mysql.ts:397-408,579-588
- 影响：名义上成功的迁移可能丢失切块、阅卷流程、批注、权限和隐私设置；错误目标或重试还可能覆盖账号与成绩，并在部分初始化后错误记录迁移已完成。

### PX-COR-011：数据库安装与配置无法可靠回写凭据，也不符合打包启动要求

- 原始条目：PX-R012-L001, PX-R012-L002, PX-R014-L001, PX-R014-L002, PX-R031-L001, PX-R032-L002, PX-R032-L003, PX-R032-L004, PX-R032-L005
- 置信度：高
- 主要位置：scripts/setup-maria-db.sh:12-23, 68-95；src/server/db/schema.mariadb.sql:1-11；scripts/setup-maria-db.sh:12-15, 68-86；scripts/setup-mariadb.sh:13-16, 62-86；src/apps/answer-card/client/components/AccountMenu.tsx:89-125,788-792；src/apps/answer-card/server/index.ts:617-641
- 影响：合法数据库密码、端口和配置经过保存或重启后可能失真，文档生成的账号权限又不足以完成启动检查，导致远程数据库模式在重启或新部署时不可用。

### PX-COR-012：考试组总分、过滤、重复学科/班级、导出与排行榜计算不一致

- 原始条目：PX-R018-L001, PX-R018-L002, PX-R018-L003, PX-R018-L004, PX-R018-L005, PX-R018-L006, PX-R018-L007, PX-R018-L008, PX-R018-L009, PX-R018-L010, PX-R036-L001, PX-R036-L002, PX-R036-L003, PX-R036-L007, PX-R036-L008
- 置信度：中高
- 主要位置：src/server/routes/exam-groups.ts:118-159；src/apps/answer-card/client/components/GroupExportModal.tsx:22-31；src/server/routes/exam-groups.ts:395-423,535-562；src/apps/answer-card/client/components/ExamGroupDetailPage.tsx:288-318；src/server/routes/exam-groups.ts:395-423,535-538；src/apps/answer-card/client/components/ExamGroupDetailPage.tsx:28-29,59-66,261-264
- 影响：同一考试组在排名、ZIP 导出、学生端和排行榜接口中可能得到不同总分、名次和科目结果；多重班级关系还会重复学生并放大总分。

### PX-COR-013：多处 JSON 修改请求缺少 Content-Type，服务端收到空请求体

- 原始条目：PX-R019-L001, PX-R022-L002
- 置信度：高
- 主要位置：src/apps/answer-card/client/components/GradePanel.tsx:58-70, 109-156, 175-193；src/apps/answer-card/client/components/GradingConfigPage.tsx:57-74；src/apps/answer-card/client/auth/api.ts:48-82；src/apps/answer-card/server/index.ts:450-456；src/apps/answer-card/client/components/PermissionManager.tsx:73-85；src/apps/answer-card/client/components/ReviewAssignPage.tsx:63-76
- 影响：权限、阅卷分配等修改在界面上已提交，但 Express 不会按 JSON 解析请求体，导致操作失败、写入默认值或出现误导性错误。

### PX-COR-014：阅卷提交会把未触碰分数替换为零，并可能用陈旧会话覆盖新结果

- 原始条目：PX-R019-L004, PX-R019-L005
- 置信度：高
- 主要位置：src/apps/answer-card/client/components/GradePanel.tsx:30-32, 102-131, 369-417；src/apps/answer-card/client/components/GradePanel.tsx:58-70, 92-100, 133-151
- 影响：教师只修改部分题目时，其他分数可能被意外清零；并发或延迟保存还可能用旧会话覆盖更新后的阅卷结果，造成静默改分。

### PX-COR-015：扫描进度订阅过晚、API Key 无法用于 EventSource，部分远程上传仍报告成功

- 原始条目：PX-R022-L005, PX-R022-L006, PX-R022-L007, PX-R022-L008
- 置信度：高
- 主要位置：src/apps/answer-card/client/components/ScannerPanel.tsx:141-213,286-321；src/apps/answer-card/server/scanner/index.ts:86-94,105-143,478-510；src/apps/answer-card/server/scanner/scanner-service.ts:54-153；src/apps/answer-card/client/components/ScannerPanel.tsx:119-144,286-321；src/apps/answer-card/client/auth/api.ts:84-103；src/server/middleware/scanner-auth.ts:30-53
- 影响：界面可能错过全部进度事件，API-Key-only 客户端无法建立进度流；部分页面上传失败或完成请求被拒绝时，前端仍可能宣布扫描成功。

### PX-COR-016：答案订正错误处理不定项选择、分数小数和保存后状态

- 原始条目：PX-R023-L001, PX-R023-L002, PX-R023-L003
- 置信度：高
- 主要位置：src/apps/answer-card/client/components/ScoreFixPage.tsx:381-416, 447-465；src/shared/types.ts:1-1；src/shared/grading.ts:204-210；src/apps/answer-card/client/components/ScoreFixPage.tsx:62-86, 177-202, 447-465；src/apps/answer-card/client/components/ScorePad.tsx:15-49, 51-75, 77-107
- 影响：不定项题会按单选题处理，小数分数被错误拆解或高亮；保存成功后编辑器还会恢复陈旧快照，使用户误以为订正没有生效或再次覆盖正确结果。

### PX-COR-017：学生 AI 忽略提供商选择，并暴露无法运行的单考试模式

- 原始条目：PX-R024-L001, PX-R024-L002, PX-R024-L003
- 置信度：高
- 主要位置：src/apps/answer-card/client/components/StudentAiPanel.tsx:89-117, 185-229；src/server/routes/scores.ts:163-250；src/apps/answer-card/client/components/StudentAiPanel.tsx:53-85；src/apps/answer-card/client/components/StudentAiPanel.tsx:89-104, 172-183, 226-233
- 影响：界面选择的 AI 提供商和模型不会真正传递到服务端；单考试模式虽然可见却无法完成分析，导致配置与实际行为不一致。

### PX-COR-018：分析功能直接比较满分标准不一致考试的原始分数

- 原始条目：PX-R024-L009, PX-R025-L001
- 置信度：高
- 主要位置：src/apps/answer-card/client/components/StudentScores.tsx:81-119, 133-150；src/apps/answer-card/client/components/StudentSemesterComparison.tsx:60-96, 114-160；src/apps/answer-card/client/components/StudentSubjectRadar.tsx:42-91, 102-141；src/server/repositories/ScoreRepository.ts:120-152, 185-203；src/server/routes/scores.ts:60-101
- 影响：不同满分试卷的原始分数被直接用于趋势、最佳/最差、平均值和学科对比，结果会把试卷难度与满分差异误写成学生能力变化。

### PX-COR-019：CSV 分隔符、多行字段和规范化表头处理会破坏合法导入

- 原始条目：PX-R025-L006, PX-R027-L001, PX-R034-L004
- 置信度：高
- 主要位置：src/apps/answer-card/client/components/TeacherManagement.tsx:178-200, 357-390；src/server/routes/users.ts:261-315；src/apps/answer-card/client/util/csvParser.ts:15-39, 43-59；src/apps/answer-card/client/util/csvParser.ts:78-99；src/apps/answer-card/client/components/ImportModal.tsx:19-37, 39-48, 63-75, 115-147；src/server/routes/users.ts:261-300
- 影响：包含逗号、换行、TSV 或英文规范表头的合法花名册会被错误拆分、漏行或拒绝，预览数量和最终创建结果也可能误导用户。

### PX-COR-020：学生创建与重复导入会造成班级关系缺失或不断累积

- 原始条目：PX-R016-L005, PX-R024-L004, PX-R034-L005
- 置信度：中高
- 主要位置：src/apps/answer-card/client/components/ClassManagement.tsx:287-352；src/apps/answer-card/client/components/StudentManagement.tsx:109-133, 157-220, 232-258；src/server/repositories/UserRepository.ts:271-283
- 影响：从已选班级创建学生时可能不建立班级关系；把已有学生导入新班级时又会累加关系而不是转移，最终导致花名册、排名和跨考试查询重复或缺失。

### PX-COR-021：所有未识别学生的答题卡会合并成一个虚构的最高分学生

- 原始条目：PX-R028-L001, PX-R029-L002
- 置信度：高
- 主要位置：src/apps/answer-card/server/database/scan-store.ts:275-297；src/apps/answer-card/server/scanner/index.ts:386-419,430-449；src/shared/grading.ts:405-417,419-501；src/apps/answer-card/server/scanner/scanner-service.ts:169-217；src/apps/answer-card/server/database/scan-store.ts:274-297；src/apps/answer-card/server/scanner/index.ts:386-410
- 影响：多个学生的未识别页面会被合并为一个“未识别”结果，并按较高分数去重，形成不属于任何人的虚构高分，掩盖需要人工确认的真实答题卡数量。

### PX-COR-022：扫描结果缓存契约不完整，重新打开详情会崩溃

- 原始条目：PX-R028-L008, PX-R029-L001
- 置信度：高
- 主要位置：src/apps/answer-card/server/database/scan-store.ts:53-61,242-271；src/apps/answer-card/server/scanner/index.ts:365-377,408-419,430-449；src/apps/answer-card/client/components/ScannerPanel.tsx:32-52,215-221,542-560,606-620；src/apps/answer-card/server/scanner/index.ts:365-375, 386-449；src/apps/answer-card/server/database/scan-store.ts:240-271；src/apps/answer-card/client/components/ScannerPanel.tsx:32-53, 215-221, 542-620
- 影响：首次计算结果包含的得分分解和页面详情没有完整写入缓存；刷新后会显示 undefined/NaN，打开详情时还会因 pages 缺失而抛错。

### PX-COR-023：考试、答题卡和扫描删除可能只提交破坏性前半段并留下陈旧文件/缓存

- 原始条目：PX-R028-L004, PX-R028-L005, PX-R028-L009
- 置信度：高
- 主要位置：src/apps/answer-card/server/helpers.ts:76-82；src/apps/answer-card/server/index.ts:1227-1234,1624-1654；src/apps/answer-card/server/helpers.ts:85-92；src/apps/answer-card/server/index.ts:1233-1243,1245-1254,1647-1654；src/apps/answer-card/server/database/scan-store.ts:113-122,187-188,266-271；src/apps/answer-card/server/scanner/index.ts:217-232,365-377
- 影响：删除失败可能已经清除部分成绩或扫描行，却保留考试本身；文件、页数和组合成绩缓存也可能继续存在，界面仍展示已经删除的数据。

### PX-COR-024：原卷分析静默截断 PDF，并把 DOCX 压缩容器直接交给图像 OCR

- 原始条目：PX-R028-L006, PX-R028-L007
- 置信度：高
- 主要位置：src/apps/answer-card/server/paper-ocr.ts:20-39；src/apps/answer-card/server/routes/paper-routes.ts:426-448；src/apps/answer-card/server/paper-ocr.ts:10-13,45-56,97-104；node_modules/tesseract.js/src/worker/node/loadImage.js:18-37；node_modules/tesseract.js/src/worker-script/utils/setImage.js:12-33
- 影响：PDF 第六页以后永远不会进入分析且没有截断提示；无文本 DOCX 又会被当作图像字节交给 Tesseract，导致公式/图片型文档的自动分析稳定失败。

### PX-COR-025：角色权限默认放开、强制刷新返回默认值，字符串 false 反而启用权限

- 原始条目：PX-R031-L002, PX-R031-L003, PX-R034-L006, PX-R034-L007
- 置信度：高
- 主要位置：src/server/auth/permissions.ts:86-110；src/server/auth/permissions.ts:114-127；src/server/routes/admin-permissions.ts:64-81；src/server/routes/admin-permissions.ts:15-45；src/server/db/migrations.ts:532-545
- 影响：空权限或损坏 JSON 会恢复内置默认权限，forceReload 不会真正刷新缓存，管理接口还会把字符串 false 当成 true，导致权限界面与实际授权相反或不确定。

### PX-COR-026：共享 SQLite 连接与仓库事务边界会卷入无关写入或产生陈旧读取

- 原始条目：PX-R032-L001, PX-R033-L012
- 置信度：高
- 主要位置：src/server/db/mysql.ts:125-160,277-291；src/server/db/index.ts:15-31；src/apps/answer-card/server/index.ts:339-372；src/server/services/AnswerBlockCropService.ts:98-176；src/server/repositories/ExamRepository.ts:31-36, 138-184；src/apps/answer-card/server/index.ts:333-370
- 影响：一个请求在共享连接上开启异步事务后，其他请求的写入可能被纳入并随后一起回滚；MariaDB 下又可能因仓库绕过 txAdapter 留下半持久化成绩。

### PX-COR-027：答题卡题块顺序、损坏 JSON 与创建/布局持久化不一致

- 原始条目：PX-R033-L005, PX-R033-L007, PX-R033-L008
- 置信度：高
- 主要位置：src/server/repositories/CardRepository.ts:49-56, 61-72, 103-107, 162-214；src/server/repositories/CardRepository.ts:148-184, 190-214；src/apps/answer-card/server/index.ts:146-165；src/server/repositories/CardRepository.ts:28-59
- 影响：保存后题块顺序可能改变并影响印刷与识别；单个损坏 JSON 可使整张卡无法读取，创建卡片、写题块和保存布局分属不同持久化阶段，会留下幽灵或残缺卡片。

### PX-COR-028：空考试可见列表被解释为不加过滤，而不是零结果

- 原始条目：PX-R033-L011
- 置信度：高
- 主要位置：src/server/repositories/ExamRepository.ts:61-77, 80-110
- 影响：当前部分调用方进行了额外保护，但任何遗漏或未来调用者都可能把“无权访问任何考试”转换为“返回所有匹配考试”。

### PX-COR-029：自动重新评分覆盖人工总分，却保留陈旧的人工修改审计标志

- 原始条目：PX-R033-L013
- 置信度：高
- 主要位置：src/server/repositories/ExamRepository.ts:171-184
- 影响：重新评分后官方分数和派生字段可能已经改变，但审计状态仍声称当前值来自人工修改，造成成绩来源和追溯信息不一致。

### PX-COR-030：阅卷分配与进度会因非法数量和错误关联被清空、重叠或误计

- 原始条目：PX-R037-L001, PX-R037-L006, PX-R040-L001, PX-R040-L002, PX-R040-L007
- 置信度：高
- 主要位置：src/server/routes/review.ts:27-35；src/server/routes/review-assign.ts:94-105；src/server/services/ReviewAssignmentService.ts:98-142；src/server/services/ReviewAssignmentService.ts:90-142；src/server/services/RandomDistributionService.ts:33-48；src/server/services/ReviewAssignmentService.ts:91-144
- 影响：教师待阅数量可能被夸大、变成负数或统计错误；重新分配可能先删除旧记录再失败，遗漏或重复学生，并使完成率失真。

### PX-COR-031：仲裁保存相互冲突的负分、在 MariaDB 下失败且不刷新总分

- 原始条目：PX-R037-L002, PX-R037-L003, PX-R037-L004
- 置信度：高
- 主要位置：src/server/routes/review-arbitration.ts:61-100；src/server/routes/review-arbitration.ts:120-163；src/server/routes/review-arbitration.ts:139-163；src/server/db/mysql.ts:245-255；src/server/routes/review-arbitration.ts:139-170；src/server/services/rankingUpdate.ts:34-57
- 影响：切块、逐题分数、审计与响应可能保存不同最终分；SQLite 专用 SQL 在 MariaDB 下不可用，成功仲裁后总分和排名仍使用旧值。

### PX-COR-032：答案键在重算事务之外持久化，并为不存在的变化写审计

- 原始条目：PX-R037-L005, PX-R037-L007
- 置信度：高
- 主要位置：src/server/routes/score-editing.ts:334-375；src/server/routes/score-editing.ts:375-446；src/server/routes/score-editing.ts:340-383
- 影响：答案键先提交，后续重算失败却只能回滚成绩，形成新答案与旧分数的持久不一致；未知题号还会写入并未发生变化的审计记录。

### PX-COR-033：通用用户更新接口可以停用最后一个管理员

- 原始条目：PX-R038-L003
- 置信度：高
- 主要位置：src/server/routes/users.ts:139-172；src/server/routes/users.ts:208-225；src/server/repositories/UserRepository.ts:60-79,113-124；src/server/db/index.ts:78-110
- 影响：最后管理员可通过 is_active=false 被停用，而启动逻辑又把该停用账号视为已存在，不会补建管理员，部署只能直接修改数据库恢复。

### PX-COR-034：阅卷共识聚类失效或接受少数分数，仲裁员资格还可能陈旧

- 原始条目：PX-R039-L001, PX-R039-L002, PX-R039-L003, PX-R039-L007
- 置信度：高
- 主要位置：src/server/services/ArbitrationService.ts:52-108；src/server/services/ArbitrationService.ts:64-89；src/server/services/ArbitrationService.ts:247-307；src/server/services/ArbitrationService.ts:184-244；src/server/services/BlockGradingConfigService.ts:31-71
- 影响：五轮以上阅卷中两个接近分数就可能代表“共识”，更大的反对组被当成离群值；另一聚类分支因未初始化永远为空，停用或越界教师仍可能被选为仲裁员。

### PX-COR-035：Token 持久化不是原子操作，多实例会相互覆盖会话

- 原始条目：PX-R039-L006
- 置信度：高
- 主要位置：src/server/services/AuthService.ts:55-95, 263-264
- 影响：整个 tokens.json 被直接覆盖且没有锁、临时文件或合并；崩溃会损坏全部会话，多实例竞争还会丢失新令牌或恢复已撤销令牌。

### PX-COR-036：题块评分配置接受会改变评分语义的非法最大值和部分分值

- 原始条目：PX-R035-L001, PX-R040-L003, PX-R042-L002
- 置信度：高
- 主要位置：src/server/routes/block-grading-config.ts:51-99；src/server/services/BlockGradingConfigService.ts:86-179；src/server/services/ReviewService.ts:188-205；src/server/services/ArbitrationService.ts:21-60, 111-120；src/server/services/ReviewService.ts:147-166；src/shared/grading.ts:131-143, 201-227
- 影响：零轮阅卷、负阈值、未知舍入、错误仲裁员和超出题目上限的部分分可直接进入持久化，使考试无法阅卷、总分异常或仲裁行为静默改变。

### PX-COR-037：识别流程用不安全的高分优先规则处理缺失、冲突和重复页面身份

- 原始条目：PX-R042-L003, PX-R042-L004, PX-R042-L005
- 置信度：中高
- 主要位置：src/shared/grading.ts:276-345；src/shared/grading.ts:404-417, 423-500；src/shared/grading.ts:381-402, 435-486
- 影响：缺失主观题会从分母消失，未知题可能增加分数；多个有效学生 ID 冲突时取第一页，跨页重复题又优先最高分，可能把一名学生成绩写给另一人并压低人工复核率。

### PX-COR-038：部署、演示和更新脚本会假报成功、在 dry-run 中修改文件或误杀无关进程

- 原始条目：PX-R044-L001, PX-R044-L002, PX-R044-L003, PX-R044-L004, PX-R044-L005, PX-R045-L001, PX-R045-L002, PX-R045-L003, PX-R045-L004, PX-R045-L005
- 置信度：高
- 主要位置：start-server.sh:8-34；testdata/demo-exams/scripts/build-backup.ts:20-32；testdata/demo-exams/scripts/build-backup.ts:34-50；testdata/demo-exams/scripts/seed.ts:155-192, 217-309；testdata/demo-exams/scripts/seed.ts:155-192, 217-232；testdata/demo-exams/scripts/import-all.sh:12-16
- 影响：服务或隧道已经退出时脚本仍宣布成功；dry-run 会改写构建产物，宽松 PID/端口匹配可能强杀无关服务，重启失败也被忽略。演示脚本还可能在活动数据库上执行无事务的破坏性清理。

#

## 八、验证边界与已知限制

本报告完全基于锁定修订的源码、配置、依赖清单、candidate ledger、验证记录、攻击路径记录和有界本地检查。没有进行真实网络攻击、凭据尝试、端口扫描、公共隧道启动、外部 AI 服务调用、破坏性备份/恢复、资源耗尽载荷或物理扫描器操作。

本地 npm audit 仅用于核对锁定依赖公告。TypeScript typecheck 已尝试，但当前 node_modules 缺少项目已声明的 express-rate-limit，导致 src/server/routes/auth.ts 报 TS2307；本快速报告不把该环境缺口误写成源码已经通过完整构建。

## 九、快速关闭标准

一个问题只有在以下条件同时满足时才可关闭：

1. 根控制已修复，不是只在单一路由增加表面判断；
2. 原始受影响位置均被覆盖，独立端点没有被同族问题的代表修复隐式遗漏；
3. 正常路径、拒绝路径、边界值、失败回滚和跨数据库语义测试通过；
4. 秘密、学生数据、原卷和成绩未进入新增日志或诊断；
5. 对安全问题保留对应 PX-SEC 编号，对逻辑问题保留 PX-COR 编号；
6. 构建/typecheck、授权回归、评分 smoke 和适用的部署验证均有真实命令输出；
7. 主任务全面报告中的 finding、coverage 和 write-up 状态同步更新。

## 十、证据入口

- 57 个安全问题去重清单：artifacts/04_reconciliation/deduped_candidates.jsonl
- 38 组逻辑问题：artifacts/04_reconciliation/correctness_curated.jsonl
- 248 条原始逻辑观察：artifacts/02_discovery/correctness_findings.jsonl
- 覆盖台账：artifacts/03_coverage/repository_coverage_ledger.md
- 验证关闭：artifacts/05_findings/validation_closure.jsonl
- 攻击路径关闭：artifacts/05_findings/attack_path_closure.jsonl
- 分块中文报告：报告分块/
- 结构化加固建议：hardening/hardening.md

---
本报告用于快速分派和处理；主任务的全面报告继续作为最终安全审计证据和封存结果。
