import express from "express";
import type { Request, Response } from "express";
import { ScoreRepository } from "../repositories/ScoreRepository";
import { UserRepository } from "../repositories/UserRepository";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS } from "../auth/permissions";

/**
 * 成绩查询 API
 * 挂载点：/api/scores
 *
 * - /me*          ：任何已登录用户查询自己的成绩（学生自助查分核心）
 * - /students/*   ：教师/管理员代查（要求 grade:read 权限）
 */
const router = express.Router();
const scoreRepo = new ScoreRepository();
const userRepo = new UserRepository();

router.use(authMiddleware);

/** GET /api/scores/me — 当前登录用户（学生）的全部考试成绩 */
router.get("/me", (req: Request, res: Response) => {
  const scores = scoreRepo.getStudentScores(req.user!.id);
  res.json({ studentId: req.user!.id, name: req.user!.name, scores });
});

/** GET /api/scores/me/exams/:examId — 当前用户某场考试的逐题明细 */
router.get("/me/exams/:examId", (req: Request, res: Response) => {
  const examId = Number(req.params.examId);
  if (!scoreRepo.hasScore(req.user!.id, examId)) {
    res.status(404).json({ message: "未找到你在该场考试的成绩" });
    return;
  }
  res.json({
    examId,
    questions: scoreRepo.getStudentQuestionScores(req.user!.id, examId)
  });
});

// ── 教师/管理员代查 ──────────────────────────────────────

const canQueryOthers = requirePermission(PERMISSIONS.GRADE_READ);

/** GET /api/scores/students/:studentId — 代查某学生全部成绩 */
router.get("/students/:studentId", canQueryOthers, (req: Request, res: Response) => {
  const studentId = Number(req.params.studentId);
  const student = userRepo.findByIdIncludingInactive(studentId);
  if (!student || student.role_id !== ROLE_IDS.STUDENT) {
    res.status(404).json({ message: "学生不存在" });
    return;
  }
  res.json({
    studentId,
    name: student.name,
    student_number: student.student_number,
    scores: scoreRepo.getStudentScores(studentId)
  });
});

/** GET /api/scores/students/:studentId/exams/:examId — 代查逐题明细 */
router.get("/students/:studentId/exams/:examId", canQueryOthers, (req: Request, res: Response) => {
  const studentId = Number(req.params.studentId);
  const examId = Number(req.params.examId);
  res.json({
    studentId,
    examId,
    questions: scoreRepo.getStudentQuestionScores(studentId, examId)
  });
});

export default router;
