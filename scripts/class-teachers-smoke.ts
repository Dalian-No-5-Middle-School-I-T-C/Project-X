/**
 * 第 8 条（2026-09-23 反馈）回归：班级改名 + 班主任 + 分科任课教师。
 *
 * 走真实 HTTP：建年级/班级 → 改名 → 设班主任（不限学科）→ 按学科设任课教师 → 改科目/解除，
 * 并回读数据库确认持久化结果（teacher_classes 一行一人一班、按班 is_head_teacher）。
 * 复审回归（2026-09-26）：按班班主任不得扩大其它任教班级的权限、更换失败不删除现任。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";

const tempDir = mkdtempSync(path.join(tmpdir(), "projectx-class-teachers-"));
process.env.PROJECTX_DB_PATH = path.join(tempDir, "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tempDir, "data");
process.env.USERPROFILE = path.join(tempDir, "home");
process.env.PROJECTX_ENABLE_SCANNER = "false";
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST"
]) delete process.env[key];

const ADMIN_PASSWORD = "ClassTeacher-2026!";

let server: Server | null = null;

async function main(): Promise<void> {
  const { initializeDatabase, closeDatabase, getDatabase, ensureDefaultAdmin } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { UserRepository } = await import("../src/server/repositories/UserRepository");

  try {
    initializeDatabase();
    const bootstrap = await ensureDefaultAdmin();
    const initialPassword = readFileSync(bootstrap.passwordFile, "utf8").trim();
    const app = await createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const bootstrapLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: initialPassword })
    });
    assert.equal(bootstrapLogin.status, 200, "初始管理员登录失败");
    const bootstrapToken = ((await bootstrapLogin.json()) as { token?: string }).token;
    assert.ok(bootstrapToken, "初始管理员登录未返回 token");
    const changed = await fetch(`${base}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bootstrapToken}` },
      body: JSON.stringify({ oldPassword: initialPassword, newPassword: ADMIN_PASSWORD })
    });
    assert.equal(changed.status, 200, "初始改密失败");
    const adminLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: ADMIN_PASSWORD })
    });
    assert.equal(adminLogin.status, 200, "改密后管理员登录失败");
    const token = ((await adminLogin.json()) as { token?: string }).token!;
    const auth = { Authorization: `Bearer ${token}` };
    const post = (url: string, body: unknown, method = "POST") =>
      fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) });
    const get = (url: string) => fetch(`${base}${url}`, { headers: auth });

    // ── 数据准备 ─────────────────────────────────────
    const users = new UserRepository();
    const wang = await users.createUser({ username: "smoke-wang", password: "pw-123456", name: "王晶", role_id: 2, teacher_role: "subject_teacher", subject: "物理" });
    const li = await users.createUser({ username: "smoke-li", password: "pw-123456", name: "李雷", role_id: 2, teacher_role: "subject_teacher", subject: "物理" });
    const han = await users.createUser({ username: "smoke-han", password: "pw-123456", name: "韩梅", role_id: 2, teacher_role: "subject_teacher", subject: "语文" });

    const gradeResp = await post("/api/classes/grades", { name: "高三" });
    assert.equal(gradeResp.status, 201, "创建年级失败");
    const gradeId = ((await gradeResp.json()) as { id: number }).id;
    const classResp = await post("/api/classes", { gradeId, name: "二班" });
    assert.equal(classResp.status, 201, "创建班级失败");
    const classId = ((await classResp.json()) as { id: number }).id;

    // ── 1. 班级改名 ───────────────────────────────────
    const renamed = await fetch(`${base}/api/classes/${classId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ name: "高三(2)班" })
    });
    assert.equal(renamed.status, 200, "班级改名失败");
    const listed = (await (await get(`/api/classes?gradeId=${gradeId}`)).json()) as Array<{ id: number; name: string }>;
    assert.equal(listed.find((item) => item.id === classId)?.name, "高三(2)班", "班级改名未持久化");
    const emptyName = await fetch(`${base}/api/classes/${classId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ name: "   " })
    });
    assert.equal(emptyName.status, 400, "空班级名必须被拒绝");

    // ── 2. 班主任（全部教师可选，不限学科）────────────
    type ClassTeachers = {
      headTeacherId: number | null;
      headTeacherName: string | null;
      assignments: Array<{ teacherId: number; name: string; subject: string; teacherRole: string | null }>;
    };
    const initial = (await (await get(`/api/classes/${classId}/teachers`)).json()) as ClassTeachers;
    assert.equal(initial.headTeacherId, null, "新班级不应有班主任");
    assert.deepEqual(initial.assignments, [], "新班级不应有任课教师");

    const setHead = await post(`/api/classes/${classId}/head-teacher`, { teacherId: wang.id }, "PUT");
    assert.equal(setHead.status, 200, "设置班主任失败");
    let config = (await (await get(`/api/classes/${classId}/teachers`)).json()) as ClassTeachers;
    assert.equal(config.headTeacherId, wang.id, "班主任未生效");
    const db = getDatabase();
    const headRole = db.prepare("SELECT teacher_role FROM users WHERE id = ?").get(wang.id) as { teacher_role: string };
    assert.equal(headRole.teacher_role, "subject_teacher", "设班主任不得改动教师的全局 users.teacher_role");
    const headLink = db.prepare("SELECT subject, is_head_teacher FROM teacher_classes WHERE teacher_id = ? AND class_id = ?").get(wang.id, classId) as { subject: string | null; is_head_teacher: number };
    assert.equal(headLink.is_head_teacher, 1, "班主任必须按班记在 teacher_classes.is_head_teacher");

    // ── 3. 分科任课教师 ───────────────────────────────
    assert.equal((await post(`/api/classes/${classId}/teachers`, { teacherId: li.id, subject: "物理" })).status, 200, "设置物理任课教师失败");
    config = (await (await get(`/api/classes/${classId}/teachers`)).json()) as ClassTeachers;
    assert.deepEqual(config.assignments.map((item) => [item.teacherId, item.subject]), [[li.id, "物理"]], "任课教师未生效");

    // 同一教师改科目：主键 (teacher_id, class_id) 只保留一行
    assert.equal((await post(`/api/classes/${classId}/teachers`, { teacherId: li.id, subject: "数学" })).status, 200, "改科目失败");
    config = (await (await get(`/api/classes/${classId}/teachers`)).json()) as ClassTeachers;
    assert.deepEqual(config.assignments.map((item) => [item.teacherId, item.subject]), [[li.id, "数学"]], "改科目应原地更新为一行");

    const badSubject = await post(`/api/classes/${classId}/teachers`, { teacherId: li.id, subject: "体育" });
    assert.equal(badSubject.status, 400, "非 9 科科目必须被拒绝");
    const badTeacher = await post(`/api/classes/${classId}/teachers`, { teacherId: 999999, subject: "物理" });
    assert.equal(badTeacher.status, 404, "不存在的教师必须被拒绝");

    // ── 4. 换班主任：旧班主任解绑，任课教师不受影响 ────
    assert.equal((await post(`/api/classes/${classId}/head-teacher`, { teacherId: han.id }, "PUT")).status, 200, "换班主任失败");
    config = (await (await get(`/api/classes/${classId}/teachers`)).json()) as ClassTeachers;
    assert.equal(config.headTeacherId, han.id, "班主任未替换");
    assert.deepEqual(config.assignments.map((item) => [item.teacherId, item.subject]), [[li.id, "数学"]], "换班主任不应影响任课教师");
    const oldHeadLink = db.prepare("SELECT subject FROM teacher_classes WHERE teacher_id = ? AND class_id = ?").get(wang.id, classId);
    assert.equal(oldHeadLink, undefined, "旧班主任应解除该班关联");

    // ── 5. 解除任课教师 + 清除班主任 ───────────────────
    assert.equal((await fetch(`${base}/api/classes/${classId}/teachers/${li.id}`, { method: "DELETE", headers: auth })).status, 200, "解除任课教师失败");
    config = (await (await get(`/api/classes/${classId}/teachers`)).json()) as ClassTeachers;
    assert.deepEqual(config.assignments, [], "解除后不应再有任课教师");
    assert.equal((await post(`/api/classes/${classId}/head-teacher`, { teacherId: null }, "PUT")).status, 200, "清除班主任失败");
    config = (await (await get(`/api/classes/${classId}/teachers`)).json()) as ClassTeachers;
    assert.equal(config.headTeacherId, null, "清除班主任未生效");

    // ── 6. 按班班主任不扩大其它任教班级的权限 / 更换失败保留现任 ──
    const { getVisibleExamIds } = await import("../src/apps/answer-card/server/middleware");
    const wangUser = { id: wang.id, role_name: "teacher", teacher_role: "subject_teacher", subject: "物理" } as never;
    const insertExam = (targetClassId: number, subject: string) => {
      const info = db.prepare("INSERT INTO exams (name, grade_id, class_id, subject, exam_mode) VALUES (?, ?, ?, ?, 'formal')")
        .run(`${subject}考试-${targetClassId}`, gradeId, targetClassId, subject);
      return Number(info.lastInsertRowid);
    };
    const classB = ((await (await post("/api/classes", { gradeId, name: "一班" })).json()) as { id: number }).id;
    assert.equal((await post(`/api/classes/${classB}/teachers`, { teacherId: wang.id, subject: "物理" })).status, 200, "为乙班设置物理任课教师失败");
    const examBPhysics = insertExam(classB, "物理");
    const examBChinese = insertExam(classB, "语文");
    const examAPhysics = insertExam(classId, "物理");
    const examAChinese = insertExam(classId, "语文");

    const before = await getVisibleExamIds(wangUser);
    assert.ok(before && before.includes(examBPhysics) && !before.includes(examBChinese), "任教班级只应看到任教学科考试");
    assert.ok(before && !before.includes(examAChinese) && !before.includes(examAPhysics), "无关联班级应完全不可见");

    assert.equal((await post(`/api/classes/${classId}/head-teacher`, { teacherId: wang.id }, "PUT")).status, 200, "设置甲班班主任失败");
    const during = await getVisibleExamIds(wangUser);
    assert.ok(during && during.includes(examAChinese) && during.includes(examAPhysics), "班主任应看到本班全科考试");
    assert.ok(during && !during.includes(examBChinese), "仅任教的乙班语文考试必须仍不可见（复审第 1 条）");

    const badReplace = await post(`/api/classes/${classId}/head-teacher`, { teacherId: 999999 }, "PUT");
    assert.equal(badReplace.status, 404, "不存在的教师必须被拒绝");
    config = (await (await get(`/api/classes/${classId}/teachers`)).json()) as ClassTeachers;
    assert.equal(config.headTeacherId, wang.id, "更换失败不得删除现任班主任（复审第 2 条）");

    assert.equal((await post(`/api/classes/${classId}/head-teacher`, { teacherId: null }, "PUT")).status, 200, "清除甲班班主任失败");
    const after = await getVisibleExamIds(wangUser);
    assert.ok(after && !after.includes(examAChinese) && !after.includes(examAPhysics), "清除班主任后本班考试恢复不可见");
    assert.ok(after && after.includes(examBPhysics) && !after.includes(examBChinese), "清除后任教范围权限保持原样");
    const stillPlain = db.prepare("SELECT teacher_role FROM users WHERE id = ?").get(wang.id) as { teacher_role: string };
    assert.equal(stillPlain.teacher_role, "subject_teacher", "全流程不得触碰全局教师角色");

    console.log("verify:class-teachers 通过（班级改名 / 按班班主任 / 分科任课教师 / 权限范围不扩散 / 更换失败保留现任）");
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
