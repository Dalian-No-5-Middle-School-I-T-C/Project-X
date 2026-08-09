/**
 * 首页仪表盘 API
 * 挂载点: /api/dashboard
 */
import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requirePermission } from "../middleware/auth";
import { getMysqlDb } from "../db";
import { getUnfinishedSessions } from "../services/ReviewSessionService";
import { getVisibleExamIds } from "../../apps/answer-card/server/middleware";
import type { DashboardData } from "../../shared/types";

const router = Router();
router.use(authMiddleware);

router.get("/", requirePermission(PERMISSIONS.EXAM_READ), async (req, res) => {
  try {
    const db = getMysqlDb();
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "未登录" });

    // 教师按可见范围过滤统计与最新考试，避免学科老师/班主任看到全校数据
    const visibleExamIds = await getVisibleExamIds(req.user);
    const scopeSql = visibleExamIds == null
      ? ""
      : visibleExamIds.length === 0
        ? " AND 0"
        : ` AND e.id IN (${visibleExamIds.map(() => "?").join(",")})`;
    const scopeParams: number[] = visibleExamIds ?? [];

    const data: DashboardData = {
      hasUnfinishedGrading: false,
      unfinishedTask: null,
      latestScanExam: null,
      stats: { totalExams: 0, activeGradingExams: 0, completedExams: 0 }
    };

    // 1. 检查未完成阅卷会话
    const sessions = await getUnfinishedSessions(userId, db);
    if (sessions.length > 0) {
      const ses = sessions[0];
      const exam = await db.get("SELECT name FROM exams WHERE id = ?", ses.examId) as { name: string } | undefined;
      const cropCount = await db.get(
        "SELECT student_count AS cnt FROM review_assignments WHERE exam_id = ? AND block_id = ? AND teacher_id = ?",
        ses.examId, ses.blockId, userId
      ) as { cnt: number } | undefined;

      data.hasUnfinishedGrading = true;
      data.unfinishedTask = {
        examId: ses.examId,
        examName: exam?.name ?? "",
        blockTitle: ses.blockId,
        progress: { done: ses.currentIndex, total: cropCount?.cnt ?? 0 }
      };
    }

    // 2. 最新扫描考试（优先有切块的，fallback 到最新创建的考试）
    const latestExam = await db.get(
      `SELECT e.id, e.name, e.subject, MAX(abc.created_at) AS scanned_at
       FROM exams e
       JOIN answer_block_crops abc ON abc.exam_id = e.id
       WHERE 1=1 ${scopeSql}
       GROUP BY e.id
       ORDER BY scanned_at DESC
       LIMIT 1`,
      ...scopeParams
    ) as { id: number; name: string; subject: string | null; scanned_at: string } | undefined;

    if (latestExam) {
      data.latestScanExam = {
        examId: latestExam.id, examName: latestExam.name,
        subject: latestExam.subject ?? "", scannedAt: latestExam.scanned_at
      };
    } else {
      // fallback: 最新创建的考试
      const fallback = await db.get(
        `SELECT id, name, subject, created_at FROM exams WHERE 1=1 ${scopeSql} ORDER BY created_at DESC LIMIT 1`,
        ...scopeParams
      ) as { id: number; name: string; subject: string | null; created_at: string } | undefined;
      if (fallback) {
        data.latestScanExam = {
          examId: fallback.id, examName: fallback.name,
          subject: fallback.subject ?? "", scannedAt: fallback.created_at
        };
      }
    }

    // 3. 统计数据
    const stats = await db.get(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN e.status IN ('active', 'grading') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN e.status = 'closed' THEN 1 ELSE 0 END) AS completed
       FROM exams e
       WHERE 1=1 ${scopeSql}`,
      ...scopeParams
    ) as { total: number; active: number; completed: number } | undefined;
    if (stats) {
      data.stats = { totalExams: stats.total, activeGradingExams: stats.active, completedExams: stats.completed };
    }

    res.json({ ok: true, data });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
