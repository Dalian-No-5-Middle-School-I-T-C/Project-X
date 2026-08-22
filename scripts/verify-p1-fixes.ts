/**
 * 安全审计 P1 修复集成验证（本地临时库）：
 *  1. 同源浏览器登录响应不含 token、跨源/无 Origin 含 token（HttpOnly Cookie 主通道）
 *  2. Cookie 登录后 /api/auth/me 可恢复会话
 *  3. 默认扫描 API Key 已哈希入库（64 位 hex）+ 明文仅写受保护文件
 *  4. 历史明文 api_keys 启动迁移为哈希
 *  5. llm-client 的 getLlmEnv 可读取 llmclient/.env
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-p1-verify-"));
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

async function main() {
  console.log(`临时库: ${process.env.PROJECTX_DB_PATH}`);
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase, getScannerApiKeyPath, migrateLegacyPlaintextApiKeys } =
    await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");

  initializeDatabase();
  const db = getDatabase();
  const bootstrap = await ensureDefaultAdmin();

  // ── 3/4. 默认 API Key 哈希化 + 历史明文迁移 ──
  const defaultKeyRow = db.prepare("SELECT api_key FROM api_keys WHERE scope='scanner' AND is_active=1 LIMIT 1").get() as any;
  const isHash = typeof defaultKeyRow?.api_key === "string" && /^[0-9a-f]{64}$/.test(defaultKeyRow.api_key);
  ok(isHash, `默认扫描 Key 已哈希入库（64 位 hex，实际 ${String(defaultKeyRow?.api_key).slice(0,12)}…）`);
  ok(!/^sk-/.test(defaultKeyRow?.api_key ?? ""), "库中不再存 sk- 明文");
  ok(existsSync(getScannerApiKeyPath()), "明文仅写入受保护文件 scanner-api-key.txt");
  const writtenPlain = readFileSync(getScannerApiKeyPath(), "utf8").trim();
  ok(/^sk-[0-9a-f]{32}$/.test(writtenPlain), "受保护文件内容是完整明文 sk-…");

  // 构造历史明文行并迁移
  db.prepare("INSERT INTO api_keys (name, api_key, scope) VALUES (?,?,?)").run("legacy", "sk-legacy-plaintext-abcd1234", "scanner");
  await migrateLegacyPlaintextApiKeys((await import("../src/server/db")).getMysqlDb());
  const legacy = db.prepare("SELECT api_key FROM api_keys WHERE name='legacy'").get() as any;
  ok(/^[0-9a-f]{64}$/.test(legacy.api_key), `历史明文行已迁移为哈希（${legacy.api_key.slice(0,12)}…）`);

  // ── 5. getLlmEnv 读取 llmclient/.env ──
  const secrets = `LLMCLIENT_INTERNAL_API_KEY=dev-llm-key-abc123`;
  writeFileSync(path.resolve("llmclient", ".env"), secrets, { flag: "w" });
  try {
    const { getLlmEnv } = await import("../src/apps/answer-card/server/llm-env");
    ok(getLlmEnv("LLMCLIENT_INTERNAL_API_KEY") === "dev-llm-key-abc123", "getLlmEnv 能从 llmclient/.env 读到内部密钥");
  } finally {
    rmSync(path.resolve("llmclient", ".env"), { force: true });
  }

  // ── 1/2. HTTP 登录：Cookie 主通道 ──
  const app = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const pwd = readFileSync(bootstrap.passwordFile, "utf8").trim();

  // 无 Origin（脚本客户端）→ 响应含 token
  const noOrigin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "admin", password: pwd }),
  });
  const noOriginBody = await noOrigin.json();
  ok(typeof noOriginBody.token === "string", "无 Origin 客户端响应仍携带 token（兼容脚本/测试）");

  // 同源浏览器（Origin 与 Host 一致）→ 响应不含 token，但 Set-Cookie 生效
  const pageHost = `127.0.0.1:${(server.address() as any).port}`;
  const sameOrigin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://${pageHost}` },
    body: JSON.stringify({ identifier: "admin", password: pwd }),
  });
  const sameOriginBody = await sameOrigin.json();
  ok(!("token" in sameOriginBody), "同源浏览器登录响应不含 token");
  const setCookie = sameOrigin.headers.get("set-cookie") ?? "";
  ok(setCookie.includes("projectx_auth_token") && setCookie.includes("HttpOnly"), "同源登录设置了 HttpOnly Cookie");

  // 用 Cookie 调 /api/auth/me → 会话被恢复（Cookie 主通道）
  const cookieValue = setCookie.split(";")[0];
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookieValue } });
  const meBody = await me.json();
  ok(me.status === 200 && meBody.username === "admin", "凭 HttpOnly Cookie 恢复会话（/api/auth/me 返回 admin）");

  // 跨源（Origin 不同）→ 响应含 token（移动端/小助手场景兼容）
  const crossOrigin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
    body: JSON.stringify({ identifier: "admin", password: pwd }),
  });
  const crossOriginBody = await crossOrigin.json();
  ok(typeof crossOriginBody.token === "string", "跨源浏览器登录响应携带 token（Cookie 无法跨站点携带）");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(path.resolve("data", "scanner-api-key.txt"), { force: true });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
