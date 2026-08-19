/**
 * 管理员控制台聚合 API（Issue A · P1）。
 *
 * 设计原则：
 *  - 全部端点复用 SYSTEM_MANAGE 权限，仅管理员可见。
 *  - 仅返回聚合值，绝不返回个人明细（无 PII）。
 *  - 逐步解除控制台对业务表结构的直接依赖：聚合查询集中在本文件，
 *    前端不再直连业务表。
 *  - 防御式：新表（ai_analysis_runs / entity_lifecycle_events）可能尚未随
 *    运行期迁移落到已初始化的生产库，查询以 try/catch + hasTable 兜底，
 *    缺失时返回 not_available 而非报错。
 *
 * 挂载点：/api/admin/console
 */
import { Router } from "express";
import { getMysqlDb, type DbAdapter } from "../db";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";

const router = Router();
router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.SYSTEM_MANAGE));

/** 探测表是否存在（双后端安全） */
async function hasTable(db: DbAdapter, table: string): Promise<boolean> {
  try {
    await db.get(`SELECT 1 FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function countWhere(db: DbAdapter, table: string, where = ""): Promise<number> {
  const sql = `SELECT COUNT(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ""}`;
  const row = await db.get<{ c: number }>(sql);
  return row?.c ?? 0;
}

// ── GET /api/admin/console/summary ──────────────────────
router.get("/summary", async (_req, res, next) => {
  try {
    const db = getMysqlDb();
    const examsTotal = await countWhere(db, "exams");
    const examsFormal = await countWhere(db, "exams", "exam_mode = 'formal'");
    const examsQuiz = await countWhere(db, "exams", "exam_mode = 'quiz'");
    const examsReview = await countWhere(db, "exams", "review_enabled = 1");

    // 现存答题卡 = 非演示数据（is_demo=0）
    const cardsTotal = await countWhere(db, "answer_cards");
    const cardsActive = await countWhere(db, "answer_cards", "is_demo = 0");

    const usersTotal = await countWhere(db, "users");
    // users 表无 role_name 列（角色名在 roles 表），须 JOIN 统计；一次查询取全部角色分布
    const roleRows = await db.all<{ name: string; c: number }>(
      `SELECT r.name, COUNT(*) AS c
       FROM users u JOIN roles r ON r.id = u.role_id
       GROUP BY r.name`
    );
    const roleMap = new Map(roleRows.map((r) => [r.name, r.c]));
    const usersTeachers = roleMap.get("teacher") ?? 0;
    const usersStudents = roleMap.get("student") ?? 0;
    const usersAdmins = roleMap.get("admin") ?? 0;

    // 阅卷完成率（answer_block_crops：review_round>0 视为已评）
    let grading = { cropsTotal: 0, cropsGraded: 0, completionRate: 0 };
    if (await hasTable(db, "answer_block_crops")) {
      const total = await countWhere(db, "answer_block_crops");
      const graded = await countWhere(db, "answer_block_crops", "review_round > 0");
      grading = {
        cropsTotal: total,
        cropsGraded: graded,
        completionRate: total > 0 ? Math.round((graded / total) * 1000) / 10 : 0,
      };
    }

    res.json({
      exams: {
        total: examsTotal,
        formal: examsFormal,
        quiz: examsQuiz,
        reviewEnabled: examsReview,
      },
      answerCards: {
        total: cardsTotal,
        active: cardsActive, // 现存答题卡（剔除演示数据）
      },
      users: {
        total: usersTotal,
        teachers: usersTeachers,
        students: usersStudents,
        admins: usersAdmins,
      },
      grading,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/console/activity ─────────────────────
router.get("/activity", async (_req, res, next) => {
  try {
    const db = getMysqlDb();
    // 优先使用生命周期事件表（实体创建/归档/删除/恢复）
    if (await hasTable(db, "entity_lifecycle_events")) {
      const rows = await db.all<{ entity_type: string; action: string; cnt: number; last_at: string }>(
        `SELECT entity_type, action, COUNT(*) AS cnt, MAX(created_at) AS last_at
         FROM entity_lifecycle_events
         GROUP BY entity_type, action
         ORDER BY last_at DESC
         LIMIT 50`
      );
      res.json({
        source: "entity_lifecycle_events",
        events: rows.map((r) => ({
          entityType: r.entity_type,
          action: r.action,
          count: r.cnt,
          lastAt: r.last_at,
        })),
        generatedAt: new Date().toISOString(),
      });
      return;
    }
    // 兜底：最近创建的考试与答题卡
    const recentExams = await db.all<{ day: string; cnt: number }>(
      `SELECT DATE(created_at) AS day, COUNT(*) AS cnt
       FROM exams WHERE created_at IS NOT NULL
       GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 14`
    );
    const recentCards = await db.all<{ day: string; cnt: number }>(
      `SELECT DATE(created_at) AS day, COUNT(*) AS cnt
       FROM answer_cards WHERE created_at IS NOT NULL
       GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 14`
    );
    res.json({
      source: "fallback_created_at",
      recentExams,
      recentCards,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/console/preferences ──────────────────
router.get("/preferences", async (_req, res, next) => {
  try {
    const db = getMysqlDb();
    const dist = async (col: string, table = "users"): Promise<Record<string, number>> => {
      const rows = await db.all<{ v: string | null; c: number }>(
        `SELECT ${col} AS v, COUNT(*) AS c FROM ${table} GROUP BY ${col}`
      );
      const out: Record<string, number> = {};
      for (const r of rows) out[r.v == null ? "null" : String(r.v)] = r.c;
      return out;
    };

    res.json({
      scoreDisplayMode: await dist("score_display_mode"),
      showTabBar: await dist("show_tab_bar"),
      // 皮肤：优先 ui_style，缺失时由 theme_skin 反推
      theme: await dist("COALESCE(NULLIF(ui_style, ''), theme_skin)"),
      colorScheme: await dist("color_scheme"),
      track: await dist("track"),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/console/ai-usage ─────────────────────
router.get("/ai-usage", async (_req, res, next) => {
  try {
    const db = getMysqlDb();
    if (!(await hasTable(db, "ai_analysis_runs"))) {
      res.json({ available: false, reason: "ai_analysis_runs 表不存在（尚未运行期迁移）", generatedAt: new Date().toISOString() });
      return;
    }
    const totals = await db.get<{
      runs: number; success: number; failed: number;
      tin: number | null; tout: number | null; avgLatency: number | null;
    }>(
      `SELECT COUNT(*) AS runs,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
              SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
              AVG(latency_ms) AS avgLatency
       FROM ai_analysis_runs`
    );
    const byFeature = await db.all<{
      feature: string; cnt: number; success: number; avgLatency: number | null;
      tin: number | null; tout: number | null;
    }>(
      `SELECT feature, COUNT(*) AS cnt,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
              AVG(latency_ms) AS avgLatency,
              SUM(tokens_in) AS tin, SUM(tokens_out) AS tout
       FROM ai_analysis_runs GROUP BY feature ORDER BY cnt DESC`
    );
    res.json({
      available: true,
      totals: {
        runs: totals?.runs ?? 0,
        success: totals?.success ?? 0,
        failed: totals?.failed ?? 0,
        totalTokensIn: totals?.tin ?? 0,
        totalTokensOut: totals?.tout ?? 0,
        avgLatencyMs: totals?.avgLatency != null ? Math.round(totals.avgLatency) : 0,
      },
      byFeature: byFeature.map((r) => ({
        feature: r.feature,
        count: r.cnt,
        success: r.success,
        successRate: r.cnt > 0 ? Math.round((r.success / r.cnt) * 1000) / 10 : 0,
        avgLatencyMs: r.avgLatency != null ? Math.round(r.avgLatency) : 0,
        totalTokens: (r.tin ?? 0) + (r.tout ?? 0),
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/console/data-quality ─────────────────
router.get("/data-quality", async (_req, res, next) => {
  try {
    const db = getMysqlDb();

    // 原卷附着率：answer_cards.has_original_paper = 1 的比例
    const cardsTotal = await countWhere(db, "answer_cards", "is_demo = 0");
    const withOriginal = await countWhere(db, "answer_cards", "is_demo = 0 AND has_original_paper = 1");

    // 阅卷完成率
    let grading = { graded: 0, total: 0, rate: 0 as number | string };
    if (await hasTable(db, "answer_block_crops")) {
      const total = await countWhere(db, "answer_block_crops");
      const graded = await countWhere(db, "answer_block_crops", "review_round > 0");
      grading = {
        graded,
        total,
        rate: total > 0 ? Math.round((graded / total) * 1000) / 10 : 0,
      };
    }

    // 扫描成功率 / 人工修改率：当前后端无独立 scans 表沉淀，标记为不可用（不编造）
    const scanSuccessRate = "not_available";
    const manualModificationRate = "not_available";

    res.json({
      originalPaperAttachment: {
        withOriginal,
        total: cardsTotal,
        rate: cardsTotal > 0 ? Math.round((withOriginal / cardsTotal) * 1000) / 10 : 0,
      },
      gradingCompletion: grading,
      scanSuccessRate,
      manualModificationRate,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
