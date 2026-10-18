/**
 * Issue #322：学生账号在网页端不能改阅卷/评分设置，也不能上传或看到背景图。
 * 教师账号仍可修改这些个人设置并上传背景图。
 *
 * 使用隔离 SQLite，不碰现有业务库。
 */
import assert from "node:assert/strict";
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

async function main(): Promise<void> {
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

    const studentBackgroundAgain = await fetch(`${base}/api/app/background`, { headers: studentAuth });
    assert.equal(studentBackgroundAgain.status, 404, "教师上传成功后，学生背景接口仍必须 404");
    assert.equal(studentBackgroundAgain.headers.get("cache-control"), "private, no-store");

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

    await new Promise((resolve) => setImmediate(resolve));
    const isolatedTokenPath = path.join(process.env.PROJECTX_TOKEN_DIR!, "tokens.json");
    assert.equal(existsSync(isolatedTokenPath), true, "登录令牌应写入 PROJECTX_TOKEN_DIR");
    const homeTokenShaAfter = existsSync(homeTokenPath)
      ? createHash("sha256").update(readFileSync(homeTokenPath)).digest("hex")
      : null;
    assert.equal(homeTokenShaAfter, homeTokenSha, "本脚本不得改写运行账户的 ~/.projectx/tokens.json");

    console.log("verify:student-web-settings 通过（学生无背景图、不能改阅卷/评分、不能上传；教师能力保留；缓存按 Cookie 隔离；匿名不能写设置）");
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
