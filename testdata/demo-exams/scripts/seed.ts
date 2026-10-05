/**
 * 演示考试数据种子脚本（CLI 薄包装）
 *
 * 用法（在仓库根目录）:
 *   npx tsx testdata/demo-exams/scripts/seed.ts
 *   PROJECTX_DB_PATH=/path/to.db npx tsx testdata/demo-exams/scripts/seed.ts
 *
 * 支持 SQLite 与 MariaDB 双方言：默认写本地 SQLite；设置 PROJECTX_MARIADB_HOST 等
 * 环境变量（或 config.yml database.mode: remote）后直接写入 MariaDB。
 * 可重复运行：会先清理「演示-」前缀数据。
 * 核心逻辑在 src/server/services/DemoDataService.ts（服务端 /api/db/import-demo 同款）。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeDatabase,
  detectDialect,
  ensureDefaultAdmin,
  initializeDatabase,
  initMariadbSchema,
  resetAdapter
} from "../../../src/server/db/index.ts";
import { seedDemoData } from "../../../src/server/services/DemoDataService.ts";
import { DEMO_FIXED_CREDENTIALS_ENV } from "../../../src/server/services/demo/demoDataPolicy.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

export async function seedDemoExams(dbPath?: string): Promise<void> {
  if (dbPath) process.env.PROJECTX_DB_PATH = dbPath;
  if (!process.env.PROJECTX_DB_PATH) {
    process.env.PROJECTX_DB_PATH = path.join(REPO_ROOT, "data", "projectx.db");
  }

  // 安全 R33：本脚本是**测试数据包的验收口径**——manifest.json 与 scripts/verify.ts 都按
  // `demo-teacher / teacher123`、`学生口令=学号` 登录断言，所以这里显式打开固定凭据开关。
  // 生产环境的导入走 `POST /api/db/import-demo`（前端一键导入），不经过本文件，
  // 默认仍是每次导入随机换发口令；且下面的「库中已有真实数据」闸门对本脚本同样生效，
  // 因此固定口令不会被顺手带进生产库。
  if (!process.env[DEMO_FIXED_CREDENTIALS_ENV]) {
    process.env[DEMO_FIXED_CREDENTIALS_ENV] = "1";
    console.warn(
      `[seed] ${DEMO_FIXED_CREDENTIALS_ENV}=1：使用测试数据包的固定演示口令（teacher123 / 口令=学号）。`
      + `仅限隔离测试库；生产库请用前端「导入演示数据」，那里口令是随机换发的。`
    );
  }

  console.log(`[seed] 数据库: ${process.env.PROJECTX_DB_PATH}`);
  initializeDatabase();
  // The HTTP server initializes the remote schema during startup, but this
  // standalone entry point must do so itself before querying/creating admin.
  if (detectDialect() === "mariadb") {
    await initMariadbSchema();
  }
  await ensureDefaultAdmin();

  await seedDemoData();
}

async function main(): Promise<void> {
  try {
    await seedDemoExams();
  } catch (err) {
    const refusal = err as { code?: string; confirm?: string; message?: string };
    if (typeof refusal?.code === "string" && refusal.code.startsWith("DEMO_")) {
      console.error(`\n[seed] 导入被拒绝（${refusal.code}）：${refusal.message}`);
      if (refusal.confirm) {
        console.error(`[seed] 确要在这个库上导入，请改用前端「导入演示数据」并二次确认，或设 PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT=1。`);
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    closeDatabase();
    // Close the MariaDB pool as well; closeDatabase() only owns SQLite.
    resetAdapter();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
