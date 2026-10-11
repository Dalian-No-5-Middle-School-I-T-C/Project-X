# 扫描端 i3000 连接 / 400 张批扫 / 重复学号 P1 / 自动后台上传 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复柯达 i3000 扫描端四个实测问题：①红灯连不上（双 DSM 自动重试 + 明确报错）；②扫进 10 张只录 1 张且批扫上限不足 400 张；③重复学号「一半真一半假」的死循环（P1）；④扫描判分后自动后台上传图片（不再手动点）。

**Architecture:** ①原生 TWAIN 桥补 `CAP_XFERCOUNT=-1`（规范默认值是 1，不设置时驱动只交付 1 页——这是「只录 1 张」的根因）；Node 侧把扫描子进程 10 分钟硬超时改为按页数自适应，UI 上限改为「张」语义（≤400 张），服务端上传会话页数默认 200→800。②红灯问题保留 TWAINDSM 优先，扫描「设备无响应/0 页」失败时自动用 `TWAIN_DSM_DLL=C:\Windows\twain_32.dll` 重启桥接进程重试一次，两次都失败给出可操作的双模式报错。③重复学号：服务端对「同学生 + 识别内容逐题一致」的重扫副本做内容级判重（作废多余副本、不撤回成绩），新增「作废此卷」动作；先用复现脚本钉死再修。④远端模式下成绩汇总完成即自动入队后台上传（进度条沿用 UploadProgressCard）。

**Tech Stack:** C++ TWAIN（native/ScannerBridge，VS 构建脚本 `scripts/build-scanner-bridge.bat`）、Node/Express（`src/apps/answer-card/server/scanner/`、`src/server/routes/scanner-upload.ts`、`src/server/services/scannerSubmissions.ts`）、React（`ScannerPanel.tsx`、`ScannerConflictCards.tsx`、`scannerUploadManager.ts`）、验证用 tsx 冒烟脚本（参考 `scripts/scanner-batch-results-smoke.ts` 的隔离 HTTP/DB 基建）。

**分支:** `fix/scanner-i3000-batch400-async-upload`（已基于最新 `origin/main` = f960b60 创建）。执行第 0 步先把本计划复制到 `docs/superpowers/plans/2026-10-11-scanner-i3000-batch400-dup-upload.md` 并提交。

---

## 根因诊断摘要（已核实，均带当前 main 上的文件:行号）

1. **只录 1 张**：`native/ScannerBridge/scanner-bridge/twain_controller.cpp` 的 `scan()` 在 OPENDS 后设置 CAP_FEEDERENABLED/CAP_AUTOFEED（`enableADF()` :848-856），**从未设置 `CAP_XFERCOUNT`**。TWAIN 规范中 CAP_XFERCOUNT 默认值为 1，柯达 i3000 驱动因此只向应用交付 1 页（物理进纸继续走，表现就是「扫进去 10 张只显示 1 张」）。
2. **200 张隐形上限**：代码里没有 200 张常量。实际是 `src/apps/answer-card/server/scanner/twain-bridge.ts:363` 的 `runBridge(args, 600_000)`——扫描子进程 10 分钟硬超时（300dpi 约 3s/页，10 分钟 ≈ 200 页）。另：f960b60 安全整改新增的 `src/shared/scanUploadLimits.ts:41` `maxScanSessionPages` 默认 200 页（上限上传会话 pageCount），400 张单面=400 页会直接被拒，需一并提到 800。
3. **红灯**：桥接优先加载 TWAINDSM.dll（`twain_controller.cpp:90-95`，`TWAIN_DSM_DLL` 环境变量可覆盖）。扫描流程 OPENDSM→OPENDS→ENABLEDS 齐全（`scan()` :337-559），但柯达驱动在 2.x DSM 下 MSG_ENABLEDS 可能「返回成功但硬件未激活」（C30 软件一开设备即转绿，与此吻合）。修法：失败自动切 twain_32 重试一次并报明确错误。
4. **重复学号死循环（P1）**：远端每生一个上传 job = 一个上传会话 = 一张回执（`scannerSubmissions.ts:226-228`）。同一张卡重扫重传会**新建回执**，与已保存回执同学号 → `:277-282` 判重 → `withdraw()`（:80-109）把已入库成绩删掉、全部置 conflict → 409 → 老师看到报错再扫再传 → 再建一条回执再撤回——成绩永远存不住，冲突卡越滚越多（截图中 24230 下 8 张卡就是这么来的）。服务端没有任何「同一物理卡重扫」的内容级判重；客户端只有「订正学号/重新保存」两个动作，没有「作废这张重复卷」。另外 `/correct`（`scanner-upload.ts:515-541`）每次调用把 `processScannerSession` 跑两遍。

---

## File Structure

