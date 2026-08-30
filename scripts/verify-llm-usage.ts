/**
 * LLM 用量采集 + 多模态能力判定回归测试。
 * 运行：npx tsx scripts/verify-llm-usage.ts（任一断言失败时非零退出）
 */
import assert from "node:assert/strict";
import { parseUsagePayload } from "../src/apps/answer-card/server/llm-usage";
import { isVisionProvider } from "../src/apps/answer-card/server/llm-capabilities";

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

testParseUsagePayload();
testIsVisionProvider();
console.log("verify:llm-usage OK");
