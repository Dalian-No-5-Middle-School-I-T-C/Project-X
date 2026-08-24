/**
 * v2.4.2 Bug 批量修复回归验证（临时 SQLite 库 + HTTP）：
 *  P01 恢复前置校验（不兼容备份 400 拒绝；兼容备份恢复成功）
 *  P03 中文文件名 latin1 mojibake 修复（fixMultipartName 单测）
 *  P07 识别端学号位数校验（validateStudentIdDigits 单测）
 *  P08 识别上传 40 张上限（>40 张 → 400 UPLOAD_TOO_MANY_FILES）
 *  P09 恢复期维护标志（beginRestore → 业务 503，finishRestore → 恢复 200）
 *  P10 特别备注 extraNotes 32000 上限（超长 → 400 EXTRA_NOTES_TOO_LONG）
 *
 * 用法: npx tsx scripts/verify-bugfix-242.ts
 * 注意：better-sqlite3 原生模块按 Node 24 编译，请用系统 Node 24 运行 tsx。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-242-verify-"));
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

const DEMO_ADMIN_PASSWORD = "Admin@P1Integrity2026";
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

/** 构造备份 zip：metaVersion=null 表示不写 metadata.json */
function makeBackupZip(opts: { metaVersion?: number | null; withSchemaMigrations: boolean }): Buffer {
  const zip = new AdmZip();
  if (opts.metaVersion != null) {
    zip.addFile("metadata.json", Buffer.from(JSON.stringify({ version: opts.metaVersion, format: "projectx-backup", generatedAt: new Date().toISOString(), files: [] })));
  }
  // 构造最小 SQLite db（含/不含 schema_migrations）
  const db = new Database(":memory:");
  if (opts.withSchemaMigrations) {
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);");
  } else {
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY);");
  }
  zip.addFile("projectx.db", db.serialize());
  db.close();
  return zip.toBuffer();
}

