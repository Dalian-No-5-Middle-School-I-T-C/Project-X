import express from "express";
import type { Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getDatabase } from "../db";
import { ZipArchive } from "archiver";
import XLSX from "xlsx";

const router = express.Router();
router.use(authMiddleware);

// ── Helper types ──

interface GroupRow {
  id: number; name: string; description: string | null;
  grade_id: number | null; tag: string | null; status: string;
  is_official: number; total_score_mode: string;
  only_full_participants: number; created_by: number | null;
  created_at: string; updated_at: string;
}

interface GroupMemberRow {
  id: number; exam_id: number; sort_order: number;
  e_name: string; e_subject: string | null; e_status: string;
  e_exam_date: string | null; e_assigned_formula: string | null;
  graded_count: number; avg_score: number;
}

interface StudentScoreRow {
  student_id: number; student_number: string; name: string;
  class_name: string | null; class_id: number | null; grade_name: string | null;
}

interface QuestionScoreRow {
  exam_id: number; student_id: number; question_number: number;
  score: number; max_score: number; score_type: string;
}

// ── GET /api/exam-groups ── list all groups (with optional filters) ──

router.get("/", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
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
      WHERE 1=1
    `;
    if (req.query.grade_id) { sql += " AND eg.grade_id = ?"; params.push(req.query.grade_id); }
    if (req.query.status) { sql += " AND eg.status = ?"; params.push(req.query.status); }
    sql += " ORDER BY eg.created_at DESC";

    const rows = db.prepare(sql).all(...params) as any[];
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

router.post("/", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const { name, description, grade_id, tag, is_official, total_score_mode, only_full_participants, examIds }
      = req.body as {
        name: string; description?: string; grade_id?: number | null; tag?: string;
        is_official?: number; total_score_mode?: string; only_full_participants?: number;
        examIds?: number[];
      };

    if (!name || !name.trim()) {
      res.status(400).json({ message: "大考名称不能为空" });
      return;
    }

    const result = db.prepare(`
      INSERT INTO exam_groups (name, description, grade_id, tag, status, is_official, total_score_mode, only_full_participants, created_by)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      name.trim(), description ?? null, grade_id ?? null, tag ?? null,
      is_official ?? 0, total_score_mode ?? "raw", only_full_participants ?? 0,
      req.user!.id
    );

    const groupId = result.lastInsertRowid as number;

    // Associate exams if provided
    if (examIds && examIds.length > 0) {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, ?)"
      );
      examIds.forEach((examId, idx) => {
        insert.run(groupId, examId, idx);
      });
    }

    res.status(201).json({ id: groupId, message: "大考创建成功" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "创建大考失败" });
  }
});

// ── GET /api/exam-groups/:groupId ── get group detail ──

