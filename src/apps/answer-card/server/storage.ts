import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomInt } from "node:crypto";
import type { AnswerCard, CardSummary, LayoutDocument } from "../../../shared/types";
import { createDefaultCard } from "../../../shared/defaultCard";
import { normalizeObjectiveAnswerKey } from "../../../shared/grading";
import { buildLayout } from "../../../shared/layout";

export const rootDir = process.cwd();
export const dataDir = process.env.ANSWER_CARD_DATA_DIR
  ? path.resolve(process.env.ANSWER_CARD_DATA_DIR)
  : path.join(rootDir, "data", "answer-card");
export const cardsDir = path.join(dataDir, "cards");
export const assetsDir = path.join(dataDir, "assets");
export const layoutsDir = path.join(dataDir, "layouts");
export const blockCropsDir = path.join(dataDir, "recognition", "crops");
export const papersDir = path.join(dataDir, "papers");

export async function ensureDataDirs(): Promise<void> {
  await mkdir(cardsDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(layoutsDir, { recursive: true });
  await mkdir(blockCropsDir, { recursive: true });
  await mkdir(papersDir, { recursive: true });
}

export function cardPath(cardId: string): string {
  return path.join(cardsDir, `${safeId(cardId)}.json`);
}

export function layoutPath(cardId: string): string {
  return path.join(layoutsDir, `${safeId(cardId)}.json`);
}

export function cardAssetsDir(cardId: string): string {
  return path.join(assetsDir, safeId(cardId));
}

export function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function paperDir(cardId: string): string {
  return path.join(papersDir, safeId(cardId));
}

export async function ensurePaperDir(cardId: string): Promise<void> {
  await mkdir(paperDir(cardId), { recursive: true });
}

export async function createCard(): Promise<AnswerCard> {
  await ensureDataDirs();
  let id = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    id = String(randomInt(0, 100000000)).padStart(8, "0");
    if (!existsSync(cardPath(id))) break;
  }

  const card = createDefaultCard(id);
  await saveCard(card);
  return card;
}

export async function listCards(): Promise<CardSummary[]> {
  await ensureDataDirs();
  const files = await readdir(cardsDir);
  const summaries = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const fullPath = path.join(cardsDir, file);
        const raw = await readFile(fullPath, "utf8");
        const card = JSON.parse(raw) as AnswerCard;
        const info = await stat(fullPath);
        return {
          id: card.id,
          title: card.title || "未命名答题卡",
          updatedAt: card.updatedAt || info.mtime.toISOString()
        };
      })
  );

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readCard(cardId: string): Promise<AnswerCard | null> {
  await ensureDataDirs();
  const fullPath = cardPath(cardId);
  if (!existsSync(fullPath)) return null;
  const raw = await readFile(fullPath, "utf8");
  return JSON.parse(raw) as AnswerCard;
}

export async function saveCard(card: AnswerCard): Promise<AnswerCard> {
  await ensureDataDirs();
  const normalized: AnswerCard = {
    ...card,
    id: safeId(card.id),
    bodyBlocks: card.bodyBlocks.map((block) =>
      block.type === "objective" ? { ...block, answerKey: normalizeObjectiveAnswerKey(block) } : block
    ),
    paper: { size: "A4", orientation: "portrait" },
    layoutVersion: 1,
    updatedAt: new Date().toISOString()
  };
  await writeFile(cardPath(normalized.id), JSON.stringify(normalized, null, 2), "utf8");
  await saveLayout(normalized);
  return normalized;
}

export async function saveLayout(card: AnswerCard): Promise<LayoutDocument> {
  const layout = buildLayout(card);
  await writeFile(layoutPath(card.id), JSON.stringify(layout, null, 2), "utf8");
  return layout;
}

export async function readLayout(cardId: string): Promise<LayoutDocument | null> {
  await ensureDataDirs();
  const card = await readCard(cardId);
  if (!card) return null;
  return saveLayout(card);
}

export function assetReadStream(cardId: string, assetId: string) {
  return createReadStream(path.join(cardAssetsDir(cardId), path.basename(assetId)));
}
