# 扫描端远端同步与白屏根治（scanner-remote-sync）设计文档

- 分支：`feat/scanner-remote-sync`
- 基线：`origin/main` @ 2026-08-28
- 状态：设计定稿，待实施
- 关联问题：扫描端「开始扫描/选择答题卡」白屏（检查单 2.4.1，`main-scanner.tsx` 无 ErrorBoundary + 远端已删卡片 404 未处理）

## 一、背景与问题

1. **远端新建不可见**：扫描端为 Electron 单变体，内嵌本机 `127.0.0.1:5174` SQLite 服务，`CardSelectPage.tsx:70` 的 `GET /api/cards` 读本机库；教师端（Web 构建）在远端库新建的答题卡/考试/大考不在本机库，扫描端列表永远陈旧。
2. **点击远端已删卡白屏**：`ScannerApp.tsx:123-136` 的 `onSelectCard` 先 `GET /api/cards/:id`，404 时 `catch` 仍 `setPage("workspace")`，`ScannerWorkspace` 以空数据渲染，`paper.size / sided` 等解构触发渲染期异常；`main-scanner.tsx:28` 未包裹 `ErrorBoundary`（与 `main.tsx:48` 不一致），整树卸载→检查单结果 A（Ctrl+R 回到选择页）；打包版无日志落盘。
3. **“各种信息”不同步**：扫描端实际依赖 `cards / exam-groups / grades`，但考试明细 `exams` 等未覆盖，教师端新建大考/考试后扫描端无感知。

## 二、目标与非目标

### 目标
1. 远端新建的**答题卡、考试、大考**在 30s 内（或切回窗口瞬间）出现在扫描端，可直接选中并扫描。
2. 点击远端已删卡不再白屏：二次校验 404 时留选择页、弹友好提示并刷新列表。
3. 全链路不白屏：补 `ErrorBoundary` + 全局 `error/unhandledrejection` 兜底。
4. 有网实时、无网可离线：已配 `serverUrl` 时读远端优先，未配/离线回退本机并显式提示。

### 非目标
- 不改服务端 DB/鉴权/扫描协议；不引入 WS/SSE 推送（后续 P2）。
- 不做跨重启持久化同步队列（YAGNI）。
- 不改 Web 教师端构建。

## 三、架构总览

```
CardSelectPage ──> scannerSync (lib/scannerSync.ts) ──> 决策：有 serverUrl ?
                                                        ├─ 是：remoteScannerFetch(remoteBase + /api/...) + X-Api-Key
                                                        └─ 否：fetchJson 本机 /api/...
                           ▲ 轮询 30s + visibilitychange + 进页立即拉
                           │
ScannerApp.onSelectCard ──> fetchCardByIdSynced(id) 404? → 留选择页 + toast + 刷新列表
                           └─ 200 → setPage("workspace")

main-scanner.tsx 包 ErrorBoundary（与 main.tsx 对齐）
ScannerWorkspace 空数据时渲染 EmptyState 而非假设存在
```

决策收敛：`getRemoteScannerBase()` 来自 `auth/api.ts:48`，与 `scannerUploadManager` / `remoteServerStatus` 同源 `projectx_server_url`。

## 四、模块设计

### 4.1 `client/lib/scannerSync.ts`（新建，纯函数 + 轻状态）

```ts
export type SyncSource = "remote" | "local" | "offline-cache";
export async function fetchCardsSynced(): Promise<{ data: CardSummary[]; source: SyncSource }>;
export async function fetchCardByIdSynced(id: string): Promise<AnswerCard>;
export async function fetchExamGroupsSynced(): Promise<ExamGroupFilterItem[]>;
export async function fetchGradesSynced(): Promise<{ id:number; name:string }[]>;
export async function fetchExamsSynced(): Promise<any[]>; // 覆盖“考试”维度
// 轮询
export function startPolling(opts: { intervalMs?: number; onUpdate: () => void }): () => void;
```

- **择路**：`getRemoteScannerBase()` 非空 → `remoteScannerFetch`，否则 `fetchJson`；remote 失败（网络/401/404）→ 回退本地并返回 `source` 供 UI 显“离线·显示缓存”。
- **鉴权**：remote 分支带 `X-Api-Key`（`getStoredApiKey()`），沿用上传链路已验证的鉴权。
- **轮询**：`intervalMs=30_000`，`document.visibilitychange` 回前台立即拉一次；Electron 常驻窗口亦受益。

### 4.2 `CardSelectPage` 改造

- 列表拉取改调 `fetch*Synced()`；记录 `source` 在页脚/状态栏显式提示（复用现有 `ServerStatusIndicator` 文案）。
- 挂载 `startPolling`，`onUpdate` 触发 `loadCards/loadGroups/loadGrades`（含 exams）。
- 大考展开的 `GET /api/exam-groups/:id` 同步改为 Synced 版。

### 4.3 `ScannerApp` 改造

- `onSelectCard` 改“先校验后切页”：
  ```ts
  try { await fetchCardByIdSynced(cardId); setSelectedCardId(cardId); setPage("workspace"); }
  catch (e) { if (e.status===404) toast("该答题卡已在服务器删除"); refreshList(); return; }
  ```
- 校验期间按钮 `loading` 态，防重复点击。

### 4.4 `main-scanner.tsx` / `ScannerWorkspace` 加固

- `main-scanner.tsx` 包 `<ErrorBoundary fallback={<白屏转错误卡 + 返回列表>}>` + `window.addEventListener("error"/"unhandledrejection")`。
- `ScannerWorkspace` 对 `card` 为空/404 渲染 `<EmptyState title="答题卡不存在">`，不解构 `paper`。

## 五、错误处理矩阵

| 场景 | 行为 |
|---|---|
| 点击远端已删卡 404 | 留选择页，toast + 自动刷新列表，不进工作台 |
| remote 拉取网络失败 | 回退本地列表，页脚显“离线·显示缓存” |
| 未配 serverUrl | 恒 local，不发起 remote 请求 |
| 渲染期异常 | ErrorBoundary 捕获，显错误卡 + “返回列表”/“刷新” |
| 远端 401（Key 失效） | 透出服务端 message，提示去登录页重配 |

## 六、测试与验收

1. `npm run typecheck` 通过。
2. 新增 `scripts/scanner-sync-smoke.ts`：① remote 优先拉取 ② remote 404 回退 ③ 轮询触发 ④ 校验后切页阻断。
3. 手工按检查单复测：A0 刷新不再回到白屏；A1 Console 无未捕获异常；远端新建卡 30s 内出现在扫描端。

## 七、风险与备注

- 远端优先后，离线扫描依赖缓存，可能看到旧列表；已通过显式提示缓解。
- 轮询频率 30s 为折中，后续可改 ETag/条件请求。
- Electron 打包后 CWD 已切 `userData`，不影响 fetch 择路。
