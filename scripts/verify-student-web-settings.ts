/**
 * Issue #322：学生账号在网页端不能改阅卷/评分设置，也不能上传或看到背景图。
 * 教师账号仍可修改这些个人设置并上传背景图。
 *
 * 使用隔离 SQLite，不碰现有业务库。
 */
import assert from "node:assert/strict";
import { createBackgroundOpacityQueue } from "../src/apps/answer-card/client/lib/backgroundOpacityWrites";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";

const tempDir = mkdtempSync(path.join(tmpdir(), "projectx-student-web-settings-"));
process.env.PROJECTX_DB_PATH = path.join(tempDir, "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tempDir, "data");
process.env.PROJECTX_TOKEN_DIR = path.join(tempDir, "tokens");
const homeTokenPath = path.join(homedir(), ".projectx", "tokens.json");
const homeTokenSha = existsSync(homeTokenPath)
  ? createHash("sha256").update(readFileSync(homeTokenPath)).digest("hex")
  : null;
process.env.PROJECTX_ENABLE_SCANNER = "false";
// #335：把生效上限收到 1 MiB，才能用一份刚过线的请求断言 413 文案，不必造 5 MiB 的夹具。
process.env.PROJECTX_BACKGROUND_UPLOAD_MIB = "1";
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST"
]) delete process.env[key];

const ADMIN_PASSWORD = "StudentWebSettings-2026!";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let server: Server | null = null;

type SettingsRow = {
  score_display_mode: string;
  review_confidence_threshold: number;
  background_opacity: number;
  show_tab_bar: number;
};

/** 在途的旧透明度 PATCH 必须先结束，DELETE 归零排在它后面，不能被晚到的旧值盖掉。 */
async function assertLateOpacityPatchCannotFinishAfterDelete(): Promise<void> {
  const queue = createBackgroundOpacityQueue();
  const events: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stale = queue.enqueue(async () => {
    events.push("patch-start");
    await gate;
    events.push("patch-end");
  });
  const removed = queue.enqueue(async () => { events.push("delete"); });
  await Promise.resolve();
  assert.deepEqual(events, ["patch-start"], "删除要等已经发出的透明度请求，不能和它并行");
  release();
  await stale;
  await removed;
  assert.deepEqual(events, ["patch-start", "patch-end", "delete"], "归零必须是最后一次写入");

  const recovered = createBackgroundOpacityQueue();
  const afterFailure: string[] = [];
  await recovered.enqueue(async () => { throw new Error("stale patch failed"); }).catch(() => {});
  await recovered.enqueue(async () => { afterFailure.push("delete"); });
  assert.deepEqual(afterFailure, ["delete"], "前一条透明度请求失败也不能卡住移除");
}

