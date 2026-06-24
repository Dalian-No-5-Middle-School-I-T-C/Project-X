/**
 * 生成可导入的 projectx-demo.zip 备份包
 *
 * 用法: npx tsx testdata/demo-exams/scripts/build-backup.ts
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { closeDatabase, getDatabase } from "../../../src/server/db/index.ts";
import { seedDemoExams } from "./seed.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(__dirname, "..");
const BACKUP_DIR = path.join(PACKAGE_DIR, "backup");
const ZIP_PATH = path.join(BACKUP_DIR, "projectx-demo.zip");
const TEMP_DB = path.join(BACKUP_DIR, ".build", "projectx.db");

async function main(): Promise<void> {
  mkdirSync(path.dirname(TEMP_DB), { recursive: true });
  if (existsSync(TEMP_DB)) {
    try { closeDatabase(); } catch { /* ignore */ }
  }

  console.log("[build-backup] 生成演示数据库...");
  await seedDemoExams(TEMP_DB);

  const db = getDatabase();
  const vacuumPath = path.join(BACKUP_DIR, ".build", "projectx-clean.db");
  db.exec(`VACUUM INTO '${vacuumPath.replace(/'/g, "''")}'`);
  closeDatabase();

  const metadata = {
    version: 1,
    format: "projectx-backup",
    label: "projectx-demo-exams",
    generatedAt: new Date().toISOString(),
    files: [{ name: "projectx.db", size: 0 }]
  };

  mkdirSync(BACKUP_DIR, { recursive: true });
  const staging = path.join(BACKUP_DIR, ".build", "staging");
  mkdirSync(staging, { recursive: true });
  copyFileSync(vacuumPath, path.join(staging, "projectx.db"));
  writeFileSync(path.join(staging, "metadata.json"), JSON.stringify(metadata, null, 2));

  const zip = new AdmZip();
  zip.addLocalFile(path.join(staging, "projectx.db"));
  zip.addLocalFile(path.join(staging, "metadata.json"));
  zip.writeZip(ZIP_PATH);

  console.log(`[build-backup] 已写入 ${ZIP_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
