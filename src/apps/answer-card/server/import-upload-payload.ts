import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { dataDir, safeId } from "./storage";
import { isInsideDir } from "../../../server/services/AnswerBlockCropService";
import type { CombinedRecognitionResult } from "../../../shared/types";

/** Keep only metadata in the response; load each page's crops when its upload starts. */
export async function storeImportUploadPayload(cardId: string, cardVersion: string, imagePath: string,
  recognition: CombinedRecognitionResult): Promise<string> {
  await writeFile(`${imagePath}.upload.json`, JSON.stringify({ cardVersion, recognition }), "utf8");
  return `/api/cards/${encodeURIComponent(cardId)}/grading/upload-payload/${encodeURIComponent(path.basename(imagePath))}`;
}

export async function readImportUploadPayload(cardId: string, fileName: string, cardVersion: string) {
  if (safeId(cardId) !== cardId || path.basename(fileName) !== fileName) return null;
  const imagePath = path.join(dataDir, "recognition", "uploads", cardId, fileName);
  try {
    await access(imagePath);
    const stored = JSON.parse(await readFile(`${imagePath}.upload.json`, "utf8")) as {
      cardVersion: string; recognition: CombinedRecognitionResult;
    };
    if (stored.cardVersion !== cardVersion) return null;
    const { blockCrops = [], imagePath: _imagePath, layoutPath: _layoutPath, ...recognition } = stored.recognition;
    const cropImages = [];
    for (const { path: cropPath, ...crop } of blockCrops) {
      if (!isInsideDir(path.join(dataDir, "recognition", "crop-temp", cardId), path.resolve(cropPath))) return null;
      cropImages.push({ ...crop, dataBase64: (await readFile(cropPath)).toString("base64") });
    }
    return { ...recognition, cardVersion: stored.cardVersion, cropImages };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
