/**
 * v53: 考试级「原卷 + 逐题正确答案」读取服务
 *
 * 教师端配置接口与学生端查看接口共用这里的文件/数据解析，避免两处各写一遍
 * 目录探测与扩展名兜底逻辑。三条硬约束：
 * 1. 原卷图片是「答题卡级」资产（original_paper_pages 以 card_id 为键），
 *    考试通过 exams.card_id 关联，因此读取需要先拿到考试绑定的答题卡。
 * 2. 只返回磁盘上真实存在的页：DB 有记录但文件被清理时按「未上传」处理，
 *    避免把 404 图片链接交给客户端。
 * 3. 答案文字按教师保存的原样输出，本服务不做任何对错判断或选项归一化。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { getMysqlDb, type DbAdapter } from "../db/mysql";
import { answerKeyDir, paperDir } from "../../apps/answer-card/server/storage";
import { getFileMime } from "../../apps/answer-card/server/paper-ocr";

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".bmp", ".webp"];
export const ANSWER_KEY_EXTENSIONS = [...IMAGE_EXTENSIONS, ".tiff", ".tif", ".pdf", ".docx"];

export type PaperPageView = {
  pageIndex: number;
  filename: string;
  mimeType: string;
  isImage: boolean;
};

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

/** 答题卡原卷的磁盘文件名（第 1 页沿用 legacy 的 original.<ext>） */
export function paperPageBaseName(pageIndex: number): string {
  return pageIndex === 1 ? "original" : `original-${pageIndex}`;
}

/**
 * 解析某页原卷的实际文件：优先图片，其次 PDF/DOCX。
 * 扩展名靠探测而非信任 DB 的 stored_path —— 与既有 /api/cards/:cardId/paper 一致。
 */
export function resolvePaperPageFile(
  cardId: string,
  pageIndex: number
): { filePath: string; filename: string; mimeType: string; isImage: boolean } | null {
  if (!cardId || !Number.isInteger(pageIndex) || pageIndex < 1) return null;
  const dir = paperDir(cardId);
  const baseName = paperPageBaseName(pageIndex);
  const candidates = [
    ...IMAGE_EXTENSIONS.map((ext) => `${baseName}${ext}`),
    `${baseName}.pdf`,
    `${baseName}.docx`,
  ];
  for (const filename of candidates) {
    const filePath = path.join(dir, filename);
    if (!existsSync(filePath)) continue;
    return { filePath, filename, mimeType: getFileMime(filename), isImage: isImageFile(filename) };
  }
  return null;
}

/**
 * 列出该考试所绑答题卡的原卷页（按页码升序，仅保留磁盘上存在的页）。
 * original_paper_pages 无记录时回溯 legacy 单页原卷（旧数据未入库分页表）。
 */
export async function listExamPaperPages(
  cardId: string | null | undefined,
  db: DbAdapter = getMysqlDb()
): Promise<PaperPageView[]> {
  if (!cardId) return [];
  const rows = await db.all<{ page_index: number }>(
    "SELECT page_index FROM original_paper_pages WHERE card_id = ? ORDER BY page_index",
    cardId
  ) as Array<{ page_index: number }>;

  const pageIndexes = rows.length > 0
    ? rows.map((row) => Number(row.page_index)).filter((n) => Number.isInteger(n) && n >= 1)
    : [1]; // 旧数据：只有 original.<ext>，没有分页表记录

  const pages: PaperPageView[] = [];
  for (const pageIndex of pageIndexes) {
    const resolved = resolvePaperPageFile(cardId, pageIndex);
    if (!resolved) continue;
    pages.push({
      pageIndex,
      filename: resolved.filename,
      mimeType: resolved.mimeType,
      isImage: resolved.isImage,
    });
  }
  return pages;
}

export type ExamAnswerKeyRow = {
  questionNumber: number;
  answerText: string;
  pageIndex: number | null;
};

/** 逐题「文字」正确答案（按题号升序） */
export async function listExamAnswerKeys(
  examId: number,
  db: DbAdapter = getMysqlDb()
): Promise<ExamAnswerKeyRow[]> {
  const rows = await db.all(
    `SELECT question_number, answer_text, page_index
       FROM exam_answer_keys
      WHERE exam_id = ?
      ORDER BY question_number`,
    examId
  ) as Array<{ question_number: number; answer_text: string; page_index: number | null }>;
  return rows.map((row) => ({
    questionNumber: Number(row.question_number),
    answerText: String(row.answer_text ?? ""),
    pageIndex: row.page_index == null ? null : Number(row.page_index),
  }));
}

/**
 * 按页归集答案文字：客户端在每张原卷图片下方渲染本页题号的答案。
 * page_index 为空（教师未指定）时统一落到最后一页，无原卷页则落到第 1 页，
 * 保证「有答案就一定渲染得出来」，不静默丢数据。
 */
export function groupAnswersByPage(
  answers: ExamAnswerKeyRow[],
  pageCount: number
): Map<number, ExamAnswerKeyRow[]> {
  const fallbackPage = Math.max(pageCount, 1);
  const grouped = new Map<number, ExamAnswerKeyRow[]>();
  for (const answer of answers) {
    const page = answer.pageIndex && answer.pageIndex >= 1 && answer.pageIndex <= fallbackPage
      ? answer.pageIndex
      : fallbackPage;
    const bucket = grouped.get(page);
    if (bucket) bucket.push(answer);
    else grouped.set(page, [answer]);
  }
  return grouped;
}

export type AnswerKeyPageRow = {
  pageIndex: number;
  filename: string;
  mimeType: string;
  isImage: boolean;
};

export function answerKeyBaseName(pageIndex: number): string {
  return pageIndex === 1 ? "answerkey" : `answerkey-${pageIndex}`;
}

/** 解析教师上传的「本次正确答案」某一页的实际文件 */
export function resolveAnswerKeyPageFile(
  examId: number | string,
  pageIndex: number
): { filePath: string; filename: string; mimeType: string; isImage: boolean } | null {
  if (!Number.isInteger(pageIndex) || pageIndex < 1) return null;
  const baseName = answerKeyBaseName(Number(pageIndex));
  const dir = answerKeyDir(examId);
  for (const ext of ANSWER_KEY_EXTENSIONS) {
    const filename = `${baseName}${ext}`;
    const filePath = path.join(dir, filename);
    if (!existsSync(filePath)) continue;
    return { filePath, filename, mimeType: getFileMime(filename), isImage: isImageFile(filename) };
  }
  return null;
}

/** 答案页列表（按 DB 记录顺序，仅保留磁盘上存在的页） */
export async function listAnswerKeyPages(
  examId: number,
  db: DbAdapter = getMysqlDb()
): Promise<AnswerKeyPageRow[]> {
  const rows = await db.all(
    "SELECT page_index FROM exam_answer_key_pages WHERE exam_id = ? ORDER BY page_index",
    examId
  ) as Array<{ page_index: number }>;
  const pages: AnswerKeyPageRow[] = [];
  for (const row of rows) {
    const pageIndex = Number(row.page_index);
    const resolved = resolveAnswerKeyPageFile(examId, pageIndex);
    if (!resolved) continue;
    pages.push({
      pageIndex,
      filename: resolved.filename,
      mimeType: resolved.mimeType,
      isImage: resolved.isImage,
    });
  }
  return pages;
}
