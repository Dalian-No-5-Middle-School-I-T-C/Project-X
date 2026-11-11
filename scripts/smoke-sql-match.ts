/** Whitespace-insensitive SQL shape checks for smoke-test instrumentation hooks. */

export function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Batch load of scan rows joined to session metadata for one session (or sheet range). */
export function isSessionGroupedRecordBatch(sql: string): boolean {
  const c = compactSql(sql).toLowerCase();
  return c.includes("from twain_scan_records r")
    && c.includes("join twain_scan_sessions")
    && c.includes("r.session_id = ?");
}

/** Batch load of OCR rows for all pages in a session (or sheet range). */
export function isSessionGroupedOcrBatch(sql: string): boolean {
  const c = compactSql(sql).toLowerCase();
  return c.includes("from twain_recognition_results o")
    && c.includes("join twain_scan_records r")
    && c.includes("r.session_id = ?");
}

/** Upload path stamp of recognized student id after recognition is stored. */
export function isUploadRecognizedStudentStamp(sql: string): boolean {
  const c = compactSql(sql).toLowerCase();
  return c.startsWith("update twain_scan_records set")
    && c.includes("student_id")
    && c.includes("recognized_at")
    && c.includes("where id = ?");
}

/** Ownership lookup before allowing upload to overwrite saved/discarded receipt evidence. */
export function isSavedReceiptOwnershipLookup(sql: string): boolean {
  const c = compactSql(sql).toLowerCase();
  return c.includes("from scanner_submissions")
    && c.includes("session_id = ?")
    && /state\s*=\s*'saved'\s+or\b/.test(c);
}
