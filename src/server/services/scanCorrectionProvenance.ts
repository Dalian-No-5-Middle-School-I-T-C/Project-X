import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { DbAdapter } from "../db";
import type { AnswerCard, CombinedRecognitionResult } from "../../shared/types";
import { cardFingerprint, gradingVersion, layoutFingerprint, stableVersionStringify } from "../../shared/cardVersion";
import { buildLayout } from "../../shared/layout";
import { mapScanPageToLayout } from "../../shared/scanPages";
import { assertScanImageDimensions } from "../lib/scanImageBudget";
import { isInsideDir } from "./AnswerBlockCropService";

type VersionedSession = {
  card_id: string;
  card_version: string | null;
  layout_fingerprint: string | null;
  grading_version?: string | null;
  version_source: string;
};

export function needsCorrectionProvenance(session: VersionedSession) {
  return !session.layout_fingerprint || session.version_source === "legacy_verified";
}

function parseJson(raw: unknown): any {
  if (typeof raw !== "string") return raw;
  return JSON.parse(raw);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableVersionStringify(left) === stableVersionStringify(right);
}

function validHomography(value: unknown): boolean {
  return Array.isArray(value) && value.length === 9 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function inverseHomography(a: unknown, b: unknown): boolean {
  if (!validHomography(a) || !validHomography(b)) return false;
  const left = a as number[], right = b as number[];
  const product = Array.from({ length: 9 }, (_, i) =>
    [0, 1, 2].reduce((sum, k) => sum + left[Math.floor(i / 3) * 3 + k] * right[k * 3 + i % 3], 0));
  return Math.abs(product[8]) >= 1e-12
    && product.every((value, i) => Math.abs(value / product[8] - (i % 4 === 0 ? 1 : 0)) <= 1e-5);
}

/**
 * v72 前会话只有混合哈希，不能据此放行。逐页核对实际落库的 layout_json、
 * 原图尺寸、二维码/兼容身份、识别矩阵和主识别 JSON；全部一致才允许显式升级。
 * 这只复用已有 OMR，不调用识别器，也不要求重新扫描。
 */
export async function verifySessionLayoutEvidence(
  db: DbAdapter,
  card: AnswerCard,
  sessionId: string,
): Promise<true> {
  const session = await db.get<VersionedSession & { status: string; identity_mode: string }>(
    "SELECT card_id,card_version,layout_fingerprint,grading_version,version_source,status,identity_mode FROM twain_scan_sessions WHERE id=?",
    sessionId,
  );
  if (!session || session.card_id !== card.id) throw new Error("原扫描会话与答题卡不匹配");
  if (session.status === "scanning") throw new Error("扫描会话仍在进行，请完成后再处理");
  const currentLayout = buildLayout(card);
  const correctionSourceMatch = db.dialect === "mariadb"
    ? "c.source_id = CONVERT(r.id USING utf8mb4) COLLATE utf8mb4_unicode_ci"
    : "c.source_id = r.id";
  const rows = await db.all<any>(
    `SELECT r.*,g.objective_json,g.subjective_json,c.layout_json,c.recognition_json,c.layout_fingerprint
     FROM twain_scan_records r
     JOIN twain_scan_sessions s ON s.id=r.session_id
     LEFT JOIN twain_recognition_results g ON g.scan_record_id=r.id
     LEFT JOIN scan_correction_pages c ON c.source_type='twain_scan_record' AND ${correctionSourceMatch}
     WHERE r.session_id=? ORDER BY r.page_num,r.side,r.id`,
    sessionId,
  );
  if (!rows.length) throw new Error("原卷不存在，请重新识别");
  const root = process.env.ANSWER_CARD_DATA_DIR || path.join(process.cwd(), "data", "answer-card");
  let verified = 0;
  for (const row of rows) {
    const mapped = mapScanPageToLayout(Number(row.page_num), row.side, currentLayout.pages.length, card.sided);
    if (mapped.unusedSide) continue;
    if (!row.image_path || !isInsideDir(root, path.resolve(row.image_path))) {
      throw new Error("原卷图片缺失或路径无效，请重新识别，无需重新扫描");
    }
    if (!row.layout_json || !row.recognition_json || !row.identity_json || !row.objective_json) {
      throw new Error("原卷缺少可验证的识别凭据，请重新识别，无需重新扫描");
    }
    const expected = currentLayout.pages.find((page) => page.pageNumber === mapped.layoutPage);
    if (!expected || !sameJson(parseJson(row.layout_json), expected)) {
      throw new Error("原卷版式与当前答题卡不一致，请重新识别，无需重新扫描");
    }
    const recognition = parseJson(row.recognition_json) as CombinedRecognitionResult;
    if (recognition.pageNumber !== mapped.layoutPage || recognition.status === "failed") {
      throw new Error("原卷识别失败或页码不一致，请重新识别，无需重新扫描");
    }
    const metadata = await assertScanImageDimensions(row.image_path);
    if (recognition.geometry?.imageWidth !== metadata.width || recognition.geometry?.imageHeight !== metadata.height
      || !inverseHomography(recognition.geometry?.imageToLayout, recognition.geometry?.layoutToImage)) {
      throw new Error("原卷坐标映射无效，请重新识别，无需重新扫描");
    }
    const identity = recognition.identity;
    const identityValid = identity?.status === "verified" && identity.cardId === card.id && identity.pageNumber === mapped.layoutPage;
    const legacyValid = session.identity_mode === "legacy" && identity?.status === "unverified"
      && ["QR_MISSING", "QR_UNREADABLE"].includes(identity.code);
    if ((!identityValid && !legacyValid) || !sameJson(parseJson(row.identity_json), identity)) {
      throw new Error("原卷身份凭据无效，请重新识别，无需重新扫描");
    }
    const expectedQuestions = [...new Set(expected.elements.filter((element) => element.type === "objective_option")
      .map((element) => element.questionNumber))].sort((a, b) => a - b);
    const actualQuestions = (recognition.questions ?? []).map((question) => question.questionNumber).sort((a, b) => a - b);
    if (!sameJson(expectedQuestions, actualQuestions)) throw new Error("原卷客观题坐标与当前版式不一致，请重新识别");
    const expectedScores = [...new Set(expected.elements.filter((element) => element.type === "score_cell")
      .map((element) => element.questionId))].sort();
    const actualScores = [...new Set((recognition.subjectiveQuestions ?? [])
      .map((question) => question.questionId))].sort();
    if (!sameJson(expectedScores, actualScores)) throw new Error("原卷分数格与当前版式不一致，请重新识别");
    if (!sameJson(parseJson(row.objective_json), recognition.questions)
      || !sameJson(parseJson(row.subjective_json ?? "[]"), recognition.subjectiveQuestions ?? [])) {
      throw new Error("原卷识别凭据不一致，请重新识别");
    }
    verified += 1;
  }
  if (!verified) throw new Error("原卷没有可验证的识别页，请重新识别");
  return true;
}

/** 显式升级只写经过核验的几何/判分版本，并刷新旧混合哈希产生的恢复凭据。 */
export async function upgradeSessionLayoutVersions(db: DbAdapter, card: AnswerCard, sessionId: string): Promise<void> {
  const session = await db.get<VersionedSession>(
    "SELECT card_id,card_version,layout_fingerprint,grading_version,version_source FROM twain_scan_sessions WHERE id=?",
    sessionId,
  );
  if (!session || session.card_id !== card.id) throw new Error("原扫描会话与答题卡不匹配");
  const geometry = layoutFingerprint(card), grading = gradingVersion(card);
  if (session.layout_fingerprint) {
    if (session.layout_fingerprint !== geometry) throw new Error("答题卡版式已变化，请重新识别，无需重新扫描");
    if (session.grading_version !== grading) {
      await db.run("UPDATE twain_scan_sessions SET grading_version=? WHERE id=?", grading, sessionId);
    }
    return;
  }
  const trustedUpload = session.version_source === "upload" && session.card_version === cardFingerprint(card);
  if (!trustedUpload) await verifySessionLayoutEvidence(db, card, sessionId);
  const source = trustedUpload ? "upload" : "layout_verified";
  await db.run(
    "UPDATE twain_scan_sessions SET layout_fingerprint=?,grading_version=?,version_source=? WHERE id=?",
    geometry, grading, source, sessionId,
  );
  const recordIds = (await db.all<{ id: string }>(
    "SELECT id FROM twain_scan_records WHERE session_id=?",
    sessionId,
  )).map((row) => row.id);
  if (!recordIds.length) return;
  const pages = await db.all<{ source_id: string; recovery_fingerprint: string | null }>(
    `SELECT source_id,recovery_fingerprint FROM scan_correction_pages WHERE source_type=? AND source_id IN (${recordIds.map(() => "?").join(",")})`,
    "twain_scan_record", ...recordIds,
  );
  for (const page of pages) {
    await db.run(
      "UPDATE scan_correction_pages SET layout_fingerprint=?,grading_version=? WHERE source_type='twain_scan_record' AND source_id=?",
      geometry, grading, page.source_id,
    );
    if (page.recovery_fingerprint) {
      await db.run(
        "UPDATE scan_correction_pages SET recovery_fingerprint=? WHERE source_type='twain_scan_record' AND source_id=?",
        await correctionSourceFingerprint(db, card, page.source_id), page.source_id,
      );
    }
  }
}

/** Bind a server-verified recovery to this page, its corrected marks and its original bytes. */
export async function correctionSourceFingerprint(db: DbAdapter, card: AnswerCard, sourceId: string): Promise<string> {
  const row = await db.get<any>(`SELECT r.id,r.session_id,r.card_id,r.page_num,r.side,r.image_path,r.student_id,r.identity_json,
    s.identity_mode,s.dpi,g.objective_json,g.subjective_json,c.card_version,c.layout_fingerprint,c.layout_json,c.recognition_json,c.revision
    FROM twain_scan_records r JOIN twain_scan_sessions s ON s.id=r.session_id
    JOIN twain_recognition_results g ON g.scan_record_id=r.id
    JOIN scan_correction_pages c ON c.source_type='twain_scan_record' AND c.source_id=?
    WHERE r.id=? AND s.card_id=? AND r.card_id=?`, sourceId, sourceId, card.id, card.id);
  if (!row) throw new Error("旧卷恢复凭据与当前答题卡版本不符，请重新识别并保存");
  const expected = buildLayout(card).pages.find((page) => page.pageNumber === Number(parseJson(row.recognition_json).pageNumber));
  const layoutMatches = row.layout_fingerprint
    ? row.layout_fingerprint === layoutFingerprint(card)
    : expected && sameJson(parseJson(row.layout_json), expected);
  if (!layoutMatches) throw new Error("旧卷恢复凭据与当前答题卡版式不符，请重新识别并保存");
  const root = process.env.ANSWER_CARD_DATA_DIR || path.join(process.cwd(), "data", "answer-card");
  if (!row.image_path || !isInsideDir(root, path.resolve(row.image_path))) throw new Error("原卷图片不存在");
  await assertScanImageDimensions(row.image_path);
  const hash = createHash("sha256").update(JSON.stringify(row));
  for await (const chunk of createReadStream(row.image_path)) hash.update(chunk);
  return hash.digest("hex");
}

export const STALE_CORRECTION_PROVENANCE = "旧卷恢复凭据已失效，请重新核验原图与识别结果后再保存";

export type CorrectionProvenanceState = "absent" | "valid" | "invalid";

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

export async function assertCorrectionPageProvenance(db: DbAdapter, card: AnswerCard, sourceId: string): Promise<string | null> {
  const state = await correctionProvenanceState(db, card, sourceId);
  if (state === "invalid") throw new Error(STALE_CORRECTION_PROVENANCE);
  if (state === "absent") return null;
  const row = await db.get<{ recovery_fingerprint: string | null }>(
    "SELECT recovery_fingerprint FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?", sourceId);
  return row?.recovery_fingerprint ?? null;
}

export async function hasCorrectionProvenance(db: DbAdapter, card: AnswerCard, sourceId: string): Promise<boolean> {
  return await correctionProvenanceState(db, card, sourceId) === "valid";
}

export function requiresCorrectionPageProvenance(card: AnswerCard, session: VersionedSession): boolean {
  // 旧库当前完整混合哈希相等仍证明卡内容未变；但绝不把它写入或当作 layout_fingerprint。
  return needsCorrectionProvenance(session) && session.card_version !== cardFingerprint(card);
}

export function assertCorrectionSessionVersion(card: AnswerCard, session: VersionedSession | null | undefined): asserts session is VersionedSession {
  if (!session || session.card_id !== card.id) throw new Error("原扫描会话与考试答题卡不匹配");
  if (session.layout_fingerprint && session.layout_fingerprint !== layoutFingerprint(card)) throw new Error("答题卡版式已变化，请重新识别，无需重新扫描");
}
export async function assertCorrectionGroupVersion(db: DbAdapter, card: AnswerCard,
  session: VersionedSession | null | undefined, sourceIds: string[]) {
  assertCorrectionSessionVersion(card, session);
  const fingerprints: string[] = [];
  const required = requiresCorrectionPageProvenance(card, session);
  if (required && !sourceIds.length) throw new Error("原卷不存在，请刷新");
  for (const id of sourceIds) {
    const page = await db.get<{ layout_fingerprint: string | null; layout_json: string; recognition_json: string }>(
      "SELECT layout_fingerprint,layout_json,recognition_json FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?", id);
    if (page) {
      const recognition = parseJson(page.recognition_json);
      const expected = buildLayout(card).pages.find((layout) => layout.pageNumber === recognition?.pageNumber);
      const stored = parseJson(page.layout_json);
      if (!expected || (page.layout_fingerprint ? page.layout_fingerprint !== layoutFingerprint(card) : !sameJson(stored, expected))) {
        throw new Error("原卷版式与当前答题卡不一致，请重新识别，无需重新扫描");
      }
    }
    const fingerprint = await assertCorrectionPageProvenance(db, card, id);
    if (!fingerprint && required) throw new Error("此旧卷尚未完成原图与答题卡版本核验，请打开整卡改分，重新识别并保存");
    if (fingerprint) fingerprints.push(fingerprint);
  }
  return fingerprints;
}
