import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export async function copyOcrModels(directory: string): Promise<void> {
  const require = createRequire(import.meta.url);
  await mkdir(directory, { recursive: true });
  await Promise.all(["chi_sim", "eng"].map((language) => {
    const filename = `${language}.traineddata.gz`;
    const source = require.resolve(`@tesseract.js-data/${language}/4.0.0_best_int/${filename}`);
    return copyFile(source, path.join(directory, filename));
  }));
}
