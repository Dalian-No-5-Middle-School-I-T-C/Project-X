import express from "express";
import type { Request, Response } from "express";
import { ClassRepository } from "../repositories/ClassRepository";
import { UserRepository } from "../repositories/UserRepository";
import { authMiddleware, requirePermission, requireRole } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS, ROLE_NAMES } from "../auth/permissions";

/**
 * 年级 / 班级 / 花名册管理 API
 * 挂载点：/api/classes
 */
const router = express.Router();
const classRepo = new ClassRepository();
const userRepo = new UserRepository();

router.use(authMiddleware);

const readRoles = requireRole(ROLE_NAMES.ADMIN, ROLE_NAMES.TEACHER);
const manage = requirePermission(PERMISSIONS.CLASS_MANAGE);

// ── 年级 ──────────────────────────────────────────────

router.get("/grades", readRoles, async (_req: Request, res: Response) => {
  res.json(await classRepo.listGrades());
});

router.post("/grades", manage, async (req: Request, res: Response) => {
  const { name, sortOrder } = req.body ?? {};
  if (!name) {
    res.status(400).json({ message: "缺少年级名称" });
    return;
  }
  res.status(201).json(await classRepo.createGrade(String(name), Number(sortOrder ?? 0)));
});

router.delete("/grades/:id", manage, async (req: Request, res: Response) => {
  await classRepo.deleteGrade(Number(req.params.id));
  res.json({ message: "年级已删除（含其下班级）" });
});

// ── 班级 ──────────────────────────────────────────────

router.get("/", readRoles, async (req: Request, res: Response) => {
  const gradeId = req.query.gradeId ? Number(req.query.gradeId) : undefined;
  res.json(await classRepo.listClasses(gradeId));
});

router.post("/", manage, async (req: Request, res: Response) => {
  const { gradeId, name, sortOrder } = req.body ?? {};
  if (!gradeId || !name) {
    res.status(400).json({ message: "缺少 gradeId 或班级名称" });
    return;
  }
  res.status(201).json(await classRepo.createClass(Number(gradeId), String(name), Number(sortOrder ?? 0)));
});

router.delete("/:id", manage, async (req: Request, res: Response) => {
  const cls = await classRepo.findClassById(Number(req.params.id));
  if (!cls) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  await classRepo.deleteClass(cls.id);
  res.json({ message: "班级已删除" });
});

// ── 花名册 ────────────────────────────────────────────

router.get("/:id/students", readRoles, async (req: Request, res: Response) => {
  const cls = await classRepo.findClassById(Number(req.params.id));
  if (!cls) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  res.json(await classRepo.listStudents(cls.id));
});

router.post("/:id/students", manage, async (req: Request, res: Response) => {
  const cls = await classRepo.findClassById(Number(req.params.id));
  if (!cls) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  const { studentId, studentIds } = req.body ?? {};
  const ids: number[] = Array.isArray(studentIds)
    ? studentIds.map(Number)
    : studentId
      ? [Number(studentId)]
      : [];
  if (ids.length === 0) {
    res.status(400).json({ message: "请提供 studentId 或 studentIds" });
    return;
  }

  // 校验全部为有效学生账号
  const invalid: number[] = [];
  for (const sid of ids) {
    const u = await userRepo.findByIdIncludingInactive(sid);
    if (!u || u.role_id !== ROLE_IDS.STUDENT) invalid.push(sid);
  }
  if (invalid.length > 0) {
    res.status(400).json({ message: `以下 ID 非有效学生账号：${invalid.join(", ")}` });
    return;
  }

  const added = await classRepo.addStudents(cls.id, ids);
  res.json({ message: `已添加 ${added} 名学生`, added });
});

/** POST /api/classes/:id/students/:studentId/move — 学生迁移到目标班级（跨班级/跨年级） */
router.post("/:id/students/:studentId/move", manage, async (req: Request, res: Response) => {
  const fromId = Number(req.params.id);
  const studentId = Number(req.params.studentId);
  const { targetClassId } = req.body ?? {};

  const source = await classRepo.findClassById(fromId);
  if (!source) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  const target = await classRepo.findClassById(Number(targetClassId));
  if (!target) {
    res.status(400).json({ message: "目标班级不存在" });
    return;
  }

  const student = await userRepo.findByIdIncludingInactive(studentId);
  if (!student || student.role_id !== ROLE_IDS.STUDENT) {
    res.status(400).json({ message: "非有效学生账号" });
    return;
  }
  if (!(await classRepo.isStudentInClass(fromId, studentId))) {
    res.status(400).json({ message: "该学生不在当前班级" });
    return;
  }

  await classRepo.moveStudent(fromId, target.id, studentId);
  res.json({ message: `已迁移到 ${target.grade_name} · ${target.name}` });
});

router.delete("/:id/students/:studentId", manage, async (req: Request, res: Response) => {
  await classRepo.removeStudent(Number(req.params.id), Number(req.params.studentId));
  res.json({ message: "已从班级移除" });
});

export default router;
