# 安全审查整改说明：判定为「无需新增代码」与「直接失效」的条目

核对日期 2026-10-04 · 分支 `fix/security-r02-scanner-access` · 后端仓库 Project-X

审查清单里的条目并非都需要（或都应该）改代码。以下几类要么在更早的批次里已经生效、要么其「风险」经
真实利用判定后不成立、要么它本质上是一个需要产品/现场决策而非服务端闸门的问题。按主理人定的规矩，
**这类条目不静默消失，而是留一份说明**：写清判定、证据、以及重新评估的触发条件。

本文件随批次滚动更新（第四批已录入；第五批 A 的判定见第六节、第五批 B 的判定与真机证据见第七节，
第五批 C 的判定与证据见第八节：R32/R33/R37/R45/R48 是代码整改；R42 的判定是「没有证书就签不了名」，
处置改为可验证的完整性凭据并附实测签名状态；R36 判为按设计公开、R39 给的是运维口径——
这两条都是明确处置而非新增代码，理由与**重新评估的触发条件**写在条目里）。

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

### R33 演示导入不再安装一套「口令公开、全校可见」的教师账号

**原判定**：演示导入创建两个教师账号 `demo-teacher` / `demo-teacher-2`，口令是**写在 README、
`testdata/README.md`、`readus/演示数据.md`、`manifest.json` 里的** `teacher123`；16 个演示学生的口令
等于学号。单看是「弱口令」，真正的杀伤力在第二半：这两个教师账号创建时**没有 `teacher_role`**，而
`src/server/routes/scores.ts:58` 有一条兼容分支——

```ts
if (!user.teacher_role) return null; // plain teacher: back-compat 全部可见
```

即「未配置 `teacher_role` 的教师」不做班级收敛，**全校成绩可见**。于是只要生产库导入过一次演示数据，
任何读过 README 的人都能用一个公开口令登录，并看到全校成绩。这条兼容分支本身有它的历史理由
（老库里的教师确实没有该列），不能删；能删的是「往生产库里塞一个命中它的公开口令账号」。

**处置**（单一来源 `src/server/services/demo/demoDataPolicy.ts`）：

- **口令默认随机换发**，每次导入都换：教师用 R01 那套 `generateBootstrapAdminPassword()`
  （16 位、四类字符、剔除易混字符、拒绝采样），学生走批量导入既有的 `generateRandomInitialPassword()`。
  随机口令只在**导入响应的 `message`** 里出现一次，同时用 `field-crypto` 的 `encryptField` 写进
  `users.initial_password`——管理员原本就能从「导出账密」里查回它，因此**不需要新的明文通道**，
  也不往服务端日志里打印口令（`stats.teacherCredentials` 在响应体里被剥成 `{username, fixed}`，
  避免同一份明文在响应里出现两遍被抓包/前端日志带走）。
- **教师范围同时收敛**：`teacher_role='subject_teacher'`，并任课「演示1班 / 演示2班」。
  只改口令不改范围是不够的——`subject_teacher` 的可见班级来自 `teacher_classes`，不挂就什么都看不到
  （演示面板空转）；挂演示班级则可见范围恰好圈在演示数据里。网阅演示不受影响，因为阅卷访问是按
  `review_assignments` 判的，种子照旧给两位演示教师分配题块。
- **固定口令只作为显式开关保留**：`PROJECTX_DEMO_FIXED_CREDENTIALS=1` 恢复 `teacher123` / 口令=学号。
  保留它不是心软——`testdata/demo-exams/scripts/verify.ts` 是**按 `manifest.json` 逐条登录断言**的验收脚本，
  没有可预期口令就没法自动验收。因此 `testdata/demo-exams/scripts/seed.ts` 会自己打开这个开关并打印
  「仅限隔离测试库」警告；生产环境的导入走 `POST /api/db/import-demo`，不经过那个文件。
  开关是布尔值，没有「默认/环境/天花板」三档，但沿用同一条纪律：**取值非法一律按关闭处理**并打印
  `[demo-policy] …`，绝不静默放宽。
