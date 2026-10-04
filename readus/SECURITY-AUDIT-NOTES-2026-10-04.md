# 安全审查整改说明：判定为「无需新增代码」与「直接失效」的条目

核对日期 2026-10-04 · 分支 `fix/security-r02-scanner-access` · 后端仓库 Project-X

审查清单里的条目并非都需要（或都应该）改代码。以下几类要么在更早的批次里已经生效、要么其「风险」经
真实利用判定后不成立、要么它本质上是一个需要产品/现场决策而非服务端闸门的问题。按主理人定的规矩，
**这类条目不静默消失，而是留一份说明**：写清判定、证据、以及重新评估的触发条件。

本文件随批次滚动更新（第四批已录入；第五批 A 的判定见第六节、第五批 B 的判定与真机证据见第七节，
第五批 C 的判定与证据见第八节，其中 R36/R39 给出的是明确处置而非新增代码）。

---

## 一、经核对「已由既有实现覆盖」，本批只更正文档而非新增代码

### R11 的另一半：单次调用的输出 token 上限

**结论**：请求体注入不进 `max_tokens`，无需在服务端再加一道钳。

**证据**：边车侧的请求参数由常量决定，不接受客户端覆写——
`llmclient/providers.py` 组装 kwargs 时写死 `"max_tokens": 8192`，
`llmclient/providers_knowledge_points.py` 两处写死 `max_tokens=4096`。
服务端→边车的请求体（`llmclient/server.py` 的分析入口）里没有 `max_tokens` 字段可被前端填写。

**本批实际做的事**：配额落在**次数与累计用量**维度（见 CHANGELOG 第四节 R11），并更正一处**文档错误**——
`src/shared/aiQuotaLimits.ts` 的注释原先声称输出上限「由边车侧固定为 `PROJECTX_LLM_MAX_OUTPUT_TOKENS`」，
而这个环境变量**并不存在**（全仓库检索只命中该注释本身）。注释已改为引用真实常量位置。

**重新评估的触发条件**：若将来真的把 `max_tokens` 做成环境变量（见「三、留给主理人的可选做法」），
这条判定就要重走一遍——那时它变成「可配上限」，必须同套三档口径（默认 + 环境变量 + 天花板）。

---

## 二、经真实利用判定后不成立 / 接受风险（不改代码）

### A01 学生伪造红笔标记（F050）

**结论**：主理人已明确**接受该风险（wontfix）**，本批及后续批次均不得「顺手修复」，也不得再作为待办列出。

**为什么这不是遗漏**：红笔标记的生成端在浏览器，服务端只收结果。要彻底挡住伪造，等于把判分权从
教师端搬到服务端重算，属于产品形态变更而非安全补丁；现网威胁模型里，能伪造标记的人本来也能直接改分
（同一份请求体），而改分侧已有 `grade:write` + 题块范围 + 审计（见第三批 R09/R03/R08）。

**重新评估的触发条件**：一旦引入「教师端离线判分、结果事后批量上传」这类无法在线校验的形态，
本判定失效，需要单独出方案。

---

## 三、留给主理人的可选做法（本轮未做，因为超出清单要求）

1. **把边车的 `max_tokens` 做成可配**：现场确有「长文本整班分析被 8192 截断」的诉求时，
   应按本仓库既定三档口径实现（`PROJECTX_LLM_MAX_OUTPUT_TOKENS`，默认 8192、天花板比如 16384、
   非法值回落默认），而不是让客户端填。代价：多一个能被配错的档位，且天花板必须落在
   「单次调用成本可接受」的范围内——这也是它当初被写死的原因。
2. **AI 配额走「按服务商分别计」而不是「按用户分别计」**：现在的账本按 `user_id` 归因
   （`ai_analysis_jobs.created_by` / `ai_analysis_runs.user_id`），`providerOverride` 用的是调用者自己的 Key，
   因此「花自己的钱」的路径已被同一道闸覆盖。若要按 Key 分别限额，需要给 `ai_providers` 增加用量列并改结算路径。

---

## 四、清单中仍在观察的两个状态（不属于「失效」，但不能当作已完成）

