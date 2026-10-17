/**
 * 扫描阶段告警的可恢复性 —— 自动化验证脚本（issue #331 复核 P2）
 * ----------------------------------------------------------------
 * 运行方式：
 *   npm run verify:scanner-warning-replay                  # SQLite（本机默认）
 *   SCANNER_BATCH_MARIADB=1 npm run verify:scanner-warning-replay   # MariaDB，需一个专用空库
 *
 * 覆盖场景：
 *   1. 告警必须落到会话行：SSE 只发给当时的监听者，客户端在 202 之后才订阅、
 *      或长时间扫描中途断线重连时，只广播会让「本次批次一张红笔都没采纳」这类
 *      结论在横幅和「复制诊断」里永久缺席。
 *   2. 已终态的会话被订阅时，先补发落库告警再补终态事件（老师重开页面也能看到）。
 *   3. 重复/空白告警不重复入库，条数有上限，坏 JSON 不得把补发打挂。
 *   4. 竞态：把告警写入真的延迟（setWarningWriteDelayForTests），在延迟窗口里写终态并重连，
 *      断言终态可见时告警已在行里、补发顺序是「告警 → 终态」。只预先写好告警再测补发，
 *      覆盖不到这条窗口，所以这里同时保留「旧顺序会漏」的反证。
 *   5. 取消请求与 SSE 订阅同时发生：监听器已注册、告警补发尚未完成时，终态事件必须排队，
 *      不能先关流；本机没有扫描仪，因此用真实取消路由触发这条时序。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 必须在导入任何 db 模块前设置数据库路径（getDatabase 在模块求值期读取该变量）
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-warning-replay-"));
// 断言中途抛错也要清掉临时库：exit 监听在正常结束、process.exit 与未捕获错误终止时都会跑。
process.on("exit", () => rmSync(tmpDir, { recursive: true, force: true }));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
process.env.PROJECTX_AUTH_ENFORCE = "0";
// 告警队列与终态写入的先后关系是异步的，生产方言（MariaDB）的连接池才是真正的调度环境，
// 所以同一套断言必须能在两种方言下跑：SCANNER_BATCH_MARIADB=1 + 一个专用空库。
const useMariaDb = process.env.SCANNER_BATCH_MARIADB === "1";
if (useMariaDb) {
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
  assert.match(process.env.PROJECTX_MARIADB_DATABASE ?? "", /^projectx_scanner_batch_[a-z0-9_]+$/);
} else {
  for (const name of Object.keys(process.env)) {
    if (/^PROJECTX_(MARIADB|MYSQL)_/.test(name)) delete process.env[name];
  }
}

const { initializeDatabase, getMysqlDb, closeDatabase, initMariadbSchema } = await import("../src/server/db");
initializeDatabase();
const db = getMysqlDb();
if (useMariaDb) await initMariadbSchema();

const store = await import("../src/apps/answer-card/server/database/scan-store");
const warnings = await import("../src/apps/answer-card/server/scanner/sessionWarnings");
const { createScannerRouter } = await import("../src/apps/answer-card/server/scanner/index");

// ── 1/3. 落库、去重、上限与坏数据 ────────────────────────────
const hasWarningsColumn = useMariaDb
  ? (await db.all<{ Field: string }>("SHOW COLUMNS FROM twain_scan_sessions LIKE 'warnings_json'")).length > 0
  : (await db.all<{ name: string }>("PRAGMA table_info(twain_scan_sessions)")).some((c) => c.name === "warnings_json");
assert.ok(hasWarningsColumn, "会话行必须有告警列（两种方言的建表都要有）");
const migrated = await db.all<{ version: number }>("SELECT version FROM schema_migrations");
assert.ok(migrated.some((r) => r.version === 63), "已有库升级必须带 scan-session-warnings 迁移");

const session = await store.createSession("card-warning", "告警补发", {});
await store.appendSessionWarning(session.id, "本答题卡含红笔手写分数格，已自动把扫描模式从「灰度」改为「彩色」");
await store.appendSessionWarning(session.id, "本答题卡含红笔手写分数格，已自动把扫描模式从「灰度」改为「彩色」");
await store.appendSessionWarning(session.id, "   ");
await store.appendSessionWarning(session.id, "实际交付 DPI 与设定不一致");
await store.updateSessionStatus(session.id, "completed");

const readStored = async (id: string) => store.parseSessionWarnings(
  (await db.get<{ warnings_json: string | null }>("SELECT warnings_json FROM twain_scan_sessions WHERE id = ?", id))?.warnings_json);
assert.deepEqual(await readStored(session.id), [
  "本答题卡含红笔手写分数格，已自动把扫描模式从「灰度」改为「彩色」",
  "实际交付 DPI 与设定不一致",
], "重复与空白告警不得二次入库");
// 上限用单独会话验证，避免把上面待补发的两条挤掉
const noisy = await store.createSession("card-noisy", "告警上限", {});
for (let i = 0; i < 30; i += 1) await store.appendSessionWarning(noisy.id, `告警 ${i}`);
const capped = await readStored(noisy.id);
assert.ok(capped.length <= 20 && capped.includes("告警 29") && !capped.includes("告警 0"),
  `告警条数须有上限且丢最旧的，实际 ${capped.length}`);
assert.deepEqual(await readStored(session.id), [
  "本答题卡含红笔手写分数格，已自动把扫描模式从「灰度」改为「彩色」",
  "实际交付 DPI 与设定不一致",
], "两条告警必须原序留在会话行");
await store.appendSessionWarning("no-such-session", "会话不存在时不得抛错");
assert.deepEqual(store.parseSessionWarnings("{坏的 JSON"), [], "脏数据必须回落成空列表");

// ── 2. 终态会话订阅时补发告警，再补终态 ──────────────────────
const express = (await import("express")).default;
const app = express();
app.use("/api/scanner", createScannerRouter(true));
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;

async function readSse(sessionId: string): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/scanner/progress/${sessionId}`);
  assert.equal(response.status, 200, "SSE 订阅必须 200");
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await response.text();
  return text.split("\n\n").filter((block) => block.startsWith("data: "))
    .map((block) => block.slice(6));
}

const events = (await readSse(session.id)).map((raw) => JSON.parse(raw) as { type: string; message?: string });
const types = events.map((e) => e.type);
assert.deepEqual(types.slice(0, 2), ["warning", "warning"], `告警必须在终态之前补发，实际 ${types.join(",")}`);
assert.equal(types.at(-1), "done", "补发告警后仍要给出终态");
assert.equal(events[0].message, "本答题卡含红笔手写分数格，已自动把扫描模式从「灰度」改为「彩色」");
assert.equal(events[1].message, "实际交付 DPI 与设定不一致");
assert.equal(new Set(events.map((e) => e.message)).size, events.length, "同一连接内不得重复补发同一条告警");

// 没有告警的会话只剩终态，不能凭空多出 warning 事件
const plain = await store.createSession("card-plain", "无告警", {});
await store.updateSessionStatus(plain.id, "error", "扫描中途失败");
const plainEvents = (await readSse(plain.id)).map((raw) => JSON.parse(raw) as { type: string });
assert.deepEqual(plainEvents.map((e) => e.type), ["error"], "无告警会话不得补出 warning");

// ── 5. 竞态：告警写入被真延迟时，终态与重连都必须等到它写完 ──────
// 复现评审给出的调用顺序：OCR 末尾发告警（写入只排进会话队列）→ 紧接着写终态并广播 done
// → 此前已断线的客户端在这个窗口里重连。只预先写好告警的补发用例覆盖不到这里。
const RACE_WARNING = "本次批次一张红笔都没采纳（斜线打分）";
const DELAY_MS = 250;
const raceTypes = (id: string) => readSse(id).then((raws) => raws
  .map((raw) => JSON.parse(raw) as { type: string })
  .map((e) => e.type));

warnings.setWarningWriteDelayForTests(DELAY_MS);
try {
  // 反证「先写终态、告警随后才落库」确实是旧代码的时序：终态可见的那一刻，行里还没有告警。
  const racedOld = await store.createSession("card-race-old", "旧顺序", {});
  warnings.persistSessionWarning(racedOld.id, RACE_WARNING);
  await store.updateSessionStatus(racedOld.id, "completed");
  assert.deepEqual(await readStored(racedOld.id), [],
    "反证：不等队列就写终态时，告警仍在队列里、会话行读不到");
  // 订阅侧同样要等：/progress 先排空队列再读行，这个窗口才不会被「补发完就关流」钉死。
  assert.deepEqual(await raceTypes(racedOld.id), ["warning", "done"],
    "重连补发在关闭前必须取到完整告警（订阅侧也要等队列）");
  assert.deepEqual(await readStored(racedOld.id), [RACE_WARNING], "延迟的告警最终仍要落到会话行");

  const reserved = await store.createSession("card-race-reserved", "取消意图优先", {});
  warnings.reserveSessionCancellation(reserved.id);
  warnings.persistSessionWarning(reserved.id, RACE_WARNING);
  assert.equal(await warnings.markSessionTerminal(reserved.id, "error"), false,
    "取消意图落位后，被杀扫描的错误路径不能抢写终态");
  assert.equal((await store.getSession(reserved.id))?.status, "pending",
    "错误转换被拒绝后，会话仍等待取消路径写终态");
  assert.equal(await warnings.markSessionTerminal(reserved.id, "cancelled"), true,
    "取消路径仍可在告警落库后写入 cancelled");
  assert.deepEqual(await readStored(reserved.id), [RACE_WARNING], "取消路径同样要等告警落库完成");

  for (const status of ["completed", "error", "cancelled"] as const) {
    const s = await store.createSession(`card-race-${status}`, "终态顺序", {});
    warnings.persistSessionWarning(s.id, RACE_WARNING);
    // 计时用单调时钟，并给定时器留 10ms 容差：原先用 Date.now() 相减并卡 `>= 250`，
    // 两端的毫秒截断会让「正好等满 250ms」量成 249ms——CI run 573 就是这样假红的
    // （同一脚本在 main 的 run 571 与本机均通过，与 #322/#283 无关）。
    // 容差不会把这条断言变成空断言：不排队就写终态的实现，这里量到的是 ~0ms，照样红。
    const started = performance.now();
    await warnings.markSessionTerminal(s.id, status, status === "completed" ? undefined : "扫描阶段失败");
    const waited = performance.now() - started;
    assert.ok(waited >= DELAY_MS - 10,
      `${status}：终态必须等告警写完（本次只等了 ${waited.toFixed(1)}ms，下限 ${DELAY_MS - 10}ms）`);
    assert.deepEqual(await readStored(s.id), [RACE_WARNING],
      `${status}：终态一可见，告警就已经在会话行里`);
    assert.deepEqual(await raceTypes(s.id), ["warning", status === "completed" ? "done" : status],
      `${status}：这个会话之后重连，仍是先告警后终态`);
  }

  // 真实接线竞态：取消请求先等告警队列，SSE 稍后订阅也必须补发告警。
  // 监听器在补发初始化前就注册；若终态事件此时直接关流，旧实现只留下 cancelled。
  const racing = await store.createSession("card-race-live", "订阅初始化竞态", {});
  warnings.persistSessionWarning(racing.id, RACE_WARNING);
  const cancelResponse = fetch(`http://127.0.0.1:${port}/api/scanner/scan/${racing.id}/cancel`, { method: "POST" });
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const racingTypes = await raceTypes(racing.id);
  const cancelResult = await cancelResponse;
  assert.equal(cancelResult.status, 200, "取消请求必须成功");
  assert.equal((await cancelResult.json() as { status: string }).status, "cancelled", "取消接口必须明确返回 cancelled");
  assert.deepEqual(racingTypes, ["warning", "cancelled"],
    "订阅初始化期间收到终态，也必须先补发落库告警再关流");
  assert.equal(await warnings.markSessionTerminal(racing.id, "completed"), false,
    "已经落库的取消不能被后续完成转换覆盖");
  assert.equal((await store.getSession(racing.id))?.status, "cancelled",
    "完成转换被拒绝后，会话最终状态仍是 cancelled");
} finally {
  warnings.setWarningWriteDelayForTests(0);
}

server.close();
closeDatabase();

console.log(`verify-scanner-warning-replay: 全部通过（方言=${useMariaDb ? "MariaDB" : "SQLite"}；告警落库 / 终态订阅补发 / 去重与上限 / 延迟写入竞态与终态顺序）`);
process.exit(0);
