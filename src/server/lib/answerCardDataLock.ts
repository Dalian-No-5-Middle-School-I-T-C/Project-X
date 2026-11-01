import type { Request, RequestHandler, Response } from "express";

let tail: Promise<void> = Promise.resolve();

/** The returned task owns the lock, including its awaited cleanup. */
export function withAnswerCardDataMutationLock<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

export function requestDisconnected(req: Request, res: Response): boolean {
  return req.aborted || res.destroyed || req.socket?.destroyed === true;
}

/**
 * Run synchronous/async guards and an awaited operation inside one critical section.
 * Callback middleware (Multer) must be adapted with multipartTask first. A handler
 * owns all of its work until its promise settles, even after sending a response.
 */
export function answerCardDataOperation(...handlers: RequestHandler[]): RequestHandler {
  return async (req, res, next) => {
    try {
      await withAnswerCardDataMutationLock(async () => {
        for (const handler of handlers) {
          if (requestDisconnected(req, res) || res.writableEnded) return;
          let proceed = false;
          let failure: unknown;
          await handler(req, res, (error?: unknown) => {
            proceed = true;
            failure = error;
          });
          if (failure) throw failure;
          if (!proceed) return;
        }
      });
    } catch (error) {
      next(error);
    }
  };
}
