import type { Request, Response, NextFunction } from "express";
import { AuthService } from "../services/AuthService";

// 扩展 Express Request 类型
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        username: string;
        name: string;
        role_id: number;
        role_name: string;
      };
    }
  }
}

const authService = new AuthService();

/**
 * 认证中间件：验证 Bearer Token
 * 使用方式：在需要认证的路由前加上 authMiddleware
 *
 * 客户端请求头格式：
 *   Authorization: Bearer <token>
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ message: "未提供认证令牌" });
    return;
  }

  const token = authHeader.slice(7).trim();
  const user = authService.getUserByToken(token);

  if (!user) {
    res.status(401).json({ message: "认证令牌无效或已过期" });
    return;
  }

  // 将用户信息挂载到 req 上
  req.user = {
    id: user.id,
    username: user.username,
    name: user.name,
    role_id: user.role_id,
    role_name: user.role_name ?? "unknown"
  };

  next();
}

/**
 * 角色鉴权中间件：检查用户是否具备指定角色
 * @param allowedRoles 允许的角色名数组，如 ["admin", "teacher"]
 */
export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: "未认证" });
      return;
    }

    if (!allowedRoles.includes(req.user.role_name)) {
      res.status(403).json({ message: "权限不足" });
      return;
    }

    next();
  };
}

/**
 * 获取当前用户信息的处理器（API 端点）
 */
export function getCurrentUserHandler(req: Request, res: Response): void {
  if (!req.user) {
    res.status(401).json({ message: "未认证" });
    return;
  }

  const authService = new AuthService();
  const token = req.headers.authorization?.slice(7).trim() ?? "";
  const user = authService.getUserByToken(token);

  if (!user) {
    res.status(401).json({ message: "用户不存在" });
    return;
  }

  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    role_id: user.role_id,
    role_name: user.role_name,
    role_display_name: user.role_display_name,
    student_number: user.student_number,
    email: user.email,
    last_login_at: user.last_login_at
  });
}
