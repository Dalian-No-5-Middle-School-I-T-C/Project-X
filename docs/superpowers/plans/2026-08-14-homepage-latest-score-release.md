# 首页「最新出分」快捷卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在教师端首页（`/home`）快捷卡片区新增「最新出分」卡片：管理员/年级主任看到全校最新出分，班主任看到本班最新出分，科任老师看到本人所教学科的最新出分；点击直达该考试的成绩分析页。

**Architecture:** 出分语义 = 考试状态变为 `closed`（阅卷落库完成，见 `src/apps/answer-card/server/index.ts:506-507`）。由于 `exams.updated_at` 会被改名/换卡/分配公式等操作刷新，不能作为出分时间，因此新增 `exams.closed_at` 列（SQLite v35 + MariaDB v35 双方言迁移，历史 closed 数据用 `updated_at` 回填），在 `ExamRepository.updateStatus` 置为 `closed` 时写入。把现有 `/api/dashboard` 内联逻辑抽取为 `DashboardService.getDashboardData()`，新增 `latestReleasedExam` 字段：复用 `getVisibleExamIds` 做角色可见范围过滤（admin/grade_leader = 全部可见；head_teacher = 本班；subject_teacher = 本学科+本班，另加科目兜底过滤），再叠加 `status='closed'` 按 `closed_at DESC` 取 1 条。前端 `HomePage` 快捷卡片区新增第 4 张卡片（成功色系），`HomeRoutePage` 提供 `onOpenAnalysis` 回调：设 `analysisTab="detail"` + `selectedAnalysisExamId` + `analysisGroupId=null` 后 `switchMode("analysis")`。

**Tech Stack:** TypeScript / Express 5 / better-sqlite3（SQLite 与 MariaDB 双方言迁移）/ React 19 + Tailwind（v2 UI 桶文件）/ lucide-react。

---

## 文件结构

**修改：**
- `src/server/db/migrations.ts` — SQLite 迁移 v35 `exam-closed-at`
- `src/server/db/mysql.ts` — MariaDB 迁移 v35 `exam-closed-at`
- `src/server/repositories/ExamRepository.ts` — `ExamRecord.closed_at` + `updateStatus` 写入
- `src/server/services/DemoDataService.ts` — 两处 demo 演示数据插入 closed 考试时带 `closed_at`
- `src/shared/types.ts` — `DashboardData.latestReleasedExam`
- `src/server/routes/dashboard.ts` — 改为调用 `DashboardService`（逻辑外移，行为不变）
- `src/apps/answer-card/client/components/HomePage.tsx` — 快捷卡片新增「最新出分」
- `src/apps/answer-card/client/pages/HomeRoutePage.tsx` — `onOpenAnalysis` 直达分析详情
- `scripts/verify-auth.ts` — 新增 6.2 / 6.3 测试小节（closed_at 写入 + 各角色 latestReleasedExam）

**新建：**
- `src/server/services/DashboardService.ts` — 仪表盘数据聚合（从 dashboard 路由抽取）
- `docs/superpowers/plans/2026-08-14-homepage-latest-score-release.md` — 本文档

---

## Task 1: 创建功能分支

**Files:**
- 工作区（git）

- [ ] **Step 1: 确认工作区干净且当前在 main**

Run:
```bash
git status --short
git branch --show-current
```
Expected: 无输出（干净），`main`。

- [ ] **Step 2: 创建分支**

Run:
```bash
git checkout -b codex/latest-score-release
```
Expected: `Switched to a new branch 'codex/latest-score-release'`。

---

## Task 2: `exams.closed_at` 出分时间列（迁移 + 写入点，TDD）

**Files:**
- Test: `scripts/verify-auth.ts`（在 `scripts/verify-auth.ts:308` 的 `ok((await listReviewBlocks(trendExam1)).length === 0, "review block list empty without crops");` 之后、`scripts/verify-auth.ts:310` 的 `section("7. 中间件 requirePermission / requireRole");` 之前插入）
- Modify: `src/server/db/migrations.ts`（数组末尾，v34 之后）
- Modify: `src/server/db/mysql.ts`（`mariadbMigrations` 数组末尾，version 34 之后）
- Modify: `src/server/repositories/ExamRepository.ts:11-27`（`ExamRecord` 接口）与 `:135-138`（`updateStatus`）
- Modify: `src/server/services/DemoDataService.ts:398-402` 与 `:670-674`

