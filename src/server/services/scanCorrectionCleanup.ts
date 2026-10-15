import type { DbAdapter } from "../db";

/** Remove polymorphic snapshots before the exam's scan records cascade away. */
export async function deleteExamCorrectionPages(db: DbAdapter, examId: number): Promise<void> {
  await db.run(`DELETE FROM scan_correction_pages WHERE source_type='scan_record' AND source_id IN (
    SELECT r.id FROM scan_records r JOIN scan_batches b ON b.id=r.batch_id WHERE b.exam_id=?
  )`, examId);
}
