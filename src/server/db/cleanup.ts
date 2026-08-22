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
 * - 数据保留策略（v37+，控制台 data_retention_policies）：按策略自动归档/软删除已结考考试。
 *   三条语义假设（经产品确认，2026-08-20）：
 *     ① retain_days=0 = 永久保留，跳过归档/删除；
 *     ② auto_delete=1 = 软删除（仅标记 exam_archives.is_deleted=1，不物理销毁数据，可恢复）；
 *     ③ 未关联策略的考试维持默认行为（不归档不删除，仅按环境变量清理扫描原图）。
 *
 * 执行方式：
 * - 手动调用：npx tsx src/server/db/cleanup.ts
 * - 定时任务：由服务启动时注册 setInterval
 */

interface CleanupResult {
  scanRecordsDeleted: number;
  recognitionRecordsDeleted: number;
  filesDeleted: number;
  /** v37+: 本次按 data_retention_policies.auto_archive 新归档的考试数 */
  archivedCount: number;
  /** v37+: 本次按 data_retention_policies.auto_delete 标记软删除（exam_archives.is_deleted=1）的考试数 */
  markedDeletedCount: number;
  errors: string[];
}

/**
 * 保留期内的原始扫描图不能误删：还在阅卷中（active/grading）的考试即使超过
 * 保留期也跳过，避免申诉/复核时缺原图。成绩数据本身从不清理。
 */
const PROTECT_ACTIVE_EXAMS_SQL = `
  AND NOT EXISTS (
    SELECT 1 FROM scan_batches b JOIN exams e ON e.id = b.exam_id
    WHERE b.id = scan_records.batch_id AND e.status IN ('active', 'grading')
  )
`;

