/**
 * 答题卡数据目录与数据库的文件级互斥（#357 复核）。
 *
 * 备份在「数据库快照 + data/answer-card 复制」期间、恢复在替换整棵树期间都持有这把锁；
 * 反馈附件、原卷、答案页的删除也持有它。否则快照里的行可能在目录复制前被删掉文件，
 * 导出的备份会指向不存在的附件 / 原卷 / 答案页。
 */
import type { NextFunction, Request, Response } from "express";

let tail: Promise<void> = Promise.resolve();

export function withAnswerCardDataMutationLock<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/** 放在 multer 之前：整个上传（含临时文件写入）与备份 / 恢复 / 删除串行，结束时释放。 */
export function holdAnswerCardDataMutationLock(req: Request, res: Response, next: NextFunction): void {
  // 入队前就记下断连。排到锁之后才监听 close 时，等待期间的 close 已经发生，
  // next() 之后没有任何事件能释放这把锁。
  // 注意：正常请求体读完后 req.destroyed 也会是 true，不能用它判断断连。
  let disconnected = res.destroyed || req.socket?.destroyed === true;
  const onAborted = (): void => { disconnected = true; };
  const onResponseClose = (): void => {
    if (!res.writableEnded) disconnected = true;
  };
  req.on("aborted", onAborted);
  res.on("close", onResponseClose);

  void withAnswerCardDataMutationLock(() => new Promise<void>((resolve) => {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      req.off("aborted", onAborted);
      res.off("close", onResponseClose);
      resolve();
    };
    if (disconnected || res.destroyed) {
      release();
      return;
    }
    res.once("finish", release);
    res.once("close", release);
    next();
  })).catch(next);
}
