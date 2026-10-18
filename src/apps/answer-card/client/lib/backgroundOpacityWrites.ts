/**
 * 背景透明度的 PATCH 与「移除背景」DELETE 必须按提交顺序落库。
 * 滑块的请求可能已经在途，删除若另起一条连接，晚到的旧透明度会把归零盖回去。
 */
export function createBackgroundOpacityQueue() {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue(work: () => Promise<void>): Promise<void> {
      const run = tail.then(work, work);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
