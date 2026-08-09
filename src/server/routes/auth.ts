import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { authService } from "../services/AuthService";
import { AUTH_COOKIE_NAME, extractToken, getCurrentUserHandler, authMiddleware } from "../middleware/auth";
import type { Request, Response } from "express";

const router = express.Router();
const PERSISTENT_TOKEN_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

// P1-1 (H-S9): 登录接口双层速率限制，防止暴力破解。
// IP 维度：防单出口泛洪。阈值放宽，反代/隧道部署下全校共享出口 IP 时不互相误伤。
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // 必须使用依赖提供的 ipKeyGenerator 规范化 IP，否则 IPv6 可绕过校验
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  message: { message: "当前网络登录尝试过于频繁，请 15 分钟后重试" }
});

// 账号维度：真正按账号全局限速（轮换 IP 无法绕过）；同一账号限 10 次/15 分钟。
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const body = (req as any).body as { identifier?: unknown } | undefined;
    const identifier = typeof body?.identifier === "string"
      ? body.identifier.trim().toLowerCase().slice(0, 64)
      : "";
    return identifier ? `account:${identifier}` : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { message: "该账号登录尝试过于频繁，请 15 分钟后重试" }
});

function setAuthCookie(res: Response, token: string, isPersistent: boolean): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    ...(isPersistent ? { maxAge: PERSISTENT_TOKEN_COOKIE_MAX_AGE_MS } : {})
  });
}

function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, {
    path: "/",
    sameSite: "lax"
  });
}

/**
 * POST /api/auth/login
 * 登录接口
 * Body: { identifier: string, password: string }
 * identifier：用户名、学号或职工号
 */
router.post("/login", loginIpLimiter, loginAccountLimiter, async (req: Request, res: Response) => {
  try {
    const { identifier, password, isPersistent } = req.body;

    if (!identifier || !password) {
      res.status(400).json({ message: "请输入用户名和密码" });
      return;
    }

    const result = await authService.login(identifier, password, !!isPersistent);

    if (!result.success) {
      res.status(401).json({ message: result.message });
      return;
    }

    if (result.token) {
      setAuthCookie(res, result.token, !!isPersistent);
    }

    res.json({
      token: result.token,
      user: result.user,
      permissions: result.permissions,
      passwordChangeRequired: result.passwordChangeRequired ?? false,
      message: result.message,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "服务器错误" });
  }
});

/**
 * POST /api/auth/logout
 * 退出登录
 */
router.post("/logout", (req: Request, res: Response) => {
  const token = extractToken(req);
  if (token) {
    authService.logout(token);
  }
  clearAuthCookie(res);
  res.json({ message: "已退出登录" });
});

/**
 * GET /api/auth/me
 * 获取当前登录用户信息
 */
router.get("/me", getCurrentUserHandler);

/**
 * POST /api/auth/change-password
 * 修改当前登录用户的密码
 * Body: { oldPassword: string, newPassword: string }
 */
router.post("/change-password", authMiddleware, async (req: Request, res: Response) => {
  try {
    const { oldPassword, newPassword } = req.body ?? {};
    if (!newPassword) {
      res.status(400).json({ message: "请输入新密码" });
      return;
    }
    const result = await authService.changePassword(req.user!.id, String(oldPassword ?? ""), String(newPassword));
    if (!result.success) {
      res.status(400).json({ message: result.message });
      return;
    }
    res.json({ message: result.message });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ message: "服务器错误" });
  }
});

export default router;
