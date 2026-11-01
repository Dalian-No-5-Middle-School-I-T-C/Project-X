import { analysisCache } from "../services/analysisCache";
import { invalidateSecretKeyCache } from "../lib/field-crypto";
import { failRestoredAiWork } from "../services/aiAnalysisJobs";
import { invalidateAnalysisThresholdsCache } from "../services/analysisConfig";
import { invalidatePaperUsageCache } from "../../apps/answer-card/server/paperQuota";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { ZipArchive } from "archiver";
import { createReadStream, createWriteStream, existsSync, rmSync } from "node:fs";
import { mkdir, open, readdir, copyFile, rename, rm, stat, writeFile, readFile } from "node:fs/promises";
import { finished, pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { authMiddleware, refreshRequestUser, requirePermission } from "../middleware/auth";
import { requestDisconnected, withAnswerCardDataMutationLock } from "../lib/answerCardDataLock";
import { extractZipFileWithinBudget, RestoreZipError } from "../services/restoreZip";
import {
  MAX_RESTORE_ZIP_ENTRIES,
  MAX_RESTORE_ZIP_ENTRY_BYTES,
  MAX_RESTORE_ZIP_TOTAL_BYTES,
} from "../../shared/restoreZipLimits";
import { activeFeedbackTempFiles, beginFeedbackMaintenance, invalidateFeedbackStorageUsage } from "../lib/feedbackStorage";
// 备份要在数据库快照前收敛 `feedback/_trash`，与反馈删除共用同一份核对逻辑。
import { reconcileFeedbackTrashLocked, resetFeedbackRuntimeStateAfterRestore } from "./feedback";
import { sanitizeOpsMessage } from "../lib/opsErrorMessage";
import { PERMISSIONS, initPermissionCache, invalidatePermissionCache, roleHasPermission } from "../auth/permissions";
import { closeDatabase, getDatabase, getMysqlDb, getMariadbConfig, resolveAnswerCardDataDir, resolveProjectDbPath, resolveScannerDbPath, detectDialect, ensureDefaultAdmin, removeBootstrapAdminFile, initializeDatabase, initMariadbSchema } from "../db";
import { closeAdapter } from "../db/mysql";
import { withServiceMaintenance, requireServiceRecovery, ServiceMaintenanceError } from "../lib/serviceTasks";
import { clearRestoreRecoveryState, writeRestoreRecoveryState } from "../lib/restoreRecovery";
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

const receiveRestoreZip: RequestHandler = async (req, res, next) => {
  if (!req.is("application/zip")) { res.status(400).json({ message: "请选择 .zip 备份文件。" }); return; }
  const limitMessage = `备份文件不能超过 ${Math.round(RESTORE_ZIP_UPLOAD_LIMIT_BYTES / MEBIBYTE)} MiB`;
  if (Number(req.headers["content-length"]) > RESTORE_ZIP_UPLOAD_LIMIT_BYTES) {
    res.status(413).json({ message: limitMessage }); return;
  }
  if (restoreInProgress) { res.status(409).json({ message: "已有备份恢复任务正在进行，请稍后重试" }); return; }
  restoreInProgress = true;
  const state = req as RestoreRequest;
  state.releaseRestoreGuard = () => { restoreInProgress = false; };
  const target = path.join(os.tmpdir(), `projectx-restore-upload-${crypto.randomUUID()}.zip`);
  const out = createWriteStream(target, { flags: "wx", mode: 0o600 });
  let received = 0;
  let handedOff = false;
  const abort = () => out.destroy(new Error("上传中断，请重新选择备份文件"));
  const count = (chunk: Buffer) => {
    received += chunk.length;
    if (received <= RESTORE_ZIP_UPLOAD_LIMIT_BYTES) return;
    if (!res.headersSent && !res.destroyed) res.status(413).json({ message: limitMessage });
    out.destroy(new Error(limitMessage));
  };
  req.once("aborted", abort);
  req.once("error", abort);
  res.once("close", abort);
  req.on("data", count);
  try {
    const writing = finished(out, { cleanup: true });
    if (requestDisconnected(req, res)) abort();
    else req.pipe(out);
    await writing;
    if (requestDisconnected(req, res)) return;
    state.restoreZipPath = target;
    handedOff = true;
  } catch (error) {
    console.error("[Restore] 备份文件暂存失败:", error);
    if (!res.headersSent && !res.destroyed) res.status(400).json({ message: "备份上传失败，请重新选择文件" });
  } finally {
    req.unpipe(out);
    req.off("aborted", abort);
    req.off("error", abort);
    req.off("data", count);
    res.off("close", abort);
    if (!handedOff) {
      out.destroy();
      await finished(out, { cleanup: true }).catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      state.releaseRestoreGuard?.();
      req.resume();
    }
  }
  if (handedOff) next();
};

async function revokeAllRestoreSessions(): Promise<void> {
  const { authService } = await import("../services/AuthService");
  authService.revokeAllTokens();
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

/** 数据树换完之后再落 scanner.db。它和 data/answer-card 同目录，提前写进旧树会被一起换走。 */
export async function restoreScannerDatabase(scannerBak: string, scannerDbPath: string): Promise<void> {
  if (!existsSync(scannerBak)) return;
  await mkdir(path.dirname(scannerDbPath), { recursive: true });
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = scannerDbPath + suffix;
    if (existsSync(sidecar)) {
      try { rmSync(sidecar, { force: true }); } catch (err) {
        console.warn(`[Restore] 清理 scanner ${suffix} 失败（继续）:`, err);
      }
    }
  }
  await copyFile(scannerBak, scannerDbPath);
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
/** Revalidate after waiting: a restore may have replaced accounts and revoked tokens. */
async function authorizeDataOperation(req: Request, res: Response): Promise<boolean> {
  if (requestDisconnected(req, res)) return false;
  if (!(await refreshRequestUser(req))) {
    res.status(401).json({ message: "认证令牌无效或已过期" });
    return false;
  }
  if (!req.user || !roleHasPermission(req.user.role_id, PERMISSIONS.USER_MANAGE)) {
    res.status(403).json({ message: "权限不足" });
    return false;
  }
  return !requestDisconnected(req, res);
}

async function copyBackupData(tmpDir: string): Promise<boolean> {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) return false;
  await copyDirectory(dataDir, path.join(tmpDir, "data", "answer-card"), (filePath) =>
    !isSeparatelyBackedUpDbFile(filePath, [getProjectXDbPath(), getScannerDbPath()])
    && !isDataTreeTransientPath(filePath, dataDir));
  return true;
}

/** Only immutable snapshot files are read while the client downloads the ZIP. */
async function sendBackupSnapshot(tmpDir: string, res: Response): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''ProjectX_backup_${timestamp}.zip`);
  const sourceAbort = new AbortController();
  const transfer = pipeline(archive, res);
  // Abort the current file reader too; archiver.abort() does not drain its sources.
  void transfer.catch(() => sourceAbort.abort());
  const appendFile = async (file: string, name: string) => {
    const source = createReadStream(file, { signal: sourceAbort.signal });
    const closed = finished(source, { cleanup: true });
    archive.append(source, { name });
    try { await closed; }
    finally { source.destroy(); await closed.catch(() => undefined); }
  };
  archive.on("warning", (error: Error) => archive.destroy(error));
  try {
    for (const name of ["metadata.json", "projectx.db", "scanner.db", "dump.sql"]) {
      const file = path.join(tmpDir, name);
      if (existsSync(file)) await appendFile(file, name);
    }
    const dataBakDir = path.join(tmpDir, "data", "answer-card");
    if (existsSync(dataBakDir)) {
      archive.append(Buffer.alloc(0), { name: "data/answer-card/" });
      await addFilesToArchive(appendFile, dataBakDir, "data/answer-card");
    }
    void archive.finalize().catch((error: Error) => archive.destroy(error));
    await transfer;
  } finally {
    sourceAbort.abort();
    archive.abort();
    archive.destroy();
    await transfer.catch(() => undefined);
  }
}

router.get("/backup", async (req, res) => {
  const tmpDir = path.join(os.tmpdir(), `projectx-backup-${crypto.randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const ready = await withServiceMaintenance(req, () => withAnswerCardDataMutationLock(async () => {
      if (!(await authorizeDataOperation(req, res))) return false;
      if (!(await reconcileFeedbackTrashLocked())) throw new Error("反馈暂存目录核对失败，已中止备份");
      const maria = detectDialect() === "mariadb";
      const metadata = {
        version: maria ? 2 : 1,
        format: maria ? "projectx-backup-mariadb" : "projectx-backup",
        generatedAt: new Date().toISOString(),
        files: [] as Array<{ name: string; size: number }>,
      };
      if (maria) {
        await dumpMariaDatabase(path.join(tmpDir, "dump.sql"));
        metadata.files.push({ name: "dump.sql", size: (await stat(path.join(tmpDir, "dump.sql"))).size });
      } else {
        // Online backup includes committed WAL contents; copying only the .db file does not.
        await getDatabase().backup(path.join(tmpDir, "projectx.db"));
        metadata.files.push({ name: "projectx.db", size: (await stat(path.join(tmpDir, "projectx.db"))).size });
        const scannerDbPath = getScannerDbPath();
        if (existsSync(scannerDbPath)) {
          closeDb();
          await copyFile(scannerDbPath, path.join(tmpDir, "scanner.db"));
          metadata.files.push({ name: "scanner.db", size: (await stat(path.join(tmpDir, "scanner.db"))).size });
        }
      }
      if (await copyBackupData(tmpDir)) metadata.files.push({ name: "data/answer-card/", size: 0 });
      await writeFile(path.join(tmpDir, "metadata.json"), JSON.stringify(metadata, null, 2));
      await assertBackupFitsRestoreBudget(tmpDir);
      return true;
    }));
    if (ready && !requestDisconnected(req, res)) await sendBackupSnapshot(tmpDir, res);
  } catch (error) {
    console.error("[Backup] Export failed:", error);
    if (!res.headersSent && !res.destroyed) respondOpsFailure(res, error, "导出失败");
    else if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
  } finally {
    await cleanupDir(tmpDir).catch((error) => console.warn("[Backup] cleanupDir 异常:", error));
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

async function replaceSqliteDatabase(source: string, target: string): Promise<void> {
  closeDatabase();
  await closeAdapter();
  await mkdir(path.dirname(target), { recursive: true });
  for (const suffix of ["-wal", "-shm"]) await rm(target + suffix, { force: true });
  await copyFile(source, target);
}

async function reloadRestoredState(regenerateBootstrap = true): Promise<void> {
  invalidateSecretKeyCache();
  await closeAdapter();
  initializeDatabase();
  getMysqlDb();
  await initMariadbSchema();
  if (regenerateBootstrap) {
    removeBootstrapAdminFile();
    await ensureDefaultAdmin();
    await failRestoredAiWork();
  }
  await revokeAllRestoreSessions();
  invalidatePermissionCache();
  await initPermissionCache();
  analysisCache.clear();
  invalidateAnalysisThresholdsCache();
  invalidatePaperUsageCache();
  resetFeedbackRuntimeStateAfterRestore();
  invalidateFeedbackStorageUsage();
  const probe = await getMysqlDb().get("SELECT id FROM users LIMIT 1");
  if (!probe) throw new Error("恢复后的账号数据为空");
}

async function restoreUploadedZip(req: Request, res: Response): Promise<void> {
  const zipPath = (req as RestoreRequest).restoreZipPath;
  if (!zipPath) { res.status(400).json({ message: "请选择 .zip 备份文件。" }); return; }
  const tmpDir = path.join(os.tmpdir(), `projectx-restore-${crypto.randomUUID()}`);
  const dataDir = getDataDir();
  const recoveryDir = path.join(path.dirname(dataDir), `projectx-restore-recovery-${crypto.randomUUID()}`);
  const oldDataDir = path.join(recoveryDir, "data");
  const maria = detectDialect() === "mariadb";
  let staging: string | null = null;
  let preserveRecovery = false;
  let succeeded = false;
  let failure: unknown;
  try {
    if (!(await hasZipMagic(zipPath))) throw new RestoreZipError("所选文件不是有效的 ZIP 备份", 400);
    await mkdir(tmpDir, { recursive: true });
    await extractZipFileWithinBudget(zipPath, tmpDir);
    let metadata: { version?: number };
    try { metadata = JSON.parse(await readFile(path.join(tmpDir, "metadata.json"), "utf8")); }
    catch { throw new RestoreZipError("备份文件格式不正确，缺少有效的 metadata.json"); }
    const databaseFile = path.join(tmpDir, maria ? "dump.sql" : "projectx.db");
    if (!existsSync(databaseFile) || !metadata || ![1, 2].includes(Number(metadata.version))) {
      res.status(400).json({ message: "备份文件格式不正确或数据库类型不匹配" }); return;
    }
    if (!maria) {
      try {
        const candidate = new Database(databaseFile, { readonly: true, fileMustExist: true });
        try { if (candidate.pragma("quick_check", { simple: true }) !== "ok") throw new Error("integrity check failed"); }
        finally { candidate.close(); }
      } catch { throw new RestoreZipError("备份数据库校验失败"); }
    }
    staging = await stageRestoredDataDir(path.join(tmpDir, "data", "answer-card"), dataDir);
    const endFeedbackMaintenance = beginFeedbackMaintenance();
    try {
      if (activeFeedbackTempFiles().size > 0) {
        res.status(409).json({ message: "有反馈附件正在上传，请稍后重试恢复" }); return;
      }
      await withServiceMaintenance(req, () => withAnswerCardDataMutationLock(async () => {
        if (!(await authorizeDataOperation(req, res))) return;
        await mkdir(recoveryDir, { recursive: true });
        const recoveryDatabase = path.join(recoveryDir, maria ? "dump.sql" : "projectx.db");
        if (maria) await dumpMariaDatabase(recoveryDatabase);
        else await getDatabase().backup(recoveryDatabase);
        closeDb();
        const scannerDbPath = getScannerDbPath();
        const hadScannerDb = existsSync(scannerDbPath);
        if (hadScannerDb) await copyFile(scannerDbPath, path.join(recoveryDir, "scanner.db"));
        const bootstrapPath = path.join(path.dirname(getProjectXDbPath()), "bootstrap-admin.txt");
        const bootstrap = existsSync(bootstrapPath) ? await readFile(bootstrapPath) : null;
        if (bootstrap) await writeFile(path.join(recoveryDir, "bootstrap-admin.txt"), bootstrap, { mode: 0o600 });
        const recoveryState = { hadDataDir: existsSync(dataDir), replacesDataDir: staging !== null, hadScannerDb, hadBootstrapFile: bootstrap !== null, phase: "replacing", dialect: maria ? "mariadb" : "sqlite", recoveryDir, dataDir, oldDataDir, projectDb: getProjectXDbPath(), scannerDb: scannerDbPath };
        await writeRestoreRecoveryState(recoveryState);
        let oldMoved = false;
        let newMoved = false;
        try {
          // Close connections before moving a tree that may contain either database.
          closeDatabase();
          await closeAdapter();
          if (staging) {
            if (existsSync(dataDir)) { await rename(dataDir, oldDataDir); oldMoved = true; }
            await rename(staging, dataDir);
            newMoved = true;
          }
          if (maria) await importMariaDatabase(databaseFile);
          else await replaceSqliteDatabase(databaseFile, getProjectXDbPath());
          await restoreScannerDatabase(path.join(tmpDir, "scanner.db"), scannerDbPath);
          await reloadRestoredState();
          await clearRestoreRecoveryState();
        } catch (error) {
          // Roll back both database and files while the service stays in maintenance.
          try {
            closeDb();
            closeDatabase();
            await closeAdapter();
            if (newMoved) await rm(dataDir, { recursive: true, force: true });
            if (oldMoved) await rename(oldDataDir, dataDir);
            if (maria) await importMariaDatabase(recoveryDatabase);
            else await replaceSqliteDatabase(recoveryDatabase, getProjectXDbPath());
            if (hadScannerDb) await restoreScannerDatabase(path.join(recoveryDir, "scanner.db"), scannerDbPath);
            else await rm(scannerDbPath, { force: true });
            await reloadRestoredState(false);
            if (bootstrap) await writeFile(bootstrapPath, bootstrap, { mode: 0o600 });
            else await rm(bootstrapPath, { force: true });
            await clearRestoreRecoveryState();
          } catch (rollbackError) {
            preserveRecovery = true;
            requireServiceRecovery();
            await writeRestoreRecoveryState({ ...recoveryState, phase: "recovery-required" }).catch(() => undefined);
            console.error("[Restore] 回退失败，保持维护状态；恢复材料:", recoveryDir, rollbackError);
          }
          throw error;
        }
        succeeded = true;
      }));
    } finally {
      endFeedbackMaintenance();
    }
  } catch (error) {
    console.error("[Restore] Import failed:", error);
    failure = error;
  } finally {
    await cleanupDir(tmpDir);
    await discardStagingDir(staging);
    await rm(zipPath, { force: true }).catch(() => undefined);
    if (!preserveRecovery) await cleanupDir(recoveryDir);
    invalidateFeedbackStorageUsage();
  }
  if (failure && !res.headersSent && !res.destroyed) respondOpsFailure(res, failure, "导入失败，已尝试恢复原数据，请查看服务端日志");
  else if (succeeded && !res.destroyed) res.json({ ok: true, message: "数据已恢复，请重新登录。" });
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

/** Both normal backup and restore recovery material use the same dump command. */
async function dumpMariaDatabase(dumpFile: string): Promise<void> {
  const cfg = getMariadbConfig();
  const args = [
    `--host=${cfg?.host || "127.0.0.1"}`, `--port=${cfg?.port || 3306}`,
    `--user=${cfg?.user || "projectx_app"}`, "--databases", cfg?.database || "projectx",
    `--result-file=${dumpFile}`, "--add-drop-database", "--add-drop-table",
    "--routines", "--triggers", "--events", "--single-transaction", "--quick", "--default-character-set=utf8mb4",
  ];
  const env = { ...process.env, MYSQL_PWD: cfg?.password || "" };
  try {
    await execFileAsync("mariadb-dump", args, { timeout: 300_000, env });
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    await execFileAsync("mysqldump", args, { timeout: 300_000, env });
  }
}

/** Await child exit and input stream shutdown before releasing the restore task. */
async function importMariaDatabase(dumpFile: string): Promise<void> {
  const cfg = getMariadbConfig();
  const args = [`--host=${cfg?.host || "127.0.0.1"}`, `--port=${cfg?.port || 3306}`, `--user=${cfg?.user || "projectx_app"}`, cfg?.database || "projectx"];
  const env = { ...process.env, MYSQL_PWD: cfg?.password || "" };
  const run = async (command: string) => {
    const input = createReadStream(dumpFile);
    let child: ReturnType<typeof execFile>;
    const exited = new Promise<void>((resolve, reject) => {
      child = execFile(command, args, { timeout: 300_000, killSignal: "SIGKILL", env }, (error) => error ? reject(error) : resolve());
    });
    const writing = pipeline(input, child!.stdin!).catch((error) => { child!.kill("SIGKILL"); throw error; });
    const results = await Promise.allSettled([exited, writing]);
    if (results[0].status === "rejected") throw results[0].reason;
    if (results[1].status === "rejected") throw results[1].reason;
  };
  try { await run("mariadb"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; await run("mysql"); }
}

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
async function addFilesToArchive(appendFile: (file: string, name: string) => Promise<void>, dir: string, dest: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const name = `${dest}/${entry.name}`;
    if (entry.isDirectory()) await addFilesToArchive(appendFile, full, name);
    else if (entry.isFile()) await appendFile(full, name);
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
  if (res.destroyed || res.writableEnded) return;
  if (error instanceof ServiceMaintenanceError) { res.status(409).json({ message: error.message }); return; }
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
