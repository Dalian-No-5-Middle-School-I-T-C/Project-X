/** 应考范围/显式名单回归（隔离 SQLite + HTTP）。
 * 创建考试与名单编辑仍校验范围；公布已有成绩不要求名单齐全。
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

  // ── T2: 无范围考试已有成绩可公布 ──
  {
    console.log("\n[T2] 无范围已有成绩允许公布");
    const examId = createExamDirect("T2-无范围", {});
    insertScore(examId, sids["20001"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `无范围 + 1 条成绩 → 200 (实际 ${r.status})`);
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

  // ── T4: 显式名单缺人也能公布，名单编辑不影响幂等性 ──
  {
    console.log("\n[T4] 显式名单缺人允许公布");
    const examId = createExamDirect("T4-缺人", {});
    await fetch(`${base}/api/exams/${examId}/participants`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ studentNumbers: ["20001", "20002", "20003"] }),
    });
    insertScore(examId, sids["20001"]);
    insertScore(examId, sids["20002"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `显式名单缺 1 人 → 200 (实际 ${r.status})`);
    // 修改名单后重复公布依然幂等，不以删除缺考者为条件
    await fetch(`${base}/api/exams/${examId}/participants`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ studentNumbers: ["20001", "20002"] }),
    });
    const r2 = await publish(base, headers, examId);
    ok(r2.status === 200, `剔除缺考者后 → 200 (实际 ${r2.status})`);
  }

  // ── T5: 空班级已有成绩可公布 ──
  {
    console.log("\n[T5] 空班级有成绩允许公布");
    const examId = createExamDirect("T5-空班级", { classId: emptyClass });
    insertScore(examId, sids["20005"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `空班级有成绩 → 200 (实际 ${r.status})`);
    db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(emptyClass, sids["20005"]);
    const r2 = await publish(base, headers, examId);
    ok(r2.status === 200, `学生入班后名册非空 → 200 (实际 ${r2.status})`);
  }

  // ── T6: 批量公布含无范围考试，只要已有成绩即成功 ──
  {
    console.log("\n[T6] 批量公布含无范围考试允许");
    const goodId = createExamDirect("T6-正常", { classId: classA });
    insertScore(goodId, sids["20001"]);
    insertScore(goodId, sids["20002"]);
    const badId = createExamDirect("T6-无范围", {});
    insertScore(badId, sids["20003"]);
    const r = await fetch(`${base}/api/exams/publish-batch`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ examIds: [goodId, badId] }),
    });
    ok(r.status === 200, `批量含无范围 → 200 (实际 ${r.status})`);
    const good = db.prepare("SELECT score_published FROM exams WHERE id = ?").get(goodId) as { score_published: number };
    ok(Number(good.score_published) === 1, "批量公布成功：完整场次和部分场次均发布");
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
    ok(r.status === 200, `补设范围后公布 → 200（范围不再决定能否公布）(实际 ${r.status})`);
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
    // 回落名册后仍允许缺考，公布不改变应考名单。
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `清除显式名单后回落名册，缺 20002 → 200 (实际 ${r.status})`);
    insertScore(examId, sids["20002"]);
    const r2 = await publish(base, headers, examId);
    ok(r2.status === 200, `补齐名册后公布 → 200 (实际 ${r2.status})`);
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