- Modify: `native/ScannerBridge/scanner-bridge/twain_controller.cpp`（CAP_XFERCOUNT 设置+回读日志）
- Modify: `native/ScannerBridge/scanner-bridge/twain_controller.hpp`（新增 `setXferCount()` 声明）
- Modify: `src/apps/answer-card/server/scanner/twain-bridge.ts`（自适应超时 + 双 DSM 重试）
- Modify: `src/apps/answer-card/server/scanner/index.ts`（maxPages 夹紧 ≤800 页）
- Modify: `src/shared/scanUploadLimits.ts`（maxScanSessionPages 默认 200→800）
- Modify: `src/apps/answer-card/client/components/ScannerPanel.tsx`（张数语义 ≤400、自动入队上传）
- Modify: `src/server/services/scannerSubmissions.ts`（内容级重扫判重 + discardScannerGroup）
- Modify: `src/server/routes/scanner-upload.ts`（discard 端点）
- Modify: `src/apps/answer-card/server/scanner/index.ts`（本机 discard 端点）
- Modify: `src/apps/answer-card/client/components/ScannerConflictCards.tsx`（作废此卷按钮）
- Create: `scripts/duplicate-rescan-smoke.ts`（P1 复现 + 回归脚本）
- Modify: `readus/CHANGELOG.md`、`readus/SCANNER-SETUP.md`（行为变更同步）

---

## Task 1: 原生桥设置 CAP_XFERCOUNT=-1

**Files:**
- Modify: `native/ScannerBridge/scanner-bridge/twain_controller.hpp:121`（`bool enableADF();` 之后加声明）
- Modify: `native/ScannerBridge/scanner-bridge/twain_controller.cpp:848`（`enableADF()` 之后新增实现）、`:438`（`enableADF();` 调用后加一行）

- [ ] **Step 1: hpp 加声明**

在 `native/ScannerBridge/scanner-bridge/twain_controller.hpp` 第 121 行 `bool enableADF();` 之后插入：

```cpp
    bool setXferCount();
```

- [ ] **Step 2: cpp 加实现**

在 `twain_controller.cpp` 的 `enableADF()` 实现（:848-856）之后新增：

```cpp
bool TwainController::setXferCount() {
    // TWAIN 规范中 CAP_XFERCOUNT 默认值为 1：不显式设置时 DS 只向应用交付 1 页
    // 就结束会话（柯达 i3000 实测：ADF 照常走纸但只收到 1 张）。
    // -1 表示不限张数，是 ADF 批量扫描的标准做法，必须在 ENABLEDS 前设置。
    TW_INT32 unlimited = -1;
    bool ok = setCapability(CAP_XFERCOUNT, TWTY_INT32, &unlimited);
    // 回读确认实际生效值（同 setPaperSize 的做法）：驱动拒绝时至少留下诊断日志
    TW_CAPABILITY current;
    memset(&current, 0, sizeof(current));
    current.Cap = CAP_XFERCOUNT;
    TW_UINT16 rc = DSM_Entry(&m_appId, &m_sourceId,
        DG_CONTROL, DAT_CAPABILITY, MSG_GETCURRENT,
        (TW_MEMREF)&current);
    TW_INT32 effective = -1;
    if (rc == TWRC_SUCCESS && current.hContainer) {
        pTW_ONEVALUE value = static_cast<pTW_ONEVALUE>(GlobalLock(current.hContainer));
        if (value && value->ItemType == TWTY_INT32) effective = static_cast<TW_INT32>(value->Item);
        if (value) GlobalUnlock(current.hContainer);
        GlobalFree(current.hContainer);
    }
    fprintf(stderr, "[ScannerBridge] CAP_XFERCOUNT set=%s effective=%d\n",
        ok ? "ok" : "rejected", static_cast<int>(effective));
    return ok;
}
```

- [ ] **Step 3: scan() 中调用**

`twain_controller.cpp:438` 处：

```cpp
    enableADF();
```

改为：

```cpp
    enableADF();
    setXferCount();   // 必须在 ENABLEDS 之前；不设时驱动默认只交付 1 页
```

- [ ] **Step 4: 编译验证**

Run: `cmd /c scripts\\build-scanner-bridge.bat`（按仓库现有脚本；若脚本要求参数，先 `head -30 scripts/build-scanner-bridge.bat` 查看用法）
Expected: Win32 与 x64 两个平台的 `scanner-bridge.exe` 均编译链接成功（C++ 无单测基建，验证靠编译 + 现场实扫）。

- [ ] **Step 5: Commit**

```bash
git add native/ScannerBridge/scanner-bridge/twain_controller.cpp native/ScannerBridge/scanner-bridge/twain_controller.hpp
git commit -m "fix(scanner): 扫描前显式设置 CAP_XFERCOUNT=-1，修复柯达 i3000 只交付 1 页"
```

---

## Task 2: 批扫 400 张——自适应超时 + 各处上限

**Files:**
- Modify: `src/apps/answer-card/server/scanner/twain-bridge.ts:363`
- Modify: `src/apps/answer-card/server/scanner/index.ts:134`
- Modify: `src/shared/scanUploadLimits.ts:41`
- Modify: `src/apps/answer-card/client/components/ScannerPanel.tsx:91,490,720-728`

- [ ] **Step 1: 扫描子进程超时按页数自适应（先写失败断言的验证脚本）**

创建 `scripts/verify-scanner-scan-timeout.ts`：

```ts
import assert from "node:assert/strict";
const { scanTimeoutMs } = await import("../src/apps/answer-card/server/scanner/twain-bridge");
// 不限张数（0）：1 小时兜底（native 侧 ADF 空纸 60s 自退，不会真挂死）
assert.equal(scanTimeoutMs(0), 3_600_000);
// 400 张双面 = 800 页：800×5s + 300s 缓冲 = 4300s，且不低于旧默认 600s
assert.equal(scanTimeoutMs(800), 4_300_000);
// 小批量不低于旧行为
assert.equal(scanTimeoutMs(30), 600_000);
console.log("scanTimeoutMs OK");
```

