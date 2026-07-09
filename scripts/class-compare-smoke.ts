/**
 * Smoke test for cross-class deep compare (v1.9.0).
 * Uses a temporary SQLite DB with the real schema, seeds 2 classes × 2 students,
 * then asserts overview / question matrix / knowledge matrix shapes.
 *
 * Run: npx tsx scripts/class-compare-smoke.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-class-compare-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "class-compare.db");
for (const k of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST"
]) delete process.env[k];

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const { initializeDatabase, getDatabase, closeDatabase } = await import("../src/server/db");
  const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");

  initializeDatabase();
  const sqlite = getDatabase();

  sqlite.prepare("INSERT INTO grades (id, name, sort_order) VALUES (1, '高一', 1)").run();
  sqlite.prepare("INSERT INTO classes (id, name, grade_id, sort_order) VALUES (1, '1班', 1, 1), (2, '2班', 1, 2)").run();
  sqlite.prepare("INSERT INTO answer_cards (id, title) VALUES ('88888888', '跨班对比测卷')").run();

  const insUser = sqlite.prepare(
    "INSERT INTO users (id, username, password_hash, name, role_id, student_number) VALUES (?,?,'','',3,?)"
  );
  for (const [sid, num] of [[101, "20260101"], [102, "20260102"], [201, "20260201"], [202, "20260202"]] as const) {
    insUser.run(sid, `u${sid}`, num);
  }
  sqlite.prepare(
    "INSERT INTO class_students (class_id, student_id) VALUES (1, 101), (1, 102), (2, 201), (2, 202)"
  ).run();

  const examId = Number(
    (sqlite.prepare(
      "INSERT INTO exams (name, card_id, grade_id, subject, status) VALUES ('跨班对比测', '88888888', 1, '数学', 'closed')"
    ).run() as { lastInsertRowid: number | bigint }).lastInsertRowid
  );

  const insScore = sqlite.prepare(
    "INSERT INTO student_scores (exam_id, student_id, total_score, objective_score, subjective_score) VALUES (?, ?, ?, ?, ?)"
  );
  // Class 1 stronger overall
  insScore.run(examId, 101, 90, 45, 45);
  insScore.run(examId, 102, 80, 40, 40);
  insScore.run(examId, 201, 70, 30, 40);
  insScore.run(examId, 202, 60, 25, 35);

  const insQs = sqlite.prepare(
    "INSERT INTO question_scores (exam_id, student_id, question_number, score_type, score, max_score) VALUES (?, ?, ?, ?, ?, ?)"
  );
  // Q1: class1 stronger; Q2: class2 stronger
  for (const [sid, q1, q2] of [
    [101, 10, 9], [102, 8, 7], [201, 4, 10], [202, 2, 8]
  ] as const) {
    insQs.run(examId, sid, 1, "objective", q1, 10);
    insQs.run(examId, sid, 2, "subjective", q2, 10);
  }

  sqlite.prepare(
    "INSERT INTO knowledge_points (card_id, question_number, point_text, sort_order) VALUES ('88888888', 1, '函数', 0), ('88888888', 2, '几何', 1)"
  ).run();

  console.log("class-compare smoke");
  const repo = new AnalysisRepository();

  const all = await repo.getCrossClassDeepCompare(examId);
  check("examId 匹配", all.examId === examId, `got ${all.examId}`);
  check("examName", all.examName === "跨班对比测", `got ${all.examName}`);
  check("两个班级", all.classes.length === 2, `got ${all.classes.length}`);
  check("题目矩阵 2 行", all.questionMatrix.length === 2, `got ${all.questionMatrix.length}`);
  check("知识点矩阵 2 行", all.knowledgeMatrix.length === 2, `got ${all.knowledgeMatrix.length}`);

  const c1 = all.classes.find((c) => c.classId === 1);
  const c2 = all.classes.find((c) => c.classId === 2);
  check("班级 1/2 均存在", !!c1 && !!c2);
  check("各班 2 人", !!c1 && !!c2 && c1.gradedCount === 2 && c2.gradedCount === 2,
    `got ${c1?.gradedCount}/${c2?.gradedCount}`);
  check("1班均分高于2班", !!c1 && !!c2 && c1.avgScore > c2.avgScore,
    `got ${c1?.avgScore} vs ${c2?.avgScore}`);
  check("含及格率/优秀率字段", !!c1 && typeof c1.passRate === "number" && typeof c1.excellentRate === "number");
  check("含分数段分布", !!c1 && Array.isArray(c1.distribution) && c1.distribution.length > 0);

  const q1 = all.questionMatrix.find((r) => r.questionNumber === "1");
  check("Q1 在矩阵中", !!q1);
  check("Q1: 1班得分率 > 2班", !!q1 && q1.byClass["1"].scoreRate > q1.byClass["2"].scoreRate,
    `got ${q1?.byClass["1"]?.scoreRate} vs ${q1?.byClass["2"]?.scoreRate}`);

  const q2 = all.questionMatrix.find((r) => r.questionNumber === "2");
  check("Q2 在矩阵中", !!q2);
  check("Q2: 2班得分率 ≥ 1班", !!q2 && q2.byClass["2"].scoreRate >= q2.byClass["1"].scoreRate,
    `got ${q2?.byClass["2"]?.scoreRate} vs ${q2?.byClass["1"]?.scoreRate}`);

  const kpFn = all.knowledgeMatrix.find((r) => r.pointText === "函数");
  check("知识点「函数」存在", !!kpFn);
  check("「函数」两班均有数据", !!kpFn && kpFn.byClass["1"] != null && kpFn.byClass["2"] != null);

  const filtered = await repo.getCrossClassDeepCompare(examId, [1], { baselineClassId: 1 });
  check("classIds 过滤只返回1班", filtered.classes.length === 1 && filtered.classes[0].classId === 1);
  check("baselineClassId=1", filtered.baselineClassId === 1);

  const missingBaseline = await repo.getCrossClassDeepCompare(examId, [1, 2], { baselineClassId: 99 });
  check("无效基准 → null", missingBaseline.baselineClassId === null);

  const noKnowledge = await repo.getCrossClassDeepCompare(examId, undefined, { includeKnowledge: false });
  check("includeKnowledge=false 时空知识点矩阵", noKnowledge.knowledgeMatrix.length === 0);
  check("includeKnowledge=false 时班级弱项为空", noKnowledge.classes.every((c) => c.knowledgeWeaknesses.length === 0));

  closeDatabase?.();
  rmSync(tmpDir, { recursive: true, force: true });

  if (failed > 0) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

main().catch((err) => {
  console.error(err);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
