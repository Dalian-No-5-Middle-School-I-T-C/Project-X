/**
 * 同一原卷只允许进一次上传队列。
 * 上传任务列表是内存态，进度卡关掉或进程重进后就没了；扫描面板和后处理页共用这份名单，
 * 避免两边各 startUpload 一次，在服务端形成同学号的第二份回执。
 */

export interface PreviewDiscardRef {
  sessionId: string;
  groupId: string;
}

function queuedKey(cardId: string): string {
  return `projectx-postprocess-queued/${cardId}`;
}

function previewDiscardKey(cardId: string): string {
  return `projectx-postprocess-preview-discard/${cardId}`;
}

function readStringSet(key: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeStringSet(key: string, values: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...values])); } catch { /* 配额满时仍保留调用方的内存集合 */ }
}

export function queuedGroupKey(sessionId: string, groupId: string): string {
  return `${sessionId}/${groupId}`;
}

export function readQueuedGroups(cardId: string): Set<string> {
  return readStringSet(queuedKey(cardId));
}

export function isGroupQueued(cardId: string, sessionId: string, groupId: string): boolean {
  return readQueuedGroups(cardId).has(queuedGroupKey(sessionId, groupId));
}

export function rememberQueuedGroup(cardId: string, sessionId: string, groupId: string): void {
  const values = readQueuedGroups(cardId);
  values.add(queuedGroupKey(sessionId, groupId));
  writeStringSet(queuedKey(cardId), values);
}

/** 尚未在远端建出会话的任务被取消或删除时，把入队资格还回去。 */
export function forgetQueuedGroup(cardId: string, sessionId: string, groupId: string): void {
  const values = readQueuedGroups(cardId);
  values.delete(queuedGroupKey(sessionId, groupId));
  writeStringSet(queuedKey(cardId), values);
}

export function readPreviewDiscards(cardId: string): PreviewDiscardRef[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(previewDiscardKey(cardId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PreviewDiscardRef => {
      if (!item || typeof item !== "object") return false;
      const row = item as { sessionId?: unknown; groupId?: unknown };
      return typeof row.sessionId === "string" && typeof row.groupId === "string";
    });
  } catch {
    return [];
  }
}

export function rememberPreviewDiscard(cardId: string, sessionId: string, groupId: string): void {
  const values = readPreviewDiscards(cardId);
  if (values.some(item => item.sessionId === sessionId && item.groupId === groupId)) return;
  values.push({ sessionId, groupId });
  try { localStorage.setItem(previewDiscardKey(cardId), JSON.stringify(values)); } catch { /* 同上 */ }
}
