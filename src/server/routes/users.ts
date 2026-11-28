import express from "express";
import type { Request, Response } from "express";
import { UserRepository, type BatchStudentInput } from "../repositories/UserRepository";
import { ClassRepository } from "../repositories/ClassRepository";
import { authService } from "../services/AuthService";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS, ROLE_IDS, ROLE_NAMES, TEACHER_ROLE_LABELS, TEACHER_ROLES, roleHasPermission } from "../auth/permissions";
import { validateInitialPassword, generateRandomInitialPassword } from "../auth/passwordPolicy";
import { getMysqlDb, hashPassword } from "../db";
import { hasClassViewPermission } from "../../apps/answer-card/server/middleware";
import { getAccessibleClassIds } from "./scores";
import * as XLSX from "xlsx";

/**
 * 用户管理 API（仅管理员，要求 user:manage 权限）
 * 挂载点：/api/users
 */
const router = express.Router();
const userRepo = new UserRepository();
const classRepo = new ClassRepository();

// 账号维护接口逐路由要求 user:manage；花名册批量操作使用独立的班级权限与逐生范围校验。
router.use(authMiddleware);

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

/** 检查当前活跃管理员数量，调用方必须在用户写锁或事务内执行。 */
async function isLastActiveAdmin(repo: UserRepository = userRepo): Promise<boolean> {
  return await repo.countActiveAdmins() <= 1;
}

function errorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error && Number.isInteger((error as { status: number }).status)
    ? (error as { status: number }).status
    : 500;
}