async function main() {
  console.log(`临时库: ${process.env.PROJECTX_DB_PATH}`);
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { fixMultipartName, validateStudentIdDigits } = await import("../src/apps/answer-card/server/helpers");
  const { beginRestore, finishRestore, isRestoring } = await import("../src/server/services/restoreGuard");

  // ── P03 / P07 纯函数单测（先于 DB 初始化，独立可靠）──
  {
    console.log("\n[P03] 中文文件名 mojibake 修复");
    const mojibake = Buffer.from("微信图片.jpg", "utf8").toString("latin1");
    ok(fixMultipartName(mojibake) === "微信图片.jpg", `mojibake → 微信图片.jpg (${mojibake})`);
    ok(fixMultipartName("普通-语文-期中.pdf") === "普通-语文-期中.pdf", "正常中文名不变");
    ok(fixMultipartName("scan_001.jpg") === "scan_001.jpg", "ASCII 名不变");
    ok(fixMultipartName("café.pdf") === "café.pdf", "真实 latin1（法语）名不被误转");

    console.log("\n[P07] 学号位数校验");
    ok(validateStudentIdDigits("10001", 5) === null, "5 位学号 × 5 位卡配置 → 通过");
    const err4 = validateStudentIdDigits("1001", 5);
    ok(err4 !== null && err4.includes("位数"), `4 位学号 × 5 位卡配置 → 拒绝 (${err4})`);
    ok(validateStudentIdDigits("100011", 5) !== null, "6 位学号 × 5 位卡配置 → 拒绝");
    ok(validateStudentIdDigits("123", 0) === null, "卡未配置位数（0）→ 不校验");
  }

  initializeDatabase();
  const db = getDatabase();
  const bootstrap = await ensureDefaultAdmin();

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

  // ── P08: 识别上传 41 张 → 400 UPLOAD_TOO_MANY_FILES ──
  {
    console.log("\n[P08] 识别上传数量上限 40");
    const fd = new FormData();
    for (let i = 0; i < 41; i++) {
      fd.append("files", new Blob([Buffer.from("x".repeat(128))], { type: "image/jpeg" }), `card_${i}.jpg`);
    }
    const r = await fetch(`${base}/api/cards/fake-card/grading`, { method: "POST", headers, body: fd });
    const body = await r.json().catch(() => ({}));
    ok(r.status === 400 && body.code === "UPLOAD_TOO_MANY_FILES", `41 张 → 400 UPLOAD_TOO_MANY_FILES (实际 ${r.status}/${body.code})`);
  }

  // ── P10: 分析端点 extraNotes 超长 → 400 EXTRA_NOTES_TOO_LONG（无需卡/AI 配置）──
  {
    console.log("\n[P10] extraNotes 32000 上限");
    const r = await fetch(`${base}/api/cards/fake-card/knowledge-points/analyze`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ questionRange: "1-10", extraNotes: "x".repeat(32001) }),
    });
    const body = await r.json().catch(() => ({}));
    ok(r.status === 400 && body.error === "EXTRA_NOTES_TOO_LONG", `超长 extraNotes → 400 EXTRA_NOTES_TOO_LONG (实际 ${r.status}/${body.error})`);
  }

  // ── P09: 维护标志 → 业务 503，清理后恢复 ──
  {
    console.log("\n[P09] 恢复期维护模式");
    ok(!isRestoring(), "初始无维护标志");
    beginRestore();
    ok(isRestoring(), "beginRestore 后标志存在");
    const blocked = await fetch(`${base}/api/exams`, { headers });
    ok(blocked.status === 503 && (await blocked.json().catch(() => ({}))).code === "MAINTENANCE", `维护期间业务 API → 503 (实际 ${blocked.status})`);
    const healthOk = await fetch(`${base}/api/app/health`);
    ok(healthOk.status === 200, `维护期间健康检查放行 (实际 ${healthOk.status})`);
    finishRestore();
    ok(!isRestoring(), "finishRestore 后标志清理");
    const alive = await fetch(`${base}/api/exams`, { headers });
    ok(alive.status === 200, `清理后业务 API 恢复 (实际 ${alive.status})`);
  }

  // ── P01: 恢复前置校验（拒绝路径）──
  {
    console.log("\n[P01] 恢复前置校验（不兼容备份拒绝）");
    // 1) 缺 metadata.json
    const noMeta = makeBackupZip({ metaVersion: null, withSchemaMigrations: true });
    const r1 = await fetch(`${base}/api/db/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: noMeta });
    ok(r1.status === 400, `缺 metadata.json → 400 (实际 ${r1.status})`);
    // 2) v1.x + 无 schema_migrations（老备份典型）
    const oldZip = makeBackupZip({ metaVersion: 1, withSchemaMigrations: false });
    const r2 = await fetch(`${base}/api/db/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: oldZip });
    const b2 = await r2.json().catch(() => ({}));
    ok(r2.status === 400 && /备份版本过旧|不兼容/.test(b2.message ?? ""), `v1.x 老备份 → 400 兼容性提示 (实际 ${r2.status})`);
    // 3) version=2 但缺 schema_migrations
    const fakeNew = makeBackupZip({ metaVersion: 2, withSchemaMigrations: false });
    const r3 = await fetch(`${base}/api/db/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: fakeNew });
    ok(r3.status === 400, `version=2 但缺 schema_migrations → 400 (实际 ${r3.status})`);
    // 4) 校验失败不应留下维护标志
    ok(!isRestoring(), `拒绝路径不残留维护标志`);
  }

  // ── P01: 兼容备份恢复成功（最后执行：会替换临时库）──
  {
    console.log("\n[P01] 兼容备份恢复成功");
    const goodZip = makeBackupZip({ metaVersion: 2, withSchemaMigrations: true });
    const r = await fetch(`${base}/api/db/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: goodZip });
    ok(r.status === 200, `version=2 + schema_migrations → 恢复 200 (实际 ${r.status})`);
    ok(!isRestoring(), "恢复成功后维护标志已清理");
    // 恢复后 DB 被替换，不再执行任何 DB 断言
    console.log("  ℹ 恢复已替换临时库，后续不再访问 DB");
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { closeDatabase(); } catch {}
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
