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
  confidence: { label: "置信度", category: "other" },
  objectiveSubScores: { label: "客观题小分", category: "questions" },
  subjectiveSubScores: { label: "主观题小分", category: "questions" }
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

    const db = getDatabase();
    const analysisRepo = new AnalysisRepository();
    const { rows, examName, hasAssignedScore } = analysisRepo.getScoreTableData(examId, classId);

    // Determine if we need sub-scores
    const needObjSub = columns.includes("objectiveSubScores");
    const needSubjSub = columns.includes("subjectiveSubScores");

    // Fetch question definitions and scores if needed
    let objQuestionDefs: Array<{ questionNumber: number; maxScore: number }> = [];
    let subQuestionDefs: Array<{ questionNumber: number; maxScore: number }> = [];
    let subScoreMap: Map<number, Map<number, number>> = new Map(); // studentId -> questionNumber -> score

    if (needObjSub || needSubjSub) {
      const allQs = db.prepare(`
        SELECT question_number as questionNumber, score_type, MAX(max_score) as maxScore
        FROM question_scores WHERE exam_id = ?
        GROUP BY question_number, score_type
        ORDER BY question_number
      `).all(examId) as Array<{ questionNumber: number; score_type: string; maxScore: number }>;

      objQuestionDefs = allQs.filter((q) => q.score_type === "objective");
      subQuestionDefs = allQs.filter((q) => q.score_type === "subjective");

      // Fetch all sub-scores
      const allSubScores = db.prepare(`
        SELECT student_id as studentId, question_number as questionNumber, score
        FROM question_scores WHERE exam_id = ?
      `).all(examId) as Array<{ studentId: number; questionNumber: number; score: number }>;

      for (const s of allSubScores) {
        if (!subScoreMap.has(s.studentId)) subScoreMap.set(s.studentId, new Map());
        subScoreMap.get(s.studentId)!.set(s.questionNumber, s.score);
      }
    }

    // Build headers dynamically
    const baseCols = columns.filter((c) => c !== "objectiveSubScores" && c !== "subjectiveSubScores");
    const headers: string[] = [];

    for (const col of baseCols) {
      switch (col) {
        case "studentNumber": headers.push("考号"); break;
        case "grade": headers.push("年级"); break;
        case "className": headers.push("班级"); break;
        case "studentName": headers.push("姓名"); break;
        case "totalScore": headers.push("原始分"); break;
        case "assignedScore": if (hasAssignedScore) headers.push("赋分"); break;
        case "objectiveScore": headers.push("客观分"); break;
        case "subjectiveScore": headers.push("主观分"); break;
        case "gradeRank": headers.push("年排"); break;
        case "classRank": headers.push("班排"); break;
        case "rankChange": headers.push("名次变化"); break;
        case "displayValue": headers.push("偏差值/Z值"); break;
        case "needsReview": headers.push("需要复核"); break;
        case "confidence": headers.push("置信度"); break;
      }
    }

    // Add sub-score headers
    if (needObjSub) {
      objQuestionDefs.forEach((q) => headers.push(`客观Q${q.questionNumber}(${q.maxScore}分)`));
    }
    if (needSubjSub) {
      subQuestionDefs.forEach((q) => headers.push(`主观Q${q.questionNumber}(${q.maxScore}分)`));
    }

    // Build data rows
    const data: Record<string, string | number | null>[] = [];

    for (const row of rows) {
      const exportRow: Record<string, string | number | null> = {};

      for (const col of baseCols) {
        switch (col) {
          case "studentNumber": exportRow["考号"] = row.studentNumber; break;
          case "grade": exportRow["年级"] = row.gradeName || "-"; break;
          case "className": exportRow["班级"] = row.className; break;
          case "studentName": exportRow["姓名"] = row.studentName; break;
          case "totalScore": exportRow["原始分"] = row.totalScore; break;
          case "assignedScore": if (hasAssignedScore) exportRow["赋分"] = row.assignedScore; break;
          case "objectiveScore": exportRow["客观分"] = row.objectiveScore; break;
          case "subjectiveScore": exportRow["主观分"] = row.subjectiveScore; break;
          case "gradeRank": exportRow["年排"] = row.gradeRank; break;
          case "classRank": exportRow["班排"] = row.classRank; break;
          case "rankChange": {
            const ch = row.rankChange;
            exportRow["名次变化"] = ch == null ? "-" : (ch > 0 ? `↑+${ch}` : ch < 0 ? `↓${ch}` : "0");
            break;
          }
          case "displayValue": exportRow["偏差值/Z值"] = row.displayValue; break;
          case "needsReview": exportRow["需要复核"] = ""; break;
          case "confidence": exportRow["置信度"] = null; break;
        }
      }

      // Add sub-scores
      if (needObjSub) {
        const scoreMap = subScoreMap.get(row.studentId);
        objQuestionDefs.forEach((q) => {
          const key = `客观Q${q.questionNumber}(${q.maxScore}分)`;
          exportRow[key] = scoreMap?.get(q.questionNumber) ?? "";
        });
      }
      if (needSubjSub) {
        const scoreMap = subScoreMap.get(row.studentId);
        subQuestionDefs.forEach((q) => {
          const key = `主观Q${q.questionNumber}(${q.maxScore}分)`;
          exportRow[key] = scoreMap?.get(q.questionNumber) ?? "";
        });
      }

      data.push(exportRow);
    }

    const wb = XLSX.utils.book_new();

    // Main sheet
    const ws = XLSX.utils.json_to_sheet(data, { header: headers });

    // Set column widths
    const colWidths: number[] = [];
    for (const h of headers) {
      if (h.startsWith("客观Q") || h.startsWith("主观Q")) {
        colWidths.push(8);
      } else {
        const wMap: Record<string, number> = {
          "考号": 14, "年级": 8, "班级": 10, "姓名": 10,
          "原始分": 8, "赋分": 8, "客观分": 8, "主观分": 8,
          "年排": 6, "班排": 6, "名次变化": 10, "偏差值/Z值": 12,
          "需要复核": 8, "置信度": 8
        };
        colWidths.push(wMap[h] ?? 10);
      }
    }
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
      const sideWidths = [6, 10, 8];
      for (let i = 0; i < sideWidths.length; i++) {
        if (!ws["!cols"]) ws["!cols"] = [];
        ws["!cols"][originCol + i] = { wch: sideWidths[i] };
      }

      XLSX.utils.sheet_add_json(ws, [{ "": `年级前${sideTableN}名` }], { origin: { r: 0, c: originCol }, skipHeader: true });
    }

    XLSX.utils.book_append_sheet(wb, ws, "成绩表");

    const fileName = `${examName.replace(/[\\/:*?"<>|]/g, "_")}_成绩表.xlsx`;
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(buf);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "导出失败" });
  }
});

export default router;
