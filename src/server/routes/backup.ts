import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { ZipArchive } from "archiver";
import { createReadStream, createWriteStream, existsSync, rmSync } from "node:fs";
import { mkdir, open, readdir, copyFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { authMiddleware, requirePermission } from "../middleware/auth";
import { extractZipFileWithinBudget, RestoreZipError } from "../services/restoreZip";
import {
  MAX_RESTORE_ZIP_ENTRIES,
  MAX_RESTORE_ZIP_ENTRY_BYTES,
  MAX_RESTORE_ZIP_TOTAL_BYTES,
} from "../../shared/restoreZipLimits";
import { activeFeedbackTempFiles, beginFeedbackMaintenance, invalidateFeedbackStorageUsage, withFeedbackMutationLock } from "../lib/feedbackStorage";
// 备份要在数据库快照前收敛 `feedback/_trash`，与反馈删除共用同一份核对逻辑。
import { reconcileFeedbackTrashLocked, resetFeedbackRuntimeStateAfterRestore } from "./feedback";
import { sanitizeOpsMessage } from "../lib/opsErrorMessage";
import { PERMISSIONS, initPermissionCache, invalidatePermissionCache } from "../auth/permissions";
import { closeDatabase, getDatabase, getMysqlDb, getMariadbConfig, resolveAnswerCardDataDir, resolveProjectDbPath, resolveScannerDbPath, detectDialect, ensureDefaultAdmin, removeBootstrapAdminFile } from "../db";
import { closeDb } from "../../apps/answer-card/server/database";
import { seedDemoData, clearDemoData } from "../services/DemoDataService";
import { DEMO_IMPORT_PRODUCTION_CONFIRM } from "../services/demo/demoDataPolicy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const router = Router();

// 管理员权限
router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

// 恢复上传改为流式落盘：合法备份可能包含反馈附件（默认 8 GiB），不能再按 128 MiB
// 全量读进内存。上限与解压总量预算一致，另留 64 MiB 给 ZIP 头与不可压缩数据的余量。
const MEBIBYTE = 1024 * 1024;
export const RESTORE_ZIP_UPLOAD_LIMIT_BYTES = MAX_RESTORE_ZIP_TOTAL_BYTES + 64 * MEBIBYTE;

type RestoreRequest = Request & { restoreZipPath?: string; releaseRestoreGuard?: () => void };

// 同一时间只允许一个恢复任务：每个请求最多保留一份备份 ZIP + 一份解压树，
// 并发恢复会在临时盘上叠加多份十几 GiB 的副本。
let restoreInProgress = false;

const receiveRestoreZip: RequestHandler = (req, res, next) => {
  if (!req.is("application/zip")) {
    res.status(400).json({ message: "请选择 .zip 备份文件。" });
    return;
  }
  const limitMessage = `备份文件不能超过 ${Math.round(RESTORE_ZIP_UPLOAD_LIMIT_BYTES / MEBIBYTE)} MiB`;
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > RESTORE_ZIP_UPLOAD_LIMIT_BYTES) {
    res.status(413).json({ message: limitMessage });
    return;
  }
  if (restoreInProgress) {
    res.status(409).json({ message: "已有备份恢复任务正在进行，请稍后重试" });
    return;
  }
  restoreInProgress = true;
  const state = req as RestoreRequest;
  let handedOff = false;
  let guardHeld = true;
  const releaseGuard = (): void => {
    if (!guardHeld) return;
    guardHeld = false;
    restoreInProgress = false;
  };
  state.releaseRestoreGuard = releaseGuard;

  const target = path.join(os.tmpdir(), `projectx-restore-upload-${crypto.randomUUID()}.zip`);
  const cleanup = (): void => { void rm(target, { force: true }).catch(() => undefined); };
  const out = createWriteStream(target);
  let received = 0;
  let settled = false;
  const abortUpload = (status: number, message: string): void => {
    if (settled) return;
    settled = true;
    req.unpipe(out);
    out.destroy();
    req.resume();
    if (!res.headersSent && !res.destroyed) res.status(status).json({ message });
    cleanup();
    releaseGuard();
  };

  // 上传阶段一旦断连就中止并释放闸门：不能留给稍后的 finish 再调用 next()，
  // 否则第二份恢复可能已经拿到闸门，第一份却又继续执行。
  res.once("close", () => {
    if (handedOff) return;
    abortUpload(400, "上传中断，请重新选择备份文件");
  });
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > RESTORE_ZIP_UPLOAD_LIMIT_BYTES) abortUpload(413, limitMessage);
  });
  req.on("aborted", () => abortUpload(400, "上传中断，请重新选择备份文件"));
  req.on("error", () => abortUpload(400, "上传中断，请重新选择备份文件"));
  out.on("error", (err) => {
    console.error("[Restore] 备份文件落盘失败:", err);
    abortUpload(500, "备份文件暂存失败，请稍后重试");
  });
  out.on("finish", () => {
    if (settled) return;
    settled = true;
    handedOff = true;
    state.restoreZipPath = target;
    next();
  });
  req.pipe(out);
};

