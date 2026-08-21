import express from "express";
import type { NextFunction, Request, Response } from "express";
import { getMysqlDb } from "../db";
import { ZipArchive } from "archiver";
import XLSX from "xlsx";
import { competitionRank } from "../../shared/ranking";
import { AnalysisRepository } from "../repositories/AnalysisRepository";
import { createAiAnalysisJob, enqueueAiAnalysisJob } from "../services/aiAnalysisJobs";
import type { AiJobCreateResponse } from "../../shared/types";
import {
  getAiProviderForUser,
  memberMatchesTrack,
  normalizeTrackFilter,
  requireReadableGroup,
} from "./exam-groups-helpers";

const router = express.Router({ mergeParams: true });
// ── GET /api/exam-groups/:groupId/overview ── group overview ──

router.get("/overview", requireReadableGroup, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const track = normalizeTrackFilter(req.query.track);

    const group = await db.get("SELECT name FROM exam_groups WHERE id = ?", groupId) as { name: string } | undefined;
    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }

    // 评审修复（PR #212）：逐科统计必须与参与人数同口径——按 users.track 过滤学生
    const trackStudentClause = track === "all" ? "" : "AND u.track = ?";
    const memberParams: unknown[] = [groupId];
    if (track !== "all") memberParams.push(track);
    const members = await db.all(`
      SELECT e.id as exam_id, e.name as exam_name, e.subject,
             e.assigned_formula,
             egm.track_type,
             COUNT(ss.exam_id) as graded_count,
             ROUND(AVG(ss.total_score), 1) as avg_score,
             ROUND(MAX(ss.total_score), 1) as max_score,
             ROUND(MIN(ss.total_score), 1) as min_score
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      LEFT JOIN users u ON u.id = ss.student_id
      WHERE egm.group_id = ? ${trackStudentClause}
      GROUP BY e.id
      ORDER BY egm.sort_order, egm.id
    `, ...memberParams) as any[];
    const trackMembers = track === "all"
      ? members
      : members.filter((m) => memberMatchesTrack(m.track_type, track));

    // N+1 收敛：满分一次批量取；每科 std + 及格/优秀 合并为 1 条聚合（原各科 3 条 → 1 条）
    const memberExamIds = trackMembers.map((m) => m.exam_id);
    let fullByExam = new Map<number, number>();
    if (memberExamIds.length > 0) {
      const fullRows = await db.all(
        `SELECT exam_id, SUM(max_score) AS total FROM (
           SELECT exam_id, question_number, score_type, MAX(max_score) AS max_score
           FROM question_scores WHERE exam_id IN (${memberExamIds.map(() => "?").join(",")})
           GROUP BY exam_id, question_number, score_type
         ) GROUP BY exam_id`,
        ...memberExamIds
      ) as Array<{ exam_id: number; total: number | null }>;
      fullByExam = new Map(fullRows.map((r) => [Number(r.exam_id), r.total ?? 100]));
    }

    const subjects = [];
    for (const m of trackMembers) {
      const fullScore = fullByExam.get(m.exam_id) ?? 100;
      const passLine = fullScore * 0.6;
      const excellentLine = fullScore * 0.9;
      const statRow = await db.get(`
        SELECT
          ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as std,
          SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as pass_count,
          SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as excellent_count
        FROM student_scores ss
        JOIN users u ON u.id = ss.student_id
        WHERE ss.exam_id = ? ${trackStudentClause}
      `, m.avg_score, m.avg_score, passLine, excellentLine, m.exam_id, ...(track !== "all" ? [track] : [])) as { std: number | null; pass_count: number | null; excellent_count: number | null } | undefined;

      subjects.push({
        examId: m.exam_id,
        examName: m.exam_name,
        subject: m.subject || "",
        gradedCount: m.graded_count,
        avgScore: m.avg_score || 0,
        maxScore: m.max_score || 0,
        minScore: m.min_score || 0,
        stdDev: statRow?.std ?? 0,
        passRate: m.graded_count > 0 ? Math.round((statRow?.pass_count || 0) / m.graded_count * 100) : 0,
        excellentRate: m.graded_count > 0 ? Math.round((statRow?.excellent_count || 0) / m.graded_count * 100) : 0,
        fullScore,
        hasAssignedScore: !!(m.assigned_formula && m.assigned_formula !== ""),
        trackType: m.track_type || "common"
      });
    }

    // Total participants（按文理筛选学生）
    const totalParams: unknown[] = [groupId];
    if (track !== "all") totalParams.push(track);
    const totalRow = await db.get(`
      SELECT COUNT(DISTINCT s.student_id) as cnt FROM (
        SELECT ss.student_id FROM exam_group_members egm
        JOIN student_scores ss ON ss.exam_id = egm.exam_id
        JOIN users u ON u.id = ss.student_id
        WHERE egm.group_id = ? ${trackStudentClause}
      ) s
    `, ...totalParams) as { cnt: number };

    const fullParams: unknown[] = [groupId];
    let memberCountClause = "(SELECT COUNT(*) FROM exam_group_members WHERE group_id = ?)";
    if (track !== "all") {
      memberCountClause = "(SELECT COUNT(*) FROM exam_group_members WHERE group_id = ? AND (track_type = 'common' OR track_type = ?))";
      fullParams.push(track);
    }
    const fullRow = await db.get(`
      SELECT COUNT(*) as cnt FROM (
        SELECT ss.student_id, COUNT(DISTINCT egm.exam_id) as exam_count
        FROM exam_group_members egm
        JOIN student_scores ss ON ss.exam_id = egm.exam_id
        JOIN users u ON u.id = ss.student_id
        WHERE egm.group_id = ? ${trackStudentClause}
        GROUP BY ss.student_id
        HAVING exam_count = ${memberCountClause}
      )
    `, ...fullParams, ...fullParams.slice(0)) as { cnt: number } | undefined;

    res.json({
      groupId, groupName: group.name,
      track,
      totalParticipants: totalRow.cnt,
      fullParticipants: fullRow?.cnt ?? 0,
      subjects
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "获取大考概览失败" });
  }
});

