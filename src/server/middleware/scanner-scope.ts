import type { Request, Response, NextFunction } from "express";
import {
  requireExamAccess,
  getPermittedBlocks,
  getVisibleExamIds,
  isExamSoftDeleted,
} from "../../apps/answer-card/server/middleware";
import { getMysqlDb } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { resolveScannerExam } from "../services/scannerExam";
import { isAuthEnforced } from "../lib/authEnforce";

/** 把「扫描记录 ID」映射到它所属的会话 ID（R04：记录级路由只有 recordId）。 */
export async function sessionIdOfScanRecord(recordId: string): Promise<string | null> {
  const row = await getMysqlDb().get<{ session_id: string | null }>(
    "SELECT session_id FROM twain_scan_records WHERE id = ?", recordId);
  return row?.session_id ?? null;
}

/**
 * 安全（R04）：记录/会话级路由（读取原卷图片、查看扫描结果、删除扫描记录）的访问校验。
 *
 * 与 requireScannerExamScope 的差别在于：这些请求里没有 examId，而且一张答题卡可能被多场
 * 考试复用，会话归属并不唯一。归属唯一时直接复用 requireExamAccess（含软删除与学生规则）；
 * 归属不唯一时要求**全部候选考试都可见**——只要有一个不可见就不能放行，否则越权考试的原卷
 * 图片会借着「另一场考试可见」的名义被读走。删除类请求还要求整份答卷的阅卷权限。
 */
export function requireScannerRecordScope(params: { recordIdParam?: string } = {}) {
  return async function scannerRecordScope(req: Request, res: Response, next: NextFunction): Promise<void> {
    if ((req as Request & { isApiClient?: boolean }).isApiClient) { next(); return; }
    if (!req.user) {
      if (isAuthEnforced()) { res.status(401).json({ message: "未提供认证令牌" }); return; }
      next(); return;
    }
    try {
      const recordId = params.recordIdParam ? req.params[params.recordIdParam] : undefined;
      const sessionId = recordId
        ? await sessionIdOfScanRecord(String(recordId))
        : String(req.params.sessionId ?? "");
      if (!sessionId) { res.status(404).json({ message: "扫描记录不存在" }); return; }
      const session = await getMysqlDb().get<{ card_id: string }>(
        "SELECT card_id FROM twain_scan_sessions WHERE id = ?", sessionId);
      if (!session) { res.status(404).json({ message: "扫描会话不存在" }); return; }

      const resolved = await resolveScannerExam(session.card_id, sessionId);
      // 答题卡尚未绑定任何考试（本机扫描、未提交）：与既有会话级行为一致，放行读取。
      if (resolved.exams.length === 0) { next(); return; }
      const candidateIds = (resolved.exam ? [resolved.exam.id] : resolved.exams.map(e => e.id)).map(Number);

      if (req.user.role_name === "student") {
        res.status(403).json({ message: "权限不足：扫描原卷仅限阅卷侧访问" }); return;
      }
      if (candidateIds.length === 1 && req.user.role_name === "teacher") {
        const original = req.params.examId;
        let allowed = false;
        try {
          req.params.examId = String(candidateIds[0]);
          await requireExamAccess(req, res, () => { allowed = true; });
        } finally {
          if (original === undefined) delete req.params.examId;
          else req.params.examId = original;
        }
        if (!allowed) return;
      } else {
        const visible = await getVisibleExamIds(req.user);
        for (const examId of candidateIds) {
          if (visible !== null && !visible.includes(examId)) {
            res.status(403).json({ message: "权限不足：无权访问此扫描记录所属考试" }); return;
          }
          if (req.user.role_name !== "admin" && await isExamSoftDeleted(examId)) {
            res.status(404).json({ message: "考试不存在或已按数据保留策略清理" }); return;
          }
        }
      }

      if (req.method === "DELETE") {
        // 删除扫描记录会连带撤出已判成绩与阅卷队列，权限口径与「保存整卷」一致；
        // 取消扫描、读取进度一类操作不改动成绩，仍只要求考试可见。
        for (const examId of candidateIds) {
          const permitted = await getPermittedBlocks(req.user, examId);
          if (permitted === null) continue;
          const exam = await getMysqlDb().get<{ card_id: string }>("SELECT card_id FROM exams WHERE id = ?", examId);
          const card = exam && await new CardRepository().findById(exam.card_id);
          const blocks = card?.bodyBlocks.filter(b => b.type === "objective" || b.type === "subjective") ?? [];
          if (!blocks.length || blocks.some(b => !permitted.includes(b.id))) {
            res.status(403).json({ message: "权限不足：删除扫描记录需要整份答题卡的阅卷权限" }); return;
          }
        }
      }
      next();
    } catch (error) { next(error); }
  };
}

/** Mount only after scanner authentication. A raw X-Api-Key header never grants a bypass. */
export async function requireScannerExamScope(req: Request, res: Response, next: NextFunction) {
  if ((req as Request & { isApiClient?: boolean }).isApiClient) { next(); return; }
  if (!req.user) {
    if (isAuthEnforced()) { res.status(401).json({ message: "未提供认证令牌" }); return; }
    next(); return;
  }
  try {
    const db = getMysqlDb();
    let examId = Number(req.params.examId);
    if (!req.params.examId) {
      const session = await db.get<{ card_id: string }>(
        "SELECT card_id FROM twain_scan_sessions WHERE id = ?", req.params.sessionId);
      if (!session) { res.status(404).json({ message: "扫描会话不存在" }); return; }
      const resolved = await resolveScannerExam(session.card_id, String(req.params.sessionId));
      // Unbound local sessions may still be recognized, but cannot mutate exam grades.
      if (!resolved.exam && resolved.exams.length === 0) { next(); return; }
      if (!resolved.exam) { res.status(409).json({ message: "无法确定扫描会话的考试归属" }); return; }
      examId = resolved.exam.id;
    }
    if (!Number.isSafeInteger(examId) || examId < 1) { res.status(400).json({ message: "无效的考试编号" }); return; }
    const original = req.params.examId;
    let allowed = false;
    try {
      req.params.examId = String(examId);
      await requireExamAccess(req, res, () => { allowed = true; });
    } finally {
      if (original === undefined) delete req.params.examId;
      else req.params.examId = original;
    }
    if (!allowed) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Saving/correcting a scanner submission changes the whole paper, not just an assigned block.
      const permitted = await getPermittedBlocks(req.user, examId);
      if (permitted !== null) {
        const exam = await db.get<{ card_id: string }>("SELECT card_id FROM exams WHERE id = ?", examId);
        const card = exam && await new CardRepository().findById(exam.card_id);
        const blocks = card?.bodyBlocks.filter(b => b.type === "objective" || b.type === "subjective") ?? [];
        if (!blocks.length || blocks.some(b => !permitted.includes(b.id))) {
          res.status(403).json({ message: "权限不足：扫描保存和订正需要整份答题卡的阅卷权限" }); return;
        }
      }
    }
    next();
  } catch (error) { next(error); }
}
