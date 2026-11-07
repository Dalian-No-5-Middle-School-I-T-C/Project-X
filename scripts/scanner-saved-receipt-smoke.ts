import assert from "node:assert/strict";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";

const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import("../src/server/db");
  const db = getMysqlDb();
  if (db.dialect === "mariadb") {
    // Historical installations may use different collations for these columns.
    await db.exec("ALTER TABLE users MODIFY student_number VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL");
    await db.exec("ALTER TABLE scanner_submissions MODIFY student_number VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL");
    // The project database defaults to unicode_ci while the TWAIN table uses
    // general_ci. Exercise that configuration even when the test DB uses defaults.
    await db.exec("ALTER TABLE scan_correction_pages MODIFY source_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL");
  }
  await db.run("UPDATE users SET student_number = 'ABC001' WHERE student_number = '91001'");
  const owner = (await db.get<{ id: number }>("SELECT id FROM users WHERE student_number = 'ABC001'"))!;
  const request = (url: string, init?: RequestInit) => fetch(`${fixture.baseUrl}/api/scanner/upload${url}`, {
    ...init, headers: { ...init?.headers, "X-Api-Key": info.key },
  });
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  async function upload(studentId: string) {
    const created = await request("/sessions", json({ cardId: info.cardId, cardVersion: info.version, pageCount: 1, name: "saved-receipt" }));
    assert.equal(created.status, 201);
    const { sessionId, uploadTokens } = await created.json();
    const form = new FormData();
    form.append("image", new Blob([Buffer.from(info.images.original, "base64")], { type: "image/png" }), "page.png");
    form.append("token", uploadTokens[0]); form.append("pageNum", "1"); form.append("side", "front");
    form.append("recognition", JSON.stringify({ status: "ok", studentId: { status: "ok", value: studentId }, pageNumber: 1,
      identity: { status: "verified", code: "QR_VERIFIED", cardId: info.cardId, pageNumber: 1 },
      geometry: { imageWidth: 24, imageHeight: 24, imageToLayout: [1,0,0,0,1,0,0,0,1], layoutToImage: [1,0,0,0,1,0,0,0,1] },
      questions: [{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }], subjectiveQuestions: [],
    }));
    assert.equal((await request(`/sessions/${sessionId}/pages`, { method: "POST", body: form })).status, 200);
    return sessionId as string;
  }
  const sessionId = await upload(db.dialect === "mariadb" ? "abc001" : "ABC001");
  const complete = () => request(`/sessions/${sessionId}/complete`, json({ cardVersion: info.version }));
  const first = await complete();
  assert.equal(first.status, 200, await first.clone().text());
  const response = await request(`/sessions/${sessionId}/results`);
  assert.equal(response.status, 200, await response.clone().text());
  const batch = await response.json();
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].saved, true, "receipt lookup must use the database's student-number comparison");
  await db.run("UPDATE student_scores SET total_score = 3, objective_score = 3, manually_modified = 1 WHERE student_id = ?", owner.id);
  await db.run("UPDATE question_scores SET score = 3, manually_modified = 1 WHERE student_id = ?", owner.id);
  assert.equal((await complete()).status, 200);
  const score = (await db.get<{ total_score: number; manually_modified: number }>("SELECT total_score, manually_modified FROM student_scores WHERE student_id = ?", owner.id))!;
  assert.equal(Number(score.total_score), 3, "completion retry must preserve the teacher's score");
  assert.equal(Number(score.manually_modified), 1);
  assert.equal(Number((await db.get<{ score: number }>("SELECT score FROM question_scores WHERE student_id = ?", owner.id))!.score), 3);
  if (db.dialect === "sqlite") {
    const wrongCase = await upload("abc001");
    assert.equal((await request(`/sessions/${wrongCase}/complete`, json({ cardVersion: info.version }))).status, 409,
      "SQLite's case-sensitive student-number matching must be preserved");
  }
  console.log(`PASS saved receipt (${db.dialect}): database collation, saved preview and idempotent completion preserve teacher scores`);
} finally { await fixture.close(); }
