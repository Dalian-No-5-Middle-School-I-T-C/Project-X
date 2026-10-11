/** Review regressions on a disposable real DB: bounded receipt reads and resumable repair. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import type { DbAdapter } from "../src/server/db/mysql";

const repairScript = fileURLToPath(new URL("./repair-scanner-reuploads.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json() as { cardId: string };
  const { getMysqlDb } = await import("../src/server/db");
  const db = getMysqlDb();
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const { processScannerSession } = await import("../src/server/services/scannerSubmissions");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const card = (await new CardRepository().findById(info.cardId))!;
  const exam = (await db.get<{ id: number }>("SELECT id FROM exams WHERE card_id=?", card.id))!;
  for (let index = 1; index < 400; index++) await db.run(
    "INSERT INTO scanner_submissions (exam_id,session_id,group_id,student_number,state,previously_saved,pages_json) VALUES (?,?,? ,?,'saved',1,'[]')",
    exam.id, `prior-${index}`, "0", `990${String(index).padStart(3, "0")}`);
  const session = await store.createSession(card.id, "receipt-budget");
  const record = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: 1, imagePath: "test-original.png" });
  await db.run("UPDATE twain_scan_records SET identity_json=? WHERE id=?", JSON.stringify({ status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 }), record.id);
  await store.updateScanOcrResult(record.id, "91010", 1, "done");
  await store.upsertRecognitionResult({ scanRecordId: record.id, objectiveJson: JSON.stringify([{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }]), subjectiveJson: "[]", gradeStatus: "done" });
  await store.updateSessionStatus(session.id, "completed");
  let receiptReads = 0;
  const originalTransaction = db.transaction.bind(db);
  db.transaction = work => originalTransaction(tx => work(new Proxy(tx, {
    get(target, property) {
      if (property === "all") return (sql: string, ...params: unknown[]) => {
        if (/SELECT \* FROM scanner_submissions WHERE exam_id/.test(sql)) receiptReads++;
        return target.all(sql, ...params);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DbAdapter));
  try {
    assert.equal((await processScannerSession(card, session.id, "save")).results[0].saved, true);
  } finally { db.transaction = originalTransaction; }
  assert(receiptReads <= 6, `400 active receipts must use bounded reads; observed ${receiptReads}`);
  assert.equal(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scanner_submissions WHERE exam_id=? AND state='saved'", exam.id))?.n), 400);

  const ids: number[] = [];
  await db.run("UPDATE exams SET assigned_formula=? WHERE id=?", JSON.stringify({ type: "custom", enabled: true, params: {}, expression: "raw * 2" }), exam.id);
  for (const [index, number] of ["91001", "91002"].entries()) {
    const user = (await db.get<{ id: number }>("SELECT id FROM users WHERE student_number=?", number))!;
    ids.push(user.id);
    const snapshot = JSON.stringify({ score: { objective_score: 4, subjective_score: 0, total_score: 4, assigned_score: 81 + index, manually_modified: 1 }, questions: [] });
    await db.run("INSERT INTO scanner_submissions (exam_id,session_id,group_id,student_number,state,previously_saved,pages_json,score_snapshot) VALUES (?,?,?,?,?,1,'[]',?)",
      exam.id, `legacy:${exam.id}`, `resume-${index}`, number, index === 0 ? "pending" : "conflict", snapshot);
  }
  await db.run("DELETE FROM exam_participants WHERE exam_id=? AND student_id=?", exam.id, ids[0]);
  const auditDir = await mkdtemp(path.join(tmpdir(), "projectx-review-audit-"));
  async function runRepair() {
    return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, repairScript, "--apply", `--audit-dir=${auditDir}`], { env: process.env });
      let output = "";
      child.stdout.on("data", data => { output += String(data); });
      child.stderr.on("data", data => { output += String(data); });
      child.on("error", reject);
      child.on("close", code => resolve({ code, output }));
    });
  }
  const failed = await runRepair();
  assert.notEqual(failed.code, 0, "Out-of-roster snapshot must stop repair with a real error");
  assert.match(failed.output, /应考名单/);
  assert.equal((await db.get<{ state: string }>("SELECT state FROM scanner_submissions WHERE session_id=? AND group_id='resume-0'", `legacy:${exam.id}`))?.state, "pending");
  assert.equal((await db.get<{ state: string }>("SELECT state FROM scanner_submissions WHERE session_id=? AND group_id='resume-1'", `legacy:${exam.id}`))?.state, "conflict", "Unprocessed restore keeps its eligible state");
  await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.id, ids[0]);
  const resumed = await runRepair();
  assert.equal(resumed.code, 0, resumed.output);
  for (const [index, id] of ids.entries()) {
    const score = await db.get<{ total_score: number; assigned_score: number }>("SELECT total_score,assigned_score FROM student_scores WHERE exam_id=? AND student_id=?", exam.id, id);
    assert.equal(Number(score?.total_score), 4);
    assert.equal(Number(score?.assigned_score), 81 + index);
    assert.equal((await db.get<{ state: string }>("SELECT state FROM scanner_submissions WHERE session_id=? AND group_id=?", `legacy:${exam.id}`, `resume-${index}`))?.state, "saved");
  }
  assert.equal((await runRepair()).code, 0, "Replaying a completed repair is harmless");
  console.log(`PASS scanner review (${db.dialect}): 400 receipts / ${receiptReads} locked receipt reads; interrupted repair resumes pending/conflict snapshots and assigned scores`);
} finally { await fixture.close(); }