Run: `npx tsx scripts/verify-scanner-scan-timeout.ts`
Expected: FAIL（`scanTimeoutMs` 尚未导出）。

- [ ] **Step 2: 实现 scanTimeoutMs 并接入 scan()**

`src/apps/answer-card/server/scanner/twain-bridge.ts` 中，在 `export async function scan(` 之前新增并导出：

```ts
/** 扫描子进程超时：按预期页数估算（5s/页 + 5 分钟缓冲，不低于旧默认 10 分钟）。
 *  不限张数时给 1 小时兜底——native 侧 ADF 无纸 60s 空闲自退，长超时只是防驱动死锁的保险。 */
export function scanTimeoutMs(maxPages: number): number {
  if (maxPages > 0) return Math.max(600_000, maxPages * 5_000 + 300_000);
  return 3_600_000;
}
```

`:363` 处：

```ts
  const { stdout } = await runBridge(args, 600_000, sessionId); // 10 min timeout for scanning
```

改为：

```ts
  const { stdout } = await runBridge(args, scanTimeoutMs(config.maxPages), sessionId);
```

Run: `npx tsx scripts/verify-scanner-scan-timeout.ts`
Expected: PASS（打印 `scanTimeoutMs OK`）。

- [ ] **Step 3: 服务端夹紧 maxPages ≤ 800 页（=400 张双面）**

`src/apps/answer-card/server/scanner/index.ts:134`：

```ts
          maxPages: body.maxPages || 0,
```

改为：

```ts
          // 400 张双面 = 800 页；超出夹紧，防止异常入参把扫描子进程挂到超时
          maxPages: Math.min(800, Math.max(0, Math.floor(Number(body.maxPages) || 0))),
```

- [ ] **Step 4: 上传会话页数默认 200→800**

`src/shared/scanUploadLimits.ts:41`：

```ts
  // 单个会话页数：pageCount 由扫描端上报，直接决定会话创建时写入的记录与令牌数量（R22）。
  // 200 页 = A4 双面连扫 100 张卡；天花板 2000 页已远超任何单机扫描场景。
  { key: "maxScanSessionPages", env: "PROJECTX_UPLOAD_MAX_SESSION_PAGES", unit: "count", default: 200, ceiling: 2000 },
```

改为：

```ts
  // 单个会话页数：pageCount 由扫描端上报，直接决定会话创建时写入的记录与令牌数量（R22）。
  // 800 页 = 400 张卡双面连扫（与扫描端单次批扫上限一致）；天花板 2000 页已远超单机场景。
  { key: "maxScanSessionPages", env: "PROJECTX_UPLOAD_MAX_SESSION_PAGES", unit: "count", default: 800, ceiling: 2000 },
```

检查是否有脚本/文档按默认 200 断言：`grep -rn "maxScanSessionPages\|MAX_SCAN_SESSION_PAGES\|SESSION_PAGES" scripts/ src/ readus/ --include="*.ts" --include="*.md"`，把断言基准同步为 800（例如 scanner-image-limits-smoke 之类）。

- [ ] **Step 5: UI 改为「张」语义，上限 400**

`src/apps/answer-card/client/components/ScannerPanel.tsx`：

:91 `const [maxPages, setMaxPages] = useState(0);` 改为：

```ts
  // 单次批扫上限按「张」输入（0=不限，最高 400 张）；发给服务端时按单双面折算成页数
  const [maxSheets, setMaxSheets] = useState(0);
```

:720-728 的 `Field label="最大页数"` 整块改为：

```tsx
              <Field label="单次最多张数">
                <Input
                  type="number"
                  min={0}
                  max={400}
                  value={maxSheets}
                  onChange={(e) => setMaxSheets(Math.max(0, Math.min(400, Math.trunc(Number(e.target.value)) || 0)))}
                  placeholder="0=不限（最高400）"
                />
              </Field>
```

:490 附近 startScan 请求体里的 `maxPages,` 改为：

```ts
          maxPages: maxSheets > 0 ? maxSheets * (duplex ? 2 : 1) : 0,
```

确认该请求体所在位置（startScan 内 `authFetch("/api/scanner/scan", ...)` 的 body）。grep 校验残留：`grep -n "maxPages" src/apps/answer-card/client/components/ScannerPanel.tsx` 应只剩请求体这一处与本地说明文案。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 0 错误。

- [ ] **Step 7: Commit**

```bash
git add src/apps/answer-card/server/scanner/twain-bridge.ts src/apps/answer-card/server/scanner/index.ts src/shared/scanUploadLimits.ts src/apps/answer-card/client/components/ScannerPanel.tsx scripts/verify-scanner-scan-timeout.ts
git commit -m "feat(scanner): 单次批扫支持 400 张——超时按页自适应、UI 张数语义、上传会话页数上限 800"
```

---

## Task 3: 红灯问题——双 DSM 失败自动重试 + 明确报错

**Files:**
- Modify: `src/apps/answer-card/server/scanner/twain-bridge.ts`（`runBridge` 加 env 参数；`scan()` 加重试；导出取消探测）

- [ ] **Step 1: runBridge 支持 env 覆盖，并暴露取消探测**

`src/apps/answer-card/server/scanner/twain-bridge.ts`：

`runBridge` 签名（:81）改为：

