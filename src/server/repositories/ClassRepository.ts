import { buildInsertIgnore, getMysqlDb } from "../db";
import type { DbAdapter } from "../db";

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
  /** 文理分科：arts 文科 / science 理科（Issue #177） */
  track: string | null;
  joined_at: string;
}

/**
 * 年级 / 班级 / 班级花名册的数据访问层。
 * 管理员通过 /api/classes 维护组织结构，教师/分析模块按 grade_id / class_id 过滤成绩。
 */
export class ClassRepository {
  private db: DbAdapter;

  constructor() {
    this.db = getMysqlDb();
  }

  // ── 年级 ──────────────────────────────────────────────

  async listGrades(): Promise<GradeRecord[]> {
    return await this.db.all("SELECT * FROM grades ORDER BY sort_order ASC, id ASC");
  }

  async createGrade(name: string, sortOrder = 0): Promise<GradeRecord> {
    const result = await this.db.run("INSERT INTO grades (name, sort_order) VALUES (?, ?)", name, sortOrder);
    return (await this.db.get("SELECT * FROM grades WHERE id = ?", result.lastInsertRowid))!;
  }

  async updateGrade(id: number, name: string): Promise<void> {
    await this.db.run("UPDATE grades SET name = ? WHERE id = ?", name, id);
  }

  async deleteGrade(id: number): Promise<void> {
    await this.db.run("DELETE FROM grades WHERE id = ?", id);
  }

  // ── 班级 ──────────────────────────────────────────────

  async listClasses(gradeId?: number): Promise<ClassRecord[]> {
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
    return await this.db.all(sql, ...params);
  }

  async findClassById(id: number): Promise<ClassRecord | null> {
    return await this.db.get(`
      SELECT c.*, g.name as grade_name
      FROM classes c JOIN grades g ON g.id = c.grade_id
      WHERE c.id = ?
    `, id);
  }

  async createClass(gradeId: number, name: string, sortOrder = 0): Promise<ClassRecord> {
    const result = await this.db.run("INSERT INTO classes (grade_id, name, sort_order) VALUES (?, ?, ?)", gradeId, name, sortOrder);
    return (await this.findClassById(result.lastInsertRowid))!;
  }

  async deleteClass(id: number): Promise<void> {
    await this.db.run("DELETE FROM classes WHERE id = ?", id);
  }

  // ── 花名册 ────────────────────────────────────────────

  async listStudents(classId: number): Promise<ClassStudent[]> {
    return await this.db.all(`
      SELECT cs.student_id, u.username, u.name, u.student_number, u.track, cs.joined_at
      FROM class_students cs
      JOIN users u ON u.id = cs.student_id
      WHERE cs.class_id = ? AND u.is_active = 1
      ORDER BY u.student_number ASC, u.id ASC
    `, classId);
  }

  async addStudent(classId: number, studentId: number): Promise<void> {
    const sql = buildInsertIgnore(this.db.dialect, "class_students", ["class_id", "student_id"]);
    await this.db.run(sql, classId, studentId);
  }

  async addStudents(classId: number, studentIds: number[]): Promise<number> {
    let added = 0;
    await this.db.transaction(async (tx) => {
      const sql = buildInsertIgnore(tx.dialect, "class_students", ["class_id", "student_id"]);
      for (const sid of studentIds) {
        const r = await tx.run(sql, classId, sid);
        added += r.changes;
      }
    });
    return added;
  }

  async removeStudent(classId: number, studentId: number): Promise<void> {
    await this.db.run("DELETE FROM class_students WHERE class_id = ? AND student_id = ?", classId, studentId);
  }

  /** 学生迁移：从原班级移除并加入目标班级（目标班级所属年级即学生的新年级）。 */
  async moveStudent(fromClassId: number, toClassId: number, studentId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run("DELETE FROM class_students WHERE class_id = ? AND student_id = ?", fromClassId, studentId);
      const sql = buildInsertIgnore(tx.dialect, "class_students", ["class_id", "student_id"]);
      await tx.run(sql, toClassId, studentId);
    });
  }

  async isStudentInClass(classId: number, studentId: number): Promise<boolean> {
    const row = await this.db.get("SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ? LIMIT 1", classId, studentId);
    return Boolean(row);
  }

  // ── v1.1.0: 教师-班级关联 ─────────────────────────────

  async addTeacherToClass(teacherId: number, classId: number, subject?: string): Promise<void> {
    const sql = buildInsertIgnore(this.db.dialect, "teacher_classes", ["teacher_id", "class_id", "subject"]);
    await this.db.run(sql, teacherId, classId, subject ?? null);
  }

  async removeTeacherFromClass(teacherId: number, classId: number): Promise<void> {
    await this.db.run("DELETE FROM teacher_classes WHERE teacher_id = ? AND class_id = ?", teacherId, classId);
  }

  async listTeacherClasses(teacherId: number): Promise<Array<{
    class_id: number; class_name: string; grade_name: string; subject: string | null;
  }>> {
    return await this.db.all(`
      SELECT tc.class_id, c.name as class_name, g.name as grade_name, tc.subject
      FROM teacher_classes tc
      JOIN classes c ON c.id = tc.class_id
      JOIN grades g ON g.id = c.grade_id
      WHERE tc.teacher_id = ?
      ORDER BY g.sort_order ASC, c.sort_order ASC
    `, teacherId);
  }

  async listAllClassesWithGrade(): Promise<Array<{
    class_id: number; class_name: string; grade_id: number; grade_name: string;
  }>> {
    return await this.db.all(`
      SELECT c.id as class_id, c.name as class_name, g.id as grade_id, g.name as grade_name
      FROM classes c
      JOIN grades g ON g.id = c.grade_id
      ORDER BY g.sort_order ASC, c.sort_order ASC
    `);
  }
}
