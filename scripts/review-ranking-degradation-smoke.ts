/**
 * 回归测试：网阅提交后赋分重算中途失败时，API 必须返回降级状态
 * （assignedScoresRecalculated=false + assignedScoreError），而不是伪装成功。
 * 同时覆盖学生搜索 LIKE 通配符（%/_\）字面量匹配。
 *
 * 运行：npm run verify:review-ranking-degradation
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";

const tempDir = mkdtempSync(path.join(tmpdir(), "projectx-review-rank-"));
process.env.PROJECTX_DB_PATH = path.join(tempDir, "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tempDir, "data");
process.env.USERPROFILE = path.join(tempDir, "home");
process.env.PROJECTX_AUTH_ENFORCE = "1";
process.env.PROJECTX_ENABLE_SCANNER = "false";
process.env.PROJECTX_ENABLE_SCANNER_CLIENT_API = "false";
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST"
]) delete process.env[key];

let passed = 0;
const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(label: string): void {
  console.log(`\n\x1b[36m== ${label} ==\x1b[0m`);
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function main(): Promise<void> {
  let server: Server | undefined;
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase, hashPassword } =
    await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { authService } = await import("../src/server/services/AuthService");

  try {
    initializeDatabase();
    const db = getDatabase();
    const bootstrap = await ensureDefaultAdmin();
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number };
    db.prepare("UPDATE users SET password_hash = ?, password_change_required = 0 WHERE username = 'admin'")
      .run(await hashPassword("AdminReview-2026!"));
    rmSync(bootstrap.passwordFile, { force: true });
    const login = await authService.login("admin", "AdminReview-2026!");
    if (!login.token) throw new Error("管理员登录失败");
    const token = login.token;

    // ── 建卡、考试、学生、成绩、切块与评分配置 ──
    db.prepare(
      `INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version)
       VALUES ('review-card', '降级测试卡', '化学', '化学', '2026-08-09', 'A4', 'portrait', '[]', 5, 'double', 1)`
    ).run();
    db.prepare(
      `INSERT INTO subjective_blocks (id, card_id, sort_order, block_kind, title) VALUES ('b1', 'review-card', 0, 'answer', '解答题')`
    ).run();
    db.prepare(
      `INSERT INTO subjective_questions (id, block_id, number, score, style, kind, min_height_mm, sort_order)
       VALUES ('q1', 'b1', 1, 10, 'manual_score_grid', 'plain_box', 68, 0)`
    ).run();

    const exam = db.prepare(
      `INSERT INTO exams (name, card_id, subject, status, created_by) VALUES ('赋分降级测试', 'review-card', '化学', 'active', ?)`
    ).run(admin.id);
    const examId = Number(exam.lastInsertRowid);
    db.prepare(
      `UPDATE exams SET assigned_formula = ? WHERE id = ?`
    ).run(
      JSON.stringify({ type: "proportional", enabled: true, params: { minIn: 0, maxIn: 10, minOut: 30, maxOut: 100 } }),
      examId
    );

    // 3 名学生：第 1 名成功、第 2 名被触发器强制失败、第 3 名未执行，
    // 用于验证单条 CASE WHEN UPDATE 语句级回滚后所有学生赋分保持原值（无部分更新）。
    const studentIds: number[] = [];
    for (const num of ["S001", "S002", "S003"]) {
      const info = db.prepare(
        `INSERT INTO users (username, name, role_id, student_number, is_active, password_hash) VALUES (?, ?, 3, ?, 1, '')`
      ).run(num, `测试学生${num}`, num);
      const sid = Number(info.lastInsertRowid);
      studentIds.push(sid);
      db.prepare(
        `INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score)
         VALUES (?, ?, 0, 0, 10)`
      ).run(examId, sid);
    }
    const studentId = studentIds[0];
    const failingStudentId = studentIds[1];
    db.prepare(
      `INSERT INTO answer_block_crops
        (id, card_id, exam_id, student_id, student_number, source_type, source_record_id, block_id,
         block_title, block_type, page_number, segment_index, question_numbers, rect_json, image_path,
         width_px, height_px, dpi, status, review_round, claim_count)
       VALUES ('crop1', 'review-card', ?, ?, 'S001', 'scan_record', 'r1', 'b1',
         '解答题', 'subjective', 1, 0, '[1]', '{}', '/tmp/x.png',
         100, 100, 300, 'ready', 0, 0)`
    ).run(
      examId, studentId
    );
    db.prepare(
      `INSERT INTO block_grading_config (exam_id, block_id, dispute_threshold, rounding, review_mode, scoring_mode, score_distribution)
       VALUES (?, 'b1', 2, 'ceil', 1, 'block_total', 'proportional')`
    ).run(
      examId
    );

    // 触发器：仅第 2 名学生的赋分更新失败，模拟“中途失败”；
    // 排名（rank/percentile）更新不设置 assigned_score，不受影响。
    db.exec(
      `CREATE TRIGGER review_rank_degrade BEFORE UPDATE ON student_scores
       WHEN NEW.assigned_score IS NOT NULL AND NEW.student_id = ${failingStudentId}
       BEGIN SELECT RAISE(ABORT, 'forced assigned failure'); END`
    );

    const app = await createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    section("网阅提交：赋分重算中途失败必须降级返回");
    const submitRes = await fetch(`${base}/api/review/exams/${examId}/block-crops/crop1/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({
        scores: [{ questionNumber: 1, scoreType: "subjective" }],
        blockTotalScore: 10,
        status: "reviewed"
      })
    });
    const submitBody = await submitRes.json() as {
      ok?: boolean;
      rankingsRecalculated?: boolean;
      rankingError?: string;
      assignedScoresRecalculated?: boolean;
      assignedScoreError?: string;
    };
    check(submitRes.status === 200 && submitBody.ok === true, "提交接口返回 200 ok");
    check(submitBody.rankingsRecalculated === true, "排名重算成功（rank/percentile 不受赋分失败影响）");
    check(submitBody.rankingError === undefined, "rankingError 仅表示排名失败（与赋分错误语义分离）");
    check(
      submitBody.assignedScoresRecalculated === false
        && typeof submitBody.assignedScoreError === "string"
        && submitBody.assignedScoreError.includes("forced assigned failure"),
      "赋分失败通过 assignedScoresRecalculated=false + assignedScoreError 明确上报"
    );
    const cropState = db.prepare(
      "SELECT status, final_score FROM answer_block_crops WHERE id = 'crop1'"
    ).get() as { status: string; final_score: number | null };
    const scoreState = db.prepare(
      "SELECT score FROM question_scores WHERE exam_id = ? AND student_id = ? AND question_number = 1"
    ).get(examId, studentId) as { score: number } | undefined;
    const rankState = db.prepare(
      "SELECT `rank`, percentile, assigned_score FROM student_scores WHERE exam_id = ? AND student_id = ?"
    ).get(examId, studentId) as { rank: number; percentile: number; assigned_score: number | null };
    check(cropState.status === "reviewed" && cropState.final_score === 10, "分数已保存（不因赋分失败回滚）");
    check(scoreState?.score === 10, "逐题分数已落库");
    check(rankState.rank === 1 && rankState.percentile === 100, "排名已更新");
    const assignedStates = studentIds.map((sid) => {
      const row = db.prepare(
        "SELECT assigned_score FROM student_scores WHERE exam_id = ? AND student_id = ?"
      ).get(examId, sid) as { assigned_score: number | null };
      return row.assigned_score;
    });
    check(
      assignedStates.every((v) => v === null),
      "赋分中途失败后全部回滚（3 名学生均保持原值，无部分更新）"
    );
    db.exec("DROP TRIGGER review_rank_degrade");

    section("赋分重算：单条 UPDATE 批量赋值（MariaDB 连接池兼容）");
    // 用记录调用的假 adapter 验证 recalculateAll 只发出「一条」CASE WHEN UPDATE：
    // 单条语句在任意物理连接上都是语句级原子，不依赖 SAVEPOINT/固定连接，
    // 因此 MariaDB 连接池不会产生跨连接的部分更新问题。
    const { AssignedScoreService: AssignedScoreServiceClass } = await import("../src/server/services/AssignedScoreService");
    const calls: string[] = [];
    const fakeDb = {
      dialect: "mariadb",
      async get(sql: string): Promise<any> {
        calls.push(`get:${sql.slice(0, 60)}`);
        if (sql.includes("assigned_formula")) {
          return { assigned_formula: JSON.stringify({ type: "proportional", enabled: true, params: { minIn: 0, maxIn: 10, minOut: 30, maxOut: 100 } }) };
        }
        if (sql.includes("MAX(total_score)")) return { max: 10, min: 10, avg: 10 };
        return null;
      },
      async all(): Promise<any[]> {
        calls.push("all:scores");
        return [
          { student_id: 1, total_score: 10 },
          { student_id: 2, total_score: 10 },
          { student_id: 3, total_score: 10 },
        ];
      },
      async run(sql: string): Promise<any> {
        calls.push(`run:${sql.slice(0, 80)}`);
        return { lastInsertRowid: 1, changes: 3 };
      },
      async exec(): Promise<void> { calls.push("exec"); },
      async transaction<T>(fn: (db: any) => Promise<T>): Promise<T> { return fn(fakeDb); },
    };
    const fakeSvc = new AssignedScoreServiceClass();
    // getFormula 使用实例的 this.db，测试中整体替换为假 adapter 以模拟池行为
    (fakeSvc as any).db = fakeDb;
    const fakeResult = await fakeSvc.recalculateAll(123, fakeDb as any);
    const updateCalls = calls.filter((c) => c.startsWith("run:"));
    check(fakeResult.updated === 3 && fakeResult.skipped === 0, "假 adapter 下 3 名学生全部计入更新");
    check(
      updateCalls.length === 1 && updateCalls[0].includes("CASE"),
      "赋分重算仅发出 1 条 CASE WHEN UPDATE（语句级原子，不依赖 SAVEPOINT/固定连接）"
    );

    section("Web 模式（PROJECTX_ENABLE_SCANNER=false）：图片路由可用、TWAIN 关闭");
    const imgRes = await fetch(`${base}/api/scanner/grading-image/review-card/nope.png`, {
      headers: authHeaders(token)
    });
    const imgBody = await imgRes.json() as { message?: string };
    check(
      imgRes.status === 404 && imgBody.message === "图片不存在",
      "grading-image 纯文件路由在 Web 模式仍挂载（成绩/改分页整页预览不 404）"
    );
    const twainRes = await fetch(`${base}/api/scanner/sources`, { headers: authHeaders(token) });
    const twainBody = await twainRes.json() as { message?: string };
    check(
      twainRes.status === 404 && String(twainBody.message).includes("disabled"),
      "TWAIN 路由（/sources）在 Web 模式返回 404 disabled"
    );

    section("答题卡资源鉴权（assets 路由在全局 optionalAuth 之前注册的回归）");
    const assetDir = path.join(process.env.ANSWER_CARD_DATA_DIR!, "assets", "review-card");
    mkdirSync(assetDir, { recursive: true });
    const assetFile = path.join(assetDir, "asset-test.png");
    writeFileSync(assetFile, "not-a-real-image");
    const anonAsset = await fetch(`${base}/api/assets/review-card/asset-test.png`);
    check(anonAsset.status === 401, "未登录访问答题卡资源返回 401（强制鉴权）");
    const adminAsset = await fetch(`${base}/api/assets/review-card/asset-test.png`, {
      headers: authHeaders(token)
    });
    check(adminAsset.status === 200, "教师/管理员登录后可访问答题卡资源（optionalAuth 顺序正确）");

    section("阅卷分配：不存在的教师被拒绝");
    const badAssign = await fetch(`${base}/api/review-assign/exams/${examId}/blocks/b1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ teacherCounts: { 99999: 5 } })
    });
    const badAssignBody = await badAssign.json() as { error?: string };
    check(
      badAssign.status === 400 && String(badAssignBody.error).includes("不存在的教师"),
      "分配包含不存在的教师时返回 400（而非外键 500）"
    );

    section("成绩趋势按教师可见范围过滤");
    db.prepare("INSERT INTO grades (id, name, sort_order) VALUES (30, '高三', 0)").run();
    db.prepare("INSERT INTO classes (id, grade_id, name, sort_order) VALUES (101, 30, '一班', 0)").run();
    db.prepare("INSERT INTO classes (id, grade_id, name, sort_order) VALUES (102, 30, '二班', 1)").run();
    for (const sid of studentIds) {
      db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (101, ?)").run(sid);
    }
    const teacherInfo = db.prepare(
      `INSERT INTO users (username, name, role_id, subject, teacher_role, is_active, password_hash)
       VALUES ('teacher1', '化学老师', 2, '化学', 'subject_teacher', 1, ?)`
    ).run(await hashPassword("TeacherTest-2026!"));
    const teacherId = Number(teacherInfo.lastInsertRowid);
    db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, 101, '化学')").run(teacherId);
    db.prepare("UPDATE exams SET class_id = 101, grade_id = 30 WHERE id = ?").run(examId);
    const exam2 = db.prepare(
      `INSERT INTO exams (name, card_id, subject, class_id, grade_id, status, created_by)
       VALUES ('趋势不可见考试', 'review-card', '化学', 102, 30, 'active', ?)`
    ).run(admin.id);
    const exam2Id = Number(exam2.lastInsertRowid);
    const s4 = db.prepare(
      `INSERT INTO users (username, name, role_id, student_number, is_active, password_hash)
       VALUES ('S004', '四号生', 3, 'S004', 1, '')`
    ).run();
    const s4Id = Number(s4.lastInsertRowid);
    db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (102, ?)").run(s4Id);
    db.prepare(
      `INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score)
       VALUES (?, ?, 0, 0, 8)`
    ).run(exam2Id, s4Id);
    const teacherLogin = await authService.login("teacher1", "TeacherTest-2026!");
    if (!teacherLogin.token) throw new Error("教师登录失败");
    const teacherToken = teacherLogin.token;
    const teacherTrend = await fetch(`${base}/api/analysis/trends?subject=${encodeURIComponent("化学")}`, {
      headers: authHeaders(teacherToken)
    });
    const teacherTrendBody = await teacherTrend.json() as Array<{ examId: number }>;
    const adminTrend = await fetch(`${base}/api/analysis/trends?subject=${encodeURIComponent("化学")}`, {
      headers: authHeaders(token)
    });
    const adminTrendBody = await adminTrend.json() as Array<{ examId: number }>;
    check(
      teacherTrendBody.length === 1 && teacherTrendBody[0].examId === examId,
      "学科教师趋势仅包含其可见考试（跨班级考试被过滤）"
    );
    check(
      adminTrendBody.some((e) => e.examId === examId) && adminTrendBody.some((e) => e.examId === exam2Id),
      "管理员趋势包含全部考试"
    );

    section("我的待阅：已阅数超过分配数时待阅数收敛为 0");
    db.prepare(
      `INSERT INTO review_assignments (exam_id, block_id, teacher_id, student_count, assigned_student_ids)
       VALUES (?, 'b1', ?, 1, '[1]')`
    ).run(
      examId, teacherId
    );
    db.prepare(
      `INSERT INTO answer_block_crops
        (id, card_id, exam_id, student_id, student_number, source_type, source_record_id, block_id,
         block_title, block_type, page_number, segment_index, question_numbers, rect_json, image_path,
         width_px, height_px, dpi, status, reviewer_id, review_round, claim_count)
       VALUES ('crop-x1', 'review-card', ?, ?, 'S001', 'scan_record', 'rx1', 'b1',
         '解答题', 'subjective', 1, 0, '[1]', '{}', '/tmp/x.png',
         100, 100, 300, 'reviewed', ?, 1, 0),
              ('crop-x2', 'review-card', ?, ?, 'S002', 'scan_record', 'rx2', 'b1',
         '解答题', 'subjective', 1, 0, '[1]', '{}', '/tmp/y.png',
         100, 100, 300, 'reviewed', ?, 1, 0)`
    ).run(
      examId, studentIds[0], teacherId, examId, studentIds[1], teacherId
    );
    const myExams = await fetch(`${base}/api/review/my-exams`, { headers: authHeaders(teacherToken) });
    const myExamsBody = await myExams.json() as { data?: Array<{ examId: number; totalCount: number; pendingCount: number }> };
    const row = myExamsBody.data?.find((r) => r.examId === examId);
    check(
      myExams.status === 200 && row?.totalCount === 1 && row?.pendingCount === 0,
      `已阅数(2) > 分配数(1) 时 pendingCount 收敛为 0（实际 ${row?.pendingCount}）`
    );

    section("仪表盘：按教师可见范围过滤 + 继续阅卷进度");
    db.prepare(
      `INSERT INTO review_sessions (teacher_id, exam_id, block_id, current_index)
       VALUES (?, ?, 'b1', 1)`
    ).run(
      teacherId, examId
    );
    const dashTeacher = await fetch(`${base}/api/dashboard`, { headers: authHeaders(teacherToken) });
    const dashTeacherBody = await dashTeacher.json() as {
      data?: { stats?: { totalExams: number }; unfinishedTask?: { progress?: { total: number } } };
    };
    const dashAdmin = await fetch(`${base}/api/dashboard`, { headers: authHeaders(token) });
    const dashAdminBody = await dashAdmin.json() as { data?: { stats?: { totalExams: number } } };
    check(
      dashTeacherBody.data?.stats?.totalExams === 1,
      `学科教师仪表盘统计仅含可见考试（实际 ${dashTeacherBody.data?.stats?.totalExams}）`
    );
    check(
      dashAdminBody.data?.stats?.totalExams === 2,
      `管理员仪表盘统计包含全部考试（实际 ${dashAdminBody.data?.stats?.totalExams}）`
    );
    check(
      dashTeacherBody.data?.unfinishedTask?.progress?.total === 1,
      `继续阅卷进度总数取分配份数而非分配行数（实际 ${dashTeacherBody.data?.unfinishedTask?.progress?.total}）`
    );

    section("仲裁人列表（考试带年级时不再因 users.grade_id 报错）");
    const arbRes = await fetch(`${base}/api/review-arbitration/exams/${examId}/blocks/b1/arbitrators`, {
      headers: authHeaders(token)
    });
    const arbBody = await arbRes.json() as { ok?: boolean; data?: unknown };
    check(
      arbRes.status === 200 && arbBody.ok === true && Array.isArray(arbBody.data),
      "仲裁人候选接口在考试带 grade_id 时返回 200（users.grade_id 修复生效）"
    );

    section("学生搜索：LIKE 通配符按字面量匹配");
    const names = ["张%三", "张四", "李_五", "王\\六"];
    const likeStudentIds: number[] = [];
    for (const name of names) {
      const info = db.prepare(
        `INSERT INTO users (username, name, role_id, student_number, is_active, password_hash) VALUES (?, ?, 3, ?, 1, '')`
      ).run(`U_${name}`, name, `SN_${name}`);
      likeStudentIds.push(Number(info.lastInsertRowid));
    }
    for (const sid of likeStudentIds) {
      db.prepare(
        `INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score)
         VALUES (?, ?, 0, 0, 10)`
      ).run(
        examId, sid
      );
    }
    const searchCases: Array<[string, number]> = [
      ["张%", 1],   // 只应命中「张%三」，若未转义会命中「张四」
      ["李_", 1],   // 只应命中「李_五」
      ["王\\", 1],  // 只应命中「王\六」
    ];
    for (const [q, expected] of searchCases) {
      const res = await fetch(`${base}/api/exams/${examId}/students/search?q=${encodeURIComponent(q)}`, {
        headers: authHeaders(token)
      });
      const body = await res.json() as Array<{ name: string }>;
      check(res.status === 200 && body.length === expected, `搜索「${q}」返回 ${expected} 条（LIKE 字面量）`);
    }

    section("登录账号维度限速");
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "teacher1", password: "wrong-pass" })
      });
      if (res.status === 429) { got429 = true; break; }
    }
    check(got429, "同一账号连续错误登录超过账号阈值后返回 429（轮换 IP 也无法绕过账号维度）");

    console.log(`\nreview-ranking-degradation：${passed} 通过，${failures.length} 失败`);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
