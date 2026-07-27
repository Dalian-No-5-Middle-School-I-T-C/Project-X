import express from "express";
import type { Request, Response } from "express";
import { UserRepository, type BatchStudentInput } from "../repositories/UserRepository";
import { authService } from "../services/AuthService";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS, ROLE_NAMES, TEACHER_ROLE_LABELS } from "../auth/permissions";
import { validateInitialPassword, generateRandomInitialPassword } from "../auth/passwordPolicy";

/**
 * 用户管理 API（仅管理员，要求 user:manage 权限）
 * 挂载点：/api/users
 */
const router = express.Router();
const userRepo = new UserRepository();

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

/** 检查当前活跃管理员数量，<=1 表示不允许停用/降级最后一名管理员。 */
async function isLastActiveAdmin(): Promise<boolean> {
  const admins = await userRepo.adminListUsers({ roleName: ROLE_NAMES.ADMIN, pageSize: 1000 });
  return admins.total <= 1;
}

/** GET /api/users — 用户列表（分页/搜索/按角色/含禁用） */
router.get("/", async (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : 1;
  const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 20;
  const roleName = typeof req.query.role === "string" ? req.query.role : undefined;
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword : undefined;
  const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";

  const { users, total } = await userRepo.adminListUsers({ page, pageSize, roleName, keyword, includeInactive });
  res.json({
    users: users.map(stripHash),
    total,
    page,
    pageSize,
    roleSummary: await userRepo.countByRole()
  });
});

/** GET /api/users/:id — 用户详情（含班级） */
router.get("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const user = await userRepo.findByIdIncludingInactive(id);
  if (!user) {
    res.status(404).json({ message: "用户不存在" });
    return;
  }
  res.json({ ...stripHash(user), classes: await userRepo.getUserClasses(id) });
});

/** POST /api/users — 创建用户（教师/学生/管理员） */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { username, password, name, role, student_number, email, phone, teacher_role } = req.body ?? {};
    if (!username || !name) {
      res.status(400).json({ message: "缺少用户名或姓名" });
      return;
    }
    const roleId = resolveRoleId(role);
    if (roleId === null) {
      res.status(400).json({ message: "无效的角色，需为 admin/teacher/student" });
      return;
    }
    if (await userRepo.usernameExists(String(username))) {
      res.status(409).json({ message: "用户名已存在" });
      return;
    }
    if (roleId === ROLE_IDS.STUDENT && !student_number) {
      res.status(400).json({ message: "学生账号必须提供学号" });
      return;
    }
    if (student_number && await userRepo.studentNumberExists(String(student_number))) {
      res.status(409).json({ message: "学号已存在" });
      return;
    }

    // 验证教师角色（仅教师有效）
    if (roleId === ROLE_IDS.TEACHER && teacher_role && !["subject_teacher", "head_teacher", "grade_leader"].includes(teacher_role)) {
      res.status(400).json({ message: "无效的教师角色" });
      return;
    }

    // 密码：显式提供则使用；缺失时由服务器生成随机不可推导初始密码（禁止以学号等可推导值兜底）
    const providedPassword = password ? String(password) : "";
    const generatedPassword = providedPassword ? null : generateRandomInitialPassword();
    const finalPassword = providedPassword || generatedPassword!;
    const passwordError = validateInitialPassword({
      password: finalPassword,
      isStudent: roleId === ROLE_IDS.STUDENT,
      studentNumber: student_number ? String(student_number) : undefined
    });
    if (passwordError) {
      res.status(400).json({ message: passwordError });
      return;
    }

    const created = await userRepo.createUser({
      username: String(username),
      password: finalPassword,
      name: String(name),
      role_id: roleId,
      student_number: student_number ? String(student_number) : undefined,
      teacher_role: roleId === ROLE_IDS.TEACHER ? (teacher_role || undefined) : undefined,
      email: email ? String(email) : undefined,
      phone: phone ? String(phone) : undefined,
      initial_password: finalPassword
    });
    res.status(201).json({ ...stripHash(created), ...(generatedPassword ? { initialPassword: generatedPassword } : {}) });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "创建失败" });
  }
});

