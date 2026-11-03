/**
 * 一直待命时，进纸器空着等超时不算设备故障。
 * 这类结果要再开一轮等待；打不开设备、色彩/分辨率不对、已经扫出页面后的失败不能当成「还在等纸」。
 */
export function isStandbyIdleMiss(message: string | undefined, pageCount: number): boolean {
  if (pageCount > 0) return false;
  const text = message?.trim() ?? "";
  if (!text) return false;
  return text === "No pages captured" || text === "扫描未产生任何页面";
}

/** 空等失败如果立刻返回，至少隔这么久再开下一轮，避免进纸器空着时反复启动设备。 */
export const STANDBY_REARM_MIN_MS = 5000;