/** 是否存在数据保留策略行（决定是否进入策略消费步骤）。 */
async function hasAnyRetentionPolicy(tx: DbAdapter): Promise<boolean> {
  try {
    const row = await tx.get("SELECT 1 FROM data_retention_policies LIMIT 1");
    return !!row;
  } catch {
    return false;
  }
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
    archivedCount: 0,
    markedDeletedCount: 0,
    errors: []
  };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retainDays);
  const cutoffStr = cutoffDate.toISOString();

  console.log(`[Cleanup] 开始清理 ${retainDays} 天前的数据（截止：${cutoffDate.toLocaleDateString()}）`);

  try {
    // 步骤 1 和 3-5 在事务内执行（纯数据库操作）
    const filePathsToDelete: string[] = [];

    await db.transaction(async (tx) => {
      // 1. 查找过期的扫描记录
      const expiredRecords = await tx.all(
        `SELECT id, file_path, batch_id FROM scan_records
         WHERE expires_at IS NOT NULL AND expires_at < ?${PROTECT_ACTIVE_EXAMS_SQL}`,
        cutoffStr
      ) as Array<{ id: number; file_path: string | null; batch_id: number }>;

      console.log(`[Cleanup] 找到 ${expiredRecords.length} 条过期扫描记录`);

      // 收集需要删除的文件路径（稍后在事务外删除）
      for (const record of expiredRecords) {
        if (record.file_path) {
          filePathsToDelete.push(record.file_path);
        }
      }

      // 2. 删除过期的识别结果（先删子表）
      const deletedRecognitions = await tx.run(
        `DELETE FROM objective_recognitions
         WHERE record_id IN (
           SELECT id FROM scan_records
           WHERE expires_at IS NOT NULL AND expires_at < ?${PROTECT_ACTIVE_EXAMS_SQL}
         )`,
        cutoffStr
      );
      result.recognitionRecordsDeleted = deletedRecognitions.changes;

      // 3. 清除过期扫描记录的文件路径（保留成绩相关数据）
      const clearedFiles = await tx.run(
        `UPDATE scan_records
         SET file_path = NULL, status = 'expired'
         WHERE expires_at IS NOT NULL AND expires_at < ? AND file_path IS NOT NULL${PROTECT_ACTIVE_EXAMS_SQL}`,
        cutoffStr
      );
      result.scanRecordsDeleted = clearedFiles.changes;

      // 4. 检查超过保留期（cutoffStr）的归档记录
      const archivedExpired = await tx.get(
        `SELECT COUNT(*) as cnt FROM exam_archives
         WHERE is_deleted = 0 AND archived_at < ?`,
        cutoffStr
      ) as { cnt: number };

      if (archivedExpired.cnt > 0) {
        console.log(`[Cleanup] 有 ${archivedExpired.cnt} 条归档记录超过保留期，建议手动审查后删除`);
      }

      // 5. 数据保留策略消费（v37+）：管理员在控制台配置的 data_retention_policies 在此生效。
      //    - 仅处理 已结考(status='closed') 且关联了策略(retention_policy_id) 的考试；
      //    - 距结考时间（closed_at，缺省回退 end_time）超过策略 retain_days 才处理；
      //    - 假设①：retain_days=0 视为永久保留，跳过归档/删除（可人工在控制台放开）；
      //    - 假设②：auto_delete=1 为软删除——仅标记 exam_archives.is_deleted=1，不物理销毁数据，可恢复；
      //    - 假设③：未关联策略的考试维持默认行为——不归档不删除，仅按环境变量
      //      PROJECTX_SCAN_RETENTION_DAYS 清理扫描原图（本步骤之前的步骤 1-3）。
      //    - 超期判定统一交给 SQL 日期函数（julianday）比较：closed_at/end_time 为
      //      SQLite 'YYYY-MM-DD HH:mm:ss'（CURRENT_TIMESTAMP，UTC），与 JS toISOString()
      //      'YYYY-MM-DDTHH:mm:ss.sssZ' 直接按字典序比较会在 ' ' < 'T' 处错位，导致
      //      保留期未满的考试被提前归档/删除（评审 P1，2026-08-22 实测复现）。
      if (await hasAnyRetentionPolicy(tx)) {
        const policyExams = await tx.all(
          `SELECT e.id, p.retain_days, p.auto_archive, p.auto_delete
           FROM exams e
           JOIN data_retention_policies p ON p.id = e.retention_policy_id
           WHERE e.status = 'closed'
             AND COALESCE(e.closed_at, e.end_time) IS NOT NULL
             AND p.retain_days > 0
             AND julianday(COALESCE(e.closed_at, e.end_time)) <= julianday('now', '-' || p.retain_days || ' days')`
        ) as Array<{ id: number; retain_days: number; auto_archive: number; auto_delete: number }>;

        // 本轮跳过计数（用于汇总日志，便于运维核对三种假设的执行情况）
        let skippedPermanent = 0;   // 假设①：永久保留（retain_days=0）
        let skippedWithin = 0;      // 未到保留期
        let skippedNoPolicy = 0;    // 假设③：未关联策略
        let skippedOrphan = 0;      // 悬空引用：关联的策略已被删除（理论不可达，防御处理）

        const statRow = await tx.get(
          `SELECT
             SUM(CASE WHEN p.retain_days <= 0 THEN 1 ELSE 0 END) AS permanent,
             SUM(CASE WHEN p.retain_days > 0 THEN 1 ELSE 0 END) AS bounded
           FROM exams e
           JOIN data_retention_policies p ON p.id = e.retention_policy_id
           WHERE e.status = 'closed' AND COALESCE(e.closed_at, e.end_time) IS NOT NULL`
        ) as { permanent: number | null; bounded: number | null } | undefined;
        skippedPermanent = Number(statRow?.permanent ?? 0);
        const boundedCount = Number(statRow?.bounded ?? 0);
        skippedWithin = Math.max(0, boundedCount - policyExams.length);

        const noPolicyCount = await tx.get(
          `SELECT COUNT(*) AS cnt FROM exams
           WHERE status = 'closed' AND retention_policy_id IS NULL`
        ) as { cnt: number };
        skippedNoPolicy = noPolicyCount.cnt;

        const orphanRow = await tx.get(
          `SELECT COUNT(*) AS cnt FROM exams e
           WHERE e.status = 'closed' AND e.retention_policy_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM data_retention_policies p WHERE p.id = e.retention_policy_id)`
        ) as { cnt: number };
        skippedOrphan = orphanRow.cnt;

        if (skippedNoPolicy > 0) {
          console.log(`[Cleanup] ${skippedNoPolicy} 场已结考考试未关联保留策略（假设③：维持默认行为，不归档不删除，仅按环境变量清理扫描原图）`);
        }
        if (skippedOrphan > 0) {
          console.warn(`[Cleanup] ${skippedOrphan} 场已结考考试关联的保留策略不存在（悬空引用），跳过`);
        }
        if (skippedPermanent > 0) {
          console.log(`[Cleanup] ${skippedPermanent} 场已结考考试绑定永久保留策略（retain_days=0，假设①），跳过归档/删除`);
        }

        const ensureArchive = async (examId: number): Promise<number> => {
          const ins = await tx.run(
            `INSERT INTO exam_archives (exam_id, scan_count)
             SELECT ?, (SELECT COUNT(*) FROM scan_batches WHERE exam_id = ?)
             WHERE NOT EXISTS (SELECT 1 FROM exam_archives WHERE exam_id = ?)`,
            examId, examId, examId
          );
          return ins.changes;
        };

        const { recordLifecycleEvent } = await import("../services/lifecycleEvents");

        for (const exam of policyExams) {
          if (exam.auto_archive) {
            const created = await ensureArchive(exam.id);
            if (created > 0) {
              result.archivedCount++;
              console.log(`[Cleanup] 已归档考试 #${exam.id}（策略保留 ${exam.retain_days} 天）`);
              // 生命周期事件：自动归档计入控制台「历史累计」（评审 P2）
              await recordLifecycleEvent({ entityType: "exam", entityId: exam.id, action: "archive", actorId: null });
            }
          }
          if (exam.auto_delete) {
            await ensureArchive(exam.id); // 仅删除未归档的也补建归档记录，保留痕迹
            const upd = await tx.run(
              `UPDATE exam_archives SET is_deleted = 1, deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)
               WHERE exam_id = ? AND is_deleted = 0`,
              exam.id
            );
            if (upd.changes > 0) {
              result.markedDeletedCount += upd.changes;
              console.log(`[Cleanup] 考试 #${exam.id} 已按策略软删除（is_deleted=1，假设②：不物理销毁数据，可恢复）`);
              // 生命周期事件：策略软删除计入控制台「历史累计」（评审 P2）
              await recordLifecycleEvent({ entityType: "exam", entityId: exam.id, action: "delete", actorId: null });
            }
          }
        }

        console.log(`[Cleanup] 策略处理汇总：归档 ${result.archivedCount}、软删除 ${result.markedDeletedCount}；跳过 永久保留 ${skippedPermanent}、保留期内 ${skippedWithin}、无策略 ${skippedNoPolicy}、悬空引用 ${skippedOrphan}`);
      } else {
        console.log("[Cleanup] 无数据保留策略（data_retention_policies 为空），跳过策略归档/删除");
      }
    });

    // 步骤 2: 在事务外删除文件（DB 事务已提交，文件删除失败不影响数据一致性）
    for (const filePath of filePathsToDelete) {
      try {
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(process.cwd(), filePath);
        rmSync(fullPath, { force: true });
        result.filesDeleted++;
      } catch (error) {
        const msg = `删除文件失败 ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(msg);
        console.warn(`[Cleanup] ${msg}`);
      }
    }

    console.log(`[Cleanup] 完成：清除 ${result.scanRecordsDeleted} 条文件记录，${result.recognitionRecordsDeleted} 条识别记录，${result.filesDeleted} 个文件，按策略归档 ${result.archivedCount} 个考试、标记删除 ${result.markedDeletedCount} 个考试`);
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

// ── 软删除恢复（#246 评审 P2：可恢复必须有产品通道，不能靠改库）──────

export interface SoftDeletedExamRow {
  examId: number;
  examName: string | null;
  subject: string | null;
  status: string | null;
  deletedAt: string | null;
  archivedAt: string | null;
}

/** 列出当前被保留策略软删除（exam_archives.is_deleted=1）的考试。 */
export async function listSoftDeletedExams(): Promise<SoftDeletedExamRow[]> {
  const db = getMysqlDb();
  return await db.all<SoftDeletedExamRow>(
    `SELECT ea.exam_id AS examId, e.name AS examName, e.subject, e.status,
            ea.deleted_at AS deletedAt, ea.archived_at AS archivedAt
     FROM exam_archives ea LEFT JOIN exams e ON e.id = ea.exam_id
     WHERE ea.is_deleted = 1
     ORDER BY ea.deleted_at DESC, ea.exam_id DESC`
  );
}

/**
 * 恢复一场被保留策略软删除的考试（is_deleted 重置 0，deleted_at 清空）。
 * 写入 entity_lifecycle_events('exam', id, 'restore') 审计。
 * 返回 true=已恢复；false=该考试当前未被软删除（或归档记录不存在）。
 */
export async function restoreSoftDeletedExam(examId: number, actorId?: number | null): Promise<boolean> {
  if (!Number.isInteger(examId) || examId <= 0) {
    throw Object.assign(new Error("无效的考试 ID"), { status: 400 });
  }
  const db = getMysqlDb();
  const result = await db.run(
    `UPDATE exam_archives SET is_deleted = 0, deleted_at = NULL WHERE exam_id = ? AND is_deleted = 1`,
    examId
  );
  if (Number(result.changes) === 0) return false;
  // 恢复即人工豁免：解除该考试的保留策略绑定（假设③：未关联策略 = 不归档不删除）。
  // 否则考试仍满足原过期条件，下一轮清理（含服务启动时的立即执行）会按原策略
  // 再次软删除同一场考试，恢复形同虚设。
  await db.run(
    "UPDATE exams SET retention_policy_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    examId
  );
  console.log(`[Cleanup] 考试 #${examId} 已从软删除恢复并解除保留策略绑定（操作人 ${actorId ?? "未知"}）`);
  const { recordLifecycleEvent } = await import("../services/lifecycleEvents");
  await recordLifecycleEvent({ entityType: "exam", entityId: examId, action: "restore", actorId: actorId ?? null });
  return true;
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
