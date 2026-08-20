import { getMysqlDb, buildInsertIgnore } from "../db";
import type { DbAdapter } from "../db";
import { hashPassword, verifyPassword } from "../db";
import { validateInitialPassword, generateRandomInitialPassword } from "../auth/passwordPolicy";
import { encryptField, decryptField } from "../lib/field-crypto";
import crypto from "node:crypto";

export interface UserRecord {
  id: number; username: string; password_hash: string; name: string; role_id: number;
  role_name?: string; role_display_name?: string; student_number: string | null;
  track: string | null;
  subject: string | null; teacher_role: string | null; initial_password: string | null;
  email: string | null; phone: string | null; is_active: number;
  password_change_required: number;
  last_login_at: string | null; created_at: string; updated_at: string;
}

export interface CreateUserParams {
  username: string; password: string; name: string; role_id: number;
  student_number?: string; subject?: string; teacher_role?: string;
  track?: string;
  initial_password?: string; email?: string; phone?: string;
}

export interface UpdateUserParams {
  name?: string; password?: string; email?: string; phone?: string;
  is_active?: number; student_number?: string; role_id?: number; teacher_role?: string | null;
  track?: string | null;
}

export interface BatchStudentInput { username: string; name: string; student_number: string; password?: string; }

export interface BatchImportResult {
  created: number; skipped: number; errors: Array<{ row: BatchStudentInput; message: string }>; createdIds: number[];
}

export class UserRepository {
  private db: DbAdapter;

  constructor() { this.db = getMysqlDb(); }

