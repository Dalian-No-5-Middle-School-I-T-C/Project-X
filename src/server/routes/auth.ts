import express from "express";
import { authService } from "../services/AuthService";
import { getCurrentUserHandler, authMiddleware } from "../middleware/auth";
import type { Request, Response } from "express";

const router = express.Router();

/**
 * POST /api/auth/login
 * 登录接口
 * Body: { identifier: string, password: string }
 * identifier：用户名、学号或职工号
 */
router.post("/login", async (req: Request, res: Response) => {
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

    res.json({
      token: result.token,
      user: result.user,
      permissions: result.permissions,
      message: result.message
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
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    authService.logout(token);
  }
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
