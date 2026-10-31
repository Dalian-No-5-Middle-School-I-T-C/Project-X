/**
 * v54: 考试级「原卷 + 逐题正确答案」读取服务
 * v66: 追加答案原文件的直发读取（exams.answer_key_mode='file' 时学生看上传的文件本身）
 *
 * 教师端配置接口与学生端查看接口共用这里的文件/数据解析，避免两处各写一遍
 * 目录探测与扩展名兜底逻辑。四条硬约束：
 * 1. 原卷图片是「答题卡级」资产（original_paper_pages 以 card_id 为键），
 *    考试通过 exams.card_id 关联，因此读取需要先拿到考试绑定的答题卡。
 * 2. 只返回磁盘上真实存在的页：DB 有记录但文件被清理时按「未上传」处理，
 *    避免把 404 图片链接交给客户端。
 * 3. 答案文字按教师保存的原样输出，本服务不做任何对错判断或选项归一化。
 * 4. 答案原文件页（exam_answer_key_pages）默认只给教师核对；是否下发给学生由调用方
 *    按 exams.answer_key_mode 决定，本服务只提供解析能力，不含可见性判断。
 */
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { getMysqlDb, type DbAdapter } from "../db/mysql";
import { answerKeyDir, paperDir } from "../../apps/answer-card/server/storage";
import { getFileMime } from "../../apps/answer-card/server/paper-ocr";
import { answerKeyPreviewFilename } from "../../shared/answerKeyFiles";

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".bmp", ".webp"];
const SOURCE_IMAGE_EXTENSIONS = [...IMAGE_EXTENSIONS, ".tiff", ".tif"];
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