/** GET /api/users — 用户列表（分页/搜索/按角色/含禁用） */
router.get("/", requirePermission(PERMISSIONS.USER_MANAGE), async (req: Request, res: Response) => {
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
router.get("/:id", requirePermission(PERMISSIONS.USER_MANAGE), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const user = await userRepo.findByIdIncludingInactive(id);
  if (!user) {
    res.status(404).json({ message: "用户不存在" });
    return;
  }
  res.json({ ...stripHash(user), classes: await userRepo.getUserClasses(id) });
});

/** POST /api/users — 创建用户（教师/学生/管理员） */
router.post("/", requirePermission(PERMISSIONS.USER_MANAGE), async (req: Request, res: Response) => {
  try {
    const { username, password, name, role, student_number, email, phone, teacher_role, track } = req.body ?? {};
    if (!username || !name) {
      res.status(400).json({ message: "缺少用户名或姓名" });
      return;
    }
    const roleId = resolveRoleId(role);
    if (roleId === null) {
      res.status(400).json({ message: "无效的角色，需为 admin/teacher/student" });
      return;
    }
    if (roleId === ROLE_IDS.STUDENT && !student_number) {
      res.status(400).json({ message: "学生账号必须提供学号" });
      return;
    }
    if (track !== undefined && track !== null && track !== "" && !["arts", "science"].includes(String(track))) {
      res.status(400).json({ message: "无效的文理分科，仅支持 arts（文科）/ science（理科）" });
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

    const finalPasswordHash = await hashPassword(finalPassword);
    const created = await getMysqlDb().transactionWithNamedLock("projectx:user-mutations", 5000, async (tx) => {
      const repo = new UserRepository(tx);
      if (await repo.usernameExists(String(username))) {
        throw Object.assign(new Error("用户名已存在"), { status: 409 });
      }
      if (student_number && await repo.studentNumberExists(String(student_number))) {
        throw Object.assign(new Error("学号已存在"), { status: 409 });
      }
      return repo.createUser({
        username: String(username),
        password: finalPassword,
        name: String(name),
        role_id: roleId,
        student_number: student_number ? String(student_number) : undefined,
        teacher_role: roleId === ROLE_IDS.TEACHER ? (teacher_role || undefined) : undefined,
        track: roleId === ROLE_IDS.STUDENT && track ? String(track) : undefined,
        email: email ? String(email) : undefined,
        phone: phone ? String(phone) : undefined,
        initial_password: finalPassword
      }, finalPasswordHash);
    });
    res.status(201).json({ ...stripHash(created), ...(generatedPassword ? { initialPassword: generatedPassword } : {}) });
  } catch (error) {
    res.status(errorStatus(error)).json({ message: error instanceof Error ? error.message : "创建失败" });
  }
});

/** PUT /api/users/:id — 更新用户（姓名/邮箱/电话/角色/启用状态/学号/教师角色） */
router.put("/:id", requirePermission(PERMISSIONS.USER_MANAGE), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "无效的用户 ID" });
      return;
    }
    const existing = await userRepo.findByIdIncludingInactive(id);
    if (!existing) {
      res.status(404).json({ message: "用户不存在" });
      return;
    }

    const { name, email, phone, role, is_active, student_number, teacher_role, track } = req.body ?? {};
    const params: Parameters<UserRepository["updateUser"]>[1] = {};
    if (name !== undefined) params.name = String(name);
    if (email !== undefined) params.email = String(email);
    if (phone !== undefined) params.phone = String(phone);
    if (student_number !== undefined) params.student_number = String(student_number).trim();
    if (track !== undefined) {
      if (track !== null && track !== "" && !["arts", "science"].includes(String(track))) {
        res.status(400).json({ message: "无效的文理分科，仅支持 arts（文科）/ science（理科）" });
        return;
      }
      params.track = track ? String(track) : null;
    }
    let nextRoleId = existing.role_id;
    if (role !== undefined) {
      const roleId = resolveRoleId(role);
      if (roleId === null) {
        res.status(400).json({ message: "无效的角色" });
        return;
      }
      nextRoleId = roleId;
      params.role_id = roleId;
    }
    if (nextRoleId === ROLE_IDS.STUDENT && !(params.student_number ?? existing.student_number)) {
      res.status(400).json({ message: "学生账号必须提供学号" });
      return;
    }
    if (teacher_role !== undefined) {
      if (teacher_role && !["subject_teacher", "head_teacher", "grade_leader"].includes(teacher_role)) {
        res.status(400).json({ message: "无效的教师角色" });
        return;
      }
      params.teacher_role = teacher_role || null;
    }
    if (is_active !== undefined) {
      if (![true, false, 0, 1, "0", "1"].includes(is_active)) {
        res.status(400).json({ message: "is_active 仅支持布尔值或 0/1" });
        return;
      }
      params.is_active = is_active === true || is_active === 1 || is_active === "1" ? 1 : 0;
    }

    const updated = await getMysqlDb().transactionWithNamedLock("projectx:user-mutations", 5000, async (tx) => {
      const repo = new UserRepository(tx);
      const current = await repo.findByIdIncludingInactive(id);
      if (!current) throw Object.assign(new Error("用户不存在"), { status: 404 });
      const resultingNumber = params.student_number ?? current.student_number;
      if (params.role_id === ROLE_IDS.STUDENT || (params.role_id === undefined && current.role_id === ROLE_IDS.STUDENT)) {
        if (!resultingNumber) throw Object.assign(new Error("学生账号必须提供学号"), { status: 400 });
        const duplicate = await tx.get("SELECT id FROM users WHERE student_number = ? AND id <> ?", resultingNumber, id);
        if (duplicate) throw Object.assign(new Error("学号已存在"), { status: 409 });
      }
      const disablesLastAdmin = current.role_id === ROLE_IDS.ADMIN && current.is_active === 1
        && ((params.is_active === 0) || (params.role_id !== undefined && params.role_id !== ROLE_IDS.ADMIN));
      if (disablesLastAdmin && await isLastActiveAdmin(repo)) {
        throw Object.assign(new Error("系统至少需保留一名管理员，无法停用或降级"), { status: 400 });
      }
      await repo.updateUser(id, params);
      return repo.findByIdIncludingInactive(id);
    });
    // 禁用账号时吊销其会话
    if (params.is_active === 0) authService.revokeUserTokens(id);
    res.json(updated ? stripHash(updated) : null);
  } catch (error) {
    res.status(errorStatus(error)).json({ message: error instanceof Error ? error.message : "更新失败" });
  }
});

