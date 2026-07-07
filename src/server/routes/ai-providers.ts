import express from "express";
import type { Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getMysqlDb } from "../db";
import { maskApiKey } from "../utils/maskApiKey";

/**
 * AI 服务商配置管理
 * 挂载点：/api/ai/providers
 *
 * 每个用户可配置多个服务商（GPT / DeepSeek / Gemini）
 * 支持自定义 base_url
 */
const router = express.Router();

router.use(authMiddleware);

// ── 列表用户的所有服务商 ──────────────────────────
router.get("/", async (req: Request, res: Response) => {
  const db = getMysqlDb();
  const providers = await db.all(`
    SELECT id, name, provider_type, base_url, api_key, models, is_active, sort_order
    FROM ai_providers
    WHERE user_id = ?
    ORDER BY sort_order, id
  `, req.user!.id) as any[];

  res.json(providers.map((p: any) => ({
    id: p.id,
    name: p.name,
    providerType: p.provider_type,
    baseUrl: p.base_url,
    apiKey: maskApiKey(p.api_key),
    models: p.models ? JSON.parse(p.models) : null,
    isActive: !!(p.is_active)
  })));
});

function normalizeBaseUrl(url: string, providerType: string): string {
  if (!url) return url;
  let normalized = url.trim().replace(/\/+$/, "");

  if (providerType === "gemini") return normalized;

  if (!normalized.endsWith("/v1") && !normalized.includes("/openai/deployments")) {
    normalized = normalized + "/v1";
  }
  return normalized;
}

// ── 创建服务商 ────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  const { name, providerType, baseUrl, apiKey, models } = req.body ?? {};
  const needsBaseUrl = providerType !== "gemini";
  if (!name || !providerType || !apiKey || (needsBaseUrl && !baseUrl)) {
    res.status(400).json({ message: needsBaseUrl ? "缺少必要参数: name, providerType, baseUrl, apiKey" : "缺少必要参数: name, providerType, apiKey (Gemini 无需 Base URL)" });
    return;
  }
  const normalizedUrl = needsBaseUrl ? normalizeBaseUrl(baseUrl, providerType) : "";
  const db = getMysqlDb();
  const result = await db.run(`
    INSERT INTO ai_providers (user_id, name, provider_type, base_url, api_key, models)
    VALUES (?, ?, ?, ?, ?, ?)
  `, req.user!.id, name, providerType, normalizedUrl, apiKey, models ? JSON.stringify(models) : null);

  res.status(201).json({ id: result.lastInsertRowid, baseUrl: normalizedUrl });
});

// ── 更新服务商 ────────────────────────────────────
router.put("/:id", async (req: Request, res: Response) => {
  const { name, providerType, baseUrl, apiKey, models, isActive } = req.body ?? {};
  const db = getMysqlDb();

  const provider = await db.get(
    "SELECT * FROM ai_providers WHERE id = ? AND user_id = ?",
    Number(req.params.id), req.user!.id
  ) as any;

  if (!provider) {
    res.status(404).json({ message: "服务商不存在" });
    return;
  }

  const effectiveType = providerType ?? provider.provider_type;
  const normalizedUrl = baseUrl ? normalizeBaseUrl(baseUrl, effectiveType) : null;

  await db.run(`
    UPDATE ai_providers SET
      name = COALESCE(?, name),
      provider_type = COALESCE(?, provider_type),
      base_url = COALESCE(?, base_url),
      api_key = COALESCE(?, api_key),
      models = COALESCE(?, models),
      is_active = COALESCE(?, is_active),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    name ?? null, providerType ?? null, normalizedUrl,
    apiKey ?? null, models ? JSON.stringify(models) : null,
    isActive !== undefined ? (isActive ? 1 : 0) : null,
    Number(req.params.id)
  );

  res.json({ ok: true, baseUrl: normalizedUrl });
});

// ── 删除服务商 ────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  const db = getMysqlDb();
  const result = await db.run(
    "DELETE FROM ai_providers WHERE id = ? AND user_id = ?",
    Number(req.params.id), req.user!.id
  );

  if (result.changes === 0) {
    res.status(404).json({ message: "服务商不存在" });
    return;
  }
  res.json({ ok: true });
});

export default router;
