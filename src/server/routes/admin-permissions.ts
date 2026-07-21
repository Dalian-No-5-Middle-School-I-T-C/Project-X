/**
 * Admin-only route: manage teacher permissions.
 * GET  /api/admin/permissions — list all teacher permissions
 * PUT  /api/admin/permissions — update a teacher's permissions
 */
import { Router } from "express";
import { getMysqlDb, type DbAdapter } from "../db";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";

const router = Router();
router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

/** 显式 upsert：避免 UNIQUE(teacher_id, grade_id) 在 grade_id=NULL 时无法命中冲突行 */
async function upsertTeacherPermission(
  db: DbAdapter,
  params: {
    teacher_id: number;
    grade_id: number | null;
    can_view_scores: boolean;
    can_view_charts: boolean;
    can_view_students: boolean;
    updated_at: string;
  },
): Promise<void> {
  const { teacher_id, grade_id, can_view_scores, can_view_charts, can_view_students, updated_at } = params;
  const existing = grade_id == null
    ? await db.get<{ id: number }>("SELECT id FROM teacher_permissions WHERE teacher_id = ? AND grade_id IS NULL", teacher_id)
    : await db.get<{ id: number }>("SELECT id FROM teacher_permissions WHERE teacher_id = ? AND grade_id = ?", teacher_id, grade_id);

  const flags = [can_view_scores ? 1 : 0, can_view_charts ? 1 : 0, can_view_students ? 1 : 0];
  if (existing) {
    await db.run(
      `UPDATE teacher_permissions SET can_view_scores = ?, can_view_charts = ?, can_view_students = ?, updated_at = ? WHERE id = ?`,
      ...flags, updated_at, existing.id,
    );
  } else {
    await db.run(
      `INSERT INTO teacher_permissions (teacher_id, grade_id, can_view_scores, can_view_charts, can_view_students, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      teacher_id, grade_id, ...flags, updated_at,
    );
  }
}

// ── List ────────────────────────────────────────────────
router.get("/", async (_req, res) => {
  try {
    const db = getMysqlDb();
    const rows = await db.all(`
      SELECT tp.*, u.name as teacher_name, u.teacher_role, g.name as grade_name
      FROM teacher_permissions tp
      JOIN users u ON u.id = tp.teacher_id
      LEFT JOIN grades g ON g.id = tp.grade_id
      ORDER BY u.name, g.sort_order
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "加载失败" });
  }
});

// ── Upsert (create or update) ───────────────────────────
router.put("/", async (req, res) => {
  try {
    const { teacher_id, grade_id, can_view_scores, can_view_charts, can_view_students } = req.body;
    if (!teacher_id) {
      res.status(400).json({ message: "缺少 teacher_id" });
      return;
    }
    const db = getMysqlDb();
    const updatedAt = new Date().toISOString();
    await upsertTeacherPermission(db, {
      teacher_id,
      grade_id: grade_id ?? null,
      can_view_scores: !!can_view_scores,
      can_view_charts: !!can_view_charts,
      can_view_students: !!can_view_students,
      updated_at: updatedAt,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "保存失败" });
  }
});

// ── Delete ──────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const db = getMysqlDb();
    await db.run("DELETE FROM teacher_permissions WHERE id = ?", Number(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "删除失败" });
  }
});

export default router;
