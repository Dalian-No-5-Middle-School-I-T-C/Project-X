/**
 * 针对 BUGFIX-SUMMARY-2026-07-19.md 的定向运行时验证。
 * 真实启动 answer-card 服务的 createApp()，通过 HTTP + 直接服务调用，
 * 验证该文档所列安全 / 数据完整性修复（P0-4/P0-5/P0-8/P0-9/P1-1/P1-2/P2-1/L-S5）。
 *
 * 运行：USERPROFILE=<tmp> npx tsx scripts/bugfix-summary-verification.ts
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── 隔离环境：临时 SQLite DB + 临时 HOME（token 存于临时目录） ──
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-bugfix-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tmpDir, "data"); // 隔离答题卡数据，避免污染仓库
process.env.USERPROFILE = path.join(tmpDir, "home"); // 隔离 token 存储，避免污染真实 HOME
process.env.PROJECTX_ENABLE_SCANNER = "false"; // 避免加载原生扫码模块
for (const k of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST",
]) delete process.env[k];
delete process.env.PROJECTX_AUTH_ENFORCE; // 默认开启（P0-4 验证点）

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import(
    "../src/server/db"
  );
  const { AuthService } = await import("../src/server/services/AuthService");

  initializeDatabase();
  const bootstrap = await ensureDefaultAdmin();
  const app = await createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[verify] 服务监听于 ${base}`);

  // ── P0-4 / P0-5：默认开启鉴权，无 token 访问受保护路由 → 401 ──
  const cardsRes = await fetch(`${base}/api/cards`);
  ok(cardsRes.status === 401, "P0-4/P0-5 无 token 访问 /api/cards → 401");
  const examsRes = await fetch(`${base}/api/exams`);
  ok(examsRes.status === 401, "P0-4/P0-5 无 token 访问 /api/exams → 401");

  // ── P1-2：CORS 白名单校验 ──
  const evilRes = await fetch(`${base}/api/app/health`, { headers: { Origin: "http://evil.com" } });
  ok(!evilRes.headers.get("access-control-allow-origin"), "P1-2 跨域 evil.com 不返回 ACAO 头");
  const goodRes = await fetch(`${base}/api/app/health`, { headers: { Origin: "http://localhost:5173" } });
  ok(
    goodRes.headers.get("access-control-allow-origin") === "http://localhost:5173",
    "P1-2 白名单 origin 正确回显 ACAO 头"
  );

  // ── P0-8：管理员初始密码为固定值，登录后可直接使用 ──
  const bootstrapPassword = readFileSync(bootstrap.passwordFile, "utf8").trim();
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "admin", password: bootstrapPassword }),
  });
  const loginBody = (await loginRes.json().catch(() => ({}))) as { passwordChangeRequired?: boolean; token?: string };
  ok(loginRes.status === 200 && loginBody.passwordChangeRequired === true, "P0-8 固定初始密码登录后强制改密");
  const oldAdminToken = loginBody.token;
  const protectedRes = await fetch(`${base}/api/cards`, {
    headers: oldAdminToken ? { Authorization: `Bearer ${oldAdminToken}` } : {}
  });
  ok(protectedRes.status === 428, "P0-8 强制改密会话访问业务 API → 428");
  const changedRes = await fetch(`${base}/api/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(oldAdminToken ? { Authorization: `Bearer ${oldAdminToken}` } : {}) },
    body: JSON.stringify({ oldPassword: bootstrapPassword, newPassword: "VerifyAdmin-2026!" })
  });
  ok(changedRes.status === 200, "P0-8 管理员完成改密");
  const reloginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "admin", password: "VerifyAdmin-2026!" })
  });
  const reloginBody = (await reloginRes.json().catch(() => ({}))) as { token?: string };
  const adminToken = reloginBody.token;
  ok(reloginRes.status === 200 && !!adminToken, "P0-8 改密后重新登录成功");

  // ── P1-1：登录速率限制（15 分钟 / 10 次）──
  let saw429 = false;
  let firstWrong = 0;
  for (let i = 0; i < 12; i++) {
    const rr = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: "wrong" + i }),
    });
    if (i === 0) firstWrong = rr.status;
    if (rr.status === 429) saw429 = true;
  }
  ok(firstWrong === 401, "P1-1 前几次错误登录返回 401");
  ok(saw429, "P1-1 连续错误登录触发 429 限流");

  await sleep(150); // 等待 token 持久化（scheduleSave 为 setImmediate 异步写盘）

  // ── P2-1：Token 以 SHA-256 哈希存储，磁盘不含明文 ──
  const tokenPath = path.join(process.env.USERPROFILE!, ".projectx", "tokens.json");
  if (existsSync(tokenPath)) {
    const data = JSON.parse(readFileSync(tokenPath, "utf8")) as { tokens?: Record<string, unknown> };
    const keys = Object.keys(data.tokens ?? {});
    const allHashed = keys.length > 0 && keys.every((k) => /^[a-f0-9]{64}$/.test(k));
    const plaintextLeak = adminToken ? keys.includes(adminToken) : false;
    ok(allHashed, `P2-1 token 以 SHA-256 哈希存储（${keys.length} 个 key 均为 64 位 hex）`);
    ok(!plaintextLeak, "P2-1 磁盘 token 文件不含明文 token");

    // round-trip：哈希后仍可凭 token 换取用户
    const auth2 = new AuthService();
    const u = adminToken ? await auth2.getUserByToken(adminToken) : null;
    ok(!!u && u.username === "admin", "P2-1 哈希 token 可正常换回用户（round-trip）");
  } else {
    ok(false, "P2-1 tokens.json 未生成，无法验证");
  }

  // ── P0-9：空密码 hash 改密被拦截 ──
  const auth = new AuthService();
  const db = getDatabase();
  // password_hash 列为 NOT NULL，故以空字符串（falsy）模拟「空 hash」场景，
  // 这正是 P0-9 修复要拦截的异常状态。
  db.prepare("INSERT INTO users (username, name, role_id, is_active, password_hash) VALUES (?,?,?,?,?)").run(
    "emptyhash", "empty", 1, 1, ""
  );
  const eid = (db.prepare("SELECT id FROM users WHERE username='emptyhash'").get() as { id: number }).id;
  const cpRes = await auth.changePassword(eid, "x", "NewPass123");
  ok(
    cpRes.message.includes("账户密码状态异常"),
    `P0-9 空密码 hash 改密返回异常提示（实际: ${cpRes.message}）`
  );

  // ── L-S5：定时清理方法可正常调用 ──
  let ls5 = true;
  try {
    auth.cleanupExpiredTokens();
  } catch {
    ls5 = false;
  }
  ok(ls5, "L-S5 cleanupExpiredTokens 可正常调用（构造已注册定时调度）");

  // ── P0-1：导出答题卡时损坏资源被收集到 warnings.failedAssets ──
  const authHeader = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
  const createRes = await fetch(`${base}/api/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify({ subject: "数学", title: "P0-1验证卡" + Date.now(), examDate: "2026-06-01" }),
  });
  const created = (await createRes.json().catch(() => ({}))) as { id?: string };
  if (created.id) {
    const { cardAssetsDir } = await import("../src/apps/answer-card/server/storage");
    const adir = cardAssetsDir(created.id);
    mkdirSync(path.join(adir, "corrupt_dir"), { recursive: true }); // 目录无法被 readFile 读取 → 触发失败收集
    const expRes = await fetch(`${base}/api/cards/${created.id}/export`, { headers: authHeader });
    const expBody = (await expRes.json().catch(() => ({}))) as { warnings?: { failedAssets?: string[] } };
    ok(
      Array.isArray(expBody.warnings?.failedAssets) && expBody.warnings!.failedAssets!.includes("corrupt_dir"),
      `P0-1 导出损坏资源返回 warnings.failedAssets（实际: ${JSON.stringify(expBody.warnings)}）`
    );
  } else {
    ok(false, `P0-1 无法创建测试卡（create 返回 ${createRes.status}）`);
  }

  // ── P0-2：导入答题卡时损坏 base64 被收集到 warnings.failedImports ──
  const impCard = {
    format: "projectx-card",
    version: 1,
    card: {
      id: "IMP" + Date.now(),
      title: "P0-2验证卡" + Date.now(),
      paper: { size: "A4", orientation: "portrait" },
      studentInfo: { fields: [], studentNumberDigits: 5 },
      bodyBlocks: [],
      sided: "single",
      layoutVersion: 1,
      updatedAt: new Date().toISOString(),
    },
    assets: { "evil.png": "!!!@@@###$$$%%%%" }, // 无有效 base64 字符 → 解码为空 → 触发失败收集
  };
  const impRes = await fetch(`${base}/api/cards/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify(impCard),
  });
  const impBody = (await impRes.json().catch(() => ({}))) as { warnings?: { failedImports?: string[] } };
  ok(
    Array.isArray(impBody.warnings?.failedImports) && impBody.warnings!.failedImports!.includes("evil.png"),
    `P0-2 导入损坏 base64 返回 warnings.failedImports（实际: ${impRes.status}/${JSON.stringify(impBody.warnings ?? impBody)}）`
  );

  server.close();
  closeDatabase();
  console.log(`\n────────────────────────────────────────`);
  console.log(`结果：\x1b[32m${passed} 通过\x1b[0m，\x1b[31m${failed} 失败\x1b[0m`);
  if (failed > 0) console.log("失败：\n  - " + failures.join("\n  - "));
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n\x1b[31m验证脚本异常：\x1b[0m", err);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
