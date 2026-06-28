/**
 * 成绩修改 API
 * 挂载点: /api/exams (由 server/index.ts 的业务路由 RBAC 网关保护)
 *
 * 功能:
 * - 获取学生全部题目得分详情
 * - 逐题手动修改分数（教师/管理员）
 * - 修改答案并自动重算所有学生分数
 * - 查看答题卡答案配置
 */

import express from "express";
import type { Request, Response } from "express";
import { getMysqlDb, buildUpsertSQL } from "../db";
import type { DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { AssignedScoreService } from "../services/AssignedScoreService";
import {
  objectiveQuestionDefinitions,
  gradeObjectiveQuestion,
} from "../../shared/grading";
import type { AnswerCard, ObjectiveRecognitionQuestion } from "../../shared/types";

const router = express.Router();

// ── 搜索考生（考号/姓名） ──────────────────────────
router.get("/:examId/students/search", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const q = (req.query.q as string || "").trim();
  if (!Number.isFinite(examId) || !q) {
    res.status(400).json({ message: "非法参数" });
    return;
  }

  const db = getMysqlDb();
  const students = await db.all(`
    SELECT DISTINCT u.id, u.name, u.student_number
    FROM student_scores ss
    JOIN users u ON u.id = ss.student_id
    WHERE ss.exam_id = ? AND (u.student_number = ? OR u.name LIKE ?)
    ORDER BY u.student_number
    LIMIT 20
  `, examId, q, `%${q}%`) as Array<{ id: number; name: string; student_number: string | null }>;

  res.json(students.map((s) => ({
    id: s.id,
    name: s.name,
    studentNumber: s.student_number ?? ""
  })));
});

