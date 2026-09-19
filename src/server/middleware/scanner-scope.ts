import type { Request, Response, NextFunction } from "express";
import { requireExamAccess, getPermittedBlocks } from "../../apps/answer-card/server/middleware";
import { getMysqlDb } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { resolveScannerExam } from "../services/scannerExam";
import { isAuthEnforced } from "../lib/authEnforce";

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