/** POST /api/users/:id/reset-password — 管理员重置密码 */
router.post("/:id/reset-password", requirePermission(PERMISSIONS.USER_MANAGE), async (req: Request, res: Response) => {
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
router.delete("/:id", requirePermission(PERMISSIONS.USER_MANAGE), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    await getMysqlDb().transactionWithNamedLock("projectx:user-mutations", 5000, async (tx) => {
      const repo = new UserRepository(tx);
      const existing = await repo.findByIdIncludingInactive(id);
      if (!existing) throw Object.assign(new Error("用户不存在"), { status: 404 });
      if (existing.role_id === ROLE_IDS.ADMIN && existing.is_active === 1 && await isLastActiveAdmin(repo)) {
        throw Object.assign(new Error("系统至少需保留一名管理员，无法禁用"), { status: 400 });
      }
      await repo.deactivateUser(id);
    });
    authService.revokeUserTokens(id);
    res.json({ message: "账号已禁用" });
  } catch (error) {
    res.status(errorStatus(error)).json({ message: error instanceof Error ? error.message : "禁用失败" });
  }
});

/** POST /api/users/:id/reactivate — 重新启用账号 */
router.post("/:id/reactivate", requirePermission(PERMISSIONS.USER_MANAGE), async (req: Request, res: Response) => {
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
router.post("/import-students", requirePermission(PERMISSIONS.USER_MANAGE), async (req: Request, res: Response) => {
  try {
    const students = req.body?.students;
    if (!Array.isArray(students) || students.length === 0) {
      res.status(400).json({ message: "请提供 students 数组" });
      return;
    }
    const rows: BatchStudentInput[] = students.map((s: Record<string, unknown>, index: number) => ({
      username: String(s.username ?? ""),
      name: String(s.name ?? ""),
      student_number: String(s.student_number ?? ""),
      password: s.password ? String(s.password) : undefined,
      track: s.track === undefined || s.track === null ? undefined : String(s.track),
      rowNumber: Number.isInteger(s.rowNumber) ? Number(s.rowNumber) : index + 2,
    }));
    const result = await userRepo.batchCreateStudents(rows);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "导入失败" });
  }
});

/** POST /api/users/import-csv — v1.1 统一批量导入（学生+教师从CSV文本） */
router.post("/import-csv", requirePermission(PERMISSIONS.USER_MANAGE), async (req: Request, res: Response) => {
  try {
    const { csvText } = req.body ?? {};
    if (!csvText || typeof csvText !== "string" || !csvText.trim()) {
      res.status(400).json({ message: "请提供 csvText（CSV 文本内容）" });
      return;
    }

    // 使用成熟 CSV 解析库，并按工作表行号保留空行，错误能指回原始记录。
    const workbook = XLSX.read(csvText.replace(/^\uFEFF/, ""), { type: "string", raw: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet || !sheet["!ref"]) {
      res.status(400).json({ message: "CSV 至少需要表头+1行数据" });
      return;
    }
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex++) {
      const row: string[] = [];
      for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
        row.push(cell ? String(cell.w ?? cell.v ?? "") : "");
      }
      rows.push(row);
      rowNumbers.push(rowIndex + 1);
    }
    const result = await userRepo.batchImportFromCsv(rows, rowNumbers);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "导入失败" });
  }
});

function parseStudentIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw Object.assign(new Error("请提供 1–500 个 studentIds"), { status: 400 });
  }
  const ids = value.map(Number);
  if (ids.some(id => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw Object.assign(new Error("studentIds 必须是不重复的有效学生 ID"), { status: 400 });
  }
  return ids;
}

async function assertRosterWriteScope(req: Request, sourceClassId: number, targetClassId: number | null): Promise<void> {
  const user = req.user;
  if (!user) throw Object.assign(new Error("未认证"), { status: 401 });
  if (!roleHasPermission(user.role_id, PERMISSIONS.CLASS_MANAGE)) {
    if (user.role_name !== ROLE_NAMES.TEACHER) {
      throw Object.assign(new Error(`权限不足：缺少 ${PERMISSIONS.CLASS_MANAGE}`), { status: 403 });
    }
    const isGradeLeader = user.teacher_role === TEACHER_ROLES.GRADE_LEADER;
    if (!isGradeLeader) {
      const scoped = user.teacher_role === TEACHER_ROLES.HEAD_TEACHER || user.teacher_role === TEACHER_ROLES.SUBJECT_TEACHER;
      if (!scoped || !await classRepo.isSourceClassHead(user.id, sourceClassId, user.teacher_role ?? null)) {
        throw Object.assign(new Error("权限不足：批量调班或移出只能由管理员、源班班主任或学年主任操作"), { status: 403 });
      }
      const accessible = await getAccessibleClassIds(user);
      if (accessible === null || !accessible.includes(sourceClassId) || (targetClassId !== null && !accessible.includes(targetClassId))) {
        throw Object.assign(new Error("权限不足：源班级与目标班级都必须在你任教或担任班主任的范围内"), { status: 403 });
      }
    }
  }
  if (!await hasClassViewPermission(user, sourceClassId, "can_view_students", { enforceMatrix: true })) {
    throw Object.assign(new Error("权限不足：管理员已关闭你对该班级「学生名单」的查看权限"), { status: 403 });
  }
}

