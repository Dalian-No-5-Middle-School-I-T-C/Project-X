/**
 * issue #345 回归验证：进步/退步按「得分率变化（百分点）」判定，不再按绝对分差。
 *
 * 缺陷：不同卷子的满分不同，绝对分差不可比。150 分卷涨 3 分只有 2%，100 分卷涨 3 分是 3%；
 *  旧口径统一用 `> 3 分` 作阈值，导致满分大的卷子更容易被贴上「进步」标签。
 * 修复：判定统一在得分率上做差（src/shared/scoreProgress.ts），阈值 ±3 pp；
 *  满分解析不出来的考试 direction=unknown，界面留空，绝不退回绝对分、也不虚构满分。
 *
 * 夹具用「绝对分与得分率方向相反」的数据，直接钉住新旧口径的差异：
 *   物理 70/100 → 85/150：绝对 +15 分（旧口径判进步），得分率 −13.3 pp（新口径判退步）
 *   化学 90/150 → 65/100：绝对 −25 分（旧口径判退步），得分率 +5.0 pp（新口径判进步）
 *   数学 60/100 → 90/150：绝对 +30 分（旧口径判进步），得分率 0.0 pp（新口径判稳定）
 *   生物 60/100 → 70/满分未知：得分率不可算（新口径 unknown，不出现在进/退步名单）
 *
 * 用法: npx tsx scripts/verify-progress-score-rate.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import bcrypt from "bcryptjs";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-progress-rate-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
process.env.PROJECTX_TOKEN_DIR = path.join(tmpDir, "tokens");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}

const DEMO_ADMIN_PASSWORD = "Admin@ProgressRate2026";
async function login(base: string, identifier: string, password: string): Promise<{ token?: string; status: number; body: any }> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  const body = await r.json().catch(() => ({}));
  return { token: body.token, status: r.status, body };
}
async function loginAdmin(base: string, initial: string): Promise<string> {
  const first = await login(base, "admin", initial);
  if (first.token && !first.body?.passwordChangeRequired) return first.token;
  if (first.status === 428 || first.body?.code === "PASSWORD_CHANGE_REQUIRED" || first.body?.passwordChangeRequired) {
    await fetch(`${base}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${first.body?.token ?? ""}` },
      body: JSON.stringify({ oldPassword: initial, newPassword: DEMO_ADMIN_PASSWORD }),
    }).catch(() => {});
    const retry = await login(base, "admin", DEMO_ADMIN_PASSWORD);
    if (retry.token) return retry.token;
    throw new Error(`admin 自动改密失败：首次=${first.status}，重试=${retry.status}`);
  }
  throw new Error(`admin 登录失败: status=${first.status}`);
}

/** 逐题满分行：满分 = 各 (题号, 题型) 的 MAX(max_score) 之和（getExamFullScoreMap 兜底口径）。 */
function addFullScoreRows(
  db: { prepare: (sql: string) => { run: (...args: any[]) => any } },
  examId: number, studentId: number, parts: Array<{ number: number; type: string; max: number }>
): void {
  for (const p of parts) {
    db.prepare(
      `INSERT INTO question_scores (exam_id, student_id, question_number, question_id, block_id, score, max_score, score_type)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(examId, studentId, p.number, `q${examId}_${p.number}`, `b${p.type}`, p.max, p.type);
  }
}

async function main() {
  console.log(`临时库: ${process.env.PROJECTX_DB_PATH}`);
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { ScoreRepository } = await import("../src/server/repositories/ScoreRepository");
  const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");
  const {
    judgeProgress, meanScoreRate, scoreRateChange, scoreRateOf, hasResolvableFullScore,
    PROGRESS_RATE_THRESHOLD_PP,
  } = await import("../src/shared/scoreProgress");

  // ── 1. 纯函数：统一口径本身 ──
  {
    console.log("\n[1] 共享得分率函数");
    ok(PROGRESS_RATE_THRESHOLD_PP === 3, "1.1 阈值为 ±3 个百分点");
    ok(scoreRateOf(85, 150) === 56.7, `1.2 得分率 85/150=56.7%（实际 ${scoreRateOf(85, 150)}）`);
    ok(scoreRateOf(70, 0) === null && scoreRateOf(70, null) === null, "1.3 满分不可解析 → null（不虚构分母）");
    ok(hasResolvableFullScore(0) === false && hasResolvableFullScore(150) === true, "1.4 满分 0 视为不可解析");
    ok(scoreRateChange(56.7, 70) === -13.3, `1.5 变化量 56.7−70=−13.3 pp（实际 ${scoreRateChange(56.7, 70)}）`);
    ok(scoreRateChange(56.7, null) === null, "1.6 任一侧缺满分 → 变化量 null");
    ok(judgeProgress(-13.3) === "down", "1.7 −13.3 pp → down（绝对 +15 分曾误判 up）");
    ok(judgeProgress(5) === "up" && judgeProgress(0) === "stable", "1.8 +5 pp → up，0 pp → stable");
    ok(judgeProgress(2.9) === "stable" && judgeProgress(3) === "up", "1.9 阈值边界：2.9 pp 稳定 / 3.0 pp 进步");
    ok(judgeProgress(null) === "unknown", "1.10 不可判定 → unknown（不是 stable）");
    ok(meanScoreRate([70, 60, 60]) === 63.3, `1.11 均值 63.3（实际 ${meanScoreRate([70, 60, 60])}）`);
    ok(meanScoreRate([70, null]) === null && meanScoreRate([]) === null, "1.12 任一成员缺满分 → 整体不可判定");
  }

  initializeDatabase();
  const db = getDatabase();
  const bootstrap = await ensureDefaultAdmin();

  // ── 夹具 ──
  const gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES ('得分率测试年级', 1, 0)").run().lastInsertRowid);
  const classId = Number(db.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '得分率A班', 1, 0)").run(gradeId).lastInsertRowid);

  function addStudent(sn: string, name: string): number {
    const id = Number(db.prepare(
      "INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES (?, ?, ?, 3, ?, 1)"
    ).run(sn, bcrypt.hashSync(sn, 10), name, sn).lastInsertRowid);
    db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classId, id);
    return id;
  }
  const sPhysics = addStudent("51001", "得分率-物理");
  const sTwo = addStudent("51002", "得分率-化学数学");
  const sBio = addStudent("51003", "得分率-生物");

  /** fullParts 为空数组 → 该场考试没有任何满分来源。 */
  function makeExam(subject: string, name: string, startTime: string, studentId: number, totalScore: number, fullParts: Array<{ number: number; type: string; max: number }>): number {
    const examId = Number(db.prepare(
      `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, score_published, exam_mode, created_by)
       VALUES (?, NULL, ?, ?, ?, ?, 'closed', 1, 'formal', (SELECT id FROM users WHERE username='admin'))`
    ).run(name, gradeId, classId, subject, startTime).lastInsertRowid);
    db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)")
      .run(examId, studentId, totalScore, totalScore);
    addFullScoreRows(db, examId, studentId, fullParts);
    return examId;
  }

  // 上学期（2025-09 ~ 2025-12 → 2025-1）与本学期（2026-03 ~ 2026-06 → 2025-2）
  const eP1 = makeExam("物理", "物理上学期（满分100）", "2025-09-15 10:00:00", sPhysics, 70,
    [{ number: 1, type: "objective", max: 50 }, { number: 2, type: "subjective", max: 50 }]);
  const eP2 = makeExam("物理", "物理本学期（满分150）", "2026-03-10 10:00:00", sPhysics, 85,
    [{ number: 1, type: "objective", max: 100 }, { number: 2, type: "subjective", max: 50 }]);
  const eC1 = makeExam("化学", "化学上学期（满分150）", "2025-10-20 10:00:00", sTwo, 90,
    [{ number: 1, type: "objective", max: 100 }, { number: 2, type: "subjective", max: 50 }]);
  const eC2 = makeExam("化学", "化学本学期（满分100）", "2026-04-05 10:00:00", sTwo, 65,
    [{ number: 1, type: "objective", max: 50 }, { number: 2, type: "subjective", max: 50 }]);
  const eM1 = makeExam("数学", "数学上学期（满分100）", "2025-11-10 10:00:00", sTwo, 60,
    [{ number: 1, type: "objective", max: 50 }, { number: 2, type: "subjective", max: 50 }]);
  const eM2 = makeExam("数学", "数学本学期（满分150）", "2026-05-08 10:00:00", sTwo, 90,
    [{ number: 1, type: "objective", max: 100 }, { number: 2, type: "subjective", max: 50 }]);
  const eB1 = makeExam("生物", "生物上学期（满分100）", "2025-12-01 10:00:00", sBio, 60,
    [{ number: 1, type: "objective", max: 50 }, { number: 2, type: "subjective", max: 50 }]);
  const eB2 = makeExam("生物", "生物本学期（无满分依据）", "2026-06-01 10:00:00", sBio, 70, []);

  const app = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const adminToken = await loginAdmin(base, readFileSync(bootstrap.passwordFile, "utf8").trim());
  async function studentHeaders(sn: string): Promise<Record<string, string>> {
    const r = await login(base, sn, sn);
    if (!r.token) throw new Error(`学生 ${sn} 登录失败: ${r.status}`);
    return { Authorization: `Bearer ${r.token}` };
  }
  ok(Boolean(adminToken), "2.1 admin / 学生账号可用");

  const hPhysics = await studentHeaders("51001");
  const hTwo = await studentHeaders("51002");
  const hBio = await studentHeaders("51003");

  // ── 3. /me/trends 携带满分与得分率 ──
  {
    console.log("\n[3] /api/scores/me/trends 满分与得分率");
    const r = await fetch(`${base}/api/scores/me/trends`, { headers: hPhysics });
    const list = (await r.json().catch(() => [])) as any[];
    ok(r.status === 200 && list.length === 2, `3.1 物理趋势 2 场（实际 ${list.length}）`);
    ok(list.every((t) => "fullScore" in t && "scoreRate" in t), "3.2 每条含 fullScore / scoreRate");
    const p1 = list.find((t) => t.examId === eP1);
    const p2 = list.find((t) => t.examId === eP2);
    ok(p1?.fullScore === 100 && p1?.scoreRate === 70, `3.3 上学期 70/100 → 得分率 70%（实际 ${p1?.scoreRate}）`);
    ok(p2?.fullScore === 150 && p2?.scoreRate === 56.7, `3.4 本学期 85/150 → 得分率 56.7%（实际 ${p2?.scoreRate}）`);

    const rb = await fetch(`${base}/api/scores/me/trends`, { headers: hBio });
    const lb = (await rb.json().catch(() => [])) as any[];
    const b2 = lb.find((t) => t.examId === eB2);
    ok(b2?.fullScore === null && b2?.scoreRate === null, "3.5 无满分依据 → fullScore/scoreRate 均为 null（不写 0）");
  }

  // ── 4. /me/subject-comparison 的 trend 按得分率 ──
  {
    console.log("\n[4] /api/scores/me/subject-comparison 学科趋势");
    const r = await fetch(`${base}/api/scores/me/subject-comparison`, { headers: hTwo });
    const body = (await r.json().catch(() => ({ subjects: [] }))) as any;
    const byName = new Map<string, any>((body.subjects ?? []).map((s: any) => [s.subject, s]));
    ok(r.status === 200, `4.1 接口 200（实际 ${r.status}）`);
    ok(byName.get("化学")?.trend === "up", `4.2 化学 −25 分但 +5.0 pp → up（实际 ${byName.get("化学")?.trend}）`);
    ok(byName.get("数学")?.trend === "stable", `4.3 数学 +30 分但 0.0 pp → stable（实际 ${byName.get("数学")?.trend}）`);

    const rb = await fetch(`${base}/api/scores/me/subject-comparison`, { headers: hBio });
    const bb = (await rb.json().catch(() => ({ subjects: [] }))) as any;
    ok(bb.subjects?.[0]?.trend === "unknown", `4.4 生物缺满分 → unknown（实际 ${bb.subjects?.[0]?.trend}）`);
  }

  // ── 5. /me/semester-comparison 进退步名单与学期得分率 ──
  {
    console.log("\n[5] /api/scores/me/semester-comparison 学期对比");
    const rp = await fetch(`${base}/api/scores/me/semester-comparison`, { headers: hPhysics });
    const bp = (await rp.json().catch(() => ({}))) as any;
    const phy = (bp.subjectComparisons ?? []).find((c: any) => c.subject === "物理");
    ok(rp.status === 200, `5.1 学期对比 200（此前无 subjectComparisons 字段）`);
    ok(bp?.current?.avgScoreRate === 56.7 && bp?.previous?.avgScoreRate === 70,
      `5.2 学期得分率 70.0% → 56.7%（实际 ${bp?.previous?.avgScoreRate} → ${bp?.current?.avgScoreRate}）`);
    ok(bp?.avgScoreRateChange === -13.3, `5.3 得分率变化 −13.3 pp（实际 ${bp?.avgScoreRateChange}）`);
    ok(bp?.avgScoreChange === 15, `5.4 绝对均分差 +15 仍返回，仅作展示（实际 ${bp?.avgScoreChange}）`);
    ok((bp?.declinedSubjects ?? []).includes("物理"), "5.5 物理计入退步学科（旧口径 +15 分会误判为进步）");
    ok(!(bp?.improvedSubjects ?? []).includes("物理"), "5.6 物理不再被贴「进步」标签");
    ok(phy?.direction === "down" && phy?.scoreRateChange === -13.3, `5.7 subjectComparisons 物理 direction=down（实际 ${phy?.direction}）`);
    ok(phy?.currentScoreRate === 56.7 && phy?.previousScoreRate === 70, "5.8 对比行返回两侧得分率");

    const rt = await fetch(`${base}/api/scores/me/semester-comparison`, { headers: hTwo });
    const bt = (await rt.json().catch(() => ({}))) as any;
    ok((bt?.improvedSubjects ?? []).includes("化学"), `5.9 化学 −25 分但 +5.0 pp → 进步（名单 ${JSON.stringify(bt?.improvedSubjects)}）`);
    ok(!(bt?.declinedSubjects ?? []).includes("化学"), "5.10 化学不再被贴「退步」标签");
    ok(!(bt?.improvedSubjects ?? []).includes("数学") && !(bt?.declinedSubjects ?? []).includes("数学"),
      "5.11 数学 0.0 pp → 既非进步也非退步（旧口径 +30 分会误判进步）");

    const rb = await fetch(`${base}/api/scores/me/semester-comparison`, { headers: hBio });
    const bb = (await rb.json().catch(() => ({}))) as any;
    const bio = (bb.subjectComparisons ?? []).find((c: any) => c.subject === "生物");
    ok(bio?.direction === "unknown", `5.12 生物缺满分 → direction=unknown（实际 ${bio?.direction}）`);
    ok((bb?.improvedSubjects ?? []).length === 0 && (bb?.declinedSubjects ?? []).length === 0,
      "5.13 不可判定的学科不进任何进/退步名单");
    ok(bb?.current?.avgScoreRate === null && bb?.avgScoreRateChange === null, "5.14 缺满分的学期不给虚假得分率均值");
    ok(typeof bb?.avgScoreChange === "number", `5.15 绝对均分差仍可用于展示（实际 ${bb?.avgScoreChange}）`);
  }

  // ── 6. /me/ai-analysis 文案与说明 ──
  {
    console.log("\n[6] /api/scores/me/ai-analysis");
    const r = await fetch(`${base}/api/scores/me/ai-analysis`, { method: "POST", headers: { ...hPhysics, "Content-Type": "application/json" }, body: "{}" });
    const body = (await r.json().catch(() => ({}))) as any;
    ok(r.status === 200, `6.1 分析接口 200（实际 ${r.status}）`);
    const weak: string[] = body?.report?.weakPoints ?? [];
    ok(weak.some((t) => t.includes("物理") && t.includes("得分率")),
      `6.2 下滑说明以得分率表述，不再只报绝对分变化（实际 ${JSON.stringify(weak)}）`);

    const rb = await fetch(`${base}/api/scores/me/ai-analysis`, { method: "POST", headers: { ...hBio, "Content-Type": "application/json" }, body: "{}" });
    const bb = (await rb.json().catch(() => ({}))) as any;
    const caveats: string[] = bb?.report?.caveats ?? [];
    const unjudged = caveats.filter((c) => c.includes("缺少满分依据"));
    ok(unjudged.some((c) => c.includes("生物")),
      `6.3 缺满分学科向学生说明「未参与进步/退步判定」（实际 ${JSON.stringify(unjudged)}）`);
    const caveatsP: string[] = body?.report?.caveats ?? [];
    ok(!caveatsP.some((c) => c.includes("缺少满分依据")), "6.4 满分齐全的学科不产生该说明");
  }

  // ── 7. 教师端单场「较上届」对比同样按得分率 ──
  {
    console.log("\n[7] AnalysisRepository 教师端上届对比");
    const repo = new AnalysisRepository();
    const cmp = await repo.getPreviousExamComparison(eP2);
    ok(cmp.avgScoreChange === 15, `7.1 绝对均分差 +15 保留为展示值（实际 ${cmp.avgScoreChange}）`);
    ok(cmp.avgScoreRateChange === -13.3, `7.2 得分率变化 −13.3 pp 作为判定值（实际 ${cmp.avgScoreRateChange}）`);
    ok(cmp.prevExamId === eP1, `7.3 上届识别正确（实际 ${cmp.prevExamId} vs ${eP1}）`);

    const cmpBio = await repo.getPreviousExamComparison(eB2);
    ok(cmpBio.avgScoreRateChange === null, `7.4 本届无满分 → 得分率变化 null（实际 ${cmpBio.avgScoreRateChange}）`);
    ok(typeof cmpBio.avgScoreChange === "number", `7.5 绝对差仍可展示（实际 ${cmpBio.avgScoreChange}）`);
    ok(cmpBio.passRateChange === null, "7.6 缺满分时及格率变化同样不比较");

    const trend = await repo.getStudentTrend(sBio);
    ok(trend.every((t) => typeof t.scoreRate === "number" || t.scoreRate === null), "7.7 getStudentTrend 的 scoreRate 为数值或 null");
    ok(trend.find((t) => t.examId === eB2)?.scoreRate === null, "7.8 无满分场次 scoreRate=null（不是 0）");
  }

  // ── 8. 旧口径不复现：确认判定不再受满分大小带偏 ──
  {
    console.log("\n[8] 新旧口径对照");
    const absChange = 85 - 70;
    ok(absChange > PROGRESS_RATE_THRESHOLD_PP, `8.1 绝对分 +15 在旧阈值下会判「进步」（说明这是真实回归点）`);
    const repo = new ScoreRepository();
    const cmp = await repo.getStudentSemesterComparison(sPhysics);
    ok(cmp.improvedSubjects.length === 0 && cmp.declinedSubjects.includes("物理"), "8.2 同一份数据新口径只判「退步」");
    const empty = await repo.getStudentSemesterComparison(999999);
    ok(empty.avgScoreRateChange === null && empty.subjectComparisons.length === 0, "8.3 无成绩学生返回空结构，不抛异常");
  }

  server.close();
  closeDatabase();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log("");
  if (failed === 0) console.log(`\x1b[32m全部通过：${passed} 项\x1b[0m`);
  else console.log(`\x1b[31m失败 ${failed} 项 / 通过 ${passed} 项\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
