import express from "express";
import type { Request, Response } from "express";
import { ClassRepository } from "../repositories/ClassRepository";
import { UserRepository } from "../repositories/UserRepository";
import { authMiddleware, requirePermission, requireRole } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS, ROLE_NAMES } from "../auth/permissions";

/**
 * 年级 / 班级 / 花名册管理 API
 * 挂载点：/api/classes
 *
 * - 读取（GET）：管理员 + 教师（教师需要按班级查成绩）
 * - 写入（POST/DELETE 组织结构、花名册）：仅管理员（class:manage）
 */
const router = express.Router();
const classRepo = new ClassRepository();
const userRepo = new UserRepository();

router.use(authMiddleware);

const readRoles = requireRole(ROLE_NAMES.ADMIN, ROLE_NAMES.TEACHER);
const manage = requirePermission(PERMISSIONS.CLASS_MANAGE);

// ── 年级 ──────────────────────────────────────────────

router.get("/grades", readRoles, (_req: Request, res: Response) => {
  res.json(classRepo.listGrades());
});

router.post("/grades", manage, (req: Request, res: Response) => {
  const { name, sortOrder } = req.body ?? {};
  if (!name) {
    res.status(400).json({ message: "缺少年级名称" });
    return;
  }
  res.status(201).json(classRepo.createGrade(String(name), Number(sortOrder ?? 0)));
});

router.delete("/grades/:id", manage, (req: Request, res: Response) => {
  classRepo.deleteGrade(Number(req.params.id));
  res.json({ message: "年级已删除（含其下班级）" });
});

// ── 班级 ──────────────────────────────────────────────

router.get("/", readRoles, (req: Request, res: Response) => {
  const gradeId = req.query.gradeId ? Number(req.query.gradeId) : undefined;
  res.json(classRepo.listClasses(gradeId));
});

router.post("/", manage, (req: Request, res: Response) => {
  const { gradeId, name, sortOrder } = req.body ?? {};
  if (!gradeId || !name) {
    res.status(400).json({ message: "缺少 gradeId 或班级名称" });
    return;
  }
  res.status(201).json(classRepo.createClass(Number(gradeId), String(name), Number(sortOrder ?? 0)));
});

router.delete("/:id", manage, (req: Request, res: Response) => {
  const cls = classRepo.findClassById(Number(req.params.id));
  if (!cls) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  classRepo.deleteClass(cls.id);
  res.json({ message: "班级已删除" });
});

// ── 花名册 ────────────────────────────────────────────

router.get("/:id/students", readRoles, (req: Request, res: Response) => {
  const cls = classRepo.findClassById(Number(req.params.id));
  if (!cls) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  res.json(classRepo.listStudents(cls.id));
});

/** 加入学生：body 支持 { studentId } 或 { studentIds: number[] } */
router.post("/:id/students", manage, (req: Request, res: Response) => {
  const cls = classRepo.findClassById(Number(req.params.id));
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
    const u = userRepo.findByIdIncludingInactive(sid);
    if (!u || u.role_id !== ROLE_IDS.STUDENT) invalid.push(sid);
  }
  if (invalid.length > 0) {
    res.status(400).json({ message: `以下 ID 非有效学生账号：${invalid.join(", ")}` });
    return;
  }

  const added = classRepo.addStudents(cls.id, ids);
  res.json({ message: `已添加 ${added} 名学生`, added });
});

router.delete("/:id/students/:studentId", manage, (req: Request, res: Response) => {
  classRepo.removeStudent(Number(req.params.id), Number(req.params.studentId));
  res.json({ message: "已从班级移除" });
});

export default router;