- [ ] **Step 1: 写失败测试（closed_at 写入）**

在 `scripts/verify-auth.ts` 的插入点新增：

```ts
  // ── 6.2 首页仪表盘：最新出分（closed_at 写入点）────────────────
  section("6.2 Dashboard latest released exam (closed_at)");
  const { ExamRepository } = await import("../src/server/repositories/ExamRepository");
  const examRepo = new ExamRepository();

  const draftExamId = Number(
    db.prepare("INSERT INTO exams (name, card_id, subject, class_id, status) VALUES ('待结考', '99999999', '数学', ?, 'draft')")
      .run(klass.id).lastInsertRowid
  );
  await examRepo.updateStatus(draftExamId, "closed");
  const closedRow = db.prepare("SELECT closed_at FROM exams WHERE id = ?").get(draftExamId) as { closed_at: string | null };
  ok(Boolean(closedRow.closed_at), "updateStatus('closed') 写入 exams.closed_at");
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run verify:auth`

Expected: 失败，退出码非 0，报错形如 `no such column: closed_at`（`closed_at` 列尚不存在）。

- [ ] **Step 3: 实现 SQLite 迁移 v35**

在 `src/server/db/migrations.ts` 中 v34 对象之后、数组结尾 `];` 之前新增：

```ts
  // v35: 首页「最新出分」— exams.closed_at 记录结考/出分时间；历史 closed 考试用 updated_at 回填
  {
    version: 35,
    name: "exam-closed-at",
    up(db) {
      addColumnIfMissing(db, "exams", "closed_at", "DATETIME");
      db.exec("UPDATE exams SET closed_at = updated_at WHERE status = 'closed' AND closed_at IS NULL");
    }
  }
```

- [ ] **Step 4: 实现 MariaDB 迁移 v35**

在 `src/server/db/mysql.ts` 的 `mariadbMigrations` 数组末尾（version 34 对象之后）新增：

```ts
    {
      version: 35,
      name: "exam-closed-at",
      sqls: [
        "ALTER TABLE exams ADD COLUMN closed_at DATETIME",
        "UPDATE exams SET closed_at = updated_at WHERE status = 'closed' AND closed_at IS NULL"
      ]
    }
```

- [ ] **Step 5: 实现写入点（ExamRepository）**

`src/server/repositories/ExamRepository.ts` 的 `ExamRecord` 接口在 `status: string;` 后新增：

```ts
  closed_at: string | null;
```

`updateStatus` 整体替换为：

```ts
  async updateStatus(id: number, status: string): Promise<void> {
    if (status === "closed") {
      // COALESCE：重复结考不覆盖首次出分时间
      await this.db.run(
        "UPDATE exams SET status = ?, closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        status, id
      );
    } else {
      await this.db.run("UPDATE exams SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", status, id);
    }
  }
```

- [ ] **Step 6: 让演示数据也带出分时间**

`src/server/services/DemoDataService.ts:398-402` 的 `insertExam` 改为：

```ts
  const insertExam = db.prepare(`
    INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, closed_at, created_by)
    VALUES (?, ?, ?, ?, ?, 'closed', CURRENT_TIMESTAMP, (SELECT id FROM users WHERE username = 'admin'))
  `);
```

`src/server/services/DemoDataService.ts:670-674` 的 `INSERT INTO exams` 改为：

