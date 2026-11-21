import { writeFile } from "node:fs/promises";

/** Disk staging for scanner crop uploads; tests may replace `write` before loading upload routes. */
export const scannerCropStaging = {
  async write(target: string, data: Buffer): Promise<void> {
    await writeFile(target, data);
  },
};