- **升级即失效**：v1.9.8 之前崩溃残留的 `demo-teacher`（`is_demo=0`、`cleanupDemoData` 认不出来）
  照旧收编，但一律换发口令、补 `teacher_role`、打 `is_demo=1`。也就是说老库升级后
  `teacher123` **当场失效**，与 R01「历史公开口令一律视为无效」同一口径。
- **收编有边界**：`demo-teacher` / `demo-teacher-2` 是保留用户名，但若库里同名的 `is_demo=0` 账号
  真被业务用过（任课真实班级 / 被分配过阅卷 / 创建过考试），导入**整单拒绝**
  （409 `DEMO_TEACHER_USERNAME_TAKEN`）而不是改掉一个真实教师的口令与角色。
- **生产库导入需二次确认**：库里已有真实考试或真实账号（`admin` 除外）时，接口返回
  409 `DEMO_IMPORT_REQUIRES_CONFIRMATION` 并带回确认串 `IMPORT_DEMO_INTO_PRODUCTION`，前端二次确认后
  回传；CI/装机可用 `PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT=1` 免逐次确认。理由不是「怕误点」这么轻：
  演示导入写入 16 个账号与十几场考试，而 `clearDemoData` 只认「演示-」前缀与 `is_demo=1`，
  中间态最难还原。

**证据**（`npm run verify:demo-credentials`，SQLite 84 通过 / 0 失败；MariaDB 同一脚本 `--mariadb` 跑同一套断言）：

- 默认导入：两名教师口令互不相同、长度 ≥16、`!== teacher123`；用 `teacher123` 校验**失败**、
  用返回口令校验通过；`teacher_role='subject_teacher'`；`teacher_classes` 恰好 2 条且**全部指向
  `is_demo=1` 的班级**，指向真实班级的条数为 0；`decryptField(initial_password)` 等于返回口令。
- 16 名演示学生逐条 bcrypt 校验：**用学号登录成功的数量为 0**，且每人都有可解密的随机初始口令。
- 重复导入：上一轮口令**立即失效**（`verifyPassword(旧口令)` 为 false），且不叠加演示账号（仍是 18 个）。
- 开关：`=1` 时教师口令确实回到 `teacher123` 且**能登录**（证明开关生效而非被静默忽略）、
  `studentPasswordIsStudentNumber=true`；`=maybe` 这类非法值按关闭处理。
- 闸门：库里插入 1 场真实考试后，未确认导入抛 `DEMO_IMPORT_REQUIRES_CONFIRMATION`（`status=409`、
  带确认串、`realExams=1`），且**用户/考试/答题卡/年级/题块五项计数与拒绝前完全一致**、
  「演示-」前缀考试数为 0；带确认串放行；`=on` 放行；删掉变量后闸门恢复。
- 保留名：残留账号被收编（`is_demo` 0→1、补 `teacher_role`、`teacher123` 失效、换发口令、清理可回收）；
  在用的真实同名教师三条判据（任课真实班级 / `exams.created_by` / `review_assignments`）**逐条**触发拒绝，
  且拒绝时该账号的 `password_hash`、`is_demo`、`teacher_role` 原样不动；三条证据全部撤除后放行。
- 清单一致性：脚本接管的变量清单与 `DEMO_POLICY_ENV_VARS` 全等（新增开关却忘了在验证脚本里清空，
  会让「默认关闭」的断言在带脏环境的机器上假通过）。

### R48 演示卡号撞上真实答题卡：从「静默改写真实卡」改为「整单拒绝」

**原判定**：演示数据用**固定卡号**（`88000001` 语文、`88000002` 数学、`88000999` 网阅，以及周报晨测卡号），
而真实卡号由 `generateCardId()`（`src/shared/defaultCard.ts`）产出、落在 `10000000~99999999`——
**演示卡号就在这个区间里**。建卡用的是 `INSERT … IGNORE`，所以撞号不报错：演示考试静默挂到那张
**真实**卡上，随后 `ensureDemoObjectiveBlock` 给它补一个 5 题选择题块并写入标准答案 `A/B/C/D/A`，
作文/填空 seeder 再补上题块、知识点与 `assets/<cardId>/fig-demo.png`。后果不是「多了一张演示卡」，
而是**真实考试从此按演示答案判分**，且界面上看不出任何异常。

