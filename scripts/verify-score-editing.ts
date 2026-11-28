/**
 * 成绩修改真实行为回归：真实 SQLite + HTTP 路由 + 真实事务/排名/公布策略。
 * 不使用 mock，不检查源码文本；临时库位于 node_modules/.cache，避免系统临时目录。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import express from "express";
import { isLegalObjectiveScore, objectiveScoreCandidates } from "../src/shared/grading";

const cacheRoot = path.join(process.cwd(), "node_modules", ".cache");
mkdirSync(cacheRoot, { recursive: true });
const tempDir = mkdtempSync(path.join(cacheRoot, "verify-score-editing-"));
process.env.PROJECTX_DB_PATH = path.join(tempDir, "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tempDir, "data");
process.env.PROJECTX_TOKEN_DIR = path.join(tempDir, "tokens");
process.env.PROJECTX_AUTH_ENFORCE = "1";
process.env.PROJECTX_ENABLE_SCANNER = "false";
process.env.PROJECTX_ENABLE_SCANNER_CLIENT_API = "true";
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST"
]) delete process.env[key];

let passed = 0;
const failures: string[] = [];
function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function section(label: string): void {
  console.log(`\n== ${label} ==`);
}

async function main(): Promise<void> {
  let server: Server | undefined;
  const {
    initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase, hashPassword
  } = await import("../src/server/db/index");
  const scoreEditingRouter = (await import("../src/server/routes/score-editing")).default;
  const { authService } = await import("../src/server/services/AuthService");
  const { UserRepository } = await import("../src/server/repositories/UserRepository");
  const { dualAuth } = await import("../src/server/middleware/scanner-auth");

  try {
    initializeDatabase();
    await ensureDefaultAdmin();
    const db = getDatabase();
    const adminPassword = "ScoreEditing-Regression-2026!";
    db.prepare("UPDATE users SET password_hash = ?, password_change_required = 0 WHERE username = 'admin'")
      .run(await hashPassword(adminPassword));
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number };
    const adminToken = (await authService.login("admin", adminPassword)).token!;
    const users = new UserRepository();
    const studentA = await users.createUser({
      username: "score-edit-a", password: "student-pass", name: "学生甲", role_id: 3, student_number: "SE-A"
    });
    const studentB = await users.createUser({
      username: "score-edit-b", password: "student-pass", name: "学生乙", role_id: 3, student_number: "SE-B"
    });
    const blockTeacher = await users.createUser({
      username: "score-block-teacher", password: "teacher-pass", name: "题块教师", role_id: 2,
      teacher_role: "subject_teacher", subject: "数学"
    });
    const studentAToken = (await authService.login(studentA.username, "student-pass")).token!;
    const blockTeacherToken = (await authService.login(blockTeacher.username, "teacher-pass")).token!;

    const gradeId = Number(db.prepare("INSERT INTO grades (name) VALUES (?)").run("成绩改分验证年级").lastInsertRowid);
    const classId = Number(db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, ?)")
      .run(gradeId, "成绩改分验证班").lastInsertRowid);
    db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classId, studentA.id);
    db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classId, studentB.id);
    db.prepare(
      `INSERT INTO teacher_permissions
       (teacher_id, grade_id, subject, class_id, block_id, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign)
       VALUES (?, ?, ?, ?, ?, 1, 1, 1, 1, 1)`
    ).run(blockTeacher.id, gradeId, "数学", classId, "obj-score-answer-card");

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/exams", dualAuth, scoreEditingRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    async function api(
      token: string,
      route: string,
      method: "GET" | "POST" | "PUT" = "GET",
      body?: unknown
    ): Promise<{ status: number; body: any }> {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const text = await response.text();
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed };
    }

    function createCard(cardId: string): void {
      const objectiveBlockId = `obj-${cardId}`;
      const subjectiveBlockId = `subj-${cardId}`;
      db.prepare("INSERT INTO answer_cards (id, title, subject, subject_label) VALUES (?, ?, ?, ?)")
        .run(cardId, "成绩修改行为验证卡", "shuxue", "数学");
      db.prepare(
        `INSERT INTO objective_blocks
         (id, card_id, sort_order, title, question_start, question_count, option_count, mode, score_per_question)
         VALUES (?, ?, 0, '客观题', 1, 2, 4, 'multiple', 5)`
      ).run(objectiveBlockId, cardId);
      db.prepare(
        `INSERT INTO objective_questions (block_id, question_number, sort_order, mode, option_count, score, scoring_rule_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(objectiveBlockId, 1, 0, "single", 4, 5, null);
      db.prepare(
        `INSERT INTO objective_questions (block_id, question_number, sort_order, mode, option_count, score, scoring_rule_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(objectiveBlockId, 2, 1, "multiple", 4, 5, JSON.stringify({ type: "fixed_partial", partialScore: 3 }));
      db.prepare("INSERT INTO objective_answer_keys (block_id, question_number, correct_options) VALUES (?, ?, ?)")
        .run(objectiveBlockId, 1, JSON.stringify(["A"]));
      db.prepare("INSERT INTO objective_answer_keys (block_id, question_number, correct_options) VALUES (?, ?, ?)")
        .run(objectiveBlockId, 2, JSON.stringify(["A", "B"]));
      db.prepare(
        `INSERT INTO subjective_blocks (id, card_id, sort_order, block_kind, title) VALUES (?, ?, 1, 'answer', '主观题')`
      ).run(subjectiveBlockId, cardId);
      db.prepare(
        `INSERT INTO subjective_questions (id, block_id, number, score, style, kind, sort_order)
         VALUES (?, ?, 3, 10, 'manual_score_grid', 'plain_box', 0)`
      ).run(`subj-q3-${cardId}`, subjectiveBlockId);
    }

    function createExam(cardId: string, name: string, published = 0): number {
      return Number(db.prepare(
        `INSERT INTO exams (name, card_id, grade_id, class_id, subject, status, score_published, created_by)
         VALUES (?, ?, ?, ?, ?, 'closed', ?, ?)`
      ).run(name, cardId, gradeId, classId, "数学", published, admin.id).lastInsertRowid);
    }

    function seedStudentScore(examId: number, studentId: number, objective: number, subjective: number): void {
      db.prepare(
        `INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score)
         VALUES (?, ?, ?, ?, ?)`
      ).run(examId, studentId, objective, subjective, objective + subjective);
    }

    function seedQuestionScore(options: {
      examId: number; studentId: number; questionNumber: number; scoreType: "objective" | "subjective";
      score: number; maxScore: number; selectedOptions?: string[]; manual?: boolean; modifiedBy?: number;
      modifiedAt?: string; blockId?: string;
    }): void {
      const exam = db.prepare("SELECT card_id FROM exams WHERE id = ?").get(options.examId) as { card_id: string };
      const defaultBlockId = options.scoreType === "objective" ? `obj-${exam.card_id}` : `subj-${exam.card_id}`;
      db.prepare(
        `INSERT INTO question_scores
         (exam_id, student_id, question_number, block_id, score, max_score, score_type, selected_options,
          manually_modified, modified_by, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        options.examId, options.studentId, options.questionNumber,
        options.blockId ?? defaultBlockId,
        options.score, options.maxScore, options.scoreType,
        options.selectedOptions ? JSON.stringify(options.selectedOptions) : null,
        options.manual ? 1 : 0, options.modifiedBy ?? null, options.modifiedAt ?? null
      );
    }

    function setPublication(examId: number, published: number, autoUnpublish: boolean): void {
      db.prepare("INSERT OR REPLACE INTO system_settings (`key`, value) VALUES ('auto_unpublish_on_score_change', ?)")
        .run(autoUnpublish ? "1" : "0");
      db.prepare("UPDATE exams SET score_published = ? WHERE id = ?").run(published, examId);
      db.prepare("DELETE FROM exam_publish_events WHERE exam_id = ?").run(examId);
    }

    function snapshotExam(examId: number) {
      return {
        questions: db.prepare("SELECT * FROM question_scores WHERE exam_id = ? ORDER BY id").all(examId),
        students: db.prepare("SELECT * FROM student_scores WHERE exam_id = ? ORDER BY student_id").all(examId),
        audits: db.prepare("SELECT * FROM answer_overrides WHERE exam_id = ? ORDER BY id").all(examId),
        publishEvents: db.prepare("SELECT * FROM exam_publish_events WHERE exam_id = ? ORDER BY id").all(examId)
      };
    }

    section("共享合法分值与后端逐题校验");
    check(JSON.stringify(objectiveScoreCandidates(5, 3, "multiple")) === JSON.stringify([0, 3, 5]),
      "多选 max=5/step=3 候选为 0、3、5，包含满分且不越界");
    check(isLegalObjectiveScore(3, 5, 3, "multiple") && isLegalObjectiveScore(5, 5, 3, "multiple") &&
      !isLegalObjectiveScore(4, 5, 3, "multiple"), "共享合法分值函数接受 3/5 并拒绝 4");

    section("答案重算只改动真实变化题");
    createCard("score-answer-card");
    const answerExam = createExam("score-answer-card", "答案重算验证", 1);
    setPublication(answerExam, 1, false);
    seedStudentScore(answerExam, studentA.id, 0, 0);
    seedQuestionScore({
      examId: answerExam, studentId: studentA.id, questionNumber: 1, scoreType: "objective",
      score: 5, maxScore: 5, selectedOptions: ["B"], manual: true, modifiedBy: admin.id,
      modifiedAt: "2026-01-01 01:02:03"
    });
    seedQuestionScore({
      examId: answerExam, studentId: studentA.id, questionNumber: 2, scoreType: "objective",
      score: 3, maxScore: 5, selectedOptions: ["A"], manual: true, modifiedBy: blockTeacher.id,
      modifiedAt: "2026-01-02 03:04:05"
    });
    seedQuestionScore({
      examId: answerExam, studentId: studentA.id, questionNumber: 3, scoreType: "subjective",
      score: 4, maxScore: 10, manual: true, modifiedBy: blockTeacher.id,
      modifiedAt: "2026-01-03 04:05:06"
    });
    db.prepare("UPDATE student_scores SET objective_score = 8, subjective_score = 4, total_score = 12 WHERE exam_id = ? AND student_id = ?")
      .run(answerExam, studentA.id);
    const preservedQ2 = db.prepare("SELECT * FROM question_scores WHERE exam_id = ? AND question_number = 2").get(answerExam);
    const preservedQ3 = db.prepare("SELECT * FROM question_scores WHERE exam_id = ? AND question_number = 3").get(answerExam);

    const answerResult = await api(adminToken, `/api/exams/${answerExam}/answers`, "PUT", { answers: { "1": ["b"] } });
    check(answerResult.status === 200 && answerResult.body.updatedCount === 1 && answerResult.body.modifiedAnswers === 1,
      "答案真实变化时仅重算该题并返回一名学生");
    const recalculatedQ1 = db.prepare(
      "SELECT * FROM question_scores WHERE exam_id = ? AND question_number = 1 AND score_type = 'objective'"
    ).get(answerExam) as any;
    check(recalculatedQ1.score === 5 && recalculatedQ1.manually_modified === 0 &&
      recalculatedQ1.selected_options === JSON.stringify(["B"]) && recalculatedQ1.modified_by === admin.id &&
      recalculatedQ1.modified_at !== "2026-01-01 01:02:03",
      "被重算题清除人工标记、记录修改人/时间并保留学生选项");
    check(JSON.stringify(db.prepare("SELECT * FROM question_scores WHERE exam_id = ? AND question_number = 2").get(answerExam)) ===
      JSON.stringify(preservedQ2), "另一道客观题的人工分数、标记、修改人与时间完全不变");
    check(JSON.stringify(db.prepare("SELECT * FROM question_scores WHERE exam_id = ? AND question_number = 3").get(answerExam)) ===
      JSON.stringify(preservedQ3), "主观题整行保持不变");
    const answerAudit = db.prepare(
      "SELECT override_type FROM answer_overrides WHERE exam_id = ? AND question_number = 1 ORDER BY id"
    ).all(answerExam) as Array<{ override_type: string }>;
    check(answerAudit.some((row) => row.override_type === "answer") && answerAudit.some((row) => row.override_type === "score"),
      "答案变化与被重算题均写审计");
    const answerTotal = db.prepare("SELECT * FROM student_scores WHERE exam_id = ? AND student_id = ?")
      .get(answerExam, studentA.id) as any;
    check(answerTotal.objective_score === 8 && answerTotal.subjective_score === 4 && answerTotal.total_score === 12,
      "总分按 question_scores 汇总客观、主观与总分");
    check(db.prepare("SELECT score_published FROM exams WHERE id = ?").get(answerExam)?.score_published === 1 &&
      db.prepare("SELECT COUNT(*) AS c FROM exam_publish_events WHERE exam_id = ?").get(answerExam)?.c === 0,
      "默认保持公布策略下答案重算不撤回、不写撤回审计");

    const detail = await api(adminToken, `/api/exams/${answerExam}/student/${studentA.id}/scores`);
    const detailQ2 = detail.body.questionScores.find((row: any) => row.question_number === 2);
    check(detail.status === 200 && detailQ2.step === 3, "学生详情返回共享规则导出的步进值 3");
    const beforeIllegal = db.prepare("SELECT * FROM question_scores WHERE exam_id = ? AND question_number = 2").get(answerExam);
    const illegalScore = await api(adminToken, `/api/exams/${answerExam}/student/${studentA.id}/scores`, "PUT", {
      scores: [{ questionNumber: 2, scoreType: "objective", score: 4 }]
    });
    check(illegalScore.status === 400 &&
      JSON.stringify(db.prepare("SELECT * FROM question_scores WHERE exam_id = ? AND question_number = 2").get(answerExam)) ===
      JSON.stringify(beforeIllegal), "后端拒绝合法候选之外的分值且不写入");
    const legalScore = await api(adminToken, `/api/exams/${answerExam}/student/${studentA.id}/scores`, "PUT", {
      scores: [{ questionNumber: 2, scoreType: "objective", score: 5 }]
    });
    check(legalScore.status === 200 && legalScore.body.updatedCount === 1 &&
      db.prepare("SELECT score FROM question_scores WHERE exam_id = ? AND question_number = 2").get(answerExam)?.score === 5,
      "后端接受包含满分的合法分值");

    section("重复提交不变更不写成绩、不清标记、不撤回");
    setPublication(answerExam, 1, true);
    const cardRevisionBefore = db.prepare("SELECT revision FROM answer_cards WHERE id = ?").get("score-answer-card")?.revision;
    const beforeNoopScore = snapshotExam(answerExam);
    const noopScore = await api(adminToken, `/api/exams/${answerExam}/student/${studentA.id}/scores`, "PUT", {
      scores: [{ questionNumber: 2, scoreType: "objective", score: 5 }]
    });
    check(noopScore.status === 200 && noopScore.body.updatedCount === 0 &&
      JSON.stringify(snapshotExam(answerExam)) === JSON.stringify(beforeNoopScore),
      "逐题同分重复提交不写逐题、总分、审计或公布事件");
    const beforeNoopAnswer = snapshotExam(answerExam);
    const noopAnswer = await api(adminToken, `/api/exams/${answerExam}/answers`, "PUT", { answers: { "1": ["B"] } });
    check(noopAnswer.status === 200 && noopAnswer.body.updatedCount === 0 && noopAnswer.body.modifiedAnswers === 0 &&
      JSON.stringify(snapshotExam(answerExam)) === JSON.stringify(beforeNoopAnswer) &&
      db.prepare("SELECT revision FROM answer_cards WHERE id = ?").get("score-answer-card")?.revision === cardRevisionBefore &&
      db.prepare("SELECT score_published FROM exams WHERE id = ?").get(answerExam)?.score_published === 1,
      "答案相同重复提交不改卡版本、成绩、人工标记或已公布状态");

    section("批量送分/加分：权限、夹值、审计、排名与两种公布策略");
    createCard("score-batch-keep-card");
    const batchKeepExam = createExam("score-batch-keep-card", "批量改分保持公布", 1);
    setPublication(batchKeepExam, 1, false);
    seedStudentScore(batchKeepExam, studentA.id, 9, 0);
    seedStudentScore(batchKeepExam, studentB.id, 1, 0);
    for (const [studentId, q1, q3] of [[studentA.id, 0, 9], [studentB.id, 0, 1]] as const) {
      seedQuestionScore({ examId: batchKeepExam, studentId, questionNumber: 1, scoreType: "objective", score: q1, maxScore: 5, selectedOptions: ["A"] });
      seedQuestionScore({ examId: batchKeepExam, studentId, questionNumber: 3, scoreType: "subjective", score: q3, maxScore: 10 });
    }
    db.prepare("INSERT INTO review_assignments (exam_id, block_id, teacher_id) VALUES (?, ?, ?)")
      .run(batchKeepExam, "obj-score-batch-keep-card", blockTeacher.id);
    const batchBody = {
      studentIds: [studentA.id, studentB.id],
      scores: [
        { questionNumber: 1, scoreType: "objective", operation: "full" },
        { questionNumber: 3, scoreType: "subjective", operation: "add", amount: 5 }
      ]
    };
    const beforePermission = snapshotExam(batchKeepExam);
    const blockDenied = await api(blockTeacherToken, `/api/exams/${batchKeepExam}/scores/batch`, "POST", batchBody);
    const studentDenied = await api(studentAToken, `/api/exams/${batchKeepExam}/scores/batch`, "POST", batchBody);
    check(blockDenied.status === 403 && studentDenied.status === 403 &&
      JSON.stringify(snapshotExam(batchKeepExam)) === JSON.stringify(beforePermission),
      "题块级教师与学生批量改分均 403，且没有任何写入");

    const batchKeep = await api(adminToken, `/api/exams/${batchKeepExam}/scores/batch`, "POST", batchBody);
    check(batchKeep.status === 200 && batchKeep.body.updatedCount === 4 && batchKeep.body.updatedStudents === 2,
      "两名学生各两道题批量提交成功");
    const batchRowsA = db.prepare(
      "SELECT question_number, score, manually_modified FROM question_scores WHERE exam_id = ? AND student_id = ? ORDER BY question_number"
    ).all(batchKeepExam, studentA.id) as any[];
    const batchRowsB = db.prepare(
      "SELECT question_number, score, manually_modified FROM question_scores WHERE exam_id = ? AND student_id = ? ORDER BY question_number"
    ).all(batchKeepExam, studentB.id) as any[];
    check(batchRowsA[0].score === 5 && batchRowsA[1].score === 10 && batchRowsB[0].score === 5 && batchRowsB[1].score === 6 &&
      batchRowsA.every((row) => row.manually_modified === 1) && batchRowsB.every((row) => row.manually_modified === 1),
      "送分设满分，加分基于当前分并夹到满分，逐题标记人工修改");
    const batchTotals = db.prepare(
      "SELECT student_id, objective_score, subjective_score, total_score, `rank`, manually_modified FROM student_scores WHERE exam_id = ? ORDER BY student_id"
    ).all(batchKeepExam) as any[];
    check(batchTotals[0].total_score === 15 && batchTotals[1].total_score === 11 &&
      batchTotals[0].rank === 1 && batchTotals[1].rank === 2 && batchTotals.every((row) => row.manually_modified === 1),
      `批量后按逐题汇总总分并一次得到正确排名 (${JSON.stringify(batchTotals)})`);
    check(db.prepare("SELECT COUNT(*) AS c FROM answer_overrides WHERE exam_id = ?").get(batchKeepExam)?.c === 4,
      "每道实际变化的逐题成绩写一条审计");
    check(db.prepare("SELECT score_published FROM exams WHERE id = ?").get(batchKeepExam)?.score_published === 1 &&
      db.prepare("SELECT COUNT(*) AS c FROM exam_publish_events WHERE exam_id = ?").get(batchKeepExam)?.c === 0,
      "默认策略批量改分保持公布且不写撤回事件");

    createCard("score-batch-unpublish-card");
    const batchUnpublishExam = createExam("score-batch-unpublish-card", "批量改分自动撤回", 1);
    setPublication(batchUnpublishExam, 1, true);
    seedStudentScore(batchUnpublishExam, studentA.id, 0, 0);
    seedStudentScore(batchUnpublishExam, studentB.id, 0, 0);
    for (const studentId of [studentA.id, studentB.id]) {
      seedQuestionScore({ examId: batchUnpublishExam, studentId, questionNumber: 1, scoreType: "objective", score: 0, maxScore: 5, selectedOptions: ["A"] });
      seedQuestionScore({ examId: batchUnpublishExam, studentId, questionNumber: 3, scoreType: "subjective", score: 1, maxScore: 10 });
    }
    const batchUnpublish = await api(adminToken, `/api/exams/${batchUnpublishExam}/scores/batch`, "POST", {
      studentIds: [studentA.id, studentB.id],
      scores: [{ questionNumber: 1, scoreType: "objective", operation: "full" }]
    });
    const unpublishEvents = db.prepare(
      "SELECT action, reason FROM exam_publish_events WHERE exam_id = ?"
    ).all(batchUnpublishExam) as Array<{ action: string; reason: string }>;
    check(batchUnpublish.status === 200 && batchUnpublish.body.updatedStudents === 2 &&
      db.prepare("SELECT score_published FROM exams WHERE id = ?").get(batchUnpublishExam)?.score_published === 0 &&
      unpublishEvents.length === 1 && unpublishEvents[0].action === "unpublish",
      "自动撤回策略下多人多题批量改分只撤回一次并写一次事件");

    section("批量校验失败整批回滚");
    createCard("score-batch-rollback-card");
    const rollbackExam = createExam("score-batch-rollback-card", "批量改分回滚验证", 1);
    setPublication(rollbackExam, 1, true);
    seedStudentScore(rollbackExam, studentA.id, 9, 0);
    seedStudentScore(rollbackExam, studentB.id, 0, 0);
    seedQuestionScore({ examId: rollbackExam, studentId: studentA.id, questionNumber: 1, scoreType: "objective", score: 0, maxScore: 5, selectedOptions: ["A"] });
    seedQuestionScore({ examId: rollbackExam, studentId: studentB.id, questionNumber: 1, scoreType: "objective", score: 0, maxScore: 5, selectedOptions: ["A"] });
    seedQuestionScore({ examId: rollbackExam, studentId: studentA.id, questionNumber: 2, scoreType: "objective", score: 0, maxScore: 5, selectedOptions: ["A"] });
    seedQuestionScore({ examId: rollbackExam, studentId: studentA.id, questionNumber: 3, scoreType: "subjective", score: 9, maxScore: 10 });
    const beforeInvalidBatch = snapshotExam(rollbackExam);
    const invalidObjectiveBatch = await api(adminToken, `/api/exams/${rollbackExam}/scores/batch`, "POST", {
      studentIds: [studentA.id],
      scores: [{ questionNumber: 2, scoreType: "objective", operation: "add", amount: 1 }]
    });
    check(invalidObjectiveBatch.status === 400 && JSON.stringify(snapshotExam(rollbackExam)) === JSON.stringify(beforeInvalidBatch),
      "批量加分得到非法客观目标分时整批拒绝且不写入");
    const rollback = await api(adminToken, `/api/exams/${rollbackExam}/scores/batch`, "POST", {
      studentIds: [studentA.id, studentB.id],
      scores: [
        { questionNumber: 1, scoreType: "objective", operation: "full" },
        { questionNumber: 3, scoreType: "subjective", operation: "add", amount: 2 }
      ]
    });
    check(rollback.status === 404 && JSON.stringify(snapshotExam(rollbackExam)) === JSON.stringify(beforeInvalidBatch) &&
      db.prepare("SELECT score_published FROM exams WHERE id = ?").get(rollbackExam)?.score_published === 1,
      "任一学生缺逐题成绩时整批回滚，已校验学生的送分也不落库、不撤回");

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAILED: ${failure}`);
      process.exitCode = 1;
    }
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    closeDatabase();
    try { rmSync(tempDir, { recursive: true, force: true }); }
    catch { /* Windows 可能仍有文件句柄，验证结果不受影响 */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
