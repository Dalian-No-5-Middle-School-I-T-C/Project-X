/**
 * Admin-only route: manage teacher permissions.
 * GET  /api/admin/permissions — list all teacher permissions
 * PUT  /api/admin/permissions — upsert a teacher's permission (grade / subject / class / block dims)
 * DELETE /:id — remove a permission row
 *
 * v37+（教师权限细粒度）：支持按科目 subject / 班级 class_id / 题块 block_id / 操作
 * can_grade / can_assign 维度授权；NULL 表示该维度不限。与旧「年级级 3 查看标志」
 * 完全兼容（新维度缺省为 NULL / 1）。
 */
import { Router } from "express";
import { getMysqlDb, type DbAdapter } from "../db";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";

const router = Router();
router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

/** 按全维度精确 upsert：grade/subject/class/block 四维皆 NULL 用 IS NULL 匹配。 */
async function upsertTeacherPermission(
  db: DbAdapter,
  params: {
    teacher_id: number;
    grade_id: number | null;
    subject: string | null;
    class_id: number | null;
    block_id: string | null;
    can_view_scores: boolean;
    can_view_charts: boolean;
    can_view_students: boolean;
    can_grade: boolean;
    can_assign: boolean;
    updated_at: string;
  },
): Promise<void> {
  const { teacher_id, grade_id, subject, class_id, block_id, updated_at } = params;
  const gradeClause = grade_id == null ? "grade_id IS NULL" : "grade_id = ?";
  const gradeVals = grade_id == null ? [] : [grade_id];
  const dims: Array<{ col: string; val: string | number | null }> = [
    { col: "subject", val: subject },
    { col: "class_id", val: class_id },
    { col: "block_id", val: block_id },
  ];
  const dimClauses = dims.map((d) => (d.val == null ? `${d.col} IS NULL` : `${d.col} = ?`));
  const dimVals = dims.filter((d) => d.val != null).map((d) => d.val);

  const existing = await db.get<{ id: number }>(
    `SELECT id FROM teacher_permissions
     WHERE teacher_id = ? AND ${gradeClause} AND ${dimClauses.join(" AND ")}
     LIMIT 1`,
    teacher_id, ...gradeVals, ...dimVals,
  );

  const flags = [
    params.can_view_scores ? 1 : 0,
    params.can_view_charts ? 1 : 0,
    params.can_view_students ? 1 : 0,
    params.can_grade ? 1 : 0,
    params.can_assign ? 1 : 0,
  ];

  if (existing) {
    await db.run(
      `UPDATE teacher_permissions
       SET can_view_scores = ?, can_view_charts = ?, can_view_students = ?, can_grade = ?, can_assign = ?, updated_at = ?
       WHERE id = ?`,
      ...flags, updated_at, existing.id,
    );
    return;
  }

  try {
    await db.run(
      `INSERT INTO teacher_permissions
         (teacher_id, grade_id, subject, class_id, block_id,
          can_view_scores, can_view_charts, can_view_students, can_grade, can_assign, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      teacher_id, grade_id, subject, class_id, block_id, ...flags, updated_at,
    );
  } catch (err: any) {
    // 撞旧 UNIQUE(teacher_id, grade_id)：同教师同年级已存在旧行且维度不同（NULL 维度行不冲突）
    if (err?.code === "ER_DUP_ENTRY" || String(err?.message ?? "").includes("UNIQUE constraint")) {
      throw new Error("同教师同年级已存在授权记录；如需按科目/班级/题块细分，请先删除该教师的原记录再添加");
    }
    throw err;
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
      ORDER BY u.name, g.sort_order, tp.id
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "加载失败" });
  }
});

// ── Upsert (create or update) ───────────────────────────
// body: { teacher_id, grade_id?, subject?, class_id?, block_id?,
//         can_view_scores?, can_view_charts?, can_view_students?,
//         can_grade?, can_assign? }（维度缺省 null=不限；操作标志缺省 true）
router.put("/", async (req, res) => {
  try {
    const body = req.body ?? {};
    const teacher_id = Number(body.teacher_id);
    if (!Number.isInteger(teacher_id) || teacher_id <= 0) {
      res.status(400).json({ message: "缺少 teacher_id" });
      return;
    }
    const toIntOrNull = (v: unknown): number | null => {
      const n = Number(v);
      return v === undefined || v === null || v === "" || !Number.isInteger(n) || n <= 0 ? null : n;
    };
    const toStrOrNull = (v: unknown): string | null => {
      const s = typeof v === "string" ? v.trim() : "";
      return s === "" ? null : s;
    };
    const toFlag = (v: unknown, def = true): boolean => (v === undefined ? def : !!v);

    const db = getMysqlDb();
    await upsertTeacherPermission(db, {
      teacher_id,
      grade_id: toIntOrNull(body.grade_id),
      subject: toStrOrNull(body.subject),
      class_id: toIntOrNull(body.class_id),
      block_id: toStrOrNull(body.block_id),
      can_view_scores: toFlag(body.can_view_scores),
      can_view_charts: toFlag(body.can_view_charts),
      can_view_students: toFlag(body.can_view_students),
      can_grade: toFlag(body.can_grade),
      can_assign: toFlag(body.can_assign),
      updated_at: new Date().toISOString(),
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
