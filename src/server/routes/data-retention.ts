/**
 * 数据保留策略管理 API（管理员）
 * 挂载点: /api/admin/data-retention-policies
 * 表: data_retention_policies(id, name, retain_days, auto_archive, auto_delete)
 * 权限: 全部 SYSTEM_MANAGE；仅返回策略元数据（无个人数据）。
 */
import { Router } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { getMysqlDb } from "../db";

const router = Router();

// GET /api/admin/data-retention-policies — 列出全部保留策略
router.get("/", requirePermission(PERMISSIONS.SYSTEM_MANAGE), async (_req, res) => {
  try {
    const rows = (await getMysqlDb().all(
      "SELECT id, name, retain_days, auto_archive, auto_delete FROM data_retention_policies ORDER BY id"
    )) as Array<{ id: number; name: string; retain_days: number; auto_archive: number; auto_delete: number }>;
    res.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        retainDays: r.retain_days,
        autoArchive: r.auto_archive ? 1 : 0,
        autoDelete: r.auto_delete ? 1 : 0,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/admin/data-retention-policies/:id — 更新单条保留策略
// body: { retainDays?, autoArchive?, autoDelete? }
router.put("/:id", requirePermission(PERMISSIONS.SYSTEM_MANAGE), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ ok: false, error: "无效的策略 ID" });
      return;
    }
    const db = getMysqlDb();
    const existing = await db.get("SELECT id FROM data_retention_policies WHERE id = ?", id);
    if (!existing) {
      res.status(404).json({ ok: false, error: "策略不存在" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (body.retainDays !== undefined) {
      const days = Number(body.retainDays);
      if (!Number.isInteger(days) || days < 0) {
        res.status(400).json({ ok: false, error: "retainDays 必须为非负整数（0=永久保留）" });
        return;
      }
      sets.push("retain_days = ?");
      vals.push(days);
    }
    if (body.autoArchive !== undefined) {
      sets.push("auto_archive = ?");
      vals.push(body.autoArchive ? 1 : 0);
    }
    if (body.autoDelete !== undefined) {
      sets.push("auto_delete = ?");
      vals.push(body.autoDelete ? 1 : 0);
    }
    if (sets.length === 0) {
      res.status(400).json({ ok: false, error: "无有效更新项" });
      return;
    }

    vals.push(id);
    await db.run(`UPDATE data_retention_policies SET ${sets.join(", ")} WHERE id = ?`, ...vals);
    res.json({ ok: true, message: "保留策略已更新" });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
