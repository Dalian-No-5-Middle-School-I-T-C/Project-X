/**
 * 信度指标筛选缺陷修复验证（PR#247 评审 P2）
 *
 * 覆盖：
 *  1. 普通考试 metrics?classId=X：getExamReliability 只按 exam_id 查询，
 *     不同班级得到全场信度 → 修复后按班级参与者集合过滤（与参考人数/区分度同口径）。
 *  2. 大考 metrics?track=arts|science：逐科信度忽略文理科与完整参与者集合
 *     → 修复后按 getGroupTotalsMap 的参与者集合（track + only_full_participants）过滤。
 *
 * 运行：npx tsx scripts/verify-reliability-filter.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "px-reliability-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "t.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

const { initializeDatabase, getMysqlDb } = await import("../src/server/db/index");
const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");
const { cronbachAlpha, kr20 } = await import("../src/shared/stats");

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, info?: unknown) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + label); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + label, info ?? ""); }
}

initializeDatabase();
const db = getMysqlDb();

// ── 数据：4 学生（2 文科/2 理科、2 班级），2 场考试，1 大考组 ──
const uA = (await db.run("INSERT INTO users (username, password_hash, role_id, student_number, name, track) VALUES ('stuA', 'x', 3, 'S1', '甲', 'science')")).lastInsertRowid as number;
const uB = (await db.run("INSERT INTO users (username, password_hash, role_id, student_number, name, track) VALUES ('stuB', 'x', 3, 'S2', '乙', 'science')")).lastInsertRowid as number;
const uC = (await db.run("INSERT INTO users (username, password_hash, role_id, student_number, name, track) VALUES ('stuC', 'x', 3, 'S3', '丙', 'arts')")).lastInsertRowid as number;
const uD = (await db.run("INSERT INTO users (username, password_hash, role_id, student_number, name, track) VALUES ('stuD', 'x', 3, 'S4', '丁', 'arts')")).lastInsertRowid as number;
const gradeId = (await db.run("INSERT INTO grades (name) VALUES ('高一')")).lastInsertRowid as number;
const class1 = (await db.run("INSERT INTO classes (grade_id, name) VALUES (?, '1班')", gradeId)).lastInsertRowid as number;
const class2 = (await db.run("INSERT INTO classes (grade_id, name) VALUES (?, '2班')", gradeId)).lastInsertRowid as number;
for (const s of [uA, uB]) await db.run("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)", class1, s);
for (const s of [uC, uD]) await db.run("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)", class2, s);

const e1 = (await db.run("INSERT INTO exams (name, subject, status) VALUES ('G1-数学', '数学', 'closed')")).lastInsertRowid as number;
const e2 = (await db.run("INSERT INTO exams (name, subject, status) VALUES ('G1-语文', '语文', 'closed')")).lastInsertRowid as number;

// 每题 10 分：score=10 记 1（满分），score=0 记 0。满分数 A=3, B=10, C=7, D=9（Guttman 阶梯）
const patterns = new Map<number, number[]>([
  [uA, [10, 10, 10, 0, 0, 0, 0, 0, 0, 0]],
  [uB, [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]],
  [uC, [10, 10, 10, 10, 10, 10, 10, 0, 0, 0]],
  [uD, [10, 10, 10, 10, 10, 10, 10, 10, 10, 0]],
]);
const totals = new Map<number, number>([[uA, 30], [uB, 100], [uC, 70], [uD, 90]]);
for (const [sid, pat] of patterns) {
  for (let q = 0; q < pat.length; q++) {
    await db.run("INSERT INTO question_scores (exam_id, student_id, question_number, score_type, score, max_score) VALUES (?, ?, ?, 'objective', ?, 10)", e1, sid, q + 1, pat[q]);
  }
  await db.run("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)", e1, sid, totals.get(sid)!, totals.get(sid)!);
}
// e2：B 缺考（only_full=1 时被剔除）；其余同 e1 模式
for (const [sid, pat] of patterns) {
  if (sid === uB) continue;
  for (let q = 0; q < pat.length; q++) {
    await db.run("INSERT INTO question_scores (exam_id, student_id, question_number, score_type, score, max_score) VALUES (?, ?, ?, 'objective', ?, 10)", e2, sid, q + 1, pat[q]);
  }
  await db.run("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)", e2, sid, totals.get(sid)!, totals.get(sid)!);
}

const grp = (await db.run("INSERT INTO exam_groups (name, total_score_mode, only_full_participants) VALUES ('G1-联考', 'raw', 0)")).lastInsertRowid as number;
await db.run("INSERT INTO exam_group_members (group_id, exam_id, track_type, sort_order) VALUES (?, ?, 'common', 0)", grp, e1);
await db.run("INSERT INTO exam_group_members (group_id, exam_id, track_type, sort_order) VALUES (?, ?, 'common', 1)", grp, e2);

/** 复刻 getExamReliability 的矩阵构建（仅用于按指定行集手动计算期望值） */
function manualReliability(rows: Array<{ student_id: number; question_number: number; score_type: string; score: number; max_score: number }>): number | null {
  const qKeys = Array.from(new Set(rows.map((r) => String(r.question_number)))).sort((a, b) => Number(a) - Number(b));
  if (qKeys.length < 2) return null;
  const byStudent = new Map<number, Map<string, { score: number; maxScore: number; isObjective: boolean }>>();
  let hasSubjective = false;
  for (const r of rows) {
    if (r.score_type !== "objective") hasSubjective = true;
    const m = byStudent.get(Number(r.student_id)) ?? new Map();
    if (!m.has(String(r.question_number))) {
      m.set(String(r.question_number), { score: Number(r.score), maxScore: Number(r.max_score), isObjective: r.score_type === "objective" });
    }
    byStudent.set(Number(r.student_id), m);
  }
  const matrix: number[][] = [];
  for (const m of byStudent.values()) {
    if (m.size !== qKeys.length) continue; // 作答不完整的学生剔除
    const row: number[] = [];
    let complete = true;
    for (const key of qKeys) {
      const qv = m.get(key);
      if (!qv) { complete = false; break; }
      row.push(hasSubjective ? qv.score : (qv.maxScore > 0 && qv.score >= qv.maxScore ? 1 : 0));
    }
    if (complete) matrix.push(row);
  }
  if (matrix.length < 2) return null;
  return hasSubjective ? cronbachAlpha(matrix) : kr20(matrix);
}
async function rowsOf(examId: number, studentIds: number[]): Promise<Array<{ student_id: number; question_number: number; score_type: string; score: number; max_score: number }>> {
  return db.all(
    `SELECT student_id, question_number, score_type, score, max_score FROM question_scores WHERE exam_id = ? AND student_id IN (${studentIds.map(() => "?").join(",")})`,
    examId, ...studentIds
  ) as Promise<Array<{ student_id: number; question_number: number; score_type: string; score: number; max_score: number }>>;
}

