/**
 * 每周考试审计（周报告发布）冒烟验证
 * ----------------------------------------------------------------
 * 覆盖发布规则（产品需求）：
 *  - 每周六上午 08:00 发布本周报告；周五考试未完成 → 顺延到全部完成
 *  - checkWeekComplete：quiz 考试全部有出分才算完成；草稿不计入门槛
 *  - publishDueWeeks：未到周六 08:00 不发布；到点但未完成不发布（顺延）；
 *    完成后发布（幂等 ensure 周组）；跨周仍可顺延复核上周
 *  - getSummary 只读已发布组：未发布周 active=null + 未发布状态/顺延原因；
 *    已发布周返回完整汇总（场次/参评/得分率/覆盖天数/班级对比/薄弱 Top5/较上周）
 *  - 排除：formal 大考 / 无出分 quiz / 草稿 quiz / 无年级 quiz
 *
 * 运行：npx tsx scripts/weekly-audit-smoke.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-weekly-audit-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "smoke.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

const STUDENT_NUMS = [
  "20260101", "20260102", "20260103", "20260104",
  "20260105", "20260106", "20260107", "20260108",
  "20260109", "20260110", "20260111", "20260112",
  "20260113", "20260114", "20260115", "20260116"
];

/** 每位学生的总分（0-150），制造班级间与题间差异 */
const BASE_TOTALS = [138, 125, 118, 140, 128, 115, 122, 135, 130, 120, 128, 116, 124, 132, 121, 127];

/** 5 道客观题每题满分 30；压低第 3 题制造「薄弱题」 */
function questionScores(total: number): number[] {
  const perQ = Math.floor(total / 5);
  const remainder = total - perQ * 5;
  const q = [perQ, perQ, perQ, perQ, perQ + remainder];
  q[2] = Math.max(0, q[2] - 8);
  q[4] = Math.min(30, q[4] + 8);
  return q;
}

