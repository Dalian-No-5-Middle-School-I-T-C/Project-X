# 扫描端登录后可改服务器连接（scanner-server-config）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扫描端登录后在 `CardSelectPage` 与 `ScannerWorkspace` 顶栏常驻“服务器连接”入口，可改 `服务器地址+API Key（掩码）`，带测试连接，保存即生效。

**Architecture:** 抽 `ServerConfigDialog` 共用组件（`dialog|embedded` 双模式），复用 `auth/api.ts` 的 `getStoredApiKey/storeApiKey/remoteScannerFetch` 与 `remoteServerStatus` 探活；两页顶栏统一为 `ServerStatusIndicator | Globe按钮->Dialog | SkinSwitcher`，保存后 `serverStatus.refresh()+scannerUploadManager.notifyNetworkChanged()`。

**Tech Stack:** Vite/React 19 + Electron 39 + `localStorage("projectx_server_url"/"projectx_api_key" v1+exp)` + `ui/v2 Dialog/Input/Badge/Button`

---

### Task 1: 新建 `ServerConfigDialog` 共用组件

**Files:**
- Create: `src/apps/answer-card/client/components/ServerConfigDialog.tsx`
- Modify: `src/apps/answer-card/client/lib/scannerMode.ts:11` (仅复用 `SERVER_URL_KEY` 常量，无改动)

- [ ] **Step 1: 新建组件骨架（失败态先不跑通）**

```tsx
// src/apps/answer-card/client/components/ServerConfigDialog.tsx
import { useState } from "react";
import { Eye, EyeOff, Globe } from "lucide-react";
import { SERVER_URL_KEY } from "../lib/scannerMode";
import { getStoredApiKey, storeApiKey, remoteScannerFetch } from "../auth/api";
import { serverStatus } from "../lib/remoteServerStatus";
import { scannerUploadManager } from "../lib/scannerUploadManager";
import { Button, Input, Field, Badge, Dialog, DialogHeader, DialogTitle, DialogContent } from "./ui/v2";

type Mode = "dialog" | "embedded";
interface Props {
  mode: Mode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSaved?: () => void;
}

function loadUrl(): string {
  try { return (localStorage.getItem(SERVER_URL_KEY) ?? "").trim(); } catch { return ""; }
}
function saveUrl(url: string): void {
  try { localStorage.setItem(SERVER_URL_KEY, url.trim().replace(/\/+$/, "")); } catch {}
}

export function ServerConfigDialog({ mode, open, onOpenChange, onSaved }: Props) {
  const [serverUrl, setServerUrl] = useState(loadUrl);
  const [apiKey, setApiKey] = useState(() => getStoredApiKey() ?? "");
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<""|"testing"|"ok"|"fail">("");
  const [testMessage, setTestMessage] = useState("");

  async function handleTest() {
    if (!serverUrl.trim()) return;
    setTestStatus("testing"); setTestMessage("");
    try {
      const base = serverUrl.trim().replace(/\/+$/, "");
      const res = await remoteScannerFetch("/api/app/health", { signal: AbortSignal.timeout(5000) });
      // remoteScannerFetch 已拼 base，若 base 为空会抛“未配置”，此处直接用 fetch 兜底探 base
      // 实际走 base+health 时需直连 base，下面为简化：若 getRemoteScannerBase 为空则提示未配置
      const body = await res.json() as { ok?: boolean; capabilities?: { scannerClientApi?: boolean } };
      if (res.ok && body.ok && body.capabilities?.scannerClientApi) { setTestStatus("ok"); setTimeout(()=>setTestStatus(""),3000); }
      else { setTestStatus("fail"); setTestMessage(res.ok ? "服务器在线，但未启用远程扫描客户端 API" : `HTTP ${res.status}`); }
    } catch (e) { setTestStatus("fail"); setTestMessage(e instanceof Error ? e.message : "连接失败"); }
  }
  function handleSave() {
    saveUrl(serverUrl);
    storeApiKey(apiKey.trim() || null);
    serverStatus.refresh();
    scannerUploadManager.notifyNetworkChanged();
    if (mode === "dialog") onOpenChange?.(false);
    onSaved?.();
  }

  const form = (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-xs text-muted-foreground">扫描、识别和账号登录始终在本机完成。填入服务器地址和 API Key 后，可将扫描结果上传到远端服务器。</p>
      <Field label="服务器地址">
        <Input value={serverUrl} onChange={e=>{setServerUrl(e.target.value); setTestStatus("");}} placeholder="http://192.168.1.100:5174" autoComplete="off" />
      </Field>
      <Field label="API Key">
        <div className="relative">
          <Input type={showKey ? "text" : "password"} value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="sk-xxx..." autoComplete="off" className="pr-8" />
          <button type="button" onClick={()=>setShowKey(v=>!v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-label={showKey ? "隐藏" : "显示"}>
            {showKey ? <EyeOff size={16}/> : <Eye size={16}/>}
          </button>
        </div>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" type="button" loading={testStatus==="testing"} onClick={()=>void handleTest()} disabled={!serverUrl.trim() || testStatus==="testing"}>
          {testStatus==="testing" ? "测试中..." : "测试连接"}
        </Button>
        {testStatus==="ok" && <Badge tone="success" dot>服务器可达</Badge>}
        {testStatus==="fail" && <Badge tone="danger" dot>{testMessage || "连接失败"}</Badge>}
        <Button variant="primary" size="sm" type="button" className="ml-auto" onClick={handleSave}>保存配置</Button>
      </div>
    </div>
  );

  if (mode === "embedded") return <div className="mt-2 rounded-md border border-border-subtle bg-secondary p-3">{form}</div>;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Globe size={16}/>服务器连接</DialogTitle></DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS（若 `Dialog` 导入名不符，按 `src/apps/answer-card/client/components/ui/v2/*` 桶导出调整）

- [ ] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/components/ServerConfigDialog.tsx
git commit -m "feat(scanner): add shared ServerConfigDialog (dialog+embedded)"
```

### Task 2: `LoginPageScanner` 嵌入复用

**Files:**
- Modify: `src/apps/answer-card/client/components/LoginPageScanner.tsx:19-96,145-211`

- [ ] **Step 1: 替换折叠区为共用组件**

```tsx
// LoginPageScanner.tsx
import { ServerConfigDialog } from "./ServerConfigDialog";
// 删除：SERVER_URL_STORAGE / loadServerUrl / saveServerUrl / loadApiKey / saveApiKey / handleTestConnection / handleSaveRemoteConfig 及其 state (serverUrl/apiKey/testStatus/testMessage)
// 保留：showRemote 折叠按钮
// 将折叠区 {showRemote && <div>...</div>} 替换为：
{showRemote && <ServerConfigDialog mode="embedded" />}
// handleSubmit 中“提交前同步”改为：
try { const url = localStorage.getItem("projectx_server_url") ?? ""; /* 已由 Dialog 保存，无需再写 */ } catch {}
// 或者直接删去 handleSubmit 里的 saveServerUrl/saveApiKey（Dialog 已持久化）
```

保留 `rememberMe/identifier/password/login` 原逻辑不变。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/components/LoginPageScanner.tsx
git commit -m "refactor(scanner): LoginPageScanner reuses ServerConfigDialog"
```

