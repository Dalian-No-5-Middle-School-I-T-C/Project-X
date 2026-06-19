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
import { getDatabase } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import {
  objectiveQuestionDefinitions,
  gradeObjectiveQuestion,
} from "../../shared/grading";
import type { AnswerCard, ObjectiveBlock, ObjectiveRecognitionQuestion, SubjectiveBlock } from "../../shared/types";

const router = express.Router();

// ── 搜索考生（考号/姓名） ──────────────────────────
router.get("/:examId/students/search", (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const q = (req.query.q as string || "").trim();
  if (!Number.isFinite(examId) || !q) {
    res.status(400).json({ message: "非法参数" });
    return;
  }

  const db = getDatabase();
  const students = db.prepare(`
    SELECT DISTINCT u.id, u.name, u.student_number
    FROM student_scores ss
    JOIN users u ON u.id = ss.student_id
    WHERE ss.exam_id = ? AND (u.student_number = ? OR u.name LIKE ?)
    ORDER BY u.student_number
    LIMIT 20
  `).all(examId, q, `%${q}%`) as Array<{ id: number; name: string; student_number: string | null }>;

  res.json(students.map((s) => ({
    id: s.id,
    name: s.name,
    studentNumber: s.student_number ?? ""
  })));
});

// ── 获取某学生全部题目得分 + 答题卡图片路径 ──────────
router.get("/:examId/student/:studentId/scores", (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(examId) || !Number.isFinite(studentId)) {
    res.status(400).json({ message: "非法考试或学生 ID" });
    return;
  }

  const db = getDatabase();

  // Verify exam and get card_id
  const exam = db.prepare("SELECT id, card_id FROM exams WHERE id = ?").get(examId) as { card_id: string | null } | undefined;
  if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }
  const cardId = exam.card_id;
  if (!cardId) { res.status(404).json({ message: "此考试未关联答题卡" }); return; }

  // Student info
  const student = db.prepare(
    "SELECT id, name, username, student_number FROM users WHERE id = ?"
  ).get(studentId) as { id: number; name: string; username: string; student_number: string | null } | undefined;
  if (!student) { res.status(404).json({ message: "学生不存在" }); return; }

  // Student total score
  const totalRow = db.prepare(
    "SELECT * FROM student_scores WHERE exam_id = ? AND student_id = ?"
  ).get(examId, studentId) as any;

  // Question scores
  const questionScores = db.prepare(`
    SELECT id, question_number, question_id, block_id, score, max_score, score_type,
           manually_modified, modified_at
    FROM question_scores
    WHERE exam_id = ? AND student_id = ?
    ORDER BY question_number
  `).all(examId, studentId) as any[];

  // Scan record images — return file_path for grading-image endpoint
  const scans: Array<{ recordId: number; fileName: string; pageNum: number }> = [];
  try {
    const scanRows = db.prepare(`
      SELECT sr.id as recordId, sr.file_path as fileName
      FROM scan_records sr
      JOIN scan_batches sb ON sb.id = sr.batch_id
      WHERE sb.exam_id = ? AND sr.student_id = ?
      ORDER BY sr.id
    `).all(examId, studentId) as Array<{ recordId: number; fileName: string | null }>;
    scans.push(...scanRows.filter((r) => r.fileName).map((r, idx) => ({
      recordId: r.recordId, fileName: r.fileName!, pageNum: idx + 1
    })));
  } catch {
    // scan_records may not have expected columns in all DB versions
  }

  // Build card for question definitions
  const cardRepo = new CardRepository();
  const card = cardRepo.findById(cardId);
  if (!card) { res.status(404).json({ message: "答题卡数据不存在" }); return; }

  // Build question definition lookup from card
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
          mode: def.mode,
          optionCount: def.optionCount,
          answerKey: def.answerKey ?? [],
          scoringRule: def.scoringRule ?? null,
          step,
          blockType: "objective"
        });
      }
    } else if (block.type === "subjective") {
      for (const q of block.questions) {
        const qNum = typeof q.number === "number" ? q.number : parseInt(String(q.number), 10);
        if (!Number.isFinite(qNum)) continue;
        questionDefMap.set(qNum, {
          mode: "manual",
          optionCount: 0,
          answerKey: [],
          scoringRule: null,
          step: q.score,
          blockType: "subjective"
        });
      }
    }
  }

  // Enrich question scores with card-derived info
  const enrichedScores = questionScores.map((qs: any) => {
    const def = questionDefMap.get(qs.question_number);
    return { ...qs, ...(def ?? {}) };
  });

  // Get recognition data (projectx.db scan_records has no page_num)
  const recognitionRows = db.prepare(`
    SELECT orr.question_number, orr.selected_options, orr.confidence
    FROM objective_recognitions orr
    JOIN scan_records sr ON sr.id = orr.record_id
    JOIN scan_batches sb ON sb.id = sr.batch_id
    WHERE sb.exam_id = ? AND sr.student_id = ?
    ORDER BY orr.confidence DESC
  `).all(examId, studentId) as any[];

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
    student: {
      id: student.id,
      name: student.name,
      studentNumber: student.student_number ?? "",
    },
    totalScore: totalRow ? {
      objectiveScore: totalRow.objective_score,
      subjectiveScore: totalRow.subjective_score,
      totalScore: totalRow.total_score,
      assignedScore: totalRow.assigned_score ?? null,
      manuallyModified: !!totalRow.manually_modified,
    } : null,
    questionScores: enrichedScores,
    recognition: Object.fromEntries(recognitionMap),
    scans: scans.map((s) => ({
      recordId: s.recordId,
      fileName: s.fileName,
      pageNum: s.pageNum,
    })),
    cardId
  });
});

