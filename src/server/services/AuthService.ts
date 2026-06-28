import { UserRepository, type UserRecord } from "../repositories/UserRepository";
import { verifyPassword, hashPassword, getDatabase } from "../db";
import { permissionsForRole } from "../auth/permissions";
import { validateUserChosenPassword } from "../auth/passwordPolicy";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

interface TokenRecord {
  userId: number;
  expiresAt: number;
}

const TOKEN_STORE_DIR = join(homedir(), ".projectx");
const TOKEN_STORE_PATH = join(TOKEN_STORE_DIR, "tokens.json");

const TOKEN_EXPIRE_MS = 8 * 60 * 60 * 1000; // 8小时
const PERSISTENT_TOKEN_EXPIRE_MS = 180 * 24 * 60 * 60 * 1000; // 6个月

export class AuthService {
  private userRepo?: UserRepository;
  private tokenStore = new Map<string, TokenRecord>();
  private saveScheduled = false;
  private initialized = false;

  constructor() {
    // 轻量构造——不要在这里做 IO/DB 操作
  }

  /**
   * 显式初始化：在保证环境（DB 文件 / env）就绪后调用。
   * 可多次调用（幂等）。
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    // 创建依赖（UserRepository 会间接触发 DB 适配器）
    this.userRepo = new UserRepository();
    // 从磁盘加载持久化 tokens（保持原有同步行为）
    this.loadTokens();
    this.initialized = true;
  }

  /** 确保已初始化（否则给出友好错误） */
  private ensureInitialized(): void {
    if (!this.initialized || !this.userRepo) {
      throw new Error("AuthService 未初始化：请在使用前调用 authService.init()");
    }
  }

  /** 从磁盘加载持久化 tokens */
  private loadTokens(): void {
    try {
      if (!existsSync(TOKEN_STORE_PATH)) return;
      const raw = readFileSync(TOKEN_STORE_PATH, "utf8");
      const data = JSON.parse(raw) as { tokens: Record<string, TokenRecord> };
      const now = Date.now();
      for (const [token, record] of Object.entries(data.tokens ?? {})) {
        if (record.expiresAt > now) {
          this.tokenStore.set(token, record);
        }
      }
      console.log(`[Auth] 从磁盘加载了 ${this.tokenStore.size} 个有效 token`);
    } catch (error) {
      console.error("[Auth] 加载持久化 token 失败:", error);
    }
  }

  /** 异步保存 tokens 到磁盘（合并短时间内的多次写入） */
  private scheduleSave(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setImmediate(() => {
      this.saveScheduled = false;
      this.persistTokens();
    });
  }

  private persistTokens(): void {
    try {
      if (!existsSync(TOKEN_STORE_DIR)) {
        mkdirSync(TOKEN_STORE_DIR, { recursive: true });
      }
      const data: { tokens: Record<string, TokenRecord> } = { tokens: {} };
      for (const [token, record] of this.tokenStore.entries()) {
        data.tokens[token] = record;
      }
      writeFileSync(TOKEN_STORE_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.error("[Auth] 持久化 token 失败:", error);
    }
  }

  /**
   * 用户登录
   * 支持用户名（学号/职工号）或邮箱登录
   */
  async login(identifier: string, password: string, isPersistent = false): Promise<LoginResult> {
    this.ensureInitialized();
    // 查找用户（支持 username 或 student_number 或 email）
    let user = await this.userRepo!.findByUsername(identifier);

    if (!user && /^\d+$/.test(identifier)) {
      // 纯数字，尝试学号
      user = await this.userRepo!.findByStudentNumber(identifier);
    }

    if (!user) {
      return { success: false, message: "用户名或密码错误" };
    }

    // 验证密码。兼容旧流程留下的学生空密码哈希：首次用学号登录时自动补齐为学号密码。
    let valid = false;
    if (!user.password_hash && user.role_name === "student" && user.student_number && password === user.student_number) {
      const newHash = await hashPassword(user.student_number);
      const db = getDatabase();
      db.prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newHash, user.id);
      user.password_hash = newHash;
      valid = true;
    } else {
      valid = await verifyPassword(password, user.password_hash);
    }
    if (!valid) {
      return { success: false, message: "用户名或密码错误" };
    }

    // 更新最后登录时间
    await this.userRepo!.updateLastLogin(user.id);

    // 生成 token
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + (isPersistent ? PERSISTENT_TOKEN_EXPIRE_MS : TOKEN_EXPIRE_MS);
    this.tokenStore.set(token, { userId: user.id, expiresAt });
    this.scheduleSave();

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
    const passwordError = validateUserChosenPassword(newPassword);
    if (passwordError) return { success: false, message: passwordError };

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
    let changed = false;
    for (const [token, record] of this.tokenStore.entries()) {
      if (record.userId === userId) {
        this.tokenStore.delete(token);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  /**
   * 验证 token
   */
  verifyToken(token: string): { userId: number } | null {
    const record = this.tokenStore.get(token);
    if (!record) return null;

    if (Date.now() > record.expiresAt) {
      this.tokenStore.delete(token);
      this.scheduleSave();
      return null;
    }

    return { userId: record.userId };
  }

  /**
   * 根据 token 获取用户
   */
  async getUserByToken(token: string): Promise<Omit<UserRecord, "password_hash"> | null> {
    this.ensureInitialized();
    const record = this.verifyToken(token);
    if (!record) return null;

    const user = await this.userRepo!.findById(record.userId);
    if (!user) return null;

    const { password_hash, ...safeUser } = user;
    return safeUser;
  }

  /**
   * 退出登录
   */
  logout(token: string): void {
    if (this.tokenStore.delete(token)) {
      this.scheduleSave();
    }
  }

  /**
   * 清理过期 token（定时执行）
   */
  cleanupExpiredTokens(): void {
    const now = Date.now();
    let changed = false;
    for (const [token, record] of this.tokenStore.entries()) {
      if (now > record.expiresAt) {
        this.tokenStore.delete(token);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }
}

/** 全局单例：routes/auth.ts 和 middleware/auth.ts 共享同一个实例 */
export const authService = new AuthService();
