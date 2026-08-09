/**
 * 回归测试：网阅提交后赋分重算中途失败时，API 必须返回降级状态
 * （assignedScoresRecalculated=false + assignedScoreError），而不是伪装成功。
 * 同时覆盖学生搜索 LIKE 通配符（%/_\）字面量匹配。
 *
 * 运行：npm run verify:review-ranking-degradation
 */
import { mkdtempSync, rmSync } from "node:fs";
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
    // 用于验证 savepoint 回滚后所有学生赋分保持原值（无部分更新）。
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
