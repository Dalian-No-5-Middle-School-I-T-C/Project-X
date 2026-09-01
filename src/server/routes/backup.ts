import { Router } from "express";
import type { Request, Response } from "express";
import { raw as expressRaw } from "express";
import { ZipArchive } from "archiver";
import AdmZip from "adm-zip";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, copyFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { closeDatabase, getDatabase, getMysqlDb, getMariadbConfig, resolveAnswerCardDataDir, resolveProjectDbPath, resolveScannerDbPath, detectDialect, ensureDefaultAdmin, removeBootstrapAdminFile } from "../db";
import { closeDb } from "../../apps/answer-card/server/database";
import { seedDemoData, clearDemoData } from "../services/DemoDataService";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const router = Router();

// 管理员权限
router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

// 导入使用 raw body（避免 multpart/form-data 解析 corrupt ZIP 二进制数据）
// 安全审计（F-12-11）：512MB → 128MB，收紧管理员上传面（防内存 DoS）
const rawBodyParser = expressRaw({ type: "application/zip", limit: "128mb" });

/**
 * 计算备份中包含的所有目录和文件大小
 */
function getDataDir(): string {
  return resolveAnswerCardDataDir();
}

function getProjectXDbPath(): string {
  return resolveProjectDbPath();
}

function getScannerDbPath(): string {
  return resolveScannerDbPath();
}

/**
 * GET /api/db/backup
 * 导出所有数据为 ZIP 下载
 */
