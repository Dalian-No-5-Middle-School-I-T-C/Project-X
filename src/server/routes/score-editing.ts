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
import { CardRepository } from "../repositories/CardRepository";
import { listAnswerBlockCropsForStudent } from "../services/AnswerBlockCropService";
import { recomputeExamRankings, roundScore } from "../services/rankingUpdate";
import { analysisCache } from "../services/analysisCache";
import { resolveReviewConfidenceThreshold } from "../services/userSettings";
import { requireExamAccess } from "../../apps/answer-card/server/middleware";
import {
  objectiveQuestionDefinitions,
  gradeObjectiveQuestion,
} from "../../shared/grading";
import type { AnswerCard, ObjectiveRecognitionQuestion } from "../../shared/types";

const router = express.Router();

// ── 搜索考生（考号/姓名） ──────────────────────────
router.get("/:examId/students/search", requireExamAccess, async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const q = (req.query.q as string || "").trim();
  if (!Number.isFinite(examId) || !q) {
    res.status(400).json({ message: "非法参数" });
    return;
  }

  const db = getMysqlDb();
  // 转义 LIKE 通配符，避免用户输入 % / _ 时匹配到无关学生
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  const students = await db.all(`
    SELECT DISTINCT u.id, u.name, u.student_number
    FROM student_scores ss
    JOIN users u ON u.id = ss.student_id
    WHERE ss.exam_id = ? AND (u.student_number = ? OR u.name LIKE ? ESCAPE '\\')
    ORDER BY u.student_number
    LIMIT 20
  `, examId, q, `%${escaped}%`) as Array<{ id: number; name: string; student_number: string | null }>;

  res.json(students.map((s) => ({
    id: s.id,
    name: s.name,
    studentNumber: s.student_number ?? ""
  })));
});

// ── 获取某学生全部题目得分 + 答题卡图片路径 ──────────
router.get("/:examId/student/:studentId/scores", requireExamAccess, async (req: Request, res: Response) => {
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
           selected_options, manually_modified, modified_at
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

  // v29: 优先从 question_scores.selected_options 构造 recognition（主数据源）；
  // objective_recognitions 仅作为历史遗留数据与 confidence 的回退来源。
  const recognitionMap = new Map<number, { selectedOptions: string[]; confidence: number }>();
  for (const qs of questionScores) {
    if (qs.score_type !== "objective" || qs.selected_options == null) continue;
    let opts: string[] = [];
    try { opts = JSON.parse(qs.selected_options); } catch { opts = []; }
    recognitionMap.set(qs.question_number, { selectedOptions: opts, confidence: 1 });
  }

  const recognitionRows = await db.all(`
    SELECT orr.question_number, orr.selected_options, orr.confidence
    FROM objective_recognitions orr
    JOIN scan_records sr ON sr.id = orr.record_id
    JOIN scan_batches sb ON sb.id = sr.batch_id
    WHERE sb.exam_id = ? AND sr.student_id = ?
    ORDER BY orr.confidence DESC
  `, examId, studentId) as any[];

  for (const r of recognitionRows) {
    const existing = recognitionMap.get(r.question_number);
    if (existing) {
      // 已有 question_scores 数据，仅补充真实置信度
      existing.confidence = r.confidence ?? existing.confidence;
      continue;
    }
    recognitionMap.set(r.question_number, {
      selectedOptions: r.selected_options ? JSON.parse(r.selected_options) : [],
      confidence: r.confidence
    });
  }

  const answerBlocks = await listAnswerBlockCropsForStudent(examId, studentId, db);

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
    answerBlocks,
    classQuestionStats,
    cardId
  });
});

