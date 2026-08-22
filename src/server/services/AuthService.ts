import { UserRepository, type UserRecord } from "../repositories/UserRepository";
import { verifyPassword, hashPassword, getMysqlDb, removeBootstrapAdminFile } from "../db";
import { permissionsForRole } from "../auth/permissions";
import { validateUserChosenPassword } from "../auth/passwordPolicy";
import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export interface LoginResult {
  success: boolean;
  user?: Omit<UserRecord, "password_hash">;
  token?: string;
  permissions?: string[];
  message?: string;
  passwordChangeRequired?: boolean;
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
// 安全审计（F-12-7）：持久 token 由 6 个月收敛为 30 天，降低泄漏窗口
const PERSISTENT_TOKEN_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000; // 30天

// P2-1 (M-S3): token 不再明文存储，只存 SHA-256 哈希
// 验证时对传入 token 哈希后比对，磁盘文件 tokens.json 也只存哈希
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  private userRepo: UserRepository;
  private tokenStore = new Map<string, TokenRecord>();
  private saveScheduled = false;

  constructor() {
    this.userRepo = new UserRepository();
    this.loadTokens();
    // L-S5: 每小时自动清理过期 token，避免 tokenStore 无限增长
    const cleanupTimer = setInterval(() => this.cleanupExpiredTokens(), 60 * 60 * 1000);
    cleanupTimer.unref();  // 不阻止进程退出
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
      // 安全审计（F-12-6）：token 文件权限收紧（POSIX 0600）；Windows 下 chmod 忽略
      try { chmodSync(TOKEN_STORE_PATH, 0o600); } catch { /* ignore */ }
    } catch (error) {
      console.error("[Auth] 持久化 token 失败:", error);
    }
  }

  /**
   * 用户登录
   * 支持用户名（学号/职工号）登录
   */
  async login(identifier: string, password: string, isPersistent = false): Promise<LoginResult> {
    // 查找用户：先按 username，纯数字再按 student_number
    let user = await this.userRepo.findByUsername(identifier);

    if (!user && /^\d+$/.test(identifier)) {
      // 纯数字，尝试学号
      user = await this.userRepo.findByStudentNumber(identifier);
    }

    if (!user) {
      return { success: false, message: "用户名或密码错误" };
    }

    // 验证密码。兼容旧流程留下的学生空密码哈希：首次用学号登录时自动补齐为学号密码。
    // 安全审计（F-11）：补齐的同时标记 password_change_required，强制该学生下次改密，
    // 避免"密码即学号（可猜测）"长期有效。
    let valid = false;
    if (!user.password_hash && user.role_name === "student" && user.student_number && password === user.student_number) {
      const newHash = await hashPassword(user.student_number);
      const db = getMysqlDb();
      await db.run(
        "UPDATE users SET password_hash = ?, password_change_required = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        newHash, user.id
      );
      user.password_hash = newHash;
      // 同步内存副本：登录响应的 passwordChangeRequired 取自该对象，漏同步会让本次（最需强制的首次）登录不触发强制改密
      user.password_change_required = 1;
      valid = true;
    } else {
      valid = await verifyPassword(password, user.password_hash);
    }
    if (!valid) {
      return { success: false, message: "用户名或密码错误" };
    }

    // 更新最后登录时间
    await this.userRepo.updateLastLogin(user.id);

    // 生成 token
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + (isPersistent ? PERSISTENT_TOKEN_EXPIRE_MS : TOKEN_EXPIRE_MS);
    this.tokenStore.set(hashToken(token), { userId: user.id, expiresAt });
    this.scheduleSave();

    // 清除敏感信息
    const { password_hash, ...safeUser } = user;

    return {
      success: true,
      user: safeUser,
      token,
      permissions: permissionsForRole(user.role_id),
      message: "登录成功",
      passwordChangeRequired: Boolean(user.password_change_required)
    };
  }

  /**
   * 修改密码（需校验原密码）。
   * 任何已登录用户均可修改自己的密码。
   */
  async changePassword(userId: number, oldPassword: string, newPassword: string): Promise<ChangePasswordResult> {
    const passwordError = validateUserChosenPassword(newPassword);
    if (passwordError) return { success: false, message: passwordError };

    const db = getMysqlDb();
    const row = await db.get("SELECT username, password_hash FROM users WHERE id = ?", userId) as
      | { username: string; password_hash: string }
      | undefined;
    if (!row) {
      return { success: false, message: "用户不存在" };
    }

    // 严格校验：空 hash 视为异常状态（正常流程下 admin/学生建账都会设置 hash，空 hash 仅出现在 legacy/手动篡改场景）
    if (!row.password_hash) {
      return { success: false, message: "账户密码状态异常，请联系管理员重置" };
    }
    const valid = await verifyPassword(oldPassword, row.password_hash);
    if (!valid) {
      return { success: false, message: "原密码错误" };
    }

    const newHash = await hashPassword(newPassword);
    await db.run(
      // 用户首次改密成功后清空明文初始密码：库文件不再泄漏全部账号的初始口令；
      // 管理员再次「重置密码」时仍会重新写入新初始密码供导出下发。
      "UPDATE users SET password_hash = ?, password_change_required = 0, initial_password = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      newHash, userId
    );
    if (row.username === "admin") removeBootstrapAdminFile();

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
    const record = this.tokenStore.get(hashToken(token));
    if (!record) return null;

    if (Date.now() > record.expiresAt) {
      this.tokenStore.delete(hashToken(token));
      this.scheduleSave();
      return null;
    }

    return { userId: record.userId };
  }

  /**
   * 根据 token 获取用户
   */
  async getUserByToken(token: string): Promise<Omit<UserRecord, "password_hash"> | null> {
    const record = this.verifyToken(token);
    if (!record) return null;

    const user = await this.userRepo.findById(record.userId);
    if (!user) return null;

    const { password_hash, ...safeUser } = user;
    return safeUser;
  }

  /**
   * 退出登录
   */
  logout(token: string): void {
    if (this.tokenStore.delete(hashToken(token))) {
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