router.get("/backup", async (_req: Request, res: Response) => {
  const dialect = detectDialect();
  if (dialect === "mariadb") {
    await backupMariadb(res);
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `projectx-backup-${crypto.randomUUID()}`);

  try {
    await mkdir(tmpDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // 0. 写入 metadata.json
    const metadata = {
      version: 1,
      format: "projectx-backup",
      generatedAt: new Date().toISOString(),
      files: [] as Array<{ name: string; size: number }>
    };

    // 1. 备份 projectx.db（通过 VACUUM INTO 创建干净的副本）
    const projectxDbPath = getProjectXDbPath();
    const projectxBak = path.join(tmpDir, "projectx.db");
    if (existsSync(projectxDbPath)) {
      const db = getDatabase();
      try {
        const safeTarget = projectxBak.replace(/\\/g, "\\\\").replace(/'/g, "''");
        db.exec(`VACUUM INTO '${safeTarget}'`);
      } catch (err) {
        // VACUUM INTO 可能不支持旧版 SQLite，降级为文件复制
        console.warn("[Backup] VACUUM INTO failed, falling back to file copy:", err);
        await copyFile(projectxDbPath, projectxBak);
      }
      const fstat = await stat(projectxBak);
      metadata.files.push({ name: "projectx.db", size: fstat.size });
    }

    // 2. 备份 scanner.db
    const scannerDbPath = getScannerDbPath();
    const scannerBak = path.join(tmpDir, "scanner.db");
    if (existsSync(scannerDbPath)) {
      // scanner.db 使用独立连接，先关闭再复制
      try {
        closeDb();
      } catch (err) {
        console.warn("[Backup] 关闭 scanner DB 失败，继续备份（文件可能不一致）:", err);
      }
      await copyFile(scannerDbPath, scannerBak);
      const fstat = await stat(scannerBak);
      metadata.files.push({ name: "scanner.db", size: fstat.size });
    }

    // 3. 打包 data/answer-card/ 目录
    const dataDir = getDataDir();
    const dataBakDir = path.join(tmpDir, "data", "answer-card");
    if (existsSync(dataDir)) {
      await copyDirectory(dataDir, dataBakDir, (filePath: string) => {
        // 跳过 .db 文件（已单独备份）
        const base = path.basename(filePath);
        if (base.endsWith(".db") || base.endsWith(".db-shm") || base.endsWith(".db-wal")) {
          return false;
        }
        return true;
      });
      const dirStat = await stat(dataBakDir);
      // 估算大小
      metadata.files.push({ name: "data/answer-card/", size: 0 });
    }

    // 4. 写入 metadata
    await writeFile(path.join(tmpDir, "metadata.json"), JSON.stringify(metadata, null, 2));

    // 5. 创建 ZIP（archiver v8 ESM: new ZipArchive）
    const archive = new ZipArchive({ zlib: { level: 6 } });

    archive.on("error", (err?: Error) => {
      console.error("[Backup] Archive error:", err?.message);
    });

    // 将 archive 管道到响应
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''ProjectX_backup_${timestamp}.zip`
    );
    archive.pipe(res);

    // 添加 metadata
    archive.file(path.join(tmpDir, "metadata.json"), { name: "metadata.json" });

    // 添加 DB 文件
    if (existsSync(projectxBak)) {
      archive.file(projectxBak, { name: "projectx.db" });
    }
    if (existsSync(scannerBak)) {
      archive.file(scannerBak, { name: "scanner.db" });
    }

    // 添加 data 目录
    if (existsSync(dataBakDir)) {
      archive.directory(dataBakDir, "data/answer-card");
    }

    await archive.finalize();

    // 清理临时文件
    cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
  } catch (error) {
    console.error("[Backup] Export failed:", error);
    cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    if (!res.headersSent) {
      res.status(500).json({ message: error instanceof Error ? error.message : "导出失败" });
    }
  }
});

/**
 * POST /api/db/restore
 * 导入 ZIP 恢复数据（raw binary upload，不走 multipart）
 */
router.post("/restore", rawBodyParser, async (req: Request, res: Response) => {
  const dialect = detectDialect();
  if (dialect === "mariadb") {
    await restoreMariadb(req, res);
    return;
  }

  const zipBuffer = req.body as Buffer;
  if (!zipBuffer || !Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    res.status(400).json({ message: "请上传 .zip 备份文件（需以 application/zip Content-Type 发送）" });
    return;
  }

  // 快速校验 ZIP 魔数
  if (zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4b) {
    res.status(400).json({ message: "上传的文件不是有效的 ZIP 格式（缺少 PK 文件头）" });
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `projectx-restore-${crypto.randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });

    // 使用 adm-zip 解压
    extractZipFromBuffer(zipBuffer, tmpDir);

    // 验证 metadata
    const metadataPath = path.join(tmpDir, "metadata.json");
    if (!existsSync(metadataPath)) {
      res.status(400).json({ message: "备份文件格式不正确，缺少 metadata.json" });
      return;
    }

    // 验证必须有 projectx.db
    const projectxBak = path.join(tmpDir, "projectx.db");
    if (!existsSync(projectxBak)) {
      res.status(400).json({ message: "备份文件中未找到 projectx.db" });
      return;
    }

    // 1. 备份当前数据
    const backupSuffix = Date.now();
    const projectxDbPath = getProjectXDbPath();
    const scannerDbPath = getScannerDbPath();
    const dataDir = getDataDir();

    // 备份现有 projectx.db
    if (existsSync(projectxDbPath)) {
      await copyFile(projectxDbPath, projectxDbPath + `.bak.${backupSuffix}`);
    }

    // 备份现有 scanner.db
    if (existsSync(scannerDbPath)) {
      await copyFile(scannerDbPath, scannerDbPath + `.bak.${backupSuffix}`);
    }

    // 2. 关闭数据库连接（关键路径：主 DB 关闭失败必须中止，否则后续 copyFile 会读到锁定/不一致的 DB）
    try {
      closeDatabase();  // 主 DB
    } catch (e) {
      console.error("[Restore] closeDatabase 失败，中止恢复:", e);
      throw new Error(`关闭主数据库失败，无法安全恢复: ${e instanceof Error ? e.message : e}`);
    }
    try {
      closeDb();  // scanner DB（非核心，失败仅 warn 继续）
    } catch (e) {
      console.warn("[Restore] 关闭 scanner DB 失败（继续恢复）:", e);
    }

    // 3. 替换文件（先清理旧 WAL/SHM，避免残留日志污染新库）
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = projectxDbPath + suffix;
      if (existsSync(sidecar)) {
        try { rmSync(sidecar, { force: true }); } catch (e) {
          console.warn(`[Restore] 清理 ${suffix} 失败（继续）:`, e);
        }
      }
    }
    await copyFile(projectxBak, projectxDbPath);

    // 恢复后重新引导管理员账号（#185 安全模型）：还原出的库若使用旧默认口令 admin123
    // 或引导文件丢失，则重新生成一次性口令并写入 bootstrap-admin.txt，确保还原后可用引导文件登录。
    try {
      removeBootstrapAdminFile();
      await ensureDefaultAdmin();
    } catch (e) {
      console.warn("[Restore] 管理员再引导失败（可重启服务自动修复）:", e);
    }

    // 恢复 scanner.db（如果有）
    const scannerBak = path.join(tmpDir, "scanner.db");
    if (existsSync(scannerBak)) {
      await copyFile(scannerBak, scannerDbPath);
    }

    // 恢复 data/answer-card/ 目录
    const bakDataDir = path.join(tmpDir, "data", "answer-card");
    if (existsSync(bakDataDir)) {
      // 先备份当前 data
      const dataBakDir = path.join(path.dirname(dataDir), `answer-card.bak.${backupSuffix}`);
      if (existsSync(dataDir)) {
        await moveDir(dataDir, dataBakDir);
      }
      // 复制新 data
      await copyDirectory(bakDataDir, dataDir, () => true);
    }

    // 清理临时文件
    await cleanupDir(tmpDir);

    res.json({
      ok: true,
      message: "数据已恢复！请重启服务器以使更改完全生效。"
    });
  } catch (error) {
    console.error("[Restore] Import failed:", error);
    await cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    res.status(500).json({ message: error instanceof Error ? error.message : "导入失败" });
  }
});

