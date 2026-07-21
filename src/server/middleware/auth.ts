import type { Request, Response, NextFunction } from "express";
import { authService } from "../services/AuthService";
import { permissionsForRole, roleHasPermission, type Permission } from "../auth/permissions";
import { resolveEnforceAuth } from "../auth/enforce";

export const AUTH_COOKIE_NAME = "projectx_auth_token";

// 强制鉴权判定统一委托给 resolveEnforceAuth()（server/auth/enforce.ts），
// 与 createApp 共用同一真相源，避免语义相反的 bug。

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
        student_number: string | null;
        teacher_role: string | null;
        subject: string | null;
      };
    }
  }
}

function tokenFromCookie(req: Request): string | null {
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return null;
  for (const part of rawCookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === AUTH_COOKIE_NAME) {
      return decodeURIComponent(valueParts.join("="));
    }
  }
  return null;
}

export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const cookieToken = tokenFromCookie(req);
  if (cookieToken) {
    return cookieToken;
  }
  // 兼容查询参数（用于 SSE / PDF 等无法设置请求头的场景）
  const queryToken = req.query.token;
  if (typeof queryToken === "string" && queryToken) {
    return queryToken;
  }
  return null;
}

async function attachUser(req: Request, token: string): Promise<boolean> {
  const user = await authService.getUserByToken(token);
  if (!user) return false;
  req.user = {
    id: user.id,
    username: user.username,
    name: user.name,
    role_id: user.role_id,
    role_name: user.role_name ?? "unknown",
    student_number: user.student_number ?? null,
    teacher_role: (user as any).teacher_role ?? null,
    subject: (user as any).subject ?? null
  };
  return true;
}

/**
 * 强制认证中间件：必须携带有效 Bearer Token。
 * 用法：router.use(authMiddleware) 或在单条路由前挂载。
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    // 未强制鉴权模式下（与 optionalAuth / makeGate 一致）：无 token 也放行，
    // 保持“未登录即可使用”的兼容；开启强制模式时必须有有效令牌。
    if (!resolveEnforceAuth()) {
      next();
      return;
    }
    res.status(401).json({ message: "未提供认证令牌" });
    return;
  }
  if (!(await attachUser(req, token))) {
    res.status(401).json({ message: "认证令牌无效或已过期" });
    return;
  }
  next();
}

/**
 * 可选认证中间件：有 token 则解析挂载用户，无 token 也放行。
 * 用于在“未强制登录”阶段仍然记录 created_by / 区分匿名访问。
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (token) {
    await attachUser(req, token);
  }
  next();
}

/**
 * 角色鉴权中间件：要求用户属于允许的角色之一。
 * @param allowedRoles 角色名数组，如 ["admin", "teacher"]
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: "未认证" });
      return;
    }
    if (!allowedRoles.includes(req.user.role_name)) {
      res.status(403).json({ message: "权限不足：需要角色 " + allowedRoles.join("/") });
      return;
    }
    next();
  };
}

/**
 * 权限鉴权中间件：基于角色权限表做细粒度控制（支持 "*" / "域:*" 通配）。
 * @param permission 所需权限，如 PERMISSIONS.USER_MANAGE
 */
export function requirePermission(permission: Permission | string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: "未认证" });
      return;
    }
    if (!roleHasPermission(req.user.role_id, permission)) {
      res.status(403).json({ message: `权限不足：缺少 ${permission}` });
      return;
    }
    next();
  };
}

/**
 * 获取当前用户信息的处理器（GET /api/auth/me）。
 * 额外回传该角色的权限列表，供前端做菜单/按钮级 UI 控制。
 */
export async function getCurrentUserHandler(req: Request, res: Response): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ message: "未认证" });
    return;
  }
  const user = await authService.getUserByToken(token);
  if (!user) {
    res.status(401).json({ message: "认证令牌无效或已过期" });
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
    teacher_role: (user as any).teacher_role ?? null,
    subject: (user as any).subject ?? null,
    email: user.email,
    last_login_at: user.last_login_at,
    show_tab_bar: (user as any).show_tab_bar ?? 0,
    permissions: permissionsForRole(user.role_id)
  });
}
