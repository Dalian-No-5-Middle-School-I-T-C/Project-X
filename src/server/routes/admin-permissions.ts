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
export async function upsertTeacherPermission(
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
  },
): Promise<void> {
  const { teacher_id, grade_id, subject, class_id, block_id } = params;
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
       SET can_view_scores = ?, can_view_charts = ?, can_view_students = ?, can_grade = ?, can_assign = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ...flags, existing.id,
    );
    return;
  }

  try {
    await db.run(
      `INSERT INTO teacher_permissions
         (teacher_id, grade_id, subject, class_id, block_id,
          can_view_scores, can_view_charts, can_view_students, can_grade, can_assign, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      teacher_id, grade_id, subject, class_id, block_id, ...flags,
    );
  } catch (err: any) {
    // 撞唯一约束：同教师同一维度组合已存在授权记录（含旧 UNIQUE(teacher_id, grade_id) 升级场景）
    if (err?.code === "ER_DUP_ENTRY" || String(err?.message ?? "").includes("UNIQUE constraint")) {
      throw new Error("该教师在此维度组合下已存在授权记录；如需覆盖请直接修改原记录");
    }
    throw err;
  }
}

/**
 * 按记录 ID 更新（#246 评审 P1：编辑权限范围必须撤销旧授权）。
 * 管理员在界面上编辑一条权限并修改教师/年级/科目/班级/题块时，直接更新该行
 * 的全部维度与标志；若新维度组合撞上其他记录的唯一约束，返回明确错误
 * （由调用方转 409 提示），绝不静默新增第二条而保留旧授权。
 */
export async function updateTeacherPermissionById(
  db: DbAdapter,
  id: number,
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
  },
): Promise<void> {
  const existing = await db.get<{ id: number }>("SELECT id FROM teacher_permissions WHERE id = ? LIMIT 1", id);
  if (!existing) {
    throw Object.assign(new Error("权限记录不存在（可能已被删除），请刷新后重试"), { status: 404 });
  }
  // 维度精确预检查（与 upsert 的 IS NULL 匹配口径一致）：SQLite/MariaDB 的 UNIQUE
  // 索引均视 NULL 为互异，纯 NULL 维度的逻辑重复不会触发数据库约束，须显式拦截。
  const { teacher_id, grade_id, subject, class_id, block_id } = params;
  const gradeClause = grade_id == null ? "grade_id IS NULL" : "grade_id = ?";
  const gradeVals = grade_id == null ? [] : [grade_id];
  const dims: Array<{ col: string; val: string | number | null }> = [
    { col: "subject", val: subject },
    { col: "class_id", val: class_id },
    { col: "block_id", val: block_id },
  ];
  const dimClauses = dims.map((d) => (d.val == null ? `${d.col} IS NULL` : `${d.col} = ?`));
  const dimVals = dims.filter((d) => d.val != null).map((d) => d.val);
  const dup = await db.get<{ id: number }>(
    `SELECT id FROM teacher_permissions
     WHERE teacher_id = ? AND ${gradeClause} AND ${dimClauses.join(" AND ")} AND id != ?
     LIMIT 1`,
    teacher_id, ...gradeVals, ...dimVals, id,
  );
  if (dup) {
    throw Object.assign(
      new Error("修改后的维度组合与现有授权记录冲突；如需合并请先删除或编辑那条记录"),
      { status: 409 },
    );
  }
  const flags = [
    params.can_view_scores ? 1 : 0,
    params.can_view_charts ? 1 : 0,
    params.can_view_students ? 1 : 0,
    params.can_grade ? 1 : 0,
    params.can_assign ? 1 : 0,
  ];
  try {
    const result = await db.run(
      `UPDATE teacher_permissions
       SET teacher_id = ?, grade_id = ?, subject = ?, class_id = ?, block_id = ?,
           can_view_scores = ?, can_view_charts = ?, can_view_students = ?, can_grade = ?, can_assign = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      params.teacher_id, params.grade_id, params.subject, params.class_id, params.block_id,
      ...flags, id,
    );
    if (Number(result.changes) === 0) {
      throw Object.assign(new Error("权限记录不存在（可能已被删除），请刷新后重试"), { status: 404 });
    }
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY" || String(err?.message ?? "").includes("UNIQUE constraint")) {
      throw Object.assign(
        new Error("修改后的维度组合与现有授权记录冲突；如需合并请先删除或编辑那条记录"),
        { status: 409 },
      );
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
// body: { id?, teacher_id, grade_id?, subject?, class_id?, block_id?,
//         can_view_scores?, can_view_charts?, can_view_students?,
//         can_grade?, can_assign? }（维度缺省 null=不限；操作标志缺省 true）
// 携带 id = 编辑既有记录：按记录 ID 原地更新全部维度与标志（旧维度授权随之撤销）；
// 不带 id = 按维度组合 upsert（旧行为）。
router.put("/", async (req, res) => {
  try {
    const body = req.body ?? {};
    const teacher_id = Number(body.teacher_id);
    if (!Number.isInteger(teacher_id) || teacher_id <= 0) {
      res.status(400).json({ message: "缺少 teacher_id" });
      return;
    }
    const editingId = Number(body.id);
    const hasEditingId = body.id !== undefined && body.id !== null && Number.isInteger(editingId) && editingId > 0;
    const toIntOrNull = (v: unknown): number | null => {
      const n = Number(v);
      return v === undefined || v === null || v === "" || !Number.isInteger(n) || n <= 0 ? null : n;
    };
    const toStrOrNull = (v: unknown): string | null => {
      const s = typeof v === "string" ? v.trim() : "";
      return s === "" ? null : s;
    };
    const toFlag = (v: unknown, def = true): boolean => {
      if (v === undefined || v === null) return def;
      return v === true || v === 1 || v === "1" || v === "true";
    };

    const db = getMysqlDb();
    // 校验目标教师存在且为启用状态的教师角色（外键兜底之外给出明确错误）
    const teacherRow = await db.get(
      "SELECT id FROM users WHERE id = ? AND role_id = 2 AND is_active = 1",
      teacher_id
    );
    if (!teacherRow) {
      res.status(400).json({ message: "教师不存在或未启用（需 role_id=2 的启用状态用户）" });
      return;
    }
    const payload = {
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
    };
    if (hasEditingId) {
      await updateTeacherPermissionById(db, editingId, payload);
    } else {
      await upsertTeacherPermission(db, payload);
    }
    res.json({ ok: true });
  } catch (error: any) {
    const status = typeof error?.status === "number" ? error.status : 500;
    res.status(status).json({ message: error instanceof Error ? error.message : "保存失败" });
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
