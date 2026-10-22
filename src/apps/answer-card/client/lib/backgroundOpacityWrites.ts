/**
 * 背景透明度的 PATCH、上传与「移除背景」DELETE 必须按提交顺序落库。
 * 滑块的请求可能已经在途，删除若另起一条连接，晚到的旧透明度会把归零盖回去。
 */
export function createBackgroundOpacityQueue() {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    enqueue<T>(work: () => Promise<T>): Promise<T> {
      const run = tail.then(work, work);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

export type BackgroundWriteSession = {
  /** true = 本次任务已执行；false = 账号已切换，任务被丢弃。 */
  enqueue(work: () => Promise<void>): Promise<boolean>;
};

let activeSession: { key: string; queue: ReturnType<typeof createBackgroundOpacityQueue> } | null = null;

/**
 * 写入队列按登录身份跨页面挂载共享：离开设置页再回来时，新的 DELETE 仍会等待
 * 旧页面已经发出的 PATCH。身份切换后旧队列里的未执行任务直接丢弃，避免用新账号
 * 的凭据执行旧任务。
 */
export function backgroundWriteSession(key: string): BackgroundWriteSession {
  if (!activeSession || activeSession.key !== key) {
    activeSession = { key, queue: createBackgroundOpacityQueue() };
  }
  const session = activeSession;
  return {
    enqueue(work: () => Promise<void>): Promise<boolean> {
      return session.queue.enqueue(async () => {
        if (activeSession !== session) return false;
        await work();
        return true;
      });
    },
  };
}
