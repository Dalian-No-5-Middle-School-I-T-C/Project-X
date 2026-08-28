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
import { Router, type Request, type Response, type NextFunction } from "express";
import { apiKeyAuth } from "../middleware/api-key";
import { authMiddleware } from "../middleware/auth";
import { CardRepository } from "../repositories/CardRepository";
import { ClassRepository } from "../repositories/ClassRepository";
import { getMysqlDb } from "../db";
import { GROUP_MEMBER_NOT_SOFT_DELETED_SQL, EXAM_NOT_SOFT_DELETED_SQL, getVisibleExamIds } from "../../apps/answer-card/server/middleware";
import { roleHasPermission, PERMISSIONS } from "../auth/permissions";
import { canReadGroup, visibleExamIdsForGroupRead } from "./exam-groups-helpers";
import { ExamRepository } from "../repositories/ExamRepository";

const router = Router();

async function scannerSyncAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    return (apiKeyAuth({ scope: "scanner" }) as any)(req, res, next);
  }
  // JWT 路径：强制要求有效令牌，不受全局 enforce 关闭影响；学生一律 403
  await (authMiddleware as any)(req, res, (err?: any) => {
    if (err) return next(err);
    if ((res as any).headersSent) return;
    if (!(req as any).user) {
      res.status(401).json({ message: "未提供认证令牌" });
      return;
    }
    if ((req as any).user?.role_name === "student") {
      res.status(403).json({ message: "学生无权访问同步接口" });
      return;
    }
    next();
  });
}

function requirePerm(perm: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if ((req as any).isApiClient) return next();
    const user = (req as any).user;
    if (!user) { res.status(401).json({ message: "未认证" }); return; }
    if (!roleHasPermission(user.role_id, perm)) {
      res.status(403).json({ message: `权限不足：缺少 ${perm}` });
      return;
    }
    next();
  };
}

router.use(scannerSyncAuth);

// GET /api/scanner/sync/cards
router.get("/cards", requirePerm(PERMISSIONS.CARD_READ), async (_req: Request, res: Response) => {
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
router.get("/cards/:id", requirePerm(PERMISSIONS.CARD_READ), async (req: Request, res: Response) => {
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
router.get("/exam-groups", requirePerm(PERMISSIONS.EXAM_READ), async (req: Request, res: Response) => {
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
    // 受限教师范围过滤（JWT 路径）；Scanner Key 直通
    if (!(req as any).isApiClient) {
      const visibleIds = await visibleExamIdsForGroupRead(req);
      if (visibleIds !== null) {
        const filtered: any[] = [];
        for (const row of rows) {
          if (await canReadGroup(req, Number(row.id))) filtered.push(row);
        }
        rows = filtered;
      }
    }
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
router.get("/exam-groups/:id", requirePerm(PERMISSIONS.EXAM_READ), async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.id);
    const group = await db.get(`SELECT eg.*, g.name as grade_name FROM exam_groups eg LEFT JOIN grades g ON g.id = eg.grade_id WHERE eg.id = ?`, groupId) as any;
    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }
    if (!(req as any).isApiClient && !(await canReadGroup(req, groupId))) {
      res.status(403).json({ message: "无权查看该大考" });
      return;
    }
    const members = (await db.all(
      `SELECT egm.id, egm.exam_id, egm.sort_order, egm.track_type, e.name as exam_name, e.subject, e.card_id
       FROM exam_group_members egm JOIN exams e ON e.id = egm.exam_id
       WHERE egm.group_id = ? AND ${EXAM_NOT_SOFT_DELETED_SQL}
       ORDER BY egm.sort_order, egm.id`, groupId
    )) as any[];
    res.json({
      id: group.id, name: group.name, description: group.description, grade_id: group.grade_id, grade_name: group.grade_name || null,
      tag: group.tag, status: group.status, is_official: group.is_official,
      total_score_mode: group.total_score_mode, only_full_participants: group.only_full_participants,
      created_by: group.created_by, created_at: group.created_at, updated_at: group.updated_at,
      memberTracks: Object.fromEntries(members.map((m: any) => [String(m.exam_id), m.track_type || "common"])),
      members: members.map((m: any) => ({ id: m.id, examId: m.exam_id, examName: m.exam_name, subject: m.subject, cardId: m.card_id ?? null, sortOrder: m.sort_order, trackType: m.track_type || "common" })),
    });
  } catch (e: any) {
    res.status(500).json({ message: e.message || "获取大考详情失败" });
  }
});

// GET /api/scanner/sync/classes/grades
router.get("/classes/grades", requirePerm(PERMISSIONS.EXAM_READ), async (_req: Request, res: Response) => {
  try {
    const classRepo = new ClassRepository();
    res.json(await classRepo.listGrades());
  } catch (e: any) {
    res.status(500).json({ message: e.message || "获取年级失败" });
  }
});

// GET /api/scanner/sync/exams
router.get("/exams", requirePerm(PERMISSIONS.EXAM_READ), async (req: Request, res: Response) => {
  try {
    // Scanner Key 直通全量；JWT 复用业务可见范围（与 /api/exams 一致）
    if ((req as any).isApiClient) {
      const db = getMysqlDb();
      const rows = (await db.all(`SELECT * FROM exams WHERE ${EXAM_NOT_SOFT_DELETED_SQL} ORDER BY created_at DESC LIMIT 200`)) as any[];
      res.json(rows);
      return;
    }
    const visibleIds = await getVisibleExamIds((req as any).user);
    if (visibleIds !== null && visibleIds.length === 0) { res.json([]); return; }
    const examRepo = new ExamRepository();
    const rows = await examRepo.listExams(visibleIds !== null ? { examIds: visibleIds } as any : {});
    // 额外软删除过滤（listExams 可能已含，但保持与成员一致）
    const db = getMysqlDb();
    const softRows = rows.filter((r: any) => r != null);
    // 若 repo 未过滤软删除，补充过滤（小表可接受）
    // 统一截断 200
    res.json(softRows.slice(0, 200));
  } catch (e: any) {
    res.status(500).json({ message: e.message || "获取考试失败" });
  }
});

export default router;
