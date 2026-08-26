# 扫描端图片上传与进度可视化（v2.5.1）设计文档

- 分支：`feat/scanner-upload-progress`
- 版本：2.5.1（package.json 单一来源，vite 注入 `VITE_APP_VERSION`）
- 日期：2026-08-25
- 状态：设计定稿，待实施

## 一、背景与问题

扫描端（Electron ScannerPanel 构建）连接远端服务器后，图片实际上传链路存在四类问题：

1. **直扫自动上传被卸载竞态取消（P0 缺陷）**：SSE `done` 事件先回调 `onScansComplete`（`ScannerPanel.tsx:279`），其内部 `setScanning(false)`（`ScannerWorkspace.tsx:122-125`）立即卸载 ScannerPanel；卸载清理函数 `clearTimeout(uploadTimerRef.current)`（`ScannerPanel.tsx:177`）把同一事件里刚排定的 `setTimeout(uploadToRemote, 500)`（`ScannerPanel.tsx:283-285`）取消。结果：remote 模式的自动上传从未发出，且唯一可见的上传状态条随面板一起消失，用户全程无感知。
2. **导入阅卷没有上传能力**：「导入阅卷」只调本机接口 `POST /api/cards/:cardId/grading`（`ScannerWorkspace.tsx:81-102`），图片不出本机。
3. **上传过程零可视化**：唯一的上传反馈是面板内一条小状态条，且仅在扫描完成后短暂存在；无逐页进度、无失败明细。
4. **弱网/断网无处理**：单页失败即整批失败（throw 中断循环），无重试、无断线暂停恢复。

附带发现：由于 `done` 即卸载，面板的 done 视图（成绩表、页明细）同样从未展示过。

**服务端现状（零改动前提）**：三步协议齐备——`POST /api/scanner/upload/sessions` 预生成每页 token；`POST .../pages` 校验魔数+token 后写盘并 `UPDATE twain_scan_records SET ocr_status='uploaded' WHERE id=token`（**token 无已消费标记，同 token 重传为幂等覆盖，天然支持续传/重试**）；`.../complete` 完整性校验（缺页 400 incomplete）。鉴权走 `X-Api-Key`（scope=scanner），开关 `PROJECTX_ENABLE_SCANNER_CLIENT_API=1`。

## 二、目标与非目标

### 目标
1. 修复竞态：直扫「上传服务器」模式的自动上传真正可用，且不再依赖组件存活。
2. 导入阅卷新增「上传服务器」档位：本地判分照旧出成绩，图片同时后台排队上传，两线互不阻塞。
3. 全局右上角下弹进度小卡片：两个上传入口共用；成功 3 秒自动收起；失败保留并列出失败页码，提供手动重试。
4. 弱网韧性：单页失败自动重试 2 次（退避）；检测到断线暂停并提示，网络恢复自动续传；彻底失败给手动兜底按钮。
5. 实时服务器连接状态指示：工作台顶栏常驻 + 进度卡片头部复用；探活结果反哺上传暂停判定（比 `navigator.onLine` 更真实）。

### 非目标
- 服务端路由/存储/鉴权不做任何改动。
- 不做上传任务跨重启持久化（Electron 场景无刷新；重启后未完成任务丢弃，属可接受损失，YAGNI）。
- 不实现服务端对已传记录的识别消费（维持现状：只存不判）。
- Web 教师端构建不涉及任何改动（新组件仅挂在 scanner 入口独有的 ScannerApp 下）。

## 三、架构总览

```
ScannerPanel(直扫·remote档)────┐
                               ├──> scannerUploadManager（TS单例，脱离React树）
导入阅卷(remote档·File[])──────┘         │ 三步协议：建会话→逐页multipart→complete
                                        │ 断线判定 ◄── remoteServerStatus（health轮询单例）
                                        ▼ 状态广播(subscribe/getState)
                          UploadProgressCard（挂 ScannerApp 根部，fixed 右上下弹卡）
ScannerWorkspace 顶栏 ──> ServerStatusIndicator（订阅 remoteServerStatus）
```

原则：上传生命周期完全脱离 React 组件树（根治竞态）；协议逻辑单处收敛（直扫/导入共用）；UI 只做订阅渲染。

## 四、模块设计

### 4.1 `client/lib/scannerUploadManager.ts`（新建，纯 TS 单例）

