/**
 * 答题卡数据目录与数据库的文件级互斥（#357 复核）。
 *
 * 备份在「数据库快照 + data/answer-card 复制」期间、恢复在替换整棵树期间都持有这把锁；
 * 反馈附件、原卷、答案页的删除也持有它。否则快照里的行可能在目录复制前被删掉文件，
 * 导出的备份会指向不存在的附件 / 原卷 / 答案页。
 */
let tail: Promise<void> = Promise.resolve();

export function withAnswerCardDataMutationLock<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.then(() => undefined, () => undefined);
  return run;
}
