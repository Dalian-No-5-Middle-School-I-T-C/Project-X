import express from "express";
import type { Request, Response } from "express";
import { ClassRepository } from "../repositories/ClassRepository";
import { UserRepository } from "../repositories/UserRepository";
import { authMiddleware, requirePermission, requireRole } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS, ROLE_NAMES } from "../auth/permissions";
import { isTeacherSubject } from "../../shared/subjects";

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

router.put("/grades/:id", manage, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name } = req.body ?? {};
  if (!name) {
    res.status(400).json({ message: "缺少年级名称" });
    return;
  }
  await classRepo.updateGrade(id, String(name));
  res.json({ message: "年级已重命名" });
});

router.delete("/grades/:id", manage, async (req: Request, res: Response) => {
  await classRepo.deleteGrade(Number(req.params.id));
  res.json({ message: "年级及其下班级已归档，历史记录保留" });
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

router.put("/:id", manage, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ message: "缺少班级名称" });
    return;
  }
  if (!await classRepo.findClassById(id)) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  await classRepo.updateClass(id, name);
  res.json({ message: "班级已重命名" });
});

router.delete("/:id", manage, async (req: Request, res: Response) => {
  const cls = await classRepo.findClassById(Number(req.params.id));
  if (!cls) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  await classRepo.deleteClass(cls.id);
  res.json({ message: "班级已归档，历史记录保留" });
});

// ── 班级教师（班主任 + 分科任课教师）────────────────────

/**
 * GET /api/classes/:id/teachers — 班级教师配置。
 * 班主任 = 该班关联里 is_head_teacher=1 的那位；任课教师 = 关联里带科目的记录。
 */
router.get("/:id/teachers", manage, async (req: Request, res: Response) => {
  const classId = Number(req.params.id);
  if (!await classRepo.findClassById(classId)) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  const rows = await classRepo.listClassTeachers(classId);
  const head = rows.find((row) => Number(row.is_head_teacher) === 1);
  res.json({
    headTeacherId: head?.teacher_id ?? null,
    headTeacherName: head?.name ?? null,
    assignments: rows
      .filter((row) => row.subject !== null)
      .map((row) => ({
        teacherId: row.teacher_id,
        name: row.name,
        subject: row.subject,
        teacherSubject: row.teacher_subject,
        teacherRole: row.teacher_role
      }))
  });
});

/** POST /api/classes/:id/teachers — 指定某学科的任课教师 */
router.post("/:id/teachers", manage, async (req: Request, res: Response) => {
  const classId = Number(req.params.id);
  const teacherId = Number(req.body?.teacherId);
  const subject = String(req.body?.subject ?? "");
  if (!teacherId || !isTeacherSubject(subject)) {
    res.status(400).json({ message: "请提供有效的 teacherId 与学科" });
    return;
  }
  if (!await classRepo.findClassById(classId)) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  const teacher = await userRepo.findByIdIncludingInactive(teacherId);
  if (!teacher || teacher.role_id !== ROLE_IDS.TEACHER || teacher.is_active !== 1) {
    res.status(404).json({ message: "教师不存在或已停用" });
    return;
  }
  await classRepo.setClassTeacher(teacherId, classId, subject);
  res.json({ message: "已设置任课教师" });
});

/** DELETE /api/classes/:id/teachers/:teacherId — 解除该教师与班级的关联 */
router.delete("/:id/teachers/:teacherId", manage, async (req: Request, res: Response) => {
  await classRepo.removeTeacherFromClass(Number(req.params.teacherId), Number(req.params.id));
  res.json({ message: "已解除关联" });
});

/**
 * PUT /api/classes/:id/head-teacher — 设置 / 清除班主任（可在全部教师中选择，不限学科）。
 * 班主任是按班关系（teacher_classes.is_head_teacher），不改动教师的全局 users.teacher_role，
 * 否则会波及该教师在其它班级的权限范围。先完成全部校验，再在事务内替换。
 */
router.put("/:id/head-teacher", manage, async (req: Request, res: Response) => {
  const classId = Number(req.params.id);
  if (!await classRepo.findClassById(classId)) {
    res.status(404).json({ message: "班级不存在" });
    return;
  }
  const raw = req.body?.teacherId;
  const teacherId = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (teacherId !== null && !Number.isFinite(teacherId)) {
    res.status(400).json({ message: "teacherId 不合法" });
    return;
  }
  if (teacherId !== null) {
    // 与 listClassTeachers（只列在职教师）口径一致：已停用教师不可被指派，
    // 否则指派后从配置列表消失、难以发现和移除
    const teacher = await userRepo.findByIdIncludingInactive(teacherId);
    if (!teacher || teacher.role_id !== ROLE_IDS.TEACHER || teacher.is_active !== 1) {
      res.status(404).json({ message: "教师不存在或已停用" });
      return;
    }
  }

  await classRepo.replaceClassHeadTeacher(classId, teacherId);
  res.json({ message: teacherId === null ? "已清除班主任" : "已设置班主任" });
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