```ts
    `INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, closed_at, review_enabled, created_by)
     VALUES (?, ?, ?, ?, ?, 'closed', CURRENT_TIMESTAMP, 1, (SELECT id FROM users WHERE username = 'admin'))`
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `npm run verify:auth`

Expected: 全部通过（原 54 项 + 新增断言），退出码 0。

- [ ] **Step 8: 提交**

```bash
git add src/server/db/migrations.ts src/server/db/mysql.ts src/server/repositories/ExamRepository.ts src/server/services/DemoDataService.ts scripts/verify-auth.ts
git commit -m "feat(db): 记录 exams.closed_at 出分时间并回填历史数据"
```

---

## Task 3: `DashboardService` + `latestReleasedExam`（角色范围，TDD）

**Files:**
- Test: `scripts/verify-auth.ts`（在 6.2 小节之后、`section("7.` 之前插入 6.3）
- Create: `src/server/services/DashboardService.ts`
- Modify: `src/shared/types.ts:1526-1546`（`DashboardData`）
- Modify: `src/server/routes/dashboard.ts`（整体瘦身为调用服务）

- [ ] **Step 1: 写失败测试（各角色 latestReleasedExam）**

在 `scripts/verify-auth.ts` 的 6.2 小节之后插入：

```ts
  // ── 6.3 首页仪表盘：最新出分（角色可见范围）────────────────
  section("6.3 Dashboard latest released exam (role scope)");
  const { getDashboardData } = await import("../src/server/services/DashboardService");
  const class2 = await classRepo.createClass(grade.id, "2班", 2);

  const headTeacher = await userRepo.createUser({
    username: "t_ht", password: "ht123", name: "班主任", role_id: ROLE_IDS.TEACHER
  });
  const subjectTeacher = await userRepo.createUser({
    username: "t_st", password: "st123", name: "数学老师", role_id: ROLE_IDS.TEACHER
  });
  db.prepare("UPDATE users SET teacher_role = 'head_teacher' WHERE id = ?").run(headTeacher.id);
  db.prepare("UPDATE users SET teacher_role = 'subject_teacher', subject = '数学' WHERE id = ?").run(subjectTeacher.id);
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, ?)").run(headTeacher.id, klass.id, null);
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, ?)").run(subjectTeacher.id, klass.id, "数学");

  const insertReleased = db.prepare(
    "INSERT INTO exams (name, card_id, subject, class_id, status, closed_at) VALUES (?, '99999999', ?, ?, 'closed', ?)"
  );
  const releasePhysicsA = Number(insertReleased.run("A班物理", "物理", klass.id, "2026-07-02 09:00:00").lastInsertRowid);
  const releaseMathA = Number(insertReleased.run("A班数学", "数学", klass.id, "2026-07-01 09:00:00").lastInsertRowid);
  const releaseMathB = Number(insertReleased.run("B班数学", "数学", class2.id, "2026-07-03 09:00:00").lastInsertRowid);
  db.prepare("INSERT INTO exams (name, card_id, subject, class_id, status) VALUES ('A班英语', '99999999', '英语', ?, 'grading')")
    .run(klass.id);

  const dashAdminUser = { id: adminRow.id, role_id: ROLE_IDS.ADMIN, role_name: "admin" };
  const dashGradeLeaderUser = { id: teacher.id, role_id: ROLE_IDS.TEACHER, role_name: "teacher", teacher_role: "grade_leader", subject: null };
  const dashHeadTeacherUser = { id: headTeacher.id, role_id: ROLE_IDS.TEACHER, role_name: "teacher", teacher_role: "head_teacher", subject: null };
  const dashSubjectTeacherUser = { id: subjectTeacher.id, role_id: ROLE_IDS.TEACHER, role_name: "teacher", teacher_role: "subject_teacher", subject: "数学" };

  const adminDash = await getDashboardData(dashAdminUser);
  ok(adminDash.latestReleasedExam?.examId === releaseMathB, "管理员：最新出分=全校最新 closed（B班数学）");
  const gradeLeaderDash = await getDashboardData(dashGradeLeaderUser);
  ok(gradeLeaderDash.latestReleasedExam?.examId === releaseMathB, "年级主任：最新出分=全校最新 closed（同管理员）");
  const headDash = await getDashboardData(dashHeadTeacherUser);
  ok(headDash.latestReleasedExam?.examId === releasePhysicsA, "班主任：仅本班最新出分（A班物理）");
  const subjectDash = await getDashboardData(dashSubjectTeacherUser);
  ok(subjectDash.latestReleasedExam?.examId === releaseMathA, "科任老师：仅本人科目+班级最新出分（A班数学，排除更晚的物理）");
  ok(subjectDash.latestReleasedExam?.releasedAt === "2026-07-01 09:00:00", "科任老师：releasedAt 返回 closed_at");
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run verify:auth`

Expected: 失败，退出码非 0，报错形如 `Cannot find module '../src/server/services/DashboardService'`。

- [ ] **Step 3: 实现类型（shared/types.ts）**

在 `src/shared/types.ts` 的 `DashboardData` 中 `latestScanExam` 对象之后、`stats` 之前新增：

```ts
  latestReleasedExam: {
    examId: number;
    examName: string;
    subject: string;
    releasedAt: string;
  } | null;
```

- [ ] **Step 4: 新建 DashboardService**

创建 `src/server/services/DashboardService.ts`，完整内容：

```ts
/**
 * 首页仪表盘数据聚合（从 /api/dashboard 路由抽取，便于单元测试）。
 * 最新出分口径：status='closed' 且 closed_at 非空，按 closed_at 倒序取 1 条。
 */
import type express from "express";
import { getMysqlDb, type DbAdapter } from "../db";
import { getUnfinishedSessions } from "./ReviewSessionService";
import { getVisibleExamIds } from "../../apps/answer-card/server/middleware";
import type { DashboardData } from "../../shared/types";

export async function getDashboardData(
  user: express.Request["user"],
  db: DbAdapter = getMysqlDb()
): Promise<DashboardData> {
  const userId = user?.id;
  if (!userId) throw new Error("未登录");

  // 教师按可见范围过滤统计与最新考试，避免学科老师/班主任看到全校数据
  const visibleExamIds = await getVisibleExamIds(user);
  const scopeSql = visibleExamIds == null
    ? ""
    : visibleExamIds.length === 0
      ? " AND 0"
      : ` AND e.id IN (${visibleExamIds.map(() => "?").join(",")})`;
  const scopeParams: number[] = visibleExamIds ?? [];

  // 科任老师：额外限定本人所教学科（或本人创建的考试），晨测（quiz）全量可见下也保持科目口径
  let subjectFilter = "";
  if (user?.teacher_role === "subject_teacher" && user.subject) {
    subjectFilter = " AND (e.subject = ? OR e.created_by = ?)";
    scopeParams.push(user.subject, user.id);
  }

  const data: DashboardData = {
    hasUnfinishedGrading: false,
    unfinishedTask: null,
    latestScanExam: null,
    latestReleasedExam: null,
    stats: { totalExams: 0, activeGradingExams: 0, completedExams: 0 }
  };

  // 1. 检查未完成阅卷会话
  const sessions = await getUnfinishedSessions(userId, db);
  if (sessions.length > 0) {
    const ses = sessions[0];
    const exam = await db.get("SELECT name FROM exams WHERE id = ?", ses.examId) as { name: string } | undefined;
    const cropCount = await db.get(
      "SELECT student_count AS cnt FROM review_assignments WHERE exam_id = ? AND block_id = ? AND teacher_id = ?",
      ses.examId, ses.blockId, userId
    ) as { cnt: number } | undefined;
    data.hasUnfinishedGrading = true;
    data.unfinishedTask = {
      examId: ses.examId,
      examName: exam?.name ?? "",
      blockTitle: ses.blockId,
      progress: { done: ses.currentIndex, total: cropCount?.cnt ?? 0 }
    };
  }

  // 2. 最新扫描考试（优先有切块的，fallback 到最新创建的考试）
  const latestExam = await db.get(
    `SELECT e.id, e.name, e.subject, MAX(abc.created_at) AS scanned_at
     FROM exams e
     JOIN answer_block_crops abc ON abc.exam_id = e.id
     WHERE 1=1 ${scopeSql}
     GROUP BY e.id
     ORDER BY scanned_at DESC
     LIMIT 1`,
    ...scopeParams
  ) as { id: number; name: string; subject: string | null; scanned_at: string } | undefined;

  if (latestExam) {
    data.latestScanExam = {
      examId: latestExam.id, examName: latestExam.name,
      subject: latestExam.subject ?? "", scannedAt: latestExam.scanned_at
    };
  } else {
    const fallback = await db.get(
      `SELECT id, name, subject, created_at FROM exams WHERE 1=1 ${scopeSql} ORDER BY created_at DESC LIMIT 1`,
      ...scopeParams
    ) as { id: number; name: string; subject: string | null; created_at: string } | undefined;
    if (fallback) {
      data.latestScanExam = {
        examId: fallback.id, examName: fallback.name,
        subject: fallback.subject ?? "", scannedAt: fallback.created_at
      };
    }
  }

  // 2.5 最新出分：最近 closed 的考试
  const released = await db.get(
    `SELECT e.id, e.name, e.subject, e.closed_at AS released_at
     FROM exams e
     WHERE e.status = 'closed' AND e.closed_at IS NOT NULL ${scopeSql}${subjectFilter}
     ORDER BY e.closed_at DESC, e.id DESC
     LIMIT 1`,
    ...scopeParams
  ) as { id: number; name: string; subject: string | null; released_at: string } | undefined;
  if (released) {
    data.latestReleasedExam = {
      examId: released.id, examName: released.name,
      subject: released.subject ?? "", releasedAt: released.released_at
    };
  }

  // 3. 统计数据
  const stats = await db.get(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN e.status IN ('active', 'grading') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN e.status = 'closed' THEN 1 ELSE 0 END) AS completed
     FROM exams e
     WHERE 1=1 ${scopeSql}`,
    ...scopeParams
  ) as { total: number; active: number; completed: number } | undefined;
  if (stats) {
    data.stats = { totalExams: stats.total, activeGradingExams: stats.active, completedExams: stats.completed };
  }

  return data;
}
```

- [ ] **Step 5: 瘦身 dashboard 路由**

`src/server/routes/dashboard.ts` 整体替换为：

```ts
/**
 * 首页仪表盘 API
 * 挂载点 /api/dashboard
 */
