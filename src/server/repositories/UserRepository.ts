import { getDatabase } from "../db";
import Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "../db";
import { validateInitialPassword } from "../auth/passwordPolicy";
import crypto from "node:crypto";

export interface UserRecord {
  id: number;
  username: string;
  password_hash: string;
  name: string;
  role_id: number;
  role_name?: string;
  role_display_name?: string;
  student_number: string | null;
  subject: string | null;
  initial_password: string | null;
  email: string | null;
  phone: string | null;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateUserParams {
  username: string;
  password: string;
  name: string;
  role_id: number;
  student_number?: string;
  subject?: string;
  initial_password?: string;
  email?: string;
  phone?: string;
}

export interface UpdateUserParams {
  name?: string;
  password?: string;
  email?: string;
  phone?: string;
  is_active?: number;
  student_number?: string;
  role_id?: number;
}

export interface BatchStudentInput {
  username: string;
  name: string;
  student_number: string;
  password?: string;
}

export interface BatchImportResult {
  created: number;
  skipped: number;
  errors: Array<{ row: BatchStudentInput; message: string }>;
  createdIds: number[];
}

export class UserRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * 根据用户名查找用户（含角色信息）
   */
  findByUsername(username: string): UserRecord | null {
    const stmt = this.db.prepare(`
      SELECT u.*, r.name as role_name, r.display_name as role_display_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.username = ? AND u.is_active = 1
    `);
    return stmt.get(username) as UserRecord | null;
  }

  /**
   * 根据学号查找学生
   */
  findByStudentNumber(studentNumber: string): UserRecord | null {
    const stmt = this.db.prepare(`
      SELECT u.*, r.name as role_name, r.display_name as role_display_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.student_number = ? AND u.is_active = 1
    `);
    return stmt.get(studentNumber) as UserRecord | null;
  }

  /**
   * 根据 ID 查找用户
   */
  findById(id: number): UserRecord | null {
    const stmt = this.db.prepare(`
      SELECT u.*, r.name as role_name, r.display_name as role_display_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND u.is_active = 1
    `);
    return stmt.get(id) as UserRecord | null;
  }

  /**
   * 创建用户（密码自动哈希）
   */
  async createUser(params: CreateUserParams): Promise<UserRecord> {
    const passwordHash = await hashPassword(params.password);
    const stmt = this.db.prepare(`
      INSERT INTO users (username, password_hash, name, role_id, student_number, subject, initial_password, email, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      params.username,
      passwordHash,
      params.name,
      params.role_id,
      params.student_number ?? null,
      params.subject ?? null,
      params.initial_password ?? null,
      params.email ?? null,
      params.phone ?? null
    );
    return this.findById(result.lastInsertRowid as number)!;
  }

  /**
   * 更新用户
   */
  async updateUser(id: number, params: UpdateUserParams): Promise<UserRecord | null> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (params.name !== undefined) { updates.push("name = ?"); values.push(params.name); }
    if (params.password !== undefined) {
      const hash = await hashPassword(params.password);
      updates.push("password_hash = ?");
      values.push(hash);
    }
    if (params.email !== undefined) { updates.push("email = ?"); values.push(params.email); }
    if (params.phone !== undefined) { updates.push("phone = ?"); values.push(params.phone); }
    if (params.is_active !== undefined) { updates.push("is_active = ?"); values.push(params.is_active); }
    if (params.student_number !== undefined) { updates.push("student_number = ?"); values.push(params.student_number); }
    if (params.role_id !== undefined) { updates.push("role_id = ?"); values.push(params.role_id); }

    updates.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id);

    const stmt = this.db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`);
    stmt.run(...values);
    return this.findById(id);
  }