**处置**：

- **导入前整单拒绝**：`assertDemoCardIdsFree` 比对 `DEMO_CARD_IDS`（全部演示卡号的单一清单）与
  `answer_cards WHERE is_demo = 0`，命中即 409 `DEMO_CARD_ID_CONFLICT`，错误里点名卡号与卡标题，
  处置办法是删掉或重建那几张真实卡（重建会拿到新卡号）。这条闸与另外两条一起在
  `ensureCrossExamTables` / `cleanupDemoData` **之前**执行——拒绝时库里一个字节都没动。
- **纵深防线**：`isDemoCard()`（`src/server/services/demo/demoCardIds.ts`）挡在每个写题块的路径前面
  （`ensureDemoObjectiveBlock`、`essayDemo`、`fillBlankDemo`、`reviewDemo`）。判据**只看 `is_demo` 归属标记，
  不按卡号前缀猜**——真实卡拿到 `88000001` 也不算演示卡；不是演示卡就跳过并打印 `[seed]` 警告，
  绝不静默写入。
- **两个更彻底的做法本轮没做，理由记在这里**：把演示卡号搬出数字命名空间（例如 `demo-88000001`）
  能让撞号在物理上不可能，但要同时改 testdata 脚本、`assets/<cardId>/` 目录名与版式文件，
  波及面远超这条判定本身；给撞号的演示卡自动改号则要把一张 ID 映射表穿过所有子 seeder。
  两者都比「拒绝 + 告警」更贵，而「拒绝 + 告警」已经把静默数据损坏变成了显式失败。
  搬命名空间这条留给主理人决定（见第三节口径）。

**证据**：

- 插入一张 `is_demo=0`、`id=88000001`、标题「真实答题卡（与演示卡号撞号）」的真实卡后导入 →
  409 `DEMO_CARD_ID_CONFLICT`，`cardIds` 精确等于 `["88000001"]`，`message` 里带出卡标题；
  用户/考试/答题卡计数不变，该卡上的 `subjective_blocks` 与 `knowledge_points` 条数为 **0**，
  没有任何「演示-」前缀考试挂到它上面。
- `isDemoCard` 对同一张卡：`is_demo=0` → false，改成 `is_demo=1` → true（判据是归属标记而非卡号）。
- `verify-demo-safety.ts` 里那句「与演示 id 重叠会主键冲突，无法构造」的旧注释是**错的**（`INSERT IGNORE`
  根本不报冲突），已连同新增的撞号断言一并更正。

### R37 Ubuntu 服务器包以 root 运行：改为专用账号 + 幂等安装脚本

**原判定**：`scripts/package-server-ubuntu.cjs` 生成的 systemd 单元只有
`Type`/`WorkingDirectory`/`Environment`/`ExecStart`/`Restart`，**没有 `User=`/`Group=`/`UMask=`**，
systemd 默认以 **root** 启动；部署说明教的又是 `sudo cp -a . /opt/project-x-server/` +
`sudo cp systemd/*.service /etc/systemd/system/`，全程没有一步涉及属主或权限。结果是一个持有全校成绩、
答题卡扫描件与 SQLite 库的进程以 root 身份常驻，而数据目录还是解压时的 `0777&umask`。

**处置**（全部做在打包侧，现场不需要记规则）：

- 单元加 `User=projectx`/`Group=projectx`/`NoNewPrivileges=yes`/`UMask=0027`，外加
  `ProtectSystem=full`、`ProtectHome`、`PrivateTmp`、`PrivateDevices`、
  `ProtectKernel{Tunables,Modules,Logs}`、`ProtectControlGroups`、`ProtectClock`、`RestrictNamespaces`、
  `RestrictSUIDSGID`、`RestrictRealtime`、`LockPersonality`、空 `CapabilityBoundingSet`、
  `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`、`SystemCallArchitectures=native`；
  `HOME` 指到数据目录（非 root 身份下 `/root` 不可读，写缓存会失败）；
  `After`/`Wants` 从 `network.target` 改成 `network-online.target`（MariaDB 远端模式下路由未就绪会直接起不来）。
