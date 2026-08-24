// cardModel.ts —— 答题卡设计相关的纯函数与标签映射。
// 从 App.tsx 抽出，解编辑器与 App handler 的共享依赖环；App / DesignEditors / DesignPage 均从此处导入。
import type {
  AnswerCard,
  BlankItem,
  BodyBlock,
  ObjectiveBlock,
  ObjectiveMode,
  ObjectiveOptionLayout,
  SubjectiveBlock,
  SubjectiveBlockKind,
  SubjectiveKind,
  SubjectiveQuestion,
  SubjectiveStyle,
  BlankLabelStyle
} from "../../../shared/types";
import { createBlockId } from "../../../shared/defaultCard";
import { formatBlankLabel } from "../../../shared/blankLabels";
import { ESSAY_DEFAULT_LINE_COLOR } from "../../../shared/essayGrid";

const modeLabels: Record<ObjectiveMode, string> = {
  single: "单选",
  multiple: "多选",
  indefinite: "不定项"
};

const optionLayoutLabels: Record<ObjectiveOptionLayout, string> = {
  horizontal: "横向",
  vertical: "竖向（4题一组）",
  "vertical-options": "选项竖排（A/B/C/D 纵向）"
};

const styleLabels: Record<SubjectiveStyle, string> = {
  manual_score_grid: "带分数填涂区",
  plain_subjective: "纯主观题书写块"
};

const kindLabels: Record<SubjectiveKind, string> = {
  blank: "填空",
  lined_answer: "横线格",
  plain_box: "空白大框"
};

const blankLabelStyleLabels: Record<BlankLabelStyle, string> = {
  none: "不带序号",
  arabic_parentheses: "(1)(2)",
  roman_parentheses: "(i)(ii)"
};

function subjectiveBlockKind(block: SubjectiveBlock): SubjectiveBlockKind {
  if (block.blockKind) return block.blockKind;
  if (block.title.includes("解答")) return "answer";
  if (block.title.includes("作文")) return "essay";
  if (block.questions.length > 0 && block.questions.every((question) => question.kind === "blank")) return "fill_blank";
  return "answer";
}

function subjectiveBlockKindLabel(block: SubjectiveBlock): string {
  const kind = subjectiveBlockKind(block);
  if (kind === "fill_blank") return "填空题";
  if (kind === "essay") return "作文题";
  return "解答题";
}

function answerBlankItems(question: SubjectiveQuestion): BlankItem[] {
  const fallbackWidth = question.blanks?.widthMm ?? 32;
  const fallbackHeight = question.blanks?.heightMm ?? 6;
  if (question.blanks?.items?.length) {
    return question.blanks.items.map((item) => ({
      label: item.label ?? "",
      widthMm: item.widthMm || fallbackWidth,
      heightMm: item.heightMm || fallbackHeight,
      rightAnnotation: item.rightAnnotation
    }));
  }
  const count = Math.max(1, question.blanks?.count ?? 4);
  return Array.from({ length: count }, (_, index) => ({
    label: formatBlankLabel(question.blanks?.labelStyle ?? "arabic_parentheses", index),
    widthMm: fallbackWidth,
    heightMm: fallbackHeight
  }));
}

function cloneCard(card: AnswerCard): AnswerCard {
  return JSON.parse(JSON.stringify(card)) as AnswerCard;
}

function answerText(options: string[]): string {
  return options.length > 0 ? options.join("") : "-";
}

function defaultObjective(start: number): ObjectiveBlock {
  return {
    id: createBlockId("obj"),
    type: "objective",
    title: "客观题",
    questionStart: start,
    questionCount: 10,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 5,
    density: "compact",
    optionLayout: "horizontal",
    answerKey: {},
    multipleScoring: {
      partialScores: { 1: 2, 2: 4 },
      wrongOrExtraScore: 0
    }
  };
}

function defaultSubjective(nextNumber: number): SubjectiveBlock {
  return {
    id: createBlockId("subj"),
    type: "subjective",
    blockKind: "answer",
    title: "解答题",
    questions: [
      {
        id: createBlockId("q"),
        number: nextNumber,
        score: 12,
        style: "manual_score_grid",
        kind: "lined_answer",
        lineGrid: { enabled: true, lineSpacingMm: 7, fixedLineCount: 5, lineColor: "#222", lineWidthMm: 0.15, insetLeftMm: 4, insetRightMm: 4 },
        scoreGrid: { enabled: true, strokeColor: "#999", strokeWidthMm: 0.15, fillColor: "#fff", fontSize: 2.8, dividerColor: "#ccc", dividerWidthMm: 0.1, showLabel: true },
        images: [],
        minHeightMm: 49   // 14 + 5×7
      }
    ]
  };
}

