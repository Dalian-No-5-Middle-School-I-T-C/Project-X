import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import type { AssignedFormula, AssignedFormulaType } from "../../shared/types";

/**
 * 赋分科目列表（新高考选考科目）
 */
export const ASSIGNED_SCORE_SUBJECTS = ["化学", "生物", "地理", "政治"];

/**
 * 赋分引擎 v1.4.0
 *
 * 两种内置公式；历史 custom 配置仅保留数据，不再执行：
 * A. proportional — 等比例转换
 *    assigned = minOut + (raw - minIn) / (maxIn - minIn) × (maxOut - minOut)
 * B. linear — 线性公式
 *    assigned = raw × a + b
 */
export class AssignedScoreService {
  private db: DbAdapter;
  private customWarningLogged = false;

  constructor() {
    this.db = getMysqlDb();
  }

  /**
   * 获取考试的赋分公式配置
   */
  async getFormula(examId: number): Promise<AssignedFormula | null> {
    const exam = await this.db.get(
      "SELECT assigned_formula FROM exams WHERE id = ?",
      examId
    ) as { assigned_formula: string | null } | undefined;

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
  async saveFormula(examId: number, formula: AssignedFormula): Promise<void> {
    await this.db.run(
      "UPDATE exams SET assigned_formula = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      JSON.stringify(formula), examId
    );
  }

  /**
   * 删除赋分公式（禁用赋分）
   */
  async disableFormula(examId: number): Promise<void> {
    await this.db.run(
      "UPDATE exams SET assigned_formula = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      examId
    );
    await this.db.run("UPDATE student_scores SET assigned_score = NULL WHERE exam_id = ?", examId);
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
        return Math.round(Math.max(minOut - 10, Math.min(maxOut + 10, result)) * 10) / 10;
      }
      case "linear": {
        const { a = 0.7, b = 30 } = formula.params;
        const result = rawScore * a + b;
        return Math.round(Math.max(0, Math.min(120, result)) * 10) / 10;
      }
      case "custom": {
        if (!this.customWarningLogged) {
          console.warn("[AssignedScore] CUSTOM_FORMULA_DISABLED: 历史自定义表达式未执行，保留原始分数");
          this.customWarningLogged = true;
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
  async recalculateAll(examId: number): Promise<{ updated: number; skipped: number }> {
    const formula = await this.getFormula(examId);
    if (!formula || !formula.enabled) {
      return { updated: 0, skipped: 0 };
    }
    if (formula.type === "custom") {
      console.warn(`[AssignedScore] CUSTOM_FORMULA_DISABLED: exam ${examId} 未执行重算`);
      return { updated: 0, skipped: 0 };
    }

    const stats = await this.db.get(`
      SELECT
        MAX(total_score) as max,
        MIN(total_score) as min,
        AVG(total_score) as avg
      FROM student_scores WHERE exam_id = ?
    `, examId) as { max: number; min: number; avg: number };

    const scores = await this.db.all(
      "SELECT total_score FROM student_scores WHERE exam_id = ?",
      examId
    ) as Array<{ total_score: number }>;

    const vals = scores.map((s) => s.total_score);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    const stdStats = { max: stats.max, min: stats.min, avg: stats.avg, std };

    const students = await this.db.all(
      "SELECT student_id, total_score FROM student_scores WHERE exam_id = ?",
      examId
    ) as Array<{ student_id: number; total_score: number }>;

    let updated = 0;
    let skipped = 0;

    await this.db.transaction(async (tx) => {
      for (const s of students) {
        if (s.total_score == null) {
          skipped++;
          continue;
        }
        const assigned = this.calculateAssignedScore(s.total_score, formula, stdStats);
        await tx.run(
          "UPDATE student_scores SET assigned_score = ? WHERE exam_id = ? AND student_id = ?",
          assigned, examId, s.student_id
        );
        updated++;
      }
    });

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
          type: "proportional", enabled: true,
          params: { minIn: 0, maxIn: 100, minOut: 30, maxOut: 100 }
        }
      },
      {
        id: "linear-070",
        name: "线性公式 (原始分×0.7+30)",
        formula: {
          type: "linear", enabled: true,
          params: { a: 0.7, b: 30 }
        }
      }
    ];
  }
}