- 新增幂等 `systemd/install.sh`：建 nologin 系统账号 → 铺包体到 `/opt/project-x-server`
  （root 所有、`g+rX,o-rwx`、目录 `0750`）→ `/var/lib/project-x`（库 / 答题卡 / 自动备份）交给服务账号并
  `0750` → 安装单元 + `daemon-reload`/`enable`/`restart` → 回显 `User`/`Group`/`UMask`。
  **首次安装与升级是同一条命令**，所以「升级又变回 root」这条路不存在；旧的 root 手工安装重跑一次即完成迁移
  （属主与权限被重新纠正）。用 `g+rX` 而不是统一 `chmod 0640`，是为了不把 `node_modules/.bin`、
  `dist/server/index.mjs`、`.venv/bin/python` 的执行位改坏。
- `start.sh` 检测到自己是 root 时打印警告并指向安装脚本（前台试跑仍可用，但不留「就这么跑生产」的错觉）。
- 包内 `data/answer-card` 用 `mode: 0o750` 创建。
- **顺带修掉一个会让整条整改失效的既有缺陷**：`package-server-ubuntu.cjs` 在 Windows 上是 CRLF 检出，
  模板字面量把 `\r\n` 带进生成物——`start.sh`/`install.sh` 的 shebang 会变成 `/usr/bin/env bash\r`
  （Ubuntu 上直接 bad interpreter），单元的 `Environment=PORT=5174` 也会多个尾随 `\r`。
  四个生成器现在统一过 `toLf()`，与 `.gitattributes` 的 `*.sh text eol=lf` 对齐。这条不是审计项。

**两条刻意不启用**（理由写进单元注释与部署说明，避免下一个人当成漏项又加回去）：

- `MemoryDenyWriteExecute=yes`：V8 的 JIT 需要「先写后执行」的内存页，打开后 node 在启动阶段就崩。
- `SystemCallFilter=@system-service`：Node 与 Python sidecar 的实际系统调用集随版本漂移，
  收紧过头的表现是生产环境崩溃循环。单元里给了 drop-in 示例，启用后用
  `systemd-analyze security project-x-server` 复核。

`ProtectSystem` 用 `full` 而不是 `strict`：AI sidecar 的 `.venv` 与 `llmclient/.env` 就住在
`/opt/project-x-server` 下，`strict` 会把 `/opt` 变成只读。部署说明因此也改了 venv 的创建位置——
**必须在最终位置建**：临时解压目录里建好的 venv 复制过去后，console script 的 shebang 会指向失效路径。

**证据与边界**：

- `npm run verify:systemd-hardening` **77 通过 / 0 失败**：直接 require 打包脚本、渲染四份生成物做静态断言，
  其中包含两条**否定**断言（不得出现 `MemoryDenyWriteExecute`、不得有生效的 `SystemCallFilter`）、
  单元身份与安装脚本默认值逐项一致、数据目录三处 `0750`、代码目录 `g+rX,o-rwx`、
  以及对 `install.sh`/`start.sh` 的 `bash -n` 语法检查与「四份生成物都不含 `\r`」。
- 打包动作收进 `buildPackage()` 并由 `require.main === module` 触发，验证脚本无需 `dist/` 即可 require 生成器。
- CI 增加 `Ubuntu server package systemd hardening (R37)`；另加一个 `continue-on-error` 的
  `systemd-analyze verify`（运行器上既没有 projectx 账号也没有 `/usr/bin/node`，只作参考输出、不判失败）。
