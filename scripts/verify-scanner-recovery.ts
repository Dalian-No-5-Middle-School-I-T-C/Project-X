/**
 * 扫描端闪退恢复的本机状态回归：
 *  - 异常卷订正草稿只在页 revision 完全一致时恢复，保存/离开后清掉；
 *  - 后处理会话列表与停留位置可跨重载恢复，正常离开时清掉停留位置；
 *  - 内嵌服务端端口按固定阶梯选，页面 origin 稳定，本机那些恢复数据下次才读得回来。
 *
 * 运行：npx tsx scripts/verify-scanner-recovery.ts
 */
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";

class MemoryStorage {
  private map = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(key, String(value));
  }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  get length(): number { return this.map.size; }
}

(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage;

const {
  clearCorrectionDraft, draftMatchesDocument, readCorrectionDraft, writeCorrectionDraft,
} = await import("../src/apps/answer-card/client/lib/correctionDraft");
const {
  clearActivePostprocess, clearPostprocessView, readActivePostprocess, readPostprocessSessions,
  readPostprocessView, resolvePersistCardId, writeActivePostprocess, writePostprocessSessions, writePostprocessView,
} = await import("../src/apps/answer-card/client/lib/postprocessResume");
import type { CorrectionDocument, CorrectionEdit } from "../src/shared/scanCorrection";

function makeDocument(revision = 3): CorrectionDocument {
  return {
    card: { id: "card-1" },
    pages: [{
      sourceId: "page-1",
      revision,
      selected: ["cell-a"],
      touched: [],
      layout: {},
      recognition: {},
      imageUrl: "/image",
    }],
  } as unknown as CorrectionDocument;
}

function makeEdits(revision = 3): CorrectionEdit[] {
  return [{ sourceId: "page-1", revision, selected: ["cell-b"], touched: ["cell-b"] }];
}

function testCorrectionDraft(): void {
  const cardId = "card-1";
  const sessionId = "session-1";
  const groupId = "group-1";
  const doc = makeDocument(3);
  const edits = makeEdits(3);

  assert.equal(writeCorrectionDraft(cardId, sessionId, groupId, doc, edits), true, "草稿写入成功要返回 true");
  const restored = readCorrectionDraft(cardId, sessionId, groupId);
  assert(restored, "草稿应可读回");
  assert.deepEqual(restored!.edits, edits, "格选与 touched 原样恢复");
  assert(draftMatchesDocument(restored!, doc), "页 revision 一致时允许恢复");
  assert(!draftMatchesDocument(restored!, makeDocument(4)), "服务端 revision 变了必须丢弃");
  assert(!draftMatchesDocument(restored!, { ...doc, pages: [...doc.pages, doc.pages[0]] } as CorrectionDocument),
    "页数变化必须丢弃");

  // 老师把考号清空也是有效草稿状态，空串不能被当成「没有手输」丢掉。
  assert.equal(writeCorrectionDraft(cardId, sessionId, groupId, doc, edits, ""), true);
  assert.equal(readCorrectionDraft(cardId, sessionId, groupId)?.typed, "", "空考号也要原样恢复");

  clearCorrectionDraft(cardId, sessionId, groupId);
  assert.equal(readCorrectionDraft(cardId, sessionId, groupId), null, "清除后不能再恢复");

  // 配额满/隐私模式：写入失败必须返回 false，界面才能提示「本机草稿未保存」。
  (localStorage as unknown as MemoryStorage).failWrites = true;
  assert.equal(writeCorrectionDraft(cardId, sessionId, groupId, doc, edits), false, "写入失败返回 false");
  (localStorage as unknown as MemoryStorage).failWrites = false;

  // 损坏的 JSON 不能把页面卡死，读取时应直接当无草稿。
  localStorage.setItem("projectx-correction-draft/v1/card-1/session-1/group-1", "{not-json");
  assert.equal(readCorrectionDraft(cardId, sessionId, groupId), null, "损坏草稿按不存在处理");
  console.log("  ✓ 订正草稿：恢复 / revision 与页数校验 / 清除 / 损坏容错");
}

function testPostprocessResume(): void {
  const cardId = "card-1";
  const sessions = [{ sessionId: "s1", pageCount: 2 }, { sessionId: "s2", pageCount: 1 }];
  writePostprocessSessions(cardId, sessions, 7);
  assert.deepEqual(readPostprocessSessions(cardId, 7), sessions, "会话列表按卡恢复");
  assert.deepEqual(readPostprocessSessions(cardId, 8), [], "换账号不恢复别人的会话列表");
  // 扫描机多人共用：同一张卡被另一个账号打开过，也不能把前一个人的恢复入口顶掉。
  writePostprocessSessions(cardId, [{ sessionId: "s9", pageCount: 1 }], 8);
  assert.deepEqual(readPostprocessSessions(cardId, 7), sessions, "另一个账号写同一张卡不能顶掉我的会话列表");
  assert.deepEqual(readPostprocessSessions(cardId, 8), [{ sessionId: "s9", pageCount: 1 }], "各自的列表互不覆盖");

  writeActivePostprocess(cardId, "高一语文", 7);
  const active = readActivePostprocess(7);
  assert(active?.cardId === cardId && active.cardTitle === "高一语文" && active.userId === 7,
    "活动卡号、标题与账号一起恢复");
  // 同机换账号：B 的活动卡不覆盖 A 的，B 登录/离开也不能删掉 A 的恢复入口。
  assert.equal(readActivePostprocess(8), null, "换账号读不到别人的活动卡");
  writeActivePostprocess("card-2", "高二数学", 8);
  assert.equal(readActivePostprocess(7)?.cardId, cardId, "另一个账号写活动卡不覆盖我的");
  clearActivePostprocess(8);
  assert.equal(readActivePostprocess(8), null, "清掉自己的活动卡");
  assert.equal(readActivePostprocess(7)?.cardId, cardId, "清自己的活动卡不影响别人");
  clearActivePostprocess(7);
  assert.equal(readActivePostprocess(7), null, "正常离开后清掉活动卡");

  writePostprocessView(cardId, { view: "correction", sessionId: "s1", groupId: "0" }, 7);
  assert.deepEqual(readPostprocessView(cardId, 7), { view: "correction", sessionId: "s1", groupId: "0" },
    "上次停留的组与视图恢复");
  writePostprocessView(cardId, { view: "queue", sessionId: "s9", groupId: "1" }, 8);
  assert.deepEqual(readPostprocessView(cardId, 7), { view: "correction", sessionId: "s1", groupId: "0" },
    "另一个账号打开同一张卡不能改掉我的停留位置");
  assert.deepEqual(readPostprocessView(cardId, 8), { view: "queue", sessionId: "s9", groupId: "1" }, "各看各的停留位置");
  clearPostprocessView(cardId, 7);
  assert.equal(readPostprocessView(cardId, 7), null, "正常离开后清掉停留位置");
  assert.ok(readPostprocessView(cardId, 8), "清自己的停留位置不影响别人");
  clearPostprocessView(cardId, 8);

  // 返回卡片列表后落盘认「刚才那张卡」，但只限同一账号，避免把上一个账号的卡写进新账号槽位。
  assert.equal(resolvePersistCardId("card-1", { userId: 7, cardId: "card-0" }, 7), "card-1", "有当前选择就用当前选择");
  assert.equal(resolvePersistCardId("", { userId: 7, cardId: "card-0" }, 7), "card-0", "选择已清空时用刚才那张卡");
  assert.equal(resolvePersistCardId("", { userId: 7, cardId: "card-0" }, 8), "", "换账号不能认上一个账号的卡");
  assert.equal(resolvePersistCardId("", null, 7), "", "没有历史选择时不写");
  assert.equal(resolvePersistCardId("", { userId: 7, cardId: "card-0" }, null), "", "未登录不写");
  console.log("  ✓ 后处理续接：会话列表 / 活动卡 / 停留视图 / 正常离开清理");
}

const requireCjs = createRequire(import.meta.url);
const { PORT_LADDER_STEPS, isPortFree, pickLocalPort } = requireCjs("../electron/local-server-port.cjs") as {
  PORT_LADDER_STEPS: number;
  isPortFree: (port: number) => Promise<boolean>;
  pickLocalPort: (preferredPort: number, log?: (message: string) => void) => Promise<number>;
};

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => resolve(server));
    server.listen(port, "127.0.0.1");
  });
}

