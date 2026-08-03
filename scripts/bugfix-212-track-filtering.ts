/**
 * PR #212 文理筛选专项冒烟测试
 *
 * 覆盖评审报告要求的 6 个场景：
 *   ① 文科排名不含理科生
 *   ② 理科排名不含文科生
 *   ③ 共同科目在文理筛选下的排名口径（年级排名 / 班级排名）
 *   ④ only_full_participants 在文理科目集不同时正确
 *   ⑤ 文科筛选返回的 subjects 不含理科科目（displayColumns 同理）
 *   ⑥ track = null 的历史学生处理
 *
 * 运行：npx tsx scripts/bugfix-212-track-filtering.ts
 */
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string, extra?: unknown) {
  if (cond) {
    pass++;
    console.log("  PASS:", msg);
  } else {
    fail++;
    console.log("  FAIL:", msg, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

// ── 复刻 exam-groups.ts 排名路由的核心逻辑 ──

type TrackFilter = "all" | "arts" | "science";

function normalizeTrackFilter(value: unknown): TrackFilter {
  if (value === "arts" || value === "science") return value;
  return "all";
}

function memberMatchesTrack(trackType: string | null | undefined, track: TrackFilter): boolean {
  if (track === "all") return true;
  if (trackType == null || trackType === "common") return true; // 共同科目始终包含
  return trackType === track;
}

/** dense ranking（与项目一致） */
function competitionRank<T>(
  items: T[],
  scoreFn: (item: T) => number,
  setRank: (item: T, rank: number) => void
): void {
  const sorted = [...items].sort((a, b) => scoreFn(b) - scoreFn(a));
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && scoreFn(sorted[i]) < scoreFn(sorted[i - 1])) rank = i + 1;
    setRank(sorted[i], rank);
  }
}

// ── 测试数据库工厂 ──

function tmpDb(suffix: string): string {
  const p = path.join(os.tmpdir(), `px-track-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try { fs.unlinkSync(p); } catch { /* noop */ }
  return p;
}

interface TestCtx {
  db: Database.Database;
  file: string;
  groupId: number;
  // user ids
  zhangSan: number; // arts
  liSi: number;     // arts
  wangWu: number;   // science
  zhaoLiu: number;  // science
  sunQi: number;    // null (历史未分科)
  // exam ids
  yuWen: number;    // common
  shuXue: number;   // common
  yingYu: number;   // common
  wuLi: number;     // science
  huaXue: number;   // science
  shengWu: number;  // science
}

/** 构造完整测试数据：5 学生 × 6 科目，含 track / track_type */
function buildTestDb(): TestCtx {
  const file = tmpDb("filter");
  const db = new Database(file);

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      student_number TEXT,
      track TEXT
    );
    CREATE TABLE classes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      grade_id INTEGER
    );
    CREATE TABLE grades (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE class_students (
      class_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      PRIMARY KEY (class_id, student_id)
    );
    CREATE TABLE exams (
      id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      full_score INTEGER NOT NULL DEFAULT 100
    );
    CREATE TABLE exam_groups (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      total_score_mode TEXT NOT NULL DEFAULT 'raw',
      only_full_participants INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE exam_group_members (
      id INTEGER PRIMARY KEY,
      group_id INTEGER NOT NULL,
      exam_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      track_type TEXT NOT NULL DEFAULT 'common'
    );
    CREATE TABLE student_scores (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL,
      exam_id INTEGER NOT NULL,
      total_score REAL NOT NULL,
      assigned_score REAL,
      objective_score REAL DEFAULT 0,
      subjective_score REAL DEFAULT 0
    );
  `);

  // 年级 & 班级
  const g1 = db.prepare("INSERT INTO grades (name) VALUES (?)").run("高二").lastInsertRowid as number;
  const c1 = db.prepare("INSERT INTO classes (name, grade_id) VALUES (?,?)").run("高二1班", g1).lastInsertRowid as number;
  const c2 = db.prepare("INSERT INTO classes (name, grade_id) VALUES (?,?)").run("高二2班", g1).lastInsertRowid as number;

  // 学生：2 文科 + 2 理科 + 1 未分科
  const insUser = db.prepare("INSERT INTO users (name, student_number, track) VALUES (?,?,?)");
  const zhangSan = insUser.run("张三", "2025001", "arts").lastInsertRowid as number;
  const liSi     = insUser.run("李四", "2025002", "arts").lastInsertRowid as number;
  const wangWu   = insUser.run("王五", "2025003", "science").lastInsertRowid as number;
  const zhaoLiu  = insUser.run("赵六", "2025004", "science").lastInsertRowid as number;
  const sunQi    = insUser.run("孙七", "2025005", null).lastInsertRowid as number;

  // 班级归属：张三/李四/孙七 → 1班；王五/赵六 → 2班
  const insCS = db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?,?)");
  insCS.run(c1, zhangSan); insCS.run(c1, liSi); insCS.run(c1, sunQi);
  insCS.run(c2, wangWu);   insCS.run(c2, zhaoLiu);

  // 科目
  const insExam = db.prepare("INSERT INTO exams (subject, full_score) VALUES (?,?)");
  const yuWen  = insExam.run("语文", 150).lastInsertRowid as number;
  const shuXue = insExam.run("数学", 150).lastInsertRowid as number;
  const yingYu = insExam.run("英语", 150).lastInsertRowid as number;
  const wuLi   = insExam.run("物理", 100).lastInsertRowid as number;
  const huaXue = insExam.run("化学", 100).lastInsertRowid as number;
  const shengWu= insExam.run("生物", 100).lastInsertRowid as number;

  // 大考组
  const groupId = db.prepare("INSERT INTO exam_groups (name, total_score_mode, only_full_participants) VALUES (?,?,?)")
    .run("期中联考", "raw", 1).lastInsertRowid as number;

  // 成员：语数英=common，理化生=science
  const insEGM = db.prepare("INSERT INTO exam_group_members (group_id, exam_id, sort_order, track_type) VALUES (?,?,?,?)");
  insEGM.run(groupId, yuWen,  1, "common");
  insEGM.run(groupId, shuXue, 2, "common");
  insEGM.run(groupId, yingYu, 3, "common");
  insEGM.run(groupId, wuLi,   4, "science");
  insEGM.run(groupId, huaXue, 5, "science");
  insEGM.run(groupId, shengWu, 6, "science");

  // ── 分数设计 ──
  //
  // 共同科目（语数英）—— 全体都有分：
  //   张三(arts):  语文120  数学100  英语110
  //   李四(arts):  语文115  数学90   英语105
  //   王五(sci):   语文110  数学130  (英语无分→模拟缺考)
  //   赵六(sci):   语文105  数学120  英语95
  //   孙七(null):  语文100  数学95   英语90
  //
  // 理科科目（理化生）—— 只有理科生有分：
  //   王五: 物理140 化学135 生物130
  //   赵六: 物理130 化学125 生物120
  //
  // 关键断言数据：
  //   - 语文全体排名：张三1 李四2 王五3 赵六4 孙七5
  //   - 语文文科内排名：张三1 李四2（王五/赵六被过滤）
  //   - 语文理科内排名：王五1 赵六2（张三/李四被过滤）
  //   - 物理只有王五/赵六有分

  const insSS = db.prepare("INSERT INTO student_scores (student_id, exam_id, total_score) VALUES (?,?,?)");
  // 张三 (arts)
  insSS.run(zhangSan, yuWen,  120);
  insSS.run(zhangSan, shuXue, 100);
  insSS.run(zhangSan, yingYu, 110);
  // 李四 (arts)
  insSS.run(liSi,     yuWen,  115);
  insSS.run(liSi,     shuXue, 90);
  insSS.run(liSi,     yingYu, 105);
  // 王五 (science) — 缺英语
  insSS.run(wangWu,   yuWen,  110);
  insSS.run(wangWu,   shuXue, 130);
  // insSS.run(wangWu, yingYu, ...);  — 缺考
  insSS.run(wangWu,   wuLi,   140);
  insSS.run(wangWu,   huaXue, 135);
  insSS.run(wangWu,   shengWu, 130);
  // 赵六 (science)
  insSS.run(zhaoLiu,  yuWen,  105);
  insSS.run(zhaoLiu,  shuXue, 120);
  insSS.run(zhaoLiu,  yingYu, 95);
  insSS.run(zhaoLiu,  wuLi,   130);
  insSS.run(zhaoLiu,  huaXue, 125);
  insSS.run(zhaoLiu,  shengWu, 120);
  // 孙七 (null, 历史未分科)
  insSS.run(sunQi,    yuWen,  100);
  insSS.run(sunQi,    shuXue, 95);
  insSS.run(sunQi,    yingYu, 90);

  return { db, file, groupId, zhangSan, liSi, wangWu, zhaoLiu, sunQi,
           yuWen, shuXue, yingYu, wuLi, huaXue, shengWu };
}