- **未验证的部分说清楚**：打包机是 Windows，本机跑不了 systemd，因此「服务真的以 `projectx` 身份起来、
  上传 / 字体读取 / 自动备份在沙箱里都能写」这一步**没有实测证据**，靠部署说明里的 `systemctl show`
  与三条 `sudo -u` 自检命令在现场兜底。这也是本条与第五批 B 的差别：B 组每条都有真机或双架构证据。

### R42 Windows 产物未签名：**没有证书就签不了**，改为提供可验证的完整性凭据

**原判定**：`package.json` 的 `build.win.signAndEditExecutable` 是 `false`，扫描端 exe / msi 既没有
Authenticode 签名，发布时也没有任何校验和。收件方看到的是一个「未知发布者」的可执行文件，
且**无法判断手上这份有没有被改过**——而这个客户端持有 API Key，能向服务器写入扫描结果。

**为什么不是「去签名」**：代码签名证书是私钥材料，**不得入库**；本轮也没有证书可用。
所以处置不是修好签名，而是把「未签名」这件事变成**可验证、可交代**的：

- 查了历史，`signAndEditExecutable: false` 是 2026-06-14 提交 `c4cdb02`（「修复了软件图标显示异常问题」）
  顺带加上的——它是图标 / rcedit 问题的规避手段，不是一个签名决策。README 里写明了打开它的前置条件
  （重新确认图标与非 ASCII 的 `executableName` 在 rcedit 环节没问题）。
- 新增 `scripts/hash-release-artifacts.cjs`，由 `release:hash` 调用，在 `release/` 下生成
  `SHA256SUMS.txt`（`sha256sum -c` 兼容、LF、按路径排序、跳过构建中间物与 `*-unpacked/`）与
  `BUILD-INTEGRITY.txt`（版本、构建提交、是否 dirty、每个产物的校验和与**签名状态**、
  未签名的原因与现场后果、两种校验方法）。`--check` 模式给收件方用：篡改、清单外多出的文件、
  清单里有而目录里缺的文件，三种情况都退出码 1 并点名。
- **接线到打包命令**：`electron:dist` / `electron:dist:ia32` / `electron:msi` / `electron:msi:ia32` /
  `package:server:ubuntu24` 五条全部以 `npm run release:hash` 收尾，所以产物不可能在没有清单的情况下
  被打出来。`electron:pack`（`--dir`，产物是目录、不是分发物）刻意不接。
- **签名状态不是猜的**：脚本用 PowerShell 的 `Get-AuthenticodeSignature` 逐个 exe/msi 取真实状态。
  产物名是中文（`答题卡扫描端.exe`），直接拼进 `-Command` 会被控制台代码页吃掉，
  所以文件清单写成 UTF-8 文件让 PowerShell 自己读、结果同样落文件再取回。
- **「以为签了」的守卫**：环境里给了 `CSC_LINK` / `WIN_CSC_LINK` 但 `signAndEditExecutable` 仍是 false 时，
  `release:hash` 打印警告——electron-builder 在这种情况下不会用那张证书，产物照样是未签名的。

**证据**：

- `npm run verify:release-integrity` **61 通过 / 0 失败**：一次性临时目录里真跑生成与校验，
  含改一个字节 → `--check` 失败并给出两个校验和、改回原样 → 重新通过、塞入清单外文件 → 失败、
  删掉清单内文件 → 失败、目录里根本没有清单 → 失败且不静默通过、空目录 → 不生成空清单冒充「已校验」。
  产物名刻意用中文，验证清单路径与签名检测都能处理非 ASCII。
- **实测确认了审计判断**：把本机 `release/win-ia32-unpacked/答题卡扫描端.exe`（180 MB，ia32 真实产物）
  交给脚本，`Get-AuthenticodeSignature` 返回 **`NotSigned`**——这条不是从配置推断的，是量出来的。
  非 PE 的假 exe 返回 `UnknownError`，同样被如实写进报告而不是被吞掉。
- 报告里的 `certutil -hashfile` 示例用**本次真实产物名**渲染，现场可以直接复制。

**边界**：校验通过只说明「与打包机产出时相同」，**不等于已签名**——它防的是传输途中的篡改与拿错包，
防不了「发布方本身被攻破」。这句话同时写在 `BUILD-INTEGRITY.txt` 与 README 里，避免清单被当成签名用。

