/**
 * 演示数据导入后校验
 *
 * 用法: npx tsx testdata/demo-exams/scripts/verify.ts
 * 需已启动服务: npm run dev
 *
 * #185 起管理员为随机一次性密码、首次登录强制改密。本脚本会：
 *   1. 读 bootstrap-admin.txt 取一次性密码登录；
 *   2. 若登录响应要求强制改密（428 PASSWORD_CHANGE_REQUIRED 或 passwordChangeRequired 标志），
 *      自动改密为 Admin@Demo2026 并回写文件；
 *   3. 用新密码重新登录后执行全部校验。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const BASE = process.env.PROJECTX_API_BASE ?? "http://127.0.0.1:5174";
const DEMO_ADMIN_PASSWORD = "Admin@Demo2026";

// #185 起管理员为随机一次性密码，写入数据库旁的 bootstrap-admin.txt；优先读取它
function resolveBootstrapFile(): string {
  const dbPath = process.env.PROJECTX_DB_PATH
    ? path.resolve(process.env.PROJECTX_DB_PATH)
    : path.join(process.cwd(), "data", "projectx.db");
  return path.join(path.dirname(dbPath), "bootstrap-admin.txt");
}

function readAdminPassword(): string {
  const file = resolveBootstrapFile();
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  return "admin123";
}

function writeAdminPassword(pw: string): void {
  writeFileSync(resolveBootstrapFile(), pw);
}

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

async function login(identifier: string, password: string): Promise<{ token?: string; status: number; body: any }> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password })
  });
  const d = await r.json();
  return { token: d.token, status: r.status, body: d };
}

/** 登录 admin；若被要求改密（428），自动改密为常量并回写 bootstrap-admin.txt，再重新登录。 */
async function loginAdmin(): Promise<string> {
  const initial = readAdminPassword();
  const first = await login("admin", initial);
  if (first.token && !first.body?.passwordChangeRequired) return first.token;

  if (first.status === 428 || first.body?.code === "PASSWORD_CHANGE_REQUIRED" || first.body?.passwordChangeRequired) {
    console.log("  ℹ 检测到首次登录需改密，自动改密为 Admin@Demo2026 …");
    // 用一次性密码作为 oldPassword 调用 change-password
    const changer = await fetch(`${BASE}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${(first.body as any).token ?? ""}` },
      body: JSON.stringify({ oldPassword: initial, newPassword: DEMO_ADMIN_PASSWORD })
    });
    // change-password 端在 428 响应里可能不返回 token；若改密失败则尝试用新密码直接登录
    void await changer.json().catch(() => ({}));
    const retry = await login("admin", DEMO_ADMIN_PASSWORD);
    if (retry.token) {
      writeAdminPassword(DEMO_ADMIN_PASSWORD);
      return retry.token;
    }
    // 旧路径：某些实现下 428 响应仍带可用的临时 token，但已被消耗；此处给出明确错误
    throw new Error(`admin 自动改密失败：首次=${first.status}，重试=${retry.status}`);
  }

  throw new Error(`admin 登录失败: status=${first.status} body=${JSON.stringify(first.body)}`);
}

