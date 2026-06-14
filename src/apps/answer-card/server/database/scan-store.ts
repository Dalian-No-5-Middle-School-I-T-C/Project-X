import { getDb } from "./index";
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

// ── Session CRUD ───────────────────────────────────────

export function createSession(
  cardId: string,
  name: string,
  config: { dpi?: number; duplex?: boolean; colorMode?: string; paperSize?: string } = {}
): ScanSession {
  const db = getDb();
  const id = generateId();
  const stmt = db.prepare(`
    INSERT INTO scan_sessions (id, card_id, name, dpi, duplex, color_mode, paper_size, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  stmt.run(
    id,
    cardId,
    name,
    config.dpi ?? 300,
    config.duplex ? 1 : 0,
    config.colorMode ?? "gray",
    config.paperSize ?? "A4"
  );
  return getSession(id)!;
}

export function getSession(id: string): ScanSession | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM scan_sessions WHERE id = ?").get(id) as ScanSession | undefined;
}

export function listSessions(cardId?: string): ScanSession[] {
  const db = getDb();
  if (cardId) {
    return db.prepare("SELECT * FROM scan_sessions WHERE card_id = ? ORDER BY created_at DESC").all(cardId) as ScanSession[];
  }
  return db.prepare("SELECT * FROM scan_sessions ORDER BY created_at DESC").all() as ScanSession[];
}

export function updateSessionStatus(id: string, status: ScanSession["status"], errorMsg?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE scan_sessions
    SET status = ?, error_msg = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, errorMsg ?? null, id);
}

export function incrementPageCount(id: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE scan_sessions
    SET page_count = page_count + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

export function deleteSession(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM scan_sessions WHERE id = ?").run(id);
}

// ── Scan Record CRUD ───────────────────────────────────

export function createScanRecord(params: {
  sessionId: string;
  cardId: string;
  imagePath: string;
  pageNum: number;
  side?: "front" | "back";
}): ScanRecord {
  const db = getDb();
  const id = generateId();
  const stmt = db.prepare(`
    INSERT INTO scan_records (id, session_id, card_id, image_path, page_num, side, ocr_status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);
  stmt.run(id, params.sessionId, params.cardId, params.imagePath, params.pageNum, params.side ?? "front");
  return getScanRecord(id)!;
}

export function getScanRecord(id: string): ScanRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM scan_records WHERE id = ?").get(id) as ScanRecord | undefined;
}

export function getScanRecordWithResult(id: string): ScanRecordWithResult | undefined {
  const db = getDb();
  const record = db.prepare("SELECT * FROM scan_records WHERE id = ?").get(id) as ScanRecord | undefined;
  if (!record) return undefined;
  const recognition = db
    .prepare("SELECT * FROM recognition_results WHERE scan_record_id = ?")
    .get(id) as RecognitionResultRow | undefined;
  return { ...record, recognition: recognition ?? null };
}

export function listScanRecords(sessionId: string): ScanRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM scan_records WHERE session_id = ? ORDER BY page_num, side")
    .all(sessionId) as ScanRecord[];
}

export function listScanRecordsByCard(cardId: string): ScanRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM scan_records WHERE card_id = ? ORDER BY created_at DESC")
    .all(cardId) as ScanRecord[];
}

export function updateScanOcrResult(
  id: string,
  studentId: string | null,
  studentConf: number | null,
  status: ScanRecord["ocr_status"],
  error?: string
): void {
  const db = getDb();
  db.prepare(`
    UPDATE scan_records
    SET student_id = ?,
        student_conf = ?,
        ocr_status = ?,
        ocr_error = ?,
        recognized_at = datetime('now')
    WHERE id = ?
  `).run(studentId, studentConf, status, error ?? null, id);
}

export function updateScanQuality(id: string, quality: number): void {
  const db = getDb();
  db.prepare("UPDATE scan_records SET scan_quality = ? WHERE id = ?").run(quality, id);
}

export function deleteScanRecord(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM scan_records WHERE id = ?").run(id);
}

// ── Recognition Result CRUD ────────────────────────────

