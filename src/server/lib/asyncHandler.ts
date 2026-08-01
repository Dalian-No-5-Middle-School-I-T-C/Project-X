import type { Request, Response, NextFunction, RequestHandler, Router } from "express";

/**
 * Express 5 不再自动捕获异步处理器（async handler）抛出的异常。
 * 一旦 handler 内部 await 的 DB 调用抖动并 reject，请求会因为没有
 * 被捕获的异常而永久挂起（前端一直转圈）。
 *
 * 用 asyncHandler 包裹后，未处理的 rejection 会被转发给 Express 的
 * 错误处理中间件（app.use((err, req, res, next) => ...)），
 * 从而返回 500 JSON 而不是让请求悬挂。
 *
 * 对同步处理器同样安全：同步抛出的错误也会被 Promise 捕获并转发。
 */
export const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/**
 * 递归包裹一个 Router 的所有处理器（含嵌套子路由），
 * 使其中任意异步 reject 都能被全局错误中间件捕获。
 *
 * 用于包裹通过 app.use(router) 挂载的外部路由模块
 * （userRoutes / classRoutes / scoreEditingRoutes ...）。
 */
export function wrapRouter(router: Router): Router {
  const anyRouter = router as any;
  if (!anyRouter || !Array.isArray(anyRouter.stack)) return router;
  for (const layer of anyRouter.stack) {
    const route = (layer as any).route;
    if (route && Array.isArray(route.stack)) {
      for (const sub of route.stack) {
        if (typeof sub.handle === "function" && !sub.handle.__wrapped) {
          const original = sub.handle;
          sub.handle = asyncHandler(original);
          sub.handle.__wrapped = true;
        }
      }
    } else if (typeof (layer as any).handle === "function") {
      const handle = (layer as any).handle as any;
      if (handle.stack && Array.isArray(handle.stack)) {
        // 嵌套子路由，递归包裹
        wrapRouter(handle);
      } else if (!handle.__wrapped) {
        const original = handle;
        (layer as any).handle = asyncHandler(original);
        (layer as any).handle.__wrapped = true;
      }
    }
  }
  return router;
}