```ts
function runBridge(args: string[], timeoutMs = 120_000, sessionId?: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
```

`spawn(exePath, args, {` 处（:90-93）改为：

```ts
    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env
    });
```

`cancelScan` 函数（:17-36）之后新增导出（供 scan() 判断「本次失败是不是用户主动取消」，取消不重试）：

```ts
/** 该会话是否处于已请求取消状态（scan() 重试前判断用，避免取消被当成设备失败重试） */
export function isCancelRequested(sessionId: string): boolean {
  return cancelRequested.has(sessionId);
}
```

注意：`cancelRequested` 集合在 `runBridge` 成功 spawn 后会 `delete`（:98），所以取消后杀的进程 `close` 时集合里仍有 sessionId（cancelScan 先 add 且只有 spawn 路径 delete）——已满足探测需求，无需额外状态。

- [ ] **Step 2: scan() 加重试逻辑**

`scan()`（:327-365）末尾部分：

```ts
  const { stdout } = await runBridge(args, scanTimeoutMs(config.maxPages), sessionId);
  return parseBridgeJson(stdout) as unknown as BridgeScanResult;
```

改为：

```ts
  const timeoutMs = scanTimeoutMs(config.maxPages);
  try {
    const { stdout } = await runBridge(args, timeoutMs, sessionId);
    return parseBridgeJson(stdout) as unknown as BridgeScanResult;
  } catch (firstError) {
    // 主动取消不重试；用户显式指定过 TWAIN_DSM_DLL 时尊重其配置，不自动切换
    if ((sessionId && isCancelRequested(sessionId)) || process.env.TWAIN_DSM_DLL) throw firstError;
    const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
    console.warn(`[scanner] 首次扫描尝试失败（${firstMessage}），改用系统 twain_32.dll 重试一次`);
    try {
      const { stdout } = await runBridge(args, timeoutMs, sessionId,
        { ...process.env, TWAIN_DSM_DLL: "C:\\Windows\\twain_32.dll" });
      return parseBridgeJson(stdout) as unknown as BridgeScanResult;
    } catch (secondError) {
      const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(
        "扫描仪无响应（指示灯未转绿）。已先后尝试 TWAIN 2.x（TWAINDSM.dll）与系统兼容模式（twain_32.dll）均失败。\n" +
        `模式一：${firstMessage}\n模式二：${secondMessage}\n` +
        "建议：1) 关闭其它扫描软件（如柯达采集软件）后重试；2) 重启扫描仪；3) 重装/更新柯达 TWAIN 驱动。"
      );
    }
  }
```

说明：「设备无响应」的失败形态（ENABLEDS 假成功后等不到 XFERREADY）在 native 侧表现为 0 页 + `扫描未产生任何页面` 报错（runScanSession 抛错），或因 native 空闲超时而正常退出带 0 页——两种形态都落在上述 catch（桥接失败或上层抛错）。这里对**所有**非取消、未显式配置的首次失败都重试一次：另一种失败（设备被占用等）重试一次代价很小，且报错文案已列出两种模式的结果。

- [ ] **Step 3: 类型检查 + 已有取消冒烟**

Run: `npm run typecheck && npx tsx scripts/verify-scanner-cancel.ts`
Expected: typecheck 0 错误；取消冒烟退出码 0（重点确认取消路径没有被重试逻辑破坏）。

- [ ] **Step 4: Commit**

```bash
git add src/apps/answer-card/server/scanner/twain-bridge.ts
git commit -m "fix(scanner): 扫描无响应时自动切换 twain_32 DSM 重试一次并给出双模式明确报错"
```

---

## Task 4: 重复学号 P1——复现脚本先行

**Files:**
- Create: `scripts/duplicate-rescan-smoke.ts`

- [ ] **Step 1: 写复现脚本（此时应失败）**

创建 `scripts/duplicate-rescan-smoke.ts`，基建照抄 `scripts/scanner-batch-results-smoke.ts:1-96` 的隔离模式（mkdtemp + `ANSWER_CARD_DATA_DIR`/`PROJECTX_DB_PATH` 环境变量 + `initializeDatabase()` + express 挂 `createScannerRouter(false)` 与 `uploadRouter` + 插入 scope=scanner 的 api_key），之后：

```ts
// 场景 A：同一物理卡重扫（识别内容完全一致）不应被判重、不应撤回成绩
// 场景 B：真重复（同学号不同内容）→ 409 + 作废多余副本 → 成绩恢复且仅一份
```

关键流程（卡片用 `createDefaultCard` + 1 道客观题 answerKey {"1":["A"]}，单面 1 页，与 batch-results 冒烟同款；学号 91001；`createVerifiedRecord` 同 :34-39）：

```ts
async function makeRecord(sessionId: string, pageNum: number, option: string) {
  const record = await createVerifiedRecord({ sessionId, cardId: card.id, pageNum, imagePath: path.join(root, `p${pageNum}_${option}.png`) });
  await store.updateScanOcrResult(record.id, "91001", 1, "done");
  await store.upsertRecognitionResult({ scanRecordId: record.id,
    objectiveJson: JSON.stringify([{ questionNumber: 1, selectedOptions: [option], confidence: 1 }]),
    subjectiveJson: "[]", gradeStatus: "done" });
  return record;
}
async function postResults(sessionId: string) {
  const res = await fetch(`http://127.0.0.1:${address.port}/api/scanner/session/${sessionId}/results`, { method: "POST" });
  return { status: res.status, body: (await res.json()) as ScanBatchResponse };
}
const scoreOf = async () => Number((await db.get<{ n: number }>("SELECT COUNT(*) n FROM student_scores WHERE exam_id = ?", exam.lastInsertRowid))!.n);

