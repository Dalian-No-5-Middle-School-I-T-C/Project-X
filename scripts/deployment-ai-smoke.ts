import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const state = JSON.parse(await readFile("data/e2e-business/state.json", "utf8"));
const base = state.base;
assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identifier: "admin", password: "E2e-Local-2026!" }) });
assert(login.ok);
const { token } = await login.json() as any;
async function request(route: string, body?: unknown) {
  const res = await fetch(base + route, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json() as any;
  assert(res.ok, `${route}: ${res.status} ${JSON.stringify(data).slice(0,500)}`);
  return data;
}
const status = await request("/api/analysis/ai/status");
console.log("AI readiness", JSON.stringify({ available: status.available, reason: status.reason, defaultModel: status.defaultModel,
  models: status.models?.map((m: any) => ({ id: m.id, available: m.available })) }));
assert(status.available, "AI is unavailable");
const model = process.env.E2E_AI_MODEL || status.models.find((m: any) => m.available && m.id === "deepseek-v4-flash")?.id || status.defaultModel;
const job = await request(`/api/analysis/exams/${state.examId}/ai-analysis`, { model });
console.log("AI task created", job.jobId, model);
const started = Date.now();
while (Date.now() - started < 300_000) {
  const result = await request(`/api/analysis/ai-analysis/jobs/${job.jobId}`);
  if (["completed", "succeeded", "done", "failed", "error"].includes(result.status)) {
    await writeFile("data/e2e-business/AI验证结果.json", JSON.stringify(result, null, 2));
    console.log("AI terminal state", result.status, "elapsed seconds", Math.round((Date.now()-started)/1000));
    assert(!["failed", "error"].includes(result.status), JSON.stringify(result).slice(0,1000));
    assert(result.result?.report?.overallJudgement?.trim(), "AI report has no overall judgement");
    assert(result.result?.report?.distributionInsight?.trim(), "AI report has no distribution insight");
    break;
  }
  await new Promise(r => setTimeout(r, 2000));
  assert(Date.now()-started < 300_000, "AI task timed out");
}