const repo = new AnalysisRepository();

// 预取各样本行集（与仓库过滤口径对齐，用于手算期望值）
const rowsAll = await rowsOf(e1, [uA, uB, uC, uD]);
const rowsClass1 = await rowsOf(e1, [uA, uB]);
const rowsClass2 = await rowsOf(e1, [uC, uD]);
const rowsE2 = await rowsOf(e2, [uA, uB, uC, uD]);
const rowsOnlyFull = await rowsOf(e1, [uA, uC, uD]);

// ═══ 1. 普通考试 metrics 按班级筛选信度 ═══
console.log("\n== Bug 1: metrics?classId=X 的信度按班级参与者集合过滤 ==");
const full = await repo.getExamMetrics(e1);
const mClass1 = await repo.getExamMetrics(e1, class1);
const mClass2 = await repo.getExamMetrics(e1, class2);
ok(full.reliability === 0.889, `全场信度 = 0.889（A,B,C,D 阶梯样本）`, full.reliability);
ok(mClass1.reliability === 0.952, "1班信度 = 0.952（仅 A,B 样本）", mClass1.reliability);
ok(mClass2.reliability === 0.556, "2班信度 = 0.556（仅 C,D 样本）", mClass2.reliability);
ok(mClass1.reliability !== full.reliability && mClass2.reliability !== full.reliability, "班级信度 ≠ 全场信度（修复前恒等于全场）");
ok(mClass1.reliability === manualReliability(rowsClass1), "1班信度 == 仅该班学生行手算值");
ok(mClass2.reliability === manualReliability(rowsClass2), "2班信度 == 仅该班学生行手算值");
ok(full.reliability === manualReliability(rowsAll), "全场信度 == 全部学生行手算值（无筛选路径不变）");
ok(mClass1.gradedCount === 2 && mClass1.avgScore === 65, "1班参考人数/均分仍按班级口径（与信度同源）", { gradedCount: mClass1.gradedCount, avgScore: mClass1.avgScore });