// —— 场景 A：重扫副本 ——
const s1 = await store.createSession(card.id, "scan-a");
await makeRecord(s1.id, 1, "A");
await store.updateSessionStatus(s1.id, "completed");
let r = await postResults(s1.id);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(await scoreOf(), 1, "第一次保存应入库");

const s2 = await store.createSession(card.id, "rescan-a");
await makeRecord(s2.id, 1, "A");           // 同一学生、同一答案——同一物理卡的重扫
await store.updateSessionStatus(s2.id, "completed");
r = await postResults(s2.id);
assert.equal(r.status, 200, `重扫副本应自动消化，实际 ${r.status}: ${JSON.stringify(r.body.failures)}`);
assert.equal(r.body.failures.length, 0, "重扫副本不应产生失败项");
assert.equal(await scoreOf(), 1, "重扫绝不能撤回已保存成绩");

// —— 场景 B：真重复 + 作废 ——
const s3 = await store.createSession(card.id, "dup-b");
await makeRecord(s3.id, 1, "B");           // 同学号、不同答案——真重复
await store.updateSessionStatus(s3.id, "completed");
r = await postResults(s3.id);
assert.equal(r.status, 409, "真重复必须 409");
assert.ok(r.body.failures[0].conflicts?.length === 2, "冲突清单应含新旧两张");
assert.equal(await scoreOf(), 0, "真重复应撤出新旧成绩待人工核对");

const d = await fetch(`http://127.0.0.1:${address.port}/api/scanner/upload/sessions/${s3.id}/groups/0/discard`, { method: "POST" });
assert.equal(d.status, 200, await d.clone().text());   // groupId "0"：单面 1 页卡 groupIndex=0

r = await postResults(s1.id);              // 原卷重新保存 → 成绩恢复
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(await scoreOf(), 1, "作废副本后原卷成绩应恢复且仅一份");
```

注意：本机结果端点是 `POST /api/scanner/session/:sid/results`（batch-results 冒烟 :89 同款）；discard 用远端上传路由前缀 `/api/scanner/upload/...`（两个路由器都已挂，见基建 :79-84）。`groupId` 是 `mapScanPageToLayout` 的 `groupIndex` 字符串（单面 1 页卡为 `"0"`）。

Run: `npx tsx scripts/duplicate-rescan-smoke.ts`
Expected: 场景 A 处 FAIL——现状重扫被判 409 且成绩被撤回（这正是线上 P1）。

- [ ] **Step 2: Commit（复现脚本先行，红）**

```bash
git add scripts/duplicate-rescan-smoke.ts
git commit -m "test(scanner): 重复学号重扫/作废复现脚本（当前应红）"
```

---

## Task 5: 重复学号 P1——服务端修复

**Files:**
- Modify: `src/server/services/scannerSubmissions.ts`（:277-282 判重循环；新增 `discardScannerGroup`）

- [ ] **Step 1: 内容级重扫判重**

`src/server/services/scannerSubmissions.ts` 的 `processScannerSession` 中，:277-282 这段：

```ts
        const all = await receipts(tx, exam.id);
        for (const studentNumber of new Set(all.map(r => r.student_number))) {
          if (all.filter(r => r.student_number === studentNumber).length > 1) await withdraw(tx, exam.id, studentNumber);
          // Resolved attempts remain pending until the teacher explicitly saves them.
          else await tx.run("UPDATE scanner_submissions SET state = 'pending' WHERE exam_id = ? AND student_number = ? AND state = 'conflict'", exam.id, studentNumber);
        }
```

改为：

```ts
        const all = await receipts(tx, exam.id);
        const rescannedGroups = new Set<string>();
        for (const studentNumber of new Set(all.map(r => r.student_number))) {
          const withNumber = all.filter(r => r.student_number === studentNumber);
          if (withNumber.length > 1) {
            // P1 重扫判重：同学生、识别内容逐题一致 ⇒ 同一物理卡的重扫副本。
            // 作废多余副本并保留成绩——绝不能按「新 vs 旧」撤回（线上一张卡反复重传，
            // 每次都把上一次已保存的成绩撤掉，成绩永远存不住、冲突卡越滚越多）。
            const saved = withNumber.find(r => r.state === "saved" && r.result_json);
            if (saved) {
              const savedResult = JSON.parse(saved.result_json!) as CombinedStudentResult;
              for (const candidate of candidates.filter(c => c.studentNumber === studentNumber)) {
                if (await candidateMatchesSavedResult(tx, candidate, savedResult)) {
                  await tx.run("UPDATE scanner_submissions SET state = 'superseded', group_id = ? WHERE exam_id = ? AND session_id = ? AND group_id = ?",
                    `${candidate.groupId}:rescan:${Date.now()}`, exam.id, sessionId, candidate.groupId);
                  rescannedGroups.add(candidate.groupId);
                }
              }
            }
          }
          const remaining = (await receipts(tx, exam.id)).filter(r => r.student_number === studentNumber);
          if (remaining.length > 1) await withdraw(tx, exam.id, studentNumber);
          // Resolved attempts remain pending until the teacher explicitly saves them.
          else await tx.run("UPDATE scanner_submissions SET state = 'pending' WHERE exam_id = ? AND student_number = ? AND state = 'conflict'", exam.id, studentNumber);
        }
