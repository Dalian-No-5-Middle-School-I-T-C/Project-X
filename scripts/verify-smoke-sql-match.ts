import assert from "node:assert/strict";
import {
  compactSql,
  isSavedReceiptOwnershipLookup,
  isSessionGroupedOcrBatch,
  isSessionGroupedRecordBatch,
  isUploadRecognizedStudentStamp,
} from "./smoke-sql-match";

const recordBatch =
  "SELECT  r.*, s.identity_mode FROM twain_scan_records r JOIN twain_scan_sessions s ON s.id = r.session_id WHERE r.session_id = ?";
const ocrBatch =
  "SELECT o.* FROM twain_recognition_results o JOIN twain_scan_records r ON r.id = o.scan_record_id WHERE r.session_id = ?";
const uploadStamp =
  "UPDATE twain_scan_records SET student_id = ?,  recognized_at = CURRENT_TIMESTAMP WHERE id = ? AND session_id = ?";
const ownership =
  "SELECT * FROM scanner_submissions WHERE session_id = ? AND (state = 'saved'  OR (? = 1 AND state = 'discarded'))";

assert.equal(compactSql("  SELECT\n  r.*  "), "SELECT r.*");
assert.ok(isSessionGroupedRecordBatch(recordBatch));
assert.ok(isSessionGroupedOcrBatch(ocrBatch));
assert.ok(isUploadRecognizedStudentStamp(uploadStamp));
assert.ok(isSavedReceiptOwnershipLookup(ownership));

assert.ok(isSessionGroupedRecordBatch(recordBatch.replace("SELECT", "SELECT  ")));
assert.ok(isSessionGroupedOcrBatch(ocrBatch.replace("SELECT", "SELECT  ")));
assert.ok(isUploadRecognizedStudentStamp(uploadStamp.replace("?, ", "?,  ")));
assert.ok(isSavedReceiptOwnershipLookup(ownership.replace("'saved'  OR", "'saved' OR")));

assert.equal(isSessionGroupedRecordBatch("SELECT * FROM twain_scan_records WHERE session_id = ?"), false);
assert.equal(isSessionGroupedOcrBatch("SELECT * FROM twain_recognition_results WHERE scan_record_id = ?"), false);
assert.equal(isUploadRecognizedStudentStamp("UPDATE twain_scan_records SET student_id = ? WHERE id = ?"), false);
assert.equal(isSavedReceiptOwnershipLookup("SELECT * FROM scanner_submissions WHERE session_id = ? AND state = 'saved'"), false);

console.log("PASS smoke-sql-match whitespace regression");
