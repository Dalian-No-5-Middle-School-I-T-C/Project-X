/**
 * 生成可导入的 projectx-demo.zip 备份包
 *
 * 用法: npx tsx testdata/demo-exams/scripts/build-backup.ts
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { closeDatabase, getDatabase, resolveAnswerCardDataDir } from "../../../src/server/db/index.ts";
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

  // 资源文件一并打包（restore 端点会自动解出 data/answer-card/ 目录）：
  // 填空题图片（assets/88000001/fig-demo.png）与网阅切块占位图（recognition/crops/demo-review/placeholder.png），
  // 保证 ZIP 恢复后图片资源完整可用。
  const answerCardDataDir = resolveAnswerCardDataDir();
  const assetFile = path.join(answerCardDataDir, "assets", "88000001", "fig-demo.png");
  if (existsSync(assetFile)) {
    const target = path.join(staging, "data", "answer-card", "assets", "88000001");
    mkdirSync(target, { recursive: true });
    copyFileSync(assetFile, path.join(target, "fig-demo.png"));
  }
  const cropFile = path.join(answerCardDataDir, "recognition", "crops", "demo-review", "placeholder.png");
  if (existsSync(cropFile)) {
    const target = path.join(staging, "data", "answer-card", "recognition", "crops", "demo-review");
    mkdirSync(target, { recursive: true });
    copyFileSync(cropFile, path.join(target, "placeholder.png"));
  }

  const zip = new AdmZip();
  zip.addLocalFile(path.join(staging, "projectx.db"));
  zip.addLocalFile(path.join(staging, "metadata.json"));
  const stagedDataDir = path.join(staging, "data", "answer-card");
  if (existsSync(stagedDataDir)) {
    zip.addLocalFolder(stagedDataDir, "data/answer-card");
  }
  zip.writeZip(ZIP_PATH);

  console.log(`[build-backup] 已写入 ${ZIP_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