```ts
interface UploadPageInput {
  pageNum: number;          // 1-based
  side: "front" | "back";
  getBlob: () => Promise<Blob>;  // 直扫: authFetch(scan-image).blob()；导入: file 直接可用
}
interface StartUploadInput {
  kind: "scan" | "import";
  cardId: string;
  name: string;             // 会话名，沿用现有命名格式
  dpi?: number;
  paperSize?: string;
  pages: UploadPageInput[];
}
startUpload(input): string /* jobId */;
retryFailed(jobId): void;    // 手动兜底：仅重试 error 页，全部成功后补发 complete
cancel?(jobId): void;        // 排队中可取消；进行中不提供（YAGNI）
subscribe(listener): () => void;
getState(): UploadManagerSnapshot;
```

**Job 状态机**：`queued → creating_session → uploading(x/y) → completing → done | paused | error`

- **排队**：多 job 全局串行（同时只跑一个，防带宽争抢）；queued 的 job 可 cancel。
- **逐页上传**：严格按页序串行；每页 `AbortSignal.timeout(120_000)`；multipart 字段与现有协议一致（image/token/pageNum/side），文件名 `page_{pageNum}.jpg`。
- **瞬时重试**：单页失败自动重试 2 次，退避 1s / 3s；重试复用同一 token（服务端幂等覆盖）。3 次尝试均失败记为该页 `failed`，**继续下一页**（不中断批次）。
- **complete 语义**：全部页成功才调 `complete`；存在 failed 页则不调（服务端会话留在 uploading 态可续传），job 进入 `error`。
- **断线暂停**：满足任一即置 `paused`——`navigator.onLine === false`；或 `remoteServerStatus` 处于 `offline/api_disabled`；或连续网络类异常（fetch reject/timeout）。paused 冻结退避计时，展示「已断线」；恢复条件（online 事件 + status 回到 online）达成后从当前页继续。
- **error 态**：保留 jobId、remoteSessionId、每页 token 与失败页码列表，供 `retryFailed` 续传。
- **快照结构**：jobs 数组（id/kind/name/status/uploaded/total/currentPage/failedPages[]/message/createdAt）+ activeJobId + queueLength。

### 4.2 `client/lib/remoteServerStatus.ts`（新建，轻量单例）

- 数据源：`GET {remote}/api/app/health`（经 `remoteScannerFetch`，带 X-Api-Key）。
- 轮询节奏：正常 **20s**；上次探测失败后加速为 **5s**（快速发现恢复），成功后回到 20s。未配置服务器地址时恒为 `unconfigured` 且不发起请求。
- 状态机：`unconfigured → checking → online | api_disabled | offline`
  - `online`：health ok 且 `capabilities.scannerClientApi === true`
  - `api_disabled`：health ok 但 capability 为 false（对应服务器没开 `PROJECTX_ENABLE_SCANNER_CLIENT_API`，提前暴露而非等上传 404）
  - `offline`：请求异常/非 ok
- 快照含最近一次探测时间与服务器地址（供 hover 提示）。
- 页面不可见时（`document.hidden`）暂停轮询，回前台立即探测一次（Electron 常驻窗口场景收益小但成本为零）。

### 4.3 `components/UploadProgressCard.tsx`（新建业务组件）

- 挂载点：`ScannerApp.tsx` 根部（scanner 构建独有入口，Web 构建天然隔离）。
- 形态：`fixed` 右上角（header 下方留白处）、宽约 320px、下弹动画（translateY + opacity 过渡）。
- 无活跃任务且无未读失败时整体隐藏。
- 状态映射：

| Job 状态 | 卡片表现 |
|---|---|
| queued | 灰点「排队中」 |
| creating_session / uploading | 蓝色进度条 x/y 页 + 当前页码 |
| paused | 橙色横幅「已断线，恢复后自动续传」+「立即重试」按钮 |
| error | 红色横幅 + 失败页码列表 + 「重试失败页」「关闭」按钮 |
| done | 绿色 ✓「上传完成」，3 秒后自动收起 |

- 多任务时显示队列长度徽标；卡片头部复用服务器状态圆点。
- 样式遵循 P6 T05 事实源：Tailwind 工具类 + ui/v2 基础组件拼装，禁止手写 CSS。

### 4.4 `components/ServerStatusIndicator.tsx`（新建，极简）

