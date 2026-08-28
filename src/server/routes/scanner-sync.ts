/**
 * Scanner 专用的只读同步路由（新增受 scanner Key 保护的只读同步面）
 * 仅供扫描端远端优先同步使用，不放宽全部业务 API。
 *
 * 鉴权：X-Api-Key (scope=scanner/full) 或 JWT（任意已登录用户）
 * GET /api/scanner/sync/cards
 * GET /api/scanner/sync/cards/:id
 * GET /api/scanner/sync/exam-groups
 * GET /api/scanner/sync/exam-groups/:id
 * GET /api/scanner/sync/classes/grades
 * GET /api/scanner/sync/exams
 */
import { Router, type Request, type Response } from "express";
import { apiKeyAuth } from "../middleware/api-key";
import { authMiddleware } from "../middleware/auth";
import { CardRepository } from "../repositories/CardRepository";
import { ClassRepository } from "../repositories/ClassRepository";
import { getMysqlDb } from "../db";
import { GROUP_MEMBER_NOT_SOFT_DELETED_SQL } from "../../apps/answer-card/server/middleware";

const router = Router();

async function scannerSyncAuth(req: Request, res: Response, next: any) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    return (apiKeyAuth({ scope: "scanner" }) as any)(req, res, next);
  }
  return (authMiddleware as any)(req, res, next);
}

router.use(scannerSyncAuth);

// GET /api/scanner/sync/cards
router.get("/cards", async (_req: Request, res: Response) => {
  try {
    const cardRepo = new CardRepository();
    const rows = await cardRepo.listCards();
    const summaries = (rows as any[]).map((row: any) => ({
      id: row.id,
      title: row.title || "未命名答题卡",
      subject: (row as any).subject ?? undefined,
      subjectLabel: (row as any).subject_label ?? undefined,
      examDate: (row as any).exam_date ?? undefined,
      updatedAt: (row as any).updatedAt ?? (row as any).updated_at ?? new Date(0).toISOString(),
    }));
    res.json(summaries);
  } catch (e: any) {
    res.status(500).json({ message: e.message || "获取答题卡失败" });
  }
});

// GET /api/scanner/sync/cards/:id
router.get("/cards/:id", async (req: Request, res: Response) => {
  try {
    const cardRepo = new CardRepository();
    const card = await cardRepo.findById(String(req.params.id));
    if (!card) { res.status(404).json({ message: "答题卡不存在" }); return; }
    res.json(card);
  } catch (e: any) {
    res.status(500).json({ message: e.message || "获取答题卡失败" });
  }
});

// GET /api/scanner/sync/exam-groups
router.get("/exam-groups", async (_req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    let rows = (await db.all(
      `SELECT eg.*, g.name as grade_name,
        (SELECT COUNT(*) FROM exam_group_members egm WHERE egm.group_id = eg.id AND ${GROUP_MEMBER_NOT_SOFT_DELETED_SQL}) as member_count,
        (SELECT COUNT(DISTINCT ss.student_id) FROM exam_group_members egm JOIN student_scores ss ON ss.exam_id = egm.exam_id WHERE egm.group_id = eg.id AND ${GROUP_MEMBER_NOT_SOFT_DELETED_SQL}) as has_results
       FROM exam_groups eg LEFT JOIN grades g ON g.id = eg.grade_id
       WHERE eg.source IS NULL OR eg.source = 'manual'
       ORDER BY eg.created_at DESC`
    )) as any[];
    res.json(rows.map((r: any) => ({
      id: r.id, name: r.name, description: r.description, tag: r.tag, grade_id: r.grade_id, grade_name: r.grade_name || null,
      status: r.status, is_official: r.is_official, total_score_mode: r.total_score_mode, only_full_participants: r.only_full_participants,
      member_count: r.member_count, has_results: r.has_results > 0 ? 1 : 0, created_at: r.created_at, updated_at: r.updated_at,
    })));
  } catch (e: any) {
    res.status(500).json({ message: e.message || "获取大考列表失败" });
  }
});

// GET /api/scanner/sync/exam-groups/:id
router.get("/exam-groups/:id", async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.id);
    const group = await db.get(`SELECT eg.*, g.name as grade_name FROM exam_groups eg LEFT JOIN grades g ON g.id = eg.grade_id WHERE eg.id = ?`, groupId) as any;
    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }
    const members = (await db.all(
      `SELECT egm.id, egm.exam_id, egm.sort_order, egm.track_type, e.name as exam_name, e.subject
       FROM exam_group_members egm JOIN exams e ON e.id = egm.exam_id
       WHERE egm.group_id = ? ORDER BY egm.sort_order, egm.id`, groupId
    )) as any[];
    res.json({
      id: group.id, name: group.name, description: group.description, grade_id: group.grade_id, grade_name: group.grade_name || null,
      tag: group.tag, status: group.status, is_official: group.is_official,
      total_score_mode: group.total_score_mode, only_full_participants: group.only_full_participants,
      created_by: group.created_by, created_at: group.created_at, updated_at: group.updated_at,
      memberTracks: Object.fromEntries(members.map((m: any) => [String(m.exam_id), m.track_type || "common"])),
      members: members.map((m: any) => ({ id: m.id, examId: m.exam_id, examName: m.exam_name, subject: m.subject, sortOrder: m.sort_order, trackType: m.track_type || "common" })),
    });
  } catch (e: any) {
    res.status(500).json({ message: e.message || "获取大考详情失败" });
  }
});

// GET /api/scanner/sync/classes/grades
router.get("/classes/grades", async (_req: Request, res: Response) => {
  try {
    const classRepo = new ClassRepository();
    res.json(await classRepo.listGrades());
  } catch (e: any) {
    res.status(500).json({ message: e.message || "获取年级失败" });
  }
});

// GET /api/scanner/sync/exams
router.get("/exams", async (_req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const rows = (await db.all(`SELECT * FROM exams ORDER BY created_at DESC LIMIT 200`)) as any[];
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ message: e.message || "获取考试失败" });
  }
});

export default router;
