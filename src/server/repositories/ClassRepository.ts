import { getDatabase } from "../db";
import Database from "better-sqlite3";

export interface GradeRecord {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface ClassRecord {
  id: number;
  grade_id: number;
  name: string;
  sort_order: number;
  created_at: string;
  grade_name?: string;
  student_count?: number;
}

export interface ClassStudent {
  student_id: number;
  username: string;
  name: string;
  student_number: string | null;
  joined_at: string;
}

/**
 * 年级 / 班级 / 班级花名册的数据访问层。
 * 管理员通过 /api/classes 维护组织结构，教师/分析模块按 grade_id / class_id 过滤成绩。
 */
export class ClassRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  // ── 年级 ──────────────────────────────────────────────

  listGrades(): GradeRecord[] {
    return this.db
      .prepare("SELECT * FROM grades ORDER BY sort_order ASC, id ASC")
      .all() as GradeRecord[];
  }

  createGrade(name: string, sortOrder = 0): GradeRecord {
    const result = this.db
      .prepare("INSERT INTO grades (name, sort_order) VALUES (?, ?)")
      .run(name, sortOrder);
    return this.db.prepare("SELECT * FROM grades WHERE id = ?").get(result.lastInsertRowid as number) as GradeRecord;
  }

  deleteGrade(id: number): void {
    // 外键 ON DELETE CASCADE 会级联删除班级与花名册
    this.db.prepare("DELETE FROM grades WHERE id = ?").run(id);
  }

  // ── 班级 ──────────────────────────────────────────────

  listClasses(gradeId?: number): ClassRecord[] {
    let sql = `
      SELECT c.*, g.name as grade_name,
        (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.id) as student_count
      FROM classes c
      JOIN grades g ON g.id = c.grade_id
    `;
    const params: unknown[] = [];
    if (gradeId) {
      sql += " WHERE c.grade_id = ?";
      params.push(gradeId);
    }
    sql += " ORDER BY g.sort_order ASC, c.sort_order ASC, c.id ASC";
    return this.db.prepare(sql).all(...params) as ClassRecord[];
  }

  findClassById(id: number): ClassRecord | null {
    const row = this.db
      .prepare(`
        SELECT c.*, g.name as grade_name
        FROM classes c JOIN grades g ON g.id = c.grade_id
        WHERE c.id = ?
      `)
      .get(id) as ClassRecord | undefined;
    return row ?? null;
  }

  createClass(gradeId: number, name: string, sortOrder = 0): ClassRecord {
    const result = this.db
      .prepare("INSERT INTO classes (grade_id, name, sort_order) VALUES (?, ?, ?)")
      .run(gradeId, name, sortOrder);
    return this.findClassById(result.lastInsertRowid as number)!;
  }

  deleteClass(id: number): void {
    this.db.prepare("DELETE FROM classes WHERE id = ?").run(id);
  }

  // ── 花名册 ────────────────────────────────────────────

  listStudents(classId: number): ClassStudent[] {
    return this.db
      .prepare(`
        SELECT cs.student_id, u.username, u.name, u.student_number, cs.joined_at
        FROM class_students cs
        JOIN users u ON u.id = cs.student_id
        WHERE cs.class_id = ? AND u.is_active = 1
        ORDER BY u.student_number ASC, u.id ASC
      `)
      .all(classId) as ClassStudent[];
  }

  /** 将学生加入班级（幂等） */
  addStudent(classId: number, studentId: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)")
      .run(classId, studentId);
  }

  /** 批量加入学生（事务） */
  addStudents(classId: number, studentIds: number[]): number {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)"
    );
    let added = 0;
    const tx = this.db.transaction(() => {
      for (const sid of studentIds) {
        const r = insert.run(classId, sid);
        added += r.changes;
      }
    });
    tx();
    return added;
  }

  removeStudent(classId: number, studentId: number): void {
    this.db
      .prepare("DELETE FROM class_students WHERE class_id = ? AND student_id = ?")
      .run(classId, studentId);
  }

  /** 判断某学生是否属于某班级（教师权限校验用） */
  isStudentInClass(classId: number, studentId: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ? LIMIT 1")
      .get(classId, studentId);
    return Boolean(row);
  }

  // ──────────────────────────────────────────────────────────
  // v1.1.0: 教师-班级关联
  // ──────────────────────────────────────────────────────────

  /** 教师关联班级 */
  addTeacherToClass(teacherId: number, classId: number, subject?: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, ?)"
    ).run(teacherId, classId, subject ?? null);
  }

  /** 教师解除班级关联 */
  removeTeacherFromClass(teacherId: number, classId: number): void {
    this.db.prepare(
      "DELETE FROM teacher_classes WHERE teacher_id = ? AND class_id = ?"
    ).run(teacherId, classId);
  }

  /** 获取教师关联的班级列表 */
  listTeacherClasses(teacherId: number): Array<{
    class_id: number;
    class_name: string;
    grade_name: string;
    subject: string | null;
  }> {
    return this.db.prepare(`
      SELECT tc.class_id, c.name as class_name, g.name as grade_name, tc.subject
      FROM teacher_classes tc
      JOIN classes c ON c.id = tc.class_id
      JOIN grades g ON g.id = c.grade_id
      WHERE tc.teacher_id = ?
      ORDER BY g.sort_order ASC, c.sort_order ASC
    `).all(teacherId) as any[];
  }

  /** 列出所有班级（含年级名，供前端下拉用） */
  listAllClassesWithGrade(): Array<{
    class_id: number;
    class_name: string;
    grade_id: number;
    grade_name: string;
  }> {
    return this.db.prepare(`
      SELECT c.id as class_id, c.name as class_name, g.id as grade_id, g.name as grade_name
      FROM classes c
      JOIN grades g ON g.id = c.grade_id
      ORDER BY g.sort_order ASC, c.sort_order ASC
    `).all() as any[];
  }
}
