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
}