/** 找一段连续空端口，别让 CI 机器上碰巧占用的端口把这条回归带崩。 */
async function findFreeRun(length: number, start = 25000): Promise<number> {
  for (let base = start; base < start + 4000; base += length + 1) {
    let free = true;
    for (let offset = 0; offset < length && free; offset += 1) free = await isPortFree(base + offset);
    if (free) return base;
  }
  throw new Error(`找不到 ${length} 个连续空端口`);
}

async function testStableOriginPort(): Promise<void> {
  const ladderSize = PORT_LADDER_STEPS + 1;
  const base = await findFreeRun(ladderSize);
  const held: net.Server[] = [];
  try {
    assert.equal(await isPortFree(base), true, "空端口要判成可用");
    held.push(await occupy(base), await occupy(base + 1));
    assert.equal(await isPortFree(base), false, "已被占用的端口要判成不可用");

    const notices: string[] = [];
    const chosen = await pickLocalPort(base, message => notices.push(message));
    assert.equal(chosen, base + 2, "首选端口被占时沿固定阶梯往下走，不是直接交给系统随机分配");
    assert.equal(notices.length, 2, "每个被跳过的端口都要留一条日志，现场才查得到为什么换了端口");
    assert.equal(await pickLocalPort(base), chosen, "同样的占用情况每次落在同一个端口，页面 origin 才稳定");

    for (let offset = 2; offset < ladderSize; offset += 1) held.push(await occupy(base + offset));
    assert.equal(await pickLocalPort(base), 0, "整段阶梯都被占才回退到系统分配");
  } finally {
    await Promise.all(held.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
  console.log("  ✓ 内嵌服务端口：固定阶梯 / origin 稳定 / 整段被占才随机");
}

testCorrectionDraft();
testPostprocessResume();
await testStableOriginPort();
console.log("PASS scanner-recovery");