async function main(): Promise<void> {
  console.log("演示数据校验\n");

  const health = await fetch(`${BASE}/api/app/health`).then((r) => r.json());
  ok(health.ok === true, "服务健康");

  const token = await loginAdmin();
  const headers = { Authorization: `Bearer ${token}` };

  const grades = await fetch(`${BASE}/api/classes/grades`, { headers }).then((r) => r.json());
  const grade = Array.isArray(grades) ? grades.find((g: { name: string }) => g.name.includes("演示")) : undefined;
  ok(Boolean(grade), `年级: ${grade?.name}`);

  const exams = await fetch(`${BASE}/api/exams?selection=1&grade_id=${grade.id}`, { headers }).then((r) => r.json());
  ok(exams.length >= 7, `考试 >= 7 (实际 ${exams.length})`);

  const week = exams.filter((e: { exam_date?: string }) => e.exam_date && e.exam_date >= "2026-06-16" && e.exam_date <= "2026-06-22");
  ok(week.length === 6, `周内考试 6 场 (实际 ${week.length})`);

  const cross = await fetch(`${BASE}/api/analysis/cross-exam/total`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "week", startDate: "2026-06-16", endDate: "2026-06-22", gradeId: grade.id })
  }).then((r) => r.json());
  ok(cross.summary?.examCount === 6, `跨考按周 6 场`);
  ok(cross.summary?.studentCount === 16, `跨考 16 人`);

  // 仅选周考数学（排除"数学月考"与"网阅测试"；按名称精确匹配，避免命中动态日期的"晨测数学"）
  const math = exams.find((e: { subject: string; name: string }) =>
    e.subject === "数学" && e.name === "演示-数学");
  if (math) {
    const table = await fetch(`${BASE}/api/analysis/exams/${math.id}/score-table`, { headers }).then((r) => r.json());
    const t128 = (table.rows ?? []).filter((r: { totalScore: number }) => r.totalScore === 128);
    ok(t128.length >= 4, `数学 128 分 ${t128.length} 人`);
    const ranks = [...new Set(t128.map((r: { gradeRank: number }) => r.gradeRank))];
    if (ranks.length === 1) {
      ok(true, `并列排名: 年排均为 ${ranks[0]} (v1.5.0+)`);
    } else {
      console.log(`  ⚠ 顺序排名 ${ranks.join(",")} (v1.4.8 main；v1.5.0 应为同排)`);
    }

    const prev = await fetch(`${BASE}/api/analysis/exams/${math.id}/previous`, { headers }).then((r) => r.json());
    ok(prev.prevExamName != null, `上次考试对比: ${prev.prevExamName ?? "无"}`);
  } else {
    ok(false, "找不到演示-数学考试");
  }

  const groups = await fetch(`${BASE}/api/exam-groups`, { headers }).then((r) => r.json());
  const big = groups.find((g: { name: string }) => g.name.includes("摸底"));
  ok(Boolean(big), "大考合集存在");

  const crossGroups = await fetch(`${BASE}/api/analysis/cross-exam/groups`, { headers }).then((r) => r.json());
  const saved = crossGroups.find((g: { name: string }) => g.name.includes("第25周"));
  ok(Boolean(saved), "跨考已存组存在");
  ok((saved?.examIds?.length ?? 0) === 6, `已存组含 6 场 (实际 ${saved?.examIds?.length ?? 0})`);

  // 学生登录：seed 后密码=学号
  const stuLogin = await login("20260102", "20260102");
  ok(Boolean(stuLogin.token), `学生登录 (20260102)`);
  if (stuLogin.token) {
    const stuHeaders = { Authorization: `Bearer ${stuLogin.token}` };
    const scores = await fetch(`${BASE}/api/scores/me`, { headers: stuHeaders }).then((r) => r.json());
    ok(scores.scores?.length >= 7, `学生成绩 >= 7 科`);

    const semester = await fetch(`${BASE}/api/scores/me/semester-comparison`, { headers: stuHeaders }).then((r) => r.json());
    ok(semester.current?.examCount >= 1, `学期对比: 本学期 ${semester.current?.examCount ?? 0} 场考试`);
    ok(Array.isArray(semester.current?.subjects) && semester.current.subjects.length >= 1, "学期对比含学科汇总");
  }

  // 全局设置（v1.9.6 全局设置页）— 公开端点 any auth 可读
  const settings = await fetch(`${BASE}/api/system-settings/public`, { headers }).then((r) => r.json().catch(() => ({})));
  const settingsData = settings?.data ?? settings ?? {};
  ok(settingsData.requireOriginalPaper === true || settingsData.requireOriginalPaper === 1 || settingsData.requireOriginalPaper === "1",
    `全局设置 requireOriginalPaper 存在`);
  ok(settingsData.highlightMissingPaper === true || settingsData.highlightMissingPaper === 1 || settingsData.highlightMissingPaper === "1",
    `全局设置 highlightMissingPaper 存在`);

  // 在线阅卷打分面板（v1.9.4 路径 B）
  const reviewExam = Array.isArray(exams) ? exams.find((e: { name: string }) => e.name === "演示-网阅测试") : undefined;
  ok(Boolean(reviewExam), "网阅考试 演示-网阅测试 存在");
  if (reviewExam) {
    const teacherLogin = await login("demo-teacher", "teacher123");
    ok(Boolean(teacherLogin.token), `网阅教师登录 (demo-teacher)`);
    if (teacherLogin.token) {
      const tHeaders = { Authorization: `Bearer ${teacherLogin.token}` };
      // 教师视角：列自己待阅考试（响应为 { ok, data: [...] }）
      const myExamsRaw = await fetch(`${BASE}/api/review/my-exams`, { headers: tHeaders }).then((r) => r.json().catch(() => null));
      const myExamsList: any[] = myExamsRaw?.data ?? myExamsRaw ?? [];
      ok(Array.isArray(myExamsList) && myExamsList.length >= 1, `网阅: 教师待阅考试列表非空`);
      // 该考试自身题块列表（响应为 { examId, blocks: [...] }）
      const blocksRaw = await fetch(`${BASE}/api/review/exams/${reviewExam.id}/blocks`, { headers: tHeaders }).then((r) => r.json().catch(() => null));
      const blocksList: any[] = blocksRaw?.blocks ?? blocksRaw ?? [];
      ok(Array.isArray(blocksList) && blocksList.length === 2, `网阅: 题块 2 个 (A/B)`);
      // 断点续批：demo-teacher 在题块 B 留有草稿会话（draft_scores 非空）
      const sessRaw = await fetch(`${BASE}/api/review-session/exams/${reviewExam.id}/blocks/B`, { headers: tHeaders }).then((r) => r.json().catch(() => null));
      const sess = sessRaw?.data ?? sessRaw ?? null;
      ok(Boolean(sess?.draftScores) && Object.keys(sess.draftScores ?? {}).length >= 1, "断点续批: 题块 B 草稿会话存在");
    }
    // 管理员视角：该考试题块评分配置（响应为 { ok, data: [...] }）
    const cfgRaw = await fetch(`${BASE}/api/block-grading-config/exams/${reviewExam.id}`, { headers }).then((r) => r.json().catch(() => null));
    const cfgList: any[] = cfgRaw?.data ?? cfgRaw ?? [];
    ok(cfgList.length === 2, `网阅配置: 2 个题块 (实际 ${cfgList.length})`);
    const aCfg = cfgList.find((c) => c.blockId === "A");
    ok(aCfg?.scoringMode === "block_total", `题块A scoringMode=block_total`);
    ok(aCfg?.reviewMode === 2, `题块A reviewMode=2 (双评)`);
    const bCfg = cfgList.find((c) => c.blockId === "B");
    ok(bCfg?.scoringMode === "per_question", `题块B scoringMode=per_question`);
    ok(bCfg?.reviewMode === 1, `题块B reviewMode=1 (单评)`);

    // 打分记录：题块 A 双评 2P（3 已批 + 1 争议 + 4 待二评）、B 单评 1P（3 已批 + 5 待批）
    const cropsARaw = await fetch(`${BASE}/api/review/exams/${reviewExam.id}/block-crops?blockId=A`, { headers }).then((r) => r.json().catch(() => null));
    const statusA: Record<string, number> = {};
    for (const c of cropsARaw?.rows ?? []) statusA[c.status] = (statusA[c.status] ?? 0) + 1;
    ok((cropsARaw?.rows?.length ?? 0) === 8, `网阅A: 8 份卷 (实际 ${cropsARaw?.rows?.length ?? 0})`);
    ok(statusA.reviewed === 3 && statusA.disputed === 1 && statusA.pending === 4,
      `网阅A: 双评 3 已批 / 1 争议 / 4 待二评 (${JSON.stringify(statusA)})`);

    const cropsBRaw = await fetch(`${BASE}/api/review/exams/${reviewExam.id}/block-crops?blockId=B`, { headers }).then((r) => r.json().catch(() => null));
    const statusB: Record<string, number> = {};
    for (const c of cropsBRaw?.rows ?? []) statusB[c.status] = (statusB[c.status] ?? 0) + 1;
    ok((cropsBRaw?.rows?.length ?? 0) === 8 && statusB.reviewed === 3 && statusB.ready === 5,
      `网阅B: 3 已批 / 5 待批 (${JSON.stringify(statusB)})`);

    // 网阅成绩：已批学生主观分已落 student_scores（张明 30 / 李华 34 / 王芳 29）
    const reviewTable = await fetch(`${BASE}/api/analysis/exams/${reviewExam.id}/score-table`, { headers }).then((r) => r.json().catch(() => null));
    const scoreByName = Object.fromEntries((reviewTable?.rows ?? []).map((r: { studentName?: string; totalScore?: number }) => [r.studentName, r.totalScore]));
    ok(scoreByName["张明"] === 30 && scoreByName["李华"] === 34 && scoreByName["王芳"] === 29,
      `网阅成绩: 已批学生总分 30/34/29 (${JSON.stringify({ 张明: scoreByName["张明"], 李华: scoreByName["李华"], 王芳: scoreByName["王芳"] })})`);
  }

  // ── v1.9.9: 新功能数据（文理分科 / 填空题升级）──

  // 文理分科：16 名演示学生均带 track 标签（1班=理科 8 人、2班=文科 8 人）
  const userList = await fetch(`${BASE}/api/users?keyword=202601&pageSize=30`, { headers }).then((r) => r.json());
  const demoStudents = (userList.users ?? []).filter((u: { username?: string }) => /^202601\d{2}$/.test(u.username ?? ""));
  const scienceCount = demoStudents.filter((u: { track?: string }) => u.track === "science").length;
  const artsCount = demoStudents.filter((u: { track?: string }) => u.track === "arts").length;
  ok(demoStudents.length === 16, `文理分科: 演示学生 16 人 (实际 ${demoStudents.length})`);
  ok(scienceCount === 8 && artsCount === 8, `文理分科: 理科 ${scienceCount} 人 / 文科 ${artsCount} 人`);

  // 大考合集：7 科成员，语数英=共同、物化生=理科、历史=文科
  if (big) {
    const detail = await fetch(`${BASE}/api/exam-groups/${big.id}`, { headers }).then((r) => r.json());
    const members: any[] = detail.members ?? [];
    ok(members.length === 7, `大考合集: 7 科成员 (实际 ${members.length})`);
    const trackBySubject = Object.fromEntries(members.map((m: { subject?: string; trackType?: string }) => [m.subject, m.trackType]));
    ok(trackBySubject["语文"] === "common" && trackBySubject["数学"] === "common" && trackBySubject["英语"] === "common", "大考合集: 语数英=共同科目");
    ok(trackBySubject["物理"] === "science" && trackBySubject["化学"] === "science" && trackBySubject["生物"] === "science", "大考合集: 物化生=理科科目");
    ok(trackBySubject["历史"] === "arts", "大考合集: 历史=文科科目");
  } else {
    ok(false, "大考合集存在（文理分科检查）");
  }

  // 填空题升级：演示-语文卡含 fill_blank 块（自定义横线 / 文字注释 / 插入图片）
  const chineseCard = await fetch(`${BASE}/api/cards/88000001`, { headers }).then((r) => r.json().catch(() => null));
  const fbBlock = (chineseCard?.bodyBlocks ?? []).find((b: { blockKind?: string }) => b.blockKind === "fill_blank");
  ok(Boolean(fbBlock), "语文卡: fill_blank 填空题块存在");
  if (fbBlock) {
    const fbQuestions: any[] = fbBlock.questions ?? [];
    ok(fbQuestions.length === 3, `语文卡: 填空题 3 道 (实际 ${fbQuestions.length})`);
    const q1 = fbQuestions.find((q: { id: string }) => q.id === "fb-q1");
    ok(q1?.blanks?.items?.length === 2 && q1.blanks.items[0].widthMm !== q1.blanks.items[1].widthMm, "语文卡: 逐空自定义横线宽度");
    ok(Boolean(q1?.annotation), "语文卡: 文字注释存在");
    const q2 = fbQuestions.find((q: { id: string }) => q.id === "fb-q2");
    ok(q2?.images?.length === 1 && q2.images[0].assetId === "fig-demo.png", "语文卡: 插入图片存在");
  }

  // ── 答题卡设计器修复：作文格仿高考样式 + 客观题选项竖排 ──
  const essayBlock = (chineseCard?.bodyBlocks ?? []).find((b: { blockKind?: string }) => b.blockKind === "essay");
  ok(Boolean(essayBlock), "语文卡: 作文块存在（blockKind=essay）");
  if (essayBlock) {
    const essayQ = (essayBlock.questions ?? [])[0];
    const grid = essayQ?.essayGrid ?? {};
    ok(grid.lineColor === "#c00000", `语文卡: 作文格朱红格线 (${String(grid.lineColor)})`);
    ok(grid.showWordScale === true && grid.showFrame === true, "语文卡: 作文格字数刻度 + 粗边框开启");
    ok(grid.targetChars === 600, `语文卡: 作文目标 600 字 (${String(grid.targetChars)})`);
  }

  const mathCard = await fetch(`${BASE}/api/cards/88000002`, { headers }).then((r) => r.json().catch(() => null));
  const mathObjBlock = (mathCard?.bodyBlocks ?? []).find((b: { type?: string }) => b.type === "objective");
  ok(mathObjBlock?.optionLayout === "vertical-options",
    `数学卡: 客观题块选项竖排 (${String(mathObjBlock?.optionLayout)})`);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
