import express from "express";
import type { Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getDatabase } from "../db";

/**
 * AI 服务商配置管理
 * 挂载点：/api/ai/providers
 *
 * 每个用户可配置多个服务商（GPT / DeepSeek / 哈基米 / Gemini）
 * 支持自定义 base_url
 */
const router = express.Router();

router.use(authMiddleware);

// ── 列表用户的所有服务商 ──────────────────────────
router.get("/", (req: Request, res: Response) => {
  const db = getDatabase();
  const providers = db.prepare(`
    SELECT id, name, provider_type, base_url, api_key, models, is_active, sort_order
    FROM ai_providers
    WHERE user_id = ?
    ORDER BY sort_order, id
  `).all((req as any).userId) as any[];

  res.json(providers.map((p: any) => ({
    id: p.id,
    name: p.name,
    providerType: p.provider_type,
    baseUrl: p.base_url,
    apiKey: p.api_key,
    models: p.models ? JSON.parse(p.models) : null,
    isActive: !!(p.is_active)
  })));
});

// ── 创建服务商 ────────────────────────────────────
router.post("/", (req: Request, res: Response) => {
  const { name, providerType, baseUrl, apiKey, models } = req.body ?? {};
  if (!name || !providerType || !baseUrl || !apiKey) {
    res.status(400).json({ message: "缺少必要参数: name, providerType, baseUrl, apiKey" });
    return;
  }
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO ai_providers (user_id, name, provider_type, base_url, api_key, models)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run((req as any).userId, name, providerType, baseUrl, apiKey, models ? JSON.stringify(models) : null);

  res.status(201).json({ id: result.lastInsertRowid });
});

// ── 更新服务商 ────────────────────────────────────
router.put("/:id", (req: Request, res: Response) => {
  const { name, providerType, baseUrl, apiKey, models, isActive } = req.body ?? {};
  const db = getDatabase();

  const provider = db.prepare(
    "SELECT * FROM ai_providers WHERE id = ? AND user_id = ?"
  ).get(Number(req.params.id), (req as any).userId) as any;

  if (!provider) {
    res.status(404).json({ message: "服务商不存在" });
    return;
  }

  db.prepare(`
    UPDATE ai_providers SET
      name = COALESCE(?, name),
      provider_type = COALESCE(?, provider_type),
      base_url = COALESCE(?, base_url),
      api_key = COALESCE(?, api_key),
      models = COALESCE(?, models),
      is_active = COALESCE(?, is_active),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name ?? null, providerType ?? null, baseUrl ?? null,
    apiKey ?? null, models ? JSON.stringify(models) : null,
    isActive !== undefined ? (isActive ? 1 : 0) : null,
    Number(req.params.id)
  );

  res.json({ ok: true });
});

// ── 删除服务商 ────────────────────────────────────
router.delete("/:id", (req: Request, res: Response) => {
  const db = getDatabase();
  const result = db.prepare(
    "DELETE FROM ai_providers WHERE id = ? AND user_id = ?"
  ).run(Number(req.params.id), (req as any).userId);

  if (result.changes === 0) {
    res.status(404).json({ message: "服务商不存在" });
    return;
  }
  res.json({ ok: true });
});

export default router;
