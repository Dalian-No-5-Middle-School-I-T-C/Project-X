import { Router } from "express";
import type { Request, Response } from "express";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readdir, copyFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";

import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { closeDatabase, getDatabase } from "../db";
import { closeDb } from "../../apps/answer-card/server/database";

const nodeRequire = createRequire(import.meta.url);
// archiver 的 CJS 类型声明不兼容 ESM；使用 require 绕过
const archiver: (format: string, options?: Record<string, unknown>) => {
  pipe: (dest: NodeJS.WritableStream) => void;
  file: (filePath: string, options: { name: string }) => void;
  directory: (dirPath: string, prefix: string) => void;
  finalize: () => Promise<void>;
  on: (event: string, handler: (err?: Error) => void) => void;
} = nodeRequire("archiver");
// unzipper 无类型声明
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unzipper: any = nodeRequire("unzipper");

const router = Router();

// 管理员权限
router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

// 上传临时文件（用于导入）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 }  // 512MB
});

/**
 * 计算备份中包含的所有目录和文件大小
 */
function getDataDir(): string {
  const envDir = process.env.ANSWER_CARD_DATA_DIR;
  if (envDir) return path.resolve(envDir);
  return path.join(process.cwd(), "data", "answer-card");
}

function getProjectXDbPath(): string {
  const envPath = process.env.PROJECTX_DB_PATH;
  if (envPath) return path.resolve(envPath);
  return path.join(process.cwd(), "data", "projectx.db");
}

function getScannerDbPath(): string {
  return path.join(getDataDir(), "scanner.db");
}

/**
 * GET /api/db/backup
 * 导出所有数据为 ZIP 下载
 */
router.get("/backup", async (_req: Request, res: Response) => {
  const tmpDir = path.join(os.tmpdir(), `projectx-backup-${crypto.randomUUID()}`);
  const zipFile = path.join(os.tmpdir(), `projectx-backup-${Date.now()}.zip`);

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
        db.exec(`VACUUM INTO '${projectxBak.replace(/\\/g, "\\\\")}'`);
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
      } catch {}
      await copyFile(scannerDbPath, scannerBak);
      const fstat = await stat(scannerBak);
      metadata.files.push({ name: "scanner.db", size: fstat.size });
    }

    // 3. 打包 data/answer-card/ 目录
    const dataDir = getDataDir();
    const dataBakDir = path.join(tmpDir, "data", "answer-card");
    const excludeDirs = new Set(["scans"]);  // 扫描图片可能很大，但用户可能需要
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

    // 5. 创建 ZIP
    const archive = archiver("zip", { zlib: { level: 6 } });

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
    cleanupDir(tmpDir).catch(() => {});
  } catch (error) {
    console.error("[Backup] Export failed:", error);
    cleanupDir(tmpDir).catch(() => {});
    if (!res.headersSent) {
      res.status(500).json({ message: error instanceof Error ? error.message : "导出失败" });
    }
  }
});

/**
 * POST /api/db/restore
 * 导入 ZIP 恢复数据
 */
router.post("/restore", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ message: "请上传 .zip 备份文件" });
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `projectx-restore-${crypto.randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });

    // 写入上传的 ZIP 到临时文件
    const zipPath = path.join(tmpDir, "backup.zip");
    await writeFile(zipPath, req.file.buffer);

    // 解压 ZIP
    await extractZip(zipPath, tmpDir);

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

    // 2. 关闭数据库连接
    try {
      closeDatabase();  // 主 DB
    } catch (e) { console.warn("[Restore] closeDatabase:", e); }
    try {
      closeDb();  // scanner DB
    } catch (e) { console.warn("[Restore] closeDb:", e); }

    // 3. 替换文件
    await copyFile(projectxBak, projectxDbPath);

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
    await cleanupDir(tmpDir).catch(() => {});
    res.status(500).json({ message: error instanceof Error ? error.message : "导入失败" });
  }
});

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
  } catch {
    // 如果重命名失败，保留原目录
  }
}

/**
 * 解压 ZIP 到目标目录
 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const directory = await unzipper.Open.file(zipPath);
  for (const file of directory.files) {
    // 安全检查：防止路径穿越攻击
    const relativePath = path.normalize(file.path).replace(/^[\\/]+/, "");
    const safePath = path.join(destDir, relativePath);
    // 确保不逃逸到 destDir 之外
    if (!safePath.startsWith(path.resolve(destDir))) {
      continue;
    }
    if (file.type === "Directory") {
      mkdirSync(safePath, { recursive: true });
    } else {
      mkdirSync(path.dirname(safePath), { recursive: true });
      const content = await file.buffer();
      await writeFile(safePath, content);
    }
  }
}

/**
 * 清理临时目录
 */
async function cleanupDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
}

export default router;