- **R36**：待产品确认（是否需要在服务端强制该行为，取决于产品对交互语义的定义），未动代码。
- **R39**：待复核（判定依赖现场设备/流程，本机无法构造真实条件），未动代码。

这两条会在第五批给出明确处置（改 / 并入本文件 / 保留为待确认），不会长期停在「待复核」。

---

## 五、复检口径（本批判定的验证方式，供复现）

- **双方言都跑，不看汇总**：SQLite 侧 `npm run verify:security-critical` **251/0**；
  MariaDB 侧本机 12.3.2（13306 临时实例）`npm run verify:mariadb` **12 节全 PASS**，
  另用一次性探针库 `projectx_quota_test` 直接验证配额 SQL 的时间窗口径（跑完即 `DROP DATABASE`）：
  `dialect=mariadb`、列默认值写入的行按本地时间进窗、直写带 `T` 的 ISO 被 `Incorrect datetime value` 拒绝、
  25 小时前的记录不进窗、两个未完成任务触发 `maxActiveJobsPerUser`、`assertAiQuota` 抛 429 —— 5/5。
- **不用健康检查代替边界验证**：容量、配额、超时、并发四类都是**按边界值**断言
  （恰好等于上限放行、越一格拒绝；并发峰值 `> 1` 且 `≤ 上限`；半挂连接在预算内被判超时）。
- **Python 侧**：`python llmclient/scripts/verify_pdf_render_isolation.py`（21 项）与
  `python llmclient/scripts/verify_llm_usage.py`（18 项）全过。真实渲染用例需要 `pymupdf`，
  缺它时那些用例会**静默 skip**——只有看到 `Ran 21 tests` 才算渲染隔离被真验过；
  CI 已新增 `LLM Sidecar (Python) Regression` 作业（装 `llmclient/requirements.txt` 后跑这两条脚本）来消除这个盲区。
- **SHA 固定**：本批结论对应的代码状态见分支 `fix/security-r02-scanner-access` 上
  「第四批：服务端资源与 AI 链路」那一次提交；重跑请固定到该 SHA，而非 `main` 的最新值。

---

## 六、第五批 A 的三条「不这样做反而更糟」判定

清单给这几条留了不止一条出路，下面记下选了哪条、为什么，以及代价落在谁身上。

### R41 废弃独立页面：**删除**，而不是修好它

`Grade-Analysis-System-database.html` 的 `SyntaxError: Unexpected identifier 'fetchExams'` 本身只是 P3 提示，
但它的存在方式有三个问题：不在 Vite 生产入口（`vite.config.ts` 只打 `index.html` 与扫描端入口）、
仓库内**没有任何文档或脚本引用**、且它自己带着与 R12 同型的 `localStorage.px_token → Bearer` 流程。
「修好异步聚合」等于给一个没人用的页面补测试与后续维护责任，而「删掉」对现网零影响。
文件在 git 历史里，需要时 `git checkout <第四批 SHA> -- Grade-Analysis-System-database.html` 可原样取回。

**重新评估的触发条件**：若有人主张该页面在仓库外被单独部署（例如给某个教研组自用），
则按 R12 的同一套处理（固定 API 来源 + 移除旧 token 流程）恢复它，而不是保持删除。

### R12 移动分析页面：**原地收紧**，而不是删页

同样是「旧独立页面」，处理与 R41 相反，理由是可部署性事实不同：`deploy-guide.md` 明确写着
`cp Grade-Analysis-System-mobile.html /var/www/project-x/`，`SERVER-README.md` 还专门警告不要用它覆盖
`dist/web/index.html`——它是**在用的部署产物**，删页就是删功能。因此改成「目标只取自页面内
`<meta name="px-api-base">`」：同源部署留空、跨源部署由部署方写死，URL 参数一律忽略并给可见提示。

**代价（写在部署文档里，不让现场踩）**：跨域部署从「改链接参数」变成「编辑 HTML 头部一行」。
如果将来要恢复「运行时可选后端」的需求，正确做法是加一个**由后端下发的配置接口**或部署期模板替换，
而不是把 `?api_base=` 放开——凭据发往哪里不属于客户端可决定的范围。

### R30 单次票据：**刻意不落库**，登出即失效

