/**
 * Shared utility functions extracted from index.ts.
 *
 * Pure helpers (no closures over createApp scope) so they can be imported
 * by both the main index.ts and domain-route modules.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { DbAdapter } from "../../../server/db/mysql";
import { assetsDir, cardAssetsDir, dataDir, layoutPath, safeId } from "./storage";

export function paramValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? "";
}

export function fieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    return String(value[0] ?? "");
  }
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function boolField(value: unknown): boolean {
  const normalized = fieldValue(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export const EXAM_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MIN_EXAM_YEAR = 1900;
export const MAX_EXAM_YEAR = 2100;

export function isValidExamDate(value: string | undefined): boolean {
  if (!value) return false;
  const match = EXAM_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_EXAM_YEAR || year > MAX_EXAM_YEAR || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function requestFlag(value: unknown): boolean {
  return value === true || boolField(value);
}

export function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const result: number[] = [];
  for (const item of value) {
    const id = Number(item);
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export function optionalPositiveNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : undefined;
}

/**
 * 评审 P07：校验填涂学号位数是否与答题卡配置（student_number_digits）一致。
 * 返回错误消息；一致返回 null。纯函数，便于单测与两处写入链路复用。
 */
export function validateStudentIdDigits(studentId: string, expectedDigits: number): string | null {
  if (expectedDigits <= 0) return null;
  const len = String(studentId).length;
  if (len !== expectedDigits) {
    return `填涂学号 ${studentId} 位数(${len})与答题卡配置位数(${expectedDigits})不符，请检查填涂或卡配置`;
  }
  return null;
}

/**
 * 评审 P03：修复 multipart 上传中文文件名的 latin1 mojibake。
 *
 * busboy 默认按 latin1 解码 multipart 文件名，中文 UTF-8 字节被逐字节映射到
 * U+00C0–U+00FF（如「微信图片.jpg」→「å¾®ä¿¡å¾ç‰‡.jpg」）。本函数：
 * - 仅当文件名含 latin1 扩展字符（U+0080–U+00FF）且不含 CJK 时尝试重解码；
 * - 重解码后必须出现 CJK 且无 U+FFFD 替换符才采用，否则保留原名（避免误伤
 *   真实的欧洲语言文件名）。
 */
export function fixMultipartName(name: string): string {
  if (!name || typeof name !== "string") return name;
  if (name.length === 0 || /[\u4e00-\u9fff]/.test(name)) return name;
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  try {
    const fixed = Buffer.from(name, "latin1").toString("utf8");
    if (/[\u4e00-\u9fff]/.test(fixed) && !fixed.includes("\uFFFD")) {
      return fixed;
    }
  } catch {
    // 解码失败保持原名
  }
  return name;
}

export function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(fieldValue(value) || String(fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function deleteExamRows(db: DbAdapter, examIds: number[]): Promise<void> {
  for (const examId of examIds) {
    await db.run("DELETE FROM question_scores WHERE exam_id = ?", examId);
    await db.run("DELETE FROM student_scores WHERE exam_id = ?", examId);
    await db.run("DELETE FROM scan_batches WHERE exam_id = ?", examId);
    await db.run("DELETE FROM exams WHERE id = ?", examId);
  }
}

export async function deleteCardFiles(cardId: string): Promise<void> {
  const cardJsonPath = path.join(dataDir, "cards", `${cardId}.json`);
  const layoutJsonPath = layoutPath(cardId);
  const assetsPath = cardAssetsDir(cardId);
  try { if (existsSync(cardJsonPath)) await rm(cardJsonPath); } catch {}
  try { if (existsSync(layoutJsonPath)) await rm(layoutJsonPath); } catch {}
  try { if (existsSync(assetsPath)) await rm(assetsPath, { recursive: true, force: true }); } catch {}
}