// ── 逐题修改分数 ──────────────────────────────────
router.put("/:examId/student/:studentId/scores", (req: Request, res: Response) => {
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

  const db = getDatabase();
  const userId = req.user!.id;
  const now = new Date().toISOString();

  const exam = db.prepare("SELECT card_id FROM exams WHERE id = ?").get(examId) as { card_id: string | null } | undefined;
  if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }

  const updateStmt = db.prepare(`
    UPDATE question_scores SET score = ?, manually_modified = 1, modified_by = ?, modified_at = ?
    WHERE exam_id = ? AND student_id = ? AND question_number = ? AND score_type = ?
  `);

  const overrideInsert = db.prepare(`
    INSERT INTO answer_overrides (exam_id, card_id, question_number, score_type, override_type, old_value, new_value, created_by, created_at)
    VALUES (?, ?, ?, ?, 'score', ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    for (const u of updates) {
      const existing = db.prepare(
        "SELECT id, score, max_score FROM question_scores WHERE exam_id = ? AND student_id = ? AND question_number = ? AND score_type = ?"
      ).get(examId, studentId, u.questionNumber, u.scoreType) as { id: number; score: number; max_score: number } | undefined;

      if (existing) {
        updateStmt.run(u.score, userId, now, examId, studentId, u.questionNumber, u.scoreType);
        overrideInsert.run(
          examId, exam.card_id, u.questionNumber, u.scoreType,
          JSON.stringify(existing.score), JSON.stringify(u.score), userId, now
        );
      }
    }

    // Re-sum all scores
    const rows = db.prepare(
      "SELECT score, score_type FROM question_scores WHERE exam_id = ? AND student_id = ?"
    ).all(examId, studentId) as any[];

    let totalObjective = 0;
    let totalSubjective = 0;
    for (const s of rows) {
      if (s.score_type === "objective") totalObjective += s.score;
      else totalSubjective += s.score;
    }
    const newTotal = totalObjective + totalSubjective;

    db.prepare(`
      UPDATE student_scores SET objective_score = ?, subjective_score = ?, total_score = ?,
        manually_modified = 1, modified_by = ?, modified_at = ?
      WHERE exam_id = ? AND student_id = ?
    `).run(totalObjective, totalSubjective, newTotal, userId, now, examId, studentId);
  });

  transaction();
  recomputeRankings(db, examId);

  res.json({ ok: true });
});

// ── 获取考试的答题卡答案配置 ──────────────────────
router.get("/:examId/answers", (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  if (!Number.isFinite(examId)) {
    res.status(400).json({ message: "非法考试 ID" });
    return;
  }

  const db = getDatabase();
  const exam = db.prepare(
    "SELECT id, card_id, name FROM exams WHERE id = ?"
  ).get(examId) as { card_id: string | null; name: string } | undefined;
  if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }
  if (!exam.card_id) { res.status(404).json({ message: "此考试未关联答题卡" }); return; }

  const cardRepo = new CardRepository();
  const card = cardRepo.findById(exam.card_id);
  if (!card) { res.status(404).json({ message: "答题卡数据不存在" }); return; }

  const questions: Array<Record<string, unknown>> = [];
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") {
      for (const def of objectiveQuestionDefinitions(block)) {
        questions.push({
          questionNumber: def.questionNumber,
          questionType: "objective",
          mode: def.mode,
          optionCount: def.optionCount,
          score: def.score,
          answerKey: def.answerKey ?? [],
          scoringRule: def.scoringRule ?? null,
        });
      }
    } else if (block.type === "subjective") {
      for (const q of block.questions) {
        questions.push({
          questionNumber: q.number,
          questionType: "subjective",
          score: q.score,
        });
      }
    }
  }

  res.json({
    examId,
    examName: exam.name,
    cardId: exam.card_id,
    questions,
    sided: card.sided ?? "double"
  });
});

// ── 修改答案并自动重算所有学生分数 ────────────────
router.put("/:examId/answers", (req: Request, res: Response) => {
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

  const db = getDatabase();
  const userId = req.user!.id;
  const now = new Date().toISOString();

  const exam = db.prepare("SELECT card_id FROM exams WHERE id = ?").get(examId) as { card_id: string | null } | undefined;
  if (!exam || !exam.card_id) { res.status(404).json({ message: "考试不存在或未关联答题卡" }); return; }

  const cardRepo = new CardRepository();
  const card = cardRepo.findById(exam.card_id);
  if (!card) { res.status(404).json({ message: "答题卡数据不存在" }); return; }

  // Record old values before modifying
  const oldAnswers: Record<string, string[]> = {};

  // Apply answer changes to card (in-memory only)
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

  // Re-grade all students
  const students = db.prepare("SELECT student_id FROM student_scores WHERE exam_id = ?").all(examId) as Array<{ student_id: number }>;
  let updatedCount = 0;

  const upsertScore = db.prepare(`
    INSERT INTO question_scores (exam_id, student_id, question_number, question_id, block_id, score, max_score, score_type, manually_modified, modified_by, modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(exam_id, student_id, question_number, score_type) DO UPDATE SET
      score = excluded.score, max_score = excluded.max_score,
      manually_modified = 1, modified_by = excluded.modified_by, modified_at = excluded.modified_at
  `);

  const overrideInsert = db.prepare(`
    INSERT INTO answer_overrides (exam_id, card_id, question_number, score_type, override_type, old_value, new_value, created_by, created_at)
    VALUES (?, ?, ?, 'objective', 'answer', ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    for (const [qNum, newKey] of Object.entries(answerUpdates)) {
      overrideInsert.run(
        examId, exam.card_id, Number(qNum),
        JSON.stringify(oldAnswers[qNum] ?? []),
        JSON.stringify(newKey),
        userId, now
      );
    }

    for (const { student_id: studentId } of students) {
      const recognitionRows = db.prepare(`
        SELECT orr.question_number, orr.selected_options, orr.confidence
        FROM objective_recognitions orr
        JOIN scan_records sr ON sr.id = orr.record_id
        JOIN scan_batches sb ON sb.id = sr.batch_id
        WHERE sb.exam_id = ? AND sr.student_id = ?
        ORDER BY orr.confidence DESC
      `).all(examId, studentId) as any[];

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

          upsertScore.run(
            examId, studentId, def.questionNumber, null, block.id,
            grade.score, grade.maxScore, "objective",
            userId, now
          );

          totalObj += grade.score;
        }
      }

      const subjScore = db.prepare(
        "SELECT COALESCE(SUM(score), 0) as total FROM question_scores WHERE exam_id = ? AND student_id = ? AND score_type = 'subjective'"
      ).get(examId, studentId) as { total: number };

      const totalScore = totalObj + subjScore.total;
      db.prepare(`
        UPDATE student_scores SET objective_score = ?, total_score = ?,
          manually_modified = 1, modified_by = ?, modified_at = ?
        WHERE exam_id = ? AND student_id = ?
      `).run(totalObj, totalScore, userId, now, examId, studentId);

      updatedCount++;
    }
  });

  transaction();
  recomputeRankings(db, examId);

  res.json({ ok: true, updatedCount, modifiedAnswers: Object.keys(answerUpdates).length });
});

// ── 重算排名 ──────────────────────────────────────
function recomputeRankings(db: ReturnType<typeof getDatabase>, examId: number) {
  const allStudents = db.prepare(`
    SELECT id, total_score FROM student_scores WHERE exam_id = ? ORDER BY total_score DESC
  `).all(examId) as Array<{ id: number; total_score: number }>;

  if (allStudents.length === 0) return;

  const n = allStudents.length;
  const updateRank = db.prepare("UPDATE student_scores SET rank = ?, percentile = ? WHERE id = ?");

  allStudents.forEach((s, i) => {
    const rank = i + 1;
    const percentile = n > 1 ? Math.round((1 - i / n) * 1000) / 10 : 100;
    updateRank.run(rank, percentile, s.id);
  });
}

export default router;