### R45 自动保存竞态让「打印的这版」与「阅卷的那版」分叉：加单调 revision，导出前做版本闸门

**原判定**：答题卡是 1200ms 防抖自动保存的，而 `GET /api/cards/:cardId/pdf` 从**库里当前值**渲染。
老师点「导出 PDF」时，屏幕上那一版可能还没落库；PDF 真开始生成时，随后一次防抖保存又可能已经把它覆盖成
另一版。打印件与阅卷用的坐标布局于是可以来自**不同的两次保存**——纸上的题格与判分位置对不上，
而且全程没有任何提示。前端其实一直在传 `?v=`，但**`/pdf` 路由从来不读它**，等于没绑。

**为什么原来那个 `?v=` 即使读了也不能用**：传的是 `savedCard.updatedAt`，而

- `updated_at` 由 `CURRENT_TIMESTAMP` 写入，**只有秒级精度**——同一秒内的两次保存取到同一个值；
- PUT 响应里的 `updatedAt` 又来自 `normalizeCard` 的 `new Date().toISOString()`，
  与库里存的那个本来就不相等。

所以这不是「忘了比对」，是**没有可比对的值**。

**处置**：

- `answer_cards` 加 `revision INTEGER NOT NULL DEFAULT 0`（迁移 **v59**，SQLite 与 MariaDB 各一份；
  `schema.sql` / `schema.mariadb.sql` / `schema.mysql.sql` 三份建库语句同步）。
- 自增写在 SQL 里（`revision = revision + 1`）而不是「读—改—写」，避免并发丢号；
  `updateCard` / `updateCardInTx` 返回**落库后**的值。
- **请求体里自带的 revision 一律不采信**：`saveCardWithLayout` 返回 `{ ...normalized, revision }`，
  版本号取自 `updateCard` 的返回值。老师（或任何调用方）PUT 一个 `revision: 9999` 既改不库里的值，
  也拿不到与之匹配的 PDF。
- `/pdf` 在 `createPdf` **之前**过闸门（`cardRevision.ts:resolvePdfRevisionGate`）：
  相等放行；不等回 **409 `CARD_REVISION_MISMATCH`**（带两个版本号）；畸形回 **400 `CARD_REVISION_INVALID`**。
  三种结果都带 `X-Card-Revision`，且头在判定之前设置——被拦时调用方也能看到服务器当前是第几版。
- `?v=` **保持可选**：`scripts/deployment-business-smoke.ts` 与 `tools/repair-benchmark/run.mjs` 直接打 `/pdf`，
  它们不经过防抖自动保存、不在这个竞态里，省略即放行。但**传了就必须是合法整数**——
  不认识的旧值（ISO 时间戳）判 invalid，而不是当成「没传」静默放行，否则这条整改会被静默绕过。
- 前端三处配合：导出前**有界收敛**待存改动（`settleCardForExport`，最多 3 轮，用户持续敲键时明确放弃而不是无限重试）；
  `?v=` 改传 revision；并且**先 `GET` 一次卡本地比对**——PDF 是在新标签页打开的，服务端的 409 客户端拿不到，
  只让用户看到一个渲染失败的空白页。

**证据**：

- `npm run verify:card-export-revision`：SQLite **66 通过 / 0 失败**，本地 MariaDB 12.3.2 临时实例（13306）
  **66 通过 / 0 失败**。关键几条不是「跑通了」而是**量出来的**：
  连发 25 次保存得到 **25 个互不相同的 revision**，同期 `updated_at` 只有 **1 个取值**，
  并断言 `updated_at` 形如 `YYYY-MM-DD HH:MM:SS`（无小数位）——直接证明秒级时间戳当不了版本令牌；
  伪造 `revision=5027` 与 `-1` 后库里仍是 `+1` 递增；摘掉列与迁移记录重跑迁移，存量卡回填 0
  （老卡升级后第一次导出不会被误拦）。