/**
 * POST /api/db/import-demo
 * 一键导入演示测试数据（「演示-」前缀，幂等，不覆盖现有数据，无需重启）
 * 支持 SQLite 与 MariaDB 双方言（DemoDataService 已双后端化）。
 *
 * 鉴权：路由级 requirePermission(USER_MANAGE) 已过滤非管理员；此路由额外要求
 * SYSTEM_MANAGE「系统维护（数据清理、归档等）」权限，作为「最高权限管理员」语义闸口。
 * 当前仅 admin（持 "*" 通配）能通过；未来若要拆分管理子角色，SYSTEM_MANAGE 可单独授予。
 */
router.post("/import-demo", requirePermission(PERMISSIONS.SYSTEM_MANAGE), async (_req: Request, res: Response) => {
  try {
    const stats = await seedDemoData();
    res.json({
      ok: true,
      message: `演示数据已重置并重新导入：${stats.exams} 场考试 / 16 名学生 / ${stats.groups} 个合集（教师 demo-teacher，密码 teacher123）。⚠️ 原有「演示-」前缀数据（含在其上完成的阅卷/改分）会被清空并更换考试 ID；演示账号凭据固定且可预测，仅限测试环境使用，请勿在生产环境导入。`,
      stats
    });
  } catch (error) {
    console.error("[DemoData] 导入失败:", error);
    res.status(500).json({ message: error instanceof Error ? error.message : "演示数据导入失败" });
  }
});

/**
 * POST /api/db/clear-demo
 * 清除全部「演示-」前缀演示数据（不动真实数据）
 * 支持 SQLite 与 MariaDB 双方言（DemoDataService 已双后端化）。
 *
 * 鉴权：同 /import-demo，要求 SYSTEM_MANAGE 权限（语义：数据清理、归档等）。
 */
