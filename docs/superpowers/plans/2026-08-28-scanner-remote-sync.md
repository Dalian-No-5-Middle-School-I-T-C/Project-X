# 扫描端远端同步与白屏根治 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扫描端列表与详情远端优先同步（答题卡/考试/大考 30s 内可见），点击已删卡不白屏。

**Architecture:** 新增 `lib/scannerSync.ts` 择路层（有 `serverUrl` → `remoteScannerFetch`，否则本地 `fetchJson`）；`CardSelectPage` 接轮询，`ScannerApp.onSelectCard` 先校验后切页；`main-scanner.tsx` 补 ErrorBoundary。

**Tech Stack:** Vite/React 19 + Express 5 + `auth/api.ts` remote/local fetch + `localStorage` + ErrorBoundary

---

### Task 1: 新建 `scannerSync` 择路层

**Files:**
- Create: `src/apps/answer-card/client/lib/scannerSync.ts`
- Test: `scripts/scanner-sync-smoke.ts`

- [ ] **Step 1: 写冒烟用例（先失败）**

```ts
// scripts/scanner-sync-smoke.ts
import assert from "node:assert";
// mock localStorage + fetch 后 import scannerSync
// 1) 未配 serverUrl → local 分支
// 2) 已配 serverUrl → remote 分支带 X-Api-Key
// 3) remote 失败回退 local
// 4) fetchCardByIdSynced 404 抛带 status=404
console.log("scanner-sync-smoke: 全部通过");
```

Run: `npx tsx scripts/scanner-sync-smoke.ts`
Expected: FAIL (module not found)

- [ ] **Step 2: 实现 `scannerSync.ts`**

```ts
// src/apps/answer-card/client/lib/scannerSync.ts
import { fetchJson, remoteScannerFetch, getStoredApiKey } from "../auth/api";
function getRemoteBase(): string { try{return (localStorage.getItem("projectx_server_url")??"").trim().replace(/\/+$/,"");}catch{return "";} }
export type SyncSource="remote"|"local"|"offline-cache";
async function fetchSynced<T>(path:string):Promise<{data:T;source:SyncSource}> {
  const base=getRemoteBase();
  if(base){
    try{
      const res=await remoteScannerFetch(path, { headers: getStoredApiKey()?{"X-Api-Key":getStoredApiKey()!}:undefined });
      if(!res.ok) throw Object.assign(new Error((await res.json().catch(()=>({})) as any).message||res.statusText),{status:res.status});
      return { data: await res.json() as T, source:"remote" };
    }catch(e){ /* 回退 local */ }
  }
  const data=await fetchJson<T>(path); return { data, source: base? "offline-cache":"local" };
}
export const fetchCardsSynced=()=>fetchSynced<any[]>("/api/cards?limit=500");
export const fetchCardByIdSynced=async(id:string)=> (await fetchSynced<any>(`/api/cards/${encodeURIComponent(id)}`)).data;
export const fetchExamGroupsSynced=()=>fetchSynced<any[]>("/api/exam-groups").then(r=>r.data);
export const fetchExamsSynced=()=>fetchSynced<any[]>("/api/exams?limit=200").then(r=>r.data);
export const fetchGradesSynced=async()=>{ try{return (await fetchSynced<any[]>("/api/classes/grades")).data;}catch{return [];} };
export function startPolling(opts:{intervalMs?:number;onUpdate:()=>void}){ const ms=opts.intervalMs??30000; const id=setInterval(opts.onUpdate,ms); const onVis=()=>{ if(!document.hidden) opts.onUpdate(); }; document.addEventListener("visibilitychange",onVis); return ()=>{clearInterval(id);document.removeEventListener("visibilitychange",onVis);} }
```

- [ ] **Step 3: 验证通过**

Run: `npx tsx scripts/scanner-sync-smoke.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/apps/answer-card/client/lib/scannerSync.ts scripts/scanner-sync-smoke.ts
git commit -m "feat(scanner): remote-first sync layer with fallback"
```

### Task 2: CardSelectPage 接入轮询与远端

**Files:**
- Modify: `src/apps/answer-card/client/components/CardSelectPage.tsx`
- Modify: `src/apps/answer-card/client/lib/scannerSync.ts` (if needed)

- [ ] **Step 1: 替换列表拉取为 Synced**

```ts
// CardSelectPage.tsx
import { fetchCardsSynced, fetchExamGroupsSynced, fetchGradesSynced, startPolling } from "../lib/scannerSync";
// loadCards: const {data}=await fetchCardsSynced(); setCards(...)
// loadGroups: setGroups(await fetchExamGroupsSynced());
// grades: setGrades(await fetchGradesSynced());
// 展开 d: await fetchExamGroupsSynced + 取 members 亦 Synced
// useEffect 挂 startPolling({onUpdate: ()=>{loadCards();loadGroups();}})
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/components/CardSelectPage.tsx
git commit -m "feat(scanner): CardSelectPage polls remote and refreshes on visibility"
```

### Task 3: ScannerApp 先校验后切页

**Files:**
- Modify: `src/apps/answer-card/client/ScannerApp.tsx:123`

- [ ] **Step 1: 实现校验**

```ts
import { fetchCardByIdSynced } from "./lib/scannerSync";
onSelectCard={async (cardId)=>{
  try{ const card=await fetchCardByIdSynced(cardId); setSelectedCardId(cardId); setSelectedCardTitle(card.title||cardId); setPage("workspace"); }
  catch(e:any){ if(e?.status===404){ setStatus?.("该答题卡已在服务器删除，已刷新列表"); /* 触发重拉 */ return; } /* 其他错 toast */ }
}}
```

- [ ] **Step 2: 验证 typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/ScannerApp.tsx
git commit -m "fix(scanner): validate card existence before entering workspace"
```

### Task 4: 加固白屏（ErrorBoundary + 空数据 EmptyState）

**Files:**
- Modify: `src/apps/answer-card/client/main-scanner.tsx`
- Modify: `src/apps/answer-card/client/components/ScannerWorkspace.tsx`
- Modify: `src/apps/answer-card/client/components/ErrorBoundary.tsx` (复用)

- [ ] **Step 1: 包 ErrorBoundary**

```tsx
// main-scanner.tsx
import { ErrorBoundary } from "./components/ErrorBoundary";
createRoot(...).render(<ErrorBoundary fallback={<div>加载失败，请返回 ...</div>}><AuthProvider><ScannerApp/></AuthProvider></ErrorBoundary>)
window.addEventListener("error", e=>console.error(e)); window.addEventListener("unhandledrejection", e=>console.error(e));
```

- [ ] **Step 2: Workspace 空数据守卫**

```tsx
// ScannerWorkspace.tsx 顶部
if(!cardId) return <EmptyState title="答题卡不存在" description="请返回重选"/>;
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/apps/answer-card/client/main-scanner.tsx src/apps/answer-card/client/components/ScannerWorkspace.tsx
git commit -m "fix(scanner): ErrorBoundary and empty-state guard against white screen"
```

### Task 5: 验证与草稿 PR

- [ ] **Step 1: 全量校验**

Run: `npm run typecheck && npx tsx scripts/scanner-sync-smoke.ts`
Expected: 全部通过

- [ ] **Step 2: 推送并建草稿 PR**

```bash
git push -u origin feat/scanner-remote-sync
gh pr create --draft --title "fix(scanner): remote-first sync for cards/exams/groups + white-screen guard" --body "见 docs/superpowers/specs/2026-08-28-scanner-sync-design.md"
```
