/**
 * Admin-only route: manage teacher permissions.
 * GET  /api/admin/permissions — list all teacher permissions
 * PUT  /api/admin/permissions — update a teacher's permissions
 */
import { Router } from "express";
import { getDatabase } from "../db";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";

const router = Router();
router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

// ── List ────────────────────────────────────────────────
router.get("/", (_req, res) => {
  try {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT tp.*, u.name as teacher_name, u.teacher_role, g.name as grade_name
      FROM teacher_permissions tp
      JOIN users u ON u.id = tp.teacher_id
      LEFT JOIN grades g ON g.id = tp.grade_id
      ORDER BY u.name, g.sort_order
    `).all();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "加载失败" });
  }
});

// ── Upsert (create or update) ───────────────────────────
router.put("/", (req, res) => {
  try {
    const { teacher_id, grade_id, can_view_scores, can_view_charts, can_view_students } = req.body;
    if (!teacher_id) {
      res.status(400).json({ message: "缺少 teacher_id" });
      return;
    }
    const db = getDatabase();
    db.prepare(`
      INSERT INTO teacher_permissions (teacher_id, grade_id, can_view_scores, can_view_charts, can_view_students, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(teacher_id, grade_id) DO UPDATE SET
        can_view_scores = excluded.can_view_scores,
        can_view_charts = excluded.can_view_charts,
        can_view_students = excluded.can_view_students,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      teacher_id,
      grade_id ?? null,
      can_view_scores ? 1 : 0,
      can_view_charts ? 1 : 0,
      can_view_students ? 1 : 0,
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "保存失败" });
  }
});

// ── Delete ──────────────────────────────────────────────
router.delete("/:id", (req, res) => {
  try {
    getDatabase().prepare("DELETE FROM teacher_permissions WHERE id = ?").run(Number(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "删除失败" });
  }
});

export default router;
