/** Archive identical reuploads without removing images or guessing student IDs.
 * Dry run is the default. Stop upload writers and back up the database before
 * --apply. The audit directory must be private and outside version control.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getMysqlDb, resetAdapter } from "../src/server/db/mysql";
import { recoverScannerSubmissionSnapshot } from "../src/server/services/scannerSubmissions";
import { scannerDuplicateEvidence } from "../src/server/services/scannerDuplicateEvidence";

interface Receipt {
  exam_id: number; session_id: string; group_id: string; student_number: string;
  state: string; previously_saved: number; pages_json: string;
  result_json: string | null; score_snapshot: string | null;
}
const apply = process.argv.includes("--apply");
const auditArg = process.argv.find(a => a.startsWith("--audit-dir="));
assert(auditArg, "Provide --audit-dir=/absolute/private/path");
const auditDir = auditArg.slice("--audit-dir=".length);
assert(path.isAbsolute(auditDir));
await mkdir(auditDir, { recursive: true, mode: 0o700 });
const db = getMysqlDb();
try {
  const rows = await db.all<Receipt>("SELECT * FROM scanner_submissions WHERE state NOT IN ('superseded','discarded') ORDER BY exam_id,session_id,group_id");
  const sessions = new Map((await db.all<{ id: string; created_at: unknown }>("SELECT id,created_at FROM twain_scan_sessions")).map(s => [s.id, String(s.created_at)]));
  const groups = new Map<string, Receipt[]>();
  const evidence: Array<{ receipt: Receipt; hashes: string[] }> = [];
  for (const row of rows.filter(r => r.state === "conflict")) {
    const pages = JSON.parse(row.pages_json) as Array<{ recordId: string; layoutPage: number }>;
    const hashes = await scannerDuplicateEvidence(db, row.session_id, row.student_number, pages);
    if (!hashes) continue;
    evidence.push({ receipt: row, hashes });
    const key = JSON.stringify([row.exam_id, row.student_number, hashes]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const discard: Receipt[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const originals = group.filter(r => r.previously_saved || r.score_snapshot);
    // More than one independently saved original needs human review.
    if (originals.length > 1) continue;
    const keeper = originals[0] ?? [...group].sort((a, b) => (sessions.get(a.session_id) ?? "").localeCompare(sessions.get(b.session_id) ?? "") || a.session_id.localeCompare(b.session_id) || a.group_id.localeCompare(b.group_id))[0];
    discard.push(...group.filter(r => r !== keeper));
  }
  const discardedKeys = new Set(discard.map(r => JSON.stringify([r.exam_id,r.session_id,r.group_id])));
  const remaining = rows.filter(r => !discardedKeys.has(JSON.stringify([r.exam_id,r.session_id,r.group_id])));
  const recover = remaining.filter(r => (r.state === "conflict" || r.state === "pending") && r.previously_saved && r.score_snapshot
    && remaining.filter(other => other.exam_id === r.exam_id && other.student_number === r.student_number).length === 1);
  const audit = { apply, evidence, discard, recover };
  const auditPath = path.join(auditDir, `scanner-reuploads-${Date.now()}.json`);
  await writeFile(auditPath, JSON.stringify(audit, null, 2), { mode: 0o600 });
  if (apply) {
    await db.transaction(async tx => {
      for (const examId of new Set([...discard, ...recover].map(r => r.exam_id))) await tx.run("UPDATE exams SET id=id WHERE id=?", examId);
      // Validate the entire receipt set before any mutation; an active writer must
      // not turn this plan into a decision on an outdated conflict/snapshot.
      const current = await tx.all<Receipt>("SELECT * FROM scanner_submissions WHERE state NOT IN ('superseded','discarded')");
      const sorted = (records: Receipt[]) => records.map(r => JSON.stringify(r)).sort();
      assert.deepEqual(sorted(current), sorted(rows), "Receipts changed since planning; rerun while upload writers are stopped");
      for (const row of discard) {
        const update = await tx.run("UPDATE scanner_submissions SET state='discarded' WHERE exam_id=? AND session_id=? AND group_id=? AND state='conflict'",
          row.exam_id,row.session_id,row.group_id);
        assert.equal(update.changes, 1);
      }
    });
    // Each restore updates the score and receipt atomically. Interrupted runs
    // retain eligible conflict/pending snapshots for the next invocation.
    for (const row of recover) await recoverScannerSubmissionSnapshot(row.exam_id,row.session_id,row.group_id);
  }
  console.log(JSON.stringify({ apply, discarded: discard.length, restored: recover.length, auditPath }));
} finally { await resetAdapter(); }
