import express from "express";
import type { Request, Response } from "express";
import { UserRepository } from "../repositories/UserRepository";
import { ClassRepository } from "../repositories/ClassRepository";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS } from "../auth/permissions";

/**
 * 教师管理 API（仅管理员）
 * 挂载点：/api/teachers
 */
const router = express.Router();
const userRepo = new UserRepository();
const classRepo = new ClassRepository();

router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

function stripHash<T extends { password_hash?: string }>(user: T): Omit<T, "password_hash"> {
  const { password_hash, ...rest } = user;
  return rest;
}

/** GET /api/teachers — 教师列表 */
router.get("/", (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : 1;
  const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 50;
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword : undefined;

  const { teachers, total } = userRepo.listTeachers({ keyword, page, pageSize });
  res.json({ teachers: teachers.map(stripHash), total, page, pageSize });
});

/** GET /api/teachers/:id — 教师详情（含关联班级） */
router.get("/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const teacher = userRepo.findTeacherById(id);
  if (!teacher) {
    res.status(404).json({ message: "教师不存在" });
    return;
  }
  res.json(stripHash(teacher));
});

/** PUT /api/teachers/:id — 更新教师（姓名/科目） */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = userRepo.findByIdIncludingInactive(id);
    if (!existing || existing.role_id !== ROLE_IDS.TEACHER) {
      res.status(404).json({ message: "教师不存在" });
      return;
    }

    const { name, subject } = req.body ?? {};
    const params: { name?: string; subject?: string } = {};
    if (name !== undefined) params.name = String(name);
    if (subject !== undefined) params.subject = String(subject);

    await userRepo.updateTeacher(id, params);
    const updated = userRepo.findTeacherById(id);
    res.json(updated ? stripHash(updated) : null);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "更新失败" });
  }
});

/** POST /api/teachers/:id/classes — 关联班级 */
router.post("/:id/classes", (req: Request, res: Response) => {
  try {
    const teacherId = Number(req.params.id);
    const existing = userRepo.findByIdIncludingInactive(teacherId);
    if (!existing || existing.role_id !== ROLE_IDS.TEACHER) {
      res.status(404).json({ message: "教师不存在" });
      return;
    }

    const { classIds, subject } = req.body ?? {};
    const ids: number[] = Array.isArray(classIds) ? classIds.map(Number) : [];
    if (ids.length === 0) {
      res.status(400).json({ message: "请提供 classIds 数组" });
      return;
    }

    let added = 0;
    for (const classId of ids) {
      const cls = classRepo.findClassById(classId);
      if (!cls) continue;
      classRepo.addTeacherToClass(teacherId, classId, subject ? String(subject) : undefined);
      added++;
    }

    const teacher = userRepo.findTeacherById(teacherId);
    res.json({ message: `已关联 ${added} 个班级`, teacher: teacher ? stripHash(teacher) : null });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "关联失败" });
  }
});

/** DELETE /api/teachers/:id/classes/:classId — 解除关联 */
router.delete("/:id/classes/:classId", (req: Request, res: Response) => {
  try {
    const teacherId = Number(req.params.id);
    const classId = Number(req.params.classId);
    classRepo.removeTeacherFromClass(teacherId, classId);

    const teacher = userRepo.findTeacherById(teacherId);
    res.json({ message: "已解除关联", teacher: teacher ? stripHash(teacher) : null });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "解除失败" });
  }
});

/** GET /api/teachers/:id/classes — 教师关联班级列表 */
router.get("/:id/classes", (req: Request, res: Response) => {
  const teacherId = Number(req.params.id);
  res.json(classRepo.listTeacherClasses(teacherId));
});

export default router;
