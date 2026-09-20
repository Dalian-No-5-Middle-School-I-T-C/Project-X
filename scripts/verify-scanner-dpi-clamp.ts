/**
 * 扫描 DPI 夹紧 —— 自动化验证脚本
 * ----------------------------------------------------------------
 * 运行方式：npx tsx scripts/verify-scanner-dpi-clamp.ts
 *
 * 背景（云端安全检查 #24 / PR280 评审 P1）：
 *   POST /api/scanner/scan 的 body.dpi 此前原样透传给 scanner-bridge.exe，
 *   并落库后再次传给原生识别器；dpi=1e9 这类请求可让原生进程分配巨量内存。
 *   修复要求：本机 TWAIN 入口与远端扫描端上报值统一夹紧到 [50,1200]。
 *
 * 断言方式：走真实 HTTP 路由创建会话（无需扫描仪硬件——扫描在后台启动后失败即可），
 *   再读回 twain_scan_sessions.dpi 断言落库值。
 *
 * 全部用例通过则进程退出码为 0，否则为 1。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";

const tempDir = mkdtempSync(path.join(tmpdir(), "projectx-dpi-clamp-"));
process.env.PROJECTX_DB_PATH = path.join(tempDir, "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tempDir, "data");
process.env.PROJECTX_AUTH_ENFORCE = "1";
process.env.PROJECTX_ENABLE_SCANNER = "true";
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST"
]) delete process.env[key];

let passed = 0;
const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

async function main(): Promise<void> {
  let server: Server | undefined;
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { UserRepository } = await import("../src/server/repositories/UserRepository");
  const { authService } = await import("../src/server/services/AuthService");

  try {
    initializeDatabase();
    await ensureDefaultAdmin();
    const db = getDatabase();
    const users = new UserRepository();
    const teacher = await users.createUser({
      username: "dpi-teacher", password: "dpi-pass", name: "DPI 教师",
      role_id: 2, teacher_role: "subject_teacher", subject: "数学"
    });
    const token = (await authService.login(teacher.username, "dpi-pass")).token!;
    db.prepare("INSERT INTO answer_cards (id,title,subject,subject_label) VALUES (?,?,?,?)")
      .run("dpi-card", "DPI 验收卡", "shuxue", "数学");

    const app = await createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    console.log("\n\x1b[36m== POST /api/scanner/scan —— dpi 落库前夹紧 ==\x1b[0m");
    const cases: Array<{ input?: number; expected: number; label: string }> = [
      { input: 1e9, expected: 1200, label: "dpi=1e9 夹紧为 1200（原生进程内存保护）" },
      { input: 600, expected: 600, label: "dpi=600 原样保留" },
      { input: 1, expected: 50, label: "dpi=1 抬升为下限 50" },
      { input: undefined, expected: 300, label: "未传 dpi 回落 300" }
    ];
    for (const testCase of cases) {
      const response = await fetch(`${base}/api/scanner/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ cardId: "dpi-card", ...(testCase.input === undefined ? {} : { dpi: testCase.input }) })
      });
      const body = await response.json() as { sessionId?: string; message?: string };
      const row = body.sessionId
        ? db.prepare("SELECT dpi FROM twain_scan_sessions WHERE id = ?").get(body.sessionId) as { dpi: number } | undefined
        : undefined;
      check(response.status === 202 && Number(row?.dpi) === testCase.expected,
        `${testCase.label} (status=${response.status}, 落库=${row?.dpi ?? "无会话"}${body.message ? `, ${body.message}` : ""})`);
    }

    // 等后台扫描（无硬件必然失败）落定，避免关闭数据库时产生噪音日志
    await new Promise((resolve) => setTimeout(resolve, 800));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    try { await (await import("../src/server/db/index")).closeDatabase(); } catch { /* ignore */ }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("verify-scanner-dpi-clamp: ALL PASS");
}

void main();
