import { databaseTimestamp } from "../db/timestamp";
import type { CombinedStudentResult } from "../../shared/grading";
export async function persistScannerResultToMainDb(
    cardId: string,
    result: CombinedStudentResult,
    requireExam = false
  ): Promise<number> {
    if (!result.studentId || result.studentId === "未识别") { if (requireExam) throw new Error("学号未识别，成绩未入库"); return 0; }

    const { getMysqlDb, buildUpsertSQL } = await import("../db");
    const { roundScore } = await import("./rankingUpdate");
    const { analysisCache } = await import("./analysisCache");
    const { ensureExamParticipants, isExamParticipant } = await import("./examParticipants");
    const db = getMysqlDb();

    const scoreUpsertSQL = buildUpsertSQL(
      db.dialect,
      "student_scores",
      ["exam_id", "student_id", "objective_score", "subjective_score", "total_score", "graded_at"],
      ["exam_id", "student_id"],
      ["objective_score", "subjective_score", "total_score", "graded_at"]
    );
    const questionUpsertSQL = buildUpsertSQL(
      db.dialect,
      "question_scores",
      ["exam_id", "student_id", "question_number", "question_id", "score", "max_score", "score_type", "selected_options"],
      ["exam_id", "student_id", "question_number", "score_type"],
      ["question_id", "score", "max_score", "selected_options"]
    );
    const gradedAt = databaseTimestamp();

    // Find user by student_number
    const user = await db.get("SELECT id FROM users WHERE student_number = ?", result.studentId) as { id: number } | undefined;
    if (!user) { if (requireExam) throw new Error(`学号 ${result.studentId} 不在学生名单中，成绩未入库`); return 0; }

    // Find exams linked to this card
    const exams = await db.all("SELECT e.id FROM exams e WHERE e.card_id = ? AND e.status != 'closed' AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)", cardId) as Array<{ id: number }>;
    if (exams.length === 0) { if (requireExam) throw new Error("答题卡未关联可阅卷的考试，成绩未入库"); return 0; }

    // P1-1: 扫描入库拒绝非应考学生（名单可知时）
    const filteredExams: Array<{ id: number }> = [];
    for (const exam of exams) {
      const snap = await ensureExamParticipants(db, exam.id);
      const enforced = snap.rosterKnown && snap.participantCount > 0;
      if (enforced && !(await isExamParticipant(db, exam.id, user.id))) {
        console.warn(`[Scanner] skip exam ${exam.id}: student ${result.studentId} not in roster snapshot`);
        continue;
      }
      filteredExams.push(exam);
    }
    if (filteredExams.length === 0) { if (requireExam) throw new Error(`学号 ${result.studentId} 不在关联考试的应考名单中`); return 0; }

    // 事务化：一个学生跨所有关联考试的写构成一个原子单元，
    // 避免中途崩溃留下 student_scores 已写、question_scores 缺行的脏数据污染后续分析
    // （难度/区分度/逐题统计都依赖两表一致）。
    await db.transaction(async (tx) => {
      for (const exam of filteredExams) {
        const obj = roundScore(result.objectiveScore);
        const subj = roundScore(result.subjectiveScore);
        const total = roundScore(result.totalScore);
        await tx.run(scoreUpsertSQL, exam.id, user.id, obj, subj, total, gradedAt);

        for (const q of result.objectiveQuestions) {
          await tx.run(
            questionUpsertSQL,
            exam.id, user.id, q.questionNumber, "", q.score, q.maxScore, "objective", JSON.stringify(q.selectedOptions)
          );
        }
        for (const sq of result.subjectiveQuestions) {
          await tx.run(
            questionUpsertSQL,
            exam.id, user.id, String(sq.questionNumber), sq.questionId, sq.score, sq.maxScore, "subjective", null
          );
        }

        await tx.run(
          "UPDATE exams SET status = 'grading', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'",
          exam.id
        );
      }
    });

    // 分析结果缓存精准失效（建议 6）
    for (const exam of filteredExams) analysisCache.invalidateExam(exam.id);
    return filteredExams.length;
  }

