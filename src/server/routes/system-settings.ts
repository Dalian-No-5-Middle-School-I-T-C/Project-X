import { databaseTimestamp } from "../db/timestamp";
/**
 * 系统级全局设置 API（仅管理员）
 * 挂载点: /api/system-settings
 * 表: system_settings(key TEXT PRIMARY KEY, value TEXT)
 */
import { Router } from "express";
import { requirePermission, authMiddleware } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { getMysqlDb, buildUpsertSQL } from "../db";

const router = Router();

// GET /api/system-settings/public — 认证用户可读的全局标志（原卷相关 UI 用）
// 原卷两开关已提升为纯全局：管理员在全局设置页统一控制，所有教师遵从。
router.get(
  "/public",
  authMiddleware,
  async (_req, res) => {
    try {
      const rows = (await getMysqlDb().all(
        "SELECT `key`, value FROM system_settings WHERE `key` IN (?, ?)",
        "require_original_paper",
        "highlight_missing_paper"
      )) as Array<{ key: string; value: string }>;
      const map: Record<string, string> = {};
      for (const r of rows) map[r.key] = r.value;
      res.json({
        ok: true,
        data: {
          requireOriginalPaper: map.require_original_paper !== "0" ? 1 : 0,
          highlightMissingPaper: map.highlight_missing_paper !== "0" ? 1 : 0,
        },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// GET /api/system-settings — 读取全部全局设置（管理员）
router.get(
  "/",
  requirePermission(PERMISSIONS.SYSTEM_MANAGE),
  async (_req, res) => {
    try {
      const rows = (await getMysqlDb().all(
        "SELECT `key`, value FROM system_settings"
      )) as Array<{ key: string; value: string }>;
      const settings: Record<string, string> = {};
      for (const r of rows) settings[r.key] = r.value;
      res.json({ ok: true, data: settings });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// PUT /api/system-settings — 批量更新全局设置（管理员）
// body: { settings: Record<string, string> } 或 { key, value }
router.put(
  "/",
  requirePermission(PERMISSIONS.SYSTEM_MANAGE),
  async (req, res) => {
    try {
      const body = req.body ?? {};
      const updates: Record<string, string> = body.settings ?? {};
      if (typeof body.key === "string" && body.value !== undefined) {
        updates[body.key] = String(body.value);
      }
      const entries = Object.entries(updates);
      if (entries.length === 0) {
        return res.status(400).json({ ok: false, error: "无有效更新项" });
      }

      const db = getMysqlDb();
      const upsertSQL = buildUpsertSQL(
        db.dialect,
        "system_settings",
        ["key", "value", "updated_at"],
        ["key"],
        ["value", "updated_at"]
      );
      await db.transaction(async (tx) => {
        for (const [key, value] of entries) {
          await tx.run(upsertSQL, key, String(value), databaseTimestamp());
        }
      });

      res.json({ ok: true, message: `已更新 ${entries.length} 项全局设置` });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
