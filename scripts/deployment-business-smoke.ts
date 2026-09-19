/** Run against an isolated local deployment; never points at production. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AnswerCard, LayoutDocument } from "../src/shared/types";

const base = process.env.E2E_SERVER_URL || "http://127.0.0.1:5187";
const local = process.env.E2E_SCANNER_URL || "http://127.0.0.1:5186";
for (const url of [base, local]) assert(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Only isolated loopback deployments are supported");
const out = path.resolve("data/e2e-business");
await mkdir(out, { recursive: true });
const password = "E2e-Local-2026!";
const tokens = new Map<string, string>();
async function request(root: string, route: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(root + route, { method,
    headers: { ...(tokens.has(root) ? { Authorization: `Bearer ${tokens.get(root)}` } : {}),
      ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  assert(response.ok, `${method} ${route}: ${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
async function login(root: string) {
  const initial = process.env.E2E_INITIAL_PASSWORD || "admin123";
  let response = await fetch(root + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "admin", password }) });
  if (!response.ok) response = await fetch(root + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "admin", password: initial }) });
  assert(response.ok, "Test admin login failed");
  const data = await response.json() as any;
  tokens.set(root, data.token);
  if (data.passwordChangeRequired) {
    await request(root, "/api/auth/change-password", "POST", { oldPassword: initial, newPassword: password });
    const fresh = await request(root, "/api/auth/login", "POST", { identifier: "admin", password });
    tokens.set(root, fresh.token);
  }
}
await login(base);
await login(local);
const health = await request(base, "/api/app/health");
assert(health.ok, "Deployment health check failed");
console.log("PASS deployment health");
const stamp = Date.now().toString().slice(-7);
await request(base, "/api/system-settings", "PUT", { settings: { require_original_paper: "0", e2e_marker: stamp } });
assert.equal((await request(base, "/api/system-settings")).data.e2e_marker, stamp);
const thresholds = await request(base, "/api/analysis/config/thresholds");
await request(base, "/api/analysis/config/thresholds", "PUT", thresholds);
console.log("PASS global settings and analysis thresholds save/read");
const grade = await request(base, "/api/classes/grades", "POST", { name: `部署测试${stamp}` });
const cls = await request(base, "/api/classes", "POST", { gradeId: grade.id, name: "一班" });
const cls2 = await request(base, "/api/classes", "POST", { gradeId: grade.id, name: "二班" });
const students: any[] = [];
for (let i = 0; i < 4; i++) {
  students.push(await request(base, "/api/users", "POST", { username: `e2e_${stamp}_${i}`, name: `测试学生${i + 1}`,
    password, role: "student", student_number: `${stamp}${i}`.slice(-5) }));
}
await request(base, `/api/classes/${cls.id}/students`, "POST", { studentIds: students.slice(0, 2).map(s => s.id) });
await request(base, `/api/classes/${cls2.id}/students`, "POST", { studentIds: students.slice(2).map(s => s.id) });
let card: AnswerCard = await request(base, "/api/cards", "POST", { subject: "math", title: `部署闭环${stamp}`, examDate: "2026-09-05" });
card.sided = "single";
card.bodyBlocks = [{ id: `e2e_objective_${stamp}`, type: "objective", title: "选择题", questionStart: 1, questionCount: 4,
  optionCount: 4, mode: "single", scorePerQuestion: 5, density: "compact", answerKey: { "1": ["A"], "2": ["A"], "3": ["A"], "4": ["A"] },
  questions: [1,2,3,4].map(questionNumber => ({ questionNumber, mode: "single", optionCount: 4, score: 5, correctOptions: ["A"] })) }];
card = await request(base, `/api/cards/${card.id}`, "PUT", card);
const exam = await request(base, "/api/exams", "POST", { name: card.title, cardId: card.id, gradeId: grade.id, subject: "math", mode: "quiz" });
await request(base, `/api/exams/${exam.id}/participants`, "PUT", { studentIds: students.map(s => s.id) });
const synced = await request(base, `/api/scanner/sync/cards/${card.id}`);
await request(local, `/api/cards/${card.id}`, "PUT", synced);
const layout: LayoutDocument = await request(base, `/api/cards/${card.id}/layout`);
const pdf = await fetch(`${base}/api/cards/${card.id}/pdf`, { headers: { Authorization: `Bearer ${tokens.get(base)}` } });
assert(pdf.ok, `PDF export ${pdf.status}`);
await writeFile(path.join(out, "答题卡.pdf"), Buffer.from(await pdf.arrayBuffer()));
console.log("PASS card creation/edit, roster, scanner sync, PDF export");
const session = await request(base, "/api/scanner/upload/sessions", "POST", { cardId: card.id, pageCount: students.length, dpi: 300 });
const rect = (r: any, fill: string) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${fill}" stroke="#111" stroke-width="0.18"/>`;
for (let i = 0; i < students.length; i++) {
  const page = layout.pages[0];
  const studentNumber = students[i].student_number;
  const marks = page.markers.map(m => rect(m.rect, "#000")).join("");
  const digits = (page.studentArea?.digitCells || []).map(c => rect(c.rect, Number(studentNumber[c.digitIndex]) === c.digit ? "#000" : "#fff")).join("");
  const choices = page.blocks.flatMap(b => b.type === "objective" ? b.items : []).flatMap((q, qi) => q.options.map(o => rect(o.rect, o.label === (qi < 4 - i ? "A" : "B") ? "#000" : "#fff"))).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}"><rect width="100%" height="100%" fill="white"/>${marks}${digits}${choices}</svg>`;
  const image = await sharp(Buffer.from(svg)).resize(Math.round(page.width / 25.4 * 300), Math.round(page.height / 25.4 * 300)).png().toBuffer();
  await writeFile(path.join(out, `填涂答题卡${i + 1}.png`), image);
  const form = new FormData(); form.append("file", new Blob([new Uint8Array(image)], { type: "image/png" }), "sheet.png");
  form.append("includeCrops", "1");
  const recognition = await request(local, `/api/cards/${card.id}/recognition`, "POST", form);
  assert.equal(recognition.studentId.value, studentNumber, "Native student recognition");
  assert.equal(recognition.questions.length, 4);
  const upload = new FormData(); upload.append("image", new Blob([new Uint8Array(image)], { type: "image/png" }), "sheet.png");
  upload.append("token", session.uploadTokens[i]); upload.append("pageNum", String(i + 1)); upload.append("side", "front");
  upload.append("recognition", JSON.stringify(recognition));
  await request(base, `/api/scanner/upload/sessions/${session.sessionId}/pages`, "POST", upload);
  assert(recognition.cropImages?.length > 0, "Native crop output");
  const cropForm = new FormData();
  const manifest = recognition.cropImages.map(({ dataBase64, ...crop }: any, index: number) => {
    const fileName = `crop_${index}.png`;
    cropForm.append("crops", new Blob([new Uint8Array(Buffer.from(dataBase64, "base64"))], { type: "image/png" }), fileName);
    return { ...crop, fileName };
  });
  cropForm.append("manifest", JSON.stringify(manifest));
  const saved = await request(base, `/api/scanner/upload/sessions/${session.sessionId}/pages/${session.uploadTokens[i]}/crops`, "POST", cropForm);
  assert.equal(saved.count, manifest.length);
}
await request(base, `/api/scanner/upload/sessions/${session.sessionId}/complete`, "POST");
await request(base, `/api/scanner/upload/sessions/${session.sessionId}/complete`, "POST");
const completed = await request(base, `/api/scanner/upload/sessions/${session.sessionId}/status`);
assert.equal(completed.progress.recognized, students.length);
console.log("PASS native OMR, image/results upload, idempotent completion");
const analysis: Record<string, any> = {};
for (const endpoint of ["overview", "students", "score-table", "questions", "distribution", "metrics", "class-comparison", "option-analysis", "comparable"]) {
  analysis[endpoint] = await request(base, `/api/analysis/exams/${exam.id}/${endpoint}${endpoint === "class-comparison" ? "?all=1" : ""}`);
  console.log(`PASS analysis ${endpoint}`);
}
const cross = await request(base, "/api/analysis/cross-exam/total", "POST", { mode: "selected", examIds: [exam.id] });
assert.deepEqual(analysis.students.map((s: any) => s.totalScore), [20, 15, 10, 5]);
assert.equal(cross.summary.avgTotalScore, 12.5);
assert.equal(cross.summary.totalFullScore, 20);
const group = await request(base, "/api/exam-groups", "POST", { name: `联考${stamp}`, grade_id: grade.id, examIds: [exam.id] });
for (const endpoint of ["overview", "metrics", "question-analysis", "distribution", "class-comparison", "rankings"]) {
  await request(base, `/api/exam-groups/${group.id}/${endpoint}`);
  console.log(`PASS exam group ${endpoint}`);
}
await writeFile(path.join(out, "业务验证结果.json"), JSON.stringify({ exam, cardId: card.id, students: students.map(s => ({ id: s.id, name: s.name })), expectedScores: [20,15,10,5], analysis, cross }, null, 2));
await writeFile(path.join(out, "state.json"), JSON.stringify({ examId: exam.id, cardId: card.id, base, local, stamp }));
console.log("PASS cross-exam analysis; evidence written to data/e2e-business");
