/**
 * 评审修复验证：覆盖
 *  1. 大考参与口径（only_full_participants + total_score_mode）
 *  2. 正态性检验（极端偏态正确判负）
 *  3. 大考班级对比遵守 passRate/excellentRate
 *  4. 直方图标签 (0-<10, 10-<20, ..., 90-100)
 *  5. 逐题下钻班级过滤与大考逐题参与者口径
 *
 * 运行：npx tsx scripts/bugfix-analysis-verification.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "px-bugfix-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "t.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

const { initializeDatabase, getDatabase } = await import("../src/server/db/index");
const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");
const { invalidateAnalysisThresholdsCache } = await import("../src/server/services/analysisConfig");
const { normality, histogram } = await import("../src/shared/stats");

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, info?: unknown) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + label); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + label, info ?? ""); }
}

initializeDatabase();
const db = getDatabase();

// ── 数据：2 场考试（满分 100），1 大考组，4 学生 ──
const insertUser = db.prepare("INSERT INTO users (username, password_hash, role_id, student_number, name) VALUES (?, ?, 3, ?, ?)");
const uA = insertUser.run("stuA", "x", "S1", "甲").lastInsertRowid as number;
const uB = insertUser.run("stuB", "x", "S2", "乙").lastInsertRowid as number;
const uC = insertUser.run("stuC", "x", "S3", "丙").lastInsertRowid as number;
const uD = insertUser.run("stuD", "x", "S4", "丁").lastInsertRowid as number;
const gradeId = db.prepare("INSERT INTO grades (name) VALUES (?)").run("高一").lastInsertRowid as number;
const classId = db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, ?)").run(gradeId, "1班").lastInsertRowid as number;
for (const studentId of [uA, uB, uD]) db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classId, studentId);

const e1 = db.prepare("INSERT INTO exams (name, subject, status) VALUES (?, ?, 'closed')").run("G1-数学", "数学").lastInsertRowid as number;
const e2 = db.prepare("INSERT INTO exams (name, subject, status) VALUES (?, ?, 'closed')").run("G1-语文", "语文").lastInsertRowid as number;
const insertQ = db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score_type, score, max_score) VALUES (?, ?, ?, 'objective', ?, ?)");
const insertS = db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)");

// A 全科(60+70=130)、B 只数学(60)、C 只语文(50)、D 全科高分(90+80=170)
for (let q = 1; q <= 10; q++) {
  insertQ.run(e1, uA, q, 6, 10);  insertQ.run(e1, uB, q, 6, 10);  insertQ.run(e1, uD, q, 9, 10);
  insertQ.run(e2, uA, q, 7, 10);  insertQ.run(e2, uC, q, 5, 10);  insertQ.run(e2, uD, q, 8, 10);
}
insertS.run(e1, uA, 60, 60);  insertS.run(e1, uB, 60, 60);  insertS.run(e1, uD, 90, 90);
insertS.run(e2, uA, 70, 70);  insertS.run(e2, uC, 50, 50);  insertS.run(e2, uD, 80, 80);

const grp = db.prepare("INSERT INTO exam_groups (name, total_score_mode, only_full_participants) VALUES (?, 'raw', 0)").run("G1-联考").lastInsertRowid as number;
db.prepare("INSERT INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, 0)").run(grp, e1);
db.prepare("INSERT INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, 1)").run(grp, e2);

const repo = new AnalysisRepository();

// ═══ Bug 1: 大考参与口径 ═══
console.log("\n== Bug 1: 大考参与口径（only_full_participants / total_score_mode）==");

// 默认 only_full=0, raw
const m0 = await repo.getGroupMetrics(grp);
ok(m0.memberCount === 2, "memberCount=2");
ok(m0.subjects.every((s: any) => s.gradedCount > 0), "subjects gradedCount 全部为正（非硬编码 0）", m0.subjects);
// subjects 的 passRate/excellentRate 不再硬编码 0（按 该科满分×阈值 口径）
const subMath = m0.subjects.find((s: any) => s.examId === e1);   // 数学: 60,60,90 / 满分100 / pass60 excell90
const subChi = m0.subjects.find((s: any) => s.examId === e2);    // 语文: 70,50,80
ok(subMath?.passRate === 100 && subMath?.excellentRate === 33, "数学 passRate=100%(3/3≥60) excellentRate=33%(1/3≥90)", subMath);
ok(subChi?.passRate === 67 && subChi?.excellentRate === 0, "语文 passRate=67%(2/3≥60) excellentRate=0%(0/3≥90)", subChi);
ok(m0.totalAvg === Math.round(((130 + 60 + 50 + 170) / 4) * 10) / 10, "totalAvg 包含所有学生 (含只考单科的缺考生)", { totalAvg: m0.totalAvg });

// only_full=1：只 A 和 D
db.prepare("UPDATE exam_groups SET only_full_participants = 1 WHERE id = ?").run(grp);
const m1 = await repo.getGroupMetrics(grp);
ok(m1.totalAvg === Math.round(((130 + 170) / 2) * 10) / 10, "only_full=1 → totalAvg 只含 A+D (100)", { totalAvg: m1.totalAvg });
const m1SubA = m1.subjects.find((s: any) => s.examId === e1);
const m1SubB = m1.subjects.find((s: any) => s.examId === e2);
ok(m1SubA?.gradedCount === 2 && m1SubA.avgScore === 75, "数学 gradedCount=2, avg=75 (A=60, D=90)", m1SubA);
ok(m1SubB?.gradedCount === 2 && m1SubB.avgScore === 75, "语文 gradedCount=2, avg=75 (A=70, D=80)", m1SubB);
const groupQuestions = await repo.getGroupQuestionAnalysis(grp);
ok(groupQuestions.subjects.every((s) => s.avgScore === 75), "大考逐科均分遵守 only_full 参与者口径", groupQuestions.subjects);
ok(groupQuestions.subjects.every((s) => s.questions.every((q) => q.totalCount === 2)), "大考逐题统计排除缺考学生", groupQuestions.subjects);

const classDrill = await repo.getQuestionStudentScores(e1, 1, classId);
ok(classDrill.length === 3 && classDrill.every((s) => s.className === "1班"), "逐题下钻按班级过滤且不发生 JOIN 别名冲突", classDrill);
const unknownClassDrill = await repo.getQuestionStudentScores(e2, 1, 0);
ok(unknownClassDrill.length === 1 && unknownClassDrill[0].studentId === uC, "逐题下钻支持未知班级过滤", unknownClassDrill);
// 后续班级汇总测试沿用原先“4 人同班”的统计口径。
db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classId, uC);

// total_score_mode=assigned + 赋分公式
db.prepare("UPDATE exam_groups SET only_full_participants = 0, total_score_mode = 'assigned' WHERE id = ?").run(grp);
db.prepare("UPDATE exams SET assigned_formula = 'mvp' WHERE id = ?").run(e1);
db.prepare("UPDATE student_scores SET assigned_score = ? WHERE exam_id = ? AND student_id = ?").run(50, e1, uA);
db.prepare("UPDATE student_scores SET assigned_score = ? WHERE exam_id = ? AND student_id = ?").run(50, e1, uB);
db.prepare("UPDATE student_scores SET assigned_score = ? WHERE exam_id = ? AND student_id = ?").run(80, e1, uD);
const m2 = await repo.getGroupMetrics(grp);
// A=50(赋分, 数学) + 70(语文) = 120
// B=50(赋分, 数学) + 缺语文 → 50
// C=缺数学 + 50(语文) = 50
// D=80(赋分, 数学) + 80(语文) = 160
ok(m2.totalAvg === Math.round(((120 + 50 + 50 + 160) / 4) * 10) / 10, "assigned 模式总分按策略口径汇总", { totalAvg: m2.totalAvg });

// 还原
db.prepare("UPDATE exam_groups SET only_full_participants = 0, total_score_mode = 'raw' WHERE id = ?").run(grp);
db.prepare("UPDATE exams SET assigned_formula = NULL WHERE id = ?").run(e1);
db.prepare("UPDATE student_scores SET assigned_score = NULL WHERE exam_id = ?").run(e1);

// 1.1 分布按参与者口径
const distSubject = await repo.getGroupDistribution(grp, "subject");
const distTotal = await repo.getGroupDistribution(grp, "total");
ok(distSubject.every((d) => d.sampleSize === 3), "subject 分布每科 3 人（参与口径）", distSubject);
ok(distTotal[0].sampleSize === 4, "total 分布 4 人");
db.prepare("UPDATE exam_groups SET only_full_participants = 1 WHERE id = ?").run(grp);
const distFull = await repo.getGroupDistribution(grp, "total");
ok(distFull[0].sampleSize === 2, "only_full=1 → total 分布只 2 人 (A+D)");
db.prepare("UPDATE exam_groups SET only_full_participants = 0 WHERE id = ?").run(grp);

// 1.2 班级对比按参与者口径
const clsComp = await repo.getGroupClassComparison(grp);
ok(clsComp.classes[0].passRate === 50, "默认 0.6 passLine=120 → passRate=50% (130/170 通过)", { passRate: clsComp.classes[0].passRate });
ok(clsComp.classes[0].excellentRate === 0, "默认 0.9 excellLine=180 → excellentRate=0%");

// ═══ Bug 3: 阈值可配置 ═══
console.log("\n== Bug 3: 大考班级对比遵守阈值（不再硬编码 0.6/0.9）==");
db.prepare("INSERT OR REPLACE INTO system_settings (`key`, value) VALUES ('analysis_pass_rate', '0.5')").run();
db.prepare("INSERT OR REPLACE INTO system_settings (`key`, value) VALUES ('analysis_excellent_rate', '0.85')").run();
invalidateAnalysisThresholdsCache();
const clsComp2 = await repo.getGroupClassComparison(grp);
ok(clsComp2.classes[0].passRate === 50, "0.5 passLine=100 → passRate=50% (2/4)", { passRate: clsComp2.classes[0].passRate });
ok(clsComp2.classes[0].excellentRate === 25, "0.85 excellLine=170 → excellentRate=25% (1/4)", { excellentRate: clsComp2.classes[0].excellentRate });
ok(clsComp2.classes[0].passRate !== clsComp.classes[0].passRate
   || clsComp2.classes[0].excellentRate !== clsComp.classes[0].excellentRate,
   "阈值修改后统计随之变化", { before: clsComp.classes[0], after: clsComp2.classes[0] });
db.prepare("DELETE FROM system_settings WHERE `key` IN ('analysis_pass_rate', 'analysis_excellent_rate')").run();
invalidateAnalysisThresholdsCache();

// ═══ Bug 2: 正态性检验 ═══
console.log("\n== Bug 2: 正态性检验（SF/KD/AD/综合判定）==");
const pathological = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100];
const r1 = normality(pathological);
ok(r1.isNormal === false, "极端偏态 isNormal=false", r1);
ok(r1.shapiroFrancia.pValue != null && r1.shapiroFrancia.pValue < 0.001, "SF p < 0.001 (极显著)", r1.shapiroFrancia);
ok(r1.kolmogorovSmirnov.pValue != null && r1.kolmogorovSmirnov.pValue < 0.05, "KS p < 0.05", r1.kolmogorovSmirnov);
ok(r1.andersonDarling.pValue != null && r1.andersonDarling.pValue < 0.05, "AD p < 0.05", r1.andersonDarling);

// 验证正态数据不被错判
const normalish: number[] = [];
let seed = 42;
function rand() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
function box() { const u1 = Math.max(rand(), 1e-9), u2 = rand(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); }
for (let i = 0; i < 50; i++) normalish.push(Math.round(70 + 10 * box()));
normalish.sort((a, b) => a - b);
const r2 = normality(normalish);
ok(r2.shapiroFrancia.W > 0.9, "正态数据 W > 0.9", { W: r2.shapiroFrancia.W });
ok(r2.isNormal === true, "正态数据 isNormal=true", r2);
ok(r2.andersonDarling.pValue != null && r2.andersonDarling.pValue > 0 && r2.andersonDarling.pValue < 1,
  "AD p 值使用分段近似而非错误钳制为 1", r2.andersonDarling);

// ═══ Bug 4: 直方图标签 ═══
console.log("\n== Bug 4: 直方图区间标签（半开区间，不再误归类）==");
const bins = histogram([9.5, 10, 19.99, 20, 100], 100, 10);
ok(bins[0].range === "0-<10", "bin 1 标签 0-<10", bins[0]);
ok(bins[1].range === "10-<20", "bin 2 标签 10-<20", bins[1]);
ok(bins[2].range === "20-<30", "bin 3 标签 20-<30", bins[2]);
ok(bins[bins.length - 1].range === "90-100", "末段 90-100", bins[bins.length - 1]);
ok(bins[0].count === 1, "9.5 → bin 1 (0-<10)");
ok(bins[1].count === 2, "10 + 19.99 → bin 2 (10-<20)");
ok(bins[2].count === 1, "20 → bin 3 (20-<30)");
ok(bins[bins.length - 1].count === 1, "100 → 末段 (90-100)");

// 清理
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n\x1b[36m结果：${pass} 通过，${fail} 失败\x1b[0m`);
if (fail > 0) process.exit(1);
