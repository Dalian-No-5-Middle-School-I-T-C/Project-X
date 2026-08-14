import express from "express";
import type { NextFunction, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getMysqlDb, buildInsertIgnore } from "../db";
import examGroupsAnalysisRouter from "./exam-groups-analysis";
import {
  assertExamIdsVisible,
  canReadGroup,
  normalizeTrackType,
  requireGroupManager,
  requireReadableGroup,
  visibleExamIdsForGroupRead,
} from "./exam-groups-helpers";

const router = express.Router();
router.use(authMiddleware);

router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role_name === "student") {
    res.status(403).json({ message: "学生无权访问考试组管理接口" });
    return;
  }
  next();
});
// ── GET /api/exam-groups ── list all groups (with optional filters) ──

router.get("/", async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const params: unknown[] = [];
    let sql = `
      SELECT eg.*,
             g.name as grade_name,
             (SELECT COUNT(*) FROM exam_group_members egm WHERE egm.group_id = eg.id) as member_count,
             (SELECT COUNT(DISTINCT ss.student_id) FROM exam_group_members egm
              JOIN student_scores ss ON ss.exam_id = egm.exam_id
              WHERE egm.group_id = eg.id) as has_results
      FROM exam_groups eg
      LEFT JOIN grades g ON g.id = eg.grade_id
      WHERE eg.source IS NULL OR eg.source = 'manual'
    `;
    if (req.query.grade_id) { sql += " AND eg.grade_id = ?"; params.push(req.query.grade_id); }
    if (req.query.status) { sql += " AND eg.status = ?"; params.push(req.query.status); }
    sql += " ORDER BY eg.created_at DESC";

    let rows = await db.all(sql, ...params) as any[];
    const visibleIds = await visibleExamIdsForGroupRead(req);
    if (visibleIds !== null) {
      const readable: any[] = [];
      for (const row of rows) {
        if (await canReadGroup(req, Number(row.id))) readable.push(row);
      }
      rows = readable;
    }
    const result = rows.map((r) => ({
      id: r.id, name: r.name, description: r.description,
      tag: r.tag, grade_id: r.grade_id, grade_name: r.grade_name || null,
      status: r.status, is_official: r.is_official,
      total_score_mode: r.total_score_mode, only_full_participants: r.only_full_participants,
      member_count: r.member_count, has_results: r.has_results > 0 ? 1 : 0,
      created_at: r.created_at, updated_at: r.updated_at
    }));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "获取大考列表失败" });
  }
});

// ── POST /api/exam-groups ── create exam group ──

router.post("/", requireGroupManager, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const { name, description, grade_id, tag, is_official, total_score_mode, only_full_participants, examIds, memberTracks }
      = req.body as {
        name: string; description?: string; grade_id?: number | null; tag?: string;
        is_official?: number; total_score_mode?: string; only_full_participants?: number;
        examIds?: number[]; memberTracks?: Record<string, string>;
      };

    if (!name || !name.trim()) {
      res.status(400).json({ message: "大考名称不能为空" });
      return;
    }
    if (examIds && !(await assertExamIdsVisible(req, res, examIds))) return;
    if (memberTracks) {
      for (const [examId, trackType] of Object.entries(memberTracks)) {
        if (!Number.isInteger(Number(examId)) || Number(examId) <= 0 || !normalizeTrackType(trackType)) {
          res.status(400).json({ message: "无效的文理分科配置：科目归属仅支持 common（共同）/ arts（文科）/ science（理科）" });
          return;
        }
      }
    }

    const groupId = await db.transaction(async (tx) => {
      const result = await tx.run(`
        INSERT INTO exam_groups (name, description, grade_id, tag, status, is_official, total_score_mode, only_full_participants, created_by)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `, name.trim(), description ?? null, grade_id ?? null, tag ?? null,
        is_official ?? 0, total_score_mode ?? "raw", only_full_participants ?? 0,
        req.user!.id);

      const createdGroupId = result.lastInsertRowid as number;
      if (examIds && examIds.length > 0) {
        const insertSql = buildInsertIgnore(tx.dialect, "exam_group_members", ["group_id", "exam_id", "sort_order", "track_type"]);
        for (const [idx, examId] of examIds.entries()) {
          const trackType = normalizeTrackType(memberTracks?.[String(examId)]) ?? "common";
          await tx.run(insertSql, createdGroupId, examId, idx, trackType);
        }
      }
      return createdGroupId;
    });

    res.status(201).json({ id: groupId, message: "大考创建成功" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "创建大考失败" });
  }
});

