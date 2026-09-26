import { buildInsertIgnore, buildUpsertSQL, getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { ensureExamParticipants } from "../services/examParticipants";

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

export interface ClassTeacherRow {
  teacher_id: number;
  name: string;
  /** 该教师在此班级的科目覆盖（空 = 未指定，例如班主任） */
  subject: string | null;
  /** 是否该班班主任（按班标记，v52） */
  is_head_teacher: number;
  /** 教师本人任教学科 */
  teacher_subject: string | null;
  teacher_role: string | null;
}

/**
 * 年级 / 班级 / 班级花名册的数据访问层。
 * 管理员通过 /api/classes 维护组织结构，教师/分析模块按 grade_id / class_id 过滤成绩。
 */
export class ClassRepository {
  private db: DbAdapter;

  constructor(db: DbAdapter = getMysqlDb()) {
    this.db = db;
  }

  // ── 年级 ──────────────────────────────────────────────

  async listGrades(): Promise<GradeRecord[]> {
    return await this.db.all("SELECT * FROM grades WHERE archived_at IS NULL ORDER BY sort_order ASC, id ASC");
  }

  async createGrade(name: string, sortOrder = 0): Promise<GradeRecord> {
    const result = await this.db.run("INSERT INTO grades (name, sort_order) VALUES (?, ?)", name, sortOrder);
    return (await this.db.get("SELECT * FROM grades WHERE id = ?", result.lastInsertRowid))!;
  }

  async updateGrade(id: number, name: string): Promise<void> {
    await this.db.run("UPDATE grades SET name = ? WHERE id = ?", name, id);
  }

  async deleteGrade(id: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.freezeGradeParticipants(tx, id);
      await tx.run("UPDATE classes SET archived_at = CURRENT_TIMESTAMP WHERE grade_id = ? AND archived_at IS NULL", id);
      await tx.run("UPDATE grades SET archived_at = CURRENT_TIMESTAMP WHERE id = ? AND archived_at IS NULL", id);
    });
  }

  private async freezeGradeParticipants(tx: DbAdapter, gradeId: number): Promise<void> {
    // Keep existing exam rosters before archived classes disappear from new grade rosters.
    const exams = await tx.all<{ id: number }>(
      "SELECT id FROM exams WHERE grade_id = ? OR class_id IN (SELECT id FROM classes WHERE grade_id = ?)",
      gradeId, gradeId,
    );
    for (const exam of exams) {
      const snapshot = await ensureExamParticipants(tx, exam.id);
      if (!snapshot.rosterKnown) throw new Error("无法保留考试应考名单，未归档班级");
    }
  }

  // ── 班级 ──────────────────────────────────────────────

  async listClasses(gradeId?: number): Promise<ClassRecord[]> {
    let sql = `
      SELECT c.*, g.name as grade_name,
        (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.id) as student_count
      FROM classes c
      JOIN grades g ON g.id = c.grade_id
      WHERE c.archived_at IS NULL AND g.archived_at IS NULL
    `;
    const params: unknown[] = [];
    if (gradeId) {
      sql += " AND c.grade_id = ?";
      params.push(gradeId);
    }
    sql += " ORDER BY g.sort_order ASC, c.sort_order ASC, c.id ASC";
    return await this.db.all(sql, ...params);
  }

  async findClassById(id: number): Promise<ClassRecord | null> {
    return await this.db.get(`
      SELECT c.*, g.name as grade_name
      FROM classes c JOIN grades g ON g.id = c.grade_id
      WHERE c.id = ? AND c.archived_at IS NULL AND g.archived_at IS NULL
    `, id);
  }

  async createClass(gradeId: number, name: string, sortOrder = 0): Promise<ClassRecord> {
    if (!await this.db.get("SELECT id FROM grades WHERE id = ? AND archived_at IS NULL", gradeId)) {
      throw Object.assign(new Error("年级不存在或已归档"), { status: 400 });
    }
    const result = await this.db.run("INSERT INTO classes (grade_id, name, sort_order) VALUES (?, ?, ?)", gradeId, name, sortOrder);
    return (await this.findClassById(result.lastInsertRowid))!;
  }

  /** 班级改名（仅改当前未归档班级的名称，历史数据不动）。 */
  async updateClass(id: number, name: string): Promise<void> {
    await this.db.run("UPDATE classes SET name = ? WHERE id = ? AND archived_at IS NULL", name, id);
  }

  async deleteClass(id: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const cls = await tx.get<{ grade_id: number }>("SELECT grade_id FROM classes WHERE id = ? AND archived_at IS NULL", id);
      if (!cls) return;
      await this.freezeGradeParticipants(tx, cls.grade_id);
      // Retain exam foreign keys, rosters, scores and historical teacher access.
      await tx.run("UPDATE classes SET archived_at = CURRENT_TIMESTAMP WHERE id = ?", id);
    });
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

  /**
   * 班级下的教师关联。teacher_classes 主键是 (teacher_id, class_id)，每位教师每班一行；
   * subject 为该教师在此班级的科目覆盖，is_head_teacher 按班标记班主任。
   */
  async listClassTeachers(classId: number): Promise<ClassTeacherRow[]> {
    return await this.db.all(`
      SELECT tc.teacher_id, u.name, tc.subject, tc.is_head_teacher, u.subject as teacher_subject, u.teacher_role
      FROM teacher_classes tc
      JOIN users u ON u.id = tc.teacher_id
      WHERE tc.class_id = ? AND u.is_active = 1
      ORDER BY u.name ASC, u.id ASC
    `, classId);
  }

  /** 关联教师到班级并写入科目（不触碰 is_head_teacher 标记）。 */
  async setClassTeacher(teacherId: number, classId: number, subject: string | null): Promise<void> {
    const sql = buildUpsertSQL(
      this.db.dialect,
      "teacher_classes",
      ["teacher_id", "class_id", "subject"],
      ["teacher_id", "class_id"],
      ["subject"]
    );
    await this.db.run(sql, teacherId, classId, subject);
  }

  /**
   * 事务内原子替换该班班主任：撤销旧班主任的按班标记（纯班主任关联则整行删除，
   * 兼任任课教师只撤标记保留科目），再为新教师置标记。teacherId 为 null 表示仅清除。
   * 新教师是否存在必须由调用方在写入前校验完成。
   */
  async replaceClassHeadTeacher(classId: number, teacherId: number | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      const heads = await tx.all<{ teacher_id: number; subject: string | null }>(
        "SELECT teacher_id, subject FROM teacher_classes WHERE class_id = ? AND is_head_teacher = 1",
        classId
      );
      for (const head of heads) {
        if (head.teacher_id === teacherId) continue;
        if (head.subject === null) {
          await tx.run("DELETE FROM teacher_classes WHERE teacher_id = ? AND class_id = ?", head.teacher_id, classId);
        } else {
          await tx.run("UPDATE teacher_classes SET is_head_teacher = 0 WHERE teacher_id = ? AND class_id = ?", head.teacher_id, classId);
        }
      }
      if (teacherId !== null) {
        const insert = buildInsertIgnore(tx.dialect, "teacher_classes", ["teacher_id", "class_id"]);
        await tx.run(insert, teacherId, classId);
        await tx.run("UPDATE teacher_classes SET is_head_teacher = 1 WHERE teacher_id = ? AND class_id = ?", teacherId, classId);
      }
    });
  }

  async listTeacherClasses(teacherId: number): Promise<Array<{
    class_id: number; class_name: string; grade_name: string; subject: string | null;
  }>> {
    return await this.db.all(`
      SELECT tc.class_id, c.name as class_name, g.name as grade_name, tc.subject
      FROM teacher_classes tc
      JOIN classes c ON c.id = tc.class_id
      JOIN grades g ON g.id = c.grade_id
      WHERE tc.teacher_id = ? AND c.archived_at IS NULL AND g.archived_at IS NULL
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
      WHERE c.archived_at IS NULL AND g.archived_at IS NULL
      ORDER BY g.sort_order ASC, c.sort_order ASC
    `);
  }
}
