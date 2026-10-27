/**
 * v64: 考试级「本次正确答案」展示模式（exams.answer_key_mode）。
 *
 * 为什么需要它：v54 只有一条下发通道 —— 教师上传的答案文件留在服务端供 OCR 与
 * 人工核对，学生端只会渲染 exam_answer_keys 里的文字。教师手里是扫描版/PDF 版标准答案
 * 且排版复杂（图表、公式、分栏）时，OCR 识别不出来就等于学生看不到答案。
 *
 * 口径（二选一，不是叠加）：
 *  - 'text'：沿用 v54 —— 学生看逐题文字答案，上传的答案原文件不下发。默认值，历史数据不变。
 *  - 'file'：学生直接看教师上传的答案原文件（图片 / PDF / DOCX），逐题文字答案不再下发。
 * 两种模式的数据都保留在库里，切回去就能看到原来的内容，切换本身不销毁数据。
 */
export const ANSWER_KEY_MODE_TEXT = "text";
export const ANSWER_KEY_MODE_FILE = "file";

export type AnswerKeyMode = typeof ANSWER_KEY_MODE_TEXT | typeof ANSWER_KEY_MODE_FILE;

export const ANSWER_KEY_MODES: readonly AnswerKeyMode[] = [ANSWER_KEY_MODE_TEXT, ANSWER_KEY_MODE_FILE];

export function isAnswerKeyMode(value: unknown): value is AnswerKeyMode {
  return value === ANSWER_KEY_MODE_TEXT || value === ANSWER_KEY_MODE_FILE;
}

/** 读取DB/请求里的任意值：非 'file' 一律按 'text' 处理（缺列的旧库、脏值都退回安全的一侧） */
export function normalizeAnswerKeyMode(value: unknown): AnswerKeyMode {
  return value === ANSWER_KEY_MODE_FILE ? ANSWER_KEY_MODE_FILE : ANSWER_KEY_MODE_TEXT;
}