/** 复刻排名路由的核心逻辑（精简版），返回 JSON 结构 */
function computeRankings(ctx: TestCtx, track: TrackFilter, fullOnly?: boolean) {
  const { db, groupId } = ctx;

  const group = db.prepare("SELECT * FROM exam_groups WHERE id = ?").get(groupId) as any;
  const members = db.prepare(`
    SELECT egm.exam_id, e.subject, egm.track_type
    FROM exam_group_members egm JOIN exams e ON e.id = egm.exam_id
    WHERE egm.group_id = ? ORDER BY egm.sort_order, egm.id
  `).all(groupId) as Array<{ exam_id: number; subject: string | null; track_type: string }>;

  const trackMembers = track === "all"
    ? members
    : members.filter(m => memberMatchesTrack(m.track_type, track));
  if (trackMembers.length === 0) return { rows: [], displayColumns: [] };

  const memberIds = trackMembers.map(m => m.exam_id);

  // trackStudentClause — 与 exam-groups.ts 一致
  const trackStudentClause = track === "all" ? "" : "AND u.track = ?";
  const allScoreParams: unknown[] = [...memberIds];
  if (track !== "all") allScoreParams.push(track);

  const allScores = db.prepare(`
    SELECT ss.student_id, ss.exam_id, ss.total_score, ss.assigned_score,
           u.student_number, u.name, u.track,
           c.name as class_name, c.id as class_id
    FROM student_scores ss
    JOIN users u ON u.id = ss.student_id
    LEFT JOIN class_students cs ON cs.student_id = ss.student_id
    LEFT JOIN classes c ON c.id = cs.class_id
    WHERE ss.exam_id IN (${memberIds.map(() => "?").join(",")}) ${trackStudentClause}
  `).all(...allScoreParams) as Array<any>;

  // Build per-student map
  const studentMap = new Map<number, any>();
  for (const s of allScores) {
    if (!studentMap.has(s.student_id)) {
      studentMap.set(s.student_id, {
        studentId: s.student_id, studentNumber: s.student_number,
        studentName: s.name, className: s.class_name || "未知班级",
        classId: s.class_id, scores: new Map()
      });
    }
    studentMap.get(s.student_id)!.scores.set(s.exam_id, {
      totalScore: s.total_score, assignedScore: s.assigned_score
    });
  }

  // ── Issue 1 fix: rankRows 加 track 过滤 ──
  const examRanks: Record<number, Map<number, { gradeRank: number; classRank: number }>> = {};
  for (const examId of memberIds) {
    const rankParams: unknown[] = [examId];
    if (track !== "all") rankParams.push(track);

    const rankRows = db.prepare(`
      SELECT ss.student_id, ss.total_score, c.name as class_name, c.id as class_id
      FROM student_scores ss
      JOIN users u ON u.id = ss.student_id
      LEFT JOIN class_students cs ON cs.student_id = ss.student_id
      LEFT JOIN classes c ON c.id = cs.class_id
      WHERE ss.exam_id = ? ${trackStudentClause}
      ORDER BY ss.total_score DESC
    `).all(...rankParams) as Array<{ student_id: number; total_score: number; class_name: string | null; class_id: number | null }>;

    const rankMap = new Map<number, { gradeRank: number; classRank: number }>();
    examRanks[examId] = rankMap;

    competitionRank(rankRows, r => r.total_score, (r, rank) => {
      rankMap.set(r.student_id, { gradeRank: rank, classRank: 0 });
    });

    // Class rank
    const classGroups = new Map<string, Array<{ student_id: number; total_score: number }>>();
    for (const r of rankRows) {
      const key = r.class_name || "__unassigned__";
      if (!classGroups.has(key)) classGroups.set(key, []);
      classGroups.get(key)!.push({ student_id: r.student_id, total_score: r.total_score });
    }
    for (const cg of classGroups.values()) {
      competitionRank(cg, r => r.total_score, (r, rank) => {
        const entry = rankMap.get(r.student_id);
        if (entry) entry.classRank = rank;
      });
    }
  }

  // ── Issue 2 fix: subjects 用 trackMembers ──
  const rows: any[] = [];
  for (const [, student] of studentMap) {
    const subjects = trackMembers.map((m) => {       // ← Issue 2: 用 trackMembers 非 members
      const s = student.scores.get(m.exam_id);
      const ranks = examRanks[m.exam_id]?.get(student.studentId);
      return {
        examId: m.exam_id,
        subject: m.subject || "",
        totalScore: s?.totalScore ?? 0,
        gradeRank: ranks?.gradeRank ?? 0,
        classRank: ranks?.classRank ?? 0,
      };
    });

    const isFull = student.scores.size >= trackMembers.length;
    if (fullOnly && !isFull) continue;

    const totalRaw = subjects.reduce((sum, sub) => sum + sub.totalScore, 0);
    rows.push({
      studentId: student.studentId,
      studentName: student.studentName,
      className: student.className,
      totalRawScore: totalRaw,
      subjectCount: student.scores.size,
      isFullParticipant: isFull,
      subjects,
    });
  }

  rows.sort((a, b) => b.totalRawScore - a.totalRawScore);
  const displayColumns = trackMembers.map(m => m.subject || `科目${m.exam_id}`);

  return { rows, displayColumns, memberCount: trackMembers.length };
}

