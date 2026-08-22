/**
 * 成绩天梯 API —— 仅返回年级前十名，不展示段位/分层
 *
 * GET /api/ladder/exams/:examId        单场考试
 * GET /api/ladder/exam-groups/:groupId  大考组
 * GET /api/ladder/cross-exam           跨考累计
 *
 * GET  /api/ladder/config              获取天梯开关状态
 * PUT  /api/ladder/config              管理员设置天梯开关
 */
import express from "express";
import type { Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getMysqlDb } from "../db";
import { AnalysisRepository } from "../repositories/AnalysisRepository";
import { LadderService } from "../services/LadderService";
import { competitionRank } from "../../shared/ranking";
import { requireExamAccess, getVisibleExamIds, validateExamIdsAccess, GROUP_MEMBER_NOT_SOFT_DELETED_SQL } from "../../apps/answer-card/server/middleware";
import type { LadderResponse } from "../../shared/types";

const router = express.Router();
router.use(authMiddleware);

// ── 天梯开关 ──

async function isLadderEnabled(): Promise<boolean> {
  const db = getMysqlDb();
  const row = await db.get<{ value: string }>("SELECT value FROM system_settings WHERE `key` = ?", "ladder_enabled");
  return row ? row.value === "1" : true;
}

/** 检查天梯是否开放，管理员始终可以预览 */
async function checkLadderOpen(req: Request, res: Response): Promise<boolean> {
  if (await isLadderEnabled()) return true;
  if (req.user?.role_name === "admin") return true;
  res.status(403).json({ message: "成绩天梯暂未开放" });
  return false;
}

/**
 * PR #256（v41）：成绩公布前学生不可经天梯取分（教师端查分不受公布限制）。
 * 返回 true=放行；false=已写 403 响应。
 */
export async function checkLadderPublished(req: Request, res: Response, examIds: number[]): Promise<boolean> {
  // 教师/管理员不受公布限制（管理员与天梯开关的预览语义一致）
  if (req.user && (req.user.role_name === "teacher" || req.user.role_name === "admin")) return true;
  const analysisRepo = new AnalysisRepository();
  const published = await analysisRepo.filterPublishedExamIds(examIds);
  if (published.length === examIds.length) return true;
  res.status(403).json({ message: "所选考试中存在尚未公布成绩的考试" });
  return false;
}

// ── GET /api/ladder/config ──

router.get("/config", async (_req: Request, res: Response) => {
  res.json({ enabled: await isLadderEnabled() });
});

// ── PUT /api/ladder/config (admin only) ──

router.put("/config", async (req: Request, res: Response) => {
  if (req.user!.role_name !== "admin") {
    res.status(403).json({ message: "仅管理员可修改天梯开关" });
    return;
  }

  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    res.status(400).json({ message: "缺少 enabled 字段 (boolean)" });
    return;
  }

  const db = getMysqlDb();
  await db.run("REPLACE INTO system_settings (`key`, value) VALUES (?, ?)", "ladder_enabled", enabled ? "1" : "0");

  res.json({ enabled });
});

// ── GET /api/ladder/exams/:examId ──

router.get("/exams/:examId", requireExamAccess, async (req: Request, res: Response) => {
  if (!(await checkLadderOpen(req, res))) return;
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId)) {
      res.status(400).json({ message: "无效的考试 ID" });
      return;
    }
    // PR #256：成绩公布前学生不可经单场天梯取分
    if (!(await checkLadderPublished(req, res, [examId]))) return;

    const analysisRepo = new AnalysisRepository();
    const scoreTable = await analysisRepo.getScoreTableData(examId, undefined, "percentile");

    if (!scoreTable || scoreTable.rows.length === 0) {
      const resp: LadderResponse = {
        scope: "single",
        scopeName: scoreTable?.examName ?? "",
        studentCount: 0,
        myRank: null,
        myScore: null,
        rows: [],
      };
      res.json(resp);
      return;
    }

    const { top10, myRank, myScore } = LadderService.fromScoreTableRows(
      scoreTable.rows,
      scoreTable.totalCount,
      req.user!.id,
    );

    const resp: LadderResponse = {
      scope: "single",
      scopeName: scoreTable.examName,
      studentCount: scoreTable.totalCount,
      myRank,
      myScore,
      rows: top10,
    };
    res.json(resp);
  } catch (err: any) {
    console.error("ladder exams error:", err);
    res.status(500).json({ message: err.message || "获取天梯数据失败" });
  }
});

