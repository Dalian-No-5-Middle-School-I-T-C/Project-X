import express from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";

const router = express.Router();

interface SponsorChannelConfig {
  id: string;
  name: string;
  qrFile: string | null;
  enabled: boolean;
}

interface SponsorConfigFile {
  title: string;
  description: string;
  channels: SponsorChannelConfig[];
}

const rootDir = process.cwd();
const sponsorConfigPath = path.join(
  rootDir,
  "src",
  "apps",
  "answer-card",
  "server",
  "data",
  "sponsor.json"
);
const sponsorQrDir = path.join(rootDir, "data", "sponsor", "qr");

async function loadSponsorConfig(): Promise<SponsorConfigFile> {
  const raw = await readFile(sponsorConfigPath, "utf8");
  return JSON.parse(raw) as SponsorConfigFile;
}

function resolveQrPath(qrFile: string): string | null {
  const fileName = path.basename(qrFile);
  const fullPath = path.join(sponsorQrDir, fileName);
  if (!fullPath.startsWith(sponsorQrDir)) return null;
  return existsSync(fullPath) ? fullPath : null;
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
    const channelId = req.params.channelId;
    const config = await loadSponsorConfig();
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