// ══════════════════════════════════════
//          测试用例
// ══════════════════════════════════════

console.log("=== PR #212 文理筛选专项冒烟 ===\n");

const ctx = buildTestDb();

// ─── 场景 ①：文科排名不含理科生 ───
{
  console.log("--- 场景 ①：文科排名不含理科生 ---");
  const r = computeRankings(ctx, "arts");
  const names = r.rows.map(row => row.studentName);
  ok(!names.includes("王五"), "文科排名不含 王五(science)", { names });
  ok(!names.includes("赵六"), "文科排名不含 赵六(science)", { names });
  ok(names.includes("张三"), "文科排名包含 张三(arts)", { names });
  ok(names.includes("李四"), "文科排名包含 李四(arts)", { names });
  // 孙七 track=null：按 memberMatchesTrack 定义，null track_type 视为 common → 包含在所有筛选中
  // 但用户 u.track=null 不匹配 'arts' → 应被 trackStudentClause 排除
  ok(!names.includes("孙七"), "文科排名不含 孙七(track=null)", { names });
  ok(r.rows.length === 2, "文科排名恰好 2 人", { count: r.rows.length, names });
}

// ─── 场景 ②：理科排名不含文科生 ───
{
  console.log("\n--- 场景 ②：理科排名不含文科生 ---");
  const r = computeRankings(ctx, "science");
  const names = r.rows.map(row => row.studentName);
  ok(!names.includes("张三"), "理科排名不含 张三(arts)", { names });
  ok(!names.includes("李四"), "理科排名不含 李四(arts)", { names });
  ok(names.includes("王五"), "理科排名包含 王五(science)", { names });
  ok(names.includes("赵六"), "理科排名包含 赵六(science)", { names });
  ok(!names.includes("孙七"), "理科排名不含 孙七(track=null)", { names });
  ok(r.rows.length === 2, "理科排名恰好 2 人", { count: r.rows.length, names });
}