// ── GET /api/ladder/exam-groups/:groupId ──

router.get("/exam-groups/:groupId", async (req: Request, res: Response) => {
  if (!(await checkLadderOpen(req, res))) return;
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    if (!Number.isFinite(groupId)) {
      res.status(400).json({ message: "无效的考试组 ID" });
      return;
    }

    const group = await db.get<{ name: string; total_score_mode: string }>(
      `SELECT name, total_score_mode FROM exam_groups WHERE id = ?`,
      groupId,
    );
    if (!group) {
      res.status(404).json({ message: "大考不存在" });
      return;
    }

    // #246：软删除成员与统计口径一致地排除——清理任务不删组成员关系，
    // 不过滤会使教师侧 validateExamIdsAccess 对整组 403、学生侧聚合已删考试成绩
    const members = await db.all<{ exam_id: number; subject: string | null }>(
      `SELECT egm.exam_id, e.subject
         FROM exam_group_members egm
         JOIN exams e ON e.id = egm.exam_id
         WHERE egm.group_id = ? AND ${GROUP_MEMBER_NOT_SOFT_DELETED_SQL}
         ORDER BY egm.sort_order, egm.id`,
      groupId,
    );

    if (members.length === 0) {
      const resp: LadderResponse = {
        scope: "group",
        scopeName: group.name,
        studentCount: 0,
        myRank: null,
        myScore: null,
        rows: [],
      };
      res.json(resp);
      return;
    }

    const memberIds = members.map((m) => m.exam_id);
    if (!(await validateExamIdsAccess(req, res, memberIds))) return;
    // PR #256：组内任一成员考试未公布，学生不可经组天梯取分（教师端不受限）
    if (!(await checkLadderPublished(req, res, memberIds))) return;

    const allScores = await db.all<{
      student_id: number;
      exam_id: number;
      total_score: number;
      assigned_score: number | null;
      student_number: string;
      name: string;
      class_name: string | null;
      class_id: number | null;
      grade_name: string | null;
    }>(
      `SELECT ss.student_id, ss.exam_id, ss.total_score, ss.assigned_score,
                u.student_number, u.name,
                c.name as class_name, c.id as class_id,
                g.name as grade_name
         FROM student_scores ss
         JOIN users u ON u.id = ss.student_id
         LEFT JOIN class_students cs ON cs.student_id = ss.student_id
         LEFT JOIN classes c ON c.id = cs.class_id
         LEFT JOIN grades g ON g.id = c.grade_id
         WHERE ss.exam_id IN (${memberIds.map(() => "?").join(",")})`,
      ...memberIds,
    );

    const studentMap = new Map<
      number,
      {
        studentId: number;
        studentNumber: string;
        studentName: string;
        className: string;
        classId: number | null;
        gradeName: string | null;
        totalRaw: number;
        totalAssigned: number;
        subjectCount: number;
        subjects: Array<{
          examId: number;
          examName: string;
          subject: string;
          score: number;
          rank: number;
        }>;
      }
    >();

    for (const s of allScores) {
      let entry = studentMap.get(s.student_id);
      if (!entry) {
        entry = {
          studentId: s.student_id,
          studentNumber: s.student_number,
          studentName: s.name,
          className: s.class_name || "未知班级",
          classId: s.class_id,
          gradeName: s.grade_name || null,
          totalRaw: 0,
          totalAssigned: 0,
          subjectCount: 0,
          subjects: [],
        };
        studentMap.set(s.student_id, entry);
      }
      const member = members.find((m) => m.exam_id === s.exam_id);
      const subjectName = member?.subject || `科目${s.exam_id}`;
      entry.totalRaw += s.total_score;
      entry.totalAssigned += s.assigned_score ?? s.total_score;
      entry.subjectCount++;
      entry.subjects.push({
        examId: s.exam_id,
        examName: subjectName,
        subject: subjectName,
        score: s.assigned_score ?? s.total_score,
        rank: 0,
      });
    }

    const rows = Array.from(studentMap.values());
    const sortScore = (r: typeof rows[0]) => r.totalAssigned;
    rows.sort((a, b) => sortScore(b) - sortScore(a));
    competitionRank(rows, sortScore, (r: any, rank: number) => {
      r._gradeRank = rank;
    });

    const classGroups2 = new Map<string, any[]>();
    for (const r of rows) {
      const key = r.className === "未知班级" ? "__unassigned__" : r.className;
      if (!classGroups2.has(key)) classGroups2.set(key, []);
      classGroups2.get(key)!.push(r);
    }
    for (const cg of classGroups2.values()) {
      competitionRank(cg, sortScore, (r: any, rank: number) => {
        r._classRank = rank;
      });
    }

    const totalCount = rows.length;
    const top10 = rows.slice(0, 10).map((r) => ({
      rank: (r as any)._gradeRank as number,
      studentId: r.studentId,
      studentNumber: r.studentNumber,
      studentName: r.studentName,
      className: r.className,
      classId: r.classId,
      gradeName: r.gradeName,
      totalScore: r.totalAssigned,
      assignedScore: r.totalAssigned,
      classRank: (r as any)._classRank as number,
      rankTrend: "new" as const,
      rankChange: null,
      prevRank: null,
      percentile: LadderService.percentile((r as any)._gradeRank as number, totalCount),
      subjectScores: r.subjects,
    }));

    const my = rows.find((r) => r.studentId === req.user!.id);
    const myRank = my ? ((my as any)._gradeRank as number) : null;
    const myScore = my ? my.totalAssigned : null;

    const resp: LadderResponse = {
      scope: "group",
      scopeName: group.name,
      studentCount: totalCount,
      myRank,
      myScore,
      rows: top10,
    };
    res.json(resp);
  } catch (err: any) {
    console.error("ladder exam-groups error:", err);
    res.status(500).json({ message: err.message || "获取大考天梯数据失败" });
  }
});

