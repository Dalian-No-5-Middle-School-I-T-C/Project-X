import type { Request, Response, NextFunction, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

function callerKey(req: Request): string {
  const apiKeyId = (req as Request & { apiKeyId?: number }).apiKeyId;
  if (apiKeyId != null) return `key:${apiKeyId}`;
  if (req.user) return `user:${req.user.id}`;
  return `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
}

// Shared across router instances so different sessions cannot bypass a key's limit.
export const correctionCallerLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: callerKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "CORRECTION_RATE_LIMITED", message: "订正请求过于频繁，请稍后重试" },
});
export const correctionSessionLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: req => String(req.params.sessionId),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "CORRECTION_RATE_LIMITED", message: "此扫描会话订正请求过于频繁，请稍后重试" },
});

const activeCallers = new Set<string>();
const activeSessions = new Set<string>();
const MAX_CONCURRENT_CORRECTIONS = 2;

/** Keep the slot until the actual handler settles, including after client disconnect. */
export function guardCorrectionRequest(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return async (req, res, next) => {
    const caller = callerKey(req), session = String(req.params.sessionId);
    if (activeCallers.size >= MAX_CONCURRENT_CORRECTIONS || activeCallers.has(caller) || activeSessions.has(session)) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({ code: "CORRECTION_BUSY", message: "订正处理中，请稍后重试" });
      return;
    }
    activeCallers.add(caller); activeSessions.add(session);
    try { await handler(req, res, next); }
    catch (error) { next(error); }
    finally { activeCallers.delete(caller); activeSessions.delete(session); }
  };
}
