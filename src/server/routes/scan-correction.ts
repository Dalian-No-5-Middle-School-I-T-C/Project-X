import { Router } from "express";
import { getMysqlDb } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { requirePermissionCompat, requireWholeExamGradingAccess, getVisibleExamIds } from "../../apps/answer-card/server/middleware";
import { PERMISSIONS } from "../auth/permissions";
import { resolveScannerExam } from "../services/scannerExam";
import { recognizeSessionCorrection, saveSessionCorrection, sessionCorrection } from "../services/scanCorrection";
import { correctionCallerLimiter, correctionSessionLimiter, guardCorrectionRequest } from "../middleware/scanCorrectionRequests";

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
      // Scanner sync imports cards without creating local exams. The enclosing session
      // scope already distinguishes these originals from ambiguous or deleted exams.
      // 多场未归档考试、只剩归档考试等无法唯一确定归属的情况也一样：本地整卡改分
      // 只改本机扫描记录，不应因为归属不唯一而整页不可用；正式成绩入库仍在后续流程校验。
      if (!remote && (!resolved.exam || resolved.allExamIds.length === 0)) {
        if (req.user && !["admin", "teacher"].includes(req.user.role_name)) {
          res.status(403).json({message:"权限不足：整卡订正仅限教师或管理员"}); return;
        }
        // 归属不唯一时必须能看到全部候选考试，口径与扫描记录读取一致；
        // 只看得到其中一场不足以证明有权改这张可能属于其他考试的卡。
        if (req.user && resolved.exams.length > 0) {
          const visible = await getVisibleExamIds(req.user);
          if (visible !== null && !resolved.exams.every(exam => visible.includes(exam.id))) {
            res.status(403).json({message:"权限不足：无权修改该扫描会话"}); return;
          }
        }
        requirePermissionCompat(PERMISSIONS.GRADE_WRITE)(req,res,next);
        return;
      }
      if (!resolved.exam && req.user) { res.status(409).json({message:"无法确定考试归属"}); return; }
      if (resolved.exam) req.params.examId = String(resolved.exam.id);
      requirePermissionCompat(PERMISSIONS.GRADE_WRITE)(req,res,() => { void requireWholeExamGradingAccess(req,res,next).catch(next); });
    } catch (error) { next(error); }
  });
  if (remote) router.use(route, correctionCallerLimiter, correctionSessionLimiter);
  router.route(route).get(guardCorrectionRequest(async (req,res) => {
    try {
      const session = await getMysqlDb().get<{card_id:string}>("SELECT card_id FROM twain_scan_sessions WHERE id=?",req.params.sessionId);
      const card = session && await new CardRepository().findById(session.card_id);
      if (!card) { res.status(404).json({message:"答题卡不存在"}); return; }
      res.json(await sessionCorrection(card,String(req.params.sessionId),String(req.params.groupId),remote));
    } catch (error) { res.status(409).json({message:error instanceof Error ? error.message : "加载失败"}); }
  })).put(guardCorrectionRequest(async (req,res) => {
    try {
      const session = await getMysqlDb().get<{card_id:string;status:string}>("SELECT card_id,status FROM twain_scan_sessions WHERE id=?",req.params.sessionId);
      const card = session && await new CardRepository().findById(session.card_id);
      if (!card || session?.status === "scanning") { res.status(409).json({message:"请等待扫描结束"}); return; }
      const draft = req.body?.draft === true && !remote;
      const result = await saveSessionCorrection(card,String(req.params.sessionId),String(req.params.groupId),req.body?.pages,req.user?.id ?? null,remote,draft);
      res.json({ok:true,...result});
    } catch (error) { res.status(409).json({message:error instanceof Error ? error.message : "保存失败"}); }
  }));
  if (remote) router.post(`${route}/recognize`,guardCorrectionRequest(async(req,res)=>{
    try {
      const session = await getMysqlDb().get<{card_id:string}>("SELECT card_id FROM twain_scan_sessions WHERE id=?",req.params.sessionId);
      const card = session && await new CardRepository().findById(session.card_id);
      if (!card) { res.status(404).json({message:"答题卡不存在"}); return; }
      res.json(await recognizeSessionCorrection(card,String(req.params.sessionId),String(req.params.groupId),req.body));
    } catch(error) { res.status(409).json({message:error instanceof Error?error.message:"重新识别失败"}); }
  }));
  return router;
}
