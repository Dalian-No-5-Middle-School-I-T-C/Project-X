import { Router } from "express";
import { getMysqlDb } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { requirePermissionCompat, requireWholeExamGradingAccess } from "../../apps/answer-card/server/middleware";
import { PERMISSIONS } from "../auth/permissions";
import { resolveScannerExam } from "../services/scannerExam";
import { saveSessionCorrection, sessionCorrection } from "../services/scanCorrection";

/** Mounted below existing authenticated scanner session scope. */
export function scanCorrectionRouter(prefix: "session" | "sessions", remote: boolean) {
  const router = Router();
  const route = `/${prefix}/:sessionId/groups/:groupId/correction`;
  router.use(route, async (req,res,next) => {
    try {
      // A scanner key already passed the enclosing scope; human users need whole-paper grading access.
      if ((req as typeof req & { isApiClient?: boolean }).isApiClient) { next(); return; }
      const session = await getMysqlDb().get<{card_id:string}>("SELECT card_id FROM twain_scan_sessions WHERE id=?",req.params.sessionId);
      if (!session) { res.status(404).json({message:"扫描会话不存在"}); return; }
      const resolved = await resolveScannerExam(session.card_id,String(req.params.sessionId));
      if (!resolved.exam && req.user) { res.status(409).json({message:"无法确定考试归属"}); return; }
      if (resolved.exam) req.params.examId = String(resolved.exam.id);
      requirePermissionCompat(PERMISSIONS.GRADE_WRITE)(req,res,() => { void requireWholeExamGradingAccess(req,res,next).catch(next); });
    } catch (error) { next(error); }
  });
  router.route(route).get(async (req,res) => {
    try {
      const session = await getMysqlDb().get<{card_id:string}>("SELECT card_id FROM twain_scan_sessions WHERE id=?",req.params.sessionId);
      const card = session && await new CardRepository().findById(session.card_id);
      if (!card) { res.status(404).json({message:"答题卡不存在"}); return; }
      res.json(await sessionCorrection(card,String(req.params.sessionId),String(req.params.groupId),remote));
    } catch (error) { res.status(409).json({message:error instanceof Error ? error.message : "加载失败"}); }
  }).put(async (req,res) => {
    try {
      const session = await getMysqlDb().get<{card_id:string;status:string}>("SELECT card_id,status FROM twain_scan_sessions WHERE id=?",req.params.sessionId);
      const card = session && await new CardRepository().findById(session.card_id);
      if (!card || session?.status === "scanning") { res.status(409).json({message:"请等待扫描结束"}); return; }
      const result = await saveSessionCorrection(card,String(req.params.sessionId),String(req.params.groupId),req.body?.pages,req.user?.id ?? null);
      res.json({ok:true,...result});
    } catch (error) { res.status(409).json({message:error instanceof Error ? error.message : "保存失败"}); }
  });
  return router;
}