import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requirePermission } from "../middleware/auth";
import { getDashboardData } from "../services/DashboardService";

const router = Router();
router.use(authMiddleware);

router.get("/", requirePermission(PERMISSIONS.EXAM_READ), async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ ok: false, error: "未登录" });
    const data = await getDashboardData(req.user);
    res.json({ ok: true, data });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `npm run verify:auth`

Expected: 全部通过（6.2 + 6.3 新增断言），退出码 0。

- [ ] **Step 7: 类型检查**

Run: `npm run typecheck`

Expected: 无错误输出，退出码 0。

- [ ] **Step 8: 提交**

```bash
git add src/shared/types.ts src/server/services/DashboardService.ts src/server/routes/dashboard.ts scripts/verify-auth.ts
git commit -m "feat(api): 首页仪表盘新增 latestReleasedExam 按角色返回最新出分"
```

---

## Task 4: 前端「最新出分」快捷卡片

**Files:**
- Modify: `src/apps/answer-card/client/components/HomePage.tsx`
- Modify: `src/apps/answer-card/client/pages/HomeRoutePage.tsx`

- [ ] **Step 1: HomePage 增加 onOpenAnalysis prop 与最新出分卡片**

`src/apps/answer-card/client/components/HomePage.tsx`：

1) lucide-react 导入行新增 `Award`：

