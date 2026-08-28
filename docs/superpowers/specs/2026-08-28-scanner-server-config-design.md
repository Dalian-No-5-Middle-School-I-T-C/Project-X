# 扫描端登录后可改服务器连接（scanner-server-config）设计文档

- 分支：`feat/scanner-server-config`（基于 `feat/scanner-remote-sync` / `3a9c7cf`）
- 基线：`2.5.3`（`package.json`）
- 状态：设计定稿（5/5 已确认），待实施
- 关联：登录页 `LoginPageScanner.tsx` 仅登录前可改 `projectx_server_url / projectx_api_key`；登录后 `CardSelectPage` / `ScannerWorkspace` 顶栏无入口；`ServerStatusIndicator` 仅展示不可改；需求“顶栏常驻入口”+“之前设过可以改”

## 一、背景与问题

1. **登录后不可改**：`LoginPageScanner.tsx:59 showRemote` 的服务器连接折叠区仅登录前可见，登录后 `ScannerApp.tsx` 切到 `CardSelectPage / ScannerWorkspace` 后顶栏只有 `ServerStatusIndicator + SkinSwitcher`，已配过的 `projectx_server_url` 无法在不退出的情况下修改。
2. **双入口不一致风险**：若登录后单独写一套表单，会与登录页的校验/探活（`GET /api/app/health` 判 `scannerClientApi`）分叉，出现两处 `SERVER_URL_STORAGE / getStoredApiKey / storeApiKey` 逻辑重复。
3. **掩码与即时生效缺失**：`API Key` 需默认掩码可显隐；保存后需 `serverStatus.refresh() + scannerUploadManager.notifyNetworkChanged()` 否则 `ServerStatusIndicator` 与上传队列仍处旧状态。

## 二、目标与非目标

### 目标
1. 登录后在 `CardSelectPage` 与 `ScannerWorkspace` 顶栏常驻“服务器连接”入口（与 `SkinSwitcher` 并列），可查看/修改 `服务器地址 + API Key`。
2. `API Key` 默认 `●●●●` 掩码（`type="password"`），点眼镜显隐。
3. 带“测试连接”按钮（`GET /api/app/health`，`capabilities.scannerClientApi` 判定），保存后立即生效。
4. 抽 `ServerConfigDialog` 共用，登录页折叠区与登录后 Dialog 复用同一校验/探活。

### 非目标
- 不改服务端 DB/鉴权/扫描协议；不新增远程拉取卡片（仍本机 `fetchJson`，远程仅上传/探活，见 `scanner-sync` 另文）。
- 不做 `API Key` 服务端下发/账号绑定持久化；仅本机 `localStorage`（全局，跨账号共享，与现状一致）。
- 不改 Web 构建。

## 三、架构总览

```
LoginPageScanner (embedded) ─┐
                             ├─> ServerConfigDialog (mode="embedded"|"dialog")
CardSelectPage header ───────┤        │ 读 localStorage(SERVER_URL_KEY) + getStoredApiKey()
                             │        │ 验 去尾斜杠 trim().replace(/\/+$/,"")
ScannerWorkspace header ─────┘        │ 探 remoteScannerFetch("/api/app/health")
                                      │ 存 localStorage + storeApiKey(v1+exp30d)
                                      └─> serverStatus.refresh() + scannerUploadManager.notifyNetworkChanged()
                                           + Dialog 关闭

Card/Exam 列表仍： CardSelectPage -> fetchJson("/api/cards" / "/api/exam-groups") 本机
上传/探活：     scannerUploadManager / remoteServerStatus -> remoteScannerFetch(remoteBase + /api/...)
```

## 四、模块设计

### 4.1 `client/components/ServerConfigDialog.tsx`（新建）

```tsx
type Mode = "dialog" | "embedded";
interface Props {
  mode: Mode;
  open?: boolean; onOpenChange?: (o:boolean)=>void;
  onSaved?: ()=>void;
}
```

