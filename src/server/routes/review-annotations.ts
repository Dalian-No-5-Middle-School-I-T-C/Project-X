/**
 * 阅卷批注 API
 * 挂载点: /api/review-annotations
 */
import { Router } from "express";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { canGradeBlock, isPrivilegedGrader } from "../../apps/answer-card/server/middleware";
import { getMysqlDb } from "../db";
import { randomUUID } from "node:crypto";

const router = Router();
router.use(authMiddleware);

/**
 * cropId → (examId, blockId) 解析（安全 R03）。
 *
 * 批注接口原先只按 `cropId` 读写：任何持有 `grade:read` / `grade:write` 的教师，
 * 只要拿到（或猜到）一个 cropId，就能读取任意考试、任意题块的批注（批注里带学生答案
 * 区域的坐标与内容标记），并往别人的题块写批注。这里把 cropId 还原到考试与题块，
 * 再套用网阅的题块级正向授权 `canGradeBlock`，与 submit 端点同一口径。
 */
async function resolveCropScope(cropId: string): Promise<{ examId: number; blockId: string } | null> {
  const row = await getMysqlDb().get(
    "SELECT exam_id, block_id FROM answer_block_crops WHERE id = ?",
    cropId
  ) as { exam_id: number; block_id: string } | undefined;
  if (!row) return null;
  return { examId: Number(row.exam_id), blockId: String(row.block_id) };
}

// GET /api/review-annotations?cropId=xxx — 获取某个切块的所有批注
router.get("/", requirePermission(PERMISSIONS.GRADE_READ), async (req, res) => {
  try {
    const cropId = typeof req.query.cropId === "string" ? req.query.cropId : "";
    if (!cropId) return res.status(400).json({ ok: false, error: "cropId required" });

    const scope = await resolveCropScope(cropId);
    if (!scope) return res.status(404).json({ ok: false, error: "切块不存在" });
    if (!(await canGradeBlock(req.user, scope.examId, scope.blockId))) {
      return res.status(403).json({ ok: false, error: `权限不足：未获分配题块 ${scope.blockId}` });
    }

    const db = getMysqlDb();
    const rows = await db.all(
      `SELECT ra.*, u.name AS reviewer_name
       FROM review_annotations ra
       LEFT JOIN users u ON u.id = ra.reviewer_id
       WHERE ra.crop_id = ?
       ORDER BY ra.created_at`,
      cropId
    );

    const annotations = (rows as any[]).map((r) => ({
      id: r.id,
      cropId: r.crop_id,
      reviewerId: r.reviewer_id,
      reviewerName: r.reviewer_name,
      type: r.type,
      dataJson: typeof r.data_json === "string" ? JSON.parse(r.data_json) : r.data_json,
      createdAt: r.created_at,
    }));

    res.json({ ok: true, data: annotations });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/review-annotations — 保存一条批注
router.post("/", requirePermission(PERMISSIONS.GRADE_WRITE), async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "未登录" });

    const { cropId, type, dataJson, positionX, positionY, width, height, color } = req.body;
    if (!cropId || !type || !dataJson) {
      return res.status(400).json({ ok: false, error: "cropId, type, dataJson required" });
    }

    const db = getMysqlDb();
    // 安全 R03：写入前同样校验题块授权，避免向未分配题块注入批注。
    const scope = await resolveCropScope(String(cropId));
    if (!scope) return res.status(404).json({ ok: false, error: "切块不存在" });
    if (!(await canGradeBlock(req.user, scope.examId, scope.blockId))) {
      return res.status(403).json({ ok: false, error: `权限不足：未获分配题块 ${scope.blockId}` });
    }

    const id = randomUUID();

    const annotationData = {
      ...dataJson,
      x: positionX ?? dataJson.x ?? 0,
      y: positionY ?? dataJson.y ?? 0,
      width: width ?? dataJson.width ?? null,
      height: height ?? dataJson.height ?? null,
      color: color ?? dataJson.color ?? "#FF3B30",
    };

    await db.run(
      `INSERT INTO review_annotations (id, crop_id, reviewer_id, type, data_json)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      cropId,
      userId,
      type,
      JSON.stringify(annotationData)
    );

    res.json({
      ok: true,
      data: { id, cropId, reviewerId: userId, type, dataJson: annotationData }
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/review-annotations/:id — 删除批注
router.delete("/:id", requirePermission(PERMISSIONS.GRADE_WRITE), async (req, res) => {
  try {
    const id = String(req.params.id ?? "");
    const db = getMysqlDb();
    // 安全 R03：原先无条件按 id 删除，任意教师可清空他人（甚至任意 cropId 持有者）的批注。
    // 现在要求「本人写的」或「特权阅卷人（管理员/学年主任）」，与 submit 的代处理规则一致。
    const existing = await db.get(
      "SELECT reviewer_id, crop_id FROM review_annotations WHERE id = ?",
      id
    ) as { reviewer_id: number | null; crop_id: string } | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: "批注不存在" });
    const userId = (req as any).user?.id;
    if (!isPrivilegedGrader(req.user) && Number(existing.reviewer_id) !== Number(userId)) {
      return res.status(403).json({ ok: false, error: "权限不足：只能删除本人添加的批注" });
    }
    await db.run("DELETE FROM review_annotations WHERE id = ?", id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
