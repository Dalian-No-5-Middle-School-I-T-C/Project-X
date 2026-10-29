/**
 * 问题反馈（#357）端到端验证
 * ----------------------------------------------------------------
 * 运行方式：
 *   npm run verify:feedback             # 临时 SQLite
 *   npm run verify:feedback:mariadb     # 专用空 MariaDB（PROJECTX_MARIADB_DATABASE）
 *
 * 覆盖：
 *   1. v66 / v67 迁移建表、旧库补表与重复执行
 *   2. 提交 / 列表 / 状态流转 / 删除的权限边界
 *   3. 标题、正文、联系方式长度与控制字符
 *   4. 客户端环境信息白名单与服务端环境信息合并
 *   5. 标记处理后 resolved_at / resolved_by 的写入与撤销
 *   6. 附件 multipart 上传、下载权限、15 / 16 个上限与删除清理
 *   7. chunked 分块预留、慢速并发、断连临时文件清理、在途临时文件不被滞留清理删除
 *   8. 教师提交、自己的反馈 / 附件与越权拒绝
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { PassThrough } from "node:stream";
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
process.env.ANSWER_CARD_DATA_DIR = path.join(tmpDir, "answer-card");
// 聚合容量测试：1 MiB 足以覆盖小附件，又能在不写大盘的情况下触发上限。
process.env.PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB = "1";
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
const feedbackStorage = await import("../src/server/lib/feedbackStorage");
const { purgeStaleTmpUploads } = await import("../src/apps/answer-card/server/paperQuota");
const backupModule = await import("../src/server/routes/backup");
const backupRouter = backupModule.default;
const { extractZipWithinBudget, extractZipFileWithinBudget } = await import("../src/server/services/restoreZip");
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

  section("1. v66 / v67 迁移与时区");
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
  const attachmentColumns = maria
    ? (await db.all<{ COLUMN_NAME: string }>(
        "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'feedback_attachments'"
      )).map((row) => row.COLUMN_NAME)
    : (await db.all<{ name: string }>("PRAGMA table_info(feedback_attachments)")).map((row) => row.name);
  for (const column of ["feedback_id", "filename", "stored_path", "mime", "size_bytes"]) {
    ok(attachmentColumns.includes(column), `feedback_attachments 含列 ${column}`);
  }
  const attachmentVersion = await db.get<{ version: number }>("SELECT version FROM schema_migrations WHERE version = 67");
  ok(Number(attachmentVersion?.version) === 67, "迁移版本 67 已登记");
  const mariaTime = withTimezone("2026-10-27 03:00:00", "mariadb");
  ok(Boolean(mariaTime && /[+-]\d{2}:\d{2}$/.test(mariaTime)), "MariaDB 本地时间补上服务器时区偏移");
  ok(Boolean(mariaTime && new Date(mariaTime).getTime() === new Date("2026-10-27T03:00:00").getTime()),
    "补偏移后仍表示同一服务器时刻");
  ok(withTimezone("2026-10-27 03:00:00", "sqlite") === "2026-10-27T03:00:00Z", "SQLite 无时区值按 UTC 解释");
  ok(withTimezone("2026-10-27T03:00:00.000Z", "sqlite") === "2026-10-27T03:00:00.000Z", "已有 Z 的值保持不变");

  // 旧库升级：删表并撤销版本记录后重新执行迁移，表应被补回且重复执行幂等。
  await db.run("DELETE FROM schema_migrations WHERE version IN (66, 67)");
  await db.run("DROP TABLE feedback_attachments");
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
      "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('feedback_reports', 'feedback_attachments')"
    );
    ok(Number(restored?.c) === 2, "MariaDB 旧库补表后可重复初始化");
  } else {
    const tables = getDatabase().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('feedback_reports', 'feedback_attachments')"
    ).all() as Array<{ name: string }>;
    ok(tables.length === 2, "SQLite 旧库补表成功且重复执行幂等");
  }

  section("2. 认证与权限");
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/feedback", feedbackRouter);
  if (!maria) app.use("/api/db", backupRouter);
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

  async function upload(form: FormData, token?: string) {
    const response = await fetch(base, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form,
    });
    let json: any = null;
    try { json = await response.json(); } catch { /* empty */ }
    return { status: response.status, json };
  }

  /** 无 Content-Length 的 chunked multipart（模拟流式客户端）。 */
  function chunkedUpload(token: string, boundary: string, body: Buffer): Promise<{ status: number; json: any; error?: string }> {
    return new Promise((resolve) => {
      const url = new URL(base);
      const request = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
      }, (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { raw += chunk; });
        response.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(raw); } catch { /* empty */ }
          resolve({ status: response.statusCode ?? 0, json });
        });
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        resolve({ status: 0, json: null, error: error.code ?? "ERROR" });
      });
      request.write(body);
      request.end();
    });
  }

  /** 可暂停的 chunked multipart：先写一段正文，等并发请求跑完再补完。 */
  function openChunkedUpload(token: string, boundary: string) {
    let settle!: (result: { status: number; json: any; error?: string }) => void;
    const done = new Promise<{ status: number; json: any; error?: string }>((resolve) => { settle = resolve; });
    const url = new URL(base);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(raw); } catch { /* empty */ }
        settle({ status: response.statusCode ?? 0, json });
      });
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      settle({ status: 0, json: null, error: error.code ?? "ERROR" });
    });
    return { request, done };
  }

  /** 声明了 Content-Length 但可以慢慢发的 multipart（模拟只声明、不急着发文件的客户端）。 */
  function openDeclaredUpload(token: string, boundary: string, contentLength: number) {
    let settle!: (result: { status: number; json: any; error?: string }) => void;
    const done = new Promise<{ status: number; json: any; error?: string }>((resolve) => { settle = resolve; });
    const url = new URL(base);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(contentLength),
      },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(raw); } catch { /* empty */ }
        settle({ status: response.statusCode ?? 0, json });
      });
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      settle({ status: 0, json: null, error: error.code ?? "ERROR" });
    });
    return { request, done };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return predicate();
  }

  /** 已落盘的反馈附件字节数（不含 _tmp 暂存）。 */
  function feedbackDiskBytes(dir: string): number {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "_tmp") total += feedbackDiskBytes(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    }
    return total;
  }

  ok((await call("GET", "")).status === 401, "未登录读取反馈返回 401");
  ok((await call("POST", "", undefined, { title: "x", content: "y" })).status === 401, "未登录提交反馈返回 401");
  ok((await call("GET", "", teacherToken)).status === 403, "教师读取全部反馈返回 403");
  ok((await call("GET", "/mine", teacherToken)).status === 200, "教师可读取自己的反馈列表");

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
  const firstPage = await call("GET", "?limit=1", adminToken);
  ok(firstPage.json?.data?.length === 1 && firstPage.json?.hasMore === true && Number(firstPage.json?.nextCursor) > 0,
    "游标第一页返回 nextCursor");
  const cursor = Number(firstPage.json?.nextCursor);

  await call("POST", "", adminToken, { title: "分页新增", content: "正文" });
  const secondPage = await call("GET", `?limit=1&cursor=${cursor}`, adminToken);
  ok(secondPage.json?.data?.length === 1 && secondPage.json?.hasMore === false && secondPage.json?.nextCursor === null,
    "游标第二页取到剩余反馈");
  ok(secondPage.json?.data?.[0]?.title !== "分页新增", "分页期间新增不会挤掉后续页");
  const all = await call("GET", "?limit=999", adminToken);
  ok(all.json?.data?.length === 3 && new Set(all.json?.data?.map((row: { id: number }) => row.id)).size === 3,
    "limit 上限收敛且无重复");
  ok((await call("GET", "?cursor=abc", adminToken)).status === 400, "非法游标被拒绝");

  section("6. 附件上传、下载与删除清理");
  const attachmentForm = new FormData();
  attachmentForm.set("title", "附件测试");
  attachmentForm.set("content", "带附件正文");
  attachmentForm.set("category", "problem");
  attachmentForm.set("context", JSON.stringify({ page: "/global-settings" }));
  attachmentForm.append("files", new Blob(["hello"], { type: "text/plain" }), "说明.txt");
  attachmentForm.append("files", new Blob(["world"], { type: "application/octet-stream" }), "log.bin");
  const attached = await upload(attachmentForm, adminToken);
  ok(attached.status === 201, "管理员可带附件提交");
  const attachReportId = Number(attached.json?.data?.id);

  const attachReport = (await call("GET", "?limit=1", adminToken)).json?.data?.[0];
  ok(attachReport?.id === attachReportId && attachReport?.attachments?.length === 2, "列表返回附件元数据");
  const firstAttachment = attachReport?.attachments?.[0];
  ok(firstAttachment?.filename === "说明.txt" && Number(firstAttachment?.sizeBytes) === 5, "附件文件名与大小正确");

  const download = await fetch(`${base}/${attachReportId}/attachments/${firstAttachment?.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  ok(download.status === 200 && (await download.text()) === "hello", "管理员可下载附件");
  ok((await fetch(`${base}/${attachReportId}/attachments/${firstAttachment?.id}`, {
    headers: { Authorization: `Bearer ${teacherToken}` },
  })).status === 403, "教师不能下载附件");
  ok((await fetch(`${base}/${attachReportId}/attachments/${firstAttachment?.id}`)).status === 401, "未登录不能下载附件");

  ok((await call("DELETE", `/${attachReportId}`, adminToken)).status === 200, "删除带附件的反馈");
  ok((await fetch(`${base}/${attachReportId}/attachments/${firstAttachment?.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).status === 404, "删除后附件不可下载");
  const feedbackRoot = path.join(process.env.ANSWER_CARD_DATA_DIR!, "feedback");
  const tempDir = path.join(feedbackRoot, "_tmp");
  const trashDir = path.join(feedbackRoot, "_trash");
  const leftDirs = existsSync(feedbackRoot)
    ? readdirSync(feedbackRoot, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && entry.name !== "_tmp" && entry.name !== "_trash"
      )
    : [];
  ok(leftDirs.length === 0, "删除反馈后附件目录已清理");
  ok(!existsSync(trashDir) || readdirSync(trashDir).length === 0, "删除后暂存目录为空");

  section("6.1 chunked 分块预留与断连清理");
  const quotaRoot = path.join(tmpDir, "quota-unit");
  const quotaTmp = path.join(quotaRoot, "_tmp");
  mkdirSync(quotaTmp, { recursive: true });
  const step = feedbackStorage.chunkedReservationStep();
  ok(step > 0 && step < feedbackStorage.MAX_FEEDBACK_STORAGE_BYTES, "chunked 预留步长小于总配额");
  const unitReservation = feedbackStorage.createFeedbackStorageReservation(quotaRoot, quotaTmp, 10 * 1024 * 1024);
  ok(unitReservation.bytes === 0, "新请求初始不占附件配额");
  await unitReservation.ensureBytes(step);
  ok(unitReservation.bytes === step, "首个文件字节到达后才开始预留");
  await unitReservation.ensureBytes(step * 2);
  ok(unitReservation.bytes === step * 2, "可按累计目标追加预留");
  unitReservation.release();

  const purgeDir = path.join(tmpDir, "purge-unit");
  mkdirSync(purgeDir, { recursive: true });
  const staleTempPath = path.join(purgeDir, "stale.bin");
  writeFileSync(staleTempPath, "stale");
  const staleTime = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(staleTempPath, staleTime, staleTime);
  feedbackStorage.markActiveFeedbackTempFile(staleTempPath);
  const keptStale = await purgeStaleTmpUploads(purgeDir, 60 * 60_000, feedbackStorage.activeFeedbackTempFiles());
  ok(keptStale === 0 && existsSync(staleTempPath), "过期清理跳过活跃上传的临时文件");
  feedbackStorage.unmarkActiveFeedbackTempFile(staleTempPath);
  const removedStale = await purgeStaleTmpUploads(purgeDir, 60 * 60_000, feedbackStorage.activeFeedbackTempFiles());
  ok(removedStale === 1 && !existsSync(staleTempPath), "非活跃的过期临时文件正常清理");

  // 慢速 chunked 在途时，声明长度的上传仍应被准入（旧实现会把剩余配额整块占走）。
  const slowBoundary = `----fbslow${Date.now()}`;
  const slow = openChunkedUpload(adminToken, slowBoundary);
  slow.request.write([
    `--${slowBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n慢速 chunked\r\n`,
    `--${slowBoundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n正文\r\n`,
    `--${slowBoundary}\r\nContent-Disposition: form-data; name="files"; filename="slow.txt"\r\nContent-Type: text/plain\r\n\r\n`,
  ].join(""), "utf8");
  slow.request.write(Buffer.alloc(20 * 1024, 0x61));
  // 等临时文件真正落盘，确认慢速请求已建立预留后再发起并发上传。
  ok(await waitFor(() => existsSync(tempDir) && readdirSync(tempDir).length > 0), "慢速 chunked 已开始写入临时文件");

  const declaredForm = new FormData();
  declaredForm.set("title", "并发声明长度");
  declaredForm.set("content", "正文");
  declaredForm.append("files", new Blob([new Uint8Array(600 * 1024)]), "declared.bin");
  const declaredRes = await upload(declaredForm, adminToken);
  ok(declaredRes.status === 201, "慢速 chunked 只占一步预留，并发上传不被饿死");

  slow.request.end(`\r\n--${slowBoundary}--\r\n`);
  const slowRes = await slow.done;
  ok(slowRes.status === 201, "慢速 chunked 上传完成");
  ok((await call("DELETE", `/${Number(declaredRes.json?.data?.id)}`, adminToken)).status === 200, "清理并发测试反馈");
  ok((await call("DELETE", `/${Number(slowRes.json?.data?.id)}`, adminToken)).status === 200, "清理慢速测试反馈");

  // 声明了 Content-Length、但还没发文件数据的请求：只占一步预留，不能锁死剩余配额。
  const slowDeclaredBoundary = `----fbdslow${Date.now()}`;
  const slowDeclaredHead = [
    `--${slowDeclaredBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n慢速声明长度\r\n`,
    `--${slowDeclaredBoundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n正文\r\n`,
    `--${slowDeclaredBoundary}\r\nContent-Disposition: form-data; name="files"; filename="slow-declared.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ].join("");
  const slowDeclaredTotal = Buffer.byteLength(slowDeclaredHead) + 800 * 1024 + 64;
  const slowDeclared = openDeclaredUpload(adminToken, slowDeclaredBoundary, slowDeclaredTotal);
  slowDeclared.request.write(slowDeclaredHead);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const declaredConcurrentForm = new FormData();
  declaredConcurrentForm.set("title", "声明长度并发");
  declaredConcurrentForm.set("content", "正文");
  declaredConcurrentForm.append("files", new Blob([new Uint8Array(600 * 1024)]), "declared-concurrent.bin");
  const declaredConcurrent = await upload(declaredConcurrentForm, adminToken);
  ok(declaredConcurrent.status === 201, "慢速声明长度请求只占一步，不锁死剩余配额");

  slowDeclared.request.destroy();
  ok(await waitFor(() => !existsSync(tempDir) || readdirSync(tempDir).length === 0), "销毁慢速声明长度请求后临时文件已清理");
  // 断连兜底最多等 1 秒才释放预留；给后续容量用例留出余量。
  await new Promise((resolve) => setTimeout(resolve, 1200));
  ok((await call("DELETE", `/${Number(declaredConcurrent.json?.data?.id)}`, adminToken)).status === 200, "清理声明长度并发测试反馈");

  // 超过一步的 chunked 上传会继续追加预留。
  const growBoundary = `----fbgrow${Date.now()}`;
  const growBody = Buffer.concat([
    Buffer.from([
      `--${growBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nchunked 追加预留\r\n`,
      `--${growBoundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n正文\r\n`,
      `--${growBoundary}\r\nContent-Disposition: form-data; name="files"; filename="grow.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ].join(""), "utf8"),
    Buffer.alloc(300 * 1024, 0x62),
    Buffer.from(`\r\n--${growBoundary}--\r\n`, "utf8"),
  ]);
  const grown = await chunkedUpload(adminToken, growBoundary, growBody);
  ok(grown.status === 201, "chunked 超过一步时按进度追加预留");
  ok((await call("DELETE", `/${Number(grown.json?.data?.id)}`, adminToken)).status === 200, "清理追加预留测试反馈");

  // 多附件 chunked 中途断开：前序已完成的 part 也要清理，预留随后释放。
  const abortBoundary = `----fbabort${Date.now()}`;
  const aborted = openChunkedUpload(adminToken, abortBoundary);
  aborted.request.write([
    `--${abortBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n断连测试\r\n`,
    `--${abortBoundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n正文\r\n`,
    `--${abortBoundary}\r\nContent-Disposition: form-data; name="files"; filename="done.txt"\r\nContent-Type: text/plain\r\n\r\ndone\r\n`,
    `--${abortBoundary}\r\nContent-Disposition: form-data; name="files"; filename="pending.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ].join(""), "utf8");
  aborted.request.write(Buffer.alloc(10 * 1024, 0x63));
  await new Promise((resolve) => setTimeout(resolve, 300));
  aborted.request.destroy();
  ok(await waitFor(() => !existsSync(tempDir) || readdirSync(tempDir).length === 0), "断连后已完成的临时 part 也被清理");

  const afterAbortForm = new FormData();
  afterAbortForm.set("title", "断连后继续上传");
  afterAbortForm.set("content", "正文");
  afterAbortForm.append("files", new Blob([new Uint8Array(700 * 1024)]), "after-abort.bin");
  const afterAbort = await upload(afterAbortForm, adminToken);
  ok(afterAbort.status === 201, "断连后预留已释放，后续上传不受影响");
  ok((await call("DELETE", `/${Number(afterAbort.json?.data?.id)}`, adminToken)).status === 200, "清理断连测试反馈");

  // 直接调用 purge 只能证明「传入 skip 集合会跳过」。这里走真实上传：
  // 在途文件的 mtime 超过 1 小时后，另一个请求会触发清理；文件必须还在，提交后的内容也必须完整。
  // 超过 10 分钟的在途文件仍由本请求预留覆盖，准入不能再按占盘加一次。
  const holdBoundary = `----fbhold${Date.now()}`;
  const holdPayload = Buffer.alloc(400 * 1024, 0x71);
  const hold = openChunkedUpload(adminToken, holdBoundary);
  const createdIds: number[] = [];
  let holdEnded = false;
  try {
    hold.request.write([
      `--${holdBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n在途清理保护\r\n`,
      `--${holdBoundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n正文\r\n`,
      `--${holdBoundary}\r\nContent-Disposition: form-data; name="files"; filename="hold.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ].join(""), "utf8");
    if (!hold.request.write(holdPayload)) {
      await new Promise((resolve) => hold.request.once("drain", resolve));
    }
    const holdReady = await waitFor(() => existsSync(tempDir) && readdirSync(tempDir).some((name) => {
      try { return statSync(path.join(tempDir, name)).size >= holdPayload.length; } catch { return false; }
    }));
    ok(holdReady, "在途附件已写完待提交");
    const holdName = readdirSync(tempDir).find((name) => {
      try { return statSync(path.join(tempDir, name)).size >= holdPayload.length; } catch { return false; }
    });
    const holdPath = holdName ? path.join(tempDir, holdName) : "";
    const ageUntilStable = async (when: Date): Promise<boolean> => {
      if (!holdPath) return false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        utimesSync(holdPath, when, when);
        await new Promise((resolve) => setTimeout(resolve, 40));
        try {
          if (Math.abs(statSync(holdPath).mtimeMs - when.getTime()) < 2000) return true;
        } catch { return false; }
      }
      return false;
    };
    ok(await ageUntilStable(new Date(Date.now() - 11 * 60_000)), "在途临时文件可拨到 10 分钟宽限期之外");

    const duringGrace = new FormData();
    duringGrace.set("title", "宽限期内的并发");
    duringGrace.set("content", "正文");
    duringGrace.append("files", new Blob([new Uint8Array(200 * 1024)]), "during-grace.bin");
    const duringGraceRes = await upload(duringGrace, adminToken);
    if (duringGraceRes.status === 201) createdIds.push(Number(duringGraceRes.json?.data?.id));
    ok(duringGraceRes.status === 201, "在途附件超过 10 分钟仍只按预留计一次，并发上传不会被重复核算拒绝");

    ok(await ageUntilStable(new Date(Date.now() - 2 * 60 * 60 * 1000)), "在途临时文件可拨到清理存活期之外");
    const duringPurge = new FormData();
    duringPurge.set("title", "触发滞留清理");
    duringPurge.set("content", "正文");
    duringPurge.append("files", new Blob(["probe"], { type: "text/plain" }), "probe.txt");
    const duringPurgeRes = await upload(duringPurge, adminToken);
    if (duringPurgeRes.status === 201) createdIds.push(Number(duringPurgeRes.json?.data?.id));
    ok(duringPurgeRes.status === 201 && Boolean(holdPath) && existsSync(holdPath),
      "其他上传触发的滞留清理不会删除仍在上传的临时文件");

    hold.request.end(`\r\n--${holdBoundary}--\r\n`);
    holdEnded = true;
    const holdRes = await hold.done;
    if (holdRes.status === 201) createdIds.push(Number(holdRes.json?.data?.id));
    ok(holdRes.status === 201, "超过清理存活期的在途附件仍能提交");
    const holdId = Number(holdRes.json?.data?.id);
    const holdReport = (await call("GET", "?limit=20", adminToken)).json?.data?.find((row: { id: number }) => row.id === holdId);
    const holdAttachment = holdReport?.attachments?.[0];
    const holdDownload = await fetch(`${base}/${holdId}/attachments/${holdAttachment?.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const holdBytes = Buffer.from(await holdDownload.arrayBuffer());
    ok(holdDownload.status === 200 && holdBytes.equals(holdPayload), "在途附件内容完整，没有因为临时文件被删而丢失");

    const staleOrphan = path.join(tempDir, "stale-unregistered.bin");
    writeFileSync(staleOrphan, Buffer.alloc(1024));
    const purgeAge = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleOrphan, purgeAge, purgeAge);
    const purgeTrigger = new FormData();
    purgeTrigger.set("title", "清理真正的孤儿");
    purgeTrigger.set("content", "正文");
    const purgeTriggerRes = await upload(purgeTrigger, adminToken);
    if (purgeTriggerRes.status === 201) createdIds.push(Number(purgeTriggerRes.json?.data?.id));
    ok(purgeTriggerRes.status === 201 && !existsSync(staleOrphan), "没有在途登记的过期临时文件仍会被清理");
  } finally {
    if (!holdEnded) {
      hold.request.destroy();
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    for (const id of createdIds) {
      if (!Number.isFinite(id) || id <= 0) continue;
      ok((await call("DELETE", `/${id}`, adminToken)).status === 200, `清理在途保护测试反馈 ${id}`);
    }
  }

  const fifteen = new FormData();
  fifteen.set("title", "15 个附件");
  fifteen.set("content", "正文");
  for (let i = 0; i < 15; i += 1) fifteen.append("files", new Blob([`f${i}`]), `f${i}.txt`);
  const fifteenRes = await upload(fifteen, adminToken);
  ok(fifteenRes.status === 201, "最多 15 个附件可提交");
  const fifteenReport = (await call("GET", "?limit=1", adminToken)).json?.data?.[0];
  ok(fifteenReport?.attachments?.length === 15, "15 个附件全部入库");

  mkdirSync(tempDir, { recursive: true });
  const orphanPath = path.join(tempDir, "orphan.bin");
  writeFileSync(orphanPath, Buffer.alloc(700 * 1024));
  // 准入只把超过 10 分钟的临时件当孤儿；把测试文件时间拨老，模拟进程中断后的残留。
  const oldTime = new Date(Date.now() - 11 * 60_000);
  utimesSync(orphanPath, oldTime, oldTime);
  const orphanForm = new FormData();
  orphanForm.set("title", "孤儿临时文件");
  orphanForm.set("content", "正文");
  orphanForm.append("files", new Blob([new Uint8Array(400 * 1024)]), "c.bin");
  const orphanRes = await upload(orphanForm, adminToken);
  ok(orphanRes.status === 413 && orphanRes.json?.code === "FEEDBACK_STORAGE_QUOTA_EXCEEDED",
    "孤儿临时文件也计入聚合容量");
  rmSync(orphanPath, { force: true });
  ok(await waitFor(() => !existsSync(tempDir) || readdirSync(tempDir).length === 0), "孤儿临时文件清理后不留痕迹");
  await new Promise((resolve) => setTimeout(resolve, 200));

  const sixteen = new FormData();
  sixteen.set("title", "16 个附件");
  sixteen.set("content", "正文");
  for (let i = 0; i < 16; i += 1) sixteen.append("files", new Blob([`f${i}`]), `f${i}.txt`);
  ok((await upload(sixteen, adminToken)).status === 400, "超过 15 个附件被拒绝");
  ok(!existsSync(tempDir) || readdirSync(tempDir).length === 0, "被拒绝的上传没有遗留临时文件");

  const concurrentA = new FormData();
  concurrentA.set("title", "并发附件 A");
  concurrentA.set("content", "正文");
  concurrentA.append("files", new Blob([new Uint8Array(700 * 1024)]), "a.bin");
  const concurrentB = new FormData();
  concurrentB.set("title", "并发附件 B");
  concurrentB.set("content", "正文");
  concurrentB.append("files", new Blob([new Uint8Array(700 * 1024)]), "b.bin");
  const concurrent = await Promise.all([upload(concurrentA, adminToken), upload(concurrentB, adminToken)]);
  const statuses = concurrent.map((result) => result.status).sort((a, b) => a - b);
  ok(statuses[0] === 201 && statuses[1] === 413, "并发上传只放行一个，容量核算串行");
  const quotaRejected = concurrent.find((result) => result.status === 413);
  ok(quotaRejected?.json?.code === "FEEDBACK_STORAGE_QUOTA_EXCEEDED", "容量超限返回明确错误码");
  ok(await waitFor(() => !existsSync(tempDir) || readdirSync(tempDir).length === 0), "并发拒绝后临时文件已清理");
  await new Promise((resolve) => setTimeout(resolve, 200));

  const overQuota = new FormData();
  overQuota.set("title", "超容量附件");
  overQuota.set("content", "正文");
  overQuota.append("files", new Blob([new Uint8Array(1024 * 1024 + 1)]), "big.bin");
  const over = await upload(overQuota, adminToken);
  ok(over.status === 413 && over.json?.code === "FEEDBACK_STORAGE_QUOTA_EXCEEDED", "聚合容量超限被拒绝");
  ok(await waitFor(() => !existsSync(tempDir) || readdirSync(tempDir).length === 0), "容量拒绝后没有遗留临时文件");
  await new Promise((resolve) => setTimeout(resolve, 200));

  // 接近上限、但实际装得下的 chunked 上传：追加预留不能因为「多要一步」而误拒。
  const edgeBoundary = `----fbbedge${Date.now()}`;
  const edgeBody = Buffer.concat([
    Buffer.from([
      `--${edgeBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n边界 chunked\r\n`,
      `--${edgeBoundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n正文\r\n`,
      `--${edgeBoundary}\r\nContent-Disposition: form-data; name="files"; filename="edge.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ].join(""), "utf8"),
    Buffer.alloc(280 * 1024, 0x64),
    Buffer.from(`\r\n--${edgeBoundary}--\r\n`, "utf8"),
  ]);
  const edge = await chunkedUpload(adminToken, edgeBoundary, edgeBody);
  ok(edge.status === 201, "chunked 实际装得下时不会被多余步长误拒");
  ok((await call("DELETE", `/${Number(edge.json?.data?.id)}`, adminToken)).status === 200, "清理边界 chunked 测试反馈");

  const boundary = `----fbtest${Date.now()}`;
  const chunkedBody = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n分块上传测试\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n正文\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="tiny.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n`,
    `--${boundary}--\r\n`,
  ].join(""), "utf8");
  const chunked = await chunkedUpload(adminToken, boundary, chunkedBody);
  ok(chunked.status === 201, "无 Content-Length 的附件上传不被容量预检误拒");

  const bigBoundary = `----fbbig${Date.now()}`;
  const bigHead = Buffer.from([
    `--${bigBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n超大 chunked\r\n`,
    `--${bigBoundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n正文\r\n`,
    `--${bigBoundary}\r\nContent-Disposition: form-data; name="files"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ].join(""), "utf8");
  const bigTail = Buffer.from(`\r\n--${bigBoundary}--\r\n`, "utf8");
  const bigChunked = await chunkedUpload(
    adminToken,
    bigBoundary,
    Buffer.concat([bigHead, Buffer.alloc(400 * 1024), bigTail])
  );
  ok(
    bigChunked.status === 413
      ? bigChunked.json?.code === "FEEDBACK_STORAGE_QUOTA_EXCEEDED"
      : bigChunked.error === "ECONNRESET",
    "chunked 超过剩余容量在流式阶段被拒绝"
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  ok(!existsSync(tempDir) || readdirSync(tempDir).length === 0, "chunked 拒绝后没有遗留临时文件");

  // 附件配额接近上限时，纯文本反馈不占附件配额：整包预留下不去也要能提交。
  const fillForm = new FormData();
  fillForm.set("title", "填满附件容量");
  fillForm.set("content", "正文");
  const fillSize = feedbackStorage.MAX_FEEDBACK_STORAGE_BYTES - feedbackDiskBytes(feedbackRoot) - 2000;
  ok(fillSize > 0, "接近上限的填充大小有效");
  fillForm.append("files", new Blob([new Uint8Array(fillSize)]), "fill.bin");
  const filled = await upload(fillForm, adminToken);
  ok(filled.status === 201, "接近上限的附件仍可提交");

  const textOnlyForm = new FormData();
  textOnlyForm.set("title", "满额纯文本");
  textOnlyForm.set("content", "x".repeat(3000));
  textOnlyForm.set("category", "problem");
  const textOnly = await upload(textOnlyForm, adminToken);
  ok(textOnly.status === 201, "附件配额接近上限时纯文字反馈仍可提交");

  const textBoundary = `----fbtext${Date.now()}`;
  const textChunkedBody = Buffer.from([
    `--${textBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nchunked 纯文本\r\n`,
    `--${textBoundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n${"y".repeat(3000)}\r\n`,
    `--${textBoundary}--\r\n`,
  ].join(""), "utf8");
  const textChunked = await chunkedUpload(adminToken, textBoundary, textChunkedBody);
  ok(textChunked.status === 201, "chunked 纯文字反馈也不占附件配额");

  ok((await call("DELETE", `/${Number(filled.json?.data?.id)}`, adminToken)).status === 200, "清理填满容量反馈");
  ok((await call("DELETE", `/${Number(textOnly.json?.data?.id)}`, adminToken)).status === 200, "清理纯文本反馈");
  ok((await call("DELETE", `/${Number(textChunked.json?.data?.id)}`, adminToken)).status === 200, "清理 chunked 纯文本反馈");

  // 数据库删除失败时，已暂存的附件目录必须移回，不能留下指向空文件的记录。
  const restoreForm = new FormData();
  restoreForm.set("title", "删除失败恢复");
  restoreForm.set("content", "正文");
  restoreForm.append("files", new Blob(["restore-me"], { type: "text/plain" }), "restore.txt");
  const restoreReport = await upload(restoreForm, adminToken);
  ok(restoreReport.status === 201, "准备删除失败恢复测试");
  const restoreId = Number(restoreReport.json?.data?.id);
  const restoreAttachment = (await call("GET", "?limit=1", adminToken)).json?.data?.[0]?.attachments?.[0];

  const adapter = getMysqlDb();
  const adapterRun = (adapter as any).run;
  const originalRun = adapterRun.bind(adapter);
  let injectedDeleteFailure = false;
  (adapter as any).run = async (sql: string, ...args: any[]) => {
    if (!injectedDeleteFailure && /DELETE\s+FROM\s+feedback_reports/i.test(sql)) {
      injectedDeleteFailure = true;
      throw new Error("forced feedback delete failure");
    }
    return originalRun(sql, ...args);
  };
  let failedDelete: { status: number; json: any };
  try {
    failedDelete = await call("DELETE", `/${restoreId}`, adminToken);
  } finally {
    (adapter as any).run = adapterRun;
  }
  ok(failedDelete.status === 500 && failedDelete.json?.code === "FEEDBACK_DELETE_FAILED",
    "数据库删除失败时返回 500");
  const keptReport = (await call("GET", "?limit=1", adminToken)).json?.data?.[0];
  ok(keptReport?.id === restoreId && keptReport?.attachments?.length === 1,
    "数据库删除失败保留反馈与附件元数据");
  const restoredDownload = await fetch(`${base}/${restoreId}/attachments/${restoreAttachment?.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  ok(restoredDownload.status === 200 && (await restoredDownload.text()) === "restore-me",
    "数据库删除失败后附件文件已恢复");
  ok(!existsSync(trashDir) || readdirSync(trashDir).length === 0, "数据库删除失败后暂存目录已清空");
  ok((await call("DELETE", `/${restoreId}`, adminToken)).status === 200, "附件恢复后可再次删除");

  // 全零字节附件的请求不占容量，但同样会创建目录 / 写库；写库失败时必须清掉目录。
  const zeroForm = new FormData();
  zeroForm.set("title", "零字节附件写库失败");
  zeroForm.set("content", "正文");
  zeroForm.append("files", new Blob([], { type: "text/plain" }), "empty.txt");
  const dirsBeforeZero = new Set(
    existsSync(feedbackRoot)
      ? readdirSync(feedbackRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("_")).map((entry) => entry.name)
      : []
  );
  const zeroAdapter = getMysqlDb();
  const zeroTransaction = (zeroAdapter as any).transaction;
  let injectedZeroFailure = false;
  // 上传的入库走 `db.transaction(...)`；MariaDB 的事务对象不是 adapter 本体，
  // 所以直接包住 transaction 方法，两种方言都能命中。
  (zeroAdapter as any).transaction = async (...args: any[]) => {
    if (!injectedZeroFailure) {
      injectedZeroFailure = true;
      throw new Error("forced zero-byte transaction failure");
    }
    return zeroTransaction.apply(zeroAdapter, args);
  };
  let zeroResult: { status: number; json: any };
  try {
    zeroResult = await upload(zeroForm, adminToken);
  } finally {
    (zeroAdapter as any).transaction = zeroTransaction;
  }
  ok(zeroResult.status === 500, "零字节附件写库失败返回 500");
  ok(injectedZeroFailure, "零字节附件失败用例确实注入了写库错误");
  const zeroLeftovers = existsSync(feedbackRoot)
    ? readdirSync(feedbackRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !dirsBeforeZero.has(entry.name))
    : [];
  ok(zeroLeftovers.length === 0, "零字节附件写库失败后没有留下无元数据的附件目录");

  // 目录已经被外部删掉、只剩元数据时，删除反馈必须继续成功。
  const missingForm = new FormData();
  missingForm.set("title", "附件目录丢失");
  missingForm.set("content", "正文");
  missingForm.append("files", new Blob(["gone"], { type: "text/plain" }), "gone.txt");
  const missingReport = await upload(missingForm, adminToken);
  ok(missingReport.status === 201, "准备附件目录丢失测试");
  const missingId = Number(missingReport.json?.data?.id);
  const missingRow = await getMysqlDb().get<{ stored_path: string }>(
    "SELECT stored_path FROM feedback_attachments WHERE feedback_id = ?",
    missingId
  );
  const missingDir = path.dirname(path.resolve(process.env.ANSWER_CARD_DATA_DIR!, missingRow!.stored_path));
  rmSync(missingDir, { recursive: true, force: true });
  const missingDelete = await call("DELETE", `/${missingId}`, adminToken);
  ok(missingDelete.status === 200, "附件目录已丢失时仍可删除反馈");
  ok(!((await call("GET", "?limit=200", adminToken)).json?.data ?? []).some((row: any) => row.id === missingId),
    "目录丢失的反馈已从列表删除");

  // 两个管理员同时删除同一反馈：一方成功，另一方 404/409，不共用 _trash 目录。
  const concurrentForm = new FormData();
  concurrentForm.set("title", "并发删除同一反馈");
  concurrentForm.set("content", "正文");
  concurrentForm.append("files", new Blob(["concurrent"], { type: "text/plain" }), "concurrent.txt");
  const concurrentReport = await upload(concurrentForm, adminToken);
  const concurrentId = Number(concurrentReport.json?.data?.id);
  const [deleteA, deleteB] = await Promise.all([
    call("DELETE", `/${concurrentId}`, adminToken),
    call("DELETE", `/${concurrentId}`, adminToken),
  ]);
  const deleteStatuses = [deleteA.status, deleteB.status].sort((a, b) => a - b);
  ok(deleteStatuses[0] === 200 && (deleteStatuses[1] === 404 || deleteStatuses[1] === 409),
    "并发删除同一反馈只成功一次");
  ok(!((await call("GET", "?limit=200", adminToken)).json?.data ?? []).some((row: any) => row.id === concurrentId),
    "并发删除后反馈已从列表移除");
  ok(!existsSync(trashDir) || readdirSync(trashDir).length === 0, "并发删除后暂存目录为空");

  // 反馈允许上传 .db 附件；系统备份不能按扩展名把它一并跳过。
  if (!maria) {
    const findFiles = (dir: string, predicate: (filePath: string) => boolean): string[] => {
      if (!existsSync(dir)) return [];
      const hits: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) hits.push(...findFiles(full, predicate));
        else if (entry.isFile() && predicate(full)) hits.push(full);
      }
      return hits;
    };
    const dbAttachmentForm = new FormData();
    dbAttachmentForm.set("title", "数据库附件备份");
    dbAttachmentForm.set("content", "正文");
    dbAttachmentForm.append("files", new Blob(["feedback-db-payload"], { type: "application/octet-stream" }), "diagnostics.db");
    const dbAttachmentReport = await upload(dbAttachmentForm, adminToken);
    ok(dbAttachmentReport.status === 201, "准备 .db 附件备份测试");

    // 备份必须在数据库快照与附件目录复制之间独占反馈变更：期间删除 / 提交都要排队。
    const lockVictimForm = new FormData();
    lockVictimForm.set("title", "锁等待删除");
    lockVictimForm.set("content", "正文");
    const lockVictim = await upload(lockVictimForm, adminToken);
    let releaseFeedbackLock!: () => void;
    const feedbackLockHeld = feedbackStorage.withFeedbackMutationLock(
      () => new Promise<void>((resolve) => { releaseFeedbackLock = resolve; })
    );
    let backupSettled = false;
    let deleteSettled = false;
    const blockedBackup = fetch(`${new URL(base).origin}/api/db/backup`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((resp) => { backupSettled = true; return resp; });
    const blockedDelete = call("DELETE", `/${Number(lockVictim.json?.data?.id)}`, adminToken)
      .then((resp) => { deleteSettled = true; return resp; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    ok(!backupSettled && !deleteSettled, "备份与删除等待同一把反馈变更锁，不在快照与附件复制之间穿插");
    releaseFeedbackLock();
    await feedbackLockHeld;
    const backupResponse = await blockedBackup;
    ok((await blockedDelete).status === 200, "锁释放后删除正常完成");
    ok(backupResponse.status === 200, "系统备份接口成功");
    const backupZip = Buffer.from(await backupResponse.arrayBuffer());
    const extractDir = path.join(tmpDir, "backup-extract");
    mkdirSync(extractDir, { recursive: true });
    extractZipWithinBudget(backupZip, extractDir);
    const feedbackDbFiles = findFiles(
      path.join(extractDir, "data", "answer-card", "feedback"),
      (filePath) => filePath.endsWith(".db")
    );
    ok(feedbackDbFiles.some((filePath) => readFileSync(filePath, "utf8") === "feedback-db-payload"),
      "备份包含反馈目录下的 .db 附件");
    const streamingZipPath = path.join(tmpDir, "backup-streaming.zip");
    writeFileSync(streamingZipPath, backupZip);
    const streamingExtractDir = path.join(tmpDir, "backup-streaming-extract");
    await extractZipFileWithinBudget(streamingZipPath, streamingExtractDir);
    const streamedDbFiles = findFiles(
      path.join(streamingExtractDir, "data", "answer-card", "feedback"),
      (filePath) => filePath.endsWith(".db")
    );
    ok(streamedDbFiles.some((filePath) => readFileSync(filePath, "utf8") === "feedback-db-payload"),
      "流式恢复路径完整解出备份中的 .db 附件");
    ok((await call("DELETE", `/${Number(dbAttachmentReport.json?.data?.id)}`, adminToken)).status === 200,
      "清理 .db 附件备份测试");
    const restoreLimits = await import("../src/shared/restoreZipLimits");
    ok(restoreLimits.MAX_RESTORE_ZIP_TOTAL_BYTES >= 6144 * 1024 * 1024 + feedbackStorage.MAX_FEEDBACK_STORAGE_BYTES,
      "恢复累计预算覆盖基础数据 + 当前反馈附件配额");
    ok(backupModule.RESTORE_ZIP_UPLOAD_LIMIT_BYTES >= restoreLimits.MAX_RESTORE_ZIP_TOTAL_BYTES
      && backupModule.RESTORE_ZIP_UPLOAD_LIMIT_BYTES > 128 * 1024 * 1024,
      "恢复上传上限跟随解压预算，合法备份不再被 128MiB 截断");

    // 备份前先收敛 _trash：仍存在的记录移回原位，已删记录的残骸清掉且不进 ZIP。
    const stagedForm = new FormData();
    stagedForm.set("title", "暂存目录收敛备份");
    stagedForm.set("content", "正文");
    stagedForm.append("files", new Blob(["staged-me"], { type: "text/plain" }), "staged.txt");
    const stagedReport = await upload(stagedForm, adminToken);
    ok(stagedReport.status === 201, "准备暂存目录收敛备份测试");
    const stagedId = Number(stagedReport.json?.data?.id);
    const stagedRow = await db.get<{ stored_path: string }>(
      "SELECT stored_path FROM feedback_attachments WHERE feedback_id = ?",
      stagedId
    );
    const stagedDir = path.dirname(path.resolve(process.env.ANSWER_CARD_DATA_DIR!, stagedRow!.stored_path));
    mkdirSync(trashDir, { recursive: true });
    renameSync(stagedDir, path.join(trashDir, path.basename(stagedDir)));
    const residueDir = path.join(trashDir, "residue-without-row");
    mkdirSync(residueDir, { recursive: true });
    writeFileSync(path.join(residueDir, "0.txt"), "residue");
    mkdirSync(path.join(feedbackRoot, "_tmp"), { recursive: true });
    const halfUpload = path.join(feedbackRoot, "_tmp", "half-upload.bin");
    writeFileSync(halfUpload, "half");

    const trashBackup = await fetch(`${new URL(base).origin}/api/db/backup`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    ok(trashBackup.status === 200, "暂存目录存在时备份接口仍成功");
    const trashZip = Buffer.from(await trashBackup.arrayBuffer());
    const trashExtractDir = path.join(tmpDir, "backup-trash-extract");
    mkdirSync(trashExtractDir, { recursive: true });
    extractZipWithinBudget(trashZip, trashExtractDir);
    const extractedFeedback = path.join(trashExtractDir, "data", "answer-card", "feedback");
    const stagedCopied = path.join(extractedFeedback, path.basename(stagedDir), "0.txt");
    ok(existsSync(stagedDir), "仍存在的暂存附件在备份前移回原位");
    ok(existsSync(stagedCopied) && readFileSync(stagedCopied, "utf8") === "staged-me",
      "备份包含移回原位的暂存附件");
    ok(!existsSync(path.join(extractedFeedback, "_trash")) && !existsSync(path.join(extractedFeedback, "_tmp")),
      "备份不包含 _tmp / _trash");
    ok(!existsSync(residueDir), "没有记录的 _trash 残骸在备份前被清掉");
    rmSync(halfUpload, { force: true });
    ok((await call("DELETE", `/${stagedId}`, adminToken)).status === 200, "清理暂存目录备份测试");

    // 恢复发现仍有在传附件时直接 409，且不能把已解压的备份留在临时目录。
    const { default: AdmZip } = await import("adm-zip");
    const probeZip = new AdmZip();
    probeZip.addFile("metadata.json", Buffer.from(JSON.stringify({
      version: 1, format: "projectx-backup", generatedAt: new Date().toISOString(), files: [],
    })));
    probeZip.addFile("projectx.db", Buffer.from("not-a-real-db"));
    const activeTempPath = path.join(feedbackRoot, "_tmp", "restore-probe.tmp");
    writeFileSync(activeTempPath, "active");
    feedbackStorage.markActiveFeedbackTempFile(activeTempPath);
    const tmpBefore = new Set(readdirSync(tmpdir()));
    let restoreBlocked: any;
    try {
      restoreBlocked = await fetch(`${new URL(base).origin}/api/db/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/zip" },
        body: probeZip.toBuffer(),
      });
    } finally {
      feedbackStorage.unmarkActiveFeedbackTempFile(activeTempPath);
      rmSync(activeTempPath, { force: true });
    }
    ok(restoreBlocked.status === 409, "仍有在传附件时恢复请求被 409 拒绝");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leakedRestoreDirs = readdirSync(tmpdir()).filter((name) =>
      name.startsWith("projectx-restore-") && !name.startsWith("projectx-restore-upload-") && !tmpBefore.has(name)
    );
    ok(leakedRestoreDirs.length === 0, "409 退出后不残留已解压的恢复临时目录");

    // 结构校验失败（缺 projectx.db）的 400 也要清掉解压目录。
    const incompleteZip = new AdmZip();
    incompleteZip.addFile("metadata.json", Buffer.from(JSON.stringify({
      version: 1, format: "projectx-backup", generatedAt: new Date().toISOString(), files: [],
    })));
    const beforeIncomplete = new Set(readdirSync(tmpdir()));
    const rejectedIncomplete = await fetch(`${new URL(base).origin}/api/db/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/zip" },
      body: incompleteZip.toBuffer(),
    });
    ok(rejectedIncomplete.status === 400, "缺少 projectx.db 的备份被 400 拒绝");
    await new Promise((resolve) => setTimeout(resolve, 300));
    ok(readdirSync(tmpdir()).filter((name) =>
      name.startsWith("projectx-restore-") && !name.startsWith("projectx-restore-upload-") && !beforeIncomplete.has(name)
    ).length === 0, "结构校验失败不残留解压目录");

    // 并发恢复：第一个请求还在传包时，第二个直接 409；第一个断开后闸门释放。
    const slowRestore = http.request({
      host: "127.0.0.1",
      port: Number(new URL(base).port),
      path: "/api/db/restore",
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/zip",
        "Content-Length": 4096,
      },
    });
    slowRestore.on("error", () => undefined);
    slowRestore.write(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const concurrentRestore = await fetch(`${new URL(base).origin}/api/db/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/zip" },
      body: probeZip.toBuffer(),
    });
    ok(concurrentRestore.status === 409, "已有恢复任务在传包时，第二个恢复请求返回 409");
    slowRestore.destroy();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterSlowRestore = await fetch(`${new URL(base).origin}/api/db/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/zip" },
      body: Buffer.from("not-a-zip"),
    });
    ok(afterSlowRestore.status === 400, "前一个恢复断开后闸门释放，后续请求正常进入校验");
  }

  // 模拟进程在「已移入 _trash、尚未删库」时退出：后续请求应把目录恢复回原位。
  const crashForm = new FormData();
  crashForm.set("title", "删除中断恢复");
  crashForm.set("content", "正文");
  crashForm.append("files", new Blob(["crash-me"], { type: "text/plain" }), "crash.txt");
  const crashReport = await upload(crashForm, adminToken);
  ok(crashReport.status === 201, "准备删除中断恢复测试");
  const crashId = Number(crashReport.json?.data?.id);
  const crashRow = await getMysqlDb().get<{ stored_path: string }>(
    "SELECT stored_path FROM feedback_attachments WHERE feedback_id = ?",
    crashId
  );
  const crashDir = path.dirname(path.resolve(process.env.ANSWER_CARD_DATA_DIR!, crashRow!.stored_path));
  mkdirSync(trashDir, { recursive: true });
  renameSync(crashDir, path.join(trashDir, path.basename(crashDir)));
  ok(!existsSync(crashDir), "模拟删除中断后附件目录在暂存区");
  const afterCrashList = await call("GET", "?limit=1", adminToken);
  ok(afterCrashList.status === 200 && existsSync(crashDir), "后续请求已恢复暂存附件目录");
  const crashAttachment = afterCrashList.json?.data?.[0]?.attachments?.[0];
  const crashDownload = await fetch(`${base}/${crashId}/attachments/${crashAttachment?.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  ok(crashDownload.status === 200 && (await crashDownload.text()) === "crash-me", "恢复后附件可下载");
  ok(!existsSync(trashDir) || readdirSync(trashDir).length === 0, "恢复后暂存目录为空");
  ok((await call("DELETE", `/${crashId}`, adminToken)).status === 200, "清理删除中断恢复测试");

  const fieldsForm = new FormData();
  fieldsForm.set("title", "字段过多");
  fieldsForm.set("content", "正文");
  for (let i = 0; i < 10; i += 1) fieldsForm.set(`extra${i}`, "x");
  ok((await upload(fieldsForm, adminToken)).status === 400, "multipart 字段数量超限被拒绝");
  const bigFieldForm = new FormData();
  bigFieldForm.set("title", "字段过大");
  bigFieldForm.set("content", "正文");
  bigFieldForm.set("context", "x".repeat(70 * 1024));
  ok((await upload(bigFieldForm, adminToken)).status === 400, "multipart 单字段超限被拒绝");

  section("7. 教师端提交与自己的反馈");
  const teacherForm = new FormData();
  teacherForm.set("title", "教师端反馈");
  teacherForm.set("content", "教师提交正文");
  teacherForm.set("category", "problem");
  teacherForm.append("files", new Blob(["teacher-file"], { type: "text/plain" }), "teacher.txt");
  const teacherSubmitted = await upload(teacherForm, teacherToken);
  ok(teacherSubmitted.status === 201, "教师可提交反馈");
  const teacherReportId = Number(teacherSubmitted.json?.data?.id);

  const mine = await call("GET", "/mine?limit=10", teacherToken);
  ok(mine.status === 200 && mine.json?.data?.some((row: { id: number }) => row.id === teacherReportId),
    "教师可读取自己的反馈");
  const mineReport = mine.json?.data?.find((row: { id: number }) => row.id === teacherReportId);
  ok(mineReport?.attachments?.length === 1, "教师自己的反馈附件可读");
  const teacherAttachment = mineReport?.attachments?.[0];
  const teacherDownload = await fetch(`${base}/${teacherReportId}/attachments/${teacherAttachment?.id}`, {
    headers: { Authorization: `Bearer ${teacherToken}` },
  });
  ok(teacherDownload.status === 200 && (await teacherDownload.text()) === "teacher-file", "教师可下载自己的附件");
  ok((await call("PATCH", `/${teacherReportId}`, teacherToken, { status: "resolved" })).status === 403,
    "教师不能修改反馈状态");
  ok((await call("DELETE", `/${teacherReportId}`, teacherToken)).status === 403, "教师不能删除反馈");

  const adminView = await call("GET", "?limit=10", adminToken);
  ok(adminView.json?.data?.some((row: { id: number }) => row.id === teacherReportId), "管理员能看到教师反馈");
  ok((await fetch(`${base}/${teacherReportId}/attachments/${teacherAttachment?.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).status === 200, "管理员可下载教师附件");
  ok((await call("DELETE", `/${teacherReportId}`, adminToken)).status === 200, "管理员可删除教师反馈");

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

  // 附件临时目录不可用时：纯文字反馈仍能入库，只有真正带附件才返回 503。
  // 用一个指向坏数据目录的新路由实例模拟「启动清扫失败」，不影响上面已用过的实例。
  const brokenRoot = path.join(tmpDir, "broken-data");
  mkdirSync(path.join(brokenRoot, "feedback"), { recursive: true });
  writeFileSync(path.join(brokenRoot, "feedback", "_tmp"), "not-a-directory");
  const previousDataDir = process.env.ANSWER_CARD_DATA_DIR;
  process.env.ANSWER_CARD_DATA_DIR = brokenRoot;
  const brokenRouter = (await import(
    new URL("../src/server/routes/feedback.ts?broken-tmp=1", import.meta.url).href
  )).default;
  const brokenApp = express();
  brokenApp.use("/api/feedback", brokenRouter);
  const brokenServer = http.createServer(brokenApp);
  await new Promise<void>((resolve) => brokenServer.listen(0, "127.0.0.1", resolve));
  const brokenBase = `http://127.0.0.1:${(brokenServer.address() as AddressInfo).port}/api/feedback`;
  try {
    const brokenTextForm = new FormData();
    brokenTextForm.set("title", "临时目录故障纯文本");
    brokenTextForm.set("content", "正文");
    const brokenText = await fetch(brokenBase, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: brokenTextForm,
    });
    ok(brokenText.status === 201, "附件临时目录不可用时纯文字反馈仍可提交");
    if (brokenText.status === 201) {
      const brokenTextBody = await brokenText.json() as { data?: { id?: number } };
      await db.run("DELETE FROM feedback_reports WHERE id = ?", Number(brokenTextBody.data?.id));
    }
    const brokenFileForm = new FormData();
    brokenFileForm.set("title", "临时目录故障带附件");
    brokenFileForm.set("content", "正文");
    brokenFileForm.append("files", new Blob(["x"], { type: "text/plain" }), "x.txt");
    const brokenFile = await fetch(brokenBase, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: brokenFileForm,
    });
    const brokenFileBody = await brokenFile.json() as { code?: string };
    ok(brokenFile.status === 503 && brokenFileBody.code === "FEEDBACK_ATTACHMENT_UNAVAILABLE",
      "附件临时目录不可用时带附件的上传返回 503");
  } finally {
    await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
    process.env.ANSWER_CARD_DATA_DIR = previousDataDir;
    rmSync(brokenRoot, { recursive: true, force: true });
  }

  // 评审复现：多附件里一个 part 失败后，收尾会中止同伴 part。中止只 destroy 流而不回调，
  // Multer 的 pendingWrites 就永远不归零、错误响应发不出去；这里直接验证每个 part 的回调
  // 在中止后恰好执行一次（旧实现下两个 part 都不会回调）。
  section("6.2 中止在途附件时每个 part 的完成回调恰好执行一次");
  {
    const engine = feedbackModule.feedbackStorageEngine;
    const stalledReservation = {
      bytes: 0,
      limit: 10 * 1024 * 1024,
      // 一直挂起：两个 part 都停在等待预留的 transform 里，out 不会 finish。
      ensureBytes: () => new Promise<boolean>(() => undefined),
      release: () => undefined,
    };
    const engineReq: any = {
      feedbackReservation: stalledReservation,
      feedbackTempPaths: [],
      feedbackAborters: [],
      feedbackFileBytes: 0,
    };
    const makePart = (): any => {
      const stream = new PassThrough();
      stream.end(Buffer.alloc(64 * 1024, 0x61));
      return { stream, originalname: "part.bin", mimetype: "application/octet-stream" };
    };
    const calls: Array<{ part: number; err: unknown }> = [];
    engine._handleFile!(engineReq, makePart(), (err: unknown) => calls.push({ part: 1, err }));
    engine._handleFile!(engineReq, makePart(), (err: unknown) => calls.push({ part: 2, err }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    ok(calls.length === 0, "两个 part 都还在等待配额预留");
    for (const abort of engineReq.feedbackAborters as Array<() => void>) abort();
    await new Promise((resolve) => setTimeout(resolve, 80));
    ok(calls.length === 2 && calls.every((call) => call.err instanceof Error),
      "中止在途 part 后每个 _handleFile 回调恰好报告一次错误，Multer 的 pendingWrites 可以归零");
    for (const tempPath of engineReq.feedbackTempPaths as string[]) {
      feedbackStorage.unmarkActiveFeedbackTempFile(tempPath);
      rmSync(tempPath, { force: true });
    }
  }

  // 恢复备份期间的维护闸门：新的 multipart 反馈直接 503，结束后恢复提交。
  section("6.3 恢复维护闸门");
  {
    const releaseMaintenance = feedbackStorage.beginFeedbackMaintenance();
    try {
      const maintenanceForm = new FormData();
      maintenanceForm.set("title", "维护期间反馈");
      maintenanceForm.set("content", "正文");
      const blocked = await upload(maintenanceForm, adminToken);
      ok(blocked.status === 503 && blocked.json?.code === "FEEDBACK_MAINTENANCE",
        "恢复维护期间新的 multipart 反馈返回 503");
    } finally {
      releaseMaintenance();
    }
    const resumedForm = new FormData();
    resumedForm.set("title", "维护结束后的反馈");
    resumedForm.set("content", "正文");
    const resumed = await upload(resumedForm, adminToken);
    ok(resumed.status === 201, "维护结束后反馈恢复提交");
    if (resumed.status === 201) {
      await call("DELETE", `/${Number(resumed.json?.data?.id)}`, adminToken);
    }
  }

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