// ── GET /api/exam-groups/:groupId ── get group detail ──

router.get("/:groupId", requireReadableGroup, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);

    const group = await db.get(`
      SELECT eg.*, g.name as grade_name
      FROM exam_groups eg LEFT JOIN grades g ON g.id = eg.grade_id
      WHERE eg.id = ?
    `, groupId) as any;

    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }

    const members = await db.all(`
      SELECT egm.id, egm.exam_id, egm.sort_order, egm.track_type,
             e.name as exam_name, e.subject, ac.exam_date, e.status, e.assigned_formula,
             COUNT(ss.exam_id) as graded_count,
             ROUND(AVG(ss.total_score), 1) as avg_score
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      WHERE egm.group_id = ?
      GROUP BY egm.id
      ORDER BY egm.sort_order, egm.id
    `, groupId) as any[];

    res.json({
      id: group.id, name: group.name, description: group.description,
      grade_id: group.grade_id, grade_name: group.grade_name || null,
      tag: group.tag, status: group.status, is_official: group.is_official,
      total_score_mode: group.total_score_mode, only_full_participants: group.only_full_participants,
      created_by: group.created_by, created_at: group.created_at, updated_at: group.updated_at,
      memberTracks: Object.fromEntries(members.map((m) => [String(m.exam_id), m.track_type || "common"])),
      members: members.map((m) => ({
        id: m.id, examId: m.exam_id, examName: m.exam_name,
        subject: m.subject, sortOrder: m.sort_order,
        trackType: m.track_type || "common",
        examDate: m.exam_date || null, status: m.status,
        gradedCount: m.graded_count, avgScore: m.avg_score,
        hasAssignedScore: !!(m.assigned_formula && m.assigned_formula !== "") ? 1 : 0
      }))
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "获取大考详情失败" });
  }
});

// ── PUT /api/exam-groups/:groupId ── update group ──

router.put("/:groupId", requireGroupManager, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const existing = await db.get("SELECT id FROM exam_groups WHERE id = ?", groupId);
    if (!existing) { res.status(404).json({ message: "大考不存在" }); return; }

    const { name, description, grade_id, tag, is_official, total_score_mode, only_full_participants, examIds, memberTracks } = req.body;
    const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
    const vals: unknown[] = [];

    if (name !== undefined) { sets.push("name = ?"); vals.push(name.trim()); }
    if (description !== undefined) { sets.push("description = ?"); vals.push(description || null); }
    if (grade_id !== undefined) { sets.push("grade_id = ?"); vals.push(grade_id ?? null); }
    if (tag !== undefined) { sets.push("tag = ?"); vals.push(tag || null); }
    if (is_official !== undefined) { sets.push("is_official = ?"); vals.push(is_official); }
    if (total_score_mode !== undefined) { sets.push("total_score_mode = ?"); vals.push(total_score_mode); }
    if (only_full_participants !== undefined) { sets.push("only_full_participants = ?"); vals.push(only_full_participants); }

    if (memberTracks !== undefined && memberTracks !== null) {
      for (const [examId, trackType] of Object.entries(memberTracks as Record<string, string>)) {
        if (!Number.isInteger(Number(examId)) || Number(examId) <= 0 || !normalizeTrackType(trackType)) {
          res.status(400).json({ message: "无效的文理分科配置：科目归属仅支持 common（共同）/ arts（文科）/ science（理科）" });
          return;
        }
      }
    }

    await db.run(`UPDATE exam_groups SET ${sets.join(", ")} WHERE id = ?`, ...vals, groupId);

    // 编辑时同步成员（新增/移除）与文理科目归属
    if (Array.isArray(examIds)) {
      if (!(await assertExamIdsVisible(req, res, examIds.map(Number)))) return;
      await db.transaction(async (tx) => {
        const existing = await tx.all<{ exam_id: number }>(
          "SELECT exam_id FROM exam_group_members WHERE group_id = ?",
          groupId
        );
        const existingIds = new Set(existing.map((r) => Number(r.exam_id)));
        const targetIds = new Set(examIds.map(Number));
        for (const id of existingIds) {
          if (!targetIds.has(id)) {
            await tx.run("DELETE FROM exam_group_members WHERE group_id = ? AND exam_id = ?", groupId, id);
          }
        }
        const insertSql = buildInsertIgnore(tx.dialect, "exam_group_members", ["group_id", "exam_id", "sort_order", "track_type"]);
        for (const [idx, examId] of examIds.entries()) {
          const id = Number(examId);
          if (Number.isInteger(id) && id > 0 && !existingIds.has(id)) {
            const trackType = normalizeTrackType((memberTracks as Record<string, string> | undefined)?.[String(id)]) ?? "common";
            await tx.run(insertSql, groupId, id, idx, trackType);
          }
        }
      });
    }

    if (memberTracks) {
      await db.transaction(async (tx) => {
        for (const [examId, trackType] of Object.entries(memberTracks as Record<string, string>)) {
          const id = Number(examId);
          if (!Number.isInteger(id) || id <= 0) continue;
          await tx.run(
            "UPDATE exam_group_members SET track_type = ? WHERE group_id = ? AND exam_id = ?",
            normalizeTrackType(trackType) ?? "common",
            groupId,
            id
          );
        }
      });
    }

    res.json({ ok: true, message: "大考更新成功" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "更新大考失败" });
  }
});