```ts
import { Award, BarChart3, BookOpen, ChevronRight, ClipboardList, ScanLine, SquarePen, Users } from "lucide-react";
```

2) `Props` 接口在 `onEnterExam` 后新增：

```ts
  onOpenAnalysis: (examId: number) => void;
```

3) 组件签名解构增加 `onOpenAnalysis`：

```ts
export function HomePage({ userRole, teacherRole, userName, onNavigate, onEnterExam, onOpenAnalysis }: Props) {
```

4) 快捷卡片数组在「最新扫描」条目之后、「考试管理」条目之前新增：

```tsx
    dashboard?.latestReleasedExam ? {
      icon: Award, title: "最新出分", description: `${dashboard.latestReleasedExam.examName}${dashboard.latestReleasedExam.subject ? ` · ${dashboard.latestReleasedExam.subject}` : ""}`,
      tone: "border-success-border bg-success-soft text-success-foreground", onClick: () => onOpenAnalysis(dashboard.latestReleasedExam!.examId),
    } : {
      icon: Award, title: "最新出分", description: "暂无出分记录",
      tone: "border-success-border bg-success-soft text-success-foreground", onClick: () => onNavigate("analysis"),
    },
```

5) 快捷卡片外层网格由 3 列改 4 列（`md:grid-cols-3` → `md:grid-cols-2 xl:grid-cols-4`）：

```tsx
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
```

- [ ] **Step 2: HomeRoutePage 实现直达分析详情**

