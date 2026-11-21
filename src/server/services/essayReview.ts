import { accessSync, constants } from "node:fs";
import type { DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { buildLayout } from "../../shared/layout";
import type { ReviewImage } from "../../shared/types";
import type { ScanBatchPage } from "../../shared/scanPages";

/** Historical releases stored one review row per physical essay panel. Keep the latest
 * existing review (or outstanding claim) as the unit's state and leave the original rows intact. */
export function reviewUnitPredicate(alias: string): string {
  return `(NOT EXISTS (
    SELECT 1 FROM subjective_blocks eb WHERE eb.card_id=${alias}.card_id
      AND eb.id=${alias}.block_id AND eb.block_kind='essay'
  ) OR ${alias}.id=(
    SELECT peer.id FROM answer_block_crops peer WHERE peer.exam_id=${alias}.exam_id
      AND peer.student_id=${alias}.student_id AND peer.card_id=${alias}.card_id AND peer.block_id=${alias}.block_id
    ORDER BY CASE WHEN peer.source_type='twain_scan_record' THEN 0 ELSE 1 END,
      (SELECT r.batch_id FROM scan_records r WHERE peer.source_type='scan_record' AND r.id=peer.source_record_id) DESC,
      (peer.reviewed_at IS NULL), peer.reviewed_at DESC, COALESCE(peer.review_round,0) DESC,
      (peer.claimed_by IS NULL), peer.page_number, peer.segment_index, peer.id LIMIT 1
  ))`;
}

// The scanner and correction writers take this exam lock before replacing an answer.
export async function lockEssayReview(db: DbAdapter, examId: number, blockId: string): Promise<void> {
  await db.run(`UPDATE exams SET id=id WHERE id=? AND EXISTS (
    SELECT 1 FROM subjective_blocks b WHERE b.card_id=exams.card_id AND b.id=? AND b.block_kind='essay'
  )`, examId, blockId);
}

type Part = {
  id: string; card_id: string; student_id: number; student_number: string | null; block_id: string;
  page_number: number; segment_index: number; source_type: string; source_record_id: string;
  width_px: number; height_px: number; image_path: string; batch_id: number | null; question_numbers: string | Array<number | string>;
  status: string; review_round: number; claimed_by: number | null; is_unit: number;
};

type Essay = {
  unit: Part;
  images: ReviewImage[];
  files: string[];
  issue?: string;
};

function arrayValue<T>(raw: string | T[]): T[] {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export async function loadEssayReviews(db: DbAdapter, examId: number, blockId?: string, studentId?: number): Promise<Map<string, Essay>> {
  const rows = await db.all<Part>(`SELECT a.id,a.card_id,a.student_id,u.student_number,a.block_id,a.page_number,
    a.segment_index,a.source_type,a.source_record_id,a.width_px,a.height_px,a.image_path,a.question_numbers,
    a.status,a.review_round,a.claimed_by,b.id AS batch_id,${reviewUnitPredicate("a")} AS is_unit
    FROM answer_block_crops a JOIN subjective_blocks eb ON eb.card_id=a.card_id AND eb.id=a.block_id AND eb.block_kind='essay'
    JOIN users u ON u.id=a.student_id
    LEFT JOIN scan_records r ON a.source_type='scan_record' AND r.id=a.source_record_id AND r.student_id=a.student_id
    LEFT JOIN scan_batches b ON b.id=r.batch_id AND b.exam_id=a.exam_id
    WHERE a.exam_id=? AND a.student_id IS NOT NULL${blockId ? " AND a.block_id=?" : ""}${studentId != null ? " AND a.student_id=?" : ""}
    ORDER BY a.page_number,a.segment_index,a.id`, examId, ...(blockId ? [blockId] : []), ...(studentId != null ? [studentId] : []));
  const byCrop = new Map<string, Essay>();
  if (!rows.length) return byCrop;

  const expected = new Map<string, Array<{ page: number; segment: number; question: string }>>();
  for (const cardId of new Set(rows.map(r => r.card_id))) {
    const card = await new CardRepository(db).findById(cardId);
    if (!card) continue;
    for (const page of buildLayout(card).pages) {
      const crops = page.blocks.filter(b => b.type === "objective" ? b.items.length : b.questions.length);
      crops.forEach((block, i) => {
        if (block.type !== "subjective" || block.essayStartCell == null) return;
        const key = JSON.stringify([cardId, block.blockId]);
        const pieces = expected.get(key) ?? [];
        pieces.push({ page: page.pageNumber, segment: i + 1, question: String(block.questions[0].questionNumber) });
        expected.set(key, pieces);
      });
    }
  }

  const groups = new Map<string, Part[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.student_id, row.card_id, row.block_id]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  // Imported regrades keep the previous scans. The correction editor also uses the
  // student's latest completed batch when no saved scanner receipt owns the answer.
  const currentBatch = new Map<number, number>();
  if (rows.some(p => p.source_type === "scan_record")) {
    const batches = await db.all<{ student_id: number; batch_id: number }>(
      `SELECT r.student_id, MAX(r.batch_id) AS batch_id FROM scan_records r
       JOIN scan_batches b ON b.id=r.batch_id WHERE b.exam_id=? AND b.status IN ('done','partial')
       ${studentId != null ? "AND r.student_id=?" : ""} GROUP BY r.student_id`,
      examId, ...(studentId != null ? [studentId] : []));
    for (const b of batches) currentBatch.set(b.student_id, b.batch_id);
  }
  // For a multi-page TWAIN answer the accepted receipt identifies each physical page.
  const receipts = new Map<string, Array<Map<number, string>>>();
  if ([...groups.values()].some(group => group.some(p => p.source_type === "twain_scan_record") && new Set(group.map(p => p.page_number)).size > 1)) {
    const saved = await db.all<{ student_number: string; pages_json: string }>(
      `SELECT student_number,pages_json FROM scanner_submissions WHERE exam_id=? AND state='saved'
        ${studentId != null ? " AND student_number=?" : ""}`,
      examId, ...(studentId != null ? [rows[0].student_number] : []));
    for (const receipt of saved) {
      const pages = arrayValue<ScanBatchPage>(receipt.pages_json);
      if (!pages.length || pages.some(p => !p?.layoutPage || !p.recordId)
        || new Set(pages.map(p => p.layoutPage)).size !== pages.length) continue;
      const answers = receipts.get(receipt.student_number) ?? [];
      answers.push(new Map(pages.map(p => [p.layoutPage, p.recordId])));
      receipts.set(receipt.student_number, answers);
    }
  }

  for (const history of groups.values()) {
    const unit = history.find(p => Number(p.is_unit) === 1)!;
    const group = history.filter(p => p.source_type === unit.source_type &&
      (p.source_type !== "scan_record" || p.batch_id === unit.batch_id));
    const layout = expected.get(JSON.stringify([unit.card_id, unit.block_id]));
    const complete = layout?.length === group.length && group.every((part, i) => {
      const slot = layout[i];
      const questions = arrayValue(part.question_numbers);
      return part.page_number === slot.page && part.segment_index === slot.segment && questions?.length === 1
        && String(questions[0]) === slot.question && part.source_type === unit.source_type;
    });
    const byPage = new Map(group.map(p => [p.page_number, p.source_record_id]));
    const samePages = group.every(p => byPage.get(p.page_number) === p.source_record_id)
      && new Set(byPage.values()).size === byPage.size;
    const sameAnswer = samePages && (unit.source_type === "scan_record"
      ? unit.batch_id != null && unit.batch_id === currentBatch.get(unit.student_id)
      : byPage.size === 1 || (receipts.get(unit.student_number ?? "") ?? []).filter(
          pages => group.every(p => pages.get(p.page_number) === p.source_record_id)).length === 1);
    const essay: Essay = {
      unit,
      files: group.map(p => p.image_path),
      images: group.map(p => ({
        id: p.id, pageNumber: p.page_number, segmentIndex: p.segment_index, widthPx: p.width_px, heightPx: p.height_px,
        imageUrl: `/api/answer-block-crops/${encodeURIComponent(p.id)}/image`,
      })),
      ...(!complete || !sameAnswer ? { issue: "作文切图缺失、重复或原卷归属不一致，请核对扫描记录后重新领取" } : {}),
    };
    for (const part of history) byCrop.set(part.id, essay);
  }
  return byCrop;
}

export function essayReviewIssue(group: Essay | undefined, cropId: string): string | undefined {
  if (group && group.unit.id !== cropId) return "该切图属于同一篇作文，请从试卷池领取整篇作文";
  if (!group || group.issue) return group?.issue;
  try {
    for (const file of group.files) accessSync(file, constants.R_OK);
  } catch {
    return "作文切图文件缺失，请恢复原图后再阅卷";
  }
}
