import type { Request, Response, NextFunction } from "express";
import { authService } from "../services/AuthService";
import { permissionsForRole, roleHasPermission, type Permission } from "../auth/permissions";
import { isAuthEnforced } from "../lib/authEnforce";
import { isUrlCredentialAllowedPath } from "../lib/mediaAllowlist";
import { resolveMediaTicket } from "../services/mediaTicket";

export const AUTH_COOKIE_NAME = "projectx_auth_token";

// 强制鉴权判定统一委托给 isAuthEnforced()（server/lib/authEnforce.ts），
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
        password_change_required: boolean;
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
  // 兼容查询参数（用于 SSE / PDF 等无法设置请求头的场景）。
  // 仅 GET/HEAD 接受 ?token=，避免写操作 token 泄漏进 URL/代理日志。
  //
  // 安全（R30）：进一步收紧——`?token=` 携带的是**主会话令牌**，而 URL 会进浏览器历史、
  // 代理与访问日志。原先任何 GET 都能用它，于是「一次泄漏 = 整份只读权限」。
  // 现在只有媒体白名单（图片/PDF/导出/SSE，见 server/lib/mediaAllowlist.ts）接受它；
  // 其它端点必须用 Authorization 头、Cookie，或改走单次资源票据 `?mt=`。
  if (req.method === "GET" || req.method === "HEAD") {
    const queryToken = req.query.token;
    if (typeof queryToken === "string" && queryToken) {
      const pathname = req.baseUrl ? req.baseUrl + req.path : req.path;
      if (isUrlCredentialAllowedPath(pathname)) {
        return queryToken;
      }
      // 记在请求对象上（不是模块变量）：并发请求之间不能互相冒领这条状态。
      (req as Request & { mediaUrlTokenRejected?: boolean }).mediaUrlTokenRejected = true;
    }
  }
  return null;
}

/** 本请求是否「想用 ?token= 但端点不在媒体白名单」——用于给出可操作的 401 文案。 */
export function urlTokenRejectedFor(req: Request): boolean {
  return Boolean((req as Request & { mediaUrlTokenRejected?: boolean }).mediaUrlTokenRejected);
}

async function attachUser(req: Request, token: string): Promise<boolean> {
  const user = await authService.getUserByToken(token);
  if (!user) return false;
  attachUserSnapshot(req, user);
  return true;
}

function attachUserSnapshot(req: Request, user: Record<string, unknown>): void {
  req.user = {
    id: user.id as number,
    username: user.username as string,
    name: user.name as string,
    role_id: user.role_id as number,
    role_name: (user.role_name as string) ?? "unknown",
    student_number: (user.student_number as string) ?? null,
    teacher_role: (user.teacher_role as string) ?? null,
    subject: (user.subject as string) ?? null,
    password_change_required: Boolean(user.password_change_required)
  };
}

/**
 * 认证解析的统一入口（安全 R30）：先认单次资源票据 `?mt=`，再退回常规令牌。
 * 票据在签发时就绑定了「本请求路径 + 只读方法 + 时限」，所以命中即等价于该用户亲自请求。
 */
async function authenticateRequest(req: Request): Promise<"ticket" | "token" | "invalid" | "none"> {
  const rawTicket = req.query.mt;
  if (typeof rawTicket === "string" && rawTicket) {
    if (req.method === "GET" || req.method === "HEAD") {
      const pathname = req.baseUrl ? req.baseUrl + req.path : req.path;
      const user = resolveMediaTicket(rawTicket, req.method, pathname);
      if (user) {
        req.user = { ...user };
        return "ticket";
      }
    }
  }
  const token = extractToken(req);
  if (!token) return "none";
  return (await attachUser(req, token)) ? "token" : "invalid";
}

/**
 * 强制认证中间件：必须携带有效 Bearer Token。
 * 用法：router.use(authMiddleware) 或在单条路由前挂载。
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const via = await authenticateRequest(req);
  if (via === "invalid") {
    res.status(401).json({ message: "认证令牌无效或已过期" });
    return;
  }
  if (via === "none") {
    // 未强制鉴权模式下（与 optionalAuth / makeGate 一致）：无 token 也放行，
    // 保持“未登录即可使用”的兼容；开启强制模式时必须有有效令牌。
    if (!isAuthEnforced()) {
      next();
      return;
    }
    res.status(401).json({
      message: urlTokenRejectedFor(req)
        ? "该接口不接受 URL 中的 token 参数，请改用 Authorization 头；图片/PDF/SSE 可先 POST /api/auth/media-ticket 换取 ?mt= 单次票据"
        : "未提供认证令牌"
    });
    return;
  }
  next();
}

/**
 * 可选认证中间件：有 token 则解析挂载用户，无 token 也放行。
 * 用于在“未强制登录”阶段仍然记录 created_by / 区分匿名访问。
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  await authenticateRequest(req);
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
    themeSkin: (user as any).theme_skin ?? "paper-edge",
    passwordChangeRequired: Boolean((user as any).password_change_required),
    permissions: permissionsForRole(user.role_id)
  });
}

/** 强制改密账号只能访问挂载在本中间件之前的认证自助端点。 */
export function requirePasswordChangeCompleted(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.password_change_required) {
    res.status(428).json({
      code: "PASSWORD_CHANGE_REQUIRED",
      message: "必须先修改一次性密码"
    });
    return;
  }
  next();
}
