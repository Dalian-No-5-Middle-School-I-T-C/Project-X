/**
 * LLM 用量采集 + 多模态能力判定回归测试。
 * 运行：npx tsx scripts/verify-llm-usage.ts（任一断言失败时非零退出）
 */
import assert from "node:assert/strict";
import { parseUsagePayload } from "../src/apps/answer-card/server/llm-usage";
import { isVisionProvider, resolveKnowledgePointMode } from "../src/apps/answer-card/server/llm-capabilities";
import { sanitizeForwardHeaders } from "../src/apps/answer-card/server/llm-client";

function testParseUsagePayload() {
  assert.deepEqual(
    parseUsagePayload({ usage: { tokensIn: 12, tokensOut: 34 } }),
    { tokensIn: 12, tokensOut: 34 }
  );
  assert.equal(parseUsagePayload({}), null);
  assert.equal(parseUsagePayload({ usage: {} }), null);
  assert.equal(parseUsagePayload(null), null);
  assert.equal(parseUsagePayload({ usage: { tokensIn: "x", tokensOut: 1 } }), null);
}

function testIsVisionProvider() {
  assert.equal(isVisionProvider("gemini", "gemini-3.5-flash"), true);
  assert.equal(isVisionProvider("openai", "gpt-5.5"), true);
  assert.equal(isVisionProvider("deepseek", "deepseek-v4-flash-vision-exp"), true);
  assert.equal(isVisionProvider("deepseek", "deepseek-v4-flash"), false);
  assert.equal(isVisionProvider("deepseek", null), false);
}

function testResolveKnowledgePointMode() {
  assert.equal(resolveKnowledgePointMode(true), "direct");
  assert.equal(resolveKnowledgePointMode(false), "text");
}

function testSanitizeForwardHeaders() {
  const headers = new Headers();
  headers.set("content-length", "7");
  headers.set("content-encoding", "gzip");
  headers.set("content-type", "application/json");
  headers.set("x-custom", "keep");
  const out = sanitizeForwardHeaders(headers);
  assert.equal(out.has("content-length"), false);
  assert.equal(out.has("content-encoding"), false);
  assert.equal(out.get("content-type"), "application/json");
  assert.equal(out.get("x-custom"), "keep");
}

testParseUsagePayload();
testIsVisionProvider();
testResolveKnowledgePointMode();
testSanitizeForwardHeaders();
console.log("verify:llm-usage OK");
