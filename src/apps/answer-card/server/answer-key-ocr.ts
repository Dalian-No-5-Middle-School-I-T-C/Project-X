/**
 * 「本次正确答案」OCR 文本解析（仅生成草稿，教师可逐题修正后保存）
 *
 * 只负责把 OCR 出来的纯文本切成「题号 → 答案文字」，不做任何对错判断、
 * 不猜题型、也不校验题号是否连续。解析不出来时返回空数组，
 * 教师仍可手动录入。
 */

/** 单个题号允许的最长答案文字（超长截断，防止把整段解析文本塞进一格） */
export const MAX_ANSWER_TEXT_LENGTH = 500;
/** 题号上限，避免把分数/页码等裸数字误判成题目 */
export const MAX_QUESTION_NUMBER = 200;

export type AnswerKeyDraft = {
  questionNumber: number;
  answerText: string;
  /** range=「1-5 BACDB」式选项串；single=「12. 答案」式逐题行 */
  matchedBy: "range" | "single";
};

const FULLWIDTH_DIGITS = /[\uFF10-\uFF19]/g;
const QUESTION_NUMBER_SEPARATORS = "[.、．:：)）]";

function normalizeDigits(value: string): string {
  return value.replace(FULLWIDTH_DIGITS, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48));
}

/** 清洗 OCR 噪声：去掉竖线/波浪线装饰与多余空白 */
function cleanAnswerText(value: string): string {
  return normalizeDigits(value)
    .replace(/[|｜~∼]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 「1-5 BACDB」「6~10：CCBDA」「11—13 ABD」：题号区间 + 等长选项串 */
const RANGE_PATTERN = new RegExp(
  `(\\d{1,3})\\s*[-—–~至]\\s*(\\d{1,3})\\s*[:：]?\\s*([A-Ka-k]{2,})`,
  "g"
);

/** 「12. 光合作用的场所是叶绿体」：行内「题号 + 分隔符」开头的题 */
const QUESTION_HEAD_PATTERN = new RegExp(`(\\d{1,3})\\s*${QUESTION_NUMBER_SEPARATORS}\\s*`, "g");

/**
 * 把一行拆成「题号 → 该题答案文字」若干段，支持一行多题（「1．A 2．B 3．C」）。
 * 题号必须位于行首或紧跟非数字字符 —— 否则「21. 甲」会被再从「1.」处切开，
 * 把第 21 题错解析成第 1 题。
 */
function splitLabeledQuestions(line: string): Array<{ questionNumber: number; answerText: string }> {
  const heads: Array<{ number: number; start: number; end: number }> = [];
  QUESTION_HEAD_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUESTION_HEAD_PATTERN.exec(line)) !== null) {
    const start = match.index;
    const before = start === 0 ? "" : line[start - 1];
    if (before && /\d/.test(before)) continue;
    heads.push({ number: Number(match[1]), start, end: start + match[0].length });
  }
  return heads.map((head, i) => ({
    questionNumber: head.number,
    answerText: line.slice(head.end, i + 1 < heads.length ? heads[i + 1].start : line.length),
  }));
}

function pushDraft(
  drafts: Map<number, AnswerKeyDraft>,
  questionNumber: number,
  answerText: string,
  matchedBy: AnswerKeyDraft["matchedBy"]
): void {
  if (!Number.isInteger(questionNumber) || questionNumber <= 0 || questionNumber > MAX_QUESTION_NUMBER) return;
  const text = cleanAnswerText(answerText);
  if (!text) return;
  // 先命中的规则优先：OCR 同一题往往只在一种格式里出现
  if (drafts.has(questionNumber)) return;
  drafts.set(questionNumber, {
    questionNumber,
    answerText: text.slice(0, MAX_ANSWER_TEXT_LENGTH),
    matchedBy,
  });
}

export function parseAnswerKeyText(text: string): AnswerKeyDraft[] {
  const drafts = new Map<number, AnswerKeyDraft>();
  if (!text) return [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeDigits(rawLine).trim();
    if (!line) continue;

    // 区间式优先整行扫描：一行可含多组「1-5 BACDB 6-10 CCBDA」
    RANGE_PATTERN.lastIndex = 0;
    let range: RegExpExecArray | null;
    while ((range = RANGE_PATTERN.exec(line)) !== null) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const options = range[3].toUpperCase();
      if (!(end >= start) || end - start + 1 !== options.length) continue;
      for (let i = 0; i < options.length; i += 1) {
        pushDraft(drafts, start + i, options[i], "range");
      }
    }

    // 区间已占用的题号由 pushDraft 的「先命中优先」自动跳过
    for (const item of splitLabeledQuestions(line)) {
      pushDraft(drafts, item.questionNumber, item.answerText, "single");
    }
  }

  return [...drafts.values()].sort((a, b) => a.questionNumber - b.questionNumber);
}
