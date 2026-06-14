import type { AnswerCard } from "./types";

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

export function createDefaultCard(id: string, subject?: string): AnswerCard {
  const now = new Date().toISOString();

  return {
    id,
    title: "",
    subject: subject ?? undefined,
    paper: { size: "A4", orientation: "portrait" },
    studentInfo: {
      fields: ["姓名", "班级"],
      studentNumberDigits: 5
    },
    bodyBlocks: [],
    sided: "single",
    layoutVersion: 1,
    updatedAt: now
  };
}
