import type { AnswerCard } from "./types";

export function createBlockId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultCard(id: string): AnswerCard {
  const now = new Date().toISOString();

  return {
    id,
    title: "",
    paper: { size: "A4", orientation: "portrait" },
    studentInfo: {
      fields: ["姓名", "班级"],
      studentNumberDigits: 5
    },
    bodyBlocks: [],
    layoutVersion: 1,
    updatedAt: now
  };
}
