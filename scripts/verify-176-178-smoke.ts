/**
 * Issue #176 + #178 冒烟验证
 * ----------------------------------------------------------------
 * #176：知识点聚合返回难度系数 P 与区分度 D（极端组法逐题均值）。
 * #178：考试模式双权限 —— quiz（晨测）对教师全量可见，
 *       formal（大考）继续走 teacher_role / teacher_permissions 精细过滤。
 *
 * 运行：npm run verify:176-178
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 必须在导入任何 db 模块前设置数据库路径（getDatabase 在模块求值期读取该变量）
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-176-178-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "smoke.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

async function main(): Promise<void> {
  console.log(`使用临时数据库: ${process.env.PROJECTX_DB_PATH}`);

  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import(
    "../src/server/db/index"
  );
  const { loadRolePermissions, ROLE_IDS, TEACHER_ROLES } = await import(
    "../src/server/auth/permissions"
  );
  const { ExamRepository } = await import("../src/server/repositories/ExamRepository");
  const { KnowledgePointRepository } = await import("../src/server/repositories/KnowledgePointRepository");
  const { getVisibleExamIds } = await import("../src/apps/answer-card/server/middleware");

  initializeDatabase();
  await ensureDefaultAdmin();
  loadRolePermissions(true);
  const db = getDatabase();

  // ── #178 考试模式双权限 ─────────────────────────────────
  section("#178 考试模式切换（晨测全量 / 大考精细）");
  const gradeId = Number(
    db.prepare("INSERT INTO grades (name) VALUES (?)").run("高一年级").lastInsertRowid
  );
  db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, ?)").run(gradeId, "1班");
  const teacherId = Number(
    db.prepare(
      "INSERT INTO users (username, password_hash, name, role_id, teacher_role, subject) VALUES ('T178', 'x', '受限教师', ?, ?, ?)"
    ).run(ROLE_IDS.TEACHER, TEACHER_ROLES.SUBJECT_TEACHER, "数学").lastInsertRowid
  );
  db.prepare(
    "INSERT INTO answer_cards (id, title, subject, subject_label) VALUES ('C0000001', '数学卡', 'shuxue', '数学')"
  ).run();

  const examRepo = new ExamRepository();
  const quiz = await examRepo.createExam({
    name: "晨测-176-178",
    card_id: "C0000001",
    subject: "数学",
    exam_mode: "quiz"
  });
  const formal = await examRepo.createExam({
    name: "大考-176-178",
    card_id: "C0000001",
    subject: "数学",
    exam_mode: "formal"
  });

  ok(quiz.exam_mode === "quiz", "创建晨测考试写入 exam_mode=quiz");
  ok(formal.exam_mode === "formal", "创建大考考试写入 exam_mode=formal");
  const defaultExam = await examRepo.createExam({
    name: "默认-176-178",
    card_id: "C0000001",
    subject: "数学"
  });
  ok(defaultExam.exam_mode === "formal", "未指定模式时默认 formal（保持精细权限语义）");

  const teacherUser = {
    id: teacherId,
    role_name: "teacher",
    teacher_role: TEACHER_ROLES.SUBJECT_TEACHER,
    subject: "数学"
  } as any;

  const visible1 = await getVisibleExamIds(teacherUser);
  ok(Array.isArray(visible1) && visible1.includes(quiz.id), "晨测考试对受限教师全量可见");
  ok(Array.isArray(visible1) && !visible1.includes(formal.id), "大考考试对受限教师不可见");

  db.prepare("UPDATE exams SET exam_mode = 'formal' WHERE id = ?").run(quiz.id);
  const visible2 = await getVisibleExamIds(teacherUser);
  ok(Array.isArray(visible2) && !visible2.includes(quiz.id), "晨测切换为大考后不再全量可见");
  db.prepare("UPDATE exams SET exam_mode = 'quiz' WHERE id = ?").run(quiz.id);

  // ── #176 知识点难度 / 区分度 ────────────────────────────
  section("#176 知识点难度 P / 区分度 D");
  const cases: Array<[number, number, number]> = [
    [1, 90, 10],
    [2, 60, 6],
    [3, 30, 3],
  ];
  for (const [no, total, score] of cases) {
    const sid = Number(
      db.prepare(
        "INSERT INTO users (username, password_hash, name, role_id, student_number) VALUES (?, 'x', ?, ?, ?)"
      ).run(`S${no}`, `学生${no}`, ROLE_IDS.STUDENT, `S00${no}`).lastInsertRowid
    );
    db.prepare("INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?, ?, ?)")
      .run(quiz.id, sid, total);
    db.prepare(
      "INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type) VALUES (?, ?, 1, ?, 10, 'objective')"
    ).run(quiz.id, sid, score);
  }
  db.prepare("INSERT INTO knowledge_points (card_id, question_number, point_text) VALUES ('C0000001', 1, '函数')")
    .run();

  const kpRepo = new KnowledgePointRepository();
  const weaknesses = await kpRepo.getWeaknessesForExam(quiz.id);
  ok(weaknesses.length === 1, "知识点聚合返回 1 条");
  const kp = weaknesses[0];
  ok(kp.avg_rate > 63 && kp.avg_rate < 64, `知识点得分率 ≈63.3（实际 ${kp.avg_rate}）`);
  ok(
    kp.difficulty != null && Math.abs(kp.difficulty - 0.633) < 0.001,
    `知识点难度 P ≈0.633（实际 ${kp.difficulty}）`
  );
  ok(
    kp.discrimination != null && Math.abs(kp.discrimination - 0.7) < 0.001,
    `知识点区分度 D ≈0.7（实际 ${kp.discrimination}）`
  );

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  closeDatabase();
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