// ── DELETE /api/exam-groups/:groupId ── delete group ──

router.delete("/:groupId", requireGroupManager, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const deleteExams = req.query.deleteExams === "1";

    const existing = await db.get("SELECT id, name FROM exam_groups WHERE id = ?", groupId) as { id: number; name: string } | undefined;
    if (!existing) { res.status(404).json({ message: "大考不存在" }); return; }

    // Count associated exams
    const memberExams = await db.all(`
      SELECT e.id, e.name FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      WHERE egm.group_id = ?
    `, groupId) as Array<{ id: number; name: string }>;

    await db.transaction(async (tx) => {
      // If deleting exams too, delete them (with cascade to scores etc.)
      if (deleteExams && memberExams.length > 0) {
        for (const exam of memberExams) {
          await tx.run("DELETE FROM exams WHERE id = ?", exam.id);
        }
      }
      // Delete the group (cascade deletes members)
      await tx.run("DELETE FROM exam_groups WHERE id = ?", groupId);
    });

    res.json({ ok: true, deletedExams: deleteExams ? memberExams.length : 0, message: "大考已删除" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "删除大考失败" });
  }
});

// ── POST /api/exam-groups/:groupId/exams ── associate exams ──

router.post("/:groupId/exams", requireGroupManager, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const { examIds, memberTracks } = req.body as { examIds?: number[]; memberTracks?: Record<string, string> };

    if (!examIds || examIds.length === 0) {
      res.status(400).json({ message: "请至少选择一个考试" });
      return;
    }
    if (!(await assertExamIdsVisible(req, res, examIds))) return;

    // Get current max sort_order
    const maxOrder = await db.get(
      "SELECT MAX(sort_order) as m FROM exam_group_members WHERE group_id = ?", groupId
    ) as { m: number | null };
    let nextOrder = (maxOrder?.m ?? -1) + 1;

    const insertSql = buildInsertIgnore(db.dialect, "exam_group_members", ["group_id", "exam_id", "sort_order", "track_type"]);

    const added = await db.transaction(async (tx) => {
      const inserted: number[] = [];
      for (const examId of examIds) {
        const trackType = normalizeTrackType(memberTracks?.[String(examId)]) ?? "common";
        const result = await tx.run(insertSql, groupId, examId, nextOrder, trackType);
        if (result.changes > 0) { inserted.push(examId); nextOrder++; }
      }
      return inserted;
    });

    res.json({ ok: true, added, message: `已关联 ${added.length} 场考试` });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "关联考试失败" });
  }
});

// ── DELETE /api/exam-groups/:groupId/exams/:examId ── remove exam ──

router.delete("/:groupId/exams/:examId", requireGroupManager, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const examId = Number(req.params.examId);
    await db.run(
      "DELETE FROM exam_group_members WHERE group_id = ? AND exam_id = ?",
      groupId, examId
    );
    res.json({ ok: true, message: "已移除考试关联" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "移除考试失败" });
  }
});

// ── PUT /api/exam-groups/:groupId/exams/sort ── update sort order ──

router.put("/:groupId/exams/sort", requireGroupManager, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const items = req.body as { examId: number; sortOrder: number }[];
    if (!Array.isArray(items)) { res.status(400).json({ message: "请求格式错误" }); return; }
    if (!(await assertExamIdsVisible(req, res, items.map((item) => item.examId)))) return;

    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx.run(
          "UPDATE exam_group_members SET sort_order = ? WHERE group_id = ? AND exam_id = ?",
          item.sortOrder, groupId, item.examId
        );
      }
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "更新排序失败" });
  }
});

router.use("/:groupId", examGroupsAnalysisRouter);

export default router;