- 闸门是纯函数，单测穷举 20 种畸形取值（空串、空格、`+1`、`-1`、`1.0`、`1e2`、`0x10`、`007`、11 位、
  `NaN`、`Infinity`、`null`、对象、数组、重复参数）。
- **验证脚本抓到两个真问题**（都是先写断言才发现的）：
  一是数组 `?v=7&v=7` 原先被 `join` 成 `"7,7"` 之外还可能被解析成合法值——同一个参数传两次，取哪个都是猜，
  现在一律判 invalid，且不做 `String()` 兜底（否则 `toString() → "7"` 的对象就能冒充版本号）；
  二是 MariaDB 模式下脚本**跑完不退出**——`closeDatabase()` 只关 SQLite 实例，连接池要靠 `resetAdapter()` 才
  `end()`，否则 CI 步骤会挂到超时。同批的 `verify-demo-credentials.ts` 有同样的毛病，一并修了。
- CI 两条：`Answer card export revision gate (R45)`（SQLite）与 `(R45, MariaDB)`（新开一次性库
  `projectx_card_revision_test`）。`npm run typecheck` 通过，`verify:security-critical` 仍 **407 / 0**。

**边界与未做**：

- 闸门只保证「**导出那一刻**」版本一致，不解决多写者丢更新：两个窗口同时改一张卡，后保存的仍会覆盖先保存的
  （谁都不报错）。要做严是 PUT 层乐观锁（`If-Match: <revision>` → 409），但它会让「两个标签页开着同一张卡」
  这种日常操作频繁报错，属于产品决策，本轮没做，已单独提给主理人。
- `revision` 每次保存 +1，不做回滚或复用；`is_demo` 与 `has_original_paper` 这类不改版式的写入不递增。
- 升级后存量卡都是 `revision=0`，第一次保存变 1——所以老库不会出现「闸门把所有人拦在门外」的现场事故。

### R36 赞助接口匿名可读：收款码本来就要给用的人看，判定为**按设计公开**（不改代码）

**原判定**：`app.use("/api/sponsor", sponsorRoutes)` 没挂任何鉴权中间件，匿名请求 `GET /api/sponsor`
能拿到标题、说明与启用中的渠道列表，`GET /api/sponsor/qr/:channelId` 能直接取到收款码图片。

**为什么不加鉴权**：这两个接口返回的是**运营方自己的收款渠道**，不含任何校务数据
（无学生、无成绩、无答题卡、无凭据）。赞助页的用途就是「谁在用这个软件，谁都能看到怎么打赏」——
把它收到登录后面，等于让未登录的安装用户看不到一个他们本来该看到的东西，是功能退化而不是收紧。
需要区分的是：前端 `canOpenMode("sponsor")` 只在**学生端形态**隐藏了这个入口（`App.tsx:446`），
那是页面可见性，不是数据边界；真要涉密的内容不该靠这一层。

**核对过的技术点**（这几条如果成立就是要改代码的）：

- **路径穿越**：`resolveQrPath` 先 `path.basename(qrFile)` 再 `fullPath.startsWith(sponsorQrDir)`，
  文件名里的 `../` 在 basename 阶段就没了，配置被写成绝对路径也一样落回 qr 目录。不成立。
- **越权读文件**：`sendFile` 只可能命中 qr 目录里的文件，渠道 id 与文件名的对应关系来自服务端配置文件，
  请求方只能通过 id 间接选中，选不到别的文件。不成立。
- **匿名枚举**：`GET /api/sponsor` 已经把 `enabled: false` 的渠道过滤掉，未启用的渠道不出现。

**处置（明确、可执行，而不是「就这样吧」）**：

1. 现场要收口的话有两条**现成**的路，不需要改代码：把 `sponsor.json` 里对应渠道的 `enabled` 置 `false`
   （列表与图片同时消失），或在反向代理上屏蔽 `/api/sponsor`。