export function upsertRecognitionResult(params: {
  scanRecordId: string;
  objectiveJson?: string | null;
  subjectiveJson?: string | null;
  totalScore?: number | null;
  maxScore?: number | null;
  gradeStatus?: string;
}): RecognitionResultRow {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM recognition_results WHERE scan_record_id = ?")
    .get(params.scanRecordId) as { id: string } | undefined;

  if (existing) {
    const stmt = db.prepare(`
      UPDATE recognition_results
      SET objective_json = COALESCE(?, objective_json),
          subjective_json = COALESCE(?, subjective_json),
          total_score = COALESCE(?, total_score),
          max_score = COALESCE(?, max_score),
          grade_status = COALESCE(?, grade_status)
      WHERE scan_record_id = ?
    `);
    stmt.run(
      params.objectiveJson ?? null,
      params.subjectiveJson ?? null,
      params.totalScore ?? null,
      params.maxScore ?? null,
      params.gradeStatus ?? null,
      params.scanRecordId
    );
  } else {
    const id = generateId();
    const stmt = db.prepare(`
      INSERT INTO recognition_results (id, scan_record_id, objective_json, subjective_json, total_score, max_score, grade_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      params.scanRecordId,
      params.objectiveJson ?? null,
      params.subjectiveJson ?? null,
      params.totalScore ?? null,
      params.maxScore ?? null,
      params.gradeStatus ?? "pending"
    );
  }

  return db
    .prepare("SELECT * FROM recognition_results WHERE scan_record_id = ?")
    .get(params.scanRecordId) as RecognitionResultRow;
}

export function deleteRecognitionResult(scanRecordId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM recognition_results WHERE scan_record_id = ?").run(scanRecordId);
}

// ── Student Grading Results (combined across pages) ────

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

/** Upsert a combined student grading result */
export function upsertStudentGradingResult(params: {
  sessionId: string;
  studentId: string;
  objectiveJson?: string | null;
  subjectiveJson?: string | null;
  totalScore?: number | null;
  maxScore?: number | null;
  pageCount?: number;
}): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO student_grading_results (session_id, student_id, objective_json, subjective_json, total_score, max_score, page_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id, student_id) DO UPDATE SET
      objective_json = COALESCE(excluded.objective_json, objective_json),
      subjective_json = COALESCE(excluded.subjective_json, subjective_json),
      total_score = COALESCE(excluded.total_score, total_score),
      max_score = COALESCE(excluded.max_score, max_score),
      page_count = COALESCE(excluded.page_count, page_count),
      created_at = datetime('now')
  `);
  stmt.run(
    params.sessionId,
    params.studentId,
    params.objectiveJson ?? null,
    params.subjectiveJson ?? null,
    params.totalScore ?? null,
    params.maxScore ?? null,
    params.pageCount ?? 1
  );
}

/** Get combined student grading results for a session */
export function listStudentGradingResults(sessionId: string): StudentGradingResultRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM student_grading_results WHERE session_id = ? ORDER BY student_id")
    .all(sessionId) as StudentGradingResultRow[];
}

/** Get scan records for a session grouped by student_id (for combined grading) */
export function listScanRecordsGroupedByStudent(sessionId: string): Array<{
  studentId: string;
  records: ScanRecordWithResult[];
}> {
  const db = getDb();
  const records = db
    .prepare("SELECT * FROM scan_records WHERE session_id = ? ORDER BY student_id, page_num, side")
    .all(sessionId) as ScanRecord[];

  const grouped = new Map<string, ScanRecordWithResult[]>();
  for (const record of records) {
    const key = record.student_id ?? "__unrecognized__";
    if (!grouped.has(key)) grouped.set(key, []);
    const recognition = db
      .prepare("SELECT * FROM recognition_results WHERE scan_record_id = ?")
      .get(record.id) as RecognitionResultRow | undefined;
    grouped.get(key)!.push({ ...record, recognition: recognition ?? null });
  }

  return Array.from(grouped.entries()).map(([studentId, recs]) => ({ studentId, records: recs }));
}

// ── Bulk Operations ────────────────────────────────────

/** Get all scan records for a card with their student IDs, images, and recognition results */
export function listScansForCard(cardId: string): Array<{
  record: ScanRecord;
  recognition: RecognitionResultRow | null;
}> {
  const db = getDb();
  const records = db
    .prepare("SELECT * FROM scan_records WHERE card_id = ? ORDER BY page_num, side")
    .all(cardId) as ScanRecord[];

  return records.map((record) => {
    const recognition = db
      .prepare("SELECT * FROM recognition_results WHERE scan_record_id = ?")
      .get(record.id) as RecognitionResultRow | undefined;
    return { record, recognition: recognition ?? null };
  });
}

/** Search scan records by student ID */
export function findScansByStudentId(cardId: string, studentId: string): ScanRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM scan_records WHERE card_id = ? AND student_id = ? ORDER BY created_at DESC")
    .all(cardId, studentId) as ScanRecord[];
}

// ── Helpers ────────────────────────────────────────────

function generateId(): string {
  return randomUUID();
}