  async findByUsername(username: string): Promise<UserRecord | null> {
    return await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = ? AND u.is_active = 1`, username);
  }

  async findByStudentNumber(studentNumber: string): Promise<UserRecord | null> {
    return await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.student_number = ? AND u.is_active = 1`, studentNumber);
  }

  async findById(id: number): Promise<UserRecord | null> {
    return await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.is_active = 1`, id);
  }

  async createUser(params: CreateUserParams): Promise<UserRecord> {
    const passwordHash = await hashPassword(params.password);
    const result = await this.db.run(
      `INSERT INTO users (username, password_hash, name, role_id, student_number, track, subject, teacher_role, initial_password, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params.username, passwordHash, params.name, params.role_id, params.student_number ?? null,
      params.track ?? null, params.subject ?? null, params.teacher_role ?? null, encryptField(params.initial_password ?? null),
      params.email ?? null, params.phone ?? null
    );
    return (await this.findById(result.lastInsertRowid))!;
  }

  async updateUser(id: number, params: UpdateUserParams): Promise<UserRecord | null> {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (params.name !== undefined) { updates.push("name = ?"); values.push(params.name); }
    if (params.password !== undefined) { updates.push("password_hash = ?"); values.push(await hashPassword(params.password)); /* initial_password 用于管理员导出/发放密码，密码变更时同步保持可追溯（加密存储，防库泄漏即口令全量暴露） */ updates.push("initial_password = ?"); values.push(encryptField(params.password)); }
    if (params.email !== undefined) { updates.push("email = ?"); values.push(params.email); }
    if (params.phone !== undefined) { updates.push("phone = ?"); values.push(params.phone); }
    if (params.is_active !== undefined) { updates.push("is_active = ?"); values.push(params.is_active); }
    if (params.student_number !== undefined) { updates.push("student_number = ?"); values.push(params.student_number); }
    if (params.track !== undefined) { updates.push("track = ?"); values.push(params.track); }
    if (params.role_id !== undefined) { updates.push("role_id = ?"); values.push(params.role_id); }
    if (params.teacher_role !== undefined) { updates.push("teacher_role = ?"); values.push(params.teacher_role); }
    updates.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id);
    await this.db.run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, ...values);
    return await this.findById(id);
  }

  async deactivateUser(id: number): Promise<void> {
    await this.db.run("UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", id);
  }

  async updateLastLogin(id: number): Promise<void> {
    await this.db.run("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", id);
  }

  async listUsers(page = 1, pageSize = 20, roleName?: string): Promise<{ users: UserRecord[]; total: number }> {
    const offset = (page - 1) * pageSize;
    let where = "WHERE u.is_active = 1";
    const params: unknown[] = [];
    if (roleName) { where += " AND r.name = ?"; params.push(roleName); }
    const users = await this.db.all(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id ${where} ORDER BY u.id ASC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
    const { total } = await this.db.get(`SELECT COUNT(*) as total FROM users u JOIN roles r ON r.id = u.role_id ${where}`, ...params) as { total: number };
    return { users: users as UserRecord[], total };
  }

  async getUserClasses(userId: number): Promise<Array<{ class_id: number; class_name: string; grade_name: string }>> {
    return await this.db.all(`SELECT cs.class_id, c.name as class_name, g.name as grade_name FROM class_students cs JOIN classes c ON c.id = cs.class_id JOIN grades g ON g.id = c.grade_id WHERE cs.student_id = ?`, userId);
  }

  async findByIdIncludingInactive(id: number): Promise<UserRecord | null> {
    return await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, id);
  }

  async usernameExists(username: string): Promise<boolean> {
    const row = await this.db.get("SELECT 1 FROM users WHERE username = ? LIMIT 1", username);
    return Boolean(row);
  }

  async studentNumberExists(studentNumber: string): Promise<boolean> {
    const row = await this.db.get("SELECT 1 FROM users WHERE student_number = ? LIMIT 1", studentNumber);
    return Boolean(row);
  }

  async adminListUsers(options: { page?: number; pageSize?: number; roleName?: string; keyword?: string; includeInactive?: boolean } = {}): Promise<{ users: UserRecord[]; total: number }> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 20;
    const offset = (page - 1) * pageSize;
    let where = "WHERE 1=1";
    const params: unknown[] = [];
    if (!options.includeInactive) where += " AND u.is_active = 1";
    if (options.roleName) { where += " AND r.name = ?"; params.push(options.roleName); }
    if (options.keyword) { where += " AND (u.username LIKE ? OR u.name LIKE ? OR u.student_number LIKE ?)"; const like = `%${options.keyword}%`; params.push(like, like, like); }
    const users = await this.db.all(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id ${where} ORDER BY u.role_id ASC, u.id ASC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
    const { total } = await this.db.get(`SELECT COUNT(*) as total FROM users u JOIN roles r ON r.id = u.role_id ${where}`, ...params) as { total: number };
    return { users: users as UserRecord[], total };
  }

  async reactivateUser(id: number): Promise<void> {
    await this.db.run("UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", id);
  }

  async countByRole(): Promise<Array<{ role_name: string; display_name: string; count: number }>> {
    return await this.db.all(`SELECT r.name as role_name, r.display_name, COUNT(u.id) as count FROM roles r LEFT JOIN users u ON u.role_id = r.id AND u.is_active = 1 GROUP BY r.id ORDER BY r.id ASC`);
  }

  async batchCreateStudents(rows: BatchStudentInput[]): Promise<BatchImportResult> {
    const result: BatchImportResult = { created: 0, skipped: 0, errors: [], createdIds: [] };
    const prepared: Array<{ row: BatchStudentInput; username: string; hash: string; initialPassword: string }> = [];
    for (const row of rows) {
      const username = (row.username || row.student_number || "").trim();
      const studentNumber = (row.student_number || "").trim();
      if (!username || !studentNumber || !row.name) { result.errors.push({ row, message: "缺少用户名/学号/姓名" }); continue; }
      if (await this.usernameExists(username) || await this.studentNumberExists(studentNumber)) { result.skipped++; result.errors.push({ row, message: "用户名或学号已存在" }); continue; }
      // 显式密码优先；缺失时生成不可推导随机初始密码（不再以学号兜底）
      const initialPassword = row.password || generateRandomInitialPassword();
      const passwordError = validateInitialPassword({ password: initialPassword, isStudent: true, studentNumber });
      if (passwordError) { result.errors.push({ row, message: passwordError }); continue; }
      prepared.push({ row: { ...row, username, student_number: studentNumber }, username, hash: await hashPassword(initialPassword), initialPassword });
    }
    await this.db.transaction(async (tx) => {
      for (const item of prepared) {
        try {
          const insertResult = await tx.run("INSERT INTO users (username, password_hash, name, role_id, student_number, initial_password) VALUES (?, ?, ?, 3, ?, ?)", item.username, item.hash, item.row.name, item.row.student_number, encryptField(item.initialPassword));
          result.created++;
          result.createdIds.push(insertResult.lastInsertRowid);
        } catch (err) { result.errors.push({ row: item.row, message: err instanceof Error ? err.message : String(err) }); }
      }
    });
    return result;
  }

  async generateTeacherUsername(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const username = `T${crypto.randomInt(100000, 1000000)}`;
      if (!(await this.usernameExists(username))) return username;
    }
    // 兜底：附加时间戳降低碰撞概率
    return `T${Date.now().toString(36).slice(-6)}${crypto.randomInt(0, 1000)}`;
  }

  generateTeacherPassword(): string {
    return String(crypto.randomInt(100000, 1000000));
  }

  async listTeachers(options: { keyword?: string; page?: number; pageSize?: number } = {}): Promise<{ teachers: UserRecord[]; total: number }> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 50;
    const offset = (page - 1) * pageSize;
    let where = "WHERE u.role_id = 2 AND u.is_active = 1";
    const params: unknown[] = [];
    if (options.keyword) { where += " AND (u.name LIKE ? OR u.username LIKE ? OR u.subject LIKE ?)"; const like = `%${options.keyword}%`; params.push(like, like, like); }
    const teachers = await this.db.all(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id ${where} ORDER BY u.created_at ASC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
    const kw = options.keyword;
    const { total } = await this.db.get(`SELECT COUNT(*) as total FROM users u WHERE u.role_id = 2 AND u.is_active = 1 ${kw ? "AND (u.name LIKE ? OR u.username LIKE ? OR u.subject LIKE ?)" : ""}`, ...(kw ? [`%${kw}%`, `%${kw}%`, `%${kw}%`] : [])) as { total: number };
    return { teachers: teachers as UserRecord[], total };
  }

  async findTeacherById(id: number): Promise<(UserRecord & { classes?: Array<{ class_id: number; class_name: string; grade_name: string; subject: string | null }> }) | null> {
    const teacher = await this.db.get(`SELECT u.*, r.name as role_name, r.display_name as role_display_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.role_id = 2`, id) as UserRecord | null;
    if (!teacher) return null;
    const classes = await this.db.all(`SELECT tc.class_id, c.name as class_name, g.name as grade_name, tc.subject FROM teacher_classes tc JOIN classes c ON c.id = tc.class_id JOIN grades g ON g.id = c.grade_id WHERE tc.teacher_id = ? ORDER BY g.sort_order ASC, c.sort_order ASC`, id);
    return { ...teacher, classes };
  }

  async updateTeacher(id: number, params: { name?: string; subject?: string; password?: string; teacher_role?: string | null }): Promise<UserRecord | null> {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (params.name !== undefined) { updates.push("name = ?"); values.push(params.name); }
    if (params.subject !== undefined) { updates.push("subject = ?"); values.push(params.subject); }
    if (params.teacher_role !== undefined) { updates.push("teacher_role = ?"); values.push(params.teacher_role); }
    if (params.password !== undefined) { updates.push("password_hash = ?"); values.push(await hashPassword(params.password)); /* initial_password 用于管理员导出/发放密码，密码变更时同步（加密存储） */ updates.push("initial_password = ?"); values.push(encryptField(params.password)); }
    updates.push("updated_at = CURRENT_TIMESTAMP"); values.push(id);
    await this.db.run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, ...values);
    return await this.findById(id);
  }

  async listStudentsByClass(classId?: number): Promise<Array<any>> {
    let sql = `SELECT cs.student_id, u.username, u.name, u.student_number, u.track, u.initial_password, c.id as class_id, c.name as class_name, g.id as grade_id, g.name as grade_name, cs.joined_at FROM class_students cs JOIN users u ON u.id = cs.student_id AND u.is_active = 1 JOIN classes c ON c.id = cs.class_id JOIN grades g ON g.id = c.grade_id`;
    const params: unknown[] = [];
    if (classId) { sql += " WHERE cs.class_id = ?"; params.push(classId); }
    sql += " ORDER BY g.sort_order ASC, c.sort_order ASC, u.student_number ASC";
    return await this.db.all(sql, ...params);
  }

  async listAllStudentsForExport(): Promise<Array<any>> {
    return await this.db.all(`SELECT cs.student_id, u.username, u.name, u.student_number, u.initial_password, c.name as class_name, g.name as grade_name FROM class_students cs JOIN users u ON u.id = cs.student_id AND u.is_active = 1 JOIN classes c ON c.id = cs.class_id JOIN grades g ON g.id = c.grade_id ORDER BY g.sort_order ASC, c.sort_order ASC, u.student_number ASC`);
  }

  async listAllTeachersForExport(): Promise<Array<any>> {
    return await this.db.all(`SELECT id, name, username, subject, initial_password FROM users WHERE role_id = 2 AND is_active = 1 ORDER BY created_at ASC`);
  }

  async exportStudentsCsv(): Promise<string> {
    const rows = await this.listAllStudentsForExport();
    const header = "年级,班级,学号,姓名,账号,密码";
    const csvEsc = (v: string | null) => v ? (v.includes(",") ? `"${v}"` : v) : "";
    return "\uFEFF" + [header, ...rows.map((r: any) => [csvEsc(r.grade_name), csvEsc(r.class_name), csvEsc(r.student_number), csvEsc(r.name), csvEsc(r.username), csvEsc(decryptField(r.initial_password))].join(","))].join("\n");
  }

  async exportTeachersCsv(): Promise<string> {
    const teachers = await this.listAllTeachersForExport();
    const header = "科目,姓名,账号,密码";
    const csvEsc = (v: string | null) => v ? (v.includes(",") ? `"${v}"` : v) : "";
    return "\uFEFF" + [header, ...teachers.map((t: any) => [csvEsc(t.subject), csvEsc(t.name), csvEsc(t.username), csvEsc(decryptField(t.initial_password))].join(","))].join("\n");
  }

  async batchImportFromCsv(rows: string[][]): Promise<{
    students: { created: number; linked: number; skipped: number; errors: Array<{ row: string[]; message: string }> };
    teachers: { created: number; skipped: number; errors: Array<{ row: string[]; message: string }> };
  }> {
    const result = { students: { created: 0, linked: 0, skipped: 0, errors: [] as any[] }, teachers: { created: 0, skipped: 0, errors: [] as any[] } };
    if (rows.length < 2) return result;
    const header = rows[0].map(c => c.toLowerCase().replace(/[_\s]+/g, ""));
    const dataRows = rows.slice(1).filter(r => r.some(c => c.trim()));
    const isStudent = header.some((h: string) => /班级|class/.test(h));
    const isTeacher = header.some((h: string) => /科目|subject/.test(h)) && !isStudent;

    if (isStudent) {
      const gradeIdx = header.findIndex((h: string) => /年级|grade/.test(h));
      const classIdx = header.findIndex((h: string) => /班级|class/.test(h));
      const numberIdx = header.findIndex((h: string) => /学号|student_number|考号/.test(h));
      const nameIdx = header.findIndex((h: string) => /姓名|name/.test(h));
      if (classIdx < 0 || numberIdx < 0 || nameIdx < 0) { result.students.errors.push({ row: header, message: "表头不完整" }); return result; }
      const hasSeparateGrade = gradeIdx >= 0;
      const parseGradeFromClass = (cn: string): string => { const m = cn.match(/^(?:高|初|小?)([一二三四五六]+)/); return m ? m[0] : cn; };
      let currentGradeName = "", currentClassName = "";

      for (const row of dataRows) {
        try {
          const rawClassName = (row[classIdx] ?? "").trim();
          let rawGradeName: string;
          if (hasSeparateGrade) { rawGradeName = (row[gradeIdx] ?? "").trim(); if (rawGradeName && rawGradeName !== currentGradeName) { currentGradeName = rawGradeName; if (!rawClassName) currentClassName = ""; } }
          else { rawGradeName = parseGradeFromClass(rawClassName); if (rawGradeName && rawGradeName !== currentGradeName) currentGradeName = rawGradeName; }
          if (rawClassName) currentClassName = rawClassName;
          const gradeName = currentGradeName, className = currentClassName;
          const studentNumber = (row[numberIdx] ?? "").trim(), studentName = (row[nameIdx] ?? "").trim();
          if (!studentNumber && !studentName) continue;
          if (!studentNumber || !studentName) { result.students.errors.push({ row, message: "缺少学号/姓名" }); continue; }
          const username = `P${studentNumber}`, password = generateRandomInitialPassword();
          if (!gradeName || !className) { result.students.errors.push({ row, message: "缺少年级/班级" }); continue; }

          const existingStudent = await this.findByStudentNumber(studentNumber);
          if (existingStudent) {
            if (existingStudent.role_id !== 3) { result.students.skipped++; result.students.errors.push({ row, message: "学号已被非学生账号占用" }); continue; }
            await this.db.transaction(async (tx) => {
              let grade = await tx.get("SELECT id FROM grades WHERE name = ?", gradeName) as { id: number } | null;
              if (!grade) { const gr = await tx.run("INSERT INTO grades (name) VALUES (?)", gradeName); grade = { id: gr.lastInsertRowid }; }
              let cls = await tx.get("SELECT id FROM classes WHERE grade_id = ? AND name = ?", grade.id, className) as { id: number } | null;
              if (!cls) { const cr = await tx.run("INSERT INTO classes (grade_id, name) VALUES (?, ?)", grade.id, className); cls = { id: cr.lastInsertRowid }; }
              await tx.run("UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND role_id = 3", studentName, existingStudent.id);
              const linkSql = buildInsertIgnore(tx.dialect, "class_students", ["class_id", "student_id"]);
              await tx.run(linkSql, cls.id, existingStudent.id);
            });
            result.students.linked++; continue;
          }

          if (await this.usernameExists(username) || await this.studentNumberExists(studentNumber)) { result.students.skipped++; result.students.errors.push({ row, message: "用户名或学号已存在" }); continue; }
          const hash = await hashPassword(password);

          await this.db.transaction(async (tx) => {
            let grade = await tx.get("SELECT id FROM grades WHERE name = ?", gradeName) as { id: number } | null;
            if (!grade) { const gr = await tx.run("INSERT INTO grades (name) VALUES (?)", gradeName); grade = { id: gr.lastInsertRowid }; }
            let cls = await tx.get("SELECT id FROM classes WHERE grade_id = ? AND name = ?", grade.id, className) as { id: number } | null;
            if (!cls) { const cr = await tx.run("INSERT INTO classes (grade_id, name) VALUES (?, ?)", grade.id, className); cls = { id: cr.lastInsertRowid }; }
            const ins = await tx.run("INSERT INTO users (username, password_hash, name, role_id, student_number, initial_password) VALUES (?, ?, ?, 3, ?, ?)", username, hash, studentName, studentNumber, encryptField(password));
            const linkSql = buildInsertIgnore(tx.dialect, "class_students", ["class_id", "student_id"]);
            await tx.run(linkSql, cls.id, ins.lastInsertRowid);
          });
          result.students.created++;
        } catch (err) { result.students.errors.push({ row, message: err instanceof Error ? err.message : String(err) }); }
      }
    } else if (isTeacher) {
      const subjectIdx = header.findIndex((h: string) => /科目|subject/.test(h));
      const nameIdx = header.findIndex((h: string) => /姓名|name/.test(h));
      if (subjectIdx < 0 || nameIdx < 0) { result.teachers.errors.push({ row: header, message: "表头不完整" }); return result; }
      for (const row of dataRows.filter(r => r[nameIdx]?.trim() || r[subjectIdx]?.trim())) {
        try {
          const subject = (row[subjectIdx] ?? "").trim(), teacherName = (row[nameIdx] ?? "").trim();
          if (!subject || !teacherName) { result.teachers.errors.push({ row, message: "缺少科目或姓名" }); continue; }
          const username = await this.generateTeacherUsername(), password = this.generateTeacherPassword();
          await this.db.run("INSERT INTO users (username, password_hash, name, role_id, subject, initial_password) VALUES (?, ?, ?, 2, ?, ?)", username, await hashPassword(password), teacherName, subject, encryptField(password));
          result.teachers.created++;
        } catch (err) { result.teachers.errors.push({ row, message: err instanceof Error ? err.message : String(err) }); }
      }
    } else { result.students.errors.push({ row: header, message: "无法识别 CSV 类型" }); }
    return result;
  }
}
