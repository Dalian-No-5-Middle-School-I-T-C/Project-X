import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const state = JSON.parse(await readFile("data/e2e-business/state.json", "utf8"));
const evidence = JSON.parse(await readFile("data/e2e-business/业务验证结果.json", "utf8"));
const base = state.base;
assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
let token = "";
async function call(route: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); assert(res.ok, `${route}: ${res.status} ${text.slice(0,600)}`);
  return text ? JSON.parse(text) : null;
}
token = (await call("/api/auth/login", "POST", { identifier: "admin", password: "E2e-Local-2026!" })).token;
const sid = evidence.students[3].id;
await call(`/api/exams/${state.examId}/student/${sid}/scores`, "PUT", { scores: [{ questionNumber: 4, scoreType: "objective", score: 5 }] });
let students = await call(`/api/analysis/exams/${state.examId}/students`);
assert.deepEqual(students.map((s: any) => s.totalScore), [20,15,10,10]);
assert.deepEqual(students.map((s: any) => s.rank), [1,2,3,3]);
await call(`/api/exams/${state.examId}/student/${sid}/scores`, "PUT", { scores: [{ questionNumber: 4, scoreType: "objective", score: 0 }] });
students = await call(`/api/analysis/exams/${state.examId}/students`);
assert.deepEqual(students.map((s: any) => s.totalScore), [20,15,10,5]);
console.log("PASS manual correction, tied rankings, cache invalidation and restoring scores");
await call(`/api/exams/${state.examId}/publish`, "POST");
const csv = await fetch(`${base}/api/analysis/exams/${state.examId}/export-csv`, { headers: { Authorization: `Bearer ${token}` } });
assert(csv.ok); await writeFile("data/e2e-business/成绩导出.csv", await csv.text());
const studentNumber = students[0].studentNumber;
const auth = await call("/api/auth/login", "POST", { identifier: studentNumber, password: "E2e-Local-2026!" });
token = auth.token;
if (auth.passwordChangeRequired) {
  await call("/api/auth/change-password", "POST", { oldPassword: "E2e-Local-2026!", newPassword: "E2e-Student-2026!" });
  token = (await call("/api/auth/login", "POST", { identifier: studentNumber, password: "E2e-Student-2026!" })).token;
}
const detail = await call(`/api/scores/me/exams/${state.examId}`);
await call("/api/scores/me/trends");
await call("/api/scores/me/subject-comparison");
await writeFile("data/e2e-business/学生查分验证.json", JSON.stringify(detail, null, 2));
console.log("PASS closing/publishing, CSV export, student login, score detail and trends");