function defaultBlankBlock(nextNumber: number): SubjectiveBlock {
  return {
    id: createBlockId("subj"),
    type: "subjective",
    blockKind: "fill_blank",
    title: "填空题",
    questions: Array.from({ length: 10 }, (_, index) =>
      defaultBlankQuestion(nextNumber + index, index === 0 ? 15 : 0, index === 0 ? "manual_score_grid" : "plain_subjective")
    )
  };
}

function defaultEssayBlock(nextNumber: number): SubjectiveBlock {
  return {
    id: createBlockId("subj"),
    type: "subjective",
    blockKind: "essay",
    title: "作文",
    questions: [{
      id: createBlockId("q"),
      number: nextNumber,
      score: 60,
      style: "manual_score_grid",
      kind: "plain_box",
      lineGrid: { enabled: false, lineSpacingMm: 7, lineColor: "#222", lineWidthMm: 0.15, insetLeftMm: 4, insetRightMm: 4 },
      images: [],
      minHeightMm: 280,
      essayGrid: {
        columns: 0,
        rows: 0,
        cellWidthMm: 7,
        cellHeightMm: 7,
        targetChars: 600,
        showTitle: true,
        lineColor: ESSAY_DEFAULT_LINE_COLOR,
        lineWidthMm: 0.15,
        showFrame: true,
        showWordScale: true,
      },
    }],
  };
}

function defaultAnswerBlankQuestion(nextNumber: number): SubjectiveQuestion {
  return {
    ...defaultBlankQuestion(nextNumber, 12, "manual_score_grid"),
    minHeightMm: 62,
    blanks: {
      count: 4,
      widthMm: 32,
      heightMm: 6,
      labelStyle: "arabic_parentheses",
      items: Array.from({ length: 4 }, (_, index) => ({
        label: `(${index + 1})`,
        widthMm: 32,
        heightMm: 6
      }))
    }
  };
}

function answerLineCount(question: SubjectiveQuestion): number {
  const spacing = Math.max(5, question.lineGrid?.lineSpacingMm ?? 8);
  return Math.max(1, Math.min(20, Math.ceil((question.minHeightMm - 14) / spacing)));
}

function heightForAnswerLines(lineCount: number, spacing: number): number {
  return 14 + Math.max(1, Math.min(20, lineCount)) * Math.max(5, spacing);
}

function numericQuestionValue(value: string | number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findNextQuestionNumber(card: AnswerCard): number {
  let max = 0;
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") max = Math.max(max, block.questionStart + block.questionCount - 1);
    if (block.type === "subjective") {
      for (const question of block.questions) max = Math.max(max, numericQuestionValue(question.number));
    }
  }
  return max + 1;
}

export {
  modeLabels,
  optionLayoutLabels,
  styleLabels,
  kindLabels,
  blankLabelStyleLabels,
  subjectiveBlockKind,
  subjectiveBlockKindLabel,
  answerBlankItems,
  cloneCard,
  answerText,
  defaultObjective,
  defaultSubjective,
  defaultBlankBlock,
  defaultEssayBlock,
  defaultAnswerBlankQuestion,
  answerLineCount,
  heightForAnswerLines,
  numericQuestionValue,
  findNextQuestionNumber,
  defaultBlankQuestion
};

function defaultBlankQuestion(
  questionNumber: string | number,
  score = 0,
  style: SubjectiveStyle = "plain_subjective"
): SubjectiveQuestion {
  return {
    id: createBlockId("q"),
    number: questionNumber,
    score,
    style,
    kind: "blank",
    blanks: { count: 1, widthMm: 22, heightMm: 6, labelStyle: "none" },
    lineGrid: { enabled: false, lineSpacingMm: 7, lineColor: "#222", lineWidthMm: 0.15, insetLeftMm: 4, insetRightMm: 4 },
    images: [],
    minHeightMm: 14
  };
}

// 预览缩放模式与持久化设置（B1 从 App.tsx 迁入，供 DesignEditors 的 CardPreview 使用）
export type PreviewMode = "fit-width" | "fit-page" | "fit-panel" | "custom";

export const PREVIEW_SETTINGS_KEY = "projectx-card-preview-settings-v1";
export const PREVIEW_MIN_PERCENT = 50;
export const PREVIEW_MAX_PERCENT = 400;
