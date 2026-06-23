import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CardRepository } from "../../../server/repositories/CardRepository";
import { buildLayout } from "../../../shared/layout";
import type { AnswerCard, LayoutDocument } from "../../../shared/types";
import { layoutPath } from "./storage";

export type PreparedCardLayout = {
  card: AnswerCard;
  layout: LayoutDocument;
  layoutPath: string;
};

export function findCardForLayout(cardId: string, cardRepo = new CardRepository()): AnswerCard | null {
  return cardRepo.findById(cardId);
}

export async function prepareCardLayout(
  card: AnswerCard,
  _cardRepo?: CardRepository
): Promise<PreparedCardLayout> {
  const layout = buildLayout(card);

  const targetPath = layoutPath(card.id);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(layout, null, 2), "utf8");

  return { card, layout, layoutPath: targetPath };
}

export async function prepareCardLayoutById(
  cardId: string,
  cardRepo = new CardRepository()
): Promise<PreparedCardLayout | null> {
  const card = findCardForLayout(cardId, cardRepo);
  if (!card) return null;
  return prepareCardLayout(card, cardRepo);
}