// ── 获取某学生全部题目得分 + 答题卡图片路径 ──────────
router.get("/:examId/student/:studentId/scores", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(examId) || !Number.isFinite(studentId)) {
    res.status(400).json({ message: "非法考试或学生 ID" });
    return;
  }

  const db = getMysqlDb();

  const exam = await db.get("SELECT id, card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
  if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }
  const cardId = exam.card_id;
  if (!cardId) { res.status(404).json({ message: "此考试未关联答题卡" }); return; }

  const student = await db.get(
    "SELECT id, name, username, student_number FROM users WHERE id = ?",
    studentId
  ) as { id: number; name: string; username: string; student_number: string | null } | undefined;
  if (!student) { res.status(404).json({ message: "学生不存在" }); return; }

  const totalRow = await db.get(
    "SELECT * FROM student_scores WHERE exam_id = ? AND student_id = ?",
    examId, studentId
  ) as any;

  const questionScores = await db.all(`
    SELECT id, question_number, question_id, block_id, score, max_score, score_type,
           manually_modified, modified_at
    FROM question_scores
    WHERE exam_id = ? AND student_id = ?
    ORDER BY question_number
  `, examId, studentId) as any[];

  const scans: Array<{ recordId: number; fileName: string; pageNum: number }> = [];
  try {
    const scanRows = await db.all(`
      SELECT sr.id as recordId, sr.file_path as fileName
      FROM scan_records sr
      JOIN scan_batches sb ON sb.id = sr.batch_id
      WHERE sb.exam_id = ? AND sr.student_id = ?
      ORDER BY sr.id
    `, examId, studentId) as Array<{ recordId: number; fileName: string | null }>;
    scans.push(...scanRows.filter((r) => r.fileName).map((r, idx) => ({
      recordId: r.recordId, fileName: r.fileName!, pageNum: idx + 1
    })));
  } catch {
    // scan_records may not have expected columns in all DB versions
  }

  const classQuestionStats: Record<number, { avgScore: number; maxScore: number; count: number }> = {};
  const classRow = await db.get(
    "SELECT cs.class_id FROM class_students cs WHERE cs.student_id = ?",
    studentId
  ) as { class_id: number } | undefined;
  if (classRow) {
    const classAvgs = await db.all(`
      SELECT qs.question_number, qs.score_type, ROUND(AVG(qs.score), 1) as avgScore, MAX(qs.max_score) as maxScore, COUNT(*) as cnt
      FROM question_scores qs
      JOIN class_students cs ON cs.student_id = qs.student_id
      WHERE qs.exam_id = ? AND cs.class_id = ?
      GROUP BY qs.question_number, qs.score_type
      ORDER BY qs.question_number
    `, examId, classRow.class_id) as Array<{ question_number: number; score_type: string; avgScore: number; maxScore: number; cnt: number }>;
    for (const row of classAvgs) {
      classQuestionStats[row.question_number] = { avgScore: row.avgScore, maxScore: row.maxScore, count: row.cnt };
    }
  }
  const cardRepo = new CardRepository();
  const card = await cardRepo.findById(cardId);
  if (!card) { res.status(404).json({ message: "答题卡数据不存在" }); return; }

  const questionDefMap = new Map<number, {
    mode: string; optionCount: number; answerKey: string[];
    scoringRule: any; step: number; blockType: string;
  }>();
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") {
      for (const def of objectiveQuestionDefinitions(block)) {
        const step = (() => {
          if (!def.scoringRule) return def.score / (def.optionCount || 1);
          if (def.scoringRule.type === "fixed_partial") return def.scoringRule.partialScore;
          return def.score / (def.optionCount || 1);
        })();
        questionDefMap.set(def.questionNumber, {
          mode: def.mode, optionCount: def.optionCount,
          answerKey: def.answerKey ?? [], scoringRule: def.scoringRule ?? null,
          step, blockType: "objective"
        });
      }
    } else if (block.type === "subjective") {
      for (const q of block.questions) {
        const qNum = typeof q.number === "number" ? q.number : parseInt(String(q.number), 10);
        if (!Number.isFinite(qNum)) continue;
        questionDefMap.set(qNum, {
          mode: "manual", optionCount: 0, answerKey: [],
          scoringRule: null, step: q.score, blockType: "subjective"
        });
      }
    }
  }

  const enrichedScores = questionScores.map((qs: any) => {
    const def = questionDefMap.get(qs.question_number);
    return { ...qs, ...(def ?? {}) };
  });

  const recognitionRows = await db.all(`
    SELECT orr.question_number, orr.selected_options, orr.confidence
    FROM objective_recognitions orr
    JOIN scan_records sr ON sr.id = orr.record_id
    JOIN scan_batches sb ON sb.id = sr.batch_id
    WHERE sb.exam_id = ? AND sr.student_id = ?
    ORDER BY orr.confidence DESC
  `, examId, studentId) as any[];

  const recognitionMap = new Map<number, { selectedOptions: string[]; confidence: number }>();
  for (const r of recognitionRows) {
    const existing = recognitionMap.get(r.question_number);
    if (!existing || r.confidence > existing.confidence) {
      recognitionMap.set(r.question_number, {
        selectedOptions: r.selected_options ? JSON.parse(r.selected_options) : [],
        confidence: r.confidence
      });
    }
  }

  res.json({
    student: { id: student.id, name: student.name, studentNumber: student.student_number ?? "" },
    totalScore: totalRow ? {
      objectiveScore: totalRow.objective_score, subjectiveScore: totalRow.subjective_score,
      totalScore: totalRow.total_score, assignedScore: totalRow.assigned_score ?? null,
      manuallyModified: !!totalRow.manually_modified,
    } : null,
    questionScores: enrichedScores,
    recognition: Object.fromEntries(recognitionMap),
    scans: scans.map((s) => ({ recordId: s.recordId, fileName: s.fileName, pageNum: s.pageNum })),
    classQuestionStats,
    cardId
  });
});

// ── 逐题修改分数 ──────────────────────────────────
router.put("/:examId/student/:studentId/scores", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(examId) || !Number.isFinite(studentId)) {
    res.status(400).json({ message: "非法考试或学生 ID" });
    return;
  }

  const updates = req.body?.scores as Array<{ questionNumber: number; scoreType: string; score: number }> | undefined;
  if (!updates || !Array.isArray(updates) || updates.length === 0) {
    res.status(400).json({ message: "未提供分数修改数据" });
    return;
  }

  const db = getMysqlDb();
  const userId = req.user!.id;
  const now = new Date().toISOString();

  const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
  if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }

  await db.transaction(async (tx) => {
    for (const u of updates) {
      const existing = await tx.get(
        "SELECT id, score, max_score FROM question_scores WHERE exam_id = ? AND student_id = ? AND question_number = ? AND score_type = ?",
        examId, studentId, u.questionNumber, u.scoreType
      ) as { id: number; score: number; max_score: number } | undefined;

      if (existing) {
        await tx.run(
          `UPDATE question_scores SET score = ?, manually_modified = 1, modified_by = ?, modified_at = ?
           WHERE exam_id = ? AND student_id = ? AND question_number = ? AND score_type = ?`,
          u.score, userId, now, examId, studentId, u.questionNumber, u.scoreType
        );
        await tx.run(
          `INSERT INTO answer_overrides (exam_id, card_id, question_number, score_type, override_type, old_value, new_value, created_by, created_at)
           VALUES (?, ?, ?, ?, 'score', ?, ?, ?, ?)`,
          examId, exam.card_id, u.questionNumber, u.scoreType,
          JSON.stringify(existing.score), JSON.stringify(u.score), userId, now
        );
      }
    }

    const rows = await tx.all(
      "SELECT score, score_type FROM question_scores WHERE exam_id = ? AND student_id = ?",
      examId, studentId
    ) as any[];

    let totalObjective = 0, totalSubjective = 0;
    for (const s of rows) {
      if (s.score_type === "objective") totalObjective += s.score;
      else totalSubjective += s.score;
    }
    const newTotal = totalObjective + totalSubjective;

    await tx.run(`
      UPDATE student_scores SET objective_score = ?, subjective_score = ?, total_score = ?,
        manually_modified = 1, modified_by = ?, modified_at = ?
      WHERE exam_id = ? AND student_id = ?
    `, totalObjective, totalSubjective, newTotal, userId, now, examId, studentId);
  });

  await recomputeRankings(db, examId);
  res.json({ ok: true });
});

