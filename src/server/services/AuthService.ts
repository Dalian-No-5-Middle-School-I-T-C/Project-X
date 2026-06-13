import { UserRepository, type UserRecord } from "../repositories/UserRepository";
import { verifyPassword, hashPassword, getDatabase } from "../db";
import { permissionsForRole } from "../auth/permissions";
import { randomBytes } from "node:crypto";

export interface LoginResult {
  success: boolean;
  user?: Omit<UserRecord, "password_hash">;
  token?: string;
  permissions?: string[];
  message?: string;
}

export interface ChangePasswordResult {
  success: boolean;
  message: string;
}

/**
 * 简单的 token 存储（生产环境应使用 Redis 或 JWT）
 * key: token, value: { userId, expiresAt }
 */
const tokenStore = new Map<string, { userId: number; expiresAt: number }>();

const TOKEN_EXPIRE_MS = 8 * 60 * 60 * 1000; // 8小时

export class AuthService {
  private userRepo: UserRepository;

  constructor() {
    this.userRepo = new UserRepository();
  }

  /**
   * 用户登录
   * 支持用户名（学号/职工号）或邮箱登录
   */
  async login(identifier: string, password: string): Promise<LoginResult> {
    // 查找用户（支持 username 或 student_number 或 email）
    let user = this.userRepo.findByUsername(identifier);

    if (!user && /^\d+$/.test(identifier)) {
      // 纯数字，尝试学号
      user = this.userRepo.findByStudentNumber(identifier);
    }

    if (!user) {
      return { success: false, message: "用户名或密码错误" };
    }

    // 验证密码
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return { success: false, message: "用户名或密码错误" };
    }

    // 更新最后登录时间
    this.userRepo.updateLastLogin(user.id);

    // 生成 token
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + TOKEN_EXPIRE_MS;
    tokenStore.set(token, { userId: user.id, expiresAt });

    // 清除敏感信息
    const { password_hash, ...safeUser } = user;

    return {
      success: true,
      user: safeUser,
      token,
      permissions: permissionsForRole(user.role_id),
      message: "登录成功"
    };
  }

  /**
   * 修改密码（需校验原密码）。
   * 任何已登录用户均可修改自己的密码。
   */
  async changePassword(userId: number, oldPassword: string, newPassword: string): Promise<ChangePasswordResult> {
    if (!newPassword || newPassword.length < 6) {
      return { success: false, message: "新密码长度至少 6 位" };
    }

    const db = getDatabase();
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
      | { password_hash: string }
      | undefined;
    if (!row) {
      return { success: false, message: "用户不存在" };
    }

    // 默认管理员首次创建时 password_hash 为占位（学生自动建账场景），允许空原密码
    if (row.password_hash) {
      const valid = await verifyPassword(oldPassword, row.password_hash);
      if (!valid) {
        return { success: false, message: "原密码错误" };
      }
    }

    const newHash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newHash, userId);

    // 安全起见：改密后吊销该用户的所有其它会话
    this.revokeUserTokens(userId);
    return { success: true, message: "密码修改成功，请使用新密码重新登录" };
  }

  /**
   * 吊销指定用户的所有 token（改密 / 禁用账号时调用）。
   */
  revokeUserTokens(userId: number): void {
    for (const [token, record] of tokenStore.entries()) {
      if (record.userId === userId) {
        tokenStore.delete(token);
      }
    }
  }

  /**
   * 验证 token
   */
  verifyToken(token: string): { userId: number } | null {
    const record = tokenStore.get(token);
    if (!record) return null;

    if (Date.now() > record.expiresAt) {
      tokenStore.delete(token);
      return null;
    }

    return { userId: record.userId };
  }

  /**
   * 根据 token 获取用户
   */
  getUserByToken(token: string): Omit<UserRecord, "password_hash"> | null {
    const record = this.verifyToken(token);
    if (!record) return null;

    const user = this.userRepo.findById(record.userId);
    if (!user) return null;

    const { password_hash, ...safeUser } = user;
    return safeUser;
  }

  /**
   * 退出登录
   */
  logout(token: string): void {
    tokenStore.delete(token);
  }

  /**
   * 清理过期 token（定时执行）
   */
  cleanupExpiredTokens(): void {
    const now = Date.now();
    for (const [token, record] of tokenStore.entries()) {
      if (now > record.expiresAt) {
        tokenStore.delete(token);
      }
    }
  }
}
