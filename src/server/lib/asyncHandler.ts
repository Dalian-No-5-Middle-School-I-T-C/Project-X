import type { Request, Response, NextFunction, RequestHandler, Router } from "express";

import { enterRequestTask, inServiceTaskContext } from "./serviceTasks";

/** Track handler completion separately from response finish/close, and forward errors. */
export const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    const leave = enterRequestTask(req, res);
    if (!leave) return;
    try { await inServiceTaskContext(async () => { await fn(req, res, next); }); }
    catch (error) { next(error); }
    finally { leave(); }
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