2. 部署说明与 README 里**不**把这个接口描述成受保护资源，避免下一个人以为它跟 `/api/cards/*` 同门槛。
3. **重新评估的触发条件**（写死在这里，改一条就要改代码）：一旦 `sponsor.json` 或 qr 目录里出现
   不该匿名可见的内容——运营方真实姓名 / 学校署名的收款账号 / 与校务数据同目录混放——本条立即升级为
   需要鉴权或需要开关的项，而不是继续按公开处理。

**证据**：判定基于代码通读（`src/server/routes/sponsor.ts` 全文 97 行）与挂载点
（`src/apps/answer-card/server/index.ts:1044`）。没有新增验证脚本：一条「不改代码」的判定配一个
只断言「它还是匿名的」的脚本，会在将来真要收紧时变成阻力，所以这里只留判定与触发条件。

### R39 数据目录换位置后「答题卡还在、文件打不开」：本轮给的是**运维口径**，不是服务端闸门

**原判定**：卡片的元数据（标题、题块、分值、答案）在数据库里，而**布局 JSON、上传图片、原卷、答案卷、
识别裁图全在 `ANSWER_CARD_DATA_DIR`（默认 `cwd/data/answer-card`）下**
（`storage.ts:11-19`）。把环境变量指到别处、或换了工作目录再用默认路径启动，结果不是报错而是
「列表里答题卡都在，点进去原卷 404、图片不见了」——看起来像数据丢了。

**为什么不学 R31 那样在启动时说出来**：R31 能给警告，是因为「哪一个是真库」有可判别的信号
（同机还有别的 `projectx.db` 文件）。文件侧没有这个oracle：

- **不自动回退到探测到的另一个目录**——「静默改用一个别的数据目录」与「静默新建一个空目录」
  是同一类错误，只是更难发现。这条与 R31 的结论一致（`paths.ts:21-30`）。
- 连「新目录是空的而库里有 N 张卡」这个信号都不干净：**迁移过来的合法新装就是这个样子**，
  按它告警会在最该安静的场合喊狼，几次之后现场就把启动警告当噪音。

**处置（本轮可执行的部分）**：

1. **整目录一起搬**：`answer-card` 是数据目录的整体，Move 而不是只改环境变量；
   只改 `ANSWER_CARD_DATA_DIR` 而不搬文件，等于把卡片留在原地。
2. **在 unit / 桌面端里显式写死**，不让它跟着 cwd 走。R37 这一轮已经把
   `ANSWER_CARD_DATA_DIR=/var/lib/project-x/answer-card` 与 `PROJECTX_DB_PATH` 一起写进 systemd 单元，
   Electron 侧同样显式给路径——**剩下会踩这条的只有「直接 `node dist/server/index.mjs`」的 standalone 形态**，
   也正是 R31 警告覆盖到的那个形态。
3. **自检**：搬完之后用 `ls <数据目录>/layouts | wc -l` 与 `SELECT COUNT(*) FROM answer_cards` 对数，
   两个数量对不上就是目录指错了。整套步骤（停服 → `mv` 整目录 → `systemctl edit` 写死新路径 → 属主/权限 → 对数）
   已写进 `deploy-guide.md` 的 **2.4 节**，并在第九节「安全与合规建议」列为第 8 条，不要求现场记规则。

**重新评估的触发条件**：如果将来在数据目录里落一个清单文件（例如 `answer-card/.projectx-manifest`，
记 `card_id` 集合或卡总数），就有了可靠的「这份文件配不上这个库」判据，届时启动时拒绝或警告都可以实现，
本条从「运维口径」升为「服务端闸门」。本轮没有该清单，也没有靠一次迁移就能把它补上的安全方式
（老目录里的文件已经和新目录分离了，事后写清单等于写错的清单）。

**证据与边界**：判定依据是 `storage.ts` 与 `paths.ts` 的解析路径、R31 已有的诊断实现，以及 R37 单元里
显式设置的两条路径。**本条没有实测复现**：要复现需要一份真实的「旧目录有卡、新目录为空」的现场样本库，
本轮手上没有（也不该拿学校数据造样本）；所以上面给的是能立刻执行的运维口径与自检命令，
而不是一句「已修复」。