票据若写进数据库（为了「重启后仍可校验」），就会随 `mysqldump`/备份文件长期存活，
变成它本来要替代的那种长效凭据——泄漏一份备份等于泄漏全部历史票据。现在只放内存：
重启后已发出的票据一起失效（页面重新 `POST /api/auth/media-ticket` 即可），登出主动吊销。

**配套要求（不是服务端能自己做完的）**：nginx `access_log` 默认记录完整请求行，`?mt=` 与历史的 `?token=`
都会进代理日志。`deploy-guide.md` 已给出「只记路径、不记查询串」的 `log_format` 配方；
服务端自己的日志由 `src/server/lib/logRedaction.ts` 截断。**验收时请把「代理日志里没有完整凭据」
作为独立一项确认**，服务端全绿证明不了部署方的日志配置。

**为什么白名单只有 14 条**：模式逐条与 `grep router.get / app.get` 的真实注册核对过，
并按「浏览器会不会自己发起这个 URL」取舍。CSV/Excel 导出经 `downloadBlob → authFetch` 走头认证，
不需要 URL 凭据，因此**不进**白名单；多写的模式等于无谓扩大 `?token=` 的适用面。

---

## 七、第五批 B（扫描端与原生识别器）的判定与证据

这一批改的是 **Windows 原生进程**：Electron 主进程、TWAIN 桥接子进程、答题卡识别器子进程。
与前四批不同，这里没有「服务端全绿就代表生效」的余地——原生侧的行为只能靠真机、真驱动、
真图片去验。下面记下每条的取舍理由与可复现证据。

### R19 识别器资源边界：边界放在**解码之前**，档位放在**子进程环境变量**里

清单给的说法是「解码 bomb / 超大布局」。真正的取舍有两处：

1. **像素预算必须在 `cv::imdecode` 之前生效**。只在解码后判 `image.total()` 是不够的——
   声明炸弹（IHDR 写 20000×20000、实际数据几 KB）会让 OpenCV 先把几 GB 分配出来再失败，
   32 位扫描端上这直接是崩溃而不是拒绝。因此 `vision_utils.cpp` 先按容器头声明的尺寸预拒
   （PNG IHDR / BMP DIB 含 BITMAPCOREHEADER / JPEG SOF 标记游走 / TIFF 首个 IFD 的 256、257 标签，
   条目循环上限 512 / WebP VP8X·VP8L·VP8 ），解码后再按真实 `total()` 复核一次。
   `verify:recognizer-limits` 用 `PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS=1000000` 断言错误信息里
   含「头部声明」四个字——**这条断言就是为了证明拒绝发生在解码前**，不是解码后。
2. **默认档位按架构分档**，因为 32 位进程只有 2 GB 用户地址空间：x64 默认 100 Mpx / 天花板 400 Mpx，
   ia32 默认 40 Mpx / 天花板 70 Mpx。参照物：A4@300 = 8.7 Mpx、A4@600 = 34.8、A3@600 = 69.6、
   A4@1200 = 139、A3@1200 = 278。也就是说 **ia32 上把天花板抬到 70 Mpx 以上没有意义**——
   再高不是「拒绝」而是「崩」，这属于必须写进文档、不能靠环境变量放宽的一类。
   UI 只提供 150–600 dpi，服务端夹在 [50,1200]；真要在 x64 上跑 A4@1200（139 Mpx），
   出路是显式设 `PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS=160000000`，README 已写明。
3. **诊断一律走 stderr**，`stdout` 仍然只有那一份 JSON——`recognition.ts` 的契约没动，
   档位摘要（`[recognizer-limits] …`）由父进程环境继承，服务端与 Electron 都不需要改代码。

**证据**：`npm run verify:recognizer-limits` 在 x64 与 ia32 两个产物上各 **45 通过 / 0 失败**
（ia32 用 `ANSWER_CARD_RECOGNIZER_EXE=resources/native/win-ia32/answer-card-recognizer.exe` 指定）；
既有的 `verify:recognizer-layout`、`verify:recognizer-pencil` 在**两个架构**上同样全绿
（即「加了边界没有把正常卡拒掉」）；`verify:security-critical` **365 / 0**（新增 R19 静态断言：
7 个档位都写成「默认值 + 环境变量 + 天花板」三档、每档天花板不低于默认值、
`read_capped_file` 出现在 `cv::imdecode` 之前且源码里不再有 `std::istreambuf_iterator`、
`assert_pixel_budget` 出现在 `cv::warpPerspective` 之前、`assert_array_size` ≥ 9 处、
`SetErrorMode` 与档位摘要都在 `main.cpp` 里）。

