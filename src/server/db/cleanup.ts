import { getMysqlDb } from "./index";
import type { DbAdapter } from "./mysql";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rmSync } from "node:fs";

/**
 * 30天数据保留清理任务
 *
 * 清理规则：
 * - scan_records：超过保留期（默认30天）的记录，删除原始图片文件，保留成绩数据
 * - objective_recognitions：同步清理过期的识别结果
 * - exam_archives：归档记录不自动删除，仅标记
 *
 * 执行方式：
 * - 手动调用：npx tsx src/server/db/cleanup.ts
 * - 定时任务：由服务启动时注册 setInterval
 */

interface CleanupResult {
  scanRecordsDeleted: number;
  recognitionRecordsDeleted: number;
  filesDeleted: number;
  errors: string[];
}

/**
 * 清理过期的扫描记录和识别结果
 */
export async function runCleanup(retainDays: number = 30): Promise<CleanupResult> {
  const db = getMysqlDb();
  const result: CleanupResult = {
    scanRecordsDeleted: 0,
    recognitionRecordsDeleted: 0,
    filesDeleted: 0,
    errors: []
  };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retainDays);
  const cutoffStr = cutoffDate.toISOString();

  console.log(`[Cleanup] 开始清理 ${retainDays} 天前的数据（截止：${cutoffDate.toLocaleDateString()}）`);

  try {
    await db.transaction(async (tx) => {
      // 1. 查找过期的扫描记录
      const expiredRecords = await tx.all(
        `SELECT id, file_path, batch_id FROM scan_records
         WHERE expires_at IS NOT NULL AND expires_at < ?`,
        cutoffStr
      ) as Array<{ id: number; file_path: string | null; batch_id: number }>;

      console.log(`[Cleanup] 找到 ${expiredRecords.length} 条过期扫描记录`);

      // 2. 删除原始图片文件
      for (const record of expiredRecords) {
        if (record.file_path) {
          try {
            const fullPath = path.isAbsolute(record.file_path)
              ? record.file_path
              : path.resolve(process.cwd(), record.file_path);
            rmSync(fullPath, { force: true });
            result.filesDeleted++;
          } catch (error) {
            const msg = `删除文件失败 ${record.file_path}: ${error instanceof Error ? error.message : String(error)}`;
            result.errors.push(msg);
            console.warn(`[Cleanup] ${msg}`);
          }
        }
      }

      // 3. 删除过期的识别结果（先删子表）
      const deletedRecognitions = await tx.run(
        `DELETE FROM objective_recognitions
         WHERE record_id IN (
           SELECT id FROM scan_records WHERE expires_at IS NOT NULL AND expires_at < ?
         )`,
        cutoffStr
      );
      result.recognitionRecordsDeleted = deletedRecognitions.changes;

      // 4. 清除过期扫描记录的文件路径（保留成绩相关数据）
      const clearedFiles = await tx.run(
        `UPDATE scan_records
         SET file_path = NULL, status = 'expired'
         WHERE expires_at IS NOT NULL AND expires_at < ? AND file_path IS NOT NULL`,
        cutoffStr
      );
      result.scanRecordsDeleted = clearedFiles.changes;

      // 5. 检查超过90天的归档记录
      const archivedExpired = await tx.get(
        `SELECT COUNT(*) as cnt FROM exam_archives
         WHERE is_deleted = 0 AND archived_at < ?`,
        cutoffStr
      ) as { cnt: number };

      if (archivedExpired.cnt > 0) {
        console.log(`[Cleanup] 有 ${archivedExpired.cnt} 条归档记录超过保留期，建议手动审查后删除`);
      }
    });

    console.log(`[Cleanup] 完成：清除 ${result.scanRecordsDeleted} 条文件记录，${result.recognitionRecordsDeleted} 条识别记录，${result.filesDeleted} 个文件`);
  } catch (error) {
    const msg = `清理事务失败: ${error instanceof Error ? error.message : String(error)}`;
    result.errors.push(msg);
    console.error(`[Cleanup] ${msg}`);
  }

  if (result.errors.length > 0) {
    console.warn(`[Cleanup] 有 ${result.errors.length} 个错误，请检查日志`);
  }

  return result;
}

/**
 * 注册定时清理任务（在服务启动时调用）
 */
export function scheduleCleanup(intervalHours: number = 24, retainDays: number = 30): NodeJS.Timeout {
  console.log(`[Cleanup] 定时清理已注册，每 ${intervalHours} 小时执行一次，保留期 ${retainDays} 天`);

  // 立即执行一次（异步，不阻塞）
  runCleanup(retainDays).catch((error) => {
    console.error("[Cleanup] 首次执行失败:", error);
  });

  // 注册定时任务
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return setInterval(() => {
    runCleanup(retainDays).catch((error) => {
      console.error("[Cleanup] 定时清理执行失败:", error);
    });
  }, intervalMs);
}

/**
 * 手动触发清理（API 调用）
 */
export async function manualCleanup(retainDays?: number): Promise<CleanupResult> {
  console.log("[Cleanup] 手动触发清理");
  return runCleanup(retainDays ?? 30);
}

// 命令行直接执行（ESM 兼容写法）
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isMain =
  invokedPath !== "" &&
  /^cleanup\.(?:ts|js|mjs)$/.test(path.basename(invokedPath)) &&
  import.meta.url === pathToFileURL(invokedPath).href;
if (isMain) {
  const args = process.argv.slice(2);
  const days = args.length > 0 ? parseInt(args[0]) : 30;
  if (isNaN(days) || days < 0) {
    console.error("用法: npx tsx src/server/db/cleanup.ts [保留天数]");
    process.exit(1);
  }
  runCleanup(days).then((result) => {
    console.log("清理结果:", JSON.stringify(result, null, 2));
    process.exit(0);
  }).catch((err) => {
    console.error("清理失败:", err);
    process.exit(1);
  });
}
