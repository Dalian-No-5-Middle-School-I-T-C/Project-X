import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { DbAdapter } from "../db";
import type { AnswerCard } from "../../shared/types";
import { cardFingerprint } from "../../shared/cardVersion";
import { assertScanImageDimensions } from "../lib/scanImageBudget";
import { isInsideDir } from "./AnswerBlockCropService";

export function needsCorrectionProvenance(session: { card_version: string | null; version_source: string }) {
  return !session.card_version || session.version_source === "legacy_verified";
}

/** Bind a server-verified recovery to this page, its corrected marks and its original bytes. */
export async function correctionSourceFingerprint(db: DbAdapter, card: AnswerCard, sourceId: string): Promise<string> {
  const row = await db.get<any>(`SELECT r.id,r.session_id,r.card_id,r.page_num,r.side,r.image_path,r.student_id,r.identity_json,
    s.identity_mode,s.dpi,g.objective_json,g.subjective_json,c.card_version,c.layout_json,c.recognition_json,c.revision
    FROM twain_scan_records r JOIN twain_scan_sessions s ON s.id=r.session_id
    JOIN twain_recognition_results g ON g.scan_record_id=r.id
    JOIN scan_correction_pages c ON c.source_type='twain_scan_record' AND c.source_id=?
    WHERE r.id=? AND s.card_id=? AND r.card_id=?`, sourceId, sourceId, card.id, card.id);
  if (!row || row.card_version !== cardFingerprint(card)) throw new Error("旧卷恢复凭据与当前答题卡版本不符，请重新识别并保存");
  const root = process.env.ANSWER_CARD_DATA_DIR || path.join(process.cwd(), "data", "answer-card");
  if (!row.image_path || !isInsideDir(root, path.resolve(row.image_path))) throw new Error("原卷图片不存在");
  await assertScanImageDimensions(row.image_path);
  const hash = createHash("sha256").update(JSON.stringify(row));
  for await (const chunk of createReadStream(row.image_path)) hash.update(chunk);
  return hash.digest("hex");
}

export const STALE_CORRECTION_PROVENANCE = "旧卷恢复凭据已失效，请重新核验原图与识别结果后再保存";

export type CorrectionProvenanceState = "absent" | "valid" | "invalid";

/**
 * 没有恢复指纹的页按普通扫描处理。已经写过指纹、但原图或识别结果对不上的页
 * 不能再当成普通扫描改正式成绩，调用方必须要求重新核验。
 */
export async function correctionProvenanceState(db: DbAdapter, card: AnswerCard, sourceId: string): Promise<CorrectionProvenanceState> {
  const row = await db.get<{ recovery_fingerprint: string | null }>(
    "SELECT recovery_fingerprint FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?", sourceId);
  if (!row?.recovery_fingerprint) return "absent";
  try {
    return row.recovery_fingerprint === await correctionSourceFingerprint(db, card, sourceId) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

async function verifiedCorrectionFingerprint(db: DbAdapter, card: AnswerCard, sourceId: string): Promise<string | null> {
  if (await correctionProvenanceState(db, card, sourceId) !== "valid") return null;
  const row = await db.get<{ recovery_fingerprint: string | null }>(
    "SELECT recovery_fingerprint FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?", sourceId);
  return row?.recovery_fingerprint ?? null;
}

export async function hasCorrectionProvenance(db: DbAdapter, card: AnswerCard, sourceId: string): Promise<boolean> {
  return await correctionProvenanceState(db, card, sourceId) === "valid";
}

export async function assertCorrectionGroupVersion(db: DbAdapter, card: AnswerCard,
  session: { card_id: string; card_version: string | null; version_source: string } | null | undefined, sourceIds: string[]) {
  if (!session || session.card_id !== card.id) throw new Error("原扫描会话与考试答题卡不匹配");
  if (session.card_version && session.card_version !== cardFingerprint(card)) throw new Error("答题卡版本已变化，请核对原卷版本后重新扫描");
  const fingerprints: string[] = [];
  if (needsCorrectionProvenance(session)) {
    if (!sourceIds.length) throw new Error("原卷不存在，请刷新");
    for (const id of sourceIds) {
      const fingerprint = await verifiedCorrectionFingerprint(db, card, id);
      if (!fingerprint) throw new Error("此旧卷尚未完成原图与答题卡版本核验，请打开整卡改分，重新识别并保存");
      fingerprints.push(fingerprint);
    }
  }
  return fingerprints;
}