/** 本地时区日期偏移（避免 toISOString 的 UTC 偏移导致日期错位） */
function addDaysLocal(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main(): Promise<void> {
  console.log(`临时数据库: ${process.env.PROJECTX_DB_PATH}`);

  const { initializeDatabase, ensureDefaultAdmin, getDatabase } = await import("../src/server/db/index");
  const { seedDemoData } = await import("../src/server/services/DemoDataService");
  const { getWeekWindow, weekPublishAt, weekWindowFor, WeeklyAuditService } = await import("../src/server/services/WeeklyAuditService");
  const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");

  initializeDatabase();
  await ensureDefaultAdmin();
  await seedDemoData();
  const db = getDatabase();

  const gradeId = (db.prepare("SELECT id FROM grades WHERE name = '高一(演示)'").get() as { id: number }).id;
  const studentIds = STUDENT_NUMS.map((num) => (db.prepare("SELECT id FROM users WHERE student_number = ?").get(num) as { id: number }).id);

  // ── 关键时间点（相对真实本周窗口，保证与机器时钟一致） ──
  const week = getWeekWindow(0);
  const prevWeek = getWeekWindow(-1);
  const publishAt = weekPublishAt(week.weekStart);          // 本周六 08:00
  const fridayBefore = new Date(publishAt.getTime() - 9 * 3600_000); // 周五 23:00
  const saturday8 = new Date(publishAt.getTime());          // 周六 08:00
  const mondayAfter = new Date(publishAt.getTime() + 2 * 86400000); // 下周一 08:00

  // ── 数据准备 ──
  section("数据准备");
  let cardSeq = 1;
  function insertQuizExam(name: string, subject: string, dateStr: string, status: string, totals: number[], withNullGrade = false): number {
    const cardId = `WA${String(cardSeq++).padStart(7, "0")}`;
    db.prepare("INSERT INTO answer_cards (id, title, subject_label, exam_date) VALUES (?, ?, ?, ?)")
      .run(cardId, name, subject, dateStr);
    const info = db.prepare(`
      INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, closed_at, exam_mode, created_by)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'quiz', (SELECT id FROM users WHERE username = 'admin'))
    `).run(name, cardId, withNullGrade ? null : gradeId, subject, dateStr, status);
    const examId = Number(info.lastInsertRowid);
    for (const [i, total] of totals.entries()) {
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)")
        .run(examId, studentIds[i], total, total);
      const qs = questionScores(total);
      for (let q = 1; q <= 5; q++) {
        db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type) VALUES (?, ?, ?, ?, 30, 'objective')")
          .run(examId, studentIds[i], q, qs[q - 1]);
      }
    }
    return examId;
  }
  function insertFormalExam(name: string, subject: string, dateStr: string): number {
    const cardId = `WA${String(cardSeq++).padStart(7, "0")}`;
    db.prepare("INSERT INTO answer_cards (id, title, subject_label, exam_date) VALUES (?, ?, ?, ?)")
      .run(cardId, name, subject, dateStr);
    const info = db.prepare(`
      INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, closed_at, exam_mode, created_by)
      VALUES (?, ?, ?, ?, ?, 'closed', CURRENT_TIMESTAMP, 'formal', (SELECT id FROM users WHERE username = 'admin'))
    `).run(name, cardId, gradeId, subject, dateStr);
    const examId = Number(info.lastInsertRowid);
    for (const [i, total] of BASE_TOTALS.entries()) {
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)")
        .run(examId, studentIds[i], total, total);
    }
    return examId;
  }

  insertQuizExam("晨测-语文", "语文", week.weekStart, "closed", BASE_TOTALS);
  insertQuizExam("晨测-数学", "数学", addDaysLocal(week.weekStart, 1), "closed", BASE_TOTALS);
  insertQuizExam("晨测-英语", "英语", addDaysLocal(week.weekStart, 2), "closed", BASE_TOTALS);
  // 周五化学：已关闭但未出分 → 阻塞本周发布（顺延）
  const chemistryExamId = insertQuizExam("晨测-化学", "化学", addDaysLocal(week.weekStart, 4), "closed", []);
  // 草稿 exam：不计入完成门槛（无出分也不阻塞）
  insertQuizExam("晨测-草稿生物", "生物", addDaysLocal(week.weekStart, 3), "draft", []);
  // 上周完整考试（供较上周对比 + 上周发布）
  insertQuizExam("晨测-上周数学", "数学", addDaysLocal(prevWeek.weekStart, 2), "closed", BASE_TOTALS.map((t) => t - 10));
  // 干扰项：formal 大考（never 触发门槛/入组）；无年级 quiz（不算发布门槛阻塞但入不了组）
  insertFormalExam("大考-本周物理", "物理", week.weekStart);
  insertQuizExam("晨测-无年级", "生物", addDaysLocal(week.weekStart, 3), "closed", BASE_TOTALS, true);

  const svc = new WeeklyAuditService();

  // ── 完成门槛 ──
  section("checkWeekComplete（完成门槛）");
  let check = await svc.checkWeekComplete(week.weekStart);
  ok(check.complete === false, `本周未完成（化学未出分）: complete=false`);
  ok(check.pendingExamNames.includes("晨测-化学"), `顺延原因列出生化：${check.pendingExamNames.join("、")}`);
  ok(!check.pendingExamNames.includes("晨测-草稿生物"), "草稿考试不计入门槛");
  ok(check.pendingExamNames.every((n) => !n.startsWith("大考-")), "formal 大考不计入门槛");
  check = await svc.checkWeekComplete(prevWeek.weekStart);
  ok(check.complete === true, "上周全部完成");

  // ── 发布时刻门槛 ──
  section("发布时刻（每周六 08:00）");
  // 注意：demo 数据自带「演示-第25周考试包」（source='week' 且 grade_id 为 NULL，exam_mode=formal），
  // 周组计数一律按 start_date 定位；上周数据已完整，周五检查时会被补发（合法回填）。
  // published = 本轮 ensure 过的周（含空周）；created = 本轮新建组的周。
  let result = await svc.publishDueWeeks(fridayBefore);
  ok(!result.published.includes(week.label), "周五 23:00：本周未到点不发布");
  ok(result.created.length === 1 && result.created[0] === prevWeek.label, `周五 23:00：仅补发上周（created: ${result.created.join("、")}）`);
  result = await svc.publishDueWeeks(saturday8);
  ok(!result.published.includes(week.label) && result.created.length === 0, "周六 08:00：本周化学未完成 → 顺延，无新发布");
  const currentWeekGroupCount = (db.prepare("SELECT COUNT(*) AS c FROM exam_groups WHERE source = 'week' AND start_date = ? AND end_date = ?").get(week.weekStart, week.weekEnd) as { c: number }).c;
  ok(currentWeekGroupCount === 0, `本周尚未建组（0 个，实际 ${currentWeekGroupCount}）`);

  // ── 读取侧未发布状态 ──
  section("getSummary（未发布周）");
  const resPending = await svc.getSummary(undefined, undefined, new Date(saturday8.getTime() + 60_000));
  ok(resPending.weeks[0]!.published === false, "本周未发布");
  ok(resPending.weeks[0]!.pendingExamNames.includes("晨测-化学"), "未发布原因含未完成考试");
  ok(resPending.weeks[1]!.published === true, "上周（已过发布点且完成）已发布");
  ok(resPending.grades.length === 0 && resPending.active === null, "未发布周无数据");

  // ── 完成 → 发布 ──
  section("完成化学后发布（周六 08:00）");
  for (const [i, total] of BASE_TOTALS.entries()) {
    db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)")
      .run(chemistryExamId, studentIds[i], total, total);
    const qs = questionScores(total);
    for (let q = 1; q <= 5; q++) {
      db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type) VALUES (?, ?, ?, ?, 30, 'objective')")
        .run(chemistryExamId, studentIds[i], q, qs[q - 1]);
    }
  }
  check = await svc.checkWeekComplete(week.weekStart);
  ok(check.complete === true, "化学出分后本周完成");
  result = await svc.publishDueWeeks(saturday8);
  const afterCount = (db.prepare("SELECT COUNT(*) AS c FROM exam_groups WHERE source = 'week' AND start_date IN (?, ?)").get(week.weekStart, prevWeek.weekStart) as { c: number }).c;
  ok(result.created.length === 1 && result.created[0] === week.label, `发布本周（created: ${result.created.join("、")}）`);
  ok(afterCount === 2, `本周+上周建组 2 个（实际 ${afterCount}，demo 自带周组另计）`);

  // ── 组落库检查 ──
  section("exam_groups 落库（本周组）");
  const groupRow = db.prepare("SELECT * FROM exam_groups WHERE source = 'week' AND start_date = ? AND end_date = ?").get(week.weekStart, week.weekEnd) as any;
  ok(groupRow != null, "存在本周组");
  ok(groupRow.grade_id === gradeId, `grade_id 写入（${groupRow.grade_id}）`);
  ok(/^\d{4}年第\d+周晨测包（\d{2}-\d{2} ~ \d{2}-\d{2}）$/.test(groupRow.name), `组名格式: ${groupRow.name}`);
  let memberCount = (db.prepare("SELECT COUNT(*) AS c FROM exam_group_members WHERE group_id = ?").get(groupRow.id) as { c: number }).c;
  ok(memberCount === 4, `组成员 4（语文/数学/英语/化学；草稿/大考/无年级不入组），实际 ${memberCount}`);
  const sortOrders = db.prepare("SELECT sort_order FROM exam_group_members WHERE group_id = ? ORDER BY sort_order").all(groupRow.id) as Array<{ sort_order: number }>;
  ok(sortOrders.every((r, i) => r.sort_order === i), "sort_order 连续且按日期排序");

  // ── 已发布周汇总 ──
  section("getSummary（已发布周）");
  const resPub = await svc.getSummary(undefined, undefined, new Date(saturday8.getTime() + 3600_000));
  ok(resPub.weeks[0]!.published === true, "本周已发布");
  ok(resPub.weeks[0]!.pendingExamNames.length === 0, "无顺延原因");
  ok(resPub.grades.length === 1, `年级列表 1 个（实际 ${resPub.grades.length}）`);
  ok(resPub.grades[0]!.examCount === 4, `年级 examCount 4（实际 ${resPub.grades[0]!.examCount}）`);
  const active = resPub.active!;
  ok(active != null && active.examCount === 4, `晨测场次 4（实际 ${active?.examCount}）`);
  ok(active.participantCount === 16, `参评 16（实际 ${active.participantCount}）`);
  ok(active.attendedCount === 64, `出勤 64 人次（实际 ${active.attendedCount}）`);
  ok(active.coverageDays === 4, `覆盖 4 个工作日（实际 ${active.coverageDays}）`);
  ok(active.classSummaries.length === 2, `班级对比 2（实际 ${active.classSummaries.length}）`);
  ok(active.weakPoints.length === 5, `薄弱 Top5 5 条（实际 ${active.weakPoints.length}）`);
  ok(active.weakPoints.every((p, i) => i === 0 || active.weakPoints[i - 1].scoreRate <= p.scoreRate), "薄弱题按得分率升序");
  ok(active.weakPoints[0]!.questionNumber === "3", `最薄弱为第 3 题（实际 ${active.weakPoints[0]?.questionNumber}）`);
  ok(active.vsLastWeek != null && active.vsLastWeek.examCountChange === 3, `较上周场次 +3（实际 ${active.vsLastWeek?.examCountChange}）`);
  ok(active.vsLastWeek!.avgScoreRateChange != null && active.vsLastWeek!.avgScoreRateChange > 0, `较上周得分率上升（实际 ${active.vsLastWeek?.avgScoreRateChange}）`);

  // ── 幂等 ──
  section("幂等");
  const res2 = await svc.publishDueWeeks(new Date(saturday8.getTime() + 7200_000));
  ok(res2.created.length === 0, "重复发布为幂等 no-op（不新建组，仅重复 ensure）");
  const memberCount2 = (db.prepare("SELECT COUNT(*) AS c FROM exam_group_members WHERE group_id = ?").get(groupRow.id) as { c: number }).c;
  ok(memberCount2 === 4, `成员不变（${memberCount2}）`);
  const weekGroupCount = (db.prepare("SELECT COUNT(*) AS c FROM exam_groups WHERE source = 'week' AND start_date = ?").get(week.weekStart) as { c: number }).c;
  ok(weekGroupCount === 1, `本周仅 1 个组（实际 ${weekGroupCount}）`);

  // ── 成员漂移（发布后新出分晨测自动入组） ──
  section("成员漂移");
  insertQuizExam("晨测-周五英语", "英语", addDaysLocal(week.weekStart, 4), "closed", BASE_TOTALS);
  const res3 = await svc.publishDueWeeks(new Date(saturday8.getTime() + 3 * 3600_000));
  const memberCount3 = (db.prepare("SELECT COUNT(*) AS c FROM exam_group_members WHERE group_id = ?").get(groupRow.id) as { c: number }).c;
  ok(memberCount3 === 5, `新出分晨测自动入组（成员 5，实际 ${memberCount3}）`);
  const resPub2 = await svc.getSummary(undefined, undefined, new Date(saturday8.getTime() + 3 * 3600_000));
  ok(resPub2.active!.examCount === 5, `汇总场次同步 5（实际 ${resPub2.active!.examCount}）`);

  // ── 跨周顺延复核：本周再次出现未完成考试 → 继续等待 ──
  section("跨周顺延");
  insertQuizExam("晨测-周六补测", "生物", addDaysLocal(week.weekStart, 5), "closed", []);
  const resDefer = await svc.publishDueWeeks(mondayAfter);
  ok(!resDefer.published.includes(week.label) && resDefer.created.length === 0, "下周一复核：本周又出现未完成 → 顺延不发布");
  const memberCount4 = (db.prepare("SELECT COUNT(*) AS c FROM exam_group_members WHERE group_id = ?").get(groupRow.id) as { c: number }).c;
  ok(memberCount4 === 5, "顺延期组不变（成员仍 5，实际不变才正确）");

  // ── 历史周回补：晚于一周才出分的周（近 5 周窗口内）仍可补发 ──
  section("历史周回补");
  const backfillWeek = getWeekWindow(-2);
  insertQuizExam("晨测-前周地理", "地理", backfillWeek.weekStart, "closed", BASE_TOTALS.map((t) => t - 20));
  const resBackfill = await svc.publishDueWeeks(new Date(saturday8.getTime() + 3600_000));
  ok(resBackfill.created.includes(backfillWeek.label), `晚出分的历史周回补发布（created: ${resBackfill.created.join("、")}）`);
  const backfillGroupRow = db.prepare("SELECT id FROM exam_groups WHERE source = 'week' AND start_date = ? AND end_date = ?").get(backfillWeek.weekStart, backfillWeek.weekEnd) as { id: number } | undefined;
  ok(backfillGroupRow != null, "回补周建组存在");
  const resBackfillSummary = await svc.getSummary(backfillWeek.weekStart, undefined, new Date(saturday8.getTime() + 3600_000));
  ok(resBackfillSummary.active != null && resBackfillSummary.active!.examCount === 1, `回补周可读取（场次 1，实际 ${resBackfillSummary.active?.examCount}）`);

  // ── 历史空周 ──
  section("历史空周");
  const resEmpty = await svc.getSummary(resPub.weeks[4]!.weekStart, undefined, new Date(saturday8.getTime() + 3600_000));
  ok(resEmpty.weeks[4]!.published === true, "5 周前无考试 → 视为已完成、已发布");
  ok(resEmpty.active === null && resEmpty.grades.length === 0, "空周无数据");

  // ── 完整周报链路 ──
  section("完整周报链路");
  const repo = new AnalysisRepository();
  const cross = await repo.getCrossExamTotal({ mode: "group", groupId: resPub.grades[0]!.groupId });
  ok(cross.exams.length === 5, `跨考统计 5 场（实际 ${cross.exams.length}）`);
  ok(cross.summary.studentCount === 16, `跨考参评 16（实际 ${cross.summary.studentCount}）`);
  const group = await repo.getExamGroup(resPub.grades[0]!.groupId);
  ok(group != null && group.gradeId === gradeId && group.source === "week", "getExamGroup 返回 gradeId 与 source");

  // ── 跨年 ISO 周年份（回归：年标注必须取 ISO 周所属年份，而非周一所在公历年）──
  section("跨年 ISO 周年份");
  const isoLabel = (dateStr: string): string => weekWindowFor(new Date(`${dateStr}T00:00:00`)).label;
  ok(isoLabel("2025-12-29") === "2026年第1周", `2025-12-29（ISO 2026-W01）→ ${isoLabel("2025-12-29")}`);
  ok(isoLabel("2026-01-01") === "2026年第1周", `2026-01-01（同周）→ ${isoLabel("2026-01-01")}`);
  ok(isoLabel("2025-12-28") === "2025年第52周", `2025-12-28（ISO 2025-W52）→ ${isoLabel("2025-12-28")}`);
  ok(isoLabel("2027-01-01") === "2026年第53周", `2027-01-01（ISO 2026-W53）→ ${isoLabel("2027-01-01")}`);

  // ── 真实时钟（当前应处于周中） ──
  section("真实时钟 getSummary（本周未到周六）");
  const resNow = await svc.getSummary();
  ok(resNow.weeks.length === 5, "近 5 周选项");
  ok(resNow.weeks[0]!.published === false, "真实当前（周六前）本周未发布");
  ok(resNow.weeks[1]!.published === true, "上周已发布（周六已过且完成）");

  // ── 结果 ──
  console.log(`\n\x1b[36m== 结果 ==\x1b[0m 通过 ${passed}，失败 ${failed}`);
  console.log("\n示例 summary（已发布周）:");
  console.log(JSON.stringify(resPub.active, null, 2));
  if (failed > 0) {
    console.error("\n失败项:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nDB 路径（供服务端冒烟复用）: ${process.env.PROJECTX_DB_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});