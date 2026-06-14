import { getDatabase } from "../db";
import Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "../db";

export interface UserRecord {
  id: number;
  username: string;
  password_hash: string;
  name: string;
  role_id: number;
  role_name?: string;
  role_display_name?: string;
  student_number: string | null;
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
      INSERT INTO users (username, password_hash, name, role_id, student_number, email, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      params.username,
      passwordHash,
      params.name,
      params.role_id,
      params.student_number ?? null,
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
    const result: BatchImportResult = { created: 0, skipped: 0, errors: [] };

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
      const hash = await hashPassword(row.password || studentNumber);
      prepared.push({ row: { ...row, username, student_number: studentNumber }, username, hash });
    }

    const insert = this.db.prepare(`
      INSERT INTO users (username, password_hash, name, role_id, student_number)
      VALUES (?, ?, ?, 3, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const item of prepared) {
        try {
          insert.run(item.username, item.hash, item.row.name, item.row.student_number);
          result.created++;
        } catch (err) {
          result.errors.push({ row: item.row, message: err instanceof Error ? err.message : String(err) });
        }
      }
    });
    tx();

    return result;
  }
}
