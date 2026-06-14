import express from "express";
import type { Request, Response } from "express";
import { UserRepository, type BatchStudentInput } from "../repositories/UserRepository";
import { AuthService } from "../services/AuthService";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS, ROLE_NAMES } from "../auth/permissions";

/**
 * 用户管理 API（仅管理员，要求 user:manage 权限）
 * 挂载点：/api/users
 */
const router = express.Router();
const userRepo = new UserRepository();
const authService = new AuthService();

// 所有用户管理接口都要求登录 + user:manage 权限
router.use(authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE));

function stripHash<T extends { password_hash?: string }>(user: T): Omit<T, "password_hash"> {
  const { password_hash, ...rest } = user;
  return rest;
}

const ROLE_NAME_TO_ID: Record<string, number> = {
  [ROLE_NAMES.ADMIN]: ROLE_IDS.ADMIN,
  [ROLE_NAMES.TEACHER]: ROLE_IDS.TEACHER,
  [ROLE_NAMES.STUDENT]: ROLE_IDS.STUDENT
};

function resolveRoleId(role: unknown): number | null {
  if (typeof role === "number" && [1, 2, 3].includes(role)) return role;
  if (typeof role === "string") {
    if (ROLE_NAME_TO_ID[role] !== undefined) return ROLE_NAME_TO_ID[role];
    const n = Number(role);
    if ([1, 2, 3].includes(n)) return n;
  }
  return null;
}

/** GET /api/users — 用户列表（分页/搜索/按角色/含禁用） */
router.get("/", (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : 1;
  const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 20;
  const roleName = typeof req.query.role === "string" ? req.query.role : undefined;
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword : undefined;
  const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";

  const { users, total } = userRepo.adminListUsers({ page, pageSize, roleName, keyword, includeInactive });
  res.json({
    users: users.map(stripHash),
    total,
    page,
    pageSize,
    roleSummary: userRepo.countByRole()
  });
});

/** GET /api/users/:id — 用户详情（含班级） */
router.get("/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const user = userRepo.findByIdIncludingInactive(id);
  if (!user) {
    res.status(404).json({ message: "用户不存在" });
    return;
  }
  res.json({ ...stripHash(user), classes: userRepo.getUserClasses(id) });
});

/** POST /api/users — 创建用户（教师/学生/管理员） */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { username, password, name, role, student_number, email, phone } = req.body ?? {};
    if (!username || !name) {
      res.status(400).json({ message: "缺少用户名或姓名" });
      return;
    }
    const roleId = resolveRoleId(role);
    if (roleId === null) {
      res.status(400).json({ message: "无效的角色，需为 admin/teacher/student" });
      return;
    }
    if (userRepo.usernameExists(String(username))) {
      res.status(409).json({ message: "用户名已存在" });
      return;
    }
    if (roleId === ROLE_IDS.STUDENT && !student_number) {
      res.status(400).json({ message: "学生账号必须提供学号" });
      return;
    }
    if (student_number && userRepo.studentNumberExists(String(student_number))) {
      res.status(409).json({ message: "学号已存在" });
      return;
    }

    // 密码默认：学生用学号，教师/管理员需显式提供
    const finalPassword = password || (roleId === ROLE_IDS.STUDENT ? String(student_number) : "");
    if (!finalPassword) {
      res.status(400).json({ message: "请为该账号设置初始密码" });
      return;
    }

    const created = await userRepo.createUser({
      username: String(username),
      password: String(finalPassword),
      name: String(name),
      role_id: roleId,
      student_number: student_number ? String(student_number) : undefined,
      email: email ? String(email) : undefined,
      phone: phone ? String(phone) : undefined
    });
    res.status(201).json(stripHash(created));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "创建失败" });
  }
});

