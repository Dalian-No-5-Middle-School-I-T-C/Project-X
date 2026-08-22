import { getMysqlDb, buildUpsertSQL } from "../db";
import type { DbAdapter } from "../db";
import { roundScore } from "../services/rankingUpdate";

export interface ExamRecord {
  id: number;
  name: string;
  card_id: string | null;
  grade_id: number | null;
  class_id: number | null;
  subject: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
  closed_at: string | null;
  /** v41: 0=未公布 1=已公布 2=已撤回（学生端仅见 1） */
  score_published?: number;
  assigned_formula: string | null;
  retention_policy_id: number | null;
  exam_mode?: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /** 考试日期：答题卡 exam_date，缺省回退到创建日期（YYYY-MM-DD，仅列表查询填充） */
  exam_date?: string | null;
}

export interface ScanRecordInput {
  batch_id: number;
  file_path: string;
  file_name: string;
  student_number?: string;
  student_id?: number;
  expires_at?: string;
}

export class ExamRepository {
  private db: DbAdapter;

  constructor(db: DbAdapter = getMysqlDb()) {
    this.db = db;
  }

  async createExam(params: {
    name: string; card_id: string; grade_id?: number; class_id?: number;
    subject?: string; start_time?: string; end_time?: string;
    retention_policy_id?: number; created_by?: number;
    exam_mode?: "quiz" | "formal";
  }): Promise<ExamRecord> {
    const result = await this.db.run(
      `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, end_time, status, retention_policy_id, exam_mode, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      params.name, params.card_id, params.grade_id ?? null, params.class_id ?? null,
      params.subject ?? null, params.start_time ?? null, params.end_time ?? null,
      params.retention_policy_id ?? 1, params.exam_mode ?? "formal", params.created_by ?? null
    );
    return (await this.findExamById(result.lastInsertRowid))!;
  }

  async findExamById(id: number): Promise<ExamRecord | null> {
    return await this.db.get("SELECT * FROM exams WHERE id = ?", id);
  }

  async findExamByName(name: string): Promise<ExamRecord | null> {
    return await this.db.get("SELECT * FROM exams WHERE name = ?", name);
  }

  async listExams(filters?: {
    status?: string; grade_id?: number; class_id?: number;
    subject?: string; created_by?: number; examIds?: number[];
  }): Promise<ExamRecord[]> {
    // 考试日期语义与 listExamsForSelection 保持一致：取答题卡 exam_date，缺省回退创建日期
    let sql = `SELECT e.*, COALESCE(ac.exam_date, date(e.created_at)) as exam_date
      FROM exams e
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      WHERE 1=1`;
    const params: unknown[] = [];
    if (filters?.status) { sql += " AND e.status = ?"; params.push(filters.status); }
    if (filters?.grade_id) { sql += " AND e.grade_id = ?"; params.push(filters.grade_id); }
    if (filters?.class_id) { sql += " AND e.class_id = ?"; params.push(filters.class_id); }
    if (filters?.subject) { sql += " AND e.subject = ?"; params.push(filters.subject); }
    if (filters?.created_by) { sql += " AND e.created_by = ?"; params.push(filters.created_by); }
    if (filters?.examIds && filters.examIds.length > 0) {
      sql += ` AND e.id IN (${filters.examIds.map(() => "?").join(",")})`;
      params.push(...filters.examIds);
    }
    sql += " ORDER BY e.created_at DESC";
    return await this.db.all(sql, ...params);
  }

  async listExamsForSelection(filters?: {
    grade_id?: number; subject?: string; academic_year?: string; examIds?: number[];
  }): Promise<Array<{
    id: number; name: string; subject: string | null;
    grade_id: number | null; grade_name: string | null;
    exam_date: string | null; status: string;
    graded_count: number; avg_score: number; has_assigned_score: number;
  }>> {
    let sql = `SELECT e.id, e.name, e.subject, e.grade_id, g.name as grade_name,
        COALESCE(ac.exam_date, date(e.created_at)) as exam_date, e.status,
        COUNT(ss.exam_id) as graded_count, ROUND(AVG(ss.total_score), 1) as avg_score,
        CASE WHEN e.assigned_formula IS NOT NULL AND e.assigned_formula != '' THEN 1 ELSE 0 END as has_assigned_score
      FROM exams e
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      LEFT JOIN grades g ON g.id = e.grade_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      WHERE 1=1`;
    const params: unknown[] = [];
    if (filters?.grade_id) { sql += " AND e.grade_id = ?"; params.push(filters.grade_id); }
    if (filters?.subject) { sql += " AND e.subject = ?"; params.push(filters.subject); }
    if (filters?.academic_year) {
      const [startYear] = filters.academic_year.split("-").map(Number);
      sql += ` AND ((ac.exam_date >= ? AND ac.exam_date < ?) OR (ac.exam_date IS NULL AND e.created_at >= ? AND e.created_at < ?))`;
      params.push(`${startYear}-09-01`, `${startYear + 1}-08-01`, `${startYear}-09-01T00:00:00.000Z`, `${startYear + 1}-08-01T00:00:00.000Z`);
    }
    if (filters?.examIds && filters.examIds.length > 0) {
      sql += ` AND e.id IN (${filters.examIds.map(() => "?").join(",")})`;
      params.push(...filters.examIds);
    }
    sql += ` GROUP BY e.id ORDER BY COALESCE(ac.exam_date, e.created_at) DESC`;
    return await this.db.all(sql, ...params);
  }

  async getAcademicYears(): Promise<string[]> {
    const rows = await this.db.all(`SELECT DISTINCT COALESCE(ac.exam_date, e.created_at) as dt
      FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id`);
    const years = new Set<string>();
    for (const row of rows as Array<{ dt: string }>) {
      if (!row.dt) continue;
      const d = new Date(row.dt);
      const month = d.getMonth() + 1;
      const year = month >= 9 ? d.getFullYear() : d.getFullYear() - 1;
      years.add(`${year}-${year + 1}`);
    }
    return Array.from(years).sort().reverse();
  }

  async getSubjects(): Promise<string[]> {
    const rows = await this.db.all(
      "SELECT DISTINCT subject FROM exams WHERE subject IS NOT NULL AND subject != '' ORDER BY subject"
    );
    return (rows as Array<{ subject: string }>).map(r => r.subject);
  }

  async updateStatus(id: number, status: string): Promise<void> {
    if (status === "closed") {
      // 出分时间语义：从非 closed 状态进入 closed（含重新阅卷后再次结考）视为一次新的出分，
      // 刷新 closed_at；closed → closed（重复调用）保留首次出分时间。
      await this.db.run(
        `UPDATE exams
         SET closed_at = CASE WHEN status = 'closed' THEN closed_at ELSE CURRENT_TIMESTAMP END,
             status = 'closed',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        id
      );
    } else {
      await this.db.run("UPDATE exams SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", status, id);
    }
  }

  async createScanBatch(examId: number, name: string, createdBy?: number): Promise<number> {
    const result = await this.db.run("INSERT INTO scan_batches (exam_id, name, created_by) VALUES (?, ?, ?)",
      examId, name, createdBy ?? null);
    return result.lastInsertRowid;
  }

  async addScanRecord(input: ScanRecordInput): Promise<number> {
    let expiresAt = input.expires_at;
    if (!expiresAt) {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      expiresAt = d.toISOString();
    }
    const result = await this.db.run(
      "INSERT INTO scan_records (batch_id, file_path, file_name, student_number, student_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      input.batch_id, input.file_path, input.file_name,
      input.student_number ?? null, input.student_id ?? null, expiresAt
    );
    return result.lastInsertRowid;
  }

  /**
   * @deprecated 主流程从未调用此方法（persistGradingResults 直接写 question_scores.selected_options）。
   * objective_recognitions 表在当前版本中始终为空，仅作为历史遗留回退源。
   * 如需写入识别结果，请优先考虑写入 question_scores.selected_options。
   */
  async saveRecognition(recordId: number, blockId: string, questionNumber: number, selectedOptions: string[], confidence?: number): Promise<void> {
    await this.db.run(
      "REPLACE INTO objective_recognitions (record_id, block_id, question_number, selected_options, confidence) VALUES (?, ?, ?, ?, ?)",
      recordId, blockId, questionNumber, JSON.stringify(selectedOptions), confidence ?? null);
  }

  async saveObjectiveGrade(recordId: number, questionNumber: number, blockId: string, score: number, maxScore: number, isCorrect: number): Promise<void> {
    await this.db.run(
      "REPLACE INTO objective_grades (record_id, question_number, block_id, score, max_score, is_correct) VALUES (?, ?, ?, ?, ?, ?)",
      recordId, questionNumber, blockId, score, maxScore, isCorrect);
  }

  async saveStudentScore(examId: number, studentId: number, objectiveScore: number, subjectiveScore: number): Promise<void> {
    const obj = roundScore(objectiveScore);
    const subj = roundScore(subjectiveScore);
    const total = roundScore(obj + subj);
    const gradedAt = new Date().toISOString();
    const upsertSQL = buildUpsertSQL(
      this.db.dialect,
      "student_scores",
      ["exam_id", "student_id", "objective_score", "subjective_score", "total_score", "graded_at"],
      ["exam_id", "student_id"],
      ["objective_score", "subjective_score", "total_score", "graded_at"]
    );
    // ON CONFLICT 仅更新分数列，保留 rank/percentile/assigned_score/manually_modified 等
    await this.db.run(upsertSQL, examId, studentId, obj, subj, total, gradedAt);
  }

  async getExamResults(examId: number): Promise<Array<{
    student_id: number; student_number: string; name: string;
    total_score: number; objective_score: number; subjective_score: number;
  }>> {
    return await this.db.all(`SELECT ss.*, u.student_number, u.name
      FROM student_scores ss JOIN users u ON u.id = ss.student_id
      WHERE ss.exam_id = ? ORDER BY ss.total_score DESC`, examId);
  }

  async finishBatch(batchId: number): Promise<void> {
    await this.db.run("UPDATE scan_batches SET status = 'done', finished_at = CURRENT_TIMESTAMP WHERE id = ?", batchId);
  }

  async finishBatchWithOutcome(
    batchId: number,
    status: "done" | "partial" | "error",
    successCount: number,
    failureCount: number,
    errorSummary: string | null
  ): Promise<void> {
    await this.db.run(
      `UPDATE scan_batches
       SET status = ?, success_count = ?, failure_count = ?, error_summary = ?,
           file_count = ?, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      status, successCount, failureCount, errorSummary,
      successCount + failureCount, batchId
    );
  }
}