`src/apps/answer-card/client/pages/HomeRoutePage.tsx` 整体替换为：

```tsx
import { useWorkspace } from "../WorkspaceContext";
import { HomePage } from "../components/HomePage";
import type { AppMode } from "../WorkspaceContext";

/**
 * /home 路由页。
 * 最新出分卡片：先设分析状态（detail + examId），再切到 analysis 模式。
 */
export function HomeRoutePage() {
  const {
    user,
    switchMode,
    setSelectedExamId,
    loadExams,
    setAnalysisTab,
    setSelectedAnalysisExamId,
    setAnalysisGroupId,
  } = useWorkspace();

  return (
    <div className="grid w-full gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="col-span-full p-0">
        <HomePage
          userName={user?.name ?? ""}
          userRole={user?.role_name ?? ""}
          teacherRole={user?.teacher_role ?? null}
          onNavigate={(m) => switchMode(m as AppMode)}
          onOpenNewTab={(m) => switchMode(m as AppMode)}
          onEnterExam={(id) => { switchMode("exam-manage"); setSelectedExamId(id); }}
          onOpenAnalysis={(examId) => {
            setAnalysisGroupId(null);
            setAnalysisTab("detail");
            setSelectedAnalysisExamId(examId);
            void loadExams();
            switchMode("analysis");
          }}
        />
      </section>
    </div>
  );
}
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`

Expected: 无错误输出，退出码 0。

- [ ] **Step 4: Web 构建**

Run: `npm run build`

Expected: typecheck + `vite build --mode web` 成功写入 `dist/web/`，esbuild 服务端 bundle 成功，退出码 0。

- [ ] **Step 5: 本地冒烟（可选，有 GUI 环境时）**

1) Run: `npm run dev`，打开 `http://127.0.0.1:5173/`，用 admin 登录（首次密码在 `bootstrap-admin.txt`）。
2) 首页快捷卡片区应显示第 4 张绿色「最新出分」卡；无 closed 考试时显示「暂无出分记录」。
3) 点击卡片应直达该考试的成绩分析详情页（标题为考试名，URL 为 `/analysis`）。

- [ ] **Step 6: 提交**

```bash
git add src/apps/answer-card/client/components/HomePage.tsx src/apps/answer-card/client/pages/HomeRoutePage.tsx
git commit -m "feat(web): 首页快捷卡片新增最新出分直达成绩分析"
```

---

## Task 5: 全量回归与收尾

**Files:**
- 无新文件

- [ ] **Step 1: 全量验证**

Run:
```bash
npm run verify:auth
npm run typecheck
npm run build
```

Expected: 三个命令均退出码 0。

- [ ] **Step 2: 确认提交历史**

Run: `git log --oneline -5`

Expected: 依次为 Task 2/3/4 的 3 个 feat 提交。

---

## 自检（Spec Coverage）

- 最新出分卡片：Task 4。
- 管理员/年级主任 = 年级（全校可见）最新出分：Task 3 `getVisibleExamIds` 返回 `null`（全部可见）+ 服务查询。
- 班主任 = 本班最新出分：Task 3 `getVisibleExamIds` head_teacher 分支 + 6.3 测试（A班物理）。
- 科任老师 = 本人科目最新出分：Task 3 `subjectFilter` + 6.3 测试（A班数学，排除更晚的物理）。
- 点击直达分析界面：Task 4 `onOpenAnalysis`（detail + examId + analysisGroupId=null）。
- 新建分支：Task 1（`codex/latest-score-release`）。
- 位置在快捷卡片：Task 4（快捷卡片网格第 3 位，成功色系）。

**已知假设（如与预期不符请提出）：**
1. 「出分」= 考试状态变为 `closed`（阅卷落库完成），系统当前无独立"发布成绩"动作。
2. 年级主任与管理员同样按现有可见范围语义返回全校最新（`getVisibleExamIds` 对二者均返回 null）；系统没有"年级主任绑定某一年级"的字段。
3. 科任老师在现有可见范围基础上额外按本人 `subject` 过滤（含本人创建的考试），避免晨测跨科干扰。
4. 历史 closed 考试以 `updated_at` 回填 `closed_at`，为近似值；新数据走 `updateStatus` 精确写入。
