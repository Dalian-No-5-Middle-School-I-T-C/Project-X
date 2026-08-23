/**
 * 主站侧扫描端在线状态（心跳服务）
 *
 * 扫描端定时（60s）调用 POST /api/scanner/heartbeat 上报，主站在此落库并更新
 * last_seen_at；管理端查询时按「最后心跳距今 < 3 分钟」判定在线/离线。
 * SQLite 与 MariaDB 双方言（表由 migrations v48 / mysql.ts v47 建）。
 */

import { getMysqlDb } from "../db";
import { buildUpsertSQL } from "../db/mysql";

/** 心跳超时阈值：超过 3 分钟未上报视为离线（心跳间隔 60s 的 3 倍） */
export const OFFLINE_AFTER_MS = 3 * 60 * 1000;

export interface ScannerClientRow {
  id: number;
  client_id: string;
  name: string;
  version: string;
  host: string;
  last_seen_at: string | null;
  first_seen_at: string;
}

export interface ScannerClientView extends ScannerClientRow {
  online: boolean;
  last_seen_ms: number | null;
}

/** 记录一次心跳（UPSERT：client_id 唯一键，存在则刷新 last_seen_at） */
export async function recordHeartbeat(params: {
  clientId: string;
  name?: string;
  version?: string;
  host?: string;
}): Promise<boolean> {
  try {
    const db = await getMysqlDb();
    const upsert = buildUpsertSQL(
      db.dialect,
      "scanner_clients",
      ["client_id", "name", "version", "host", "last_seen_at"],
      ["client_id"]
    );
    await db.run(
      upsert,
      params.clientId,
      params.name || "",
      params.version || "",
      params.host || "",
      new Date().toISOString()
    );
    return true;
  } catch (err: any) {
    console.warn("[Heartbeat] 记录失败:", err?.message ?? err);
    return false;
  }
}

/** 管理端查询：全部扫描端 + 在线状态（按最后心跳时间计算） */
export async function listScannerClients(): Promise<ScannerClientView[]> {
  const db = await getMysqlDb();
  const rows = await db.all<ScannerClientRow>(
    "SELECT * FROM scanner_clients ORDER BY last_seen_at DESC"
  );
  const now = Date.now();
  return rows.map((row) => {
    const lastMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : null;
    return {
      ...row,
      online: lastMs !== null && now - lastMs < OFFLINE_AFTER_MS,
      last_seen_ms: lastMs,
    };
  });
}