```

同文件新增（放在 `conflictCard` 之后）：

```ts
/** 候选组的识别内容与已保存回执是否逐题一致（重扫判重依据）。页序按题号归一后比较。 */
async function candidateMatchesSavedResult(tx: DbAdapter, candidate: { pages: ScanBatchPage[] }, saved: CombinedStudentResult): Promise<boolean> {
  if (saved.pageCount !== candidate.pages.length) return false;
  const marks = candidate.pages.map(() => "?").join(",");
  const rows = await tx.all<{ objective_json: string | null; subjective_json: string | null }>(
    `SELECT objective_json, subjective_json FROM twain_recognition_results WHERE scan_record_id IN (${marks})`,
    ...candidate.pages.map(p => p.recordId));
  if (rows.length !== candidate.pages.length || rows.some(r => !r.objective_json || !r.subjective_json)) return false;
  const canonical = (json: string) => {
    const arr = JSON.parse(json) as Array<Record<string, unknown>>;
    return JSON.stringify([...arr].sort((a, b) => Number(a.questionNumber) - Number(b.questionNumber)));
  };
  return canonical(JSON.stringify(rows.flatMap(r => JSON.parse(r.objective_json!))))
      === canonical(JSON.stringify(saved.objectiveQuestions))
    && canonical(JSON.stringify(rows.flatMap(r => JSON.parse(r.subjective_json!))))
      === canonical(JSON.stringify(saved.subjectiveQuestions));
}
```

然后在 `processScannerSession` 的冲突后置循环（:312 `for (const candidate of candidates) {`）开头加：

```ts
      if (rescannedGroups.has(candidate.groupId)) continue;   // 重扫副本已自动消化，不再报冲突
```

注意：`rescannedGroups` 在 `if (mode !== "preview")` 的 tx 块内声明，而后置循环在块外——需把声明上移到 `const { exams, exam } = ...` 之后（函数级），tx 内只 `rescannedGroups.add(...)`。

- [ ] **Step 2: discardScannerGroup 核心函数**

同文件新增导出（放在 `invalidateScanRecognition` 之后）：

```ts
/** 教师作废一张重复卷：回执置 superseded、页面标记作废。已入库（saved 且有成绩）的卷拒绝作废。 */
export async function discardScannerGroup(card: AnswerCard, sessionId: string, groupId: string): Promise<void> {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb();
    await db.transaction(async tx => {
      const records = (await listScanRecordsGroupedByStudent(sessionId)).flatMap(g => g.records);
      const group = groupSessionPages(card, records).groups.get(groupId);
      if (!group) throw new Error("答题卡分组不存在");
      const receipt = await tx.get("SELECT state, result_json FROM scanner_submissions WHERE session_id = ? AND group_id = ? AND state != 'superseded'", sessionId, groupId);
      if (receipt?.state === "saved" && receipt.result_json) {
        throw new Error("该卷成绩已入库，不能作废；请作废其它重复副本");
      }
      await tx.run("UPDATE scanner_submissions SET state = 'superseded', group_id = ? WHERE session_id = ? AND group_id = ? AND state != 'superseded'",
        `${groupId}:discarded:${Date.now()}`, sessionId, groupId);
      for (const { record } of group) {
        await tx.run("UPDATE twain_scan_records SET student_id = NULL, ocr_status = 'failed', ocr_error = '重复卷已由教师作废' WHERE id = ? AND session_id = ?", record.id, sessionId);
        await tx.run("DELETE FROM twain_recognition_results WHERE scan_record_id = ?", record.id);
        await tx.run("DELETE FROM answer_block_crops WHERE source_type = 'twain_scan_record' AND source_record_id = ?", record.id);
      }
      await tx.run("DELETE FROM twain_student_grading_results WHERE session_id = ?", sessionId);
    });
  });
}
```

- [ ] **Step 3: 远端 discard 路由**

`src/server/routes/scanner-upload.ts` 的 `/correct` 路由（:515-541）之后新增：

```ts
router.post("/sessions/:sessionId/groups/:groupId/discard", dualAuth, async (req, res, next) => {
  try {
    const sessionId = String(req.params.sessionId);
    const session = await getMysqlDb().get<{ card_id: string }>("SELECT card_id FROM twain_scan_sessions WHERE id = ?", sessionId);
    const card = session && await new CardRepository().findById(session.card_id);
    if (!card) { res.status(404).json({ message: "扫描会话或答题卡不存在" }); return; }
    await discardScannerGroup(card, sessionId, String(req.params.groupId));
    res.json(await processScannerSession(card, sessionId, "validate"));
  } catch (error) { next(error); }
});
```

文件顶部 import 补 `discardScannerGroup`（加入 existing `scannerSubmissions` import——先 `grep -n "scannerSubmissions" src/server/routes/scanner-upload.ts` 看现有导入形态）。

- [ ] **Step 4: 本机 discard 路由**

`src/apps/answer-card/server/scanner/index.ts`：第 1 行 import 改为：

```ts
import { processScannerSession, discardScannerGroup } from "../../../../server/services/scannerSubmissions";
```

在 `/session/:sessionId/retry` 路由（:520）之后新增（形态照 retry 路由：不用 twainEnabled 闸门——作废不调用本机识别器；卡片解析复用 retry 里的 `findCardForLayout`）：

```ts
  router.post("/session/:sessionId/groups/:groupId/discard", async (req, res, next) => {
    try {
      const sessionId = safeId(req.params.sessionId);
      const session = await getSession(sessionId);
      if (!session) { res.status(404).json({ message: "扫描会话不存在" }); return; }
      const card = await findCardForLayout(session.card_id);
      if (!card) { res.status(404).json({ message: "答题卡不存在" }); return; }
      await discardScannerGroup(card, sessionId, String(req.params.groupId));
      res.json(await processScannerSession(card, sessionId, "validate"));
    } catch (error) { next(error); }
  });