// ── 获取考试的答题卡答案配置 ──────────────────────
router.get("/:examId/answers", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  if (!Number.isFinite(examId)) {
    res.status(400).json({ message: "非法考试 ID" });
    return;
  }

  const db = getMysqlDb();
  const exam = await db.get(
    "SELECT id, card_id, name FROM exams WHERE id = ?",
    examId
  ) as { card_id: string | null; name: string } | undefined;
  if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }
  if (!exam.card_id) { res.status(404).json({ message: "此考试未关联答题卡" }); return; }

  const cardRepo = new CardRepository();
  const card = await cardRepo.findById(exam.card_id);
  if (!card) { res.status(404).json({ message: "答题卡数据不存在" }); return; }

  const questions: Array<Record<string, unknown>> = [];
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") {
      for (const def of objectiveQuestionDefinitions(block)) {
        questions.push({
          questionNumber: def.questionNumber, questionType: "objective",
          mode: def.mode, optionCount: def.optionCount, score: def.score,
          answerKey: def.answerKey ?? [], scoringRule: def.scoringRule ?? null,
        });
      }
    } else if (block.type === "subjective") {
      for (const q of block.questions) {
        questions.push({ questionNumber: q.number, questionType: "subjective", score: q.score });
      }
    }
  }

  res.json({ examId, examName: exam.name, cardId: exam.card_id, questions, sided: card.sided ?? "double" });
});

