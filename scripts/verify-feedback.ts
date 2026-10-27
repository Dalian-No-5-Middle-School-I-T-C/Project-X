/**
 * 问题反馈（#357）端到端验证
 * ----------------------------------------------------------------
 * 运行方式：
 *   npm run verify:feedback             # 临时 SQLite
 *   npm run verify:feedback:mariadb     # 专用空 MariaDB（PROJECTX_MARIADB_DATABASE）
 *
 * 覆盖：
 *   1. v66 迁移建表、旧库补表与重复执行
 *   2. 提交 / 列表 / 状态流转 / 删除的权限边界
 *   3. 标题、正文、联系方式长度与控制字符
 *   4. 客户端环境信息白名单与服务端环境信息合并
 *   5. 标记处理后 resolved_at / resolved_by 的写入与撤销
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const maria = process.argv.includes("--mariadb");
if (maria) {
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_feedback_test");
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
} else {
  delete process.env.PROJECTX_MARIADB_HOST;
  delete process.env.PROJECTX_MYSQL_HOST;
}

const originalCwd = process.cwd();
let dirtyCwd: string | null = null;
if (!maria) {
  // 模拟「原工作目录有 config.yml remote 配置」：先切进去，再由下面的隔离逻辑
  // 切到临时目录。隔离失效时 detectDialect() 会读到这份配置，SQLite 断言随即失败。
  dirtyCwd = mkdtempSync(path.join(tmpdir(), "feedback-verify-dirty-"));
  writeFileSync(path.join(dirtyCwd, "config.yml"), [
    "database:",
    "  mode: remote",
    "  remote:",
    "    host: 127.0.0.1",
    "    port: 1",
    "    database: must-not-touch",
    "    user: nobody",
    "    password: none",
  ].join("\n"), "utf8");
  process.chdir(dirtyCwd);
  const { readDbConfig } = await import("../src/server/db/config");
  assert.equal(readDbConfig().mode, "remote", "隔离回归的 config.yml 必须能被解析为 remote");
}
const tmpDir = mkdtempSync(path.join(tmpdir(), "feedback-verify-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "feedback.db");
process.env.PROJECTX_TOKEN_DIR = path.join(tmpDir, "tokens");
// config.yml 按 process.cwd() 解析；必须在导入数据库模块前隔离，
// 否则本机 remote 配置会让回归连上业务库并可能轮换管理员口令。
process.chdir(tmpDir);

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

const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import("../src/server/db/index");
const { getMysqlDb, initMariadbSchema, resetAdapter, detectDialect } = await import("../src/server/db/mysql");
const { authService } = await import("../src/server/services/AuthService");
const { UserRepository } = await import("../src/server/repositories/UserRepository");
const { ROLE_IDS, loadRolePermissions } = await import("../src/server/auth/permissions");
const { databaseTimestamp } = await import("../src/server/db/timestamp");
const feedbackModule = await import("../src/server/routes/feedback");
const feedbackRouter = feedbackModule.default;
const { withTimezone } = feedbackModule;
const express = (await import("express")).default;

async function main(): Promise<void> {
  if (!maria) {
    assert.equal(detectDialect(), "sqlite", "默认回归必须在临时 SQLite 上运行：config.yml remote 配置未被隔离");
    initializeDatabase();
  } else {
    const existing = await getMysqlDb().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()"
    );
    assert.equal(Number(existing?.n ?? 0), 0, "Use a new disposable database");
    await initMariadbSchema();
  }
  const bootstrap = await ensureDefaultAdmin();
  loadRolePermissions(true);
  const db = getMysqlDb();
  const auth = authService;
  const userRepo = new UserRepository();

  const adminRow = await db.get<{ id: number; name: string }>("SELECT id, name FROM users WHERE username = 'admin'");
  assert.ok(adminRow, "默认管理员必须存在");
  const adminPassword = readFileSync(bootstrap.passwordFile, "utf8").trim();
  const adminLogin = await auth.login("admin", adminPassword);
  assert.ok(adminLogin.success && adminLogin.token, "管理员登录失败");
  const adminToken = adminLogin.token!;

  const teacher = await userRepo.createUser({
    username: "fb_teacher",
    password: "teacher-feedback",
    name: "反馈测试教师",
    role_id: ROLE_IDS.TEACHER,
  });
  const teacherLogin = await auth.login("fb_teacher", "teacher-feedback");
  assert.ok(teacherLogin.success && teacherLogin.token, "教师登录失败");
  const teacherToken = teacherLogin.token!;

  section("1. v66 迁移与时区");
  const columns = maria
    ? (await db.all<{ COLUMN_NAME: string }>(
        "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'feedback_reports'"
      )).map((row) => row.COLUMN_NAME)
    : (await db.all<{ name: string }>("PRAGMA table_info(feedback_reports)")).map((row) => row.name);
  for (const column of ["user_id", "title", "content", "context_json", "status", "resolved_at", "resolved_by"]) {
    ok(columns.includes(column), `feedback_reports 含列 ${column}`);
  }
  const version = await db.get<{ version: number }>("SELECT version FROM schema_migrations WHERE version = 66");
  ok(Number(version?.version) === 66, "迁移版本 66 已登记");
  const mariaTime = withTimezone("2026-10-27 03:00:00", "mariadb");
  ok(Boolean(mariaTime && /[+-]\d{2}:\d{2}$/.test(mariaTime)), "MariaDB 本地时间补上服务器时区偏移");
  ok(Boolean(mariaTime && new Date(mariaTime).getTime() === new Date("2026-10-27T03:00:00").getTime()),
    "补偏移后仍表示同一服务器时刻");
  ok(withTimezone("2026-10-27 03:00:00", "sqlite") === "2026-10-27T03:00:00Z", "SQLite 无时区值按 UTC 解释");
  ok(withTimezone("2026-10-27T03:00:00.000Z", "sqlite") === "2026-10-27T03:00:00.000Z", "已有 Z 的值保持不变");

  // 旧库升级：删表并撤销版本记录后重新执行迁移，表应被补回且重复执行幂等。
  await db.run("DELETE FROM schema_migrations WHERE version = 66");
  await db.run("DROP TABLE feedback_reports");
  if (maria) {
    await initMariadbSchema();
    await initMariadbSchema();
  } else {
    const { runMigrations } = await import("../src/server/db/migrations");
    runMigrations(getDatabase());
    runMigrations(getDatabase());
  }
  if (maria) {
    const restored = await db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'feedback_reports'"
    );
    ok(Number(restored?.c) === 1, "MariaDB 旧库补表后可重复初始化");
  } else {
    const table = getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback_reports'").get();
    ok(Boolean(table), "SQLite 旧库补表成功且重复执行幂等");
  }

  section("2. 认证与权限");
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/feedback", feedbackRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/feedback`;

  async function call(method: string, suffix: string, token?: string, body?: unknown) {
    const response = await fetch(base + suffix, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await response.json(); } catch { /* empty */ }
    return { status: response.status, json };
  }

  ok((await call("GET", "")).status === 401, "未登录读取反馈返回 401");
  ok((await call("POST", "", undefined, { title: "x", content: "y" })).status === 401, "未登录提交反馈返回 401");
  ok((await call("GET", "", teacherToken)).status === 403, "教师读取反馈返回 403");
  ok((await call("POST", "", teacherToken, { title: "x", content: "y" })).status === 403, "教师提交反馈返回 403");

  section("3. 提交校验");
  ok((await call("POST", "", adminToken, { title: "  ", content: "正文" })).status === 400, "空标题被拒绝");
  ok((await call("POST", "", adminToken, { title: "标题", content: "  " })).status === 400, "空正文被拒绝");
  ok((await call("POST", "", adminToken, { title: "x".repeat(101), content: "正文" })).status === 400, "标题超长被拒绝");
  ok((await call("POST", "", adminToken, { title: "标题", content: "x".repeat(5001) })).status === 400, "正文超长被拒绝");
  ok((await call("POST", "", adminToken, { title: "标题", content: "正文", category: "bug" })).status === 400, "非法类型被拒绝");
  ok((await call("POST", "", adminToken, { title: "标题", content: "正文", contact: "x".repeat(101) })).status === 400, "联系方式超长被拒绝");

  section("4. 提交、列表与环境信息");
  const submitted = await call("POST", "", adminToken, {
    title: "\u0000导入 PDF 后第 2 页错位\u0007",
    content: "操作步骤：\n1. 导入\n2. 预览\n\n实际现象：错位\n期望结果：对齐",
    contact: "  scan-room@example.com  ",
    context: {
      page: "/global-settings",
      appVersion: "2.7.1",
      long: "x".repeat(1000),
      "bad-key": "应被丢弃",
      nested: { a: 1 },
      architecture: "ia32",
    },
  });
  ok(submitted.status === 201 && Number(submitted.json?.data?.id) > 0, "管理员可提交反馈");
  const reportId = Number(submitted.json.data.id);

  const listed = await call("GET", "", adminToken);
  ok(listed.status === 200 && listed.json?.data?.length === 1, "管理员可读取反馈列表");
  ok(listed.json?.counts?.total === 1 && listed.json?.counts?.open === 1, "计数为 1 条待处理");
  const report = listed.json?.data?.[0];
  ok(report?.title === "导入 PDF 后第 2 页错位", "标题的控制字符被清理");
  ok(report?.contact === "scan-room@example.com", "联系方式首尾空白被清理");
  ok(report?.category === "problem", "未传类型时默认 problem");
  ok(report?.status === "open", "新反馈状态为 open");
  ok(/(?:Z|[+-]\d{2}:\d{2})$/.test(report?.createdAt ?? ""), "创建时间带时区返回");
  ok(report?.username === "admin" && report?.displayName === adminRow!.name, "提交人账号与姓名快照正确");
  ok(report?.context?.client?.long?.length === 500, "客户端超长字段被截断到 500");
  ok(report?.context?.client?.["bad-key"] === undefined, "非法键名被丢弃");
  ok(report?.context?.client?.nested === undefined, "嵌套对象被丢弃");
  ok(report?.context?.client?.architecture === "ia32", "合法客户端字段保留");
  ok(typeof report?.context?.server?.platform === "string" && typeof report?.context?.server?.node === "string", "服务端环境信息已合并");
  ok(report?.context?.server?.database === (maria ? "mariadb" : "sqlite"), "数据库方言记录正确");

  const openOnly = await call("GET", "?status=open", adminToken);
  const resolvedOnly = await call("GET", "?status=resolved", adminToken);
  ok(openOnly.json?.data?.length === 1, "待处理筛选返回 1 条");
  ok(resolvedOnly.json?.data?.length === 0, "已处理筛选返回 0 条");

  section("5. 状态流转与删除");
  ok((await call("PATCH", `/${reportId}`, adminToken, { status: "done" })).status === 400, "非法状态被拒绝");
  ok((await call("PATCH", "/999999", adminToken, { status: "resolved" })).status === 404, "不存在的反馈返回 404");
  ok((await call("PATCH", `/${reportId}`, teacherToken, { status: "resolved" })).status === 403, "教师不能修改反馈状态");
  ok((await call("PATCH", `/${reportId}`, adminToken, { status: "resolved" })).status === 200, "管理员可标记已处理");

  const resolvedList = await call("GET", "", adminToken);
  const resolvedReport = resolvedList.json?.data?.[0];
  ok(resolvedReport?.status === "resolved", "状态已变为 resolved");
  ok(Boolean(resolvedReport?.resolvedAt), "resolved_at 已写入");
  ok(/(?:Z|[+-]\d{2}:\d{2})$/.test(resolvedReport?.resolvedAt ?? ""), "处理时间带时区返回");
  ok(resolvedReport?.resolvedByName === adminRow!.name, "resolved_by 指向处理人");
  ok(resolvedList.json?.counts?.open === 0, "计数中待处理归零");

  ok((await call("PATCH", `/${reportId}`, adminToken, { status: "open" })).status === 200, "管理员可重新打开");
  const reopened = (await call("GET", "", adminToken)).json?.data?.[0];
  ok(reopened?.status === "open" && reopened?.resolvedAt === null && reopened?.resolvedByName === null, "重新打开清空处理信息");

  ok((await call("DELETE", `/${reportId}`, teacherToken)).status === 403, "教师不能删除反馈");
  ok((await call("DELETE", "/999999", adminToken)).status === 404, "删除不存在的反馈返回 404");
  ok((await call("DELETE", `/${reportId}`, adminToken)).status === 200, "管理员可删除反馈");
  ok((await call("GET", "", adminToken)).json?.data?.length === 0, "删除后列表为空");

  const removedUser = await call("POST", "", adminToken, { title: "用户删除后保留反馈", content: "正文", category: "suggestion" });
  ok(removedUser.status === 201, "可提交建议类型反馈");
  const stillThere = (await call("GET", "", adminToken)).json?.data?.[0];
  ok(stillThere?.category === "suggestion", "建议类型按提交值保存");

  await call("POST", "", adminToken, { title: "分页测试", content: "正文" });
  const firstPage = await call("GET", "?limit=1&offset=0", adminToken);
  ok(firstPage.json?.data?.length === 1 && firstPage.json?.hasMore === true, "limit/offset 第一页带 hasMore");
  const secondPage = await call("GET", "?limit=1&offset=1", adminToken);
  ok(secondPage.json?.data?.length === 1 && secondPage.json?.hasMore === false, "第二页可取到剩余反馈");
  const clamped = await call("GET", "?limit=999&offset=-5", adminToken);
  ok(clamped.json?.data?.length === 2 && clamped.json?.hasMore === false, "limit 上限与负 offset 被收敛");

  // 直接插入一条教师提交的记录，再删账号：正文与账号快照应保留，user_id 置空。
  const now = databaseTimestamp();
  const snapshotId = (await db.run(
    `INSERT INTO feedback_reports
       (user_id, username, display_name, role_name, category, title, content, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', ?, ?, 'open', ?, ?)`,
    teacher.id, "fb_teacher", "反馈测试教师", "teacher", "删除用户后的快照", "正文", now, now
  )).lastInsertRowid;
  await db.run("DELETE FROM users WHERE id = ?", teacher.id);
  const snapshot = await db.get<{ user_id: number | null; username: string; display_name: string }>(
    "SELECT user_id, username, display_name FROM feedback_reports WHERE id = ?",
    snapshotId
  );
  ok(snapshot?.user_id == null && snapshot?.username === "fb_teacher" && snapshot?.display_name === "反馈测试教师",
    "删除提交人账号后保留正文与账号快照");

  server.close();
}

try {
  await main();
} catch (error) {
  failed++;
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
} finally {
  try { closeDatabase(); } catch { /* ignore */ }
  try { resetAdapter(); } catch { /* ignore */ }
  try { process.chdir(originalCwd); } catch { /* ignore */ }
  for (const dir of [tmpDir, dirtyCwd]) {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
  console.error("失败项：\n- " + failures.join("\n- "));
  process.exit(1);
}
