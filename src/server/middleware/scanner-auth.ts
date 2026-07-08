/**
 * 扫描端双鉴权：X-Api-Key（Electron 扫描客户端）或 JWT + GRADE_WRITE。
 * 与 scanner-upload 路由一致，供主 /api/scanner 路由在强制鉴权模式下使用。
 */
import type { Request, Response, NextFunction } from "express";
import { apiKeyAuth } from "./api-key";
import { authMiddleware, requirePermission } from "./auth";
import { PERMISSIONS } from "../auth/permissions";

const gradeWrite = requirePermission(PERMISSIONS.GRADE_WRITE);

/** API Key 优先；无 Key 时走 JWT + GRADE_WRITE（须已登录且有写权限） */
export async function dualAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    const keyMw = apiKeyAuth({ scope: "scanner" });
    await keyMw(req, res, next);
    return;
  }
  await authMiddleware(req, res, (err?: unknown) => {
    if (err) {
      next(err as Error);
      return;
    }
    if (res.headersSent) return;
    gradeWrite(req, res, next);
  });
}

/**
 * 扫描路由网关：未强制鉴权时放行；强制时 API Key 或 JWT+写权限。
 */
export function makeScannerAuth(enforceAuth: boolean) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!enforceAuth) {
      next();
      return;
    }
    const apiKey = req.headers["x-api-key"] as string | undefined;
    if (apiKey) {
      const keyMw = apiKeyAuth({ scope: "scanner" });
      await keyMw(req, res, next);
      return;
    }
    await authMiddleware(req, res, (err?: unknown) => {
      if (err) {
        next(err as Error);
        return;
      }
      if (res.headersSent) return;
      gradeWrite(req, res, next);
    });
  };
}
