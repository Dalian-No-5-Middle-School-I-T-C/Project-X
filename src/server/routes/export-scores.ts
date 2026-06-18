import express from "express";
import type { Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getDatabase } from "../db";
import XLSX from "xlsx";
import { AnalysisRepository } from "../repositories/AnalysisRepository";
import type { ExportTemplate, ExportConfigRequest } from "../../shared/types";

const router = express.Router();
router.use(authMiddleware);

// ── 模板 CRUD ──────────────────────────────────────────

/** GET /api/export/templates — 获取当前用户的导出模板 */
router.get("/templates", (req: Request, res: Response) => {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT id, slot, name, columns, side_table_n, gap_cols FROM export_templates WHERE user_id = ? ORDER BY slot"
  ).all(req.user!.id) as Array<{ id: number; slot: number; name: string; columns: string; side_table_n: number; gap_cols: number }>;
  const templates = rows.map((r) => ({
    ...r,
    columns: (() => { try { return JSON.parse(r.columns); } catch { return []; } })()
  }));
  res.json(templates);
});

/** PUT /api/export/templates/:slot — 保存/更新模板 */
router.put("/templates/:slot", (req: Request, res: Response) => {
  const db = getDatabase();
  const slot = Number(req.params.slot);
  if (slot < 1 || slot > 4) { res.status(400).json({ message: "槽位须为 1-4" }); return; }

  const { name, columns, sideTableN, gapCols } = req.body as {
    name?: string; columns?: string[]; sideTableN?: number; gapCols?: number;
  };

  db.prepare(`
    INSERT INTO export_templates (user_id, slot, name, columns, side_table_n, gap_cols)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, slot) DO UPDATE SET
      name = excluded.name, columns = excluded.columns,
      side_table_n = excluded.side_table_n, gap_cols = excluded.gap_cols,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    req.user!.id, slot,
    name ?? "未命名",
    JSON.stringify(columns ?? []),
    sideTableN ?? 0,
    gapCols ?? 3
  );
  res.json({ ok: true, slot });
});

/** DELETE /api/export/templates/:slot — 删除模板 */
router.delete("/templates/:slot", (req: Request, res: Response) => {
  const db = getDatabase();
  const slot = Number(req.params.slot);
  db.prepare("DELETE FROM export_templates WHERE user_id = ? AND slot = ?")
    .run(req.user!.id, slot);
  res.json({ ok: true });
});

// ── 成绩导出 ───────────────────────────────────────────

const ALL_COLUMNS: Record<string, { label: string; category: string }> = {
  studentNumber: { label: "考号", category: "basic" },
  grade: { label: "年级", category: "basic" },
  className: { label: "班级", category: "basic" },
  studentName: { label: "姓名", category: "basic" },
  totalScore: { label: "原始分", category: "score" },
  assignedScore: { label: "赋分", category: "score" },
  objectiveScore: { label: "客观分", category: "score" },
  subjectiveScore: { label: "主观分", category: "score" },
  gradeRank: { label: "年排", category: "ranking" },
  classRank: { label: "班排", category: "ranking" },
  rankChange: { label: "名次变化", category: "ranking" },
  displayValue: { label: "偏差值/Z值", category: "other" },
  needsReview: { label: "需要复核", category: "other" },
  confidence: { label: "置信度", category: "other" }
};

/** GET /api/export/columns — 获取可用列定义 */
router.get("/columns", (_req: Request, res: Response) => {
  res.json({ columns: ALL_COLUMNS });
});

/** POST /api/export/exams/:examId/scores — 按配置导出 Excel */
router.post("/exams/:examId/scores", async (req: Request, res: Response) => {
  try {
    const examId = Number(req.params.examId);
    const { columns, classId, sideTableN, gapCols } = req.body as ExportConfigRequest;

    if (!columns || columns.length === 0) {
      res.status(400).json({ message: "请至少选择一列" });
      return;
    }

    const analysisRepo = new AnalysisRepository();
    const { rows, examName, hasAssignedScore } = analysisRepo.getScoreTableData(examId, classId);

    // Map to export rows
    const headerMap: Record<string, string> = {};
    const data: Record<string, string | number | null>[] = [];

    for (const row of rows) {
      const exportRow: Record<string, string | number | null> = {};
      for (const col of columns) {
        switch (col) {
          case "studentNumber": exportRow["考号"] = row.studentNumber; headerMap["考号"] = "考号"; break;
          case "grade": exportRow["年级"] = row.gradeName || "-"; headerMap["年级"] = "年级"; break;
          case "className": exportRow["班级"] = row.className; headerMap["班级"] = "班级"; break;
          case "studentName": exportRow["姓名"] = row.studentName; headerMap["姓名"] = "姓名"; break;
          case "totalScore": exportRow["原始分"] = row.totalScore; headerMap["原始分"] = "原始分"; break;
          case "assignedScore": if (hasAssignedScore) { exportRow["赋分"] = row.assignedScore; headerMap["赋分"] = "赋分"; }; break;
          case "objectiveScore": exportRow["客观分"] = row.objectiveScore; headerMap["客观分"] = "客观分"; break;
          case "subjectiveScore": exportRow["主观分"] = row.subjectiveScore; headerMap["主观分"] = "主观分"; break;
          case "gradeRank": exportRow["年排"] = row.gradeRank; headerMap["年排"] = "年排"; break;
          case "classRank": exportRow["班排"] = row.classRank; headerMap["班排"] = "班排"; break;
          case "rankChange": {
            const ch = row.rankChange;
            exportRow["名次变化"] = ch == null ? "-" : (ch > 0 ? `↑+${ch}` : ch < 0 ? `↓${ch}` : "0");
            headerMap["名次变化"] = "名次变化";
            break;
          }
          case "displayValue": exportRow["偏差值/Z值"] = row.displayValue; headerMap["偏差值/Z值"] = "偏差值/Z值"; break;
          case "needsReview": exportRow["需要复核"] = ""; headerMap["需要复核"] = "需要复核"; break;
        }
      }
      data.push(exportRow);
    }

    const wb = XLSX.utils.book_new();

    // Main sheet
    const ws = XLSX.utils.json_to_sheet(data);

    // Set column widths (approximate for A4)
    const colWidths: number[] = columns.map((col) => {
      const wMap: Record<string, number> = {
        studentNumber: 14, grade: 8, className: 10, studentName: 10,
        totalScore: 8, assignedScore: 8, objectiveScore: 8, subjectiveScore: 8,
        gradeRank: 6, classRank: 6, rankChange: 10, displayValue: 12,
        needsReview: 8, confidence: 8
      };
      return wMap[col] ?? 10;
    });
    ws["!cols"] = colWidths.map((w) => ({ wch: w }));

    // Side table (top N)
    if (sideTableN > 0) {
      const topN = rows.slice(0, sideTableN);
      const sideData = topN.map((r) => ({
        "年排": r.gradeRank,
        "班级": r.className,
        "原始分": r.totalScore
      }));

      const gap = gapCols || 3;
      const mainCols = colWidths.length;
      const originCol = mainCols + gap;

      XLSX.utils.sheet_add_json(ws, sideData, { origin: { r: 0, c: originCol } });
      // Set side table column widths
      const sideWidths = [6, 10, 8];
      for (let i = 0; i < sideWidths.length; i++) {
        if (!ws["!cols"]) ws["!cols"] = [];
        ws["!cols"][originCol + i] = { wch: sideWidths[i] };
      }

      // Side table title
      XLSX.utils.sheet_add_json(ws, [{ "": `年级前${sideTableN}名` }], { origin: { r: 0, c: originCol }, skipHeader: true });
    }

    XLSX.utils.book_append_sheet(wb, ws, "成绩表");

    const fileName = `${examName.replace(/[\/:*?"<>|]/g, "_")}_成绩表.xlsx`;
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(buf);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "导出失败" });
  }
});

export default router;
