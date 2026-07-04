import { getMysqlDb, buildUpsertSQL } from "../../../../server/db";
import type { DbAdapter } from "../../../../server/db";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────

export interface ScanSession {
  id: string;
  card_id: string;
  name: string;
  dpi: number;
  duplex: number;
  color_mode: string;
  paper_size: string;
  page_count: number;
  status: "pending" | "scanning" | "completed" | "cancelled" | "error";
  error_msg: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanRecord {
  id: string;
  session_id: string;
  card_id: string;
  student_id: string | null;
  student_conf: number | null;
  image_path: string;
  page_num: number;
  side: "front" | "back";
  ocr_status: "pending" | "processing" | "done" | "failed" | "review";
  scan_quality: number | null;
  ocr_error: string | null;
  created_at: string;
  recognized_at: string | null;
}

export interface RecognitionResultRow {
  id: string;
  scan_record_id: string;
  objective_json: string | null;
  subjective_json: string | null;
  total_score: number | null;
  max_score: number | null;
  grade_status: string;
  created_at: string;
}

export interface ScanRecordWithResult extends ScanRecord {
  recognition: RecognitionResultRow | null;
}

export interface StudentGradingResultRow {
  session_id: string;
  student_id: string;
  objective_json: string | null;
  subjective_json: string | null;
  total_score: number | null;
  max_score: number | null;
  page_count: number;
  created_at: string;
}

// ── Internal ───────────────────────────────────────────

function db(): DbAdapter {
  return getMysqlDb();
}

function generateId(): string {
  return randomUUID();
}

// ── Session CRUD ──────────────────────────────────────

export async function createSession(
  cardId: string,
  name: string,
  config: { dpi?: number; duplex?: boolean; colorMode?: string; paperSize?: string } = {}
): Promise<ScanSession> {
  const id = generateId();
  await db().run(`
    INSERT INTO twain_scan_sessions (id, card_id, name, dpi, duplex, color_mode, paper_size, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `, id, cardId, name, config.dpi ?? 300, config.duplex ? 1 : 0,
    config.colorMode ?? "gray", config.paperSize ?? "A4");
  return (await getSession(id))!;
}

export async function getSession(id: string): Promise<ScanSession | undefined> {
  return await db().get("SELECT * FROM twain_scan_sessions WHERE id = ?", id) as ScanSession | undefined;
}

export async function listSessions(cardId?: string): Promise<ScanSession[]> {
  if (cardId) {
    return await db().all(
      "SELECT * FROM twain_scan_sessions WHERE card_id = ? ORDER BY created_at DESC",
      cardId
    ) as ScanSession[];
  }
  return await db().all("SELECT * FROM twain_scan_sessions ORDER BY created_at DESC") as ScanSession[];
}

export async function updateSessionStatus(
  id: string, status: ScanSession["status"], errorMsg?: string
): Promise<void> {
  await db().run(
    "UPDATE twain_scan_sessions SET status = ?, error_msg = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    status, errorMsg ?? null, id
  );
}

export async function incrementPageCount(id: string): Promise<void> {
  await db().run(
    "UPDATE twain_scan_sessions SET page_count = page_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    id
  );
}

export async function deleteSession(id: string): Promise<void> {
  await db().run("DELETE FROM twain_scan_sessions WHERE id = ?", id);
}

// ── Scan Record CRUD ───────────────────────────────────

export async function createScanRecord(params: {
  sessionId: string;
  cardId: string;
  imagePath: string;
  pageNum: number;
  side?: "front" | "back";
}): Promise<ScanRecord> {
  const id = generateId();
  await db().run(`
    INSERT INTO twain_scan_records (id, session_id, card_id, image_path, page_num, side, ocr_status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `, id, params.sessionId, params.cardId, params.imagePath, params.pageNum, params.side ?? "front");
  return (await getScanRecord(id))!;
}

export async function getScanRecord(id: string): Promise<ScanRecord | undefined> {
  return await db().get("SELECT * FROM twain_scan_records WHERE id = ?", id) as ScanRecord | undefined;
}

export async function getScanRecordWithResult(id: string): Promise<ScanRecordWithResult | undefined> {
  const record = await db().get("SELECT * FROM twain_scan_records WHERE id = ?", id) as ScanRecord | undefined;
  if (!record) return undefined;
  const recognition = await db().get(
    "SELECT * FROM twain_recognition_results WHERE scan_record_id = ?",
    id
  ) as RecognitionResultRow | undefined;
  return { ...record, recognition: recognition ?? null };
}

export async function listScanRecords(sessionId: string): Promise<ScanRecord[]> {
  return await db().all(
    "SELECT * FROM twain_scan_records WHERE session_id = ? ORDER BY page_num, side",
    sessionId
  ) as ScanRecord[];
}

export async function listScanRecordsByCard(cardId: string): Promise<ScanRecord[]> {
  return await db().all(
    "SELECT * FROM twain_scan_records WHERE card_id = ? ORDER BY created_at DESC",
    cardId
  ) as ScanRecord[];
}

export async function updateScanOcrResult(
  id: string,
  studentId: string | null,
  studentConf: number | null,
  status: ScanRecord["ocr_status"],
  error?: string
): Promise<void> {
  await db().run(`
    UPDATE twain_scan_records
    SET student_id = ?, student_conf = ?, ocr_status = ?, ocr_error = ?, recognized_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, studentId, studentConf, status, error ?? null, id);
}

export async function updateScanQuality(id: string, quality: number): Promise<void> {
  await db().run("UPDATE twain_scan_records SET scan_quality = ? WHERE id = ?", quality, id);
}

export async function deleteScanRecord(id: string): Promise<void> {
  await db().run("DELETE FROM twain_scan_records WHERE id = ?", id);
}

// ── Recognition Result CRUD ────────────────────────────

export async function upsertRecognitionResult(params: {
  scanRecordId: string;
  objectiveJson?: string | null;
  subjectiveJson?: string | null;
  totalScore?: number | null;
  maxScore?: number | null;
  gradeStatus?: string;
}): Promise<RecognitionResultRow> {
  const d = db();
  const existing = await d.get(
    "SELECT id FROM twain_recognition_results WHERE scan_record_id = ?",
    params.scanRecordId
  ) as { id: string } | undefined;

  if (existing) {
    await d.run(`
      UPDATE twain_recognition_results
      SET objective_json = COALESCE(?, objective_json),
          subjective_json = COALESCE(?, subjective_json),
          total_score = COALESCE(?, total_score),
          max_score = COALESCE(?, max_score),
          grade_status = COALESCE(?, grade_status)
      WHERE scan_record_id = ?
    `, params.objectiveJson ?? null, params.subjectiveJson ?? null,
      params.totalScore ?? null, params.maxScore ?? null,
      params.gradeStatus ?? null, params.scanRecordId);
  } else {
    const id = generateId();
    await d.run(`
      INSERT INTO twain_recognition_results (id, scan_record_id, objective_json, subjective_json, total_score, max_score, grade_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, id, params.scanRecordId,
      params.objectiveJson ?? null, params.subjectiveJson ?? null,
      params.totalScore ?? null, params.maxScore ?? null,
      params.gradeStatus ?? "pending");
  }

  return await d.get(
    "SELECT * FROM twain_recognition_results WHERE scan_record_id = ?",
    params.scanRecordId
  ) as RecognitionResultRow;
}

export async function deleteRecognitionResult(scanRecordId: string): Promise<void> {
  await db().run("DELETE FROM twain_recognition_results WHERE scan_record_id = ?", scanRecordId);
}

// ── Student Grading Results (combined across pages) ────

const SGR_UPSERT_COLS = ["session_id", "student_id", "objective_json", "subjective_json", "total_score", "max_score", "page_count"];
const SGR_CONFLICT_COLS = ["session_id", "student_id"];
const SGR_UPDATE_COLS = ["objective_json", "subjective_json", "total_score", "max_score", "page_count"];

/** Upsert a combined student grading result */
export async function upsertStudentGradingResult(params: {
  sessionId: string;
  studentId: string;
  objectiveJson?: string | null;
  subjectiveJson?: string | null;
  totalScore?: number | null;
  maxScore?: number | null;
  pageCount?: number;
}): Promise<void> {
  const d = db();
  const sql = buildUpsertSQL(d.dialect, "twain_student_grading_results", SGR_UPSERT_COLS, SGR_CONFLICT_COLS, SGR_UPDATE_COLS);
  await d.run(sql,
    params.sessionId, params.studentId,
    params.objectiveJson ?? null, params.subjectiveJson ?? null,
    params.totalScore ?? null, params.maxScore ?? null,
    params.pageCount ?? 1
  );
}

/** Get combined student grading results for a session */
export async function listStudentGradingResults(sessionId: string): Promise<StudentGradingResultRow[]> {
  return await db().all(
    "SELECT * FROM twain_student_grading_results WHERE session_id = ? ORDER BY student_id",
    sessionId
  ) as StudentGradingResultRow[];
}

/** Get scan records for a session grouped by student_id (for combined grading) */
export async function listScanRecordsGroupedByStudent(sessionId: string): Promise<Array<{
  studentId: string;
  records: ScanRecordWithResult[];
}>> {
  const d = db();
  const records = await d.all(
    "SELECT * FROM twain_scan_records WHERE session_id = ? ORDER BY student_id, page_num, side",
    sessionId
  ) as ScanRecord[];

  const grouped = new Map<string, ScanRecordWithResult[]>();
  for (const record of records) {
    const key = record.student_id ?? "__unrecognized__";
    if (!grouped.has(key)) grouped.set(key, []);
    const recognition = await d.get(
      "SELECT * FROM twain_recognition_results WHERE scan_record_id = ?",
      record.id
    ) as RecognitionResultRow | undefined;
    grouped.get(key)!.push({ ...record, recognition: recognition ?? null });
  }

  return Array.from(grouped.entries()).map(([studentId, recs]) => ({ studentId, records: recs }));
}

// ── Bulk Operations ────────────────────────────────────

/** Get all scan records for a card with their student IDs, images, and recognition results */
export async function listScansForCard(cardId: string): Promise<Array<{
  record: ScanRecord;
  recognition: RecognitionResultRow | null;
}>> {
  const d = db();
  const records = await d.all(
    "SELECT * FROM twain_scan_records WHERE card_id = ? ORDER BY page_num, side",
    cardId
  ) as ScanRecord[];

  const results: Array<{ record: ScanRecord; recognition: RecognitionResultRow | null }> = [];
  for (const record of records) {
    const recognition = await d.get(
      "SELECT * FROM twain_recognition_results WHERE scan_record_id = ?",
      record.id
    ) as RecognitionResultRow | undefined;
    results.push({ record, recognition: recognition ?? null });
  }
  return results;
}

/** Search scan records by student ID */
export async function findScansByStudentId(cardId: string, studentId: string): Promise<ScanRecord[]> {
  return await db().all(
    "SELECT * FROM twain_scan_records WHERE card_id = ? AND student_id = ? ORDER BY created_at DESC",
    cardId, studentId
  ) as ScanRecord[];
}