- 状态：`serverUrl / apiKey / showKey / testStatus(""/testing/ok/fail) / testMessage`
- 预填：`localStorage.getItem(SERVER_URL_KEY) ?? ""` + `getStoredApiKey() ?? ""`
- 校验：`serverUrl` 归一 `trim().replace(/\/+$/,"")`，空串=纯本机；`apiKey` 可空
- 探活：`fetch(remoteBase + "/api/app/health", {signal: timeout 5s})` → `ok && body.capabilities.scannerClientApi` 判 `online / api_disabled / offline`
- 保存：`localStorage.setItem(SERVER_URL_KEY, url); storeApiKey(key||null); serverStatus.refresh(); scannerUploadManager.notifyNetworkChanged(); onSaved?.();`
- 复用点：`lib/scannerMode.ts: SERVER_URL_KEY`、`auth/api.ts: getStoredApiKey/storeApiKey/getRemoteScannerBase/remoteScannerFetch`、`lib/remoteServerStatus.ts: defaultFetchHealth`

### 4.2 `LoginPageScanner.tsx` 改造

- 折叠区内容替换为 `<ServerConfigDialog mode="embedded" />`，移除本地 `SERVER_URL_STORAGE / load/save` 重复函数，保留折叠按钮与外层 `Card` 布局。

### 4.3 `CardSelectPage.tsx` / `ScannerWorkspace.tsx` 改造

- 顶栏右侧由 `[SkinSwitcher]` / `[ServerStatusIndicator+SkinSwitcher]` 统一为：
  ```
  [ServerStatusIndicator] [Button size="icon-sm" variant="ghost" <Globe> onClick=>setOpen(true)] [SkinSwitcher]
  + <ServerConfigDialog mode="dialog" open={open} onOpenChange={setOpen} />
  ```
- 两页一致，`Dialog` 承载表单，不挤占顶栏宽度。

### 4.4 `ScannerApp.tsx`

- 无新增状态；仅透传 `skin` 同款不新增 `serverUrl` 状态（以 `localStorage` 为单一事实源，避免与 `serverStatus` 双源）。

## 五、数据流与联动

- 读：两处入口预填同一 `localStorage`，跨页一致。
- 写：仅本机持久化，不写服务端。
- 生效：`save` → `serverStatus.refresh()` 立即重探，`notifyNetworkChanged()` 使 `paused` 上传自动续 `uploading`。
- 回退：`serverUrl` 置空 → `unconfigured`；`apiKey` 为空 → `remoteScannerFetch` 无 `X-Api-Key` 头，`401` 由服务端透出，探活判 `offline`。

## 六、错误处理

| 场景 | 行为 |
|---|---|
| 未填地址保存 | 允许，回到纯本机，指示器 `未配置服务器` |
| 只配地址未配 Key | 允许，远程请求无 Key，401 时仍可保存，探活提示离线 |
| 测试连接失败/超时 | `Badge tone=danger` + `testMessage`，不阻断保存 |
| `localStorage` 禁用/满 | `try/catch` 静默，按钮 toast |
| 脏值/尾斜杠 | 读写均 `trim().replace(/\/+$/,"")` 归一 |

## 七、测试与验收

1. `npm run typecheck` 通过。
2. 手工：
   - 登录前改地址/Key 并保存 → 登录后顶栏指示器立即变 `在线/离线`，`localStorage` 一致
   - 登录后两页顶栏均可弹 Dialog 改地址，保存后不刷新页面双页同值
   - Key 掩码默认 `●●●●`，点眼镜显隐不触发保存
   - 测试连接对 `scannerClientApi` 未启用显 `扫描 API 未启用`
   - `remote` 档上传在改地址后 `paused -> uploading` 自动续
3. `vite build --mode scanner` 产物含新 Dialog，不影响 `dist/web`。

## 八、风险与备注

- `localStorage` 为本机全局，换账号登录不隔离（与登录页现状一致）。
- 顶栏三件套在 `1360px` 宽度下预留 `gap-2`，`Dialog` 避免顶栏拥挤。
- 后续远程优先拉取（`scannerSync`）与本需求正交，本 PR 不改 `fetchCards` 择路。
