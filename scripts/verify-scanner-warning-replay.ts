/**
 * 扫描阶段告警的可恢复性 —— 自动化验证脚本（issue #331 复核 P2）
 * ----------------------------------------------------------------
 * 运行方式：
 *   npm run verify:scanner-warning-replay
 *
 * 覆盖场景：
 *   1. 告警必须落到会话行：SSE 只发给当时的监听者，客户端在 202 之后才订阅、
 *      或长时间扫描中途断线重连时，只广播会让「本次批次一张红笔都没采纳」这类
 *      结论在横幅和「复制诊断」里永久缺席。
 *   2. 已终态的会话被订阅时，先补发落库告警再补终态事件（老师重开页面也能看到）。
 *   3. 重复/空白告警不重复入库，条数有上限，坏 JSON 不得把补发打挂。
 *   4. 实时广播侧的接线（emitProgress 落库 + 连接级去重）留在源码里钉住：
 *      这里没有本机扫描仪，无法真跑 POST /scan，因此不断言实时链路的行为。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 必须在导入任何 db 模块前设置数据库路径（getDatabase 在模块求值期读取该变量）
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-warning-replay-"));
// 断言中途抛错也要清掉临时库：exit 监听在正常结束、process.exit 与未捕获错误终止时都会跑。
process.on("exit", () => rmSync(tmpDir, { recursive: true, force: true }));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
process.env.PROJECTX_AUTH_ENFORCE = "0";
for (const name of Object.keys(process.env)) {
  if (/^PROJECTX_(MARIADB|MYSQL)_/.test(name)) delete process.env[name];
}

const { initializeDatabase, getMysqlDb, closeDatabase } = await import("../src/server/db");
initializeDatabase();
const db = getMysqlDb();

const store = await import("../src/apps/answer-card/server/database/scan-store");
const { createScannerRouter } = await import("../src/apps/answer-card/server/scanner/index");

// ── 1/3. 落库、去重、上限与坏数据 ────────────────────────────
const columns = await db.all<{ name: string }>("PRAGMA table_info(twain_scan_sessions)");
assert.ok(columns.some((c) => c.name === "warnings_json"), "会话行必须有告警列（SQLite 建表）");
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

server.close();
closeDatabase();

// ── 4. 实时链路接线（源码钉住，本机无扫描仪跑不了 POST /scan） ──
// 用字串包含而不是正则：这几处含 `?.`、`??`、`[`，写成正则容易自我打结。
const router = readFileSync(fileURLToPath(new URL(
  "../src/apps/answer-card/server/scanner/index.ts", import.meta.url)), "utf8").replace(/\r/g, "");
const persistAt = router.indexOf("persistSessionWarning(sessionId, event.message.trim())");
const broadcastAt = router.indexOf("for (const fn of listeners) fn(event)");
assert.ok(persistAt > 0 && broadcastAt > persistAt, "告警必须在广播给监听者之前先起落库");
assert.ok(!router.includes("enqueuePersist(() => appendSessionWarning"),
  "告警不能排在主库持久化的串行队列后面——那会把补发空窗重新打开");
assert.ok(router.includes(".then(() => appendSessionWarning(sessionId, text))"),
  "同一会话的告警按会话串行写入，读行去重与写回之间不留并发缺口");
assert.ok(router.includes('if (event.type === "warning" && event.message?.trim())'), "只有非空 warning 事件才落库");
assert.ok(router.includes('if (event.type === "warning") {') && router.includes('writeWarning(event.message?.trim() ?? "");'),
  "实时告警必须走连接级去重，不能与补发重复");
const replayAt = router.indexOf("for (const text of parseSessionWarnings(session?.warnings_json)) writeWarning(text);");
const terminalAt = router.indexOf('session.status === "completed"', replayAt);
assert.ok(replayAt > 0 && terminalAt > replayAt, "补发必须早于终态事件");

console.log("verify-scanner-warning-replay: 全部通过（告警落库 / 终态订阅补发 / 去重与上限 / 实时接线在位）");
process.exit(0);