// ─── 场景 ③：共同科目(语文)在文理筛选下的排名口径 ───
{
  console.log("\n--- 场景 ③：语文在文理筛选下排名口径正确 ---");

  // 全体(all)：张三120(第1) > 李四115(第2) > 王五110(第3) > 赵六105(第4) > 孙七100(第5)
  const rAll = computeRankings(ctx, "all");
  const zhangAll = rAll.rows.find(r => r.studentName === "张三");
  const yuWenRankAll = zhangAll?.subjects.find((s: any) => s.subject === "语文")?.gradeRank;
  ok(yuWenRankAll === 1, "全体模式：张三语文年级排名第 1", { gradeRank: yuWenRankAll });

  // 文科(arts)：张三120(第1) > 李四115(第2)，不含理科生
  const rArts = computeRankings(ctx, "arts");
  const zhangArts = rArts.rows.find(r => r.studentName === "张三");
  const yuWenRankArts = zhangArts?.subjects.find((s: any) => s.subject === "语文")?.gradeRank;
  ok(yuWenRankArts === 1, "文科模式：张三语文年级排名第 1（文科内）", { gradeRank: yuWenRankArts });

  // 理科(science)：王五110(第1) > 赵六105(第2)
  const rSci = computeRankings(ctx, "science");
  const wangSci = rSci.rows.find(r => r.studentName === "王五");
  const yuWenRankSci = wangSci?.subjects.find((s: any) => s.subject === "语文")?.gradeRank;
  ok(yuWenRankSci === 1, "理科模式：王五语文年级排名第 1（理科内）", { gradeRank: yuWenRankSci });

  // 关键断言：文科内张三的语文排名 ≠ 全体内排名（如果理科生混入就会错）
  // 全体第1、文科也是第1（因为张三本来就是最高分）—— 换一个验证：
  // 李四在全体排第2，在文科也排第2（因为文科只有2人且张三更高）
  const liArts = rArts.rows.find(r => r.studentName === "李四");
  const liYWRankArts = liArts?.subjects.find((s: any) => s.subject === "语文")?.gradeRank;
  ok(liYWRankArts === 2, "文科模式：李四语文年级排名第 2（文科内）", { gradeRank: liYWRankArts });
}

