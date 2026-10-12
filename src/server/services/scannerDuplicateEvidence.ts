import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DbAdapter } from "../db/mysql";
import type { ScanBatchPage } from "../../shared/scanPages";

/** Equal answers alone cannot establish that two attempts came from the same paper. */
export async function scannerDuplicateEvidence(db: DbAdapter, sessionId: string,
  studentNumber: string, pages: Pick<ScanBatchPage, "recordId" | "layoutPage">[]): Promise<string[] | null> {
  if (!pages.length) return null;
  const hashes: string[] = [];
  for (const page of [...pages].sort((a, b) => a.layoutPage - b.layoutPage)) {
    const record = await db.get<{ image_path: string; student_id: string; identity_json: string | null;
      objective_json: string | null; subjective_json: string | null; grade_status: string }>(
      `SELECT r.image_path,r.student_id,r.identity_json,g.objective_json,g.subjective_json,g.grade_status
       FROM twain_scan_records r JOIN twain_recognition_results g ON g.scan_record_id=r.id
       WHERE r.id=? AND r.session_id=?`, page.recordId, sessionId);
    if (!record || record.student_id !== studentNumber || !["done", "recognized"].includes(record.grade_status)) return null;
    try {
      const imageHash = createHash("sha256").update(await readFile(record.image_path)).digest("hex");
      hashes.push(createHash("sha256").update(JSON.stringify([page.layoutPage, imageHash,
        record.student_id, record.identity_json, record.objective_json, record.subjective_json, record.grade_status])).digest("hex"));
    } catch { return null; }
  }
  return hashes;
}
