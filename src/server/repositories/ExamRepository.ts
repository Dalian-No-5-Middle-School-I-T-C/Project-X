import { getDatabase } from "../db";
import Database from "better-sqlite3";

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
  retention_policy_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
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
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * 创建考试
   */
  createExam(params: {
    name: string;
    card_id: string;
    grade_id?: number;
    class_id?: number;
    subject?: string;
    start_time?: string;
    end_time?: string;
    retention_policy_id?: number;
    created_by?: number;
  }): ExamRecord {
    const stmt = this.db.prepare(`
      INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, end_time, status, retention_policy_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `);
    const result = stmt.run(
      params.name,
      params.card_id,
      params.grade_id ?? null,
      params.class_id ?? null,
      params.subject ?? null,
      params.start_time ?? null,
      params.end_time ?? null,
      params.retention_policy_id ?? 1, // 默认周测=30天
      params.created_by ?? null
    );
    return this.findExamById(result.lastInsertRowid as number)!;
  }

  /**
   * 根据 ID 查找考试
   */
  findExamById(id: number): ExamRecord | null {
    return this.db.prepare("SELECT * FROM exams WHERE id = ?").get(id) as ExamRecord | null;
  }

  /**
   * 列出考试（支持过滤）
   */
  listExams(filters?: {
    status?: string;
    grade_id?: number;
    class_id?: number;
    created_by?: number;
  }): ExamRecord[] {
    let sql = "SELECT * FROM exams WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters?.grade_id) { sql += " AND grade_id = ?"; params.push(filters.grade_id); }
    if (filters?.class_id) { sql += " AND class_id = ?"; params.push(filters.class_id); }
    if (filters?.created_by) { sql += " AND created_by = ?"; params.push(filters.created_by); }

    sql += " ORDER BY created_at DESC";
    return this.db.prepare(sql).all(...params) as ExamRecord[];
  }

  /**
   * 更新考试状态
   */
  updateStatus(id: number, status: string): void {
    this.db.prepare("UPDATE exams SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
  }

  /**
   * 创建扫描批次
   */
  createScanBatch(examId: number, name: string, createdBy?: number): number {
    const stmt = this.db.prepare(`
      INSERT INTO scan_batches (exam_id, name, created_by)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(examId, name, createdBy ?? null);
    return result.lastInsertRowid as number;
  }

  /**
   * 添加扫描记录
   */
  addScanRecord(input: ScanRecordInput): number {
    // 计算过期时间（默认30天）
    let expiresAt = input.expires_at;
    if (!expiresAt) {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      expiresAt = d.toISOString();
    }

    const stmt = this.db.prepare(`
      INSERT INTO scan_records (batch_id, file_path, file_name, student_number, student_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.batch_id,
      input.file_path,
      input.file_name,
      input.student_number ?? null,
      input.student_id ?? null,
      expiresAt
    );
    return result.lastInsertRowid as number;
  }

  /**
   * 保存客观题识别结果
   */
  saveRecognition(recordId: number, blockId: string, questionNumber: number, selectedOptions: string[], confidence?: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO objective_recognitions (record_id, block_id, question_number, selected_options, confidence)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(recordId, blockId, questionNumber, JSON.stringify(selectedOptions), confidence ?? null);
  }

  /**
   * 保存客观题评分结果
   */
  saveObjectiveGrade(recordId: number, questionNumber: number, blockId: string, score: number, maxScore: number, isCorrect: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO objective_grades (record_id, question_number, block_id, score, max_score, is_correct)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(recordId, questionNumber, blockId, score, maxScore, isCorrect);
  }

  /**
   * 保存学生总分
   */
  saveStudentScore(examId: number, studentId: number, objectiveScore: number, subjectiveScore: number): void {
    const total = objectiveScore + subjectiveScore;
    this.db.prepare(`
      INSERT OR REPLACE INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score, graded_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(examId, studentId, objectiveScore, subjectiveScore, total);
  }

  /**
   * 获取考试成绩
   */
  getExamResults(examId: number): Array<{
    student_id: number;
    student_number: string;
    name: string;
    total_score: number;
    objective_score: number;
    subjective_score: number;
  }> {
    return this.db.prepare(`
      SELECT ss.*, u.student_number, u.name
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      WHERE ss.exam_id = ?
      ORDER BY ss.total_score DESC
    `).all(examId) as any[];
  }

  /**
   * 完成扫描批次
   */
  finishBatch(batchId: number): void {
    this.db.prepare("UPDATE scan_batches SET status = 'done', finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(batchId);
  }
}