router.post("/clear-demo", requirePermission(PERMISSIONS.SYSTEM_MANAGE), async (_req: Request, res: Response) => {
  try {
    const stats = await clearDemoData();
    const preserved = stats.preservedCards > 0
      ? `；为保护 ${stats.preservedExams} 场非演示考试，保留了 ${stats.preservedCards} 张仍被引用的演示答题卡`
      : "";
    res.json({
      ok: true,
      message: `演示数据已清除：${stats.removedExams} 场考试 / ${stats.removedStudents} 名学生 / ${stats.removedGroups} 个合集${preserved}`,
      stats
    });
  } catch (error) {
    console.error("[DemoData] 清除失败:", error);
    res.status(500).json({ message: error instanceof Error ? error.message : "演示数据清除失败" });
  }
});

/**
 * MariaDB 备份 — 通过 mysqldump 导出 SQL → gzip → ZIP
 */
async function backupMariadb(res: Response): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `projectx-backup-${crypto.randomUUID()}`);

  try {
    await mkdir(tmpDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // 从 adapter 获取 MariaDB 连接配置
    const db = getMysqlDb();
    const health = await (await import("../db")).healthCheck();
    if (!health.ok) {
      res.status(500).json({ message: `数据库连接失败: ${health.error}` });
      return;
    }

    // v1.6.0: 统一使用 getMariadbConfig() 读取配置（环境变量 > config.yml）
    const cfg = getMariadbConfig();
    const host = cfg?.host || "127.0.0.1";
    const port = String(cfg?.port || 3306);
    const user = cfg?.user || "projectx_app";
    const password = cfg?.password || "";
    const database = cfg?.database || "projectx";

    // 构建 mysqldump 命令
    const dumpFile = path.join(tmpDir, "dump.sql");
    const args = [
      `--host=${host}`, `--port=${port}`, `--user=${user}`,
      `--databases`, database,
      `--result-file=${dumpFile}`,
      "--add-drop-database", "--add-drop-table",
      "--routines", "--triggers", "--events",
      "--single-transaction", "--quick",
      "--default-character-set=utf8mb4"
    ];

    if (password) {
      args.push(`--password=${password}`);
    }

    try {
      await execFileAsync("mysqldump", args, { timeout: 300_000 });
    } catch (err: any) {
      // 也尝试 mariadb-dump
      console.warn("[Backup] mysqldump failed, trying mariadb-dump:", err.message);
      try {
        await execFileAsync("mariadb-dump", args, { timeout: 300_000 });
      } catch (err2: any) {
        res.status(500).json({ message: `mysqldump 执行失败: ${err2.message}。请确保已安装 MariaDB 客户端工具。` });
        return;
      }
    }

    const fstat = await stat(dumpFile);
    console.log(`[Backup] MariaDB dump: ${(fstat.size / 1024 / 1024).toFixed(1)} MB`);

    // 元数据
    const metadata = {
      version: 2,
      format: "projectx-backup-mariadb",
      generatedAt: new Date().toISOString(),
      files: [{ name: "dump.sql", size: fstat.size }]
    };
    await writeFile(path.join(tmpDir, "metadata.json"), JSON.stringify(metadata, null, 2));

    // 创建 ZIP 响应
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''ProjectX_backup_${timestamp}.zip`);

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("error", (err?: Error) => { console.error("[Backup] Archive error:", err?.message); });
    archive.pipe(res);
    archive.file(path.join(tmpDir, "metadata.json"), { name: "metadata.json" });
    archive.file(dumpFile, { name: "dump.sql" });
    await archive.finalize();

    cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
  } catch (error) {
    console.error("[Backup] MariaDB export failed:", error);
    cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    if (!res.headersSent) {
      res.status(500).json({ message: error instanceof Error ? error.message : "导出失败" });
    }
  }
}

/**
 * MariaDB 恢复 — 上传 ZIP 含 dump.sql → mysql 导入
 */
async function restoreMariadb(req: Request, res: Response): Promise<void> {
  const zipBuffer = req.body as Buffer;
  if (!zipBuffer || !Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    res.status(400).json({ message: "请上传 .zip 备份文件" });
    return;
  }
  if (zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4b) {
    res.status(400).json({ message: "不是有效的 ZIP 格式" });
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `projectx-restore-${crypto.randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    extractZipFromBuffer(zipBuffer, tmpDir);

    const dumpFile = path.join(tmpDir, "dump.sql");
    if (!existsSync(dumpFile)) {
      res.status(400).json({ message: "备份文件中未找到 dump.sql" });
      return;
    }

    // 读取配置
    const cfg = getMariadbConfig();
    const host = cfg?.host || "127.0.0.1";
    const port = String(cfg?.port || 3306);
    const user = cfg?.user || "projectx_app";
    const password = cfg?.password || "";
    const database = cfg?.database || "projectx";

    const args = [`--host=${host}`, `--port=${port}`, `--user=${user}`];
    if (password) args.push(`--password=${password}`);
    args.push(database);

    const dumpContent = await import("node:fs").then(fs => fs.promises.readFile(dumpFile, "utf8"));

    // 使用 mysql 客户端导入
    const { execFile } = await import("node:child_process");

    try {
      // 将 dump.sql 通过 stdin 传给 mysql（使用参数数组，避免 shell 命令注入）
      await new Promise<void>((resolve, reject) => {
        const child = execFile("mysql", args, { maxBuffer: 512 * 1024 * 1024 }, (err) => {
          if (err) reject(err); else resolve();
        });
        child.stdin!.write(dumpContent);
        child.stdin!.end();
      });

      await cleanupDir(tmpDir);
      res.json({ ok: true, message: "数据已恢复！请重启服务器以使更改完全生效。" });
    } catch (err: any) {
      await cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
      res.status(500).json({ message: `mysql 导入失败: ${err.message}` });
    }
  } catch (error) {
    console.error("[Restore] MariaDB import failed:", error);
    await cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    res.status(500).json({ message: error instanceof Error ? error.message : "导入失败" });
  }
}

/**
 * 递归复制目录
 */
async function copyDirectory(
  src: string,
  dest: string,
  filter: (filePath: string) => boolean
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (!filter(srcPath)) continue;
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath, filter);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

/**
 * 移动目录（重命名）
 */
async function moveDir(src: string, dest: string): Promise<void> {
  try {
    await copyDirectory(src, dest, () => true);
    await rm(src, { recursive: true, force: true });
  } catch (err) {
    // 移动失败：保留原目录，但向上抛错让调用方感知（恢复流程中 moveDir 失败应中止）
    console.warn(`[Backup] moveDir 失败 (src=${src}, dest=${dest}):`, err);
    throw err;
  }
}

/**
 * 从 Buffer 解压 ZIP 到目标目录（使用 adm-zip，全内存操作，稳定可靠）
 */
function extractZipFromBuffer(zipBuffer: Buffer, destDir: string): void {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  for (const entry of entries) {
    // 安全检查：防止路径穿越攻击
    const relativePath = path.normalize(entry.entryName).replace(/^[\\/]+/, "");
    const resolvedDest = path.resolve(destDir);
    const safePath = path.join(resolvedDest, relativePath);
    const rel = path.relative(resolvedDest, safePath);
    // 拒绝解析到目标目录之外的条目（防止前缀绕过，如 destDir-evil）
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    if (entry.isDirectory) {
      mkdirSync(safePath, { recursive: true });
    } else {
      mkdirSync(path.dirname(safePath), { recursive: true });
      writeFileSync(safePath, entry.getData());
    }
  }
}

/**
 * 清理临时目录
 */
async function cleanupDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[Backup] 清理临时目录失败 (${dirPath}):`, err);
  }
}

export default router;
