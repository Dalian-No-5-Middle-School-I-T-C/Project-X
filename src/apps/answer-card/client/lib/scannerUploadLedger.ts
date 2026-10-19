/**
 * 完成名单阻止重复回执；未完成任务保留会话及逐页进度，重新打开本机原卷时续传。
 */
import { z } from "zod";

const recoverySchema = z.object({
  remoteBase: z.string(), remoteSessionId: z.string().min(1), cardVersion: z.string().min(1),
  completed: z.boolean(), dpi: z.number(), paperSize: z.string(), identityMode: z.enum(["strict", "legacy"]),
  pendingStudentId: z.string().optional(),
  pages: z.array(z.object({
    pageNum: z.number(), side: z.enum(["front", "back"]), layoutPage: z.number().optional(),
    recordId: z.string().optional(), token: z.string().min(1), done: z.boolean(),
    studentId: z.string().optional(), recognizedStudentId: z.object({ status: z.string(), value: z.string() }).optional(),
  })).min(1),
});
export type ScanUploadRecovery = z.infer<typeof recoverySchema>;

const recoveryKey = (cardId: string, sessionId: string, groupId: string) =>
  `projectx-scanner-upload-recovery/${JSON.stringify([cardId, sessionId, groupId])}`;

export function readScanUploadRecovery(cardId: string, sessionId: string, groupId: string): ScanUploadRecovery | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(recoveryKey(cardId, sessionId, groupId));
  if (!raw) return null;
  const parsed = recoverySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("上传恢复记录不完整，请保留本机原卷并核对服务器会话");
  return parsed.data;
}

export function writeScanUploadRecovery(cardId: string, sessionId: string, groupId: string, recovery: ScanUploadRecovery): void {
  try { localStorage.setItem(recoveryKey(cardId, sessionId, groupId), JSON.stringify(recovery)); }
  catch { throw new Error("无法保存上传恢复记录，请释放本机存储空间后重试"); }
}

export function forgetScanUploadRecovery(cardId: string, sessionId: string, groupId: string): void {
  try { localStorage.removeItem(recoveryKey(cardId, sessionId, groupId)); } catch { /* Completion receipt still protects this group. */ }
}

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

function writeStringSet(key: string, values: Set<string>): boolean {
  try { localStorage.setItem(key, JSON.stringify([...values])); return true; } catch { return false; }
}

export function queuedGroupKey(sessionId: string, groupId: string): string {
  return `${sessionId}/${groupId}`;
}

export function readQueuedGroups(cardId: string): Set<string> {
  return readStringSet(queuedKey(cardId));
}

export function isGroupQueued(cardId: string, sessionId: string, groupId: string): boolean {
  return readQueuedGroups(cardId).has(queuedGroupKey(sessionId, groupId))
    || readScanUploadRecovery(cardId, sessionId, groupId)?.completed === true;
}

export function rememberQueuedGroup(cardId: string, sessionId: string, groupId: string): boolean {
  const values = readQueuedGroups(cardId);
  values.add(queuedGroupKey(sessionId, groupId));
  return writeStringSet(queuedKey(cardId), values);
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