**踩坑（写下来是为了下次别再踩）**：本机原本缺 `D:\opencv4-13` 与 `D:\nlohmann`，
两个架构都编不出来，也就无法给出上面那份真机证据。恢复方式全部在仓库外、不改任何构建脚本：

- `D:\opencv4-13\opencv\build` 与 `D:\opencv4-13\32\opencv_install_win32_vs18\include`
  都是指向本机已有 `D:\opencv-dl\opencv\opencv\build`（及其 `include`）的目录 junction；
- ia32 的 `x86\vc18\bin\opencv_world4130.dll` 取自仓库里已打包的 `resources/native/win-ia32/`，
  而**配套的导入库本机没有**，于是用 `dumpbin /exports` 导出符号表 → 生成**不带引号**的 `.def`
  → `lib /def /machine:x86` 合成 `opencv_world4130.lib`（放在 `…\x86\vc18\lib\`）。
  这里有一个坑：`.def` 里给导出名加引号会让 `lib.exe` 把引号**写进符号名**
  （`__imp__"?imdecode@cv@@…"`），链接时 41 个 LNK2001 全部对不上；去掉引号后即干净通过。
- `D:\nlohmann\include\single_include\nlohmann\json.hpp` 取自 nlohmann/json **v3.11.3**
  （`curl` 直连 raw.githubusercontent 在本机报 SSL 错误 exit 60，改用 git clone 后拷单头文件）。

**这些路径不入库、也不进 CI**：`scripts/build-answer-card-recognizer.bat` 与 `.vcxproj`
里写的仍是仓库原有的绝对路径约定，本次只是把本机补齐到那个约定上。别人复现时要么按同一约定准备 SDK，
要么改自己的本地路径——但**不要**把 junction 或合成库写进仓库。

### R23 Electron 权限：**默认全拒**，连主框架导航一起收

扫描端页面不需要任何媒体/设备权限（扫描走 TWAIN 桥接子进程），所以 `permission-request` /
`permission-check` / `device-permission` 三个处理器一律 deny。顺带修掉一个同源问题：
原先只有 `setWindowOpenHandler` 管新窗口，**页面内 `location` 跳转不受限**，
一旦跳到任意来源，之后的请求就都出自那个来源。现在按同源放行、跨源 https 交系统浏览器
（与新窗口同一套口径）、其余协议一律拦下。

### R31 默认库路径：**只把事实说出来，不自动切库**

`process.cwd()` 决定默认库位置，换个工作目录启动就会静默新建空库，现场表现为
「数据全没了 + 管理员口令按引导态换发」（并因此触发 R01 的随机口令）。
这里的取舍是**不做自动切换**：静默改用探测到的另一个库，与静默新建空库是同一类错误、只是更难发现。
改为在建库之前打印「解析到哪、是否已存在、同机还有哪些候选库」（从模块目录向上四级探测
`data/projectx.db`，不写死任何厂商路径），日志前缀 `[db-path]`，由运维显式设 `PROJECTX_DB_PATH` 收口。

### R38 兜底强杀：**宁可不杀，也不能杀错**

Windows 回收复用 PID，取消扫描时那条 2 秒兜底 `taskkill /F /T /PID` 有可能打到一个完全无关的进程
并带走它整棵子树。现在启动时记录身份快照（父 PID + 可执行文件路径 + 启动时刻），
强杀前用 PowerShell CIM 读回真实进程信息比对；**任一项读不到**（权限不足、进程已消失）
或已观察到退出，一律跳过强杀，交桥接自身超时兜底。判定抽成纯函数 `decideForceKill` 以便直接断言
（`verify:scanner-cancel` 第 5 节 13 条）。`close`/`error` 统一走 `retireActiveScan`，
既清注册项也清兜底定时器——否则定时器可能在 PID 已被复用之后才触发。

### R34/R35：两条「静默出错」的闭合

- **R34**（无二维码时页序错位会把答卷挂到别人名下）：兼容模式下**只有布局第 1 页能为本组定学号**
  （学号填涂区只在第 1 页生成），其它页即使读到学号也只记在自己名下并打 WARN；人工订正不受此限。
  会话级再加一道：纸张总数不是每份卡用纸数的整数倍，或任一份第 1 页学号不可信 → **整批不入库**，
  交人工归组。严格模式有二维码逐页校验，行为不变。
- **R35**（扫描端离线期间服务器改了卡，按旧版卡算出的分数静默入库）：新增 `src/shared/cardVersion.ts`
  按卡内容算 96bit 指纹，`POST /sessions` 与 `/sessions/:id/complete` 双端核验
  （400 `CARD_VERSION_REQUIRED` / 404 `CARD_NOT_FOUND` / 409 `CARD_VERSION_MISMATCH`），
  被拒时不建会话、不改状态、不入库并打 WARN。**指纹刻意不含 `updatedAt`**：
  本地导入会重盖时间戳，含进去会让每次上传都被误判为版本不一致；
  也**不用 Web Crypto**——`http://局域网IP` 这类非安全上下文里没有 `crypto.subtle`。

