import express from "express";
import type { Request, Response } from "express";
import { UserRepository } from "../repositories/UserRepository";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import XLSX from "xlsx";

/**
 * 账密导出 API（仅管理员）
 * 挂载点：/api/export
 * 统一 Excel (.xlsx) 输出
 */
const router = express.Router();
const userRepo = new UserRepository();

router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

/** GET /api/export/students — 导出学生账密 Excel */
router.get("/students", (_req: Request, res: Response) => {
  try {
    const rows = userRepo.listAllStudentsForExport();
    const data = rows.map((r) => ({
      "年级": r.grade_name,
      "班级": r.class_name,
      "学号": r.student_number ?? "",
      "姓名": r.name,
      "账号": r.username,
      "密码": r.initial_password ?? ""
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [
      { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 16 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "学生账密");

    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''student_accounts.xlsx");
    res.send(buf);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "导出失败" });
  }
});

/** GET /api/export/teachers — 导出教师账密 Excel */
router.get("/teachers", (_req: Request, res: Response) => {
  try {
    const teachers = userRepo.listAllTeachersForExport();
    const data = teachers.map((t) => ({
      "科目": t.subject ?? "",
      "姓名": t.name,
      "账号": t.username,
      "密码": t.initial_password ?? ""
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [
      { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 16 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "教师账密");

    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''teacher_accounts.xlsx");
    res.send(buf);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "导出失败" });
  }
});

/** GET /api/export/students.csv — 重定向到 .xlsx（兼容旧 URL） */
router.get("/students.csv", (req: Request, res: Response) => {
  res.redirect(301, "/api/export/students");
});

/** GET /api/export/teachers.csv — 重定向到 .xlsx（兼容旧 URL） */
router.get("/teachers.csv", (req: Request, res: Response) => {
  res.redirect(301, "/api/export/teachers");
});

export default router;
