import type { Request, RequestHandler } from "express";
import type { DiskStorageOptions, StorageEngine } from "multer";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isUploadAlreadyRejected } from "./uploadBudget";
import { requestDisconnected } from "./answerCardDataLock";

interface FileTask {
  file: Express.Multer.File;
  path?: string;
  done: Promise<void>;
}
const uploads = new WeakMap<Request, Set<FileTask>>();
const fileTasks = new WeakMap<Express.Multer.File, FileTask>();

/** Multer-compatible disk storage whose writes can be joined after cancellation. */
export function taskDiskStorage(options: DiskStorageOptions): StorageEngine {
  return {
    _handleFile(req, file, callback) {
      let tasks = uploads.get(req);
      if (!tasks) uploads.set(req, tasks = new Set());
      const task: FileTask = { file, done: Promise.resolve() };
      tasks.add(task);
      fileTasks.set(file, task);
      const aborted = () => file.stream.destroy(new Error("Upload interrupted"));
      // Destination selection may be asynchronous; observe stream failures immediately.
      const observeError = () => undefined;
      file.stream.on("error", observeError);
      req.once("aborted", aborted);
      task.done = (async () => {
        try {
          const destination = typeof options.destination === "function"
            ? await new Promise<string>((resolve, reject) => options.destination instanceof Function && options.destination(req, file, (err, value) => err ? reject(err) : resolve(value)))
            : options.destination!;
          if (req.aborted || req.socket?.destroyed || file.stream.destroyed) throw new Error("Upload interrupted");
          await mkdir(destination, { recursive: true });
          const filename = options.filename
            ? await new Promise<string>((resolve, reject) => options.filename!(req, file, (err, value) => err ? reject(err) : resolve(value)))
            : randomUUID();
          if (req.aborted || req.socket?.destroyed || file.stream.destroyed) throw new Error("Upload interrupted");
          const target = path.join(destination, filename);
          const out = createWriteStream(target, { flags: "wx" });
          // Only delete files this writer actually created; EEXIST owns nothing.
          out.once("open", () => { task.path = target; });
          await pipeline(file.stream, out);
          callback(null, { destination, filename, path: target, size: out.bytesWritten });
        } catch (error) {
          if (task.path) await rm(task.path, { force: true }).catch(() => undefined);
          callback(error as Error);
        } finally {
          req.off("aborted", aborted);
          file.stream.off("error", observeError);
        }
      })();
    },
    _removeFile(req, file, callback) {
      const task = fileTasks.get(file);
      void (async () => {
        await task?.done;
        const target = task?.path ?? file.path;
        if (target) await rm(target, { force: true });
      })().then(() => callback(null), callback);
    },
  };
}

/** Wait for both Multer's callback and every disk writer before returning to the caller. */
export function multipartTask(
  middleware: RequestHandler,
  onError?: (error: Error, req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => void,
): RequestHandler {
  return async (req, res, next) => {
    if (requestDisconnected(req, res) || isUploadAlreadyRejected(req, res)) return;
    let error: unknown;
    try {
      await new Promise<void>((resolve, reject) => {
        middleware(req, res, (failure?: unknown) => failure ? reject(failure) : resolve());
      });
    } catch (failure) {
      error = failure;
    }
    const tasks = uploads.get(req);
    try {
      if (error || requestDisconnected(req, res) || isUploadAlreadyRejected(req, res)) {
        for (const task of tasks ?? []) task.file.stream.destroy();
      }
      await Promise.all([...tasks ?? []].map((task) => task.done));
      if (error || requestDisconnected(req, res) || isUploadAlreadyRejected(req, res)) {
        await Promise.all([...tasks ?? []].map((task) => task.path ? rm(task.path, { force: true }) : Promise.resolve()));
        if (requestDisconnected(req, res) || isUploadAlreadyRejected(req, res)) return;
        if (onError) onError(error as Error, req, res);
        else next(error);
        return;
      }
      next();
    } finally {
      uploads.delete(req);
    }
  };
}