/** PUT /api/users/:id — 更新用户（姓名/邮箱/电话/角色/启用状态/学号） */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = userRepo.findByIdIncludingInactive(id);
    if (!existing) {
      res.status(404).json({ message: "用户不存在" });
      return;
    }

    const { name, email, phone, role, is_active, student_number } = req.body ?? {};
    const params: Parameters<UserRepository["updateUser"]>[1] = {};
    if (name !== undefined) params.name = String(name);
    if (email !== undefined) params.email = String(email);
    if (phone !== undefined) params.phone = String(phone);
    if (is_active !== undefined) params.is_active = is_active ? 1 : 0;
    if (student_number !== undefined) params.student_number = String(student_number);
    if (role !== undefined) {
      const roleId = resolveRoleId(role);
      if (roleId === null) {
        res.status(400).json({ message: "无效的角色" });
        return;
      }
      // 防止把最后一个管理员降级
      if (existing.role_id === ROLE_IDS.ADMIN && roleId !== ROLE_IDS.ADMIN) {
        const admins = userRepo.adminListUsers({ roleName: ROLE_NAMES.ADMIN, pageSize: 1000 });
        if (admins.total <= 1) {
          res.status(400).json({ message: "系统至少需保留一名管理员，无法降级" });
          return;
        }
      }
      params.role_id = roleId;
    }

    await userRepo.updateUser(id, params);
    // 禁用账号时吊销其会话
    if (params.is_active === 0) authService.revokeUserTokens(id);
    res.json(stripHash(userRepo.findByIdIncludingInactive(id)!));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "更新失败" });
  }
});

/** POST /api/users/:id/reset-password — 管理员重置密码 */
router.post("/:id/reset-password", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = userRepo.findByIdIncludingInactive(id);
    if (!existing) {
      res.status(404).json({ message: "用户不存在" });
      return;
    }
    const { newPassword } = req.body ?? {};
    const password = newPassword ? String(newPassword) : existing.student_number || "";
    if (!password || password.length < 6) {
      res.status(400).json({ message: "新密码至少 6 位（学生可默认用学号，但学号不足 6 位需手动指定）" });
      return;
    }
    await userRepo.updateUser(id, { password });
    authService.revokeUserTokens(id);
    res.json({ message: "密码已重置" });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "重置失败" });
  }
});

/** DELETE /api/users/:id — 禁用账号（软删除） */
router.delete("/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = userRepo.findByIdIncludingInactive(id);
  if (!existing) {
    res.status(404).json({ message: "用户不存在" });
    return;
  }
  if (existing.role_id === ROLE_IDS.ADMIN) {
    const admins = userRepo.adminListUsers({ roleName: ROLE_NAMES.ADMIN, pageSize: 1000 });
    if (admins.total <= 1) {
      res.status(400).json({ message: "系统至少需保留一名管理员，无法禁用" });
      return;
    }
  }
  userRepo.deactivateUser(id);
  authService.revokeUserTokens(id);
  res.json({ message: "账号已禁用" });
});

/** POST /api/users/:id/reactivate — 重新启用账号 */
router.post("/:id/reactivate", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = userRepo.findByIdIncludingInactive(id);
  if (!existing) {
    res.status(404).json({ message: "用户不存在" });
    return;
  }
  userRepo.reactivateUser(id);
  res.json({ message: "账号已启用" });
});

/** POST /api/users/import-students — 批量导入学生 */
router.post("/import-students", async (req: Request, res: Response) => {
  try {
    const students = req.body?.students;
    if (!Array.isArray(students) || students.length === 0) {
      res.status(400).json({ message: "请提供 students 数组" });
      return;
    }
    const rows: BatchStudentInput[] = students.map((s: Record<string, unknown>) => ({
      username: String(s.username ?? s.student_number ?? ""),
      name: String(s.name ?? ""),
      student_number: String(s.student_number ?? ""),
      password: s.password ? String(s.password) : undefined
    }));
    const result = await userRepo.batchCreateStudents(rows);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "导入失败" });
  }
});

export default router;