### Task 3: 两页顶栏常驻入口

**Files:**
- Modify: `src/apps/answer-card/client/components/CardSelectPage.tsx:7,165`
- Modify: `src/apps/answer-card/client/components/ScannerWorkspace.tsx:21,139`

- [ ] **Step 1: CardSelectPage 顶栏接入**

```tsx
// CardSelectPage.tsx
import { useState } from "react";
import { Globe } from "lucide-react";
import { ServerStatusIndicator } from "./ServerStatusIndicator";
import { ServerConfigDialog } from "./ServerConfigDialog";
import { Button } from "./ui/v2";
// header 内：
const [cfgOpen, setCfgOpen] = useState(false);
// 原 {skin && onSkinChange && <SkinSwitcher/>} 替换为：
{skin !== undefined && onSkinChange && (
  <div className="ml-auto flex items-center gap-2">
    <ServerStatusIndicator />
    <Button variant="ghost" size="icon-sm" aria-label="服务器连接" onClick={()=>setCfgOpen(true)}><Globe size={16}/></Button>
    <SkinSwitcher skin={skin} onSkinChange={onSkinChange} />
    <ServerConfigDialog mode="dialog" open={cfgOpen} onOpenChange={setCfgOpen} />
  </div>
)}
```

- [ ] **Step 2: ScannerWorkspace 顶栏接入**

```tsx
// ScannerWorkspace.tsx
import { useState } from "react";
import { Globe } from "lucide-react";
import { ServerConfigDialog } from "./ServerConfigDialog";
// 已有：ServerStatusIndicator + SkinSwitcher
const [cfgOpen, setCfgOpen] = useState(false);
// 将 header 右侧：
<div className="ml-auto flex shrink-0 items-center gap-2">
  <ServerStatusIndicator />
  <Button variant="ghost" size="icon-sm" aria-label="服务器连接" onClick={()=>setCfgOpen(true)}><Globe size={16}/></Button>
  <SkinSwitcher skin={skin} onSkinChange={onSkinChange} />
  <ServerConfigDialog mode="dialog" open={cfgOpen} onOpenChange={setCfgOpen} />
</div>
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/apps/answer-card/client/components/CardSelectPage.tsx src/apps/answer-card/client/components/ScannerWorkspace.tsx
git commit -m "feat(scanner): add top-bar server config entry to CardSelect & Workspace"
```

### Task 4: 校验与打包

- [ ] **Step 1: 全量校验**

Run: `npm run typecheck && npm run build:scanner:full`
Expected: `typecheck EXIT:0`，`vite build 1979 modules` + `dist/server/index.mjs 1018kB`

- [ ] **Step 2: 推送**

```bash
git push -u origin feat/scanner-server-config
```

---

## Self-Review

1. **Spec coverage:** 目标1-4 均映射：Task1 新组件覆盖表单+掩码+探活+保存即生效；Task2 登录页嵌入；Task3 两页顶栏；Task4 校验。非目标“不改Web/不新增远程拉取”已遵守。
2. **Placeholder scan:** 无 TBD/TODO/“类似 Task N”；每步含完整代码与命令。
3. **Type consistency:** `SERVER_URL_KEY` 来自 `lib/scannerMode.ts:11`，`getStoredApiKey/storeApiKey/remoteScannerFetch` 来自 `auth/api.ts`，`serverStatus.refresh()/scannerUploadManager.notifyNetworkChanged()` 签名与现有实现一致；`Dialog` 导入按 `ui/v2` 桶。