// ── GET /api/ladder/cross-exam ──

router.get("/cross-exam", async (req: Request, res: Response) => {
  if (!(await checkLadderOpen(req, res))) return;
  try {
    const { mode, examIds, groupId, startDate, endDate } = req.query;

    const request: any = { mode: mode || "week" };
    if (mode === "selected" && examIds) {
      request.examIds = String(examIds)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
    }
    if (mode === "group" && groupId) {
      request.groupId = Number(groupId);
    }
    if (startDate) request.startDate = String(startDate);
    if (endDate) request.endDate = String(endDate);

    const analysisRepo = new AnalysisRepository();
    let requestedExamIds: number[] = [];
    if (request.mode === "selected") {
      requestedExamIds = request.examIds ?? [];
      if (requestedExamIds.length === 0) {
        res.status(400).json({ message: "请选择至少一场考试" });
        return;
      }
    } else if (request.mode === "group" && request.groupId) {
      const group = await analysisRepo.getExamGroup(request.groupId);
      if (!group) {
        res.status(404).json({ message: "考试组不存在" });
        return;
      }
      requestedExamIds = group.examIds;
    }
    if (requestedExamIds.length > 0 && !(await validateExamIdsAccess(req, res, requestedExamIds))) return;

    // PR #256：学生端跨考天梯仅聚合已公布考试（教师/管理员不受限）
    const crossExamData = await analysisRepo.getCrossExamTotal(request, {
      visibleExamIds: await getVisibleExamIds(req.user),
      onlyPublished: !(req.user && (req.user.role_name === "teacher" || req.user.role_name === "admin")),
    });

    if (!crossExamData || crossExamData.rows.length === 0) {
      const resp: LadderResponse = {
        scope: "cross",
        scopeName: "跨考累计",
        studentCount: 0,
        myRank: null,
        myScore: null,
        rows: [],
      };
      res.json(resp);
      return;
    }

    const { top10, myRank, myScore } = LadderService.fromCrossExamRows(
      crossExamData.rows,
      crossExamData.rows.length,
      req.user!.id,
    );

    const resp: LadderResponse = {
      scope: "cross",
      scopeName: "跨考累计",
      studentCount: crossExamData.rows.length,
      myRank,
      myScore,
      rows: top10,
    };
    res.json(resp);
  } catch (err: any) {
    console.error("ladder cross-exam error:", err);
    res.status(500).json({ message: err.message || "获取跨考天梯数据失败" });
  }
});

export default router;
