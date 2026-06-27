/**
 * v1.6.0 — API Key 认证中间件
 * 用于扫描客户端等非用户场景的认证
 *
 * 使用方式:
 *   app.use("/api/scanner", apiKeyAuth({ scope: "scanner" }), scannerRoutes);
 *
 * 客户端在 HTTP 头中发送:
 *   X-Api-Key: sk-xxxxxxxxxxxx
 */

import type { Request, Response, NextFunction } from "express";
import { getMysqlDb } from "../db";

interface ApiKeyAuthOptions {
  scope?: string; // 限制 key 的 scope，默认不限制
}

export function apiKeyAuth(options: ApiKeyAuthOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // 如果已有用户认证（authMiddleware 已通过），跳过 key 认证
    if ((req as any).user) {
      return next();
    }

    const apiKey = req.headers["x-api-key"] as string | undefined;
    if (!apiKey) {
      res.status(401).json({ message: "缺少 X-Api-Key 请求头" });
      return;
    }

    try {
      const db = await getMysqlDb();
      const row = await db.get<{ id: number; name: string; scope: string; is_active: number }>(
        "SELECT id, name, scope, is_active FROM api_keys WHERE api_key = ?",
        apiKey
      );

      if (!row) {
        res.status(401).json({ message: "无效的 API Key" });
        return;
      }

      if (!row.is_active) {
        res.status(403).json({ message: "API Key 已被停用" });
        return;
      }

      if (options.scope && row.scope !== options.scope && row.scope !== "full") {
        res.status(403).json({ message: `API Key 无 ${options.scope} 权限` });
        return;
      }

      // 注入到 req 上，后续路由可用
      (req as any).isApiClient = true;
      (req as any).apiKeyId = row.id;
      (req as any).apiKeyName = row.name;
      next();
    } catch (err: any) {
      res.status(500).json({ message: `API Key 验证失败: ${err.message}` });
    }
  };
}