```

`getSession`、`safeId`、`findCardForLayout` 均已在该文件导入（:1-32 import 区），无需新增其它 import。

- [ ] **Step 5: 跑复现脚本转绿**

Run: `npx tsx scripts/duplicate-rescan-smoke.ts`
Expected: 全部断言通过（场景 A 重扫自动消化、场景 B 作废后恢复）。

- [ ] **Step 6: 相关回归冒烟**

Run: `npx tsx scripts/scanner-batch-results-smoke.ts && npx tsx scripts/scanner-upload-manager-smoke.ts && npx tsx scripts/scan-session-pages-smoke.ts && npx tsx scripts/scanner-image-limits-smoke.ts`
Expected: 全部退出码 0。（若 upload-manager 冒烟里对重复学号 409 有旧断言，按新语义更新——重扫副本不再 409。）

- [ ] **Step 7: Commit**

```bash
git add src/server/services/scannerSubmissions.ts src/server/routes/scanner-upload.ts src/apps/answer-card/server/scanner/index.ts scripts/duplicate-rescan-smoke.ts
git commit -m "fix(scanner): 重复学号 P1——同内容重扫副本自动消化不撤回成绩，新增作废重复卷动作"
```

---

## Task 6: 客户端——冲突卡「作废此卷」按钮

**Files:**
- Modify: `src/apps/answer-card/client/components/ScannerConflictCards.tsx`

- [ ] **Step 1: 加 discard 动作与按钮**

`ScannerConflictCards.tsx` 的 `act` 函数（:33-53）之后新增：

```tsx
  async function discard(card: ScanConflictCard) {
    setBusy(true); setMessage("");
    try {
      const base = remote ? `/api/scanner/upload/sessions/${encodeURIComponent(card.sessionId)}` : `/api/scanner/session/${encodeURIComponent(card.sessionId)}`;
      const response = await request(`${base}/groups/${encodeURIComponent(card.groupId)}/discard`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "作废失败");
      setMessage("该重复卷已作废，剩余卷可重新保存");
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "作废失败"); }
    finally { setBusy(false); }
  }
```

按钮：:65 `订正此卷` 按钮之后加（legacy 历史卷不可作废——它没有可作废的回执语义）：

```tsx
            {!legacy && <Button size="sm" variant="outline" disabled={busy} onClick={() => void discard(card)}>作废此卷</Button>}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 0 错误。

- [ ] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/components/ScannerConflictCards.tsx
git commit -m "feat(scanner): 重复学号冲突卡支持作废多余副本"
```

---

## Task 7: 扫描完成后自动后台上传（先出分、图片续传）

**Files:**
- Modify: `src/apps/answer-card/client/components/ScannerPanel.tsx`（:100-110 状态区、:341-348 done 处理、:375-436 results/save 区）

- [ ] **Step 1: 抽出 queueSuccessfulUploads + ref 同步**

`ScannerPanel.tsx` :108 `const [uploadJobs, setUploadJobs] = useState<Record<string, string>>({});` 之后加：

```ts
  const uploadJobsRef = useRef<Record<string, string>>({});
  // 每个会话只自动入队一次（done 后 SSE 重连可能再次进入 done 分支）
  const autoQueuedRef = useRef<string>("");
```

在「保持 ref 与 state 同步」的 useEffect 区（:128-133）加：

```ts
  useEffect(() => {
    uploadJobsRef.current = uploadJobs;
  }, [uploadJobs]);
```

在 `saveSuccessful`（:399-436）之前新增：

```ts
  /** 把成功答题卡加入后台上传队列（自动与手动共用；已入队的组自动跳过） */
  function queueSuccessfulUploads(data: ScanBatchResponse) {
    const nextJobs = { ...uploadJobsRef.current };
    let queued = 0;
    for (const result of data.results) {
      if (nextJobs[result.groupId]) continue;
      nextJobs[result.groupId] = scannerUploadManager.startUpload({
        identityMode: sessionLegacyIdentity ? "legacy" : "strict",
        kind: "scan", cardId, name: `扫描_${result.studentId}`, dpi, paperSize,
        cardVersion,
        pages: result.pages.map(page => ({
          pageNum: page.pageNum, side: page.side, groupId: result.groupId,
          layoutPage: page.layoutPage, studentId: result.studentId,
          getBlob: async () => {
            const res = await authFetch(`/api/scanner/scan-image/${page.recordId}`);
            if (!res.ok) throw new Error(`读取本机扫描图失败（HTTP ${res.status}）`);
            return res.blob();
          },
        })),
      });
      queued++;
    }
    uploadJobsRef.current = nextJobs;
    setUploadJobs(nextJobs);
    if (queued > 0) setResultMessage("成功答题卡已自动加入上传队列，图片将在后台续传；失败答题卡保留在本机，可继续订正。");
  }
