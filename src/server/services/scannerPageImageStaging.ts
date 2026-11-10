import { writeFile } from "node:fs/promises";

/** Disk staging for scanner page originals; tests may replace `write` before loading upload routes. */
export const scannerPageImageStaging = {
  async write(target: string, data: Buffer): Promise<void> {
    await writeFile(target, data);
  },
};
