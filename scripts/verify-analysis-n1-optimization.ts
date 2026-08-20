/**
 * 第 1 批「成绩分析优化建议清单」建议 1/9 的等价性回归验证。
 *
 * 目标：N+1 收敛是行为不变的查询层重构，必须证明新旧结果一致。
 * 方法：用旧 SQL 逻辑（逐段 COUNT / 逐班查询 / 相关子查询）作为地面真值，
 *       与改造后的 getExamOverview / getClassScoreSummaries / getScoreSummary /
 *       getStudentRanking / 大考概览合并查询逐一比对（含多班级学生防双计数）。
 *
 * 运行：npx tsx scripts/verify-analysis-n1-optimization.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "px-n1-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "t.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

const { initializeDatabase, getDatabase } = await import("../src/server/db/index");
const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");

initializeDatabase();
const db = getDatabase();

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, info?: unknown) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + label); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + label, info ?? ""); }
}
// 与 AnalysisRepository 内部 percentile 一致的实现（如需）
const pct = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0; if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p; const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};
const round1 = (v: number) => Math.round(v * 10) / 10;

// ── 数据：1 场考试（满分 100，10 客观题×10 分），5 学生 ──
// 学生 A/B/D/E 在 1 班，E 同时在 2 班（双班级），C 无班级（未知班级）
const insertUser = db.prepare("INSERT INTO users (username, password_hash, role_id, student_number, name) VALUES (?, ?, 3, ?, ?)");
const uA = insertUser.run("stuA", "x", "S1", "甲").lastInsertRowid as number;
const uB = insertUser.run("stuB", "x", "S2", "乙").lastInsertRowid as number;
const uC = insertUser.run("stuC", "x", "S3", "丙").lastInsertRowid as number;
const uD = insertUser.run("stuD", "x", "S4", "丁").lastInsertRowid as number;
const uE = insertUser.run("stuE", "x", "S5", "戊").lastInsertRowid as number;
const gradeId = db.prepare("INSERT INTO grades (name) VALUES (?)").run("高一").lastInsertRowid as number;
const class1 = db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, ?)").run(gradeId, "1班").lastInsertRowid as number;
const class2 = db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, ?)").run(gradeId, "2班").lastInsertRowid as number;
for (const sid of [uA, uB, uD, uE]) db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(class1, sid);
db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(class2, uE);

const e1 = db.prepare("INSERT INTO exams (name, subject, status) VALUES (?, ?, 'closed')").run("G1-数学", "数学").lastInsertRowid as number;
const insertQ = db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score_type, score, max_score) VALUES (?, ?, ?, 'objective', ?, ?)");
const insertS = db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)");

// 各学生每题得分：A=10×100, B 首题 2(低分)其余 6→56, C=5×10→50, D=9×10→90, E 前4题10其余0→40
const perQ: Record<number, number[]> = {
  [uA]: Array(10).fill(10),
  [uB]: [2, ...Array(9).fill(6)],
  [uC]: Array(10).fill(5),
  [uD]: Array(10).fill(9),
  [uE]: [10, 10, 10, 10, 0, 0, 0, 0, 0, 0],
};
for (const [sid, scores] of Object.entries(perQ)) {
  const total = scores.reduce((a, b) => a + b, 0);
  scores.forEach((s, i) => insertQ.run(e1, Number(sid), i + 1, s, 10));
  insertS.run(e1, Number(sid), total, total);
}

const repo = new AnalysisRepository();

// ============================================================
console.log("\n== 1. getStudentRanking：相关子查询 → LEFT JOIN+GROUP BY ==");
const qsumRef = db.prepare(`
  SELECT student_id, COUNT(*) as q_count,
         SUM(CASE WHEN score < max_score * 0.5 THEN 1 ELSE 0 END) as low
  FROM question_scores WHERE exam_id = ? GROUP BY student_id`).all(e1) as Array<{ student_id: number; q_count: number; low: number | null }>;
const refMap = new Map(qsumRef.map(r => [r.student_id, { q: r.q_count, low: r.low ?? 0 }]));

const rankAll = await repo.getStudentRanking(e1);
ok(rankAll.length === 5, "无班级过滤：一学生一行（多班级学生不重复）", rankAll.length);
const byNumber = new Map(rankAll.map(r => [r.studentNumber, r]));
ok(byNumber.get("S1")!.questionCount === 10 && byNumber.get("S1")!.lowScoreCount === 0, "甲 10 题 0 低分", byNumber.get("S1"));
ok(byNumber.get("S2")!.questionCount === 10 && byNumber.get("S2")!.lowScoreCount === 1, "乙 10 题 1 低分（首题 2/10）", byNumber.get("S2"));
ok(byNumber.get("S5")!.questionCount === 10 && byNumber.get("S5")!.lowScoreCount === 6, "戊(双班级) 10 题 6 低分（6 个 0 分题；未因双班级误乘）", byNumber.get("S5"));
ok(byNumber.get("S5")!.totalScore === 40, "戊 total 40");

// 全部学生逐项与地面真值比对
const numBySid = { [uA]: "S1", [uB]: "S2", [uC]: "S3", [uD]: "S4", [uE]: "S5" } as Record<number, string>;
let rankMismatch = 0;
for (const [sid, ref] of refMap) {
  const row = rankAll.find(r => r.studentNumber === numBySid[sid]);
  if (!row) { rankMismatch++; continue; }
  if (row.questionCount !== ref.q || row.lowScoreCount !== ref.low) {
    rankMismatch++; console.log("   mismatch", numBySid[sid], row, ref);
  }
}
ok(rankMismatch === 0, "全部学生的 questionCount/lowScoreCount 与地面真值一致");

const rankClass1 = await repo.getStudentRanking(e1, class1);
ok(rankClass1.length === 4, "班级过滤：1 班 4 人（甲/乙/丁/戊）", rankClass1.length);
ok(rankClass1.filter(r => r.studentNumber === "S5").length === 1, "班级过滤下戊只出现一次", "");
const rankUnknown = await repo.getStudentRanking(e1, 0);
ok(rankUnknown.length === 1 && rankUnknown[0].studentNumber === "S3", "未知班级过滤：只有丙", rankUnknown);

// ============================================================
console.log("\n== 2. getClassScoreSummaries：逐班查询 → 单次 LEFT JOIN 分桶 ==");
const classSummaries = await repo.getClassScoreSummaries(e1);
const clsNames = classSummaries.map(c => `${c.className}(id=${c.classId}):count=${c.summary.count}`).join(" ");
ok(classSummaries.length === 3, "班级汇总含 1班/2班/未知班级", clsNames);
const cls1s = classSummaries.find(c => c.classId === class1)!;
ok(cls1s.summary.count === 4, "1 班 4 人（A/B/D/E）", cls1s.summary.count);
ok(cls1s.summary.min === 40 && cls1s.summary.max === 100 && cls1s.summary.avg === round1((100 + 56 + 90 + 40) / 4), "1 班 min/max/avg", cls1s.summary);
const cls2s = classSummaries.find(c => c.classId === class2)!;
ok(cls2s.summary.count === 1 && cls2s.summary.min === 40 && cls2s.summary.max === 40, "2 班只有戊 1 人", cls2s.summary);
const cls0s = classSummaries.find(c => c.classId === 0)!;
ok(cls0s.summary.count === 1 && cls0s.summary.min === 50, "未知班级只有丙", cls0s.summary);

// ============================================================
console.log("\n== 3. getExamOverview：分布逐段 COUNT → 单次取分 JS 分桶 ==");
// 地面真值：旧 SQL `COUNT(*) ... BETWEEN r.min AND r.max`（含班级过滤）
function refDistribution(examId: number, classId?: number) {
  const fullScore = 100, seg = 10;
  const ranges: Array<{ range: string; min: number; max: number }> = [];
  for (let min = 0; min < fullScore; min += seg) {
    const upper = min + seg, last = upper >= fullScore;
    const max = last ? fullScore : Math.min(upper - 1, fullScore);
    ranges.push({ range: last ? `${min}-${fullScore}` : `${min}-<${upper}`, min, max });
  }
  const join = classId === undefined || classId === 0 ? "" : "JOIN class_students cs ON cs.student_id = ss.student_id";
  const where = classId === undefined ? "" : classId === 0
    ? "AND NOT EXISTS (SELECT 1 FROM class_students cs2 WHERE cs2.student_id = ss.student_id)"
    : "AND cs.class_id = ?";
  const out: Array<{ range: string; count: number }> = [];
  for (const r of ranges) {
    const params: unknown[] = [examId, r.min, r.max];
    if (classId !== undefined && classId > 0) params.push(classId);
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM student_scores ss ${join} WHERE ss.exam_id = ? AND ss.total_score >= ? AND ss.total_score <= ? ${where}`).get(...params) as { cnt: number };
    out.push({ range: r.range, count: row.cnt });
  }
  return out;
}

const ovAll = await repo.getExamOverview(e1);
const refAll = refDistribution(e1);
ok(ovAll.distribution.length === refAll.length, "分布段数与地面真值一致", ovAll.distribution.length);
let distMismatch = 0;
for (let i = 0; i < refAll.length; i++) {
  if (ovAll.distribution[i].count !== refAll[i].count) { distMismatch++; console.log("  mismatch", ovAll.distribution[i], refAll[i]); }
}
ok(distMismatch === 0, "全区间计分段数与旧 SQL 逐段 COUNT 完全一致");
ok(ovAll.distribution.reduce((s, b) => s + b.count, 0) === 5, "全区间合计 = 5 人");
ok(ovAll.scoreSummary !== null && ovAll.scoreSummary.count === 5, "overview.scoreSummary(无过滤) = 5 人", ovAll.scoreSummary);
ok(ovAll.overallScoreSummary !== null && ovAll.overallScoreSummary.count === 5, "overallScoreSummary = 5 人");
ok(ovAll.scoreSummary!.min === 40 && ovAll.scoreSummary!.max === 100 && ovAll.scoreSummary!.median === 56, "整体分位数（40/56/100）", ovAll.scoreSummary);

const ovClass = await repo.getExamOverview(e1, class1);
const refClass = refDistribution(e1, class1);
let distC = 0;
for (let i = 0; i < refClass.length; i++) if (ovClass.distribution[i].count !== refClass[i].count) distC++;
ok(distC === 0 && ovClass.distribution.reduce((s, b) => s + b.count, 0) === 4, "1 班过滤分布与旧 SQL 一致且合计 4 人");
ok(ovClass.scoreSummary !== null && ovClass.scoreSummary.count === 4 && ovClass.overallScoreSummary!.count === 5, "班级过滤时 scoreSummary=4 / overall=5");

const ovUnknown = await repo.getExamOverview(e1, 0);
ok(ovUnknown.distribution.reduce((s, b) => s + b.count, 0) === 1 && ovUnknown.scoreSummary!.count === 1 && ovUnknown.scoreSummary!.min === 50, "未知班级过滤分布=1 人，scoreSummary=丙", ovUnknown.scoreSummary);

// getScoreSummary 与班级汇总分位数一致
const ss1 = await repo.getScoreSummary(e1, class1);
ok(ss1 !== null && ss1.count === 4 && ss1.min === 40 && ss1.max === 100 && ss1.q1 === round1(pct([40,56,90,100], 0.25)), "getScoreSummary(1班) 分位数与新实现一致", ss1);
const ss0 = await repo.getScoreSummary(e1, 0);
ok(ss0 !== null && ss0.count === 1 && ss0.min === 50, "getScoreSummary(未知班级) = 丙", ss0);

// ============================================================
console.log("\n== 4. 大考概览逐科 3 查询 → 满分批量 + 每科 1 条聚合 ==");
const grp = db.prepare("INSERT INTO exam_groups (name, total_score_mode, only_full_participants) VALUES (?, 'raw', 0)").run("G1-联考").lastInsertRowid as number;
db.prepare("INSERT INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, 0)").run(grp, e1);

// 旧：3 条/科（全科满分 + std + pass/excellent）
const oldFull = db.prepare(`SELECT SUM(max_score) as total FROM (SELECT DISTINCT question_number, score_type, max_score FROM question_scores WHERE exam_id = ?)`).get(e1) as { total: number | null };
const avg1 = db.prepare(`SELECT ROUND(AVG(ss.total_score), 1) as a FROM student_scores ss WHERE ss.exam_id = ?`).get(e1) as { a: number };
const oldStd = db.prepare(`SELECT ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as std FROM student_scores ss WHERE ss.exam_id = ?`).get(avg1.a, avg1.a, e1) as { std: number | null };
const passLine = 60, excellLine = 90;
const oldPass = db.prepare(`SELECT SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as p, SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as e FROM student_scores ss WHERE ss.exam_id = ?`).get(passLine, excellLine, e1) as { p: number | null; e: number | null };

// 新：合并 1 条
const newStat = db.prepare(`
  SELECT ROUND(SQRT(AVG((ss.total_score - ?) * (ss.total_score - ?))), 1) as std,
         SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as p,
         SUM(CASE WHEN ss.total_score >= ? THEN 1 ELSE 0 END) as e
  FROM student_scores ss WHERE ss.exam_id = ?`).get(avg1.a, avg1.a, passLine, excellLine, e1) as { std: number | null; p: number | null; e: number | null };
ok((oldFull?.total ?? 100) === 100, "满分=100");
ok((newStat.std ?? 0) === (oldStd?.std ?? 0), "std 合并查询与旧查询一致", { old: oldStd?.std, neu: newStat.std });
ok((newStat.p ?? 0) === (oldPass?.p ?? 0) && (newStat.e ?? 0) === (oldPass?.e ?? 0), "pass/excellent 合并查询与旧查询一致", newStat);

// ============================================================
// 清理
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n\x1b[36m结果：${pass} 通过，${fail} 失败\x1b[0m`);
if (fail > 0) process.exit(1);
