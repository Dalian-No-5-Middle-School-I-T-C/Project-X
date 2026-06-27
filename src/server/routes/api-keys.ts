/**
 * v1.6.0 — API Key 管理路由
 * 管理员可管理扫描客户端使用的 API Key
 * 
 * GET  /api/admin/api-keys      — 列出所有（脱敏）
 * POST /api/admin/api-keys      — 创建新 key
 * PUT  /api/admin/api-keys/:id  — 启用/停用
 * DELETE /api/admin/api-keys/:id — 删除
 */

import { Router } from "express";
import crypto from "node:crypto";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { getMysqlDb } from "../db";
import { PERMISSIONS } from "../auth/permissions";

const router = Router();

// 生成 API Key（sk- 前缀 + 32位随机hex）
function generateApiKey(): string {
  return `sk-${crypto.randomBytes(16).toString("hex")}`;
}

// 脱敏显示：仅保留前后各4位
function maskKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

// 列出一个用户的 keys
router.get("/", authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE), async (req, res) => {
  try {
    const db = await getMysqlDb();
    const keys = await db.all<any>(
      `SELECT ak.id, ak.name, ak.api_key, ak.scope, ak.is_active, ak.created_at,
              u.name as created_by_name
       FROM api_keys ak
       LEFT JOIN users u ON u.id = ak.created_by
       ORDER BY ak.created_at DESC`
    );
    res.json({
      keys: keys.map((k: any) => ({
        id: k.id,
        name: k.name,
        api_key: maskKey(k.api_key),
        scope: k.scope,
        is_active: !!k.is_active,
        created_by_name: k.created_by_name ?? null,
        created_at: k.created_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// 创建新 key（返回完整 key，仅此一次）
router.post("/", authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE), async (req, res) => {
  try {
    const { name, scope } = req.body ?? {};
    if (!name?.trim()) {
      res.status(400).json({ message: "名称不能为空" });
      return;
    }

    const apiKey = generateApiKey();
    const db = await getMysqlDb();

    await db.run(
      "INSERT INTO api_keys (name, api_key, scope, created_by) VALUES (?, ?, ?, ?)",
      name.trim(), apiKey, scope || "scanner", (req as any).user?.id ?? null
    );

    // 通过 api_key 反查 id（兼容 SQLite 和 MariaDB）
    const inserted = await db.get<{ id: number }>("SELECT id FROM api_keys WHERE api_key = ?", [apiKey]);

    res.status(201).json({
      id: inserted?.id,
      name: name.trim(),
      api_key: apiKey,
      scope: scope || "scanner",
      message: "请立即复制此 Key，刷新后将不再完整显示",
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// 启用/停用
router.put("/:id", authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { is_active } = req.body ?? {};

    if (typeof is_active !== "boolean") {
      res.status(400).json({ message: "is_active 必须为布尔值" });
      return;
    }

    const db = await getMysqlDb();
    const result = await db.run(
      "UPDATE api_keys SET is_active = ? WHERE id = ?",
      is_active ? 1 : 0, id
    );

    if (!(result as any)?.changes) {
      res.status(404).json({ message: "Key 不存在" });
      return;
    }

    res.json({ ok: true, message: is_active ? "已启用" : "已停用" });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// 删除
router.delete("/:id", authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = await getMysqlDb();

    const result = await db.run("DELETE FROM api_keys WHERE id = ?", id);

    if (!(result as any)?.changes) {
      res.status(404).json({ message: "Key 不存在" });
      return;
    }

    res.json({ ok: true, message: "已删除" });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