// ── GET /api/exam-groups/:groupId/metrics ── 大考整体+逐科难度/区分度 ──

router.get("/metrics", requireReadableGroup, async (req: Request, res: Response) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const metrics = await analysisRepo.getGroupMetrics(Number(req.params.groupId), normalizeTrackFilter(req.query.track));
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "获取大考指标失败" });
  }
});

// ── GET /api/exam-groups/:groupId/question-analysis ── 大考逐题分析 ──

router.get("/question-analysis", requireReadableGroup, async (req: Request, res: Response) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const data = await analysisRepo.getGroupQuestionAnalysis(Number(req.params.groupId), normalizeTrackFilter(req.query.track));
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "获取大考逐题分析失败" });
  }
});

// ── GET /api/exam-groups/:groupId/distribution ── 大考总体分析分布 ──

router.get("/distribution", requireReadableGroup, async (req: Request, res: Response) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const mode = (req.query.mode as string) === "total" ? "total" : (req.query.mode as string) === "class" ? "class" : "subject";
    const dist = await analysisRepo.getGroupDistribution(Number(req.params.groupId), mode, normalizeTrackFilter(req.query.track));
    res.json(dist);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "获取大考分布失败" });
  }
});

// ── GET /api/exam-groups/:groupId/class-comparison ── 大考班级对比 ──

router.get("/class-comparison", requireReadableGroup, async (req: Request, res: Response) => {
  try {
    const analysisRepo = new AnalysisRepository();
    const data = await analysisRepo.getGroupClassComparison(Number(req.params.groupId), normalizeTrackFilter(req.query.track));
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "获取大考班级对比失败" });
  }
});

// ── POST /api/exam-groups/:groupId/ai-analysis ── 大考 AI 分析 ──

