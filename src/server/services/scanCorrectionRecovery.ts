import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { DbAdapter } from "../db";
import { cardFingerprint } from "../../shared/cardVersion";
import { parseIdentityMode } from "../../shared/cardIdentity";
import { parseRecognitionDpi } from "../../apps/answer-card/server/helpers";
import { isInsideDir } from "./AnswerBlockCropService";
import { correctionCells, recognizedCells, type CorrectionPage } from "../../shared/scanCorrection";
import type { AnswerCard, CombinedRecognitionResult } from "../../shared/types";

const cell = z.object({ score:z.number().finite(), rect:z.object({x:z.number().finite(),y:z.number().finite(),width:z.number().positive(),height:z.number().positive()}).optional() });
export const recoveryRecognitionSchema = z.object({
  status:z.enum(["ok","partial","failed"]), pageNumber:z.number().int().positive(),
  geometry:z.object({imageWidth:z.number().int().positive().max(100000),imageHeight:z.number().int().positive().max(100000),
    imageToLayout:z.array(z.number().finite()).length(9),layoutToImage:z.array(z.number().finite()).length(9)}),
  identity:z.object({status:z.enum(["verified","unverified"]),code:z.string(),cardId:z.string().optional(),pageNumber:z.number().int().positive().optional()}),
  studentId:z.object({status:z.string(),value:z.string().max(64).nullable(),digits:z.array(z.object({digitIndex:z.number().int().min(0).max(63),selectedDigit:z.number().int().min(0).max(9).nullable(),selectedDigits:z.array(z.number().int().min(0).max(9)).max(10).optional()})).max(64).optional()}).optional(),
  questions:z.array(z.object({questionNumber:z.number().int().positive(),selectedOptions:z.array(z.string().max(8)).max(26),confidence:z.number().finite()})).max(1000),
  subjectiveQuestions:z.array(z.object({blockId:z.string().optional(),questionId:z.string(),questionNumber:z.union([z.number(),z.string()]),score:z.number().finite(),maxScore:z.number().nonnegative(),status:z.string(),confidence:z.number().finite(),validCells:z.array(cell).max(100),invalidCells:z.array(cell).max(100)})).max(1000),
}).refine(result => result.status !== "failed" || result.studentId?.status === "failed", {
  message: "重新识别失败，无法生成订正草稿",
  path: ["status"],
});

// Drafts never enter the database. A restart invalidates them and asks for recognition again.
const recoverySigningKey = randomBytes(32);
export function signRecovery(fingerprint: string, recognition: unknown): string {
  return createHmac("sha256", recoverySigningKey).update(fingerprint)
    .update(JSON.stringify(recoveryRecognitionSchema.parse(recognition))).digest("hex");
}
export function verifyRecovery(fingerprint: string, recognition: unknown, signature: unknown): void {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature,"hex"),Buffer.from(signRecovery(fingerprint,recognition),"hex"))) {
    throw new Error("补识别草稿已失效或被修改，请重新打开并识别");
  }
}

/** The draft is tied to the original image, layout and stored recognition, not just a record ID. */
export async function recoverySource(db: DbAdapter, card: AnswerCard, sourceId: string) {
  const row = await db.get<any>(`SELECT r.*,s.identity_mode,s.dpi,s.card_version,s.status AS session_status,g.objective_json,g.subjective_json
    FROM twain_scan_records r JOIN twain_scan_sessions s ON s.id=r.session_id
    LEFT JOIN twain_recognition_results g ON g.scan_record_id=r.id WHERE r.id=? AND s.card_id=?`,sourceId,card.id);
  if (!row || row.session_status === "scanning") throw new Error("原卷不存在或正在扫描");
  if (row.card_version && row.card_version !== cardFingerprint(card)) throw new Error("答题卡版式已变化，请核对原卷版本后重新扫描");
  const root = process.env.ANSWER_CARD_DATA_DIR || path.join(process.cwd(),"data","answer-card");
  if (!row.image_path || !isInsideDir(root,path.resolve(row.image_path))) throw new Error("原卷图片不存在");
  const bytes = await readFile(row.image_path);
  const metadata = await sharp(bytes).metadata();
  const fingerprint = createHash("sha256").update(JSON.stringify(row)).update(cardFingerprint(card)).update(bytes).digest("hex");
  return { fingerprint, identityMode:parseIdentityMode(row.identity_mode), dpi:parseRecognitionDpi(row.dpi), width:metadata.width,height:metadata.height,imagePath:row.image_path as string };
}

export function recoveredPage(card: AnswerCard, page: CorrectionPage, raw: unknown): CorrectionPage {
  const recognition = recoveryRecognitionSchema.parse(raw) as CombinedRecognitionResult;
  const identity = recognition.identity!;
  if (recognition.pageNumber !== page.layout.pageNumber || !(
    (identity.status === "verified" && identity.cardId === card.id && identity.pageNumber === page.layout.pageNumber) ||
    (page.recovery?.identityMode === "legacy" && identity.status === "unverified" && ["QR_MISSING","QR_UNREADABLE"].includes(identity.code)))) throw new Error("重新识别未通过原卷二维码和页码校验");
  const cells = correctionCells(page.layout);
  const expected = [...new Set(cells.filter(c=>c.type==="objective_option").map(c=>c.questionNumber))].sort().join();
  if (recognition.questions.map(q=>q.questionNumber).sort().join() !== expected) throw new Error("重新识别客观题数据不完整");
  const scores = [...new Set(cells.filter(c=>c.type==="score_cell").map(c=>c.questionId))].sort().join();
  if (recognition.subjectiveQuestions.map(q=>q.questionId).sort().join() !== scores) throw new Error("重新识别分数格数据不完整");
  const a = recognition.geometry!.imageToLayout, b = recognition.geometry!.layoutToImage;
  const product = Array.from({length:9},(_,i)=>[0,1,2].reduce((v,k)=>v+a[Math.floor(i/3)*3+k]*b[k*3+i%3],0));
  if (Math.abs(product[8])<1e-12 || product.some((v,i)=>Math.abs(v/product[8]-(i%4===0?1:0))>1e-5)) throw new Error("重新识别坐标变换无效");
  // A valid alignment with failed student marks is an editable partial draft.
  // correctionState still requires every student-number digit before saving.
  if (recognition.status === "failed") recognition.status = "partial";
  return {...page,recognition,...recognizedCells(page.layout,recognition)};
}