async function validateRosterStudents(sourceClassId: number, studentIds: number[]): Promise<void> {
  for (const studentId of studentIds) {
    const student = await userRepo.findByIdIncludingInactive(studentId);
    if (!student || student.role_id !== ROLE_IDS.STUDENT || student.is_active !== 1) {
      throw Object.assign(new Error(`学生账号 ${studentId} 不存在或已停用`), { status: 400 });
    }
    if (!await classRepo.isStudentInClass(sourceClassId, studentId)) {
      throw Object.assign(new Error(`学生 ${studentId} 不在当前班级`), { status: 400 });
    }
  }
}

/** POST /api/users/classes/:sourceClassId/students/batch-move — 原子批量调班。 */
router.post("/classes/:sourceClassId/students/batch-move", async (req: Request, res: Response) => {
  try {
    const sourceClassId = Number(req.params.sourceClassId);
    const targetClassId = Number(req.body?.targetClassId);
    if (!Number.isInteger(sourceClassId) || sourceClassId <= 0 || !Number.isInteger(targetClassId) || targetClassId <= 0) {
      res.status(400).json({ message: "无效的班级 ID" });
      return;
    }
    const studentIds = parseStudentIds(req.body?.studentIds);
    await assertRosterWriteScope(req, sourceClassId, targetClassId);
    for (const studentId of studentIds) {
      if (!await hasClassViewPermission(req.user, sourceClassId, "can_view_students", { enforceMatrix: true })) {
        throw Object.assign(new Error(`权限不足：不能操作学生 ${studentId} 所在班级`), { status: 403 });
      }
    }
    const source = await classRepo.findClassById(sourceClassId);
    const target = await classRepo.findClassById(targetClassId);
    if (!source || !target) throw Object.assign(new Error("源班级或目标班级不存在"), { status: 400 });
    await validateRosterStudents(sourceClassId, studentIds);
    await classRepo.batchMoveStudents(sourceClassId, targetClassId, studentIds);
    res.json({ message: `已将 ${studentIds.length} 名学生调班到 ${target.grade_name} · ${target.name}`, moved: studentIds.length });
  } catch (error) {
    res.status(errorStatus(error)).json({ message: error instanceof Error ? error.message : "批量调班失败" });
  }
});

/** POST /api/users/classes/:sourceClassId/students/batch-remove — 原子批量移出。 */
router.post("/classes/:sourceClassId/students/batch-remove", async (req: Request, res: Response) => {
  try {
    const sourceClassId = Number(req.params.sourceClassId);
    if (!Number.isInteger(sourceClassId) || sourceClassId <= 0) {
      res.status(400).json({ message: "无效的班级 ID" });
      return;
    }
    const studentIds = parseStudentIds(req.body?.studentIds);
    await assertRosterWriteScope(req, sourceClassId, null);
    for (const studentId of studentIds) {
      if (!await hasClassViewPermission(req.user, sourceClassId, "can_view_students", { enforceMatrix: true })) {
        throw Object.assign(new Error(`权限不足：不能操作学生 ${studentId} 所在班级`), { status: 403 });
      }
    }
    if (!await classRepo.findClassById(sourceClassId)) throw Object.assign(new Error("源班级不存在"), { status: 400 });
    await validateRosterStudents(sourceClassId, studentIds);
    await classRepo.batchRemoveStudents(sourceClassId, studentIds);
    res.json({ message: `已从班级移出 ${studentIds.length} 名学生`, removed: studentIds.length });
  } catch (error) {
    res.status(errorStatus(error)).json({ message: error instanceof Error ? error.message : "批量移出失败" });
  }
});

export default router;
