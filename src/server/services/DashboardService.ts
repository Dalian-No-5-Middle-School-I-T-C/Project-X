/**
 * 首页仪表盘数据聚合（从 /api/dashboard 路由抽取，便于单元测试）。
 * 最新出分口径：status='closed' 且 closed_at 非空，按 closed_at 倒序取 1 条。
 */
import type express from "express";
import { getMysqlDb, type DbAdapter } from "../db";
import { getUnfinishedSessions } from "./ReviewSessionService";
import { getVisibleExamIds } from "../../apps/answer-card/server/middleware";
import type { DashboardData } from "../../shared/types";

export async function getDashboardData(
  user: express.Request["user"],
  db: DbAdapter = getMysqlDb()
): Promise<DashboardData> {
  const userId = user?.id;
  if (!userId) throw new Error("未登录");

  // 教师按可见范围过滤统计与最新考试，避免学科老师/班主任看到全校数据
  // 可见范围查询使用全局数据库适配器（与历史行为一致）；如需注入测试库，后续再给 getVisibleExamIds 增加可选 db 参数。
  const visibleExamIds = await getVisibleExamIds(user);
  const scopeSql = visibleExamIds == null
    ? ""
    : visibleExamIds.length === 0
      ? " AND 0"
      : ` AND e.id IN (${visibleExamIds.map(() => "?").join(",")})`;
  const scopeParams: number[] = visibleExamIds ?? [];

  // 科任老师：额外限定本人所教学科（或本人创建的考试），晨测（quiz）全量可见下也保持科目口径
  let subjectFilter = "";
  let subjectParams: (string | number)[] = [];
  if (user?.teacher_role === "subject_teacher" && user.subject) {
    subjectFilter = " AND (e.subject = ? OR e.created_by = ?)";
    subjectParams = [user.subject, user.id];
  }

  const data: DashboardData = {
    hasUnfinishedGrading: false,
    unfinishedTask: null,
    latestScanExam: null,
    latestReleasedExam: null,
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
     WHERE 1=1 ${scopeSql}${subjectFilter}
     GROUP BY e.id
     ORDER BY scanned_at DESC
     LIMIT 1`,
    ...scopeParams,
    ...subjectParams
  ) as { id: number; name: string; subject: string | null; scanned_at: string } | undefined;

  if (latestExam) {
    data.latestScanExam = {
      examId: latestExam.id, examName: latestExam.name,
      subject: latestExam.subject ?? "", scannedAt: latestExam.scanned_at
    };
  } else {
    const fallback = await db.get(
      `SELECT e.id, e.name, e.subject, e.created_at FROM exams e WHERE 1=1 ${scopeSql}${subjectFilter} ORDER BY e.created_at DESC LIMIT 1`,
      ...scopeParams,
      ...subjectParams
    ) as { id: number; name: string; subject: string | null; created_at: string } | undefined;
    if (fallback) {
      data.latestScanExam = {
        examId: fallback.id, examName: fallback.name,
        subject: fallback.subject ?? "", scannedAt: fallback.created_at
      };
    }
  }

  // 2.5 最新出分：最近 closed 的考试
  const released = await db.get(
    `SELECT e.id, e.name, e.subject, e.closed_at AS released_at
     FROM exams e
     WHERE e.status = 'closed' AND e.closed_at IS NOT NULL ${scopeSql}${subjectFilter}
     ORDER BY e.closed_at DESC, e.id DESC
     LIMIT 1`,
    ...scopeParams, ...subjectParams
  ) as { id: number; name: string; subject: string | null; released_at: string } | undefined;
  if (released) {
    data.latestReleasedExam = {
      examId: released.id, examName: released.name,
      subject: released.subject ?? "", releasedAt: released.released_at
    };
  }

  // 3. 统计数据
  const stats = await db.get(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN e.status IN ('active', 'grading') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN e.status = 'closed' THEN 1 ELSE 0 END) AS completed
     FROM exams e
     WHERE 1=1 ${scopeSql}${subjectFilter}`,
    ...scopeParams,
    ...subjectParams
  ) as { total: number; active: number; completed: number } | undefined;
  if (stats) {
    data.stats = { totalExams: stats.total, activeGradingExams: stats.active, completedExams: stats.completed };
  }

  return data;
}