- 订阅 `remoteServerStatus`，渲染圆点+短文案：🟢 服务器在线 / 🔴 服务器离线 / 🟡 扫描 API 未启用 / ⚪ 未配置服务器；`title` 属性显示服务器地址与最后探测时间。
- 挂载点一：`ScannerWorkspace` header 右侧（SkinSwitcher 左侧）。
- 挂载点二：UploadProgressCard 头部复用同一组件（缩小尺寸 variant）。

## 五、既有代码改造

### 5.1 ScannerPanel（直扫路径）
- SSE `done` 分支：删除 `setTimeout(() => void uploadToRemote(), 500)` 与 `uploadToRemote` 函数本体、`uploadTimerRef`、`uploadState/uploadMsg` 内联状态条；remote 模式改为组装 `pagesRef.current.map(p => ({ pageNum, side, getBlob: () => authFetch(/api/scanner/scan-image/${p.recordId}).then(r => r.blob()) }))` 调 `startUpload({kind:'scan', ...})`。
- 卸载清理中的 `clearTimeout(uploadTimerRef)` 一并移除（竞态根源消失；EventSource 清理保留）。
- 面板内旧 uploadState 指示条删除，统一由全局卡片接管。

### 5.2 ScannerWorkspace（直扫卸载行为 + 导入路径）
- `onScansComplete`：去掉 `setScanning(false)`，仅更新 status 文案——面板留在 done 视图展示成绩表（顺带修复该视图从未显示的问题）；退出依赖面板既有的关闭按钮/「开始新扫描」。
- 「导入阅卷」卡片新增 SegmentedControl「本地存储 / 上传服务器」：读写同一个 localStorage key `projectx_scanner_mode`（与直扫档位语义一致、共享记忆）。
- `gradeAnswerCardFiles`：判分流程不动；若 mode=remote 且已配置服务器，把 `gradingFiles` 组装为 pages（File 本身是 Blob，`getBlob: () => Promise.resolve(file)`）调 `startUpload({kind:'import'})`，fire-and-forget 不 await。未配置服务器/API Key 时给出与直扫一致的引导提示，不上传。

### 5.3 ScannerApp
- 根部挂载 `<UploadProgressCard />`。

## 六、错误处理矩阵

| 场景 | 行为 |
|---|---|
| 单页瞬时失败（网络抖动） | 自动重试 ×2（1s/3s），用户无感 |
| 本机断网 / 服务器不可达 / API 未启用 | job → paused（橙）；探活回到 online 后自动续传——含 api_disabled 场景（管理员在服务器开启开关后无需手动操作） |
| 重试耗尽仍失败 | 该页标 failed，批次继续；终态 error 卡片保留，列页码，手动「重试失败页」（同 token 续传，已成功页不重传） |
| 创建会话失败（404 SCANNER_CLIENT_API_DISABLED / 401 Key 无效 / 400） | job 直接 error，透出服务端 message 原文 |
| complete 失败 | 同单页错误路径处理（complete 可重入） |
| 上传中关闭面板/切页/换皮肤 | 无影响（管理器独立于组件树） |
| 未配置服务器地址即选 remote 档 | 提示去登录页配置，不发起任务 |

## 七、测试与验收

1. `npm run typecheck` 通过。
2. 新增 `scripts/scanner-upload-manager-smoke.ts`（mock fetch + mock remoteServerStatus，驱动管理器状态机）：①全成功路径（含 complete）；②中途 offline → paused → 恢复续传；③单页 3 次失败 → error → retryFailed 补发 complete。`npx tsx` 运行通过。
3. 手动验收清单（随交付给出）：直扫 remote 全流程、导入 remote 双线并行、拔网线/关服务器模拟断线、失败重试、状态指示四种态切换。
4. 打包交付：**ia32 安装版（MSI）**，实现完成并通过验证后执行 `npm run electron:msi:ia32`（package.json:31，含 ia32 原生模块重建与 sharp 平台二进制补齐）。

## 八、风险与备注

- 服务端 `getMysqlDb()` 命名虽为 MySQL，实际为内嵌 SQLite 封装，本设计不受影响。
- 导入图片多为手机拍照/大图，50MB multer 上限内串行逐页可控；不做压缩（保持与现有 grading 上传一致的行为，YAGNI）。
- `remoteServerStatus` 与登录页「测试连接」逻辑并存但互不影响（后者是显式一次性动作，前者是周期探活）。
