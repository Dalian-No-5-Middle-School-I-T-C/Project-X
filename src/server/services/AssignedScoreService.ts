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
   * 传入外部 db（如事务适配器）时在调用方事务内执行；未传时使用自身连接。
   */
  async disableFormula(examId: number, db: DbAdapter = this.db): Promise<void> {
    await db.run(
      "UPDATE exams SET assigned_formula = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      examId
    );
    await db.run("UPDATE student_scores SET assigned_score = NULL WHERE exam_id = ?", examId);
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
   * 对整场考试执行赋分重算。
   * 传入外部 db（如事务适配器）时在调用方事务内执行；未传时使用自身连接。
   * 赋分批量更新使用单条 CASE WHEN 语句（语句级原子性）：
   * 任一学生失败则整条语句回滚，不会残留“部分新口径、部分旧口径”的混合状态；
   * 天然兼容 SQLite 与 MariaDB（不依赖 SAVEPOINT 的预处理差异）。
   */
  async recalculateAll(examId: number, db: DbAdapter = this.db): Promise<{ updated: number; skipped: number }> {
    const formula = await this.getFormula(examId);
    if (!formula || !formula.enabled) {
      return { updated: 0, skipped: 0 };
    }
    if (formula.type === "custom") {
      console.warn(`[AssignedScore] CUSTOM_FORMULA_DISABLED: exam ${examId} 未执行重算`);
      return { updated: 0, skipped: 0 };
    }

    const stats = await db.get(`
      SELECT
        MAX(total_score) as max,
        MIN(total_score) as min,
        AVG(total_score) as avg
      FROM student_scores WHERE exam_id = ?
    `, examId) as { max: number; min: number; avg: number };

    const scores = await db.all(
      "SELECT total_score FROM student_scores WHERE exam_id = ?",
      examId
    ) as Array<{ total_score: number }>;

    const vals = scores.map((s) => s.total_score);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    const stdStats = { max: stats.max, min: stats.min, avg: stats.avg, std };

    const students = await db.all(
      "SELECT student_id, total_score FROM student_scores WHERE exam_id = ?",
      examId
    ) as Array<{ student_id: number; total_score: number }>;

    const pending = students
      .filter((s) => s.total_score != null)
      .map((s) => ({
        studentId: s.student_id,
        assigned: this.calculateAssignedScore(s.total_score, formula, stdStats)
      }));
    const skipped = students.length - pending.length;

    if (pending.length > 0) {
      // 单条 UPDATE 内以 CASE WHEN 逐学生赋值：任一学生（触发器/约束）失败，
      // 数据库回滚整条语句，所有学生保持原赋分。
      // 参数数量 = 2n + 1 + n；SQLite 默认变量上限 32766、MariaDB 预编译上限更高，
      // 单场考试数千学生以内均安全（学校场景远低于此）。
      const cases = pending.map(() => "WHEN student_id = ? THEN ?").join(" ");
      const ids = pending.map((p) => p.studentId);
      const params: unknown[] = [];
      for (const p of pending) params.push(p.studentId, p.assigned);
      params.push(examId, ...ids);
      await db.run(
        `UPDATE student_scores
         SET assigned_score = CASE ${cases} ELSE assigned_score END
         WHERE exam_id = ? AND student_id IN (${ids.map(() => "?").join(",")})`,
        ...params
      );
    }

    return { updated: pending.length, skipped };
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