### R40 TWAIN DSM：真机证据（这是本批唯一「必须靠设备」才能确认的一条）

改法见 CHANGELOG（候选一律绝对路径、`LoadLibraryExW(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS |
LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR)`、`wmain` 第一件事 `SetDefaultDllDirectories`、
`TWAIN_DSM_DLL` 只接受绝对路径、包内那份还要经 `GetFinalPathNameByHandleW` 确认没离开安装目录）。
真机验证（Windows，本机装有 KODAK i3000 TWAIN 驱动）：

- **x64**：`resources/native/win-x64/scanner-bridge.exe list` → `dsm_loaded=true`，
  `dsm_path` 为安装目录内的绝对路径（203120 字节），枚举出 `KODAK Scanner: i3000`。
- **ia32**：`resources/native/win-ia32/scanner-bridge.exe list` → `dsm_loaded=true`（173424 字节），
  同样枚举出该扫描仪。
- **CWD 投毒**：把 `scanner-bridge.exe` 单独放进空目录、在另一个目录里放伪造的 `TWAINDSM.dll`
  与 `twain_32.dll` 并从该目录启动 → 两个伪造文件都没进候选，`dsm_search` 只列出绝对路径，
  最终按 `DSM_LOAD_FAILED` 安全报错；`c:\windows\twain_32.dll` 因位宽不符被 `err=193` 拒绝。
- **环境覆盖**：`TWAIN_DSM_DLL=TWAINDSM.dll`（相对值）被忽略；改成绝对路径后正常加载并枚举成功。

**代价（要告诉现场）**：便携使用（把 exe 拷到别处、旁边放一份 DSM）不再可行，
DSM 必须在安装目录或 Windows 目录内；安装包因此**必须带上 `TWAINDSM.dll`**——
`verify:security-critical` 已加断言：凡是 `resources/native/win-*/scanner-bridge.exe` 存在，
同目录必须有 `TWAINDSM.dll`，缺了只能报错，不允许退回搜索路径。

### 复检口径（沿用第五节，本批的两点差别）

- **原生侧不看汇总**：识别器与桥接的每条边界都按**边界值**断言
  （恰好等于上限放行、越一格拒绝；非法值回落默认；超天花板夹紧并留 stderr 一行），
  并且「夹紧是有效的」用一对相反用例证明（同一档位先设合法值再设超天花板值）。
- **两个架构都要跑**：x64 绿不能代表 ia32 绿——像素档位、DSM 位宽、导入库都不同。
  本批所有识别器回归都在 `win-x64` 与 `win-ia32` 两份产物上各跑一遍。
- **SHA 固定**：本批结论对应分支 `fix/security-batch5-web-scan-deploy` 上第五批 B 的四次提交
  （`ba7f970` R23/R31/R38、`8d68ba4` R34/R35、`b8bbbc4` R40，以及 R19 那一次）；
  重跑请固定到这些 SHA。