```

把 `saveSuccessful` 里 remote 分支的整段 `const nextJobs = ... setUploadJobs(nextJobs);` 循环体替换为 `queueSuccessfulUploads(data);`（保留 `remote && !isRemoteServerConfigured()` 的前置校验与本地分支文案）。

- [ ] **Step 2: done 后自动入队**

`fetchCombinedResults`（:389-397）改为：

```ts
  async function fetchCombinedResults(sid: string) {
    if (resultsBusyRef.current) return;
    resultsBusyRef.current = true;
    setResultsBusy(true);
    setErrorMessage("");
    try {
      const data = await readResults(sid);
      applyResults(data);
      // 远端模式：成绩汇总一完成即自动后台上传（先出分、图片续传，进度见右上角进度条）
      if (getScannerMode() === "remote" && isRemoteServerConfigured() && autoQueuedRef.current !== sid) {
        autoQueuedRef.current = sid;
        queueSuccessfulUploads(data);
      }
    }
    catch (err) { setErrorMessage(err instanceof Error ? err.message : "汇总失败，请重试"); }
    finally { resultsBusyRef.current = false; setResultsBusy(false); }
  }
```

- [ ] **Step 3: 手动按钮保留 + 状态提示**

确认 :854-855 的「保存成功部分到服务器」按钮保留（自动入队失败的兜底）；`studentResults.some(r => !uploadJobs[r.groupId])` 的 disabled 条件保持原样即可。

- [ ] **Step 4: 类型检查 + 上传管理器冒烟**

Run: `npm run typecheck && npx tsx scripts/scanner-upload-manager-smoke.ts`
Expected: 0 错误 / 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add src/apps/answer-card/client/components/ScannerPanel.tsx
git commit -m "feat(scanner): 远端模式成绩汇总完成即自动后台上传，不再需要手动点保存"
```

---

## Task 8: 文档同步与总验证

**Files:**
- Modify: `readus/CHANGELOG.md`、`readus/SCANNER-SETUP.md`

- [ ] **Step 1: 文档同步**

- `readus/CHANGELOG.md`：追加 2026-10-11 条目，记录：CAP_XFERCOUNT 修复（只录 1 张）、批扫 400 张、双 DSM 重试、重复学号 P1 修复（重扫自动消化 + 作废）、自动后台上传。
- `readus/SCANNER-SETUP.md`：grep 其中「200」「最大页数」「重复」相关段落并同步新语义（单次最高 400 张、上传会话默认 800 页、冲突卡新增作废按钮）。
- grep 全仓残留：`grep -rn "最大页数" src/ readus/ "user guide/"` 确认无过期文案。

- [ ] **Step 2: 总验证**

Run: `npm run typecheck && npm run build:scanner:full`
Expected: 类型检查与扫描端+服务端构建全部通过。

Run: `npx tsx scripts/duplicate-rescan-smoke.ts && npx tsx scripts/scanner-batch-results-smoke.ts && npx tsx scripts/scanner-upload-manager-smoke.ts && npx tsx scripts/verify-scanner-cancel.ts && npx tsx scripts/verify-scanner-scan-timeout.ts && npx tsx scripts/scan-page-numbering.ts 2>/dev/null || npx tsx scripts/verify-scan-page-numbering.ts`
Expected: 全部退出码 0。

- [ ] **Step 3: Commit**

```bash
git add readus/CHANGELOG.md readus/SCANNER-SETUP.md
git commit -m "docs(scanner): 同步批扫上限/双DSM/重复学号作废/自动上传行为说明"
```

---

## 现场验收清单（需要真实 i3000，构建通过后交用户执行）

1. 不开 C30，直接扫：指示灯应变绿；若仍红灯，界面应给出「已尝试两种 TWAIN 模式」的明确报错。
2. 连续放 10 张：扫描端应显示 10 张（修 CAP_XFERCOUNT 前只显示 1 张）。
3. 进纸器放 400 张双面连扫：应完整走完，不被 10 分钟超时截断。
4. 同一张卡扫两遍上传：第二次应自动消化、不再报重复学号、成绩不被撤回；真重复（不同答案）才进冲突核对，可「作废此卷」。
5. 远端模式扫完即见分数，右上角进度条自动开始传图，无需手动点保存。

## Self-Review 结论

- 规格覆盖：问题①→Task 1+3；问题②→Task 1+2；问题③→Task 7；问题④（截图 P1）→Task 4-6。无占位符；类型/函数名跨任务一致（`scanTimeoutMs`、`discardScannerGroup`、`candidateMatchesSavedResult`、`rescannedGroups`、`queueSuccessfulUploads`）。
- 未覆盖声明：C++ 与真实硬件行为无法在本机验证，构建通过 ≠ 设备验收；MariaDB 方言下 `discardScannerGroup` 的 SQL 均为参数化通用写法，但复现脚本跑的是 SQLite，合并前建议在 MariaDB 临时实例跑一遍 `SCANNER_BATCH_MARIADB=1` 同款验证（Task 5 Step 6 的脚本支持 MariaDB 模式，照 batch-results 冒烟的环境变量约定）。
