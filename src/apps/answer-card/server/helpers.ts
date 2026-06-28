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