/** PUT /api/users/:id — 更新用户（姓名/邮箱/电话/角色/启用状态/学号/教师角色） */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = await userRepo.findByIdIncludingInactive(id);
    if (!existing) {
      res.status(404).json({ message: "用户不存在" });
      return;
    }

    const { name, email, phone, role, is_active, student_number, teacher_role } = req.body ?? {};
    const params: Parameters<UserRepository["updateUser"]>[1] = {};
    if (name !== undefined) params.name = String(name);
    if (email !== undefined) params.email = String(email);
    if (phone !== undefined) params.phone = String(phone);
    if (is_active !== undefined) {
      // 防止停用最后一名活跃管理员导致系统锁死
      if (!is_active && existing.role_id === ROLE_IDS.ADMIN && await isLastActiveAdmin()) {
        res.status(400).json({ message: "系统至少需保留一名管理员，无法停用" });
        return;
      }
      params.is_active = is_active ? 1 : 0;
    }
    if (student_number !== undefined) params.student_number = String(student_number);
    if (role !== undefined) {
      const roleId = resolveRoleId(role);
      if (roleId === null) {
        res.status(400).json({ message: "无效的角色" });
        return;
      }
      // 防止把最后一个管理员降级
      if (existing.role_id === ROLE_IDS.ADMIN && roleId !== ROLE_IDS.ADMIN) {
        if (await isLastActiveAdmin()) {
          res.status(400).json({ message: "系统至少需保留一名管理员，无法降级" });
          return;
        }
      }
      params.role_id = roleId;
    }
    if (teacher_role !== undefined) {
      if (teacher_role && !["subject_teacher", "head_teacher", "grade_leader"].includes(teacher_role)) {
        res.status(400).json({ message: "无效的教师角色" });
        return;
      }
      params.teacher_role = teacher_role || null;
    }

    await userRepo.updateUser(id, params);
    // 禁用账号时吊销其会话
    if (params.is_active === 0) authService.revokeUserTokens(id);
    const updated = await userRepo.findByIdIncludingInactive(id);
    res.json(updated ? stripHash(updated) : null);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "更新失败" });
  }
});

/** POST /api/users/:id/reset-password — 管理员重置密码 */
router.post("/:id/reset-password", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = await userRepo.findByIdIncludingInactive(id);
    if (!existing) {
      res.status(404).json({ message: "用户不存在" });
      return;
    }
    const { newPassword } = req.body ?? {};
    const password = newPassword ? String(newPassword) : generateRandomInitialPassword();
    const passwordError = validateInitialPassword({
      password,
      isStudent: existing.role_id === ROLE_IDS.STUDENT,
      studentNumber: existing.student_number
    });
    if (passwordError) {
      res.status(400).json({ message: passwordError });
      return;
    }
    await userRepo.updateUser(id, { password });
    authService.revokeUserTokens(id);
    res.json({ message: "密码已重置", ...(newPassword ? {} : { initialPassword: password }) });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "重置失败" });
  }
});

/** DELETE /api/users/:id — 禁用账号（软删除） */
router.delete("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await userRepo.findByIdIncludingInactive(id);
  if (!existing) {
    res.status(404).json({ message: "用户不存在" });
    return;
  }
  if (existing.role_id === ROLE_IDS.ADMIN && await isLastActiveAdmin()) {
    res.status(400).json({ message: "系统至少需保留一名管理员，无法禁用" });
    return;
  }
  await userRepo.deactivateUser(id);
  authService.revokeUserTokens(id);
  res.json({ message: "账号已禁用" });
});

/** POST /api/users/:id/reactivate — 重新启用账号 */
router.post("/:id/reactivate", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await userRepo.findByIdIncludingInactive(id);
  if (!existing) {
    res.status(404).json({ message: "用户不存在" });
    return;
  }
  await userRepo.reactivateUser(id);
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

/** POST /api/users/import-csv — v1.1 统一批量导入（学生+教师从CSV文本） */
router.post("/import-csv", async (req: Request, res: Response) => {
  try {
    const { csvText } = req.body ?? {};
    if (!csvText || typeof csvText !== "string" || !csvText.trim()) {
      res.status(400).json({ message: "请提供 csvText（CSV 文本内容）" });
      return;
    }

    // 解析 CSV
    const lines = csvText.split(/\r?\n/).filter((l: string) => l.trim());
    if (lines.length < 2) {
      res.status(400).json({ message: "CSV 至少需要表头+1行数据" });
      return;
    }

    const parseCsvLine = (line: string): string[] => {
      const cells: string[] = [];
      let cell = "";
      let inQuotes = false;
      const sep = line.includes(",") ? "," : "\t";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cell += '"'; i++; }
            else { inQuotes = false; }
          } else { cell += ch; }
        } else {
          if (ch === '"') { inQuotes = true; }
          else if (ch === sep) { cells.push(cell.trim()); cell = ""; }
          else { cell += ch; }
        }
      }
      cells.push(cell.trim());
      return cells;
    };

    const rows = lines.map(parseCsvLine);
    const result = await userRepo.batchImportFromCsv(rows);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "导入失败" });
  }
});

export default router;
