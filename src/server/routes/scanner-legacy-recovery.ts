import { Router } from "express";
import { recoverLegacyScannerSubmission } from "../services/scannerSubmissions";
/** Mount behind the scanner route's existing authentication boundary. */
export function scannerLegacyRecoveryRouter() {
  const router = Router();
  router.post("/legacy/:examId/:groupId/:action", async (req, res) => {
    const examId = Number(req.params.examId);
    const action = req.params.action;
    const studentId = req.body?.studentId;
    if (!Number.isSafeInteger(examId) || examId < 1 || !["correct", "save"].includes(action)
      || (action === "correct" && (typeof studentId !== "string" || !/^[0-9A-Za-z_-]{1,64}$/.test(studentId)))) {
      res.status(400).json({ message: "无效的历史成绩订正请求" }); return;
    }
    try { res.json(await recoverLegacyScannerSubmission(examId, String(req.params.groupId), action === "correct" ? studentId : undefined)); }
    catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : "历史成绩处理失败" }); }
  });
  return router;
}
