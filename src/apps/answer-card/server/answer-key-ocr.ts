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

const FULLWIDTH_DIGITS = /[０-９]/g;
const OPTION = /^[A-K]+$/i;
const SECTION_HEADING_PREFIX = /^(?:[一二三四五六七八九十]+[、.．]\s*)?(?:参考答案|答案解析|[单双多]?选题|选择题|填空题|解答题|主观题|判断题|计算题)(?:\s*[：:]\s*|$)/;
const STANDALONE_SECTION_HEADING = /^[一二三四五六七八九十]+[、.．]\s*$/;
const RANGE_HEAD = /(?:^|[\s,，;；])([0-9]{1,3})\s*[-—–~～至]\s*([0-9]{1,3})\s*[:：]?\s*/g;
const NUMBERED_HEAD = /^(?:第\s*(\d+)\s*题\s*[:：、.．]?|(\d+)\s*(?:[.．:：](?!\d)|[、)）]))\s*/;
const INLINE_NUMBERED_HEAD = /\s+(?:第\s*(\d+)\s*题\s*[:：、.．]?\s*|(\d+)(?:\.(?!\d)\s+|[．、](?!\d)\s*))/g;

function normalizeDigits(value: string): string {
  return value.replace(FULLWIDTH_DIGITS, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48));
}

function validQuestionNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_QUESTION_NUMBER;
}

function choiceTokens(value: string): string[] {
  return value.trim().toUpperCase().split(/[\s、,，;；|｜]+/).filter(Boolean);
}

function matchChoices(value: string, count: number): string[] | null {
  const tokens = choiceTokens(value);
  if (!tokens.every(token => OPTION.test(token))) return null;
  if (tokens.length === count) return tokens;
  if (tokens.length === 1 && tokens[0].length === count) return [...tokens[0]];
  return null;
}

function matchRanges(line: string): AnswerKeyDraft[] | null {
  const heads = [...line.matchAll(RANGE_HEAD)];
  if (heads[0]?.index !== 0) return null;

  return heads.flatMap((head, index) => {
    const start = Number(head[1]);
    const end = Number(head[2]);
    if (!validQuestionNumber(start) || !validQuestionNumber(end) || end < start) return [];
    const value = line.slice(head.index + head[0].length, heads[index + 1]?.index);
    const options = matchChoices(value, end - start + 1);
    return options?.map((answerText, offset) => ({
      questionNumber: start + offset, answerText, matchedBy: "range" as const,
    })) ?? [];
  });
}

function matchChoiceTable(numbers: string, answers: string): AnswerKeyDraft[] | null {
  const headings = choiceTokens(numbers.replace(/^题\s*号\s*[:：]?/, ""));
  if (headings.length < 2 || !headings.every(n => /^\d+$/.test(n))) return null;
  const start = Number(headings[0]);
  if (!validQuestionNumber(start) || !validQuestionNumber(start + headings.length - 1)) return null;
  if (!headings.every((n, offset) => Number(n) === start + offset)) return null;
  const options = matchChoices(answers.replace(/^答\s*案\s*[:：]?/, ""), headings.length);
  return options?.map((answerText, offset) => ({
    questionNumber: start + offset, answerText, matchedBy: "range",
  })) ?? null;
}

// Require an entire row of options before treating bare numbers or inline punctuation as question labels.
function matchChoiceRow(line: string): AnswerKeyDraft[] | null {
  if (!/^(?:\d+(?:\s*[.．、:：)）]\s*|\s+)[A-K]+)(?:[\s、,，;；]+\d+(?:\s*[.．、:：)）]\s*|\s+)[A-K]+)*$/i.test(line)) {
    return null;
  }
  return [...line.matchAll(/(\d+)(?:\s*[.．、:：)）]\s*|\s+)([A-K]+)/gi)].map(match => ({
    questionNumber: Number(match[1]), answerText: match[2].toUpperCase(), matchedBy: "single",
  }));
}

function splitInlineNumberedLine(firstNumber: number, rest: string): Array<{ questionNumber: number; answerText: string }> {
  const inlineHeads = [...rest.matchAll(INLINE_NUMBERED_HEAD)];
  if (inlineHeads.length === 0) return [{ questionNumber: firstNumber, answerText: rest }];
  const items: Array<{ questionNumber: number; answerText: string }> = [
    { questionNumber: firstNumber, answerText: rest.slice(0, inlineHeads[0].index) },
  ];
  for (let i = 0; i < inlineHeads.length; i++) {
    const match = inlineHeads[i];
    const start = match.index + match[0].length;
    const end = i + 1 < inlineHeads.length ? inlineHeads[i + 1].index : rest.length;
    items.push({ questionNumber: Number(match[1] ?? match[2]), answerText: rest.slice(start, end) });
  }
  return items;
}

export function parseAnswerKeyText(text: string): AnswerKeyDraft[] {
  const drafts = new Map<number, AnswerKeyDraft>();
  let current: { questionNumber: number; lines: string[] } | undefined;

  function save(draft: AnswerKeyDraft): void {
    if (!validQuestionNumber(draft.questionNumber) || drafts.has(draft.questionNumber)) return;
    const answerText = draft.answerText.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_TEXT_LENGTH);
    if (answerText) drafts.set(draft.questionNumber, { ...draft, answerText });
  }

  function finishQuestion(): void {
    if (!current) return;
    save({ questionNumber: current.questionNumber, answerText: current.lines.join(" "), matchedBy: "single" });
    current = undefined;
  }

  const lines = text.split(/\r?\n/).map(line => normalizeDigits(line).trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const headingMatch = SECTION_HEADING_PREFIX.exec(line);
    if (headingMatch) {
      finishQuestion();
      line = line.slice(headingMatch[0].length).trim();
      if (!line) continue;
    } else if (STANDALONE_SECTION_HEADING.test(line) || /^[一二三四五六七八九十]+[、.．]\s*\S+$/.test(line)) {
      finishQuestion();
      continue;
    }

    const table = matchChoiceTable(line, lines[i + 1] ?? "");
    if (table) {
      finishQuestion();
      table.forEach(save);
      i++;
      continue;
    }

    const ranges = matchRanges(line);
    const choices = matchChoiceRow(line);
    if (ranges?.length || (choices && choices.length > 1)) {
      finishQuestion();
      (ranges?.length ? ranges : choices)?.forEach(save);
      continue;
    }

    const head = NUMBERED_HEAD.exec(line);
    const choice = choices?.[0];
    if (head) {
      finishQuestion();
      const segments = splitInlineNumberedLine(Number(head[1] ?? head[2]), line.slice(head[0].length));
      for (let s = 0; s < segments.length - 1; s++) {
        save({ questionNumber: segments[s].questionNumber, answerText: segments[s].answerText, matchedBy: "single" });
      }
      const last = segments[segments.length - 1];
      current = { questionNumber: last.questionNumber, lines: [last.answerText] };
    } else if (choice) {
      finishQuestion();
      current = { questionNumber: choice.questionNumber, lines: [choice.answerText] };
    } else {
      current?.lines.push(line);
    }
  }
  finishQuestion();
  return [...drafts.values()].sort((a, b) => a.questionNumber - b.questionNumber);
}