---

## 八、第五批 C（部署、文档与演示数据）的判定与证据

### R32 跨机明文 HTTP 不再送出凭据

**原判定**：服务器地址由老师手输，少写一个 `s` 就变成 `http://`，此后 API Key、上传令牌、
带 `?token=` 的媒体地址全部走明文；v2.5.6 为了修「填 `192.168.1.10:5174` 连不上」还专门给
缺 scheme 的输入**自动补 `http://`**——那条现场修复是对的（不能要求每台学校内网机都装证书），
但它把明文变成了默认路径。

**处置**：保留自动补全，**把闸门放在「要不要送凭据」这一步**，单一来源
`src/apps/answer-card/client/lib/remoteCredentialTransport.ts`。判定顺序固定为
`https` → 回环 → 老师显式放行 → 拒绝：

- **回环豁免**是硬要求：本机 `http://127.0.0.1:5174` 内嵌服务是扫描端唯一的工作方式，
  把回环一起拦掉等于产品不可用。识别只认 `localhost`、完整四段的 `127.0.0.0/8`、`::1`（含方括号）；
  `127.1`、`128.127.0.0.1` 这类**看着像回环**的一律按远端处理（fail-closed）。
- **显式放行按 `host:port` 精确记账**，存 `projectx_insecure_http_hosts`（最多 16 条、单条 ≤255 字节，
  脏值整批丢弃）。不做通配、不做前缀匹配、不做「同网段」推断——放行 5174 不等于放行 5175，
  放行 `192.168.1.10` 不等于放行 `192.168.1.11`。
- **勾选框随地址变化自动取消**（`hostRef` 比对）：老师为 A 机放行过，再改成 B 机时必须重新确认，
  否则一次勾选会变成对内网所有机器的长期授权。
- **构建期的 `VITE_PROJECTX_API_BASE` 不在闸门内**：那是部署方在构建时写死的选择，
  Web 端没有界面可勾选，把它一起拦掉会让内网明文部署的 Web 端直接不可用且无从解除。
  这条界线写在代码注释、`verify:security-critical` 断言与本说明里，不靠记忆。
- **被拦下的不是「网络错误」**：抛出的错误带 `noRetry: true` 与
  `code: "INSECURE_REMOTE_TRANSPORT_BLOCKED"`，上传队列据此判定为配置问题而不进重试；
  `scannerSync` 也**不静默回退本机缓存**——回退会让老师看到卡列表照常出来、以为同步正常，
  比直接报错难查得多（与 R35「不许悄悄给旧数据」同一口径）。
- **无凭据探测仍然放行**：`/api/app/health` 不带 Key，所以「测试连接」能区分
  「服务器根本连不上」与「连得上但明文被拦」，界面上是两句话而不是一句含糊的失败。
- **带 token 的 URL 一并不给**：明文传输下 `?mt=`、`?token=` 会落进浏览器历史与代理日志，
  宁可直接 401，也不把令牌写进 URL。

**证据**（`npm run verify:insecure-remote-transport`，57 通过 / 0 失败）：

- 起真实 `http.createServer` 绑 `0.0.0.0:0`，再从 `os.networkInterfaces()` 取本机 LAN 地址，
  用**跨机明文**这一路径发带 Key 的请求 → 请求被拒且服务端**观察到的请求数为 0**
  （证明凭据没离开进程，而不是「发出去了但对端报错」）。
- 同一地址去掉 Key 的健康探测 → 通过；`grantInsecureTransportAllowance` 后 → Key 送达；
  `revokeInsecureTransportAllowance` 后 → 再次被拒。
- 回环明文 + 空放行列表 → Key 正常送达（本机模式未被误伤）。
- 纯函数侧逐条断言：`127.1` / `128.127.0.0.1` 按远端处理；放行列表对**不同端口、不同主机、
  去掉端口**的写法都不生效；无法解析的地址返回 `unparsable` 且 `allowed: false`。
- 文档侧断言：三份用户文档不再出现 `http://192.168.x.x` 之类的明文示例，必须出现 `https://`
  与 R32 说明——**示例本身就是现场照着抄的东西**，留着明文示例等于留着一条默认不安全的路。


