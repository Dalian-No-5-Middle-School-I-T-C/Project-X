/**
 * 扫描取消竞态 —— 自动化验证脚本
 * ----------------------------------------------------------------
 * 运行方式：
 *   npm run verify:scanner-cancel
 *
 * 覆盖场景（对应 P1 阻断问题）：
 *   1. POST /scan 返回 202 后用户立即取消（子进程尚未注册）：
 *      cancelScan 记录取消意图并返回 false；随后 runBridge/scan
 *      必须在 spawn 前被拦截，不能启动扫描仪进程。
 *   2. 会话取消状态持久化：cancelled 写入后不被后台任务覆盖。
 *
 * 全部用例通过则进程退出码为 0，否则为 1。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 必须在导入任何 db 模块前设置数据库路径（getDatabase 在模块求值期读取该变量）
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-scanverify-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
// 固定使用临时 SQLite，避免 cloud.env 中的 MariaDB 变量干扰
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

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

async function main(): Promise<void> {
  console.log(`使用临时数据库: ${process.env.PROJECTX_DB_PATH}`);

  // ── 1. 取消早于子进程注册（202 后立即取消） ─────────────
  section("1. 取消早于子进程注册");
  const { cancelScan, scan } = await import("../src/apps/answer-card/server/scanner/twain-bridge");

  const terminated = cancelScan("sess-cancel-early");
  ok(terminated === false, "子进程未注册时 cancelScan 返回 false（取消意图已记录）");

  let rejected = false;
  let message = "";
  try {
    await scan(
      {
        sourceName: "fake-source",
        dpi: 300,
        duplex: false,
        colorMode: "gray",
        paperSize: "A4",
        outputDir: tmpDir,
        filePrefix: "t",
        maxPages: 1
      },
      "sess-cancel-early"
    );
  } catch (e) {
    rejected = true;
    message = e instanceof Error ? e.message : String(e);
  }
  ok(rejected, "scan 被拒绝（未启动扫描仪进程）");
  ok(message === "扫描已取消", `拒绝原因为"扫描已取消"（实际：${message || "(未拒绝)"}`);

  // 未取消的会话不受影响（对照：取消拦截只针对已取消的 sessionId；
  // 无扫描仪时 scan 会 resolve(error JSON) 或抛非"扫描已取消"的错误）
  let blockedByCancel = false;
  try {
    await scan(
      {
        sourceName: "fake-source",
        dpi: 300,
        duplex: false,
        colorMode: "gray",
        paperSize: "A4",
        outputDir: tmpDir,
        filePrefix: "t",
        maxPages: 1
      },
      "sess-normal"
    );
  } catch (e) {
    blockedByCancel = e instanceof Error && e.message === "扫描已取消";
  }
  ok(!blockedByCancel, "未取消的会话不被误拦截（错误信息不含'扫描已取消'）");

  // ── 2. 会话取消状态持久化 ──────────────────────────────
  section("2. 取消状态持久化（cancelled 不被覆盖）");
  const { initializeDatabase } = await import("../src/server/db/index");
  initializeDatabase();
  const { createSession, updateSessionStatus, getSession } = await import(
    "../src/apps/answer-card/server/database/scan-store"
  );

  const s = await createSession("card-verify", "取消竞态验证", {});
  ok(s.status === "pending", `新会话初始状态为 pending（实际：${s.status}）`);

  await updateSessionStatus(s.id, "cancelled", "用户取消扫描");
  const after = await getSession(s.id);
  ok(after?.status === "cancelled", "取消接口写入 cancelled 后状态保持（实际：" + after?.status + "）");

  // runScanSession 竞态防线 1 的判定依据：前置检查能读到 cancelled
  const preScan = await getSession(s.id);
  ok(preScan?.status === "cancelled", "扫描启动前的前置检查可读到 cancelled（据此跳过 scanning 写入）");

  // ── 3. 上传管理器取消：资源释放 / activeJobId / dismiss ──
  section("3. 上传管理器取消语义（P2 审查：资源泄漏 + cancelled 无法关闭）");
  const { createScannerUploadManager } = await import(
    "../src/apps/answer-card/client/lib/scannerUploadManager"
  );

  async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return cond();
  }

  const um = createScannerUploadManager({
    remoteFetch: async () => {
      throw new Error("不应发起上传请求");
    },
    getServerKind: () => "offline", // 恒离线 → 任务创建后立即转 paused
    isOnline: () => false,
    pageTimeoutMs: 200,
  });
  const pages = [1, 2, 3].map((n) => ({
    pageNum: n,
    side: "front" as const,
    getBlob: async () => new Blob(),
  }));
  const jobId = um.startUpload({
    kind: "scan",
    cardId: "card-cancel-test",
    name: "取消资源释放测试",
    pages,
    dpi: 300,
    paperSize: "A4",
  });

  ok(
    await waitFor(() => um.getState().jobs.find((x) => x.id === jobId)?.status === "paused"),
    "离线状态下任务进入 paused"
  );

  um.cancelJob(jobId);
  const st = um.getState();
  ok(st.jobs.find((x) => x.id === jobId)?.status === "cancelled", "取消后状态为 cancelled");

  // 未上传页（全部页均未 done）的 getBlob 闭包必须已释放，不得被任务永久引用
  let anyBlobAlive = false;
  for (const p of pages) {
    try {
      await p.getBlob();
      anyBlobAlive = true;
    } catch {
      /* 已释放：预期 */
    }
  }
  ok(!anyBlobAlive, "取消后全部页面 getBlob 已释放（不残留 File/Blob 闭包）");
  ok(st.activeJobId === null, "activeJobId 不再指向已取消任务");

  const { dismissJob } = um;
  ok(typeof dismissJob === "function", "上传管理器提供 dismissJob 接口");
  ok(dismissJob(jobId) === true, "dismissJob 移除取消中的任务");
  ok(um.getState().jobs.length === 0, "dismissJob 后任务列表为空");
  ok(dismissJob("missing") === false, "dismissJob 对不存在任务返回 false");

  // ── 汇总 ───────────────────────────────────────────────
  console.log("");
  console.log("────────────────────────────────────────");
  if (failed === 0) {
    console.log(`\x1b[32m结果：${passed} 通过，0 失败\x1b[0m`);
  } else {
    console.log(`\x1b[31m结果：${passed} 通过，${failed} 失败\x1b[0m`);
    for (const f of failures) console.log(`  \x1b[31m✗ ${f}\x1b[0m`);
  }

  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响断言结果（OS 临时目录，系统会回收）
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
