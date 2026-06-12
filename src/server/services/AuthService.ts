import { UserRepository, type UserRecord } from "../repositories/UserRepository";
import { verifyPassword } from "../db";
import { randomBytes } from "node:crypto";

export interface LoginResult {
  success: boolean;
  user?: Omit<UserRecord, "password_hash">;
  token?: string;
  message?: string;
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
      message: "登录成功"
    };
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