router.get("/:groupId", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groupId = Number(req.params.groupId);

    const group = db.prepare(`
      SELECT eg.*, g.name as grade_name
      FROM exam_groups eg LEFT JOIN grades g ON g.id = eg.grade_id
      WHERE eg.id = ?
    `).get(groupId) as any;

    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }

    const members = db.prepare(`
      SELECT egm.id, egm.exam_id, egm.sort_order,
             e.name as exam_name, e.subject, ac.exam_date, e.status, e.assigned_formula,
             COUNT(ss.id) as graded_count,
             ROUND(AVG(ss.total_score), 1) as avg_score
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      LEFT JOIN answer_cards ac ON ac.id = e.card_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      GROUP BY egm.id
      ORDER BY egm.sort_order, egm.id
    `).all(groupId) as any[];

    res.json({
      id: group.id, name: group.name, description: group.description,
      grade_id: group.grade_id, grade_name: group.grade_name || null,
      tag: group.tag, status: group.status, is_official: group.is_official,
      total_score_mode: group.total_score_mode, only_full_participants: group.only_full_participants,
      created_by: group.created_by, created_at: group.created_at, updated_at: group.updated_at,
      members: members.map((m) => ({
        id: m.id, examId: m.exam_id, examName: m.exam_name,
        subject: m.subject, sortOrder: m.sort_order,
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

router.put("/:groupId", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groupId = Number(req.params.groupId);
    const existing = db.prepare("SELECT id FROM exam_groups WHERE id = ?").get(groupId);
    if (!existing) { res.status(404).json({ message: "大考不存在" }); return; }

    const { name, description, grade_id, tag, is_official, total_score_mode, only_full_participants } = req.body;
    const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
    const vals: unknown[] = [];

    if (name !== undefined) { sets.push("name = ?"); vals.push(name.trim()); }
    if (description !== undefined) { sets.push("description = ?"); vals.push(description || null); }
    if (grade_id !== undefined) { sets.push("grade_id = ?"); vals.push(grade_id ?? null); }
    if (tag !== undefined) { sets.push("tag = ?"); vals.push(tag || null); }
    if (is_official !== undefined) { sets.push("is_official = ?"); vals.push(is_official); }
    if (total_score_mode !== undefined) { sets.push("total_score_mode = ?"); vals.push(total_score_mode); }
    if (only_full_participants !== undefined) { sets.push("only_full_participants = ?"); vals.push(only_full_participants); }

    db.prepare(`UPDATE exam_groups SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals, groupId);

    res.json({ ok: true, message: "大考更新成功" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "更新大考失败" });
  }
});

// ── DELETE /api/exam-groups/:groupId ── delete group ──

router.delete("/:groupId", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groupId = Number(req.params.groupId);
    const deleteExams = req.query.deleteExams === "1";

    const existing = db.prepare("SELECT id, name FROM exam_groups WHERE id = ?").get(groupId) as { id: number; name: string } | undefined;
    if (!existing) { res.status(404).json({ message: "大考不存在" }); return; }

    // Count associated exams
    const memberExams = db.prepare(`
      SELECT e.id, e.name FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      WHERE egm.group_id = ?
    `).all(groupId) as Array<{ id: number; name: string }>;

    // If deleting exams too, delete them (with cascade to scores etc.)
    if (deleteExams && memberExams.length > 0) {
      const deleteStmt = db.prepare("DELETE FROM exams WHERE id = ?");
      for (const exam of memberExams) {
        deleteStmt.run(exam.id);
      }
    }

    // Delete the group (cascade deletes members)
    db.prepare("DELETE FROM exam_groups WHERE id = ?").run(groupId);

    res.json({ ok: true, deletedExams: deleteExams ? memberExams.length : 0, message: "大考已删除" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "删除大考失败" });
  }
});

// ── POST /api/exam-groups/:groupId/exams ── associate exams ──

router.post("/:groupId/exams", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groupId = Number(req.params.groupId);
    const { examIds } = req.body as { examIds?: number[] };

    if (!examIds || examIds.length === 0) {
      res.status(400).json({ message: "请至少选择一个考试" });
      return;
    }

    // Get current max sort_order
    const maxOrder = db.prepare(
      "SELECT MAX(sort_order) as m FROM exam_group_members WHERE group_id = ?"
    ).get(groupId) as { m: number | null };
    let nextOrder = (maxOrder?.m ?? -1) + 1;

    const insert = db.prepare(
      "INSERT OR IGNORE INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, ?)"
    );

    const added: number[] = [];
    for (const examId of examIds) {
      const result = insert.run(groupId, examId, nextOrder);
      if (result.changes > 0) { added.push(examId); nextOrder++; }
    }

    res.json({ ok: true, added, message: `已关联 ${added.length} 场考试` });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "关联考试失败" });
  }
});

// ── DELETE /api/exam-groups/:groupId/exams/:examId ── remove exam ──

router.delete("/:groupId/exams/:examId", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groupId = Number(req.params.groupId);
    const examId = Number(req.params.examId);
    db.prepare("DELETE FROM exam_group_members WHERE group_id = ? AND exam_id = ?")
      .run(groupId, examId);
    res.json({ ok: true, message: "已移除考试关联" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "移除考试失败" });
  }
});

// ── PUT /api/exam-groups/:groupId/exams/sort ── update sort order ──

router.put("/:groupId/exams/sort", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groupId = Number(req.params.groupId);
    const items = req.body as { examId: number; sortOrder: number }[];
    if (!Array.isArray(items)) { res.status(400).json({ message: "请求格式错误" }); return; }

    const stmt = db.prepare(
      "UPDATE exam_group_members SET sort_order = ? WHERE group_id = ? AND exam_id = ?"
    );
    for (const item of items) {
      stmt.run(item.sortOrder, groupId, item.examId);
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "更新排序失败" });
  }
});

// ── GET /api/exam-groups/:groupId/overview ── group overview ──

router.get("/:groupId/overview", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groupId = Number(req.params.groupId);

    const group = db.prepare("SELECT name FROM exam_groups WHERE id = ?").get(groupId) as { name: string } | undefined;
    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }

    const members = db.prepare(`
      SELECT e.id as exam_id, e.name as exam_name, e.subject,
             e.assigned_formula,
             COUNT(ss.id) as graded_count,
             ROUND(AVG(ss.total_score), 1) as avg_score,
             ROUND(MAX(ss.total_score), 1) as max_score,
             ROUND(MIN(ss.total_score), 1) as min_score
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      LEFT JOIN student_scores ss ON ss.exam_id = e.id
      WHERE egm.group_id = ?
      GROUP BY e.id
      ORDER BY egm.sort_order, egm.id
    `).all(groupId) as any[];

    // Calculate full score and std for each subject
    const subjects = members.map((m) => {
      const fullScoreRow = db.prepare(`
        SELECT SUM(max_score) as total FROM (
          SELECT DISTINCT question_number, score_type, max_score FROM question_scores WHERE exam_id = ?
        )
      `).get(m.exam_id) as { total: number } | undefined;
      const fullScore = fullScoreRow?.total ?? 100;

      const stdRow = db.prepare(`
        SELECT ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as std
        FROM student_scores ss WHERE ss.exam_id = ?
      `).get(m.avg_score, m.avg_score, m.exam_id) as { std: number } | undefined;

      const passLine = fullScore * 0.6;
      const excellentLine = fullScore * 0.9;
      const passRow = db.prepare(`
        SELECT
          SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as pass_count,
          SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as excellent_count
        FROM student_scores ss WHERE ss.exam_id = ?
      `).get(passLine, excellentLine, m.exam_id) as { pass_count: number; excellent_count: number } | undefined;

      return {
        examId: m.exam_id,
        examName: m.exam_name,
        subject: m.subject || "",
        gradedCount: m.graded_count,
        avgScore: m.avg_score || 0,
        maxScore: m.max_score || 0,
        minScore: m.min_score || 0,
        stdDev: stdRow?.std ?? 0,
        passRate: m.graded_count > 0 ? Math.round((passRow?.pass_count || 0) / m.graded_count * 100) : 0,
        excellentRate: m.graded_count > 0 ? Math.round((passRow?.excellent_count || 0) / m.graded_count * 100) : 0,
        fullScore,
        hasAssignedScore: !!(m.assigned_formula && m.assigned_formula !== "")
      };
    });

    // Total participants
    const totalRow = db.prepare(`
      SELECT COUNT(DISTINCT s.student_id) as cnt FROM (
        SELECT ss.student_id FROM exam_group_members egm
        JOIN student_scores ss ON ss.exam_id = egm.exam_id
        WHERE egm.group_id = ?
      ) s
    `).get(groupId) as { cnt: number };

    const fullRow = db.prepare(`
      SELECT COUNT(*) as cnt FROM (
        SELECT ss.student_id, COUNT(DISTINCT egm.exam_id) as exam_count
        FROM exam_group_members egm
        JOIN student_scores ss ON ss.exam_id = egm.exam_id
        WHERE egm.group_id = ?
        GROUP BY ss.student_id
        HAVING exam_count = (SELECT COUNT(*) FROM exam_group_members WHERE group_id = ?)
      )
    `).get(groupId, groupId) as { cnt: number } | undefined;

    res.json({
      groupId, groupName: group.name,
      totalParticipants: totalRow.cnt,
      fullParticipants: fullRow?.cnt ?? 0,
      subjects
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "获取大考概览失败" });
  }
});

// ── GET /api/exam-groups/:groupId/rankings ── group rankings ──

router.get("/:groupId/rankings", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groupId = Number(req.params.groupId);
    const classId = req.query.classId ? Number(req.query.classId) : undefined;
    const fullOnly = req.query.fullOnly === "1";

    const group = db.prepare(`
      SELECT name, total_score_mode, only_full_participants
      FROM exam_groups WHERE id = ?
    `).get(groupId) as { name: string; total_score_mode: string; only_full_participants: number } | undefined;
    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }

    const members = db.prepare(`
      SELECT egm.exam_id, e.subject, e.assigned_formula, egm.sort_order
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      WHERE egm.group_id = ?
      ORDER BY egm.sort_order, egm.id
    `).all(groupId) as Array<{ exam_id: number; subject: string | null; assigned_formula: string | null; sort_order: number }>;

    if (members.length === 0) {
      res.json({ groupId, groupName: group.name, totalStudents: 0, displayColumns: [], rows: [] });
      return;
    }

    const useAssigned = fullOnly ? group.only_full_participants : false;
    const memberIds = members.map((m) => m.exam_id);

    // Get all scores for all member exams
    const allScores = db.prepare(`
      SELECT
        ss.student_id, ss.exam_id, ss.total_score, ss.assigned_score,
        ss.objective_score, ss.subjective_score,
        u.student_number, u.name,
        c.name as class_name, c.id as class_id,
        g.name as grade_name
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      LEFT JOIN class_students cs ON cs.student_id = ss.student_id
      LEFT JOIN classes c ON c.id = cs.class_id
      LEFT JOIN grades g ON g.id = c.grade_id
      WHERE ss.exam_id IN (${memberIds.map(() => "?").join(",")})
    `).all(...memberIds) as Array<{
      student_id: number; exam_id: number; total_score: number; assigned_score: number | null;
      objective_score: number; subjective_score: number;
      student_number: string; name: string;
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
      const rankRows = db.prepare(`
        SELECT ss.student_id, c.name as class_name, c.id as class_id
        FROM student_scores ss
        JOIN users u ON u.id = ss.student_id
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id = ?
        ORDER BY ss.total_score DESC
      `).all(examId) as Array<{ student_id: number; class_name: string | null; class_id: number | null }>;

      const rankMap = new Map<number, { gradeRank: number; classRank: number }>();
      examRanks[examId] = rankMap;

      // Grade rank
      rankRows.forEach((r, i) => {
        if (!rankMap.has(r.student_id)) {
          rankMap.set(r.student_id, { gradeRank: i + 1, classRank: 0 });
        }
      });

      // Class rank by group
      const classGroups = new Map<string, Array<{ student_id: number; idx: number }>>();
      rankRows.forEach((r, idx) => {
        const key = r.class_name || "__unassigned__";
        if (!classGroups.has(key)) classGroups.set(key, []);
        classGroups.get(key)!.push({ student_id: r.student_id, idx });
      });
      for (const cg of classGroups.values()) {
        cg.forEach((item, ci) => {
          const entry = rankMap.get(item.student_id);
          if (entry) entry.classRank = ci + 1;
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
      const subjects = members.map((m) => {
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

      const isFull = student.scores.size >= members.length;

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

    // Grade rank
    rows.forEach((r: any, i: number) => { r.totalGradeRank = i + 1; });

    // Class rank
    const classGroups2 = new Map<string, any[]>();
    for (const r of rows) {
      const key = r.className === "未知班级" ? "__unassigned__" : r.className;
      if (!classGroups2.has(key)) classGroups2.set(key, []);
      classGroups2.get(key)!.push(r);
    }
    for (const cg of classGroups2.values()) {
      cg.forEach((r: any, ci: number) => { r.totalClassRank = ci + 1; });
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

    const displayColumns = members.map((m) => m.subject || `科目${m.exam_id}`);

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

router.post("/:groupId/export", async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groupId = Number(req.params.groupId);
    const { includeOverview = true, subjectExamIds = [], includeObjectiveSub = true, includeSubjectiveSub = true }
      = req.body as {
        includeOverview?: boolean; subjectExamIds?: number[];
        includeObjectiveSub?: boolean; includeSubjectiveSub?: boolean;
      };

    const group = db.prepare(`
      SELECT eg.name, eg.total_score_mode
      FROM exam_groups eg WHERE eg.id = ?
    `).get(groupId) as { name: string; total_score_mode: string } | undefined;
    if (!group) { res.status(404).json({ message: "大考不存在" }); return; }

    const members = db.prepare(`
      SELECT egm.exam_id, e.name as exam_name, e.subject as subject, egm.sort_order
      FROM exam_group_members egm
      JOIN exams e ON e.id = egm.exam_id
      WHERE egm.group_id = ?
      ORDER BY egm.sort_order, egm.id
    `).all(groupId) as Array<{ exam_id: number; exam_name: string; subject: string | null; sort_order: number }>;

    if (members.length === 0) {
      res.status(400).json({ message: "大考中没有关联考试" });
      return;
    }

    // Set headers for ZIP
    const safeName = group.name.replace(/[\\/:*?"<>|]/g, "_");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}_导出.zip`);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.pipe(res);

    // ── 1. Overview sheet ──
    if (includeOverview) {
      const memberIds = members.map((m) => m.exam_id);
      const allScores = db.prepare(`
        SELECT
          ss.student_id, ss.exam_id, ss.total_score, ss.assigned_score,
          u.student_number, u.name,
          c.name as class_name
        FROM student_scores ss
        JOIN users u ON u.id = ss.student_id
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id IN (${memberIds.map(() => "?").join(",")})
      `).all(...memberIds) as Array<{
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

      // Fill ranks
      overviewRows.forEach((r, i) => { r["总分年排"] = i + 1; });
      const cgMap = new Map<string, typeof overviewRows>();
      for (const r of overviewRows) {
        const key = r["班级"] as string;
        if (!cgMap.has(key)) cgMap.set(key, []);
        cgMap.get(key)!.push(r);
      }
      for (const cg of cgMap.values()) {
        cg.forEach((r, ci) => { r["总分班排"] = ci + 1; });
      }

      // Fill per-subject ranks
      for (const m of members) {
        const sub = m.subject || `科目${m.exam_id}`;
        const rawKey = `${sub}原始分`;
        const grKey = `${sub}年排`;
        const crKey = `${sub}班排`;

        const sorted = [...overviewRows].sort((a, b) => (b[rawKey] as number || 0) - (a[rawKey] as number || 0));
        sorted.forEach((r, i) => { if (r[rawKey] !== "") r[grKey] = i + 1; });

        const classSorted = new Map<string, typeof sorted>();
        for (const r of sorted) {
          const key = r["班级"] as string;
          if (!classSorted.has(key)) classSorted.set(key, []);
          classSorted.get(key)!.push(r);
        }
        for (const cs of classSorted.values()) {
          cs.forEach((r, ci) => { if (r[rawKey] !== "") r[crKey] = ci + 1; });
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
      const qsRows = db.prepare(`
        SELECT qs.student_id, qs.question_number, qs.score, qs.max_score, qs.score_type,
               u.student_number, u.name, c.name as class_name
        FROM question_scores qs
        JOIN users u ON u.id = qs.student_id
        LEFT JOIN class_students cs ON cs.student_id = qs.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE qs.exam_id = ?
        ORDER BY u.student_number, qs.question_number
      `).all(m.exam_id) as Array<{
        student_id: number; question_number: number; score: number;
        max_score: number; score_type: string;
        student_number: string; name: string; class_name: string | null;
      }>;

      // Get total scores for ranking
      const scoreRows = db.prepare(`
        SELECT ss.student_id, ss.total_score, ss.assigned_score,
               ss.objective_score, ss.subjective_score
        FROM student_scores ss WHERE ss.exam_id = ?
        ORDER BY ss.total_score DESC
      `).all(m.exam_id) as Array<{
        student_id: number; total_score: number; assigned_score: number | null;
        objective_score: number; subjective_score: number;
      }>;

      // Build grade rank
      const gradeRankMap = new Map<number, number>();
      scoreRows.forEach((sr, i) => gradeRankMap.set(sr.student_id, i + 1));

      // Class rank
      const classSorted = db.prepare(`
        SELECT ss.student_id, c.name as class_name
        FROM student_scores ss
        LEFT JOIN class_students cs ON cs.student_id = ss.student_id
        LEFT JOIN classes c ON c.id = cs.class_id
        WHERE ss.exam_id = ?
        ORDER BY ss.total_score DESC
      `).all(m.exam_id) as Array<{ student_id: number; class_name: string | null }>;
      const classRankMap = new Map<number, number>();
      const cGroups = new Map<string, Array<number>>();
      for (const cs of classSorted) {
        const key = cs.class_name || "__unassigned__";
        if (!cGroups.has(key)) cGroups.set(key, []);
        cGroups.get(key)!.push(cs.student_id);
      }
      for (const cg of cGroups.values()) {
        cg.forEach((sid, ci) => classRankMap.set(sid, ci + 1));
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
      const qList = db.prepare(`
        SELECT question_number, score_type, MAX(max_score) as max_score
        FROM question_scores WHERE exam_id = ?
        GROUP BY question_number, score_type
        ORDER BY question_number
      `).all(m.exam_id) as Array<{ question_number: number; score_type: string; max_score: number }>;

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
