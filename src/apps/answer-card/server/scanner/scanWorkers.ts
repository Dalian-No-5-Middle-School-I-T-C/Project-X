/**
 * 本进程内仍在执行的扫描 worker。
 *
 * 取消接口会先把会话写成 cancelled，但 runScanSession 还要继续落页、跑识别；
 * 后处理页此时读结果会拿到空批或半批，而且还不会再刷新。用这张表把「取消但仍未收尾」
 * 和「取消且已收尾」分开。进程重启后表是空的——那种情况下 worker 本就不存在了。
 */
const activeScanWorkers = new Set<string>();

export function beginScanWorker(sessionId: string): void {
  activeScanWorkers.add(sessionId);
}

export function endScanWorker(sessionId: string): void {
  activeScanWorkers.delete(sessionId);
}

export function isScanWorkerActive(sessionId: string): boolean {
  return activeScanWorkers.has(sessionId);
}