  /**
   * 禁用用户（软删除）
   */
  deactivateUser(id: number): void {
    this.db.prepare("UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }

  /**
   * 更新最后登录时间
   */
  updateLastLogin(id: number): void {
    this.db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }

  /**
   * 列出所有用户（分页）
   */
  listUsers(page: number = 1, pageSize: number = 20, roleName?: string): { users: UserRecord[]; total: number } {
    const offset = (page - 1) * pageSize;
    let where = "WHERE u.is_active = 1";
    const params: unknown[] = [];

    if (roleName) {
      where += " AND r.name = ?";
      params.push(roleName);
    }

    const users = this.db.prepare(`
      SELECT u.*, r.name as role_name, r.display_name as role_display_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      ${where}
      ORDER BY u.id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as UserRecord[];

    const { total } = this.db.prepare(`
      SELECT COUNT(*) as total
      FROM users u
      JOIN roles r ON r.id = u.role_id
      ${where}
    `).get(...params) as { total: number };

    return { users, total };
  }

  /**
   * 获取用户的班级信息
   */
  getUserClasses(userId: number): Array<{ class_id: number; class_name: string; grade_name: string }> {
    const stmt = this.db.prepare(`
      SELECT cs.class_id, c.name as class_name, g.name as grade_name
      FROM class_students cs
      JOIN classes c ON c.id = cs.class_id
      JOIN grades g ON g.id = c.grade_id
      WHERE cs.student_id = ?
    `);
    return stmt.all(userId) as Array<{ class_id: number; class_name: string; grade_name: string }>;
  }

  // ──────────────────────────────────────────────────────────
  // 管理员管理方法（可见禁用账号、改角色、批量导入）
  // ──────────────────────────────────────────────────────────

  /**
   * 根据 ID 查找用户（含已禁用账号，供管理员管理使用）
   */
  findByIdIncludingInactive(id: number): UserRecord | null {
    const stmt = this.db.prepare(`
      SELECT u.*, r.name as role_name, r.display_name as role_display_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?
    `);
    return (stmt.get(id) as UserRecord | null) ?? null;
  }

  /** 用户名是否已存在 */
  usernameExists(username: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM users WHERE username = ? LIMIT 1").get(username);
    return Boolean(row);
  }

  /** 学号是否已存在 */
  studentNumberExists(studentNumber: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM users WHERE student_number = ? LIMIT 1").get(studentNumber);
    return Boolean(row);
  }

  /**
   * 管理员列表用户：支持搜索关键字、是否包含禁用账号。
   */
  adminListUsers(options: {
    page?: number;
    pageSize?: number;
    roleName?: string;
    keyword?: string;
    includeInactive?: boolean;
  } = {}): { users: UserRecord[]; total: number } {
    const page = options.page && options.page > 0 ? options.page : 1;
    const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 20;
    const offset = (page - 1) * pageSize;

    let where = "WHERE 1=1";
    const params: unknown[] = [];

    if (!options.includeInactive) {
      where += " AND u.is_active = 1";
    }
    if (options.roleName) {
      where += " AND r.name = ?";
      params.push(options.roleName);
    }
    if (options.keyword) {
      where += " AND (u.username LIKE ? OR u.name LIKE ? OR u.student_number LIKE ?)";
      const like = `%${options.keyword}%`;
      params.push(like, like, like);
    }

    const users = this.db.prepare(`
      SELECT u.*, r.name as role_name, r.display_name as role_display_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      ${where}
      ORDER BY u.role_id ASC, u.id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as UserRecord[];

    const { total } = this.db.prepare(`
      SELECT COUNT(*) as total
      FROM users u
      JOIN roles r ON r.id = u.role_id
      ${where}
    `).get(...params) as { total: number };

    return { users, total };
  }

  /** 重新启用被禁用的账号 */
  reactivateUser(id: number): void {
    this.db.prepare("UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }

  /** 角色统计（用于管理仪表盘） */
  countByRole(): Array<{ role_name: string; display_name: string; count: number }> {
    return this.db.prepare(`
      SELECT r.name as role_name, r.display_name, COUNT(u.id) as count
      FROM roles r
      LEFT JOIN users u ON u.role_id = r.id AND u.is_active = 1
      GROUP BY r.id
      ORDER BY r.id ASC
    `).all() as Array<{ role_name: string; display_name: string; count: number }>;
  }

  /**
   * 批量导入学生（事务）。username 默认取 student_number，密码默认取 student_number。
   * 已存在的用户名/学号会被跳过并记录到 errors。
   */
  async batchCreateStudents(rows: BatchStudentInput[]): Promise<BatchImportResult> {
    const result: BatchImportResult = { created: 0, skipped: 0, errors: [], createdIds: [] };

    // 预先计算所有密码哈希（hash 为异步，不能放进同步事务）
    const prepared: Array<{ row: BatchStudentInput; username: string; hash: string }> = [];
    for (const row of rows) {
      const username = (row.username || row.student_number || "").trim();
      const studentNumber = (row.student_number || "").trim();
      if (!username || !studentNumber || !row.name) {
        result.errors.push({ row, message: "缺少用户名/学号/姓名" });
        continue;
      }
      if (this.usernameExists(username) || this.studentNumberExists(studentNumber)) {
        result.skipped++;
        result.errors.push({ row, message: "用户名或学号已存在，已跳过" });
        continue;
      }
      const initialPassword = row.password || studentNumber;
      const passwordError = validateInitialPassword({
        password: initialPassword,
        isStudent: true,
        studentNumber
      });
      if (passwordError) {
        result.errors.push({ row, message: passwordError });
        continue;
      }
      const hash = await hashPassword(initialPassword);
      prepared.push({ row: { ...row, username, student_number: studentNumber }, username, hash });
    }

    const insert = this.db.prepare(`
      INSERT INTO users (username, password_hash, name, role_id, student_number, initial_password)
      VALUES (?, ?, ?, 3, ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const item of prepared) {
        try {
          const initPwd = item.row.password || item.row.student_number;
          const insertResult = insert.run(item.username, item.hash, item.row.name, item.row.student_number, initPwd);
          result.created++;
          result.createdIds.push(Number(insertResult.lastInsertRowid));
        } catch (err) {
          result.errors.push({ row: item.row, message: err instanceof Error ? err.message : String(err) });
        }
      }
    });
    tx();

    return result;
  }

  // ──────────────────────────────────────────────────────────
  // v1.1.0: 教师管理 / 学生导出 / CSV 批量导入
  // ──────────────────────────────────────────────────────────

  /** 生成教师用户名: T + 6位随机数，查重重试 */
  generateTeacherUsername(): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      const num = crypto.randomInt(100000, 1000000);
      const username = `T${num}`;
      if (!this.usernameExists(username)) return username;
    }
    return `T${Date.now().toString(36).slice(-6)}${crypto.randomInt(0, 1000)}`;
  }

  /** 生成教师密码: 6位随机数字 */
  generateTeacherPassword(): string {
    return String(crypto.randomInt(100000, 1000000));
  }

  /** 获取教师列表（按创建时间升序） */
  listTeachers(options: {
    keyword?: string;
    page?: number;
    pageSize?: number;
  } = {}): { teachers: UserRecord[]; total: number } {
    const page = options.page && options.page > 0 ? options.page : 1;
    const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 50;
    const offset = (page - 1) * pageSize;

    let where = "WHERE u.role_id = 2 AND u.is_active = 1";
    const params: unknown[] = [];

    if (options.keyword) {
      where += " AND (u.name LIKE ? OR u.username LIKE ? OR u.subject LIKE ?)";
      const like = `%${options.keyword}%`;
      params.push(like, like, like);
    }

    const teachers = this.db.prepare(`
      SELECT u.*, r.name as role_name, r.display_name as role_display_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      ${where}
      ORDER BY u.created_at ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as UserRecord[];

    const { total } = this.db.prepare(`
      SELECT COUNT(*) as total FROM users u WHERE u.role_id = 2 AND u.is_active = 1
      ${options.keyword ? "AND (u.name LIKE ? OR u.username LIKE ? OR u.subject LIKE ?)" : ""}
    `).get(...(options.keyword ? [`%${options.keyword}%`, `%${options.keyword}%`, `%${options.keyword}%`] : [])) as { total: number };

    return { teachers, total };
  }

  /** 根据 ID 查找教师（包含关联班级信息） */
  findTeacherById(id: number): (UserRecord & { classes?: Array<{ class_id: number; class_name: string; grade_name: string; subject: string | null }> }) | null {
    const teacher = this.db.prepare(`
      SELECT u.*, r.name as role_name, r.display_name as role_display_name
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND u.role_id = 2
    `).get(id) as UserRecord | null;
    if (!teacher) return null;

    const classes = this.db.prepare(`
      SELECT tc.class_id, c.name as class_name, g.name as grade_name, tc.subject
      FROM teacher_classes tc
      JOIN classes c ON c.id = tc.class_id
      JOIN grades g ON g.id = c.grade_id
      WHERE tc.teacher_id = ?
      ORDER BY g.sort_order ASC, c.sort_order ASC
    `).all(id) as Array<{ class_id: number; class_name: string; grade_name: string; subject: string | null }>;

    return { ...teacher, classes };
  }

  /** 更新教师（含任教科目） */
  async updateTeacher(id: number, params: { name?: string; subject?: string; password?: string }): Promise<UserRecord | null> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (params.name !== undefined) { updates.push("name = ?"); values.push(params.name); }
    if (params.subject !== undefined) { updates.push("subject = ?"); values.push(params.subject); }
    if (params.password !== undefined) {
      const hash = await hashPassword(params.password);
      updates.push("password_hash = ?"); values.push(hash);
      updates.push("initial_password = ?"); values.push(params.password);
    }
    updates.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id);

    this.db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  /** 按班级分组查询学生（含年级/班级上下文） */
  listStudentsByClass(classId?: number): Array<{
    student_id: number;
    username: string;
    name: string;
    student_number: string | null;
    initial_password: string | null;
    class_id: number;
    class_name: string;
    grade_id: number;
    grade_name: string;
    joined_at: string;
  }> {
    let sql = `
      SELECT cs.student_id, u.username, u.name, u.student_number, u.initial_password,
             c.id as class_id, c.name as class_name, g.id as grade_id, g.name as grade_name,
             cs.joined_at
      FROM class_students cs
      JOIN users u ON u.id = cs.student_id AND u.is_active = 1
      JOIN classes c ON c.id = cs.class_id
      JOIN grades g ON g.id = c.grade_id
    `;
    const params: unknown[] = [];
    if (classId) {
      sql += " WHERE cs.class_id = ?";
      params.push(classId);
    }
    sql += " ORDER BY g.sort_order ASC, c.sort_order ASC, u.student_number ASC";
    return this.db.prepare(sql).all(...params) as any[];
  }

  /** 按年级分组查询所有学生（用于导出） */
  listAllStudentsForExport(): Array<{
    student_id: number;
    username: string;
    name: string;
    student_number: string | null;
    initial_password: string | null;
    class_name: string;
    grade_name: string;
  }> {
    return this.db.prepare(`
      SELECT cs.student_id, u.username, u.name, u.student_number, u.initial_password,
             c.name as class_name, g.name as grade_name
      FROM class_students cs
      JOIN users u ON u.id = cs.student_id AND u.is_active = 1
      JOIN classes c ON c.id = cs.class_id
      JOIN grades g ON g.id = c.grade_id
      ORDER BY g.sort_order ASC, c.sort_order ASC, u.student_number ASC
    `).all() as any[];
  }

  /** 导出所有教师（用于导出 CSV） */
  listAllTeachersForExport(): Array<{
    id: number;
    name: string;
    username: string;
    subject: string | null;
    initial_password: string | null;
  }> {
    return this.db.prepare(`
      SELECT id, name, username, subject, initial_password
      FROM users
      WHERE role_id = 2 AND is_active = 1
      ORDER BY created_at ASC
    `).all() as any[];
  }

  /**
   * 统一 CSV 批量导入：自动识别表头，分学生/教师两组处理。
   * 学生：自动建年级/班级，账号=P+学号，密码=账号。
   * 教师：账号=T+随机6位，密码=随机6位。
   */
  async batchImportFromCsv(
    rows: string[][]
  ): Promise<{
    students: { created: number; linked: number; skipped: number; errors: Array<{ row: string[]; message: string }> };
    teachers: { created: number; skipped: number; errors: Array<{ row: string[]; message: string }> };
  }> {
    const result = {
      students: { created: 0, linked: 0, skipped: 0, errors: [] as Array<{ row: string[]; message: string }> },
      teachers: { created: 0, skipped: 0, errors: [] as Array<{ row: string[]; message: string }> }
    };

    if (rows.length < 2) return result;

    const header = rows[0].map((c) => c.toLowerCase().replace(/[_\s]+/g, ""));
    const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim()));

    // 检测 CSV 类型
    const isStudent = header.some((h) => /年级|grade/.test(h)) || header.some((h) => /班级|class/.test(h));
    const isTeacher = header.some((h) => /科目|subject/.test(h)) && !header.some((h) => /班级|class|年级|grade/.test(h));

    if (isStudent) {
      const gradeIdx = header.findIndex((h) => /年级|grade/.test(h));
      const classIdx = header.findIndex((h) => /班级|class/.test(h));
      const numberIdx = header.findIndex((h) => /学号|student_number|考号/.test(h));
      const nameIdx = header.findIndex((h) => /姓名|name/.test(h));

      if (gradeIdx < 0 || classIdx < 0 || numberIdx < 0 || nameIdx < 0) {
        result.students.errors.push({ row: header, message: "表头不完整，需含：年级,班级,学号,姓名" });
        return result;
      }

      let currentGradeName = "";
      let currentClassName = "";

      for (const row of dataRows) {
        try {
          const rawGradeName = (row[gradeIdx] ?? "").trim();
          const rawClassName = (row[classIdx] ?? "").trim();
          if (rawGradeName && rawGradeName !== currentGradeName) {
            currentGradeName = rawGradeName;
            if (!rawClassName) currentClassName = "";
          }
          if (rawClassName) currentClassName = rawClassName;

          const gradeName = currentGradeName;
          const className = currentClassName;
          const studentNumber = (row[numberIdx] ?? "").trim();
          const studentName = (row[nameIdx] ?? "").trim();

          if (!studentNumber && !studentName) {
            continue;
          }
          if (!studentNumber || !studentName) {
            result.students.errors.push({ row, message: "缺少学号/姓名" });
            continue;
          }

          const username = `P${studentNumber}`;
          const password = username; // 密码=账号

          if (!gradeName || !className) {
            result.students.errors.push({ row, message: "缺少年级/班级/学号" });
            continue;
          }

          const existingStudent = this.findByStudentNumber(studentNumber);
          if (existingStudent) {
            if (existingStudent.role_id !== 3) {
              result.students.skipped++;
              result.students.errors.push({ row, message: "学号已被非学生账号占用" });
              continue;
            }

            this.db.transaction(() => {
              let grade = this.db.prepare("SELECT id FROM grades WHERE name = ?").get(gradeName) as { id: number } | undefined;
              if (!grade) {
                const gr = this.db.prepare("INSERT INTO grades (name) VALUES (?)").run(gradeName);
                grade = { id: Number(gr.lastInsertRowid) };
              }

              let cls = this.db.prepare("SELECT id FROM classes WHERE grade_id = ? AND name = ?").get(grade.id, className) as { id: number } | undefined;
              if (!cls) {
                const cr = this.db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, ?)").run(grade.id, className);
                cls = { id: Number(cr.lastInsertRowid) };
              }

              this.db.prepare("UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND role_id = 3")
                .run(studentName, existingStudent.id);
              this.db.prepare("INSERT OR IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)")
                .run(cls.id, existingStudent.id);
            })();

            result.students.linked++;
            continue;
          }

          if (this.usernameExists(username) || this.studentNumberExists(studentNumber)) {
            result.students.skipped++;
            result.students.errors.push({ row, message: "用户名或学号已存在，但未找到可关联的有效学生" });
            continue;
          }

          const hash = await hashPassword(password);

          // 在事务中完成
          this.db.transaction(() => {
            // 1) 确保年级存在
            let grade = this.db.prepare("SELECT id FROM grades WHERE name = ?").get(gradeName) as { id: number } | undefined;
            if (!grade) {
              const gr = this.db.prepare("INSERT INTO grades (name) VALUES (?)").run(gradeName);
              grade = { id: Number(gr.lastInsertRowid) };
            }

            // 2) 确保班级存在
            let cls = this.db.prepare("SELECT id FROM classes WHERE grade_id = ? AND name = ?").get(grade.id, className) as { id: number } | undefined;
            if (!cls) {
              const cr = this.db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, ?)").run(grade.id, className);
              cls = { id: Number(cr.lastInsertRowid) };
            }

            // 3) 创建学生
            const ins = this.db.prepare(`
              INSERT INTO users (username, password_hash, name, role_id, student_number, initial_password)
              VALUES (?, ?, ?, 3, ?, ?)
            `).run(username, hash, studentName, studentNumber, password);
            const studentId = Number(ins.lastInsertRowid);

            // 4) 加入班级
            this.db.prepare("INSERT OR IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)")
              .run(cls.id, studentId);
          })();

          result.students.created++;
        } catch (err) {
          result.students.errors.push({ row, message: err instanceof Error ? err.message : String(err) });
        }
      }
    } else if (isTeacher) {
      const subjectIdx = header.findIndex((h) => /科目|subject/.test(h));
      const nameIdx = header.findIndex((h) => /姓名|name/.test(h));

      if (subjectIdx < 0 || nameIdx < 0) {
        result.teachers.errors.push({ row: header, message: "表头不完整，需含：科目,姓名" });
        return result;
      }

      const validRows = dataRows.filter((r) => r[nameIdx]?.trim() || r[subjectIdx]?.trim());

      for (const row of validRows) {
        try {
          const subject = (row[subjectIdx] ?? "").trim();
          const teacherName = (row[nameIdx] ?? "").trim();

          if (!subject || !teacherName) {
            result.teachers.errors.push({ row, message: "缺少科目或姓名" });
            continue;
          }

          const username = this.generateTeacherUsername();
          const password = this.generateTeacherPassword();
          const hash = await hashPassword(password);

          this.db.prepare(`
            INSERT INTO users (username, password_hash, name, role_id, subject, initial_password)
            VALUES (?, ?, ?, 2, ?, ?)
          `).run(username, hash, teacherName, subject, password);

          result.teachers.created++;
        } catch (err) {
          result.teachers.errors.push({ row, message: err instanceof Error ? err.message : String(err) });
        }
      }
    } else {
      result.students.errors.push({ row: header, message: "无法识别 CSV 类型（学生需含年级/班级列，教师需含科目列）" });
    }

    return result;
  }

  /** 导出学生 CSV 字符串（UTF-8 BOM） */
  exportStudentsCsv(): string {
    const rows = this.listAllStudentsForExport();
    const header = "年级,班级,学号,姓名,账号,密码";
    const lines = [header];
    for (const r of rows) {
      const csvEsc = (v: string | null) => v ? (v.includes(",") ? `"${v}"` : v) : "";
      lines.push([
        csvEsc(r.grade_name),
        csvEsc(r.class_name),
        csvEsc(r.student_number),
        csvEsc(r.name),
        csvEsc(r.username),
        csvEsc(r.initial_password)
      ].join(","));
    }
    return "\uFEFF" + lines.join("\n");
  }

  /** 导出教师 CSV 字符串（UTF-8 BOM） */
  exportTeachersCsv(): string {
    const teachers = this.listAllTeachersForExport();
    const header = "科目,姓名,账号,密码";
    const lines = [header];
    for (const t of teachers) {
      const csvEsc = (v: string | null) => v ? (v.includes(",") ? `"${v}"` : v) : "";
      lines.push([
        csvEsc(t.subject),
        csvEsc(t.name),
        csvEsc(t.username),
        csvEsc(t.initial_password)
      ].join(","));
    }
    return "\uFEFF" + lines.join("\n");
  }
}