function isSourceImageFile(filename: string): boolean {
  return SOURCE_IMAGE_EXTENSIONS.includes(path.extname(filename).toLowerCase());
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
 * pageIndexes 传原卷「真实页码集合」而不是页数：删掉中间页后会留下稀疏页码（如 [1,3]），
 * 按页数当上界会把归属第 3 页的答案塞进不存在的第 2 页，学生端永远看不到。
 * page_index 为空（教师未指定）或不在集合内时统一落到最后一页，无原卷页则落到第 1 页，
 * 保证「有答案就一定渲染得出来」，不静默丢数据。
 */
export function groupAnswersByPage(
  answers: ExamAnswerKeyRow[],
  pageIndexes: number[]
): Map<number, ExamAnswerKeyRow[]> {
  const pages = new Set(pageIndexes);
  const fallbackPage = pageIndexes.length > 0 ? Math.max(...pageIndexes) : 1;
  const grouped = new Map<number, ExamAnswerKeyRow[]>();
  for (const answer of answers) {
    const page = answer.pageIndex && pages.has(answer.pageIndex)
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

/**
 * 取某页在 DB 登记的磁盘文件名。
 * 只有走过上传流程的页才会有行记录，因此「无行 = 该页不存在」：
 * 以此为准可以同时挡掉两类问题——按页码猜测文件（早期失败上传遗留的孤儿文件）
 * 被当作已上传页读取或预览（PR 审查 P2）。
 * 教师核对与学生直发下载共用本函数，避免两处各写一遍「只认 DB」的口径。
 */
export async function loadAnswerKeyPageFilename(
  examId: number,
  pageIndex: number,
  db: DbAdapter = getMysqlDb()
): Promise<string | null> {
  const row = await db.get<{ filename: string | null }>(
    "SELECT filename FROM exam_answer_key_pages WHERE exam_id = ? AND page_index = ?",
    examId, pageIndex
  );
  return row?.filename ?? null;
}

/**
 * 解析教师上传的「本次正确答案」某一页的实际文件。
 *
 * preferredFilename 为 DB 已登记的文件名（`exam_answer_key_pages.filename`），必须优先使用：
 * 同一 baseName 下可能存在历史残留（早期上传中途失败遗留的 `answerkey.jpg`），
 * 若只按 ANSWER_KEY_EXTENSIONS 顺序探测，`.jpg` 会遮蔽已登记的 `answerkey.pdf`，
 * 导致列表/预览/重识别三处一起读到旧图（PR 审查 P2）。
 * 仅当登记文件在磁盘上不存在时（外部清理/历史脏数据）才回退到扩展名探测。
 * 学生直发（`exact: true`）不回退：登记文件被删掉后，同名其他扩展名的失败上传残留
 * 不能当作这一页的答案下发。
 */
export function resolveAnswerKeyPageFile(
  examId: number | string,
  pageIndex: number,
  preferredFilename?: string | null,
  options?: { exact?: boolean }
): { filePath: string; filename: string; mimeType: string; isImage: boolean } | null {
  if (!Number.isInteger(pageIndex) || pageIndex < 1) return null;
  const dir = answerKeyDir(examId);

  if (preferredFilename) {
    const filename = path.basename(preferredFilename);
    const filePath = path.join(dir, filename);
    if (existsSync(filePath)) {
      return { filePath, filename, mimeType: getFileMime(filename), isImage: isImageFile(filename) };
    }
  }
  if (options?.exact) return null;

  const baseName = answerKeyBaseName(Number(pageIndex));
  for (const ext of ANSWER_KEY_EXTENSIONS) {
    const filename = `${baseName}${ext}`;
    const filePath = path.join(dir, filename);
    if (!existsSync(filePath)) continue;
    return { filePath, filename, mimeType: getFileMime(filename), isImage: isImageFile(filename) };
  }
  return null;
}

/**
 * 教师预览与 OCR 读的文件。
 * 新上传的图片旁边有 `<base>.preview.jpg`（压缩派生），原件留给学生直发。
 * 这次改动之前的图片入库时已经被压成 JPEG，没有原件、也没有 preview 文件，
 * 这时预览只能继续用登记的那一份。PDF / DOCX 没有派生图，直接用原文件。
 */
export function resolveAnswerKeyPreviewFile(
  examId: number | string,
  pageIndex: number,
  preferredFilename?: string | null,
): { filePath: string; filename: string; mimeType: string; isImage: boolean } | null {
  const original = resolveAnswerKeyPageFile(examId, pageIndex, preferredFilename);
  if (!original) return null;
  if (!isSourceImageFile(original.filename)) return original;
  const previewName = answerKeyPreviewFilename(answerKeyBaseName(pageIndex));
  const previewPath = path.join(answerKeyDir(examId), previewName);
  if (!existsSync(previewPath)) return original;
  return { filePath: previewPath, filename: previewName, mimeType: getFileMime(previewName), isImage: true };
}

/** 删除某一页答案在磁盘上的登记文件、扩展名残留和预览派生图。 */
export function discardAnswerKeyPageFiles(examId: number | string, pageIndex: number): void {
  const dir = answerKeyDir(examId);
  const baseName = answerKeyBaseName(pageIndex);
  for (const filename of [
    ...ANSWER_KEY_EXTENSIONS.map((ext) => `${baseName}${ext}`),
    answerKeyPreviewFilename(baseName),
  ]) {
    const filePath = path.join(dir, filename);
    if (!existsSync(filePath)) continue;
    try { unlinkSync(filePath); } catch {}
  }
}

/**
 * 清掉某页除 keepFilename 之外的同 baseName 残留。
 * 早期版本上传中途失败会留下「无 DB 记录但占着正式文件名」的孤儿文件，
 * 成功写页后调用本函数可把这类残留就地收干净，保证一页一文件。
 */
export function purgeAnswerKeyPageSiblings(
  examId: number | string,
  pageIndex: number,
  keepFilename: string
): void {
  const dir = answerKeyDir(examId);
  const baseName = answerKeyBaseName(Number(pageIndex));
  for (const ext of ANSWER_KEY_EXTENSIONS) {
    const filename = `${baseName}${ext}`;
    if (filename === keepFilename) continue;
    const filePath = path.join(dir, filename);
    if (existsSync(filePath)) {
      try { unlinkSync(filePath); } catch {}
    }
  }
  if (!isSourceImageFile(keepFilename)) {
    const previewPath = path.join(dir, answerKeyPreviewFilename(baseName));
    if (existsSync(previewPath)) {
      try { unlinkSync(previewPath); } catch {}
    }
  }
}

/** 答案页列表（按 DB 记录顺序，仅保留磁盘上存在的页） */
export async function listAnswerKeyPages(
  examId: number,
  db: DbAdapter = getMysqlDb(),
  options?: { exact?: boolean }
): Promise<AnswerKeyPageRow[]> {
  const rows = await db.all(
    "SELECT page_index, filename FROM exam_answer_key_pages WHERE exam_id = ? ORDER BY page_index",
    examId
  ) as Array<{ page_index: number; filename: string | null }>;
  const pages: AnswerKeyPageRow[] = [];
  for (const row of rows) {
    const pageIndex = Number(row.page_index);
    const resolved = resolveAnswerKeyPageFile(examId, pageIndex, row.filename, options);
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