router.post("/ai-analysis", requireReadableGroup, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groupId = Number(req.params.groupId);
    if (!Number.isFinite(groupId) || groupId <= 0) {
      res.status(400).json({ message: "无效的大考 ID" });
      return;
    }
    const providerId = req.body?.providerId ? Number(req.body.providerId) : undefined;
    let providerOverride: Record<string, unknown> | undefined;
    if (providerId && Number.isFinite(providerId)) {
      const prov = await getAiProviderForUser(providerId, req.user!.id);
      if (prov) {
        providerOverride = { provider_type: prov.provider_type, base_url: prov.base_url, api_key: prov.api_key };
      }
    }
    // 建议 5：先建任务立即返回 jobId，后台串行队列执行
    const jobId = await createAiAnalysisJob({
      groupId,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      providerOverride,
      createdBy: req.user?.id ?? null,
    });
    enqueueAiAnalysisJob(jobId, {
      groupId,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      providerOverride,
    }).catch((err) => console.error(`[AiJob] #${jobId} failed:`, err));
    res.status(202).json({ jobId, status: "queued" } satisfies AiJobCreateResponse);
  } catch (error) {
    next(error);
  }
});

// ── GET /api/exam-groups/:groupId/rankings ── group rankings ──

router.get("/rankings", requireReadableGroup, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const fullOnly = req.query.fullOnly === "1";
    const track = normalizeTrackFilter(req.query.track);

    const group = await db.get(`
      SELECT name, total_score_mode, only_full_participants
      FROM exam_groups WHERE id = ?
    `, groupId) as { name: string; total_score_mode: string; only_full_participants: number } | undefined;
    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }

    const members = await db.all(`
      SELECT egm.exam_id, e.subject, e.assigned_formula, egm.sort_order, egm.track_type
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      WHERE egm.group_id = ?
      ORDER BY egm.sort_order, egm.id
    `, groupId) as Array<{ exam_id: number; subject: string | null; assigned_formula: string | null; sort_order: number; track_type: string | null }>;

    if (members.length === 0) {
      res.json({ groupId, groupName: group.name, totalStudents: 0, displayColumns: [], rows: [] });
      return;
    }
    const trackMembers = track === "all"
      ? members
      : members.filter((m) => memberMatchesTrack(m.track_type, track));
    if (trackMembers.length === 0) {
      res.json({ groupId, groupName: group.name, totalStudents: 0, displayColumns: [], rows: [] });
      return;
    }

    const useAssigned = fullOnly ? group.only_full_participants : false;
    const memberIds = trackMembers.map((m) => m.exam_id);

    // Get all scores for all member exams（按文理过滤学生）
    const trackStudentClause = track === "all" ? "" : "AND u.track = ?";
    const allScoreParams: unknown[] = [...memberIds];
    if (track !== "all") allScoreParams.push(track);
    const allScores = await db.all(`
      SELECT
        ss.student_id, ss.exam_id, ss.total_score, ss.assigned_score,
        ss.objective_score, ss.subjective_score,
        u.student_number, u.name, u.track,
        c.name as class_name, c.id as class_id,
        g.name as grade_name
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      LEFT JOIN class_students cs ON cs.student_id = ss.student_id
      LEFT JOIN classes c ON c.id = cs.class_id
      LEFT JOIN grades g ON g.id = c.grade_id
      WHERE ss.exam_id IN (${memberIds.map(() => "?").join(",")}) ${trackStudentClause}
    `, ...allScoreParams) as Array<{
      student_id: number; exam_id: number; total_score: number; assigned_score: number | null;
      objective_score: number; subjective_score: number;
      student_number: string; name: string; track: string | null;
      class_name: string | null; class_id: number | null; grade_name: string | null;
    }>;

    // Build per-student map
    const studentMap = new Map<number, {
      studentId: number; studentNumber: string; studentName: string;
      className: string; classId: number | null; gradeName: string | null;
      scores: Map<number, { totalScore: number; assignedScore: number | null; objectiveScore: number; subjectiveScore: number }>;
    }>();

    for (const s of allScores) {
      if (!studentMap.has(s.student_id)) {
        studentMap.set(s.student_id, {
          studentId: s.student_id, studentNumber: s.student_number,
          studentName: s.name, className: s.class_name || "未知班级",
          classId: s.class_id, gradeName: s.grade_name || null,
          scores: new Map()
        });
      }
      studentMap.get(s.student_id)!.scores.set(s.exam_id, {
        totalScore: s.total_score,
        assignedScore: s.assigned_score,
        objectiveScore: s.objective_score,
        subjectiveScore: s.subjective_score
      });
    }

    // Get rankings per exam for grade and class rank
    const examRanks: Record<number, Map<number, { gradeRank: number; classRank: number }>> = {};
    for (const examId of memberIds) {
      const rankParams: unknown[] = [examId];
      if (track !== "all") rankParams.push(track);
      const rankRows = await db.all(`
        SELECT ss.student_id, ss.total_score, c.name as class_name, c.id as class_id
        FROM student_scores ss
        JOIN users u ON u.id = ss.student_id
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id = ? ${trackStudentClause}
        ORDER BY ss.total_score DESC
      `, ...rankParams) as Array<{ student_id: number; total_score: number; class_name: string | null; class_id: number | null }>;

      const rankMap = new Map<number, { gradeRank: number; classRank: number }>();
      examRanks[examId] = rankMap;

      // Grade rank — dense ranking
      competitionRank(rankRows, (r) => r.total_score, (r, rank) => {
        rankMap.set(r.student_id, { gradeRank: rank, classRank: 0 });
      });

      // Class rank by group — dense ranking within each class
      const classGroups = new Map<string, Array<{ student_id: number; total_score: number }>>();
      for (const r of rankRows) {
        const key = r.class_name || "__unassigned__";
        if (!classGroups.has(key)) classGroups.set(key, []);
        classGroups.get(key)!.push({ student_id: r.student_id, total_score: r.total_score });
      }
      for (const cg of classGroups.values()) {
        competitionRank(cg, (r) => r.total_score, (r, rank) => {
          const entry = rankMap.get(r.student_id);
          if (entry) entry.classRank = rank;
        });
      }
    }

    // Build ranking rows
    const rows: Array<{
      studentId: number; studentNumber: string; studentName: string;
      className: string; classId: number | null; gradeName: string | null;
      totalRawScore: number; totalAssignedScore: number;
      subjectCount: number; isFullParticipant: boolean;
      subjects: Array<{
        examId: number; subject: string;
        totalScore: number; assignedScore: number | null;
        gradeRank: number; classRank: number;
        objectiveScore: number; subjectiveScore: number;
      }>;
    }> = [];

    for (const [, student] of studentMap) {
      const subjects = trackMembers.map((m) => {
        const s = student.scores.get(m.exam_id);
        const ranks = examRanks[m.exam_id]?.get(student.studentId);
        return {
          examId: m.exam_id,
          subject: m.subject || "",
          totalScore: s?.totalScore ?? 0,
          assignedScore: s?.assignedScore ?? null,
          gradeRank: ranks?.gradeRank ?? 0,
          classRank: ranks?.classRank ?? 0,
          objectiveScore: s?.objectiveScore ?? 0,
          subjectiveScore: s?.subjectiveScore ?? 0
        };
      });

      const isFull = student.scores.size >= trackMembers.length;

      if (fullOnly && !isFull) continue;

      const totalRaw = subjects.reduce((sum, sub) => sum + sub.totalScore, 0);
      const totalAssigned = subjects.reduce((sum, sub) => sum + (sub.assignedScore ?? sub.totalScore), 0);

      rows.push({
        studentId: student.studentId,
        studentNumber: student.studentNumber,
        studentName: student.studentName,
        className: student.className,
        classId: student.classId,
        gradeName: student.gradeName,
        totalRawScore: totalRaw,
        totalAssignedScore: totalAssigned,
        subjectCount: student.scores.size,
        isFullParticipant: isFull,
        subjects
      });
    }

    // Sort by total score DESC
    const sortScore = useAssigned ? (r: typeof rows[0]) => r.totalAssignedScore : (r: typeof rows[0]) => r.totalRawScore;
    rows.sort((a, b) => sortScore(b) - sortScore(a));

    // Grade rank — dense ranking
    competitionRank(rows, sortScore, (r: any, rank: number) => { r.totalGradeRank = rank; });

    // Class rank
    const classGroups2 = new Map<string, any[]>();
    for (const r of rows) {
      const key = r.className === "未知班级" ? "__unassigned__" : r.className;
      if (!classGroups2.has(key)) classGroups2.set(key, []);
      classGroups2.get(key)!.push(r);
    }
    for (const cg of classGroups2.values()) {
      competitionRank(cg, sortScore, (r: any, rank: number) => { r.totalClassRank = rank; });
    }

    // Filter by class
    let filtered = rows;
    if (classId !== undefined) {
      if (classId === 0) {
        filtered = rows.filter((r) => r.classId == null);
      } else {
        filtered = rows.filter((r) => r.classId === classId);
      }
    }

    const displayColumns = trackMembers.map((m) => m.subject || `科目${m.exam_id}`);

    res.json({
      groupId, groupName: group.name,
      totalStudents: filtered.length,
      displayColumns,
      rows: filtered
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "获取大考排名失败" });
  }
});

