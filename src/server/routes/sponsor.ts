import express from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dataDir } from "../../apps/answer-card/server/storage";
import bundledConfig from "../../apps/answer-card/server/data/sponsor.json";
import path from "node:path";
import type { Request, Response } from "express";

const router = express.Router();

const sponsorDir = path.join(path.dirname(dataDir), "sponsor");
const sourceConfig = path.resolve("src/apps/answer-card/server/data/sponsor.json");

async function loadSponsorConfig(): Promise<typeof bundledConfig> {
  for (const file of [path.join(sponsorDir, "sponsor.json"), sourceConfig]) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return bundledConfig;
}

function resolveQrPath(qrFile: string): string | null {
  const name = path.basename(qrFile);
  if (!name || name === "." || name === "..") return null;
  const persistentFile = path.join(sponsorDir, "qr", name);
  if (existsSync(persistentFile)) return persistentFile;
  const bundledFile = path.resolve("data", "sponsor", "qr", name);
  return existsSync(bundledFile) ? bundledFile : null;
}

/** GET /api/sponsor — 赞助页配置（收款码 URL 由服务端解析） */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const config = await loadSponsorConfig();
    const channels = config.channels
      .filter((channel) => channel.enabled)
      .map((channel) => {
        const qrPath = channel.qrFile ? resolveQrPath(channel.qrFile) : null;
        return {
          id: channel.id,
          name: channel.name,
          enabled: channel.enabled,
          qrUrl: qrPath ? `/api/sponsor/qr/${encodeURIComponent(channel.id)}` : null
        };
      });

    res.json({
      title: config.title,
      description: config.description,
      channels
    });
  } catch (error) {
    console.error("Sponsor config error:", error);
    res.status(500).json({ message: "赞助配置加载失败" });
  }
});

/** GET /api/sponsor/qr/:channelId — 按渠道返回收款码图片 */
router.get("/qr/:channelId", async (req: Request, res: Response) => {
  try {
    const config = await loadSponsorConfig();
    const channelId = req.params.channelId;
    const channel = config.channels.find((item) => item.id === channelId && item.enabled);
    if (!channel?.qrFile) {
      res.status(404).json({ message: "收款码未配置" });
      return;
    }

    const qrPath = resolveQrPath(channel.qrFile);
    if (!qrPath) {
      res.status(404).json({ message: "收款码文件不存在" });
      return;
    }

    res.sendFile(qrPath);
  } catch (error) {
    console.error("Sponsor QR error:", error);
    res.status(500).json({ message: "收款码加载失败" });
  }
});

export default router;
