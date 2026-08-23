/**
 * 扫描端远程上传队列（断线重传）
 *
 * 扫描完成 → 入队（本地 SQLite remote_upload_queue）→ 本机服务端后台串行上传主站：
 *   ① POST /api/scanner/upload/sessions 创建会话（拿逐页 token，落库以便续传）
 *   ② 逐页 POST .../pages（断点续传：跳过已传页）
 *   ③ POST .../complete 标记完成
 * 失败指数退避重试（1s/5s/15s/45s/120s，最多 5 次 → failed 保留，可手动重试）；
 * 应用重启自动恢复 uploading → pending 续传；
 * 超过 3 天的 pending/failed 项自动清理，done 项清理并释放本地扫描数据（图片/记录）。
 * 仅 SQLite 方言（扫描端本机库）生效；主站 MariaDB 下为空操作。
 */

import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { detectDialect, getMysqlDb } from "../db";
import type { DbAdapter } from "../db/mysql";
import { dataDir } from "../../apps/answer-card/server/storage";

// ── 类型 ─────────────────────────────────────────────

export interface UploadQueueItem {
  id: number;
  local_session_id: string;
  remote_session_id: string | null;
  server_url: string;
  api_key: string | null;
  card_id: string;
  dpi: number;
  paper_size: string;
  page_count: number;
  uploaded_pages: number;
  upload_tokens: string | null;
  status: "pending" | "uploading" | "done" | "failed";
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface EnqueueParams {
  localSessionId: string;
  serverUrl: string;
  apiKey: string | null;
  cardId: string;
  dpi: number;
  paperSize: string;
  pageCount: number;
}

interface ScanRecordRow {
  id: string;
  image_path: string;
  page_num: number;
  side: string;
}

// ── 常量 ─────────────────────────────────────────────

/** 指数退避间隔（毫秒）；与 MAX_RETRIES 对应 */
const RETRY_BACKOFF_MS = [1_000, 5_000, 15_000, 45_000, 120_000];
const MAX_RETRIES = RETRY_BACKOFF_MS.length;
/** 队列保留期 / 上传成功后本地数据保留期（毫秒）：3 天 */
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const TABLE = "remote_upload_queue";

// ── 状态 ─────────────────────────────────────────────

let running = false;
let started = false;

// ── 内部工具 ─────────────────────────────────────────

async function getDb(): Promise<DbAdapter> {
  return getMysqlDb();
}

/** 仅扫描端本机库（SQLite）支持；主站 MariaDB 短路返回 null */
async function ensureQueueTable(): Promise<DbAdapter | null> {
  if (detectDialect() !== "sqlite") return null;
  const db = await getDb();
  const row = await db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    TABLE
  );
  return row ? db : null;
}

/** 主站请求：拼地址 + 附加 X-Api-Key */
async function remoteFetch(
  serverUrl: string,
  apiKey: string | null,
  apiPath: string,
  init: RequestInit
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (apiKey) headers.set("X-Api-Key", apiKey);
  return fetch(`${serverUrl}${apiPath}`, { ...init, headers });
}

/** 本地图片路径兜底：绝对路径直接用；相对路径拼 dataDir */
function resolveImagePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.join(dataDir, p);
}

// ── 公开 API ─────────────────────────────────────────