// ── POST /api/exam-groups/:groupId/export ── export ZIP ──

router.post("/export", requireReadableGroup, async (req: Request, res: Response) => {
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    const { includeOverview = true, subjectExamIds = [], includeObjectiveSub = true, includeSubjectiveSub = true }
      = req.body as {
        includeOverview?: boolean; subjectExamIds?: number[];
        includeObjectiveSub?: boolean; includeSubjectiveSub?: boolean;
      };

    const group = await db.get(`
      SELECT eg.name, eg.total_score_mode
      FROM exam_groups eg WHERE eg.id = ?
    `, groupId) as { name: string; total_score_mode: string } | undefined;
    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }

    const members = await db.all(`
      SELECT egm.exam_id, e.name as exam_name, e.subject as subject, egm.sort_order
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      WHERE egm.group_id = ?
      ORDER BY egm.sort_order, egm.id
    `, groupId) as Array<{ exam_id: number; exam_name: string; subject: string | null; sort_order: number }>;

    if (members.length === 0) {
      res.status(400).json({ message: "大考中没有关联考试" });
      return;
    }

    // Set headers for ZIP
    const safeName = group.name.replace(/[\\/:*?"<>|]/g, "_");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}_导出.zip`)}`);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.pipe(res);

    // ── 1. Overview sheet ──
    if (includeOverview) {
      const memberIds = members.map((m) => m.exam_id);
      const allScores = await db.all(`
        SELECT
          ss.student_id, ss.exam_id, ss.total_score, ss.assigned_score,
          u.student_number, u.name,
          c.name as class_name
        FROM student_scores ss
        JOIN users u ON u.id = ss.student_id
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id IN (${memberIds.map(() => "?").join(",")})
      `, ...memberIds) as Array<{
        student_id: number; exam_id: number; total_score: number; assigned_score: number | null;
        student_number: string; name: string; class_name: string | null;
      }>;

      // Build student map
      const stuMap = new Map<number, { number: string; name: string; className: string; exams: Map<number, { raw: number; assigned: number | null }> }>();
      for (const s of allScores) {
        if (!stuMap.has(s.student_id)) {
          stuMap.set(s.student_id, {
            number: s.student_number, name: s.name,
            className: s.class_name || "未知班级", exams: new Map()
          });
        }
        stuMap.get(s.student_id)!.exams.set(s.exam_id, { raw: s.total_score, assigned: s.assigned_score });
      }

      // Build overview rows
      const overviewHeaders = ["班级", "姓名", "总分", "总分年排", "总分班排"];
      for (const m of members) {
        const sub = m.subject || `科目${m.exam_id}`;
        overviewHeaders.push(`${sub}原始分`, `${sub}年排`, `${sub}班排`);
      }

      const overviewRows: Record<string, string | number>[] = [];
      for (const [, stu] of stuMap) {
        let totalRaw = 0;
        for (const m of members) {
          const score = stu.exams.get(m.exam_id);
          totalRaw += score?.raw ?? 0;
        }

        const row: Record<string, string | number> = {
          "班级": stu.className, "姓名": stu.name, "总分": totalRaw
        };
        for (const m of members) {
          const score = stu.exams.get(m.exam_id);
          const sub = m.subject || `科目${m.exam_id}`;
          row[`${sub}原始分`] = score?.raw ?? "";
          row[`${sub}年排`] = "";
          row[`${sub}班排`] = "";
        }
        overviewRows.push(row);
      }

      // Sort by total descending
      overviewRows.sort((a, b) => (b["总分"] as number) - (a["总分"] as number));

      // Fill ranks — dense ranking
      competitionRank(overviewRows, (r) => r["总分"] as number, (r, rank) => { r["总分年排"] = rank; });
      const cgMap = new Map<string, typeof overviewRows>();
      for (const r of overviewRows) {
        const key = r["班级"] as string;
        if (!cgMap.has(key)) cgMap.set(key, []);
        cgMap.get(key)!.push(r);
      }
      for (const cg of cgMap.values()) {
        competitionRank(cg, (r) => r["总分"] as number, (r, rank) => { r["总分班排"] = rank; });
      }

      // Fill per-subject ranks
      for (const m of members) {
        const sub = m.subject || `科目${m.exam_id}`;
        const rawKey = `${sub}原始分`;
        const grKey = `${sub}年排`;
        const crKey = `${sub}班排`;

        const sorted = [...overviewRows].sort((a, b) => (b[rawKey] as number || 0) - (a[rawKey] as number || 0));
        const withScore = sorted.filter((r) => r[rawKey] !== "");
        competitionRank(withScore, (r) => r[rawKey] as number, (r, rank) => { r[grKey] = rank; });

        const classSorted = new Map<string, typeof withScore>();
        for (const r of withScore) {
          const key = r["班级"] as string;
          if (!classSorted.has(key)) classSorted.set(key, []);
          classSorted.get(key)!.push(r);
        }
        for (const cs of classSorted.values()) {
          competitionRank(cs, (r) => r[rawKey] as number, (r, rank) => { r[crKey] = rank; });
        }
      }

      const wsOverview = XLSX.utils.json_to_sheet(overviewRows, { header: overviewHeaders });
      const overviewWb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(overviewWb, wsOverview, "总览");
      const overviewBuf = Buffer.from(XLSX.write(overviewWb, { type: "buffer", bookType: "xlsx" }));
      archive.append(overviewBuf, { name: "总览.xlsx" });
    }

    // ── 2. Per-subject sheets ──
    const exportExams = subjectExamIds.length > 0
      ? members.filter((m) => subjectExamIds.includes(m.exam_id))
      : members;

    for (const m of exportExams) {
      // Get question scores
      const qsRows = await db.all(`
        SELECT qs.student_id, qs.question_number, qs.score, qs.max_score, qs.score_type,
               u.student_number, u.name, c.name as class_name
        FROM question_scores qs
        JOIN users u ON u.id = qs.student_id
        LEFT JOIN class_students cs ON cs.student_id = qs.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE qs.exam_id = ?
        ORDER BY u.student_number, qs.question_number
      `, m.exam_id) as Array<{
        student_id: number; question_number: number; score: number;
        max_score: number; score_type: string;
        student_number: string; name: string; class_name: string | null;
      }>;

      // Get total scores for ranking
      const scoreRows = await db.all(`
        SELECT ss.student_id, ss.total_score, ss.assigned_score,
               ss.objective_score, ss.subjective_score
        FROM student_scores ss WHERE ss.exam_id = ?
        ORDER BY ss.total_score DESC
      `, m.exam_id) as Array<{
        student_id: number; total_score: number; assigned_score: number | null;
        objective_score: number; subjective_score: number;
      }>;

      // Build grade rank — dense ranking
      const gradeRankMap = new Map<number, number>();
      competitionRank(scoreRows, (r) => r.total_score, (r, rank) => { gradeRankMap.set(r.student_id, rank); });

      // Class rank — dense ranking within each class
      const classSorted = await db.all(`
        SELECT ss.student_id, ss.total_score, c.name as class_name
        FROM student_scores ss
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id = ?
        ORDER BY ss.total_score DESC
      `, m.exam_id) as Array<{ student_id: number; total_score: number; class_name: string | null }>;
      const classRankMap = new Map<number, number>();
      const cGroups = new Map<string, Array<{ student_id: number; total_score: number }>>();
      for (const cs of classSorted) {
        const key = cs.class_name || "__unassigned__";
        if (!cGroups.has(key)) cGroups.set(key, []);
        cGroups.get(key)!.push({ student_id: cs.student_id, total_score: cs.total_score });
      }
      for (const cg of cGroups.values()) {
        competitionRank(cg, (r) => r.total_score, (r, rank) => { classRankMap.set(r.student_id, rank); });
      }

      // Per-student map of question scores
      const stuQsMap = new Map<number, Map<number, { score: number; maxScore: number; type: string }>>();
      for (const qs of qsRows) {
        if (!stuQsMap.has(qs.student_id)) stuQsMap.set(qs.student_id, new Map());
        stuQsMap.get(qs.student_id)!.set(qs.question_number, {
          score: qs.score, maxScore: qs.max_score, type: qs.score_type
        });
      }

      // Determine question list
      const qList = await db.all(`
        SELECT question_number, score_type, MAX(max_score) as max_score
        FROM question_scores WHERE exam_id = ?
        GROUP BY question_number, score_type
        ORDER BY question_number
      `, m.exam_id) as Array<{ question_number: number; score_type: string; max_score: number }>;

      const objQuestions = qList.filter((q) => q.score_type === "objective");
      const subQuestions = qList.filter((q) => q.score_type === "subjective");

      // Build headers
      const headers = ["班级", "姓名", "原始分", "年排", "班排"];
      if (scoreRows.some((s) => s.assigned_score != null && s.assigned_score !== s.total_score)) {
        headers.push("赋分");
      }
      headers.push("客观分", "主观分");

      if (includeObjectiveSub && objQuestions.length > 0) {
        objQuestions.forEach((q) => headers.push(`客观Q${q.question_number}(${q.max_score}分)`));
      }
      if (includeSubjectiveSub && subQuestions.length > 0) {
        subQuestions.forEach((q) => headers.push(`主观Q${q.question_number}(${q.max_score}分)`));
      }

      // Build rows
      const sheetRows: Record<string, string | number>[] = [];
      for (const sr of scoreRows) {
        const qsMap = stuQsMap.get(sr.student_id);
        const row: Record<string, string | number> = {
          "班级": qsRows.find((q) => q.student_id === sr.student_id)?.class_name || "未知班级",
          "姓名": qsRows.find((q) => q.student_id === sr.student_id)?.name || "",
          "原始分": sr.total_score,
          "年排": gradeRankMap.get(sr.student_id) || 0,
          "班排": classRankMap.get(sr.student_id) || 0,
          "客观分": sr.objective_score,
          "主观分": sr.subjective_score
        };
        if (sr.assigned_score != null && sr.assigned_score !== sr.total_score) {
          row["赋分"] = sr.assigned_score;
        }

        if (includeObjectiveSub) {
          objQuestions.forEach((q) => {
            const qs = qsMap?.get(q.question_number);
            row[`客观Q${q.question_number}(${q.max_score}分)`] = qs?.score ?? "";
          });
        }
        if (includeSubjectiveSub) {
          subQuestions.forEach((q) => {
            const qs = qsMap?.get(q.question_number);
            row[`主观Q${q.question_number}(${q.max_score}分)`] = qs?.score ?? "";
          });
        }
        sheetRows.push(row);
      }

      const subjectName = m.subject || m.exam_name;
      const wsSubject = XLSX.utils.json_to_sheet(sheetRows, { header: headers });
      const subjectWb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(subjectWb, wsSubject, "成绩");
      const subjectBuf = Buffer.from(XLSX.write(subjectWb, { type: "buffer", bookType: "xlsx" }));
      archive.append(subjectBuf, { name: `${subjectName}.xlsx` });
    }

    archive.finalize();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ message: error instanceof Error ? error.message : "导出大考失败" });
    }
  }
});

export default router;
