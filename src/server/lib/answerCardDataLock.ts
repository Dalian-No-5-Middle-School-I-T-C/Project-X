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
export function holdAnswerCardDataMutationLock(_req: Request, res: Response, next: NextFunction): void {
  void withAnswerCardDataMutationLock(() => new Promise<void>((resolve) => {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      resolve();
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  })).catch(next);
}
