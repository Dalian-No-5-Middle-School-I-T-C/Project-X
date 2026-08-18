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
import { initializeDatabase, ensureDefaultAdmin, closeDatabase } from "../../../src/server/db/index.ts";
import { seedDemoData } from "../../../src/server/services/DemoDataService.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

export async function seedDemoExams(dbPath?: string): Promise<void> {
  if (dbPath) process.env.PROJECTX_DB_PATH = dbPath;
  if (!process.env.PROJECTX_DB_PATH) {
    process.env.PROJECTX_DB_PATH = path.join(REPO_ROOT, "data", "projectx.db");
  }

  console.log(`[seed] 数据库: ${process.env.PROJECTX_DB_PATH}`);
  initializeDatabase();
  await ensureDefaultAdmin();

  await seedDemoData();
}

async function main(): Promise<void> {
  await seedDemoExams();
  closeDatabase();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