// ── 修改答案并自动重算所有学生分数 ────────────────
router.put("/:examId/answers", async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  if (!Number.isFinite(examId)) {
    res.status(400).json({ message: "非法考试 ID" });
    return;
  }

  const answerUpdates = req.body?.answers as Record<string, string[]> | undefined;
  if (!answerUpdates || Object.keys(answerUpdates).length === 0) {
    res.status(400).json({ message: "未提供答案修改数据" });
    return;
  }

  const db = getMysqlDb();
  const userId = req.user!.id;
  const now = new Date().toISOString();

  const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
  if (!exam || !exam.card_id) { res.status(404).json({ message: "考试不存在或未关联答题卡" }); return; }

  const cardRepo = new CardRepository();
  const card = await cardRepo.findById(exam.card_id);
  if (!card) { res.status(404).json({ message: "答题卡数据不存在" }); return; }

  const oldAnswers: Record<string, string[]> = {};

  for (const block of card.bodyBlocks) {
    if (block.type !== "objective") continue;
    const answers = block.answerKey ?? {};
    if (block.questions && block.questions.length > 0) {
      for (const q of block.questions) {
        const key = String(q.questionNumber);
        if (answerUpdates[key]) {
          oldAnswers[key] = [...(q.answerKey ?? [])];
          q.answerKey = answerUpdates[key];
        }
      }
    } else {
      for (const key of Object.keys(answerUpdates)) {
        const qNum = Number(key);
        if (qNum >= block.questionStart && qNum < block.questionStart + block.questionCount) {
          oldAnswers[key] = [...(answers[qNum] ?? [])];
          (answers as any)[qNum] = answerUpdates[key];
        }
      }
      (block as any).answerKey = answers;
    }
  }

  const students = await db.all("SELECT student_id FROM student_scores WHERE exam_id = ?", examId) as Array<{ student_id: number }>;
  let updatedCount = 0;

  // Build cross-platform upsert SQL for question_scores
  const upsertCols = ["exam_id", "student_id", "question_number", "question_id", "block_id", "score", "max_score", "score_type", "manually_modified", "modified_by", "modified_at"];
  const conflictCols = ["exam_id", "student_id", "question_number", "score_type"];
  const updateCols = ["score", "max_score", "manually_modified", "modified_by", "modified_at"];
  const upsertSQL = buildUpsertSQL(db.dialect, "question_scores", upsertCols, conflictCols, updateCols);

  await db.transaction(async (tx) => {
    for (const [qNum, newKey] of Object.entries(answerUpdates)) {
      await tx.run(
        `INSERT INTO answer_overrides (exam_id, card_id, question_number, score_type, override_type, old_value, new_value, created_by, created_at)
         VALUES (?, ?, ?, 'objective', 'answer', ?, ?, ?, ?)`,
        examId, exam.card_id, Number(qNum),
        JSON.stringify(oldAnswers[qNum] ?? []), JSON.stringify(newKey), userId, now
      );
    }

    for (const { student_id: studentId } of students) {
      const recognitionRows = await tx.all(`
        SELECT orr.question_number, orr.selected_options, orr.confidence
        FROM objective_recognitions orr
        JOIN scan_records sr ON sr.id = orr.record_id
        JOIN scan_batches sb ON sb.id = sr.batch_id
        WHERE sb.exam_id = ? AND sr.student_id = ?
        ORDER BY orr.confidence DESC
      `, examId, studentId) as any[];

      const recognitionMap = new Map<number, { selectedOptions: string[]; confidence: number }>();
      for (const r of recognitionRows) {
        const existing = recognitionMap.get(r.question_number);
        if (!existing || r.confidence > existing.confidence) {
          recognitionMap.set(r.question_number, {
            selectedOptions: r.selected_options ? JSON.parse(r.selected_options) : [],
            confidence: r.confidence
          });
        }
      }

      let totalObj = 0;
      for (const block of card.bodyBlocks) {
        if (block.type !== "objective") continue;
        for (const def of objectiveQuestionDefinitions(block)) {
          const rec = recognitionMap.get(def.questionNumber);
          const grade = gradeObjectiveQuestion(card, {
            questionNumber: def.questionNumber,
            selectedOptions: rec?.selectedOptions ?? [],
            confidence: rec?.confidence ?? 0,
          } as ObjectiveRecognitionQuestion);

          await tx.run(upsertSQL,
            examId, studentId, def.questionNumber, null, block.id,
            grade.score, grade.maxScore, "objective",
            1, userId, now
          );
          totalObj += grade.score;
        }
      }

      const subjScore = await tx.get(
        "SELECT COALESCE(SUM(score), 0) as total FROM question_scores WHERE exam_id = ? AND student_id = ? AND score_type = 'subjective'",
        examId, studentId
      ) as { total: number };

      const totalScore = totalObj + subjScore.total;
      await tx.run(`
        UPDATE student_scores SET objective_score = ?, total_score = ?,
          manually_modified = 1, modified_by = ?, modified_at = ?
        WHERE exam_id = ? AND student_id = ?
      `, totalObj, totalScore, userId, now, examId, studentId);

      updatedCount++;
    }
  });

  await recomputeRankings(db, examId);
  res.json({ ok: true, updatedCount, modifiedAnswers: Object.keys(answerUpdates).length });
});

// ── 重算排名 ──────────────────────────────────────
async function recomputeRankings(db: DbAdapter, examId: number) {
  const allStudents = await db.all(`
    SELECT id, total_score FROM student_scores WHERE exam_id = ? ORDER BY total_score DESC
  `, examId) as Array<{ id: number; total_score: number }>;

  if (allStudents.length === 0) return;

  const n = allStudents.length;

  for (let i = 0; i < allStudents.length; i++) {
    const rank = i + 1;
    const percentile = n > 1 ? Math.round((1 - i / n) * 1000) / 10 : 100;
    await db.run(
      "UPDATE student_scores SET `rank` = ?, percentile = ? WHERE id = ?",
      rank, percentile, allStudents[i].id
    );
  }

  try {
    const assignedService = new AssignedScoreService();
    await assignedService.recalculateAll(examId);
  } catch (_) {
    // 无赋分配置或重算失败，静默跳过
  }
}

export default router;
