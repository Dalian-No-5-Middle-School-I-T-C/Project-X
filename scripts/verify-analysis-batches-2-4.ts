/**
 * 成绩分析优化清单 第 2-4 批功能回归验证（建议 3/4/5/6/7/8/10/14/15）。
 *
 * 用真实 SQLite + 迁移（含 v38 ai_analysis_jobs）搭数据，逐项断言：
 *  - 学生成长曲线 getStudentTrend（排名兜底/得分率）
 *  - 临界生名单 getBorderlineStudents（线/浮动区间语义）
 *  - 偏科预警 getSubjectDeviation（年级 Z 与手工一致 + 相对个人基线判定，Issue #264）
 *  - 班级知识点雷达 getClassKnowledgeStats（聚合/覆盖率）
 *  - 同卡对比 getComparableExams / 命题质量 getSubjectQuality
 *  - AI 异步任务流（创建→排队清理→执行失败落 error）
 *  - 知识点合并写入 mergeByCard（INSERT IGNORE 幂等）
 *  - 分析缓存 LRU 与精准失效
 *
 * 运行：npx tsx scripts/verify-analysis-batches-2-4.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "px-b2-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "t.db");
process.env.LLMCLIENT_URL = "http://127.0.0.1:1"; // 确保 AI 任务执行立刻失败（端口关闭）
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

const { initializeDatabase, getDatabase } = await import("../src/server/db/index");
const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");
const { KnowledgePointRepository } = await import("../src/server/repositories/KnowledgePointRepository");
const { analysisCache } = await import("../src/server/services/analysisCache");
const { createAiAnalysisJob, getAiAnalysisJob, enqueueAiAnalysisJob, cleanupInterruptedAiJobs } = await import("../src/server/services/aiAnalysisJobs");
const { mean, stdDev } = await import("../src/shared/stats");

initializeDatabase();
const db = getDatabase();

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, info?: unknown) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + label); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + label, info ?? ""); }
}

// ── 数据 ──
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

const cardId = "10000001";
db.prepare("INSERT INTO answer_cards (id, title, subject, subject_label) VALUES (?, '高一数学卷', '数学', '数学')").run(cardId);

const e1 = db.prepare("INSERT INTO exams (name, subject, status, card_id) VALUES (?, ?, 'closed', ?)").run("G1-数学月考", "数学", cardId).lastInsertRowid as number;
const e2 = db.prepare("INSERT INTO exams (name, subject, status) VALUES (?, ?, 'closed')").run("G1-语文月考", "语文").lastInsertRowid as number;
const e3 = db.prepare("INSERT INTO exams (name, subject, status, card_id) VALUES (?, ?, 'closed', ?)").run("G2-数学月考", "数学", cardId).lastInsertRowid as number;

const insertQ = db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score_type, score, max_score) VALUES (?, ?, ?, 'objective', ?, ?)");
const insertS = db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)");

// e1（数学，满分 100）：A=100 B=56(首题2) C=60 D=90 E=40(前4题10)
const perQ1: Record<number, number[]> = {
  [uA]: Array(10).fill(10),
  [uB]: [2, ...Array(9).fill(6)],
  [uC]: Array(10).fill(6),
  [uD]: Array(10).fill(9),
  [uE]: [10, 10, 10, 10, 0, 0, 0, 0, 0, 0],
};
for (const [sid, scores] of Object.entries(perQ1)) {
  const total = scores.reduce((a, b) => a + b, 0);
  scores.forEach((s, i) => insertQ.run(e1, Number(sid), i + 1, s, 10));
  insertS.run(e1, Number(sid), total, total);
}
// e2（语文，满分 100）：A=70 C=50 D=80
const perQ2: Record<number, number[]> = {
  [uA]: Array(10).fill(7),
  [uC]: Array(10).fill(5),
  [uD]: Array(10).fill(8),
};
for (const [sid, scores] of Object.entries(perQ2)) {
  const total = scores.reduce((a, b) => a + b, 0);
  scores.forEach((s, i) => insertQ.run(e2, Number(sid), i + 1, s, 10));
  insertS.run(e2, Number(sid), total, total);
}
// e3（数学，同卡，满分 100）：A=80
for (let q = 1; q <= 10; q++) insertQ.run(e3, uA, q, 8, 10);
insertS.run(e3, uA, 80, 80);

// 知识点标注：e1 卡 q1-4=函数性质, q5-8=导数（q9-10 未标注 → 覆盖率 80%）
db.prepare("INSERT INTO knowledge_points (card_id, question_number, point_text) VALUES (?, ?, ?)").run(cardId, 1, "函数性质");
for (let q = 2; q <= 4; q++) db.prepare("INSERT INTO knowledge_points (card_id, question_number, point_text) VALUES (?, ?, ?)").run(cardId, q, "函数性质");
for (let q = 5; q <= 8; q++) db.prepare("INSERT INTO knowledge_points (card_id, question_number, point_text) VALUES (?, ?, ?)").run(cardId, q, "导数");

const repo = new AnalysisRepository();

// ============================================================
console.log("\n== 建议 3：学生成长曲线 getStudentTrend ==");
const trendA = await repo.getStudentTrend(uA);
ok(trendA.length === 3, "甲有 3 场考试（e1/e2/e3）", trendA.map((p) => p.examName));
const tE1 = trendA.find((p) => p.examId === e1)!;
const tE2 = trendA.find((p) => p.examId === e2)!;
const tE3 = trendA.find((p) => p.examId === e3)!;
ok(tE1.rank === 1 && tE1.percentile === 100 && tE1.scoreRate === 100, "e1：甲第1名 百分位100 得分率100", tE1);
ok(tE2.rank === 2 && tE2.percentile === 50 && tE2.scoreRate === 70, "e2：甲第2名（80/70/50）百分位50 得分率70", tE2);
ok(tE3.rank === 1 && tE3.scoreRate === 80, "e3：甲第1名 得分率80", tE3);
ok(tE1.fullScore === 100 && tE1.gradeAvg === 69.2, "e1 满分 100 年级均分 69.2", tE1.gradeAvg);
ok(tE1.classAvg === 71.5, "e1 甲所在 1 班均分 (100+56+90+40)/4=71.5", tE1.classAvg);
const trendC = await repo.getStudentTrend(uC);
ok(trendC.length === 2 && trendC[0].examId === e1 && trendC[1].examId === e2, "丙有 e1/e2 两场，按时间排序", trendC.map((p) => p.examName));
ok(trendC[0].rank === 3 && trendC[1].rank === 3, "丙 e1 排第3（100/90/60/56/40）、e2 排第3（80/70/50）", trendC.map((p) => p.rank));

// ============================================================
console.log("\n== 建议 4：临界生名单 getBorderlineStudents ==");
const bl = await repo.getBorderlineStudents(e1, { lineKind: "pass", margin: 10 });
ok(bl.line === 60 && bl.lineLabel === "及格线", "及格线 = 满分100×0.6 = 60", bl);
ok(bl.items.length === 2, "±10 分内命中 2 人（乙56/丙60）", bl.items.map((i) => `${i.studentName}:${i.totalScore}`));
ok(bl.items[0].studentName === "丙" && bl.items[0].distance === 0, "按距线升序，丙在前（恰好压线）", bl.items[0]);
ok(bl.items.some((i) => i.studentName === "乙" && i.side === "below" && i.distance === 4), "乙 56 分在线下 4 分", bl.items);
const blCustom = await repo.getBorderlineStudents(e1, { lineKind: "custom", lineValue: 55, margin: 3 });
ok(blCustom.items.length === 1 && blCustom.items[0].studentName === "乙" && blCustom.items[0].side === "above", "自定义线 55 ±3：乙(56)线上", blCustom.items);
const blClass = await repo.getBorderlineStudents(e1, { lineKind: "pass", margin: 30, classId: class2 });
ok(blClass.items.length === 1 && blClass.items[0].studentName === "戊", "班级过滤：2 班只戊在 ±30 内", blClass.items);

// ============================================================
console.log("\n== 建议 7 / Issue #264：偏科预警 getSubjectDeviation ==");
const dev = await repo.getSubjectDeviation([e1, e2]);
const e1Scores = [100, 56, 60, 90, 40];
const e2Scores = [70, 50, 80];
const m1 = mean(e1Scores), sd1 = stdDev(e1Scores);
const m2 = mean(e2Scores), sd2 = stdDev(e2Scores);
const zA1 = Math.round(((100 - m1) / sd1) * 100) / 100;
const itemA = dev.items.find((i) => i.studentId === uA)!;
ok(dev.items.length === 5, "参与 5 人", dev.items.length);
ok(itemA.subjects.length === 2, "甲两科都有分", itemA.subjects);
const subj1 = itemA.subjects.find((s) => s.examId === e1)!;
ok(subj1.z === zA1 && subj1.gradeAvg === Math.round(m1 * 10) / 10, "甲数学 Z 与手工一致", { got: subj1.z, expect: zA1 });
const itemB = dev.items.find((i) => i.studentId === uB)!;
ok(itemB.subjects.length === 1 && itemB.subjects[0].subject === "数学", "乙只有数学（缺语文场不参与 Z 比较）", itemB.subjects);
ok(itemA.flagged === false && itemA.lowestSubject === "语文", "甲两科都强，不预警", itemA);
// Issue #264：偏科以「单科相对个人跨科基线」判定，而非各科各自比年级均分
const subj2A = itemA.subjects.find((s) => s.examId === e2)!;
const ownMeanZ1 = (subj1.z + subj2A.z) / 2;
ok(Math.abs(itemA.ownMeanZ - ownMeanZ1) < 0.02, "甲个人基线 = 两科年级 Z 的均值", { got: itemA.ownMeanZ, expect: ownMeanZ1 });
// ±0.01 容差：relativeZ/ownMeanZ 由未修约值算出，展示字段（z/gradeStd 等）已修约，两者可能差 0.01
ok(Math.abs(subj2A.relativeZ - (subj2A.z - itemA.ownMeanZ)) <= 0.02, "语文相对落差 = 本场 Z − 个人基线", { relativeZ: subj2A.relativeZ, z: subj2A.z, ownMeanZ: itemA.ownMeanZ });
ok(Math.abs(itemA.lowestZ - subj2A.relativeZ) <= 0.01 && itemA.lowestZ < 0, "甲最低为相对落差（语文），非裸年级 Z", itemA.lowestZ);
const itemB2 = dev.items.find((i) => i.studentId === uB)!;
ok(itemB2.lowestZ === 0 && itemB2.flagged === false && itemB2.lowestSubject === "数学", "乙单科：相对落差恒 0，不判偏科", itemB2);
const itemC = dev.items.find((i) => i.studentId === uC)!;
// 丙 数学 z≈-0.41、语文 z≈-1.36（样本标准差口径），个人基线 ≈ -0.88 → 语文相对 ≈ -0.47；
// 裸年级 Z 达 -1.36 却因语文卷整体偏难，相对个人只偏 -0.47 —— 阈值 0.4 应预警、默认 0.8 不应预警
ok(Math.abs(itemC.lowestZ + 0.47) < 0.02 && itemC.lowestSubject === "语文", "丙语文相对落差 ≈ -0.47（裸 Z -1.36 是卷难，不是偏科）", itemC);
ok(itemC.flagged === false, "丙默认阈值 0.8 不预警", itemC.flagged);
const devTight = await repo.getSubjectDeviation([e1, e2], { threshold: 0.4 });
const itemCT = devTight.items.find((i) => i.studentId === uC)!;
ok(itemCT.flagged === true, "丙在阈值 0.4 下触发预警（相对个人基线判定）", itemCT);
const devClass = await repo.getSubjectDeviation([e1, e2], { classId: class1 });
ok(devClass.items.every((i) => i.className === "1班"), "班级过滤只输出 1 班学生", devClass.items.map((i) => i.className));

// ============================================================
console.log("\n== 建议 10：班级知识点掌握 getClassKnowledgeStats ==");
const kp = await repo.getClassKnowledgeStats(e1, [class1, class2]);
ok(kp.empty === false && kp.knowledgePoints.length === 2, "2 个知识点", kp.knowledgePoints);
ok(kp.coverageRate === 80, "标注覆盖率 8/10 = 80%", kp.coverageRate);
ok(kp.classes.length === 2 && kp.classes.some((c) => c.className === "1班"), "班级列表含 1班/2班", kp.classes);
const funcRow = kp.matrix.find((m) => m.knowledgePoint === "函数性质")!;
const c1Func = funcRow.byClass.find((b) => b.classId === class1)!;
ok(c1Func.scoreRate === 85, "1班 函数性质得分率 (40+20+36+40)/160 = 85", c1Func.scoreRate);
const derivRow = kp.matrix.find((m) => m.knowledgePoint === "导数")!;
const c2Deriv = derivRow.byClass.find((b) => b.classId === class2)!;
ok(c2Deriv.scoreRate === 0, "2班(戊) 导数得分率 0（q5-8 全 0 分）", c2Deriv.scoreRate);
const kpAll = await repo.getClassKnowledgeStats(e1);
ok(kpAll.coverageRate === 80 && kpAll.classes.length === 2, "无 classIds 时默认全部班级", kpAll.classes);

// 一题多知识点只增加雷达维度，不增加已覆盖作答数；数据中已含多班级学生。
const extraPoint = "多知识点覆盖率回归";
const addPoint = db.prepare("INSERT INTO knowledge_points (card_id, question_number, point_text) VALUES (?, ?, ?)");
addPoint.run(cardId, 1, extraPoint);
const kpMulti = await repo.getClassKnowledgeStats(e1, [class1, class2]);
ok(kpMulti.coverageRate === 80, "已标注题目新增知识点后覆盖率仍为 80%", kpMulti.coverageRate);
ok(JSON.stringify(kpMulti.matrix.filter((row) => row.knowledgePoint !== extraPoint)) === JSON.stringify(kp.matrix), "原知识点得分率与题数不变");
const extraClass = kpMulti.matrix.find((row) => row.knowledgePoint === extraPoint)?.byClass.find((row) => row.classId === class1);
ok(extraClass?.questionCount === 1 && extraClass.scoreRate === 77.5, "新增知识点独立统计：1 题、1 班得分率 77.5%", extraClass);
for (let q = 2; q <= 10; q++) addPoint.run(cardId, q, extraPoint);
const kpFull = await repo.getClassKnowledgeStats(e1);
ok(kpFull.coverageRate === 100, "全部题目覆盖且一题多知识点时为 100%，不超过上限", kpFull.coverageRate);
ok((await repo.getClassKnowledgeStats(e1, [class2])).coverageRate === 100, "班级筛选和多班级归属不放大覆盖率");
const kpUntagged = await repo.getClassKnowledgeStats(e2);
ok(kpUntagged.coverageRate === 0 && kpUntagged.empty, "无知识点标注时覆盖率为 0");
const kpNoScores = await repo.getClassKnowledgeStats(-1);
ok(kpNoScores.coverageRate === 0 && kpNoScores.empty, "无作答时覆盖率为 0");
db.prepare("DELETE FROM knowledge_points WHERE card_id = ? AND point_text = ?").run(cardId, extraPoint);

// ============================================================
console.log("\n== 建议 14/15：同卡对比 + 命题质量趋势 ==");
const cmp = await repo.getComparableExams(e1);
ok(cmp.cardId === cardId && cmp.exams.length === 2, "同卡对比找到 2 场（高一/高二数学月考）", cmp.exams.map((e) => e.examName));
ok(cmp.exams.some((e) => e.examId === e1 && e.difficulty === 0.692), "e1 难度 0.692（均分69.2/100）", cmp.exams.find((e) => e.examId === e1));
const quality = await repo.getSubjectQuality("数学");
ok(quality.points.length === 2, "数学命题质量 2 场", quality.points.length);
ok(quality.points.every((p) => p.difficulty > 0 && p.discrimination >= 0), "每场都有 P/D", quality.points);

// ============================================================
console.log("\n== 建议 5：AI 异步任务流 ==");
const jobId = await createAiAnalysisJob({ examId: e1, createdBy: uA });
const job0 = await getAiAnalysisJob(jobId);
ok(job0 !== null && job0.status === "queued", "创建任务为 queued", job0?.status);
// 执行：LLM 服务不可达 → 任务落 error（异常不逃逸出队列）
await enqueueAiAnalysisJob(jobId, { examId: e1 }).catch(() => {});
const job1 = await getAiAnalysisJob(jobId);
ok(job1 !== null && job1.status === "error", "执行失败落 error", job1?.error);
// 模拟服务启动前数据库中的遗留任务，仅调用启动清理入口时标记中断。
const staleId = await createAiAnalysisJob({ examId: e1 });
const runningId = await createAiAnalysisJob({ examId: e1 });
db.prepare("UPDATE ai_analysis_jobs SET status = 'running' WHERE id = ?").run(runningId);
const doneId = await createAiAnalysisJob({ examId: e1 });
db.prepare("UPDATE ai_analysis_jobs SET status = 'done', result = ? WHERE id = ?").run('{"summary":"saved"}', doneId);
const doneBefore = await getAiAnalysisJob(doneId);
await cleanupInterruptedAiJobs();
const stale = await getAiAnalysisJob(staleId);
const running = await getAiAnalysisJob(runningId);
ok(stale?.status === "error" && (stale.error ?? "").includes("服务重启中断"), "启动时清理残留 queued 任务", stale);
ok(running?.status === "error" && (running.error ?? "").includes("服务重启中断"), "启动时清理残留 running 任务", running);
ok(JSON.stringify(await getAiAnalysisJob(doneId)) === JSON.stringify(doneBefore), "启动清理保留已完成任务及结果");
ok(JSON.stringify(await getAiAnalysisJob(jobId)) === JSON.stringify(job1), "启动清理保留已有失败任务及错误原因");

const queuedId = await createAiAnalysisJob({ examId: e1 });
const newId = await createAiAnalysisJob({ examId: e1 });
ok((await getAiAnalysisJob(queuedId))?.status === "queued" && (await getAiAnalysisJob(newId))?.status === "queued", "正常创建新任务不会取消已有排队任务");
db.prepare("UPDATE ai_analysis_jobs SET status = 'running' WHERE id = ?").run(newId);
await cleanupInterruptedAiJobs();
ok((await getAiAnalysisJob(queuedId))?.status === "queued" && (await getAiAnalysisJob(newId))?.status === "running", "启动清理只执行一次，重复调用不影响本进程的新任务");

// ============================================================
console.log("\n== 建议 8：知识点合并写入 mergeByCard ==");
const kpr = new KnowledgePointRepository();
await kpr.mergeByCard(cardId, [{ question_number: 9, point_text: "概率统计" }]);
await kpr.mergeByCard(cardId, [{ question_number: 9, point_text: "概率统计" }]); // 幂等
const rows9 = await kpr.findByCardId(cardId);
ok(rows9.filter((r) => r.question_number === 9 && r.point_text === "概率统计").length === 1, "重复合并只写入 1 条", rows9.filter((r) => r.question_number === 9));
const kpAfter = await repo.getClassKnowledgeStats(e1);
ok(kpAfter.coverageRate === 90 && kpAfter.knowledgePoints.length === 3, "合并后覆盖率 90%（9/10）、3 个知识点", kpAfter.coverageRate);

// ============================================================
console.log("\n== 建议 6：分析缓存 LRU 与精准失效 ==");
analysisCache.clear(); // 前面各节已缓存 e1/e3 概览，先清空保证断言独立
const ov1 = await repo.getExamOverview(e1);
ok(analysisCache.size === 1, "overview 首次计算后入缓存（1 条）", analysisCache.size);
const ov2 = await repo.getExamOverview(e1);
ok(ov2 === ov1, "第二次命中缓存（同一对象引用）");
ok(analysisCache.size === 1, "命中不新增条目");
const ovClass = await repo.getExamOverview(e1, class1);
ok(analysisCache.size === 2, "班级过滤是独立缓存键", analysisCache.size);
analysisCache.invalidateExam(e1);
ok(analysisCache.size === 0, "invalidateExam 清空该场考试全部缓存", analysisCache.size);
const ov3 = await repo.getExamOverview(e1);
ok(ov3.avgScore === ov1.avgScore, "失效后重算结果一致", { a: ov3.avgScore, b: ov1.avgScore });

// 清理
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n\x1b[36m结果：${pass} 通过，${fail} 失败\x1b[0m`);
if (fail > 0) process.exit(1);
