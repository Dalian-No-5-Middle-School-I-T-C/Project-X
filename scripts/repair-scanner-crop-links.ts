/** Image ownership repair only. Default is a dry run. Stop writers and back up
 * the database before --apply; the audit directory must be private. */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getMysqlDb, resetAdapter, type DbAdapter } from "../src/server/db/mysql";
import { linkSavedScannerCrops } from "../src/server/services/scannerSubmissions";
import type { ScanBatchPage } from "../src/shared/scanPages";

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const examId = Number(arg("exam-id"));
const sessionId = arg("session-id");
const expectedCount = Number(arg("expected-count"));
const auditDir = arg("audit-dir");
assert(Number.isSafeInteger(examId) && examId > 0);
assert(sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId));
assert(Number.isSafeInteger(expectedCount) && expectedCount >= 0);
assert(auditDir && path.isAbsolute(auditDir));
await mkdir(auditDir, { recursive: true, mode: 0o700 });
const apply = process.argv.includes("--apply");
const db = getMysqlDb();
assert.equal(db.dialect, "mariadb", "Run production repair against the explicit MariaDB configuration");
type Receipt = {
  exam_id: number; session_id: string; group_id: string; student_number: string;
  state: string; previously_saved: number; pages_json: string;
  result_json: string | null; score_snapshot: string | null;
};
type Crop = { id: string; card_id: string; exam_id: number | null; student_id: number | null; image_path: string; [key: string]: unknown };
const stable = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
const protectedTables = ["student_scores", "question_scores", "exams", "scanner_submissions", "twain_scan_records", "twain_student_grading_results", "exam_publish_events"];
const snapshot = async (tx: DbAdapter) => Object.fromEntries(await Promise.all(protectedTables.map(async name => [name, stable(await tx.all(`SELECT * FROM ${name}`))])));
async function plan(tx: DbAdapter) {
  const exam = await tx.get<{ card_id: string }>("SELECT card_id FROM exams WHERE id=?", examId);
  assert(exam?.card_id);
  const receipts = await tx.all<Receipt>("SELECT * FROM scanner_submissions WHERE exam_id=? AND session_id=? AND state='saved' ORDER BY group_id", examId, sessionId);
  const changes: Array<{ cropId: string; studentId: number; receipt: Receipt }> = [];
  const seen = new Set<string>();
  for (const receipt of receipts) {
    assert(receipt.result_json, "Saved receipt must retain its recognition evidence");
    const user = await tx.get<{ id: number }>("SELECT id FROM users WHERE student_number=?", receipt.student_number);
    assert(user);
    assert(await tx.get("SELECT id FROM student_scores WHERE exam_id=? AND student_id=?", examId, user.id));
    const pages = JSON.parse(receipt.pages_json) as ScanBatchPage[];
    assert(pages.length > 0);
    for (const page of pages) {
      const source = await tx.get<{ image_path: string; card_id: string; session_id: string; student_id: string }>("SELECT image_path,card_id,session_id,student_id FROM twain_scan_records WHERE id=?", page.recordId);
      assert(source && source.card_id === exam.card_id && source.session_id === sessionId && source.student_id === receipt.student_number);
      await access(source.image_path, constants.R_OK);
      const crops = await tx.all<Crop>("SELECT * FROM answer_block_crops WHERE source_type='twain_scan_record' AND source_record_id=?", page.recordId);
      assert(crops.length > 0, "Source crop missing; stop instead of guessing a replacement");
      for (const crop of crops) {
        assert.equal(crop.card_id, exam.card_id);
        await access(crop.image_path, constants.R_OK);
        if (Number(crop.exam_id) === examId && Number(crop.student_id) === Number(user.id)) continue;
        assert(crop.exam_id === null && crop.student_id === null, "Existing ownership must not be replaced");
        assert(!seen.has(crop.id), "Multiple saved receipts claim one crop");
        seen.add(crop.id);
        changes.push({ cropId: crop.id, studentId: Number(user.id), receipt });
      }
    }
  }
  assert.equal(changes.length, expectedCount, "Repair count changed; inspect the current state before applying");
  return { cardId: exam.card_id, changes };
}
try {
  const initialPlan = await plan(db);
  const auditPath = path.join(auditDir, `scanner-crop-links-${Date.now()}.json`);
  if (apply) await db.transaction(async tx => {
    await tx.run("UPDATE exams SET id=id WHERE id=?", examId);
    const currentPlan = await plan(tx);
    assert.deepEqual(currentPlan, initialPlan, "Plan changed while acquiring the transaction");
    const before = await snapshot(tx);
    const cropsBefore = await tx.all<Crop>("SELECT * FROM answer_block_crops");
    await writeFile(auditPath, JSON.stringify({ apply, examId, sessionId, plan: currentPlan, before, cropsBefore }, null, 2), { mode: 0o600 });
    const receipts = new Map(currentPlan.changes.map(c => [c.receipt.group_id, c.receipt]));
    for (const receipt of receipts.values()) await linkSavedScannerCrops(tx, currentPlan.cardId, receipt);
    const after = await snapshot(tx);
    assert.deepEqual(after, before, "Image repair must not change scores, publication, receipts or recognition");
    const targets = new Map(currentPlan.changes.map(c => [c.cropId, c.studentId]));
    const expectedCrops = cropsBefore.map(c => targets.has(c.id) ? { ...c, exam_id: examId, student_id: targets.get(c.id) } : c);
    assert.deepEqual(stable(await tx.all("SELECT * FROM answer_block_crops")), stable(expectedCrops), "Only the planned ownership fields may change");
    await writeFile(auditPath, JSON.stringify({ apply, examId, sessionId, plan: currentPlan, before, after, cropsBefore, verified: true }, null, 2), { mode: 0o600 });
  });
  else await writeFile(auditPath, JSON.stringify({ apply, examId, sessionId, plan: initialPlan }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ apply, examId, sessionId, changedCrops: initialPlan.changes.length, protectedTables, auditPath,
    planSha256: createHash("sha256").update(JSON.stringify(initialPlan)).digest("hex") }));
} finally { await resetAdapter(); }
