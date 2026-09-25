/**
 * 成绩首次正式发布 → 微信订阅消息推送。
 *
 * 语义：
 * - 仅通知「有绑定记录 且 本场有成绩」的学生。
 * - 每场考试仅首次正式发布推送一次；撤回后重新公布（成绩修订）不再重复发送。
 *   去重依赖 wechat_grade_release_notifications.exam_id 主键 + INSERT IGNORE 认领。
 * - 「失败不占用去重」：本场无人实际送达（成功数 0）、无收件人、考试未处于公布态、
 *   或流程异常时，删除认领行释放去重位，管理员修好配置后重新公布即可重推。
 *   只要有 1 条送达就保留去重位，避免已收到的学生被重复打扰。
 * - 发送失败仅记录，不回滚成绩发布（本函数全程异步、异常内部吞掉）。
 */
import { buildInsertIgnore, getMysqlDb, type DbAdapter } from "../db";
import {
  getGradeReleaseTemplateId,
  isWechatConfigured,
  sendGradeReleaseMessage,
  WechatApiError,
} from "./WechatMiniProgramService";

type ExamInfo = {
  id: number;
  name: string;
  subject: string | null;
  score_published: number | null;
};

type SubscriberScore = {
  student_id: number;
  openid: string;
  template_id: string;
  score: number | null;
};

/**
 * 收件人侧永久错误：重试同一场也不会成功。
 * 43101=用户未订阅/一次性额度已用尽，40003=openid 不合法（绑定数据失效）。
 * 其余错误码（-1 系统繁忙、40001/42001 token、40164 IP 未白名单、45009 频控等）
 * 与网络/HTTP 故障一律按「基建问题」处理，计入可重试。
 */
const RECIPIENT_SIDE_ERRCODES = new Set([43101, 40003]);

/** 认领行停留 sending 超过该时长视为进程崩溃遗留，允许重新认领。 */
const STALE_CLAIM_MINUTES = 10;

function courseLabel(exam: ExamInfo): string {
  const label = exam.subject ? `${exam.subject}${exam.name ? ` · ${exam.name}` : ""}` : exam.name;
  return label || "考试成绩";
}

function isRecipientSideFailure(error: unknown): boolean {
  return error instanceof WechatApiError && error.errcode !== null && RECIPIENT_SIDE_ERRCODES.has(error.errcode);
}

function errcodeOf(error: unknown): number | null {
  return error instanceof WechatApiError ? error.errcode : null;
}

/** 按方言构造「sending 认领行已过期」的判断条件（时间差在数据库侧算，避免时区解析歧义）。 */
function staleClaimSql(dialect: DbAdapter["dialect"]): string {
  const cutoff =
    dialect === "mariadb"
      ? `NOW() - INTERVAL ${STALE_CLAIM_MINUTES} MINUTE`
      : `datetime('now', '-${STALE_CLAIM_MINUTES} minutes')`;
  return `SELECT exam_id FROM wechat_grade_release_notifications
           WHERE exam_id = ? AND status = 'sending' AND created_at < ${cutoff}`;
}

/**
 * 认领「本场首次发布通知」：主键冲突（已存在）→ changes=0。
 * 若已存在的行是超时未完成的 sending（进程崩溃遗留），删除后重新认领一次。
 */
async function claimSlot(db: DbAdapter, examId: number): Promise<boolean> {
  const claimSql = buildInsertIgnore(db.dialect, "wechat_grade_release_notifications", [
    "exam_id",
    "status",
  ]);
  try {
    if ((await db.run(claimSql, examId, "sending")).changes === 1) return true;

    const stale = await db.get<{ exam_id: number }>(staleClaimSql(db.dialect), examId);
    if (!stale) return false;
    await db.run(
      "DELETE FROM wechat_grade_release_notifications WHERE exam_id = ? AND status = 'sending'",
      examId,
    );
    if ((await db.run(claimSql, examId, "sending")).changes !== 1) return false;
    console.warn("wechat grade release: reclaimed stale sending slot", { examId });
    return true;
  } catch (error) {
    console.error("wechat grade release claim failed:", {
      examId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** 释放去重位：本场没有任何学生收到消息，允许下次公布重推。 */
async function releaseSlot(db: DbAdapter, examId: number, reason: string, detail?: Record<string, unknown>): Promise<void> {
  try {
    await db.run("DELETE FROM wechat_grade_release_notifications WHERE exam_id = ?", examId);
    console.warn("wechat grade release slot released for retry:", { examId, reason, ...detail });
  } catch (error) {
    console.error("wechat grade release slot release failed:", {
      examId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function notifyGradeReleaseSubscribers(examId: number): Promise<void> {
  try {
    await notifyGradeReleaseSubscribersInner(examId);
  } catch (error) {
    // 本函数以 void 方式在发布响应前调用：任何外溢都会变成 unhandled rejection
    console.error("wechat grade release fatal error:", {
      examId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function notifyGradeReleaseSubscribersInner(examId: number): Promise<void> {
  if (!isWechatConfigured()) return;

  const db = getMysqlDb();
  if (!(await claimSlot(db, examId))) return;

  try {
    const templateId = getGradeReleaseTemplateId();
    const exam = await db.get<ExamInfo>(
      "SELECT id, name, subject, score_published FROM exams WHERE id = ?",
      examId,
    );
    if (!exam || exam.score_published !== 1) {
      await releaseSlot(db, examId, "not_published");
      return;
    }

    const rows = await db.all<SubscriberScore>(
      `SELECT ss.student_id, wsb.openid, wsb.template_id,
              COALESCE(ss.assigned_score, ss.total_score) AS score
         FROM student_scores ss
         JOIN wechat_subscription_bindings wsb
           ON wsb.student_id = ss.student_id AND wsb.template_id = ?
        WHERE ss.exam_id = ?`,
      templateId, examId,
    );

    const targets = rows.filter((row) => row.score != null);
    if (targets.length === 0) {
      // 本场无人订阅（或订阅者无成绩）：不占用去重位，学生补订阅后重新公布仍可推送
      await releaseSlot(db, examId, "no_recipients");
      return;
    }

    const label = courseLabel(exam);
    let success = 0;
    let recipientSide = 0;
    let infraSide = 0;
    for (const row of targets) {
      try {
        await sendGradeReleaseMessage({
          openid: row.openid,
          templateId: row.template_id,
          courseName: label,
          score: Number(row.score),
        });
        success++;
      } catch (error) {
        if (isRecipientSideFailure(error)) recipientSide++;
        else infraSide++;
        console.error("wechat grade release send failed:", {
          examId,
          studentId: row.student_id,
          errcode: errcodeOf(error),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (success === 0) {
      // 全场零送达：无论是配置错误还是订阅额度耗尽，都不该把本场永久标记为已通知
      await releaseSlot(db, examId, "no_message_delivered", {
        total: targets.length,
        recipientSide,
        infraSide,
      });
      return;
    }

    await db.run(
      `UPDATE wechat_grade_release_notifications
          SET status = ?, success_count = ?, failure_count = ?, updated_at = CURRENT_TIMESTAMP
        WHERE exam_id = ?`,
      recipientSide + infraSide > 0 ? "completed_with_errors" : "completed",
      success, recipientSide + infraSide, examId,
    );
  } catch (error) {
    // 兜底：认领后任何异常都不得外溢影响发布流程
    console.error("wechat grade release notification error:", {
      examId,
      error: error instanceof Error ? error.message : String(error),
    });
    await releaseSlot(db, examId, "unexpected_error");
  }
}
