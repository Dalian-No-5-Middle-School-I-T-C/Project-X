import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response } from "express";

interface RequestTask {
  req: Request;
  res: Response;
  epoch: number;
  handlers: number;
  transportDone: boolean;
}
const requests = new WeakMap<Request, RequestTask>();
const activeRequests = new Set<RequestTask>();
let backgroundTasks = 0;
let epoch = 0;
let maintenanceOwner: Request | null = null;
let recoveryRequired = false;
const taskContext = new AsyncLocalStorage<{ active: boolean }>();
const changed = new Set<() => void>();
const notify = () => { for (const listener of changed) listener(); };

export class ServiceMaintenanceError extends Error {
  readonly status = 409;
  constructor() { super("服务正忙，请等待当前操作结束后重试备份或恢复"); }
}

export function isServiceMaintenanceActive(): boolean {
  return maintenanceOwner !== null || recoveryRequired;
}

export function requireServiceRecovery(): void {
  recoveryRequired = true;
}

/** Called by the existing asyncHandler wrapper, including mounted routers. */
export function enterRequestTask(req: Request, res: Response): (() => void) | null {
  // Express accepts absolute-form request targets and case-insensitive routes.
  // Keep originalUrl so mounted routers retain their /api or /assets prefix.
  const url = new URL(req.originalUrl || req.url, "http://localhost").pathname.toLowerCase();
  if (!url.startsWith("/api") && !url.startsWith("/assets")) return () => undefined;
  if (url.split("?")[0] === "/api/app/health") return () => undefined;
  let state = requests.get(req);
  const rejected = state
    ? state.epoch !== epoch || (maintenanceOwner !== null && !activeRequests.has(state))
    : isServiceMaintenanceActive();
  if (req !== maintenanceOwner && (recoveryRequired || rejected)) {
    if (!res.headersSent && !res.destroyed) {
      res.status(503).json({
        code: recoveryRequired ? "RESTORE_RECOVERY_REQUIRED" : "RESTORE_IN_PROGRESS",
        message: recoveryRequired ? "数据恢复未完成，请联系管理员完成恢复" : "正在维护数据，请稍后重试",
      });
    }
    return null;
  }
  if (!state) {
    state = { req, res, epoch, handlers: 0, transportDone: res.writableEnded || res.destroyed };
    requests.set(req, state);
    const finished = () => {
      state!.transportDone = true;
      res.off("finish", finished);
      res.off("close", finished);
      if (state!.handlers === 0) activeRequests.delete(state!);
      notify();
    };
    res.once("finish", finished);
    res.once("close", finished);
  }
  state.handlers++;
  activeRequests.add(state);
  return () => {
    state!.handlers--;
    if (state!.handlers === 0 && state!.transportDone) activeRequests.delete(state!);
    notify();
  };
}

/** Child jobs spawned by an admitted handler remain part of its drain. */
export async function inServiceTaskContext<T>(work: () => Promise<T>): Promise<T> {
  const context = { active: true };
  try { return await taskContext.run(context, work); }
  finally { context.active = false; }
}

/** Background jobs are admitted before scheduling, so queued jobs are drained too. */
export async function runServiceTask<T>(work: () => Promise<T>): Promise<T> {
  if (recoveryRequired || (isServiceMaintenanceActive() && !taskContext.getStore()?.active)) throw new ServiceMaintenanceError();
  backgroundTasks++;
  try { return await inServiceTaskContext(work); }
  finally { backgroundTasks--; notify(); }
}

/** Drain already-admitted work before replacing the database and data tree. */
export async function withServiceMaintenance<T>(req: Request, work: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  if (isServiceMaintenanceActive()) throw new ServiceMaintenanceError();
  maintenanceOwner = req;
  // SSE transports do not own a write task. Close them so clients reconnect after recovery.
  for (const state of activeRequests) {
    if (String(state.res.getHeader("content-type") ?? "").startsWith("text/event-stream")) state.res.end();
  }
  let drained = false;
  const busy = () => backgroundTasks > 0 || [...activeRequests].some((state) => state.req !== req);
  try {
    if (busy()) await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (busy()) return;
        clearTimeout(timer);
        changed.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        changed.delete(check);
        reject(new ServiceMaintenanceError());
      }, timeoutMs);
      changed.add(check);
      check();
    });
    drained = true;
    return await work();
  } finally {
    // A late callback from an old request cannot begin work against the restored database.
    if (drained) epoch++;
    maintenanceOwner = null;
    notify();
  }
}