// ── 逐题修改分数 ──────────────────────────────────
router.put("/:examId/student/:studentId/scores", requireExamAccess, async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(examId) || !Number.isFinite(studentId)) {
    res.status(400).json({ message: "非法考试或学生 ID" });
    return;
  }

  const updatesRaw = req.body?.scores;
  if (!Array.isArray(updatesRaw) || updatesRaw.length === 0) {
    res.status(400).json({ message: "未提供分数修改数据" });
    return;
  }
  // 逐元素校验，防止非法数据进入 SQL / 计分计算
  for (const u of updatesRaw) {
    if (
      !u || typeof u !== "object" ||
      typeof u.questionNumber !== "number" || !Number.isFinite(u.questionNumber) ||
      typeof u.scoreType !== "string" || u.scoreType.length === 0 ||
      typeof u.score !== "number" || !Number.isFinite(u.score)
    ) {
      res.status(400).json({ message: "分数修改数据格式非法" });
      return;
    }
  }
  const updates = updatesRaw as Array<{ questionNumber: number; scoreType: string; score: number }>;

  const db = getMysqlDb();
  const userId = req.user!.id;
  const now = new Date().toISOString();

  const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
  if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }

  // 校验每道题存在且分数在 [0, max_score] 内，防止负数/超满分写入成绩
  const scoreRows = await db.all(
    "SELECT question_number, score_type, max_score FROM question_scores WHERE exam_id = ? AND student_id = ?",
    examId, studentId
  ) as Array<{ question_number: number; score_type: string; max_score: number }>;
  const maxByKey = new Map<string, number>();
  for (const row of scoreRows) maxByKey.set(`${row.question_number}_${row.score_type}`, Number(row.max_score));
  for (const u of updates) {
    const max = maxByKey.get(`${u.questionNumber}_${u.scoreType}`);
    if (max == null) {
      res.status(400).json({ message: `题号 ${u.questionNumber}（${u.scoreType}）不存在或尚未评分` });
      return;
    }
    if (u.score < 0 || u.score > max) {
      res.status(400).json({ message: `题号 ${u.questionNumber} 的分数需在 [0, ${max}] 范围内` });
      return;
    }
  }

  let assignedScoreWarning: string | undefined;
  await db.transaction(async (tx) => {
    for (const u of updates) {
      const existing = await tx.get(
        "SELECT id, score, max_score FROM question_scores WHERE exam_id = ? AND student_id = ? AND question_number = ? AND score_type = ?",
        examId, studentId, u.questionNumber, u.scoreType
      ) as { id: number; score: number; max_score: number } | undefined;

      if (existing) {
        // P1-7: 分数未变时不标记 manually_modified
        const scoreChanged = existing.score !== u.score;
        await tx.run(
          `UPDATE question_scores SET score = ?, manually_modified = ?, modified_by = ?, modified_at = ?
           WHERE exam_id = ? AND student_id = ? AND question_number = ? AND score_type = ?`,
          u.score, scoreChanged ? 1 : 0, userId, now, examId, studentId, u.questionNumber, u.scoreType
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
    totalObjective = roundScore(totalObjective);
    totalSubjective = roundScore(totalSubjective);
    const newTotal = roundScore(totalObjective + totalSubjective);

    await tx.run(`
      UPDATE student_scores SET objective_score = ?, subjective_score = ?, total_score = ?,
        manually_modified = 1, modified_by = ?, modified_at = ?
      WHERE exam_id = ? AND student_id = ?
    `, totalObjective, totalSubjective, newTotal, userId, now, examId, studentId);

    // P1-8: 排名重算在事务内执行，确保数据一致性
    const recalc = await recomputeExamRankings(tx, examId);
    if (recalc.assignedScoresRecalculated === false) {
      assignedScoreWarning = recalc.assignedScoreError;
    }
  });

  // 分析结果缓存精准失效（建议 6）
  analysisCache.invalidateExam(examId);

  res.json({
    ok: true,
    ...(assignedScoreWarning ? { warnings: { assignedScoreError: assignedScoreWarning } } : {})
  });
});

// ── 获取考试的答题卡答案配置 ──────────────────────
router.get("/:examId/answers", requireExamAccess, async (req: Request, res: Response) => {
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
router.put("/:examId/answers", requireExamAccess, async (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  if (!Number.isFinite(examId)) {
    res.status(400).json({ message: "非法考试 ID" });
    return;
  }

  const answerUpdatesRaw = req.body?.answers;
  if (!answerUpdatesRaw || typeof answerUpdatesRaw !== "object" || Array.isArray(answerUpdatesRaw)) {
    res.status(400).json({ message: "未提供答案修改数据" });
    return;
  }
  const answerEntries = Object.entries(answerUpdatesRaw);
  if (answerEntries.length === 0) {
    res.status(400).json({ message: "未提供答案修改数据" });
    return;
  }
  // 校验题号键为数字、值为字符串数组，防止非法键/值进入答案重写
  for (const [key, val] of answerEntries) {
    if (!/^\d+$/.test(key)) {
      res.status(400).json({ message: `题号非法: ${key}` });
      return;
    }
    if (!Array.isArray(val) || !val.every((x: unknown) => typeof x === "string")) {
      res.status(400).json({ message: `题号 ${key} 的答案必须是字符串数组` });
      return;
    }
  }
  const answerUpdates = answerUpdatesRaw as Record<string, string[]>;

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
  const confidenceThreshold = await resolveReviewConfidenceThreshold(req.user?.id);

  // Build cross-platform upsert SQL for question_scores
  const upsertCols = ["exam_id", "student_id", "question_number", "question_id", "block_id", "score", "max_score", "score_type", "manually_modified", "modified_by", "modified_at", "selected_options"];
  const conflictCols = ["exam_id", "student_id", "question_number", "score_type"];
  const updateCols = ["score", "max_score", "manually_modified", "modified_by", "modified_at", "selected_options"];
  const upsertSQL = buildUpsertSQL(db.dialect, "question_scores", upsertCols, conflictCols, updateCols);

  let assignedScoreWarning: string | undefined;
  await db.transaction(async (tx) => {
    // 答案与重算同事务：任一步失败整体回滚，避免“答案已改但分数未重算”的半更新状态
    await cardRepo.updateCardInTx(card, tx);

    for (const [qNum, newKey] of Object.entries(answerUpdates)) {
      await tx.run(
        `INSERT INTO answer_overrides (exam_id, card_id, question_number, score_type, override_type, old_value, new_value, created_by, created_at)
         VALUES (?, ?, ?, 'objective', 'answer', ?, ?, ?, ?)`,
        examId, exam.card_id, Number(qNum),
        JSON.stringify(oldAnswers[qNum] ?? []), JSON.stringify(newKey), userId, now
      );
    }

    for (const { student_id: studentId } of students) {
      // v29: 学生所选选项改从 question_scores.selected_options 读取
      // （objective_recognitions 在主流程中从未写入，重评分会把全体学生当未作答）
      const optionRows = await tx.all(`
        SELECT question_number, selected_options
        FROM question_scores
        WHERE exam_id = ? AND student_id = ? AND score_type = 'objective' AND selected_options IS NOT NULL
      `, examId, studentId) as any[];

      const recognitionMap = new Map<number, { selectedOptions: string[]; confidence: number }>();
      for (const r of optionRows) {
        let opts: string[] = [];
        try { opts = r.selected_options ? JSON.parse(r.selected_options) : []; } catch { opts = []; }
        recognitionMap.set(r.question_number, { selectedOptions: opts, confidence: 1 });
      }

      // 回退：历史遗留的 objective_recognitions 数据（若存在）
      if (recognitionMap.size === 0) {
        const recognitionRows = await tx.all(`
          SELECT orr.question_number, orr.selected_options, orr.confidence
          FROM objective_recognitions orr
          JOIN scan_records sr ON sr.id = orr.record_id
          JOIN scan_batches sb ON sb.id = sr.batch_id
          WHERE sb.exam_id = ? AND sr.student_id = ?
          ORDER BY orr.confidence DESC
        `, examId, studentId) as any[];

        for (const r of recognitionRows) {
          const existing = recognitionMap.get(r.question_number);
          if (!existing || r.confidence > existing.confidence) {
            recognitionMap.set(r.question_number, {
              selectedOptions: r.selected_options ? JSON.parse(r.selected_options) : [],
              confidence: r.confidence
            });
          }
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
          } as ObjectiveRecognitionQuestion, confidenceThreshold);

          await tx.run(upsertSQL,
            examId, studentId, def.questionNumber, null, block.id,
            grade.score, grade.maxScore, "objective",
            0, userId, now, // Bugfix: 答案key变更触发的自动重评分不应标记 manually_modified=1
            JSON.stringify(rec?.selectedOptions ?? [])
          );
          totalObj += grade.score;
        }
      }

      const subjScore = await tx.get(
        "SELECT COALESCE(SUM(score), 0) as total FROM question_scores WHERE exam_id = ? AND student_id = ? AND score_type = 'subjective'",
        examId, studentId
      ) as { total: number };

      const roundedObj = roundScore(totalObj);
      const roundedSubj = roundScore(Number(subjScore.total ?? 0));
      const totalScore = roundScore(roundedObj + roundedSubj);
      // 答案变更触发的自动重评分不标记 manually_modified（与上方 question_scores 的
      // 0 标记保持一致，避免把整场学生误标为“手动修改”）。
      await tx.run(`
        UPDATE student_scores SET objective_score = ?, subjective_score = ?, total_score = ?,
          modified_by = ?, modified_at = ?
        WHERE exam_id = ? AND student_id = ?
      `, roundedObj, roundedSubj, totalScore, userId, now, examId, studentId);

      updatedCount++;
    }

    // P1-8: 排名重算在事务内执行
    const recalc = await recomputeExamRankings(tx, examId);
    if (recalc.assignedScoresRecalculated === false) {
      assignedScoreWarning = recalc.assignedScoreError;
    }
  });

  // 分析结果缓存精准失效（建议 6）
  analysisCache.invalidateExam(examId);

  res.json({
    ok: true,
    updatedCount,
    modifiedAnswers: Object.keys(answerUpdates).length,
    ...(assignedScoreWarning ? { warnings: { assignedScoreError: assignedScoreWarning } } : {})
  });
});

export default router;