async function main(): Promise<void> {
  await assertLateOpacityPatchCannotFinishAfterDelete();
  const { initializeDatabase, closeDatabase, getDatabase, ensureDefaultAdmin } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { UserRepository } = await import("../src/server/repositories/UserRepository");
  const { mkdirSync, readdirSync, writeFileSync } = await import("node:fs");

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

    const users = new UserRepository();
    const student = await users.createUser({
      username: "stu-322",
      password: "pw-123456",
      name: "学生甲",
      role_id: 3,
      student_number: "322001"
    });
    const teacher = await users.createUser({
      username: "tch-322",
      password: "pw-123456",
      name: "教师乙",
      role_id: 2,
      teacher_role: "subject_teacher",
      subject: "数学"
    });

    const db = getDatabase();
    db.prepare(
      "UPDATE users SET background_opacity = 0.4, score_display_mode = 'zscore', review_confidence_threshold = 0.12, show_tab_bar = 0 WHERE id = ?"
    ).run(student.id);
    const backgroundsDir = path.join(process.env.ANSWER_CARD_DATA_DIR!, "backgrounds");
    mkdirSync(backgroundsDir, { recursive: true });
    writeFileSync(path.join(backgroundsDir, `${student.id}.jpg`), PNG);

    async function login(identifier: string): Promise<string> {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password: "pw-123456" })
      });
      assert.equal(response.status, 200, `${identifier} 登录失败`);
      const token = ((await response.json()) as { token?: string }).token;
      assert.ok(token, `${identifier} 登录未返回 token`);
      return token;
    }

    const studentAuth = { Authorization: `Bearer ${await login("stu-322")}` };
    const teacherAuth = { Authorization: `Bearer ${await login("tch-322")}` };
    const patch = (auth: { Authorization: string }, body: unknown) =>
      fetch(`${base}/api/users/me/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify(body)
      });
    const readRow = (id: number) =>
      db.prepare(
        "SELECT score_display_mode, review_confidence_threshold, background_opacity, show_tab_bar FROM users WHERE id = ?"
      ).get(id) as SettingsRow;

    const studentSettings = await fetch(`${base}/api/users/me/settings`, { headers: studentAuth });
    assert.equal(studentSettings.status, 200);
    const studentBody = await studentSettings.json() as { backgroundOpacity: number; scoreDisplayMode: string };
    assert.equal(studentBody.backgroundOpacity, 0, "学生读取设置时背景透明度必须为 0");
    assert.equal(studentBody.scoreDisplayMode, "zscore", "学生仍可读取既有成绩指标，只是不能改");

    const studentBackground = await fetch(`${base}/api/app/background`, { headers: studentAuth });
    assert.equal(studentBackground.status, 404, "学生请求背景图必须 404，即使磁盘上已有自定义图");
    assert.equal(studentBackground.headers.get("cache-control"), "private, no-store", "学生 404 不能被缓存");
    assert.equal(studentBackground.headers.get("vary"), "Cookie, Authorization", "背景响应必须按登录态区分");

    for (const body of [
      { backgroundOpacity: 0.2 },
      { scoreDisplayMode: "percentile" },
      { reviewConfidenceThreshold: 0.55 },
      { showTabBar: true, scoreDisplayMode: "deviation" }
    ]) {
      const denied = await patch(studentAuth, body);
      assert.equal(denied.status, 403, `学生修改 ${JSON.stringify(body)} 必须被拒绝`);
    }
    let stored = readRow(student.id);
    assert.equal(stored.background_opacity, 0.4, "拒绝后不得改写学生背景透明度");
    assert.equal(stored.score_display_mode, "zscore", "拒绝后不得改写学生成绩指标");
    assert.equal(stored.review_confidence_threshold, 0.12, "拒绝后不得改写学生复核阈值");
    assert.equal(stored.show_tab_bar, 0, "夹带阅卷字段的保存不得顺带改底部导航");

    const allowed = await patch(studentAuth, { showTabBar: true, colorScheme: "dark" });
    assert.equal(allowed.status, 200, "学生仍可保存与阅卷无关的客户端设置");
    stored = readRow(student.id);
    assert.equal(stored.show_tab_bar, 1, "学生底部导航开关应能保存");
    const scheme = db.prepare("SELECT color_scheme FROM users WHERE id = ?").get(student.id) as { color_scheme: string };
    assert.equal(scheme.color_scheme, "dark", "学生明暗方案应能保存");
    assert.equal(stored.score_display_mode, "zscore");
    assert.equal(stored.background_opacity, 0.4);

    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "bg.png");
    const studentUpload = await fetch(`${base}/api/users/me/background`, {
      method: "POST",
      headers: studentAuth,
      body: form
    });
    assert.equal(studentUpload.status, 403, "学生上传背景图必须被拒绝");
    assert.equal(existsSync(path.join(backgroundsDir, `${student.id}.jpg`)), true, "预先种下的学生背景文件应仍在");
    const uploadTemps = readdirSync(backgroundsDir).filter((name) => name.startsWith("upload_"));
    assert.deepEqual(uploadTemps, [], "学生上传应在落盘前拒绝，不能留下临时文件");

    const teacherPatch = await patch(teacherAuth, {
      scoreDisplayMode: "percentile",
      reviewConfidenceThreshold: 0.33,
      backgroundOpacity: 0.2
    });
    assert.equal(teacherPatch.status, 200, "教师仍可保存阅卷、评分和背景透明度");
    const teacherStored = readRow(teacher.id);
    assert.equal(teacherStored.score_display_mode, "percentile");
    assert.equal(teacherStored.review_confidence_threshold, 0.33);
    assert.equal(teacherStored.background_opacity, 0.2);
    const teacherSettings = await fetch(`${base}/api/users/me/settings`, { headers: teacherAuth });
    const teacherBody = await teacherSettings.json() as { backgroundOpacity: number; scoreDisplayMode: string; reviewConfidenceThreshold: number };
    assert.equal(teacherBody.backgroundOpacity, 0.2);
    assert.equal(teacherBody.scoreDisplayMode, "percentile");
    assert.equal(teacherBody.reviewConfidenceThreshold, 0.33);

    const teacherDefault = await fetch(`${base}/api/app/background`, { headers: teacherAuth });
    assert.equal(teacherDefault.status, 200, "未上传自定义图时教师应拿到随包默认背景");
    assert.equal(teacherDefault.headers.get("cache-control"), "private, no-store");
    assert.equal(teacherDefault.headers.get("vary"), "Cookie, Authorization");
    assert.equal(/public/.test(teacherDefault.headers.get("cache-control") ?? ""), false);
    await teacherDefault.arrayBuffer();

    const teacherForm = new FormData();
    teacherForm.append("file", new Blob([PNG], { type: "image/png" }), "bg.png");
    const teacherUpload = await fetch(`${base}/api/users/me/background`, {
      method: "POST",
      headers: teacherAuth,
      body: teacherForm
    });
    assert.equal(teacherUpload.status, 200, "教师上传背景图应成功");
    assert.ok(existsSync(path.join(backgroundsDir, `${teacher.id}.jpg`)), "教师背景图应写入 backgrounds/<id>.jpg");
    const teacherBackground = await fetch(`${base}/api/app/background`, { headers: teacherAuth });
    assert.equal(teacherBackground.status, 200, "教师应能读取自己的背景图");
    assert.equal(teacherBackground.headers.get("cache-control"), "private, no-store", "自定义背景不能被缓存");
    assert.equal(teacherBackground.headers.get("vary"), "Cookie, Authorization");
    assert.ok((await teacherBackground.arrayBuffer()).byteLength > 0);

    const teacherSettingsLimit = await fetch(`${base}/api/users/me/settings`, { headers: teacherAuth });
    const teacherLimitBody = await teacherSettingsLimit.json() as { backgroundUploadLimit?: string };
    assert.equal(teacherLimitBody.backgroundUploadLimit, "1 MiB", "设置接口应返回当前生效的背景图上限");

    const oversize = Buffer.alloc(1024 * 1024 + 64, 7);
    const overForm = new FormData();
    overForm.append("file", new Blob([oversize], { type: "image/png" }), "big.png");
    const tooBig = await fetch(`${base}/api/users/me/background`, {
      method: "POST",
      headers: teacherAuth,
      body: overForm
    });
    const tooBigBody = await tooBig.json() as { code?: string; message?: string };
    assert.equal(tooBig.status, 413, "超过 PROJECTX_BACKGROUND_UPLOAD_MIB 必须 413");
    assert.equal(tooBigBody.code, "UPLOAD_ERROR");
    assert.equal(tooBigBody.message, "上传文件超过大小限制（≤1 MiB）", "413 文案要带上当前生效上限");
    assert.deepEqual(
      readdirSync(backgroundsDir).filter((name) => name.startsWith("upload_")),
      [],
      "超限请求不能在 backgrounds 目录留下临时文件"
    );
    assert.ok(existsSync(path.join(backgroundsDir, `${teacher.id}.jpg`)), "超限不得覆盖已经上传成功的背景");

    const studentBackgroundAgain = await fetch(`${base}/api/app/background`, { headers: studentAuth });
    assert.equal(studentBackgroundAgain.status, 404, "教师上传成功后，学生背景接口仍必须 404");
    assert.equal(studentBackgroundAgain.headers.get("cache-control"), "private, no-store");

    const teacherDeniedPurge = await fetch(`${base}/api/admin/backgrounds/purge-students`, {
      method: "POST",
      headers: teacherAuth
    });
    assert.equal(teacherDeniedPurge.status, 403, "教师不能清退学生历史背景");
    const studentDeniedPurge = await fetch(`${base}/api/admin/backgrounds/purge-students`, {
      method: "POST",
      headers: studentAuth
    });
    assert.equal(studentDeniedPurge.status, 403, "学生不能清退历史背景");

    const studentDelete = await fetch(`${base}/api/users/me/background`, { method: "DELETE", headers: studentAuth });
    assert.equal(studentDelete.status, 200, "学生可以删除自己的历史背景文件");
    const studentDeleteBody = await studentDelete.json() as { removed?: boolean; opacityReset?: boolean };
    assert.equal(studentDeleteBody.removed, true);
    assert.equal(studentDeleteBody.opacityReset, true);
    assert.equal(existsSync(path.join(backgroundsDir, `${student.id}.jpg`)), false, "学生历史背景文件应被删掉");
    assert.equal(readRow(student.id).background_opacity, 0, "学生历史透明度应归零");
    assert.equal(existsSync(path.join(backgroundsDir, `${teacher.id}.jpg`)), true, "学生删除不得动教师文件");

    const teacherDelete = await fetch(`${base}/api/users/me/background`, { method: "DELETE", headers: teacherAuth });
    assert.equal(teacherDelete.status, 200, "教师可以移除自己的背景图");
    assert.equal(existsSync(path.join(backgroundsDir, `${teacher.id}.jpg`)), false);
    assert.equal(readRow(teacher.id).background_opacity, 0, "移除背景图时透明度归零");
    const teacherAfterDelete = await fetch(`${base}/api/app/background`, { headers: teacherAuth });
    assert.equal(teacherAfterDelete.status, 200, "删掉自定义图后教师回到随包默认背景");
    const defaultBg = readFileSync(path.resolve("resources/background.jpg"));
    const served = Buffer.from(await teacherAfterDelete.arrayBuffer());
    assert.equal(createHash("sha256").update(served).digest("hex"), createHash("sha256").update(defaultBg).digest("hex"));

    writeFileSync(path.join(backgroundsDir, `${student.id}.jpg`), PNG);
    writeFileSync(path.join(backgroundsDir, `${teacher.id}.jpg`), PNG);
    writeFileSync(path.join(backgroundsDir, "keep-me.png"), PNG);
    writeFileSync(path.join(backgroundsDir, "999999.jpg"), PNG);
    db.prepare("UPDATE users SET background_opacity = 0.4 WHERE id = ?").run(student.id);
    db.prepare("UPDATE users SET background_opacity = 0.2 WHERE id = ?").run(teacher.id);
    const adminLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: ADMIN_PASSWORD })
    });
    assert.equal(adminLogin.status, 200, "管理员重新登录失败");
    const adminToken = ((await adminLogin.json()) as { token?: string }).token;
    assert.ok(adminToken, "管理员登录未返回 token");
    const purged = await fetch(`${base}/api/admin/backgrounds/purge-students`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(purged.status, 200, "管理员可以清退学生历史背景");
    const purgedBody = await purged.json() as { removedFiles?: number; opacityReset?: number };
    assert.equal(purgedBody.removedFiles, 1, "清退只删学生文件");
    assert.equal(purgedBody.opacityReset, 1, "清退只把学生透明度归零");
    assert.equal(existsSync(path.join(backgroundsDir, `${student.id}.jpg`)), false);
    assert.equal(readRow(student.id).background_opacity, 0);
    assert.equal(existsSync(path.join(backgroundsDir, `${teacher.id}.jpg`)), true, "清退不得删除教师背景");
    assert.equal(readRow(teacher.id).background_opacity, 0.2, "清退不得改教师透明度");
    assert.equal(existsSync(path.join(backgroundsDir, "keep-me.png")), true, "清退不得删除非 <学生id>.jpg 的文件");
    assert.equal(existsSync(path.join(backgroundsDir, "999999.jpg")), true, "清退不得删除没有对应用户的文件");
    const purgedAgain = await fetch(`${base}/api/admin/backgrounds/purge-students`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const purgedAgainBody = await purgedAgain.json() as { removedFiles?: number; opacityReset?: number };
    assert.equal(purgedAgain.status, 200);
    assert.equal(purgedAgainBody.removedFiles, 0, "重复清退不再删文件");
    assert.equal(purgedAgainBody.opacityReset, 0, "重复清退不再改透明度");

    const { setAuthEnforced } = await import("../src/apps/answer-card/server/middleware");
    process.env.PROJECTX_AUTH_ENFORCE = "0";
    setAuthEnforced(false);
    const beforeTabs = readRow(teacher.id).show_tab_bar;
    const anonPatch = await fetch(`${base}/api/users/me/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showTabBar: false })
    });
    assert.equal(anonPatch.status, 401, "免登录模式下没有用户 id 时不能写入个人设置");
    assert.equal(readRow(teacher.id).show_tab_bar, beforeTabs, "匿名 PATCH 不得改写已有用户设置");
    const anonForm = new FormData();
    anonForm.append("file", new Blob([PNG], { type: "image/png" }), "anon.png");
    const anonUpload = await fetch(`${base}/api/users/me/background`, { method: "POST", body: anonForm });
    assert.equal(anonUpload.status, 401, "免登录模式下没有用户 id 时不能保存背景图");
    const names = readdirSync(backgroundsDir);
    assert.equal(names.includes("undefined.jpg"), false, "匿名上传不能落成 undefined.jpg");
    assert.deepEqual(names.filter((name) => name.startsWith("upload_")), [], "匿名上传被拒后不能留下临时文件");
    assert.equal(existsSync(path.join(backgroundsDir, `${teacher.id}.jpg`)), true, "匿名上传不得覆盖教师背景");
    const anonDelete = await fetch(`${base}/api/users/me/background`, { method: "DELETE" });
    assert.equal(anonDelete.status, 401, "免登录模式下没有用户 id 时不能删除背景图");
    const anonPurge = await fetch(`${base}/api/admin/backgrounds/purge-students`, { method: "POST" });
    assert.equal(anonPurge.status, 401, "免登录模式下匿名请求不能清退学生背景");
    assert.equal(existsSync(path.join(backgroundsDir, `${teacher.id}.jpg`)), true, "匿名删除不得带走教师背景");

    await new Promise((resolve) => setImmediate(resolve));
    const isolatedTokenPath = path.join(process.env.PROJECTX_TOKEN_DIR!, "tokens.json");
    assert.equal(existsSync(isolatedTokenPath), true, "登录令牌应写入 PROJECTX_TOKEN_DIR");
    const homeTokenShaAfter = existsSync(homeTokenPath)
      ? createHash("sha256").update(readFileSync(homeTokenPath)).digest("hex")
      : null;
    assert.equal(homeTokenShaAfter, homeTokenSha, "本脚本不得改写运行账户的 ~/.projectx/tokens.json");

    console.log("verify:student-web-settings 通过（学生无背景图、不能改阅卷/评分、不能上传；上限 413 带生效值；本人可删、管理员可清退学生历史背景且不动教师文件；匿名不能写或删）");
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
  process.exit(1);
});
