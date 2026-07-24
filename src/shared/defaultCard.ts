import type { AnswerCard, StudentInfoSettings } from "./types";

export const DEFAULT_STUDENT_NOTES = [
  "1. 答题前请将姓名、班级、准考证号等填写清楚。",
  "2. 客观题必须使用2B铅笔填涂，修改时用橡皮擦干净。",
  "3. 请在题号对应的答题区域作答，区域外书写无效。"
].join("\n");

export const DEFAULT_STUDENT_INFO: StudentInfoSettings = {
  studentNumberDigits: 5,
  showName: true,
  showClass: true,
  showSeat: false,
  showExamNumber: false,
  showStudentNumber: true,
  showNotes: false,
  notesText: DEFAULT_STUDENT_NOTES
};

export function createBlockId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 生成确定性 8 位纯数字答题卡 ID
 * 基于科目 + 时间戳 hash，同一科目同一毫秒生成同一 ID
 * 范围 10000000 ~ 99999999
 */
export function generateCardId(subject: string): string {
  const seed = `${subject}_${Date.now()}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const num = (Math.abs(hash) % 90_000_000) + 10_000_000;
  return String(num);
}

export function createDefaultCard(id: string, subject?: string, paperSize: "A4" | "A3" = "A4"): AnswerCard {
  const now = new Date().toISOString();

  return {
    id,
    title: "",
    subject: subject ?? undefined,
    paper: { size: paperSize, orientation: paperSize === "A3" ? "landscape" : "portrait" },
    studentInfo: {
      ...DEFAULT_STUDENT_INFO,
      // A3 默认需要注意事项（参考模板）；A4 默认不带
      showNotes: paperSize === "A3"
    },
    bodyBlocks: [],
    sided: "single",
    layoutVersion: 2,
    updatedAt: now
  };
}
