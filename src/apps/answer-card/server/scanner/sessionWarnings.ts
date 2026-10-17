/**
 * 扫描告警的落库，以及「告警写完了才让会话进终态」这条顺序保证。
 *
 * 告警既走 SSE 广播也写会话行的 `warnings_json`：客户端可能在 202 之后才订阅，或扫描途中断线重连，
 * 只广播会让「本次批次一张红笔都没采纳」这类结论在横幅和「复制诊断」里永久缺席。
 * 落库是异步的，所以终态写入之前必须先把队列排空——否则重连的订阅会先读到终态与旧的
 * `warnings_json`，补发完立刻关流，稍后才写完的那条告警再也没有机会被送出去。
 * 终态转换还必须带旧状态条件：等待队列期间另一个请求可能已写入 cancelled。
 */
import { appendSessionWarning, transitionSessionStatus } from "../database/scan-store";

// 会话内串行的必要之处在于 appendSessionWarning 是「读行 → 去重 → 写回」，并发写会互相覆盖。
// 不进 enqueuePersist：那条队列承载「扫描 → 主库」的长任务，把一条单行 UPDATE 排在它们后面，
// 客户端此刻订阅时补发读到的仍是旧行，而实时事件已经错过。
const warningQueues = new Map<string, Promise<void>>();

let writeDelayMs = 0;

/** 仅供回归测试：把告警写入推迟 N 毫秒，稳定复现「告警仍排在队列里、终态已经可写」的窗口 */
export function setWarningWriteDelayForTests(ms: number): void {
  writeDelayMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
}

export function persistSessionWarning(sessionId: string, text: string): void {
  const tail = (warningQueues.get(sessionId) ?? Promise.resolve())
    .then(async () => {
      if (writeDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, writeDelayMs));
      await appendSessionWarning(sessionId, text);
    })
    .catch((error) => {
      console.error(`[Scanner] Failed to persist warning for ${sessionId}:`, error);
    });
  warningQueues.set(sessionId, tail);
  void tail.finally(() => {
    if (warningQueues.get(sessionId) === tail) warningQueues.delete(sessionId);
  });
}

/** 等本会话已排队的告警全部落库；没有排队项时立即返回 */
export async function flushSessionWarnings(sessionId: string): Promise<void> {
  for (;;) {
    const tail = warningQueues.get(sessionId);
    if (!tail) return;
    await tail;
  }
}

/**
 * 终态的唯一写入口：先排空告警队列，再把会话暴露成 completed / error / cancelled。
 * 顺序反过来就会打开「重连读到终态却读不到告警」的窗口，见文件头注释。
 */
export async function markSessionTerminal(
  sessionId: string,
  status: "completed" | "error" | "cancelled",
  errorMsg?: string
): Promise<boolean> {
  await flushSessionWarnings(sessionId);
  return await transitionSessionStatus(sessionId, status, errorMsg);
}
