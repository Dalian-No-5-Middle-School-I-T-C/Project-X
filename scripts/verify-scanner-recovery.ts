/**
 * 扫描端闪退恢复的本机状态回归：
 *  - 异常卷订正草稿只在页 revision 完全一致时恢复，保存/离开后清掉；
 *  - 后处理会话列表与停留位置可跨重载恢复，正常离开时清掉停留位置。
 *
 * 运行：npx tsx scripts/verify-scanner-recovery.ts
 */
import assert from "node:assert/strict";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
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
  readPostprocessView, writeActivePostprocess, writePostprocessSessions, writePostprocessView,
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

  writeCorrectionDraft(cardId, sessionId, groupId, doc, edits);
  const restored = readCorrectionDraft(cardId, sessionId, groupId);
  assert(restored, "草稿应可读回");
  assert.deepEqual(restored!.edits, edits, "格选与 touched 原样恢复");
  assert(draftMatchesDocument(restored!, doc), "页 revision 一致时允许恢复");
  assert(!draftMatchesDocument(restored!, makeDocument(4)), "服务端 revision 变了必须丢弃");
  assert(!draftMatchesDocument(restored!, { ...doc, pages: [...doc.pages, doc.pages[0]] } as CorrectionDocument),
    "页数变化必须丢弃");

  clearCorrectionDraft(cardId, sessionId, groupId);
  assert.equal(readCorrectionDraft(cardId, sessionId, groupId), null, "清除后不能再恢复");

  // 损坏的 JSON 不能把页面卡死，读取时应直接当无草稿。
  localStorage.setItem("projectx-correction-draft/v1/card-1/session-1/group-1", "{not-json");
  assert.equal(readCorrectionDraft(cardId, sessionId, groupId), null, "损坏草稿按不存在处理");
  console.log("  ✓ 订正草稿：恢复 / revision 与页数校验 / 清除 / 损坏容错");
}

function testPostprocessResume(): void {
  const cardId = "card-1";
  const sessions = [{ sessionId: "s1", pageCount: 2 }, { sessionId: "s2", pageCount: 1 }];
  writePostprocessSessions(cardId, sessions);
  assert.deepEqual(readPostprocessSessions(cardId), sessions, "会话列表按卡恢复");

  writeActivePostprocess(cardId, "高一语文");
  const active = readActivePostprocess();
  assert(active?.cardId === cardId && active.cardTitle === "高一语文", "活动卡号与标题恢复");
  clearActivePostprocess();
  assert.equal(readActivePostprocess(), null, "正常离开后清掉活动卡");

  writePostprocessView(cardId, { view: "correction", sessionId: "s1", groupId: "0" });
  assert.deepEqual(readPostprocessView(cardId), { view: "correction", sessionId: "s1", groupId: "0" },
    "上次停留的组与视图恢复");
  clearPostprocessView(cardId);
  assert.equal(readPostprocessView(cardId), null, "正常离开后清掉停留位置");
  console.log("  ✓ 后处理续接：会话列表 / 活动卡 / 停留视图 / 正常离开清理");
}

testCorrectionDraft();
testPostprocessResume();
console.log("PASS scanner-recovery");
