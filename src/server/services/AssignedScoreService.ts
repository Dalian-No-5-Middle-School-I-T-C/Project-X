import { Parser } from "expr-eval";
import { getDatabase } from "../db";
import type { AssignedFormula, AssignedFormulaType } from "../../shared/types";

/**
 * 赋分科目列表（新高考选考科目）
 */
export const ASSIGNED_SCORE_SUBJECTS = ["化学", "生物", "地理", "政治"];

/**
 * 赋分引擎 v1.4.0
 *
 * 三种内置公式 + 自定义表达式：
 * A. proportional — 等比例转换
 *    assigned = minOut + (raw - minIn) / (maxIn - minIn) × (maxOut - minOut)
 * B. linear — 线性公式
 *    assigned = raw × a + b
 * C. custom — 自定义表达式 (expr-eval)
 *    可用变量: raw, max, min, avg, std
 */
export class AssignedScoreService {
  private db = getDatabase();
  private parser = new Parser();

  /**
   * 获取考试的赋分公式配置
   */
  getFormula(examId: number): AssignedFormula | null {
    const exam = this.db.prepare(
      "SELECT assigned_formula FROM exams WHERE id = ?"
    ).get(examId) as { assigned_formula: string | null } | undefined;

    if (!exam?.assigned_formula) return null;
    try {
      return JSON.parse(exam.assigned_formula) as AssignedFormula;
    } catch {
      return null;
    }
  }

  /**
   * 保存赋分公式配置
   */
  saveFormula(examId: number, formula: AssignedFormula): void {
    this.db.prepare("UPDATE exams SET assigned_formula = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify(formula), examId);
  }

  /**
   * 删除赋分公式（禁用赋分）
   */
  disableFormula(examId: number): void {
    this.db.prepare("UPDATE exams SET assigned_formula = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(examId);
    this.db.prepare("UPDATE student_scores SET assigned_score = NULL WHERE exam_id = ?").run(examId);
  }

  /**
   * 计算单个学生的赋分
   */
  calculateAssignedScore(
    rawScore: number,
    formula: AssignedFormula,
    stats: { max: number; min: number; avg: number; std: number }
  ): number {
    if (!formula.enabled) return rawScore;

    switch (formula.type) {
      case "proportional": {
        const { minIn = 0, maxIn = 100, minOut = 30, maxOut = 100 } = formula.params;
        const span = (maxIn - minIn) || 1;
        const result = minOut + ((rawScore - minIn) / span) * (maxOut - minOut);
        // 钳制到合理范围 [minOut-10, maxOut+10]
        return Math.round(Math.max(minOut - 10, Math.min(maxOut + 10, result)) * 10) / 10;
      }
      case "linear": {
        const { a = 0.7, b = 30 } = formula.params;
        const result = rawScore * a + b;
        return Math.round(Math.max(0, Math.min(120, result)) * 10) / 10;
      }
      case "custom": {
        if (!formula.params.expression) return rawScore;
        try {
          const expr = this.parser.parse(formula.params.expression);
          const result = expr.evaluate({
            raw: rawScore,
            max: stats.max,
            min: stats.min,
            avg: stats.avg,
            std: stats.std
          });
          if (typeof result === "number" && Number.isFinite(result)) {
            return Math.round(result * 10) / 10;
          }
        } catch {
          // expression parse error — return raw
        }
        return rawScore;
      }
      default:
        return rawScore;
    }
  }

  /**
   * 对整场考试执行赋分重算
   */
  recalculateAll(examId: number): { updated: number; skipped: number } {
    const formula = this.getFormula(examId);
    if (!formula || !formula.enabled) {
      return { updated: 0, skipped: 0 };
    }

    // 获取统计数据
    const stats = this.db.prepare(`
      SELECT
        MAX(total_score) as max,
        MIN(total_score) as min,
        AVG(total_score) as avg,
        SQRT(AVG((total_score - (SELECT AVG(total_score) FROM student_scores WHERE exam_id = ?)) * (total_score - (SELECT AVG(total_score) FROM student_scores WHERE exam_id = ?)))) as std
      FROM student_scores WHERE exam_id = ?
    `).get(examId, examId) as { max: number; min: number; avg: number; std: number };

    const students = this.db.prepare(
      "SELECT student_id, total_score FROM student_scores WHERE exam_id = ?"
    ).all(examId) as Array<{ student_id: number; total_score: number }>;

    const updateStmt = this.db.prepare(
      "UPDATE student_scores SET assigned_score = ? WHERE exam_id = ? AND student_id = ?"
    );

    let updated = 0;
    let skipped = 0;

    const tx = this.db.transaction(() => {
      for (const s of students) {
        if (s.total_score == null) {
          skipped++;
          continue;
        }
        const assigned = this.calculateAssignedScore(s.total_score, formula, stats);
        updateStmt.run(assigned, examId, s.student_id);
        updated++;
      }
    });

    tx();
    return { updated, skipped };
  }

  /**
   * 判断科目是否需要赋分
   */
  static isAssignedSubject(subject: string): boolean {
    return ASSIGNED_SCORE_SUBJECTS.includes(subject);
  }

  /**
   * 获取所有可用公式预设
   */
  static getFormulaPresets(): Array<{ id: string; name: string; formula: AssignedFormula }> {
    return [
      {
        id: "proportional-default",
        name: "等比例转换 (新高考常用)",
        formula: {
          type: "proportional",
          enabled: true,
          params: { minIn: 0, maxIn: 100, minOut: 30, maxOut: 100 }
        }
      },
      {
        id: "linear-070",
        name: "线性公式 (原始分×0.7+30)",
        formula: {
          type: "linear",
          enabled: true,
          params: { a: 0.7, b: 30 }
        }
      },
      {
        id: "custom-starter",
        name: "自定义 (可编辑表达式)",
        formula: {
          type: "custom",
          enabled: true,
          params: { expression: "raw * 0.7 + 30" }
        }
      }
    ];
  }
}
