import express from "express";
import rateLimit from "express-rate-limit";
import { authService } from "../services/AuthService";
import { AUTH_COOKIE_NAME, extractToken, getCurrentUserHandler, authMiddleware } from "../middleware/auth";
import type { Request, Response } from "express";

const router = express.Router();
const PERSISTENT_TOKEN_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

// P1-1 (H-S9): 登录接口速率限制 — 每个 IP 15 分钟内最多 10 次尝试，防止暴力破解
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "登录尝试过于频繁，请 15 分钟后重试" }
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
router.post("/login", loginLimiter, async (req: Request, res: Response) => {
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
      message: result.message,
      ...(result.warning ? { warning: result.warning } : {})
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
