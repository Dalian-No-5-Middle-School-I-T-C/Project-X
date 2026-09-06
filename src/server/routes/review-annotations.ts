/**
 * 阅卷批注 API
 * 挂载点: /api/review-annotations
 */
import { Router } from "express";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { getMysqlDb } from "../db";
import { randomUUID } from "node:crypto";

const router = Router();
router.use(authMiddleware);

// GET /api/review-annotations?cropId=xxx — 获取某个切块的所有批注
router.get("/", requirePermission(PERMISSIONS.GRADE_READ), async (req, res) => {
  try {
    const cropId = typeof req.query.cropId === "string" ? req.query.cropId : "";
    if (!cropId) return res.status(400).json({ ok: false, error: "cropId required" });

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
    await db.run("DELETE FROM review_annotations WHERE id = ?", id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