// ─── 场景 ④：only_full_participants 在文理科目集不同时正确 ───
{
  console.log("\n--- 场景 ④：only_full_participants 与 trackMembers 长度一致 ---");
  // 王五缺考英语 → 在 science 模式下有 5 科(语数物化生)但只考了 4 科
  const rSciFull = computeRankings(ctx, "science", true); // fullOnly=true
  const wangFull = rSciFull.rows.find(r => r.studentName === "王五");
  // science trackMembers = 语数英(3 common) + 物化生(3 science) = 6 科？
  // 不对：memberMatchesTrack(common, science)=true → trackMembers 含全部 6 科
  // 王五缺英语 → scores.size=5 < 6 → isFull=false → 被 fullOnly 过滤掉
  ok(rSciFull.rows.every(r => r.studentName !== "王五" || r.isFullParticipant),
     "fullOnly+science: 缺考英语的王五被过滤或标记为非全参",
     { wangWuPresent: rSciFull.rows.some(r => r.studentName === "王五") });

  // arts 模式：trackMembers = 语数英(3 common) = 3 科（理化生被 memberMatchesTrack 排除）
  const rArtsFull = computeRankings(ctx, "arts", true);
  const zhangArtsF = rArtsFull.rows.find(r => r.studentName === "张三");
  ok(zhangArtsF?.subjectCount === 3, "arts 模式：张三科目数=3（仅共同科目）", { count: zhangArtsF?.subjectCount });
  ok(zhangArtsF?.isFullParticipant === true, "arts 模式：张三是全参（3/3）", { isFull: zhangArtsF?.isFullParticipant });

  // 验证 arts 的 displayColumns 不含理科科目
  ok(!rArtsFull.displayColumns.includes("物理"), "arts displayColumns 不含物理", { cols: rArtsFull.displayColumns });
  ok(!rArtsFull.displayColumns.includes("化学"), "arts displayColumns 不含化学", { cols: rArtsFull.displayColumns });
}

// ─── 场景 ⑤：文科筛选返回的 subjects 不含理科科目 ───
{
  console.log("\n--- 场景 ⑤：文科 subjects 不含理科科目 ---");
  const r = computeRankings(ctx, "arts");
  // 每个学生的 subjects 只应包含 trackMembers 对应的科目（语数英）
  for (const row of r.rows) {
    const subjNames = row.subjects.map((s: any) => s.subject);
    ok(!subjNames.includes("物理"), `${row.studentName} 的 subjects 不含物理`, { subjects: subjNames });
    ok(!subjNames.includes("化学"), `${row.studentName} 的 subjects 不含化学`, { subjects: subjNames });
    ok(!subjNames.includes("生物"), `${row.studentName} 的 subjects 不含生物`, { subjects: subjNames });
  }
  // displayColumns 也应不含理科
  ok(!r.displayColumns.includes("物理"), "displayColumns 不含物理", { cols: r.displayColumns });
  ok(r.displayColumns.length === 3, "arts displayColumns 恰好 3 列（语数英）", { cols: r.displayColumns, len: r.displayColumns.length });
}

// ─── 场景 ⑥：track = null 的历史学生处理 ───
{
  console.log("\n--- 场景 ⑥：track=null 历史学生处理 ---");
  // 孙七 track=null
  // 按 trackStudentClause: track='arts' 时 AND u.track='arts' → null != 'arts' → 排除
  // 按 trackStudentClause: track='science' 时 AND u.track='science' → 排除
  // 按 trackStudentClause: track='all' 时无 clause → 包含
  const rAll = computeRankings(ctx, "all");
  ok(rAll.rows.some(r => r.studentName === "孙七"), "全体模式：孙七(track=null) 出现", { names: rAll.rows.map(r => r.studentName) });

  const rArts = computeRankings(ctx, "arts");
  ok(!rArts.rows.some(r => r.studentName === "孙七"), "文科模式：孙七(track=null) 被排除", { names: rArts.rows.map(r => r.studentName) });

  const rSci = computeRankings(ctx, "science");
  ok(!rSci.rows.some(r => r.studentName === "孙七"), "理科模式：孙七(track=null) 被排除", { names: rSci.rows.map(r => r.studentName) });
}

// ── 清理 ──
ctx.db.close();
try { fs.unlinkSync(ctx.file); } catch { /* noop */ }

// ── 结果汇总 ──
console.log(`\n${"=".repeat(40)}`);
console.log(`总计: ${pass + fail} 项, 通过: ${pass}, 失败: ${fail}`);
if (fail > 0) {
  console.log("❌ 存在失败项");
  process.exit(1);
} else {
  console.log("✅ 全部通过");
  process.exit(0);
}