/** 入队（幂等：同一本地会话未完成时复用并重置为 pending 续传） */
export async function enqueueUpload(params: EnqueueParams): Promise<UploadQueueItem | null> {
  const db = await ensureQueueTable();
  if (!db) return null;

  const existing = await db.get<UploadQueueItem>(
    "SELECT * FROM remote_upload_queue WHERE local_session_id = ? AND status != 'done'",
    params.localSessionId
  );
  if (existing) {
    await db.run(
      `UPDATE remote_upload_queue SET server_url=?, api_key=?, status='pending', retry_count=0,
       last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      params.serverUrl, params.apiKey ?? null, existing.id
    );
    void kick();
    return existing;
  }

  const result = await db.run(
    `INSERT INTO remote_upload_queue
       (local_session_id, server_url, api_key, card_id, dpi, paper_size, page_count, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    params.localSessionId,
    params.serverUrl,
    params.apiKey ?? null,
    params.cardId,
    params.dpi || 300,
    params.paperSize || "A4",
    params.pageCount || 0
  );
  const item = await db.get<UploadQueueItem>(
    "SELECT * FROM remote_upload_queue WHERE id = ?",
    result.lastInsertRowid
  );
  void kick();
  return item ?? null;
}

/** 队列列表（倒序，limit） */
export async function listUploadQueue(limit = 50): Promise<UploadQueueItem[]> {
  const db = await ensureQueueTable();
  if (!db) return [];
  const rows = await db.all<UploadQueueItem>(
    `SELECT * FROM remote_upload_queue ORDER BY id DESC LIMIT ?`,
    limit
  );
  return rows;
}

/** 手动重试（failed 项重置为 pending） */
export async function retryUploadQueueItem(id: number): Promise<boolean> {
  const db = await ensureQueueTable();
  if (!db) return false;
  await db.run(
    `UPDATE remote_upload_queue SET status='pending', retry_count=0, last_error=NULL,
     uploaded_pages=0, upload_tokens=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    id
  );
  void kick();
  return true;
}

/** 删除队列项 */
export async function deleteUploadQueueItem(id: number): Promise<boolean> {
  const db = await ensureQueueTable();
  if (!db) return false;
  await db.run("DELETE FROM remote_upload_queue WHERE id = ?", id);
  return true;
}

/**
 * 清理过期队列项（保留期 3 天）：
 * - pending / failed：直接删除（超期未传/放弃）
 * - done：删除队列项，并释放本地扫描数据（twain_scan_sessions 级联 records + 图片文件）
 * - uploading：跳过（可能正在传输）
 */
export async function cleanupExpiredUploads(): Promise<number> {
  const db = await ensureQueueTable();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  const expired = await db.all<UploadQueueItem>(
    `SELECT * FROM remote_upload_queue
     WHERE status IN ('pending','failed','done') AND updated_at < ?`,
    cutoff
  );
  let cleaned = 0;
  for (const item of expired) {
    try {
      if (item.status === "done") {
        // 释放本地扫描数据：先取图片路径再删会话（级联删除 records）
        const records = await db.all<ScanRecordRow>(
          "SELECT id, image_path FROM twain_scan_records WHERE session_id = ?",
          item.local_session_id
        );
        for (const rec of records) {
          try { rmSync(resolveImagePath(rec.image_path), { force: true }); } catch { /* ignore */ }
        }
        await db.run("DELETE FROM twain_scan_sessions WHERE id = ?", item.local_session_id);
      }
      await db.run("DELETE FROM remote_upload_queue WHERE id = ?", item.id);
      cleaned++;
    } catch (err: any) {
      console.warn(`[UploadQueue] 清理队列项 ${item.id} 失败:`, err?.message ?? err);
    }
  }
  if (cleaned > 0) console.log(`[UploadQueue] 清理过期队列项 ${cleaned} 条（保留期 3 天）`);
  return cleaned;
}

/** 服务启动时调用：恢复中断队列 + 清理过期项 */
export function startUploadQueue(): void {
  if (started) return;
  started = true;
  void (async () => {
    try {
      const db = await ensureQueueTable();
      if (!db) return;
      await db.run(
        `UPDATE remote_upload_queue SET status='pending', updated_at=CURRENT_TIMESTAMP
         WHERE status='uploading'`
      );
      console.log("[UploadQueue] 启动：已恢复中断的上传队列");
      await cleanupExpiredUploads();
      void kick();
    } catch (err: any) {
      console.warn("[UploadQueue] 启动恢复失败:", err?.message ?? err);
    }
  })();
}

// ── 执行器 ───────────────────────────────────────────

async function kick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await drain();
  } finally {
    running = false;
  }
}

async function drain(): Promise<void> {
  const db = await ensureQueueTable();
  if (!db) return;
  for (;;) {
    const item = await db.get<UploadQueueItem>(
      "SELECT * FROM remote_upload_queue WHERE status='pending' ORDER BY id ASC LIMIT 1"
    );
    if (!item) break;
    await processItem(db, item);
  }
}

async function processItem(db: DbAdapter, item: UploadQueueItem): Promise<void> {
  await db.run(
    `UPDATE remote_upload_queue SET status='uploading', updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    item.id
  );
  try {
    // ① 创建/复用主站会话
    let remoteSessionId = item.remote_session_id;
    let tokens: string[] = item.upload_tokens ? JSON.parse(item.upload_tokens) : [];

    if (!remoteSessionId) {
      const createRes = await remoteFetch(item.server_url, item.api_key, "/api/scanner/upload/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId: item.card_id,
          name: `扫描_${item.card_id}_${new Date().toISOString().slice(0, 10)}`,
          dpi: item.dpi || 300,
          paperSize: item.paper_size || "A4",
          pageCount: item.page_count,
        }),
      });
      if (!createRes.ok) {
        const body = (await createRes.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message || `创建远程会话失败（HTTP ${createRes.status}）`);
      }
      const created = (await createRes.json()) as { sessionId: string; uploadTokens: string[] };
      remoteSessionId = created.sessionId;
      tokens = created.uploadTokens || [];
      await db.run(
        `UPDATE remote_upload_queue SET remote_session_id=?, upload_tokens=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        remoteSessionId, JSON.stringify(tokens), item.id
      );
    }

    // ② 逐页上传（断点续传：跳过已传页数）
    const records = await db.all<ScanRecordRow>(
      "SELECT id, image_path, page_num, side FROM twain_scan_records WHERE session_id = ? ORDER BY page_num, side",
      item.local_session_id
    );
    let uploaded = Number(item.uploaded_pages) || 0;

    for (let i = uploaded; i < records.length; i++) {
      const rec = records[i];
      const token = tokens[i];
      const imagePath = resolveImagePath(rec.image_path);
      let buffer: Buffer;
      try {
        buffer = readFileSync(imagePath);
      } catch {
        throw new Error(`本地扫描页文件缺失: ${rec.image_path}`);
      }

      const form = new FormData();
      form.append("image", new Blob([buffer as unknown as BlobPart]), `page_${rec.page_num}.jpg`);
      form.append("token", token ?? "");
      form.append("pageNum", String(rec.page_num));
      form.append("side", rec.side);

      const pageRes = await remoteFetch(item.server_url, item.api_key, `/api/scanner/upload/sessions/${remoteSessionId}/pages`, {
        method: "POST",
        body: form as unknown as BodyInit,
      });
      if (!pageRes.ok) {
        const body = (await pageRes.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message || `第 ${rec.page_num} 页上传失败（HTTP ${pageRes.status}）`);
      }
      uploaded = i + 1;
      await db.run(
        `UPDATE remote_upload_queue SET uploaded_pages=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        uploaded, item.id
      );
    }

    // ③ 完成
    const completeRes = await remoteFetch(item.server_url, item.api_key, `/api/scanner/upload/sessions/${remoteSessionId}/complete`, {
      method: "POST",
    });
    if (!completeRes.ok) {
      const body = (await completeRes.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message || `提交扫描会话失败（HTTP ${completeRes.status}）`);
    }

    await db.run(
      `UPDATE remote_upload_queue SET status='done', last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      item.id
    );
    console.log(`[UploadQueue] 会话 ${item.local_session_id} 上传完成（${uploaded}/${records.length} 页）`);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const nextRetry = Number(item.retry_count) + 1;
    if (nextRetry <= MAX_RETRIES) {
      await db.run(
        `UPDATE remote_upload_queue SET status='pending', retry_count=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        nextRetry, message, item.id
      );
      console.warn(`[UploadQueue] 会话 ${item.local_session_id} 上传失败（第 ${nextRetry} 次）: ${message}`);
      const delay = RETRY_BACKOFF_MS[nextRetry - 1];
      setTimeout(() => void kick(), delay);
    } else {
      await db.run(
        `UPDATE remote_upload_queue SET status='failed', retry_count=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        nextRetry, message, item.id
      );
      console.warn(`[UploadQueue] 会话 ${item.local_session_id} 上传失败（已放弃，可在界面手动重试）: ${message}`);
    }
  }
}