async function revokeAllRestoreSessions(): Promise<void> {
  try {
    const { authService } = await import("../services/AuthService");
    authService.revokeAllTokens();
  } catch (e) {
    console.error("[Restore] 吊销恢复前会话失败:", e);
  }
}

/**
 * 先把备份里的 data 树复制到同卷暂存目录：复制失败（例如磁盘满）时数据库还没动，
 * 直接中止恢复即可，不会出现「库已换、原卷 / 答案页 / 反馈附件缺失」。
 */
async function stageRestoredDataDir(bakDataDir: string, dataDir: string): Promise<string | null> {
  if (!existsSync(bakDataDir)) return null;
  const staging = path.join(path.dirname(dataDir), `answer-card.restore.${crypto.randomUUID()}`);
  try {
    await copyDirectory(bakDataDir, staging, () => true);
    return staging;
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/** 库已经替换后用两次同卷 rename 换树；第二次失败时把旧树挪回去，避免只留下半套数据。 */
async function swapRestoredDataDir(dataDir: string, staging: string | null, suffix: number): Promise<void> {
  if (!staging) return;
  const backupDir = path.join(path.dirname(dataDir), `answer-card.bak.${suffix}`);
  const movedOld = existsSync(dataDir);
  if (movedOld) await rename(dataDir, backupDir);
  try {
    await rename(staging, dataDir);
  } catch (err) {
    if (movedOld) {
      try {
        await rename(backupDir, dataDir);
      } catch (restoreErr) {
        console.error("[Restore] 换树失败后恢复旧数据目录也失败:", restoreErr);
      }
    }
    throw err;
  }
}

async function discardStagingDir(staging: string | null): Promise<void> {
  if (!staging) return;
  await rm(staging, { recursive: true, force: true }).catch((err) => {
    console.warn("[Restore] 清理暂存数据目录失败:", err);
  });
}

async function hasZipMagic(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    return bytesRead === 2 && head[0] === 0x50 && head[1] === 0x4b;
  } finally {
    await handle.close();
  }
}

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

/** 只跳过已经单独备份的系统数据库及其 sidecar，不能按扩展名误伤反馈附件。 */
function isSeparatelyBackedUpDbFile(filePath: string, dbPaths: string[]): boolean {
  const resolved = path.resolve(filePath);
  const comparable = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return dbPaths.some((dbPath) => {
    const db = path.resolve(dbPath);
    const dbComparable = process.platform === "win32" ? db.toLowerCase() : db;
    return comparable === dbComparable
      || comparable === `${dbComparable}-shm`
      || comparable === `${dbComparable}-wal`;
  });
}

/** 任何 `_tmp` 临时目录与反馈 `_trash` 都不属于备份视图：前者可能有半截文件，
 *  后者在备份前已按数据库收敛（仍存在的记录移回原位、无记录的残留删除）。 */
function isDataTreeTransientPath(filePath: string, dataDir: string): boolean {
  const rel = path.relative(path.resolve(dataDir), path.resolve(filePath));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts.includes("_tmp")) return true;
  return parts[0] === "feedback" && parts[1] === "_trash";
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

    const projectxDbPath = getProjectXDbPath();
    const projectxBak = path.join(tmpDir, "projectx.db");
    const scannerDbPath = getScannerDbPath();
    const scannerBak = path.join(tmpDir, "scanner.db");
    const dataDir = getDataDir();
    const dataBakDir = path.join(tmpDir, "data", "answer-card");

    // 数据库快照与附件目录复制必须处于同一反馈视图：期间不允许提交或删除反馈，
    // 否则快照里的附件记录可能在目录复制前被删除，备份成功却缺少文件。
    await withFeedbackMutationLock(async () => {
      // 先把 _trash 收敛到与数据库一致：仍存在的记录移回原位，已删记录的残骸清掉，
      // 之后只复制正式附件目录，不会把删除残骸或悬空目录带进备份。
      if (!(await reconcileFeedbackTrashLocked())) {
        // 暂存目录没能与数据库对齐时直接中止：此时导出会留下指向缺失附件的元数据。
        throw new Error("反馈暂存目录核对失败，已中止备份");
      }

      // 1. 备份 projectx.db（通过 VACUUM INTO 创建干净的副本）
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
      if (existsSync(dataDir)) {
        const separatelyBackedUp = [getProjectXDbPath(), getScannerDbPath()];
        await copyDirectory(
          dataDir,
          dataBakDir,
          (filePath: string) => !isSeparatelyBackedUpDbFile(filePath, separatelyBackedUp) && !isDataTreeTransientPath(filePath, dataDir)
        );
        metadata.files.push({ name: "data/answer-card/", size: 0 });
      }
    });

    // 4. 写入 metadata
    await writeFile(path.join(tmpDir, "metadata.json"), JSON.stringify(metadata, null, 2));
    await assertBackupFitsRestoreBudget(tmpDir);

    // 5. 创建 ZIP（archiver v8 ESM: new ZipArchive）
    const archive = new ZipArchive({ zlib: { level: 6 } });

    archive.on("error", (err?: Error) => {
      console.error("[Backup] Archive error:", err?.message);
      // 已经 pipe 到响应后无法再改状态码：直接销毁连接，避免客户端把截断 ZIP 当成功。
      if (!res.destroyed) res.destroy(err);
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

    // 添加 data 目录：只留一个数据根标记，恢复侧靠它判断备份是否包含 data/answer-card；
    // 每个反馈 UUID 目录不再单独写条目，避免占用恢复条目预算。
    if (existsSync(dataBakDir)) {
      archive.append(Buffer.alloc(0), { name: "data/answer-card/" });
      await addFilesToArchive(archive, dataBakDir, "data/answer-card");
    }

    await archive.finalize();

    // 清理临时文件
    cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
  } catch (error) {
    console.error("[Backup] Export failed:", error);
    cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    if (!res.headersSent) {
      respondOpsFailure(res, error, "导出失败");
    } else if (!res.destroyed) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
});

/**
 * POST /api/db/restore
 * 导入 ZIP 恢复数据（raw binary upload，不走 multipart）
 */
router.post("/restore", receiveRestoreZip, async (req, res) => {
  try {
    await restoreUploadedZip(req, res);
  } finally {
    (req as RestoreRequest).releaseRestoreGuard?.();
  }
});

async function restoreUploadedZip(req: Request, res: Response): Promise<void> {
  const zipPath = (req as RestoreRequest).restoreZipPath;
  if (!zipPath) {
    res.status(400).json({ message: "请选择 .zip 备份文件。" });
    return;
  }
  const dialect = detectDialect();
  if (dialect === "mariadb") {
    await restoreMariadb(req, res, zipPath);
    return;
  }

  if (!(await hasZipMagic(zipPath).catch(() => false))) {
    await rm(zipPath, { force: true }).catch(() => undefined);
    res.status(400).json({ message: "所选文件不是有效的 ZIP 备份，请重新选择。" });
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `projectx-restore-${crypto.randomUUID()}`);
  const dataDir = getDataDir();
  const bakDataDir = path.join(tmpDir, "data", "answer-card");
  let staging: string | null = null;
  let dbReplaced = false;
  let endMaintenance: (() => void) | null = null;
  try {
    await mkdir(tmpDir, { recursive: true });

    // 逐条目流式解压（条目名越界与解压预算见 services/restoreZip.ts，安全 R43）
    await extractZipFileWithinBudget(zipPath, tmpDir);
    await rm(zipPath, { force: true }).catch(() => undefined);

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

    // 先把备份里的 data 树复制到同卷暂存目录；复制失败时数据库还没动，整体中止即可。
    staging = await stageRestoredDataDir(bakDataDir, dataDir);

    // 恢复会替换数据库与 data/answer-card（含 feedback/）：与反馈提交 / 删除共用同一把锁，
    // 避免并发上传把附件写进即将被移走的目录，或删除在恢复中途改动附件树。
    // 同时关闭新的 multipart 上传；已经在写 _tmp 的请求等它结束后再恢复。
    endMaintenance = beginFeedbackMaintenance();
    if (activeFeedbackTempFiles().size > 0) {
      await cleanupDir(tmpDir);
      res.status(409).json({ message: "有反馈附件正在上传，请稍后重试恢复" });
      return;
    }
    await withFeedbackMutationLock(async () => {
      // 1. 备份当前数据
      const backupSuffix = Date.now();
      const projectxDbPath = getProjectXDbPath();
      const scannerDbPath = getScannerDbPath();

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
      dbReplaced = true;

      // 恢复后重新引导管理员账号（#185 安全模型 + R01 整改）：先删掉当前引导文件，
      // 让 ensureDefaultAdmin() 以「文件缺失」判定口令事实源不可用——
      // 还原出的库若仍停留在引导态，会换发一个新的随机一次性口令并写入 bootstrap-admin.txt；
      // 若还原出的库已完成首次改密，则口令与改密标记都不受影响（只清理泄露过的引导文件）。
      try {
        removeBootstrapAdminFile();
        await ensureDefaultAdmin();
      } catch (e) {
        console.warn("[Restore] 管理员再引导失败（可重启服务自动修复）:", e);
      }

      // 恢复替换了整库账号，恢复前的 Token / 媒体票据会按数字 userId 命中新账号：
      // 无条件吊销全部会话与票据，所有用户都必须重新登录。
      await revokeAllRestoreSessions();

      // 恢复 scanner.db（如果有）
      const scannerBak = path.join(tmpDir, "scanner.db");
      if (existsSync(scannerBak)) {
        await copyFile(scannerBak, scannerDbPath);
      }

      // 恢复 data/answer-card/ 目录：暂存树已在库替换前复制并校验，这里只做两次同卷 rename。
      await swapRestoredDataDir(dataDir, staging, backupSuffix);
      // 备份不含 feedback/_tmp：替换数据树后让反馈模块按新目录重新初始化。
      resetFeedbackRuntimeStateAfterRestore();

      // 恢复可能替换 roles 表：先清空启动时的权限缓存，再按新库重载；失败时缓存保持为空，
      // 回落到内置默认角色，不会继续用旧权限矩阵放行。
      invalidatePermissionCache();
      try {
        await initPermissionCache();
      } catch (e) {
        console.error("[Restore] 重新加载角色权限失败，已回落到默认权限:", e);
      }

      // 在锁内失效：放开锁之前新基线已经生效，后到的上传不会读到恢复前的占盘。
      invalidateFeedbackStorageUsage();
    });

    // 清理临时文件
    await cleanupDir(tmpDir);

    res.json({
      ok: true,
      message: "数据已恢复！请重启服务器以使更改完全生效。"
    });
  } catch (error) {
    console.error("[Restore] Import failed:", error);
    await cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    respondOpsFailure(res, error, "导入失败");
  } finally {
    // 校验失败（缺 metadata / projectx.db）、维护闸门 409 与异常路径都要清掉解压目录。
    await cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    await discardStagingDir(staging);
    await rm(zipPath, { force: true }).catch(() => undefined);
    endMaintenance?.();
    if (dbReplaced) await revokeAllRestoreSessions();
    // 附件树已被替换（或可能被部分移动），用量基线必须重扫。
    invalidateFeedbackStorageUsage();
  }
}

/**
 * POST /api/db/import-demo
 * 一键导入演示测试数据（「演示-」前缀，幂等，不覆盖现有数据，无需重启）
 * 支持 SQLite 与 MariaDB 双方言（DemoDataService 已双后端化）。
 *
 * 鉴权：路由级 requirePermission(USER_MANAGE) 已过滤非管理员；此路由额外要求
 * SYSTEM_MANAGE「系统维护（数据清理、归档等）」权限，作为「最高权限管理员」语义闸口。
 * 当前仅 admin（持 "*" 通配）能通过；未来若要拆分管理子角色，SYSTEM_MANAGE 可单独授予。
 *
 * 安全 R33：库里已有真实数据时必须带 `confirm: "IMPORT_DEMO_INTO_PRODUCTION"` 才执行，
 * 否则 409 —— 权限够不等于「知道自己在往生产库里塞 16 个演示账号」。
 * 演示教师口令每次导入随机换发，只在这一次的响应里出现（不再回显文档里的固定口令）。
 */
router.post("/import-demo", requirePermission(PERMISSIONS.SYSTEM_MANAGE), async (req: Request, res: Response) => {
  try {
    const confirm = typeof req.body?.confirm === "string" ? req.body.confirm.trim() : "";
    const stats = await seedDemoData({ confirmedProductionImport: confirm === DEMO_IMPORT_PRODUCTION_CONFIRM });
    const credentials = stats.teacherCredentials
      .map((c) => `${c.username} / ${c.password}`)
      .join("，");
    const credentialNote = stats.teacherCredentials.some((c) => c.fixed)
      ? `⚠️ 当前使用公开文档里的固定演示口令（PROJECTX_DEMO_FIXED_CREDENTIALS 已打开），仅限隔离测试环境。`
      : `演示教师口令本次随机生成、只显示这一次：${credentials}（也已存入账号的「初始密码」，可在账号导出里查回）。`;
    const studentNote = stats.studentPasswordIsStudentNumber
      ? "演示学生口令＝学号（固定凭据模式）。"
      : "演示学生口令随机生成，可在学生账号导出里查回。";
    res.json({
      ok: true,
      message: `演示数据已重置并重新导入：${stats.exams} 场考试 / 16 名学生 / ${stats.groups} 个合集。`
        + `${credentialNote}${studentNote}`
        + `⚠️ 原有「演示-」前缀数据（含在其上完成的阅卷/改分）会被清空并更换考试 ID；演示账号只应存在于测试环境，生产库请导入后尽快用「清除演示数据」移除。`,
      stats: {
        ...stats,
        // 口令只在 message 里出现一次；stats 里留用户名与「是否固定口令」即可，
        // 避免同一份明文口令在响应体里出现两遍（前端日志/抓包都会原样带走）。
        teacherCredentials: stats.teacherCredentials.map(({ username, fixed }) => ({ username, fixed })),
      },
    });
  } catch (error) {
    const status = typeof (error as any)?.status === "number" ? (error as any).status : 500;
    const code = typeof (error as any)?.code === "string" ? (error as any).code : undefined;
    if (status !== 500) {
      // 409 是「本次导入被闸门拒绝、库里没动过」，不是失败到需要看日志的程度：把原因原样交给前端。
      console.warn(`[DemoData] 导入被拒绝（${code ?? status}）:`, error instanceof Error ? error.message : error);
      res.status(status).json({
        message: error instanceof Error ? error.message : "演示数据导入被拒绝",
        code,
        confirm: (error as any)?.confirm,
      });
      return;
    }
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
      res.status(500).json({ message: `数据库连接失败: ${sanitizeOpsMessage(health.error, { fallback: "数据库连接失败，请查看服务端日志" })}` });
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

    // MariaDB 模式下答题卡原卷（papers/）与教师答案页（answer-keys/）仍落磁盘，
    // 只导 dump.sql 会让恢复后的 exams 指向已不存在的文件（学生端原卷/答案页全空）。
    const dataDir = getDataDir();
    const dataBakDir = path.join(tmpDir, "data", "answer-card");

    // mysqldump 与附件目录复制必须处于同一反馈视图：期间不允许提交或删除反馈，
    // 否则 dump 里的附件记录可能在目录复制前被删除，备份成功却缺少文件。
    await withFeedbackMutationLock(async () => {
      if (!(await reconcileFeedbackTrashLocked())) {
        // 暂存目录没能与数据库对齐时直接中止：此时导出会留下指向缺失附件的元数据。
        throw new Error("反馈暂存目录核对失败，已中止备份");
      }
      try {
        await execFileAsync("mysqldump", args, { timeout: 300_000 });
      } catch (err: any) {
        // 也尝试 mariadb-dump
        console.warn("[Backup] mysqldump failed, trying mariadb-dump:", err.message);
        try {
          await execFileAsync("mariadb-dump", args, { timeout: 300_000 });
        } catch (err2: any) {
          res.status(500).json({
            // 报错里的 `--result-file=<绝对路径>` 与账号信息不外发（安全 R25）
            message: `mysqldump 执行失败: ${sanitizeOpsMessage(err2?.message, { fallback: "导出失败" })}。请确保已安装 MariaDB 客户端工具。`,
          });
          return;
        }
      }

      if (existsSync(dataDir)) {
        const separatelyBackedUp = [getProjectXDbPath(), getScannerDbPath()];
        await copyDirectory(
          dataDir,
          dataBakDir,
          (filePath: string) => !isSeparatelyBackedUpDbFile(filePath, separatelyBackedUp) && !isDataTreeTransientPath(filePath, dataDir)
        );
      }
    });
    if (res.headersSent) return;

    const fstat = await stat(dumpFile);
    console.log(`[Backup] MariaDB dump: ${(fstat.size / 1024 / 1024).toFixed(1)} MB`);

    // 元数据
    const metadata = {
      version: 2,
      format: "projectx-backup-mariadb",
      generatedAt: new Date().toISOString(),
      files: [
        { name: "dump.sql", size: fstat.size },
        ...(existsSync(dataBakDir) ? [{ name: "data/answer-card/", size: 0 }] : []),
      ]
    };
    await writeFile(path.join(tmpDir, "metadata.json"), JSON.stringify(metadata, null, 2));
    await assertBackupFitsRestoreBudget(tmpDir);

    // 创建 ZIP 响应
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''ProjectX_backup_${timestamp}.zip`);

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("error", (err?: Error) => {
      console.error("[Backup] Archive error:", err?.message);
      if (!res.destroyed) res.destroy(err);
    });
    archive.pipe(res);
    archive.file(path.join(tmpDir, "metadata.json"), { name: "metadata.json" });
    archive.file(dumpFile, { name: "dump.sql" });
    if (existsSync(dataBakDir)) {
      archive.append(Buffer.alloc(0), { name: "data/answer-card/" });
      await addFilesToArchive(archive, dataBakDir, "data/answer-card");
    }
    await archive.finalize();

    cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
  } catch (error) {
    console.error("[Backup] MariaDB export failed:", error);
    cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    if (!res.headersSent) {
      respondOpsFailure(res, error, "导出失败");
    } else if (!res.destroyed) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
}

/**
 * MariaDB 恢复 — 上传 ZIP 含 dump.sql → mysql 导入
 */
async function restoreMariadb(req: Request, res: Response, zipPath: string): Promise<void> {
  if (!(await hasZipMagic(zipPath).catch(() => false))) {
    await rm(zipPath, { force: true }).catch(() => undefined);
    res.status(400).json({ message: "所选文件不是有效的 ZIP 备份，请重新选择。" });
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `projectx-restore-${crypto.randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    await extractZipFileWithinBudget(zipPath, tmpDir);
    await rm(zipPath, { force: true }).catch(() => undefined);

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

    // 使用 mysql 客户端导入；dump.sql 逐块送入 stdin，不再先把整份 SQL 读进内存。
    const { execFile } = await import("node:child_process");

    const dataDir = getDataDir();
    const bakDataDir = path.join(tmpDir, "data", "answer-card");
    let staging: string | null = null;
    let restoreImportStarted = false;
    let endMaintenance: (() => void) | null = null;
    try {
      // 先把备份里的 data 树复制到同卷暂存目录：复制失败（磁盘满等）时 SQL 还没导入，
      // 直接中止即可，不会出现「库已换、原卷 / 答案页 / 反馈附件缺失」。
      staging = await stageRestoredDataDir(bakDataDir, dataDir);

      // 导入数据库与替换 data 目录同样与反馈写操作互斥：否则并发提交可能在 SQL 导入后
      // 再写入附件行，随后其目录被换走，留下指向缺失文件的元数据。
      // 同时关闭新的 multipart 上传；已经在写 _tmp 的请求等它结束后再恢复。
      endMaintenance = beginFeedbackMaintenance();
      if (activeFeedbackTempFiles().size > 0) {
        await cleanupDir(tmpDir);
        res.status(409).json({ message: "有反馈附件正在上传，请稍后重试恢复" });
        return;
      }
      await withFeedbackMutationLock(async () => {
        // 将 dump.sql 通过 stdin 传给 mysql（使用参数数组，避免 shell 命令注入）
        restoreImportStarted = true;
        await new Promise<void>((resolve, reject) => {
          const child = execFile("mysql", args, { timeout: 300_000, killSignal: "SIGKILL" }, (err) => {
            if (err) reject(err); else resolve();
          });
          const input = createReadStream(dumpFile);
          input.on("error", (err) => {
            child.kill();
            reject(err);
          });
          // mysql 提前退出时 stdin 会 EPIPE；真正的失败原因由 execFile 回调报告。
          child.stdin!.on("error", () => undefined);
          input.pipe(child.stdin!);
        });

        // SQL 导入成功即已替换账号库：先吊销恢复前的全部会话，再做可失败的换树 / 再引导。
        await revokeAllRestoreSessions();

        // 恢复磁盘资产（原卷 / 教师答案页）：暂存树已在 SQL 导入前复制完成，
        // 这里只做两次同卷 rename；备份里没有该目录时保持现状（兼容旧备份）。
        await swapRestoredDataDir(dataDir, staging, Date.now());
        // 备份不含 feedback/_tmp：替换数据树后让反馈模块按新目录重新初始化。
        resetFeedbackRuntimeStateAfterRestore();

        // 与 SQLite 还原分支同口径（#185 + R01）：还原出来的库可能带着另一台机器的
        // 引导态口令，本机 bootstrap-admin.txt 会对不上而把管理员锁死。这里主动清理并
        // 重新引导：引导态库换发新的随机口令写回引导文件；已改密库口令与标记都不受影响。
        try {
          removeBootstrapAdminFile();
          await ensureDefaultAdmin();
        } catch (e) {
          console.warn("[Restore] MariaDB 管理员再引导失败（可重启服务自动修复）:", e);
        }

        // 恢复可能替换 roles 表：清空启动时的权限缓存并按新库重载。
        invalidatePermissionCache();
        try {
          await initPermissionCache();
        } catch (e) {
          console.error("[Restore] MariaDB 重新加载角色权限失败，已回落到默认权限:", e);
        }

        // 在锁内失效：放开锁之前新基线已经生效，后到的上传不会读到恢复前的占盘。
        invalidateFeedbackStorageUsage();
      });

      await cleanupDir(tmpDir);
      res.json({ ok: true, message: "数据已恢复！请重启服务器以使更改完全生效。" });
    } catch (err: any) {
      console.error("[Restore] MariaDB mysql 导入失败:", err);
      await cleanupDir(tmpDir).catch((e) => console.warn("[Backup] cleanupDir 异常:", e));
      // mysql 客户端的报错自带 dump 文件绝对路径与 `user@host`，只进日志（安全 R25）
      respondOpsFailure(res, err, "数据库导入失败，请查看服务端日志中的 [Restore] 记录");
    } finally {
      await discardStagingDir(staging);
      if (restoreImportStarted) await revokeAllRestoreSessions();
      endMaintenance?.();
      // 附件树可能已被部分替换，缓存基线一律重扫。
      invalidateFeedbackStorageUsage();
    }
  } catch (error) {
    console.error("[Restore] MariaDB import failed:", error);
    await cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    respondOpsFailure(res, error, "导入失败");
  } finally {
    // 缺 dump.sql 的 400 与解压失败路径同样不能留下解压目录。
    await cleanupDir(tmpDir).catch((err) => console.warn("[Backup] cleanupDir 异常:", err));
    // 交出请求后 ZIP 由恢复任务负责删除：客户端中途断开不会提前把文件删掉。
    await rm(zipPath, { force: true }).catch(() => undefined);
  }
}

/**
 * 备份预算前置校验：导出成功但恢复时被条目数 / 体积 / 单条上限拒绝的 ZIP 没有意义。
 * 答案页、答题卡资源、版式与数据库没有独立聚合配额，只能在导出前按实际产出兜底。
 */
type BackupMeasure = { files: number; bytes: number; largest: number };

async function measureFilesInDir(dir: string): Promise<BackupMeasure> {
  const out: BackupMeasure = { files: 0, bytes: 0, largest: 0 };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = await measureFilesInDir(full);
      out.files += child.files;
      out.bytes += child.bytes;
      out.largest = Math.max(out.largest, child.largest);
    } else if (entry.isFile()) {
      const size = (await stat(full)).size;
      out.files += 1;
      out.bytes += size;
      out.largest = Math.max(out.largest, size);
    }
  }
  return out;
}

async function assertBackupFitsRestoreBudget(stagingDir: string): Promise<void> {
  const measure = await measureFilesInDir(stagingDir);
  const entries = measure.files + 1; // data/answer-card/ 根目录标记
  if (entries > MAX_RESTORE_ZIP_ENTRIES) {
    throw new Error(
      `备份将包含 ${entries} 个条目，超过恢复预算 ${MAX_RESTORE_ZIP_ENTRIES} 个；请先清理原卷、答案页或反馈附件后再导出`
    );
  }
  if (measure.largest > MAX_RESTORE_ZIP_ENTRY_BYTES) {
    throw new Error(
      `备份内单个文件 ${Math.round(measure.largest / MEBIBYTE)} MiB，超过恢复单条预算 `
      + `${Math.round(MAX_RESTORE_ZIP_ENTRY_BYTES / MEBIBYTE)} MiB；请先清理或拆分该文件后再导出`
    );
  }
  if (measure.bytes > MAX_RESTORE_ZIP_TOTAL_BYTES) {
    throw new Error(
      `备份累计约 ${Math.round(measure.bytes / MEBIBYTE)} MiB，超过恢复预算 `
      + `${Math.round(MAX_RESTORE_ZIP_TOTAL_BYTES / MEBIBYTE)} MiB；请先清理数据或多留恢复预算后再导出`
    );
  }
}

/**
 * 只把文件加入 ZIP：目录条目会额外占用恢复侧的条目预算，而解压会自行创建父目录。
 * 这样反馈附件数上限才真正等于备份里的反馈条目数。
 */
async function addFilesToArchive(archive: ZipArchive, dir: string, dest: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const name = `${dest}/${entry.name}`;
    if (entry.isDirectory()) await addFilesToArchive(archive, full, name);
    else if (entry.isFile()) archive.file(full, { name });
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
 * 恢复/导出失败时的统一应答（安全 R25 + R43）。
 *
 *  - `RestoreZipError` 的消息本身就是为对外而写的（只有数量与限额，不含主机路径），原样给出；
 *  - 其余底层错误（copyFile/mysqldump/mysql 导入）几乎必然带绝对路径或数据库账号，
 *    一律走 `sanitizeOpsMessage`，完整原文只进服务端日志。
 */
function respondOpsFailure(res: Response, error: unknown, fallback: string): void {
  if (error instanceof RestoreZipError) {
    res.status(error.status).json({ code: "RESTORE_ZIP_REJECTED", message: error.message });
    return;
  }
  const raw = error instanceof Error ? error.message : "";
  res.status(500).json({ message: sanitizeOpsMessage(raw, { fallback }) });
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