// ═══ 2. 大考逐科信度按文理 + 参与者集合过滤 ═══
console.log("\n== Bug 2: 大考 metrics?track=X 的逐科信度按 totals 参与者集合过滤 ==");
const gAll = await repo.getGroupMetrics(grp, "all");
const gArts = await repo.getGroupMetrics(grp, "arts");
const gSci = await repo.getGroupMetrics(grp, "science");
const subAll = gAll.subjects.find((s) => s.examId === e1)!;
const subArts = gArts.subjects.find((s) => s.examId === e1)!;
const subSci = gSci.subjects.find((s) => s.examId === e1)!;
ok(subAll.reliability === 0.889, "track=all 数学逐科信度 = 0.889（A,B,C,D）", subAll.reliability);
ok(subArts.reliability === 0.556, "track=arts 数学逐科信度 = 0.556（仅 C,D 文科生）", subArts.reliability);
ok(subSci.reliability === 0.952, "track=science 数学逐科信度 = 0.952（仅 A,B 理科生）", subSci.reliability);
ok(subArts.reliability !== subAll.reliability, "文科逐科信度 ≠ 全体逐科信度（修复前恒等于全体）");
ok(subSci.reliability !== subAll.reliability, "理科逐科信度 ≠ 全体逐科信度");
ok(subArts.reliability === manualReliability(rowsClass2), "文科信度 == 文科生行手算值");
ok(subSci.reliability === manualReliability(rowsClass1), "理科信度 == 理科生行手算值");
ok(subArts.gradedCount === 2 && subArts.avgScore === 80, "文科逐科参考人数/均分按参与者口径", { gradedCount: subArts.gradedCount, avgScore: subArts.avgScore });
ok(gAll.subjects.find((s) => s.examId === e2)!.reliability === manualReliability(rowsE2), "语文逐科信度同样按 participants 过滤（B 缺考自然排除）");

// ═══ 3. only_full_participants=1：B 缺考语文被剔除 → 数学信度只含 A,C,D ═══
console.log("\n== Bug 2b: only_full_participants=1 时逐科信度剔除缺考生 ==");
await db.run("UPDATE exam_groups SET only_full_participants = 1 WHERE id = ?", grp);
const gFull = await repo.getGroupMetrics(grp, "all");
const subFull = gFull.subjects.find((s) => s.examId === e1)!;
ok(gFull.participantCount === 3, "only_full=1 参与者=3（B 缺语文被剔除）", gFull.participantCount);
ok(subFull.reliability === 0.873, "only_full=1 数学逐科信度 = 0.873（仅 A,C,D）", subFull.reliability);
ok(subFull.reliability !== subAll.reliability, "剔除缺考生后信度变化（修复前恒为全体 0.889）");
ok(subFull.reliability === manualReliability(rowsOnlyFull), "only_full 信度 == 参与者行手算值");

// 清理
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n\x1b[36m结果：${pass} 通过，${fail} 失败\x1b[0m`);
if (fail > 0) process.exit(1);
