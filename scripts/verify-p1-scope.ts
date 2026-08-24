/**
 * P1-2 应考范围/显式名单回归验证（临时 SQLite 库 + HTTP）：
 *  T1  创建考试缺范围 → 400 SCOPE_REQUIRED（强制应考范围）
 *  T2  无范围考试 + 1 条成绩 → publish 409（删除「仅校验非空」退化路径）
 *  T3  无范围考试 + 显式名单 2 人 + 2 条成绩 → publish 200
 *  T4  显式名单缺人 → publish 409（缺 1）
 *  T5  空班级考试 → publish 409（应考名单为空）
 *  T6  批量公布含无范围考试 → 整体 409
 *  T7  PATCH 补设范围（无显式名单）→ 成功；此后按班级名册校验
 *  T8  PATCH 补设范围（已有显式名单）→ 409 EXPLICIT_LIST_CONFLICT
 *  T9  DELETE participants 清除显式名单 → 回落班级/年级校验
 *  T10 创建带范围 → 201 正常
 *
 * 用法: npx tsx scripts/verify-p1-scope.ts（须用 Node 24 运行 tsx）
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-p1-scope-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
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

const DEMO_ADMIN_PASSWORD = "Admin@P1Scope2026";
async function loginAdmin(base: string, initial: string): Promise<string> {
  const first = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "admin", password: initial }),
  });
  const firstBody = await first.json();
  if (firstBody.token && !firstBody?.passwordChangeRequired) return firstBody.token;
  if (first.status === 428 || firstBody?.code === "PASSWORD_CHANGE_REQUIRED" || firstBody?.passwordChangeRequired) {
    await fetch(`${base}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${firstBody?.token ?? ""}` },
      body: JSON.stringify({ oldPassword: initial, newPassword: DEMO_ADMIN_PASSWORD }),
    }).catch(() => {});
    const retry = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: DEMO_ADMIN_PASSWORD }),
    });
    const retryBody = await retry.json();
    if (retryBody.token) return retryBody.token;
    throw new Error(`admin 自动改密失败：首次=${first.status}，重试=${retry.status}`);
  }
  throw new Error(`admin 登录失败: status=${first.status} body=${JSON.stringify(firstBody)}`);
}

async function main() {
  console.log(`临时库: ${process.env.PROJECTX_DB_PATH}`);
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");

  initializeDatabase();
  const db = getDatabase();
  const bootstrap = await ensureDefaultAdmin();

  // ── 夹具：年级 G → 班级 A（含 s1,s2）/ 班级 B（含 s3,s4）──
  const gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES ('范围测试年级', 1, 0)").run().lastInsertRowid);
  const classA = Number(db.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '范围A班', 1, 0)").run(gradeId).lastInsertRowid);
  const classB = Number(db.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '范围B班', 2, 0)").run(gradeId).lastInsertRowid);
  const emptyClass = Number(db.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '空班级', 3, 0)").run(gradeId).lastInsertRowid);
  const sids: Record<string, number> = {};
  for (const num of ["20001", "20002", "20003", "20004", "20005"]) {
    const r = db.prepare("INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES (?, 'x', ?, 3, ?, 1)")
      .run(`scope-${num}`, `范围学生${num}`, num);
    sids[num] = Number(r.lastInsertRowid);
  }
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, sids["20001"]);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, sids["20002"]);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classB, sids["20003"]);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classB, sids["20004"]);
  const cardId = "TESCARD001";
  db.prepare("INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by) VALUES (?, '范围测试卡', 'math', '数学', '2026-08-24', 'A4', 'portrait', '{}', 5, 'single', 1, 1)")
    .run(cardId);

  function createExamDirect(name: string, opts: { classId?: number; gradeId?: number }): number {
    const r = db.prepare(
      `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, score_published, exam_mode, created_by)
       VALUES (?, ?, ?, ?, '数学', CURRENT_TIMESTAMP, 'closed', 0, 'formal', (SELECT id FROM users WHERE username='admin'))`
    ).run(name, cardId, opts.gradeId ?? null, opts.classId ?? null);
    return Number(r.lastInsertRowid);
  }
  function insertScore(examId: number, sid: number, total = 60): void {
    db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)")
      .run(examId, sid, total, total);
  }
  async function publish(base: string, headers: Record<string, string>, examId: number) {
    const r = await fetch(`${base}/api/exams/${examId}/publish`, { method: "POST", headers });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  const app = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const pwd = readFileSync(bootstrap.passwordFile, "utf8").trim();
  const token = await loginAdmin(base, pwd);
  const headers = { Authorization: `Bearer ${token}` };
  ok(Boolean(token), "admin 登录成功");

  // ── T1: 创建考试缺范围 → 400 ──
  {
    console.log("\n[T1] 创建考试强制应考范围");
    const r = await fetch(`${base}/api/exams`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "T1-无范围", cardId }),
    });
    ok(r.status === 400 && (await r.json().catch(() => ({}))).code === "SCOPE_REQUIRED", `缺范围创建 → 400 SCOPE_REQUIRED (实际 ${r.status})`);
  }

  // ── T2: 无范围考试 + 1 条成绩 → publish 409 ──
  {
    console.log("\n[T2] 无范围考试不再退化「仅校验非空」");
    const examId = createExamDirect("T2-无范围", {});
    insertScore(examId, sids["20001"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 409 && /完整性校验/.test(r.body?.message ?? ""), `无范围 + 1 条成绩 → 409 (实际 ${r.status})`);
  }

  // ── T3: 无范围考试 + 显式名单 2 人 + 2 条成绩 → publish 200 ──
  {
    console.log("\n[T3] 显式名单后可公布");
    const examId = createExamDirect("T3-显式名单", {});
    const put = await fetch(`${base}/api/exams/${examId}/participants`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ studentIds: [sids["20001"], sids["20002"]] }),
    });
    ok(put.status === 200, `PUT 显式名单 200 (实际 ${put.status})`);
    insertScore(examId, sids["20001"]);
    insertScore(examId, sids["20002"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `显式名单全录 → publish 200 (实际 ${r.status})`);
  }

  // ── T4: 显式名单缺人 → 409 ──
  {
    console.log("\n[T4] 显式名单缺人拒绝");
    const examId = createExamDirect("T4-缺人", {});
    await fetch(`${base}/api/exams/${examId}/participants`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ studentNumbers: ["20001", "20002", "20003"] }),
    });
    insertScore(examId, sids["20001"]);
    insertScore(examId, sids["20002"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 409, `显式名单缺 1 人 → 409 (实际 ${r.status})`);
  }

  // ── T5: 空班级考试 → 409 ──
  {
    console.log("\n[T5] 空班级拒绝");
    const examId = createExamDirect("T5-空班级", { classId: emptyClass });
    insertScore(examId, sids["20005"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 409 && /名单为空/.test(r.body?.message ?? ""), `空班级 → 409 名单为空 (实际 ${r.status})`);
  }

  // ── T6: 批量公布含无范围考试 → 409 ──
  {
    console.log("\n[T6] 批量公布含无范围考试整体 409");
    const goodId = createExamDirect("T6-正常", { classId: classA });
    insertScore(goodId, sids["20001"]);
    insertScore(goodId, sids["20002"]);
    const badId = createExamDirect("T6-无范围", {});
    insertScore(badId, sids["20003"]);
    const r = await fetch(`${base}/api/exams/publish-batch`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ examIds: [goodId, badId] }),
    });
    ok(r.status === 409, `批量含无范围 → 409 (实际 ${r.status})`);
  }

  // ── T7: PATCH 补设范围（无显式名单）→ 成功 ──
  {
    console.log("\n[T7] PATCH 补设范围");
    const examId = createExamDirect("T7-补设范围", {});
    insertScore(examId, sids["20001"]);
    insertScore(examId, sids["20002"]);
    const patch = await fetch(`${base}/api/exams/${examId}`, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ classId: classA }),
    });
    ok(patch.status === 200, `PATCH classId 成功 (实际 ${patch.status})`);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `补设范围后按班级名册校验 → 200 (实际 ${r.status})`);
  }

  // ── T8: PATCH 补设范围（已有显式名单）→ 409 ──
  {
    console.log("\n[T8] 显式名单与班级范围互斥");
    const examId = createExamDirect("T8-冲突", {});
    await fetch(`${base}/api/exams/${examId}/participants`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ studentIds: [sids["20001"]] }),
    });
    const patch = await fetch(`${base}/api/exams/${examId}`, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ classId: classA }),
    });
    const body = await patch.json().catch(() => ({}));
    ok(patch.status === 409 && body.code === "EXPLICIT_LIST_CONFLICT", `已有显式名单时 PATCH 范围 → 409 (实际 ${patch.status}/${body.code})`);
    // 清除显式名单后可补设
    const del = await fetch(`${base}/api/exams/${examId}/participants`, { method: "DELETE", headers });
    ok(del.status === 200, `DELETE 清除显式名单成功 (实际 ${del.status})`);
    const patch2 = await fetch(`${base}/api/exams/${examId}`, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ classId: classA }),
    });
    ok(patch2.status === 200, `清除后 PATCH 范围成功 (实际 ${patch2.status})`);
  }

  // ── T9: DELETE participants 回落班级校验（T8 已覆盖清除，这里验证回落行为）──
  {
    console.log("\n[T9] 清除显式名单后回落班级名册");
    const examId = createExamDirect("T9-回落", { classId: classA });
    await fetch(`${base}/api/exams/${examId}/participants`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ studentIds: [sids["20001"]] }),
    });
    await fetch(`${base}/api/exams/${examId}/participants`, { method: "DELETE", headers });
    insertScore(examId, sids["20001"]);
    // 回落后按班级 A 名册（20001, 20002）校验 → 缺 20002 → 409
    const r = await publish(base, headers, examId);
    ok(r.status === 409 && /不完整|缺/.test(r.body?.message ?? ""), `清除显式名单后按班级校验 → 409 缺人 (实际 ${r.status})`);
  }

  // ── T10: 创建带范围 → 201 ──
  {
    console.log("\n[T10] 创建带范围正常");
    const r = await fetch(`${base}/api/exams`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "T10-带范围", cardId, gradeId }),
    });
    ok(r.status === 201, `带年级创建 → 201 (实际 ${r.status})`);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

// 变量保护（T6 中 examId 声明）
main().catch((e) => { console.error(e); process.exitCode = 1; });
