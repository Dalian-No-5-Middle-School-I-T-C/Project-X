# 14 天梯API绕过考试范围和发布控制

- 原标题：Ladder API bypasses exam scope and publication controls
- 云端级别：高危（High）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/48b9de7cd8788191a657d4c51234340b?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=)
- 关联提交：[b1ac782](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/b1ac78210777fb697a37248af724053c81fe7c2b)

- 页面时间：2026 年 6 月 28 日 16:29（原页面未注明时区）。
- 操作者：火箭。

## 概要

**由本次变更引入。** 第 403 行首次挂载天梯路由，使已有但只认证、不检查对象范围和发布授权的处理函数暴露。此前这些处理函数未注册到 Express。

本提交让 /api/ladder 可达。路由仅应用 authMiddleware，因此只有 score:read 的学生或班级/学科受限教师也能访问。单考试端点把攻击者选择的顺序考试 ID 直接传 getScoreTableData，不调用 requireExamAccess，不检查班级/年级、学生是否参考或考试是否发布/关闭。仓储同样接收任意状态考试，读所有学生姓名、学号、班级、年级及分数，响应返回前十这些字段。组端点读取任意组全部成员考试分数并返回分科分；跨考接收自选考试 ID 而无 validateExamIdsAccess。全局开关默认开启，不是对象授权。因此低权限学生可枚举考试/组 ID 取得同学结果，包括草稿或仍判分考试；受限教师可跨班级/学科/年级。应在加载任何分数前，学生执行发布/参考规则，教师执行 requireExamAccess 或 validateExamIdsAccess。

## 验证

1. 确认生产组合挂载 /api/ladder，仅通用认证与全局开关保护。
2. 可控考试/组 ID 无角色、对象范围、参考或发布检查即进入分数查询。
3. 普通低权限学生经真实 HTTP 路由访问预置范围外草稿同学数据。
4. 响应泄露可识别同学分数，两种数据库 schema 默认开启天梯。
5. 认证和手工全局关闭有效，但未应用已有考试可见性中间件，输出没有实质脱敏。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 本提交在可选身份解析之后、考试/分析权限门禁之外挂载天梯，使脆弱路由可达。
2. 新 MariaDB 初始化默认开天梯，全局开关不缓解正常部署暴露。
3. 仓储加载指定考试全部身份/成绩，不查状态、参考、年级、班级或教师可见性。
4. 路由只需认证，唯一读保护为全局开关；设置不存在也默认开，没有角色、考试、参考或发布授权。
5. 任意考试 ID 直接进入无限制成绩表查询，前十返回而无考试授权/发布检查。
6. 组端点接受任意组，读取全部成员可识别成绩，不验证组或考试访问。
7. 跨考模式接收自选 ID，无 validateExamIdsAccess 即调用汇总仓储，形成另一范围绕过路径。
8. 响应包含内部 ID、学号、姓名、班级、年级、原始分、赋分及排名。

## 攻击路径分析

不适用强制排除：影响其他学生而非本人；普通学生账号即可，无管理员、操作者、开发者、物理或受保护写入；仓库有现实远程产品流程。可识别同学记录和草稿结果跨班级/参考边界，组和跨考同样暴露，影响高。生产挂载、默认开启、一次带数字 ID 的认证请求及可执行 PoC，支持高可能性。按矩阵，高影响和高可能性仅在严重标准要求立即关注时为严重；这里是泄密，而非管理员接管、RCE、整库提取或规模化改分，故最终仍高危。

### 路径

认证低权限学生/受限教师 → 正常 Web/API 有效账号 → 文档 Cloudflare/代理到 127.0.0.1:5174 → Express 挂载 /api/ladder → GET /api/ladder/exams/:examId 自选数字 ID → 只有 authMiddleware 与 ladder_enabled → 无角色、参考、班级、学科、发布或可见性授权 → AnalysisRepository 无限范围分数表 → 加载并序列化身份/分数 → 跨班级草稿身份、成绩、排名泄露。

攻击过程：学生正常登录，枚举/取得数字考试 ID，请求天梯。b1ac782 将此前不可达路由挂载。认证后无对象授权，ID 进入无限制仓储，读全部成绩行及学生身份、班级、年级，由 LadderService 返回前十。专项 HTTP PoC 使用真实路由、认证服务、schema、迁移、仓储与响应服务。匿名 401；普通学生仅有 score:read，未参与目标且无自己成绩，却得到 200，含草稿考试中另班两名学生身份、原始分及赋分。组/跨考同一遗漏由源码确认。反向证据为回环、强制认证、管理员全局开关和前十限制，但不能否定可报告性：文档公开隧道/代理，默认启用，认证学生正是威胁主体，缺失授权跨班级、参考、教师范围和草稿结果边界。

## 发生可能性

**高。** 预期低权限产品用户一次正常认证 GET。数字 ID 可控，两数据库默认开，无对象检查，文档公开 HTTPS 入口。PoC 在强制认证下返回跨班级草稿敏感数据。认证、管理员可关闭及具体入口不确定，使其并非无条件，但前提普通且现实。**攻击向量：远程网络。**

## 影响程度

**高。** 泄露他人姓名、学号、班级/年级、原始/赋分、排名，组模式还有分科分。演示目标为另一班草稿考试，攻击者未参考。任意考试/组/跨考选择可在实例内反复披露。威胁模型把学生绕过发布及广泛未发布结果泄露视为高机密性影响，但不改分或接管管理员。

## 假设条件

- 部署用受支持 Cloudflare、Nginx 或其他代理公开回环 Express，具体入口不在检出代码。
- 有正常学校流程预期的有效学生或受限教师会话。
- 目标考试/组含成绩，攻击者能获知/猜数字 ID。
- 全局天梯保持开启，SQLite/MariaDB 初始化均默认如此。

原文另列前提：

- 有效低权限认证账号。
- 天梯启用。
- 数字目标考试/组 ID。
- 目标有成绩。
- 可访问 Web/API。

## 控制措施

- authMiddleware 拒绝无有效 Bearer、Cookie 或受支持查询令牌的请求。
- 管理员可关闭 ladder_enabled。
- 考试/组路径参数须解析为有限数。
- 单考/组响应最多前十行。
- Node 回环，部署经隧道/代理公开。
- 其他处有 requireExamAccess/validateExamIdsAccess，天梯未用。
- 没有端点限流、发布门禁、参考、班级/年级限制或教师范围授权。

## 盲点

- 不能从检出代码确定具体入口/受众；公开性依据支持的部署流程。
- HTTP 挂载了精确生产路由/依赖，但 node_modules 缺 expr-eval，无法导入完整 createApp；源码独立证明生产挂载。
- 只动态测试单考，组/跨考仅追踪源码。
- 机构榜单身份展示政策无独立文件，但不能解释未参考学生访问另班草稿。
- 枚举速度及有数据考试总数依部署，证明跨边界泄露不需要这些数据。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [src/apps/answer-card/server/index.ts:386](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/apps/answer-card/server/index.ts#L386)

~~~~typescript
  // 在所有 /api 路由前解析身份（有 token 即挂载 req.user，无 token 放行）
  app.use("/api", optionalAuth);

  // 认证与账号控制系统路由
  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/classes", classRoutes);
  app.use("/api/teachers", teacherRoutes);
  app.use("/api/export", exportRoutes);
  app.use("/api/export", exportScoresRoutes);
  app.use("/api/exam-groups", examGroupRoutes);
  app.use("/api/scores", scoreRoutes);
  app.use("/api/sponsor", sponsorRoutes);
  app.use("/api/db", backupRoutes);
  app.use("/api/admin/api-keys", apiKeysRoutes);
  app.use("/api/scanner/upload", scannerUploadRoutes);
  app.use("/api/ai/providers", aiProviderRoutes);
  app.use("/api/ladder", ladderRoutes);
~~~~

### [src/server/db/schema.mariadb.sql:622](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/db/schema.mariadb.sql#L622)

~~~~sql
INSERT IGNORE INTO system_settings (`key`, value) VALUES
    ('ladder_enabled', '1');
~~~~

### [src/server/repositories/AnalysisRepository.ts:249](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/repositories/AnalysisRepository.ts#L249)

~~~~typescript
  async getScoreTableData(examId: number, classId?: number, displayMode: "deviation" | "zscore" | "percentile" = "deviation"): Promise<any> {
    const exam = await this.db.get(`SELECT e.name, e.subject, ac.exam_date, e.assigned_formula FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id WHERE e.id = ?`, examId) as any;
    if (!exam) throw new Error("考试不存在");
    const hasAssigned = !!(exam.assigned_formula && exam.assigned_formula !== "");
    const allStudents = await this.db.all(`SELECT ss.student_id, u.student_number, u.name, ss.total_score, ss.objective_score, ss.subjective_score, ss.assigned_score, c.name as class_name, c.id as class_id, g.name as grade_name FROM student_scores ss JOIN users u ON u.id = ss.student_id LEFT JOIN class_students cs ON cs.student_id = ss.student_id LEFT JOIN classes c ON c.id = cs.class_id LEFT JOIN grades g ON g.id = c.grade_id WHERE ss.exam_id = ? ORDER BY ss.total_score DESC`, examId) as any[];
    if (allStudents.length === 0) return { examName: exam.name, subject: exam.subject, examDate: exam.exam_date, hasAssignedScore: hasAssigned, rows: [], totalCount: 0 };
    const gradeRanked = allStudents.map((s: any) => ({ ...s, gradeRank: 0, classRank: 0 }));
    competitionRank(gradeRanked, (r: any) => r.total_score, (r: any, rank: number) => { r.gradeRank = rank; });
    const cg = new Map<string, any[]>();
    for (const s of gradeRanked) { const k = s.class_name ?? "__unassigned__"; if (!cg.has(k)) cg.set(k, []); cg.get(k)!.push(s); }
    for (const g of cg.values()) competitionRank(g, (r: any) => r.total_score, (r: any, rank: number) => { r.classRank = rank; });
    let filtered = gradeRanked;
    if (classId === 0) filtered = gradeRanked.filter((s: any) => s.class_id == null);
    else if (classId !== undefined) filtered = gradeRanked.filter((s: any) => s.class_id === classId);
    const scores = filtered.map((s: any) => s.total_score);
    const mean = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
    const variance = scores.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);
    const prevExam = await this.db.get(`SELECT e.id, e.name FROM exams e LEFT JOIN answer_cards ac ON ac.id = e.card_id WHERE e.subject = ? AND e.grade_id = (SELECT grade_id FROM exams WHERE id = ?) AND e.id != ? AND (ac.exam_date IS NULL OR ac.exam_date < (SELECT ac2.exam_date FROM exams e2 LEFT JOIN answer_cards ac2 ON ac2.id = e2.card_id WHERE e2.id = ?)) ORDER BY COALESCE(ac.exam_date, e.created_at) DESC LIMIT 1`, exam.subject, examId, examId, examId) as any;
    let prevRankMap = new Map<number, number>();
    if (prevExam) {
      const prevStudents = await this.db.all(`SELECT student_id, total_score FROM student_scores WHERE exam_id = ? ORDER BY total_score DESC`, prevExam.id) as any[];
      competitionRank(prevStudents, (r: any) => r.total_score, (r: any, rank: number) => prevRankMap.set(r.student_id, rank));
    }
    const rows = filtered.map((s: any) => {
      const prevRank = prevRankMap.get(s.student_id) ?? null;
      const rankChange = prevRank != null ? prevRank - s.gradeRank : null;
      let dv: number | null = null;
      if (displayMode === "deviation") dv = std > 0 ? Math.round((50 + 10 * (s.total_score - mean) / std) * 10) / 10 : 50;
      else if (displayMode === "zscore") dv = std > 0 ? Math.round(((s.total_score - mean) / std) * 100) / 100 : 0;
      else if (displayMode === "percentile") dv = Math.round((1 - (s.gradeRank - 1) / allStudents.length) * 1000) / 10;
      return { studentId: s.student_id, studentNumber: s.student_number, studentName: s.name, className: s.class_name ?? "未知班级", classId: s.class_id, gradeName: s.grade_name ?? null, totalScore: s.total_score, assignedScore: s.assigned_score, gradeRank: s.gradeRank, classRank: s.classRank ?? 0, rankChange, prevRank, prevExamName: prevExam?.name ?? null, displayValue: dv, objectiveScore: s.objective_score, subjectiveScore: s.subjective_score };
    });
    if (classId !== undefined && classId !== 0) rows.sort((a, b) => a.classRank - b.classRank);
    else rows.sort((a, b) => a.gradeRank - b.gradeRank);
    return { examName: exam.name, subject: exam.subject, examDate: exam.exam_date, hasAssignedScore: hasAssigned, rows, totalCount: rows.length };
~~~~

### [src/server/routes/ladder.ts:20](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/routes/ladder.ts#L20)

~~~~typescript
const router = express.Router();
router.use(authMiddleware);

// ── 天梯开关 ──

async function isLadderEnabled(): Promise<boolean> {
  const db = getMysqlDb();
  const row = await db.get<{ value: string }>("SELECT value FROM system_settings WHERE `key` = ?", "ladder_enabled");
  return row ? row.value === "1" : true;
}

/** 检查天梯是否开放，管理员始终可以预览 */
async function checkLadderOpen(req: Request, res: Response): Promise<boolean> {
  if (await isLadderEnabled()) return true;
  if (req.user?.role_name === "admin") return true;
  res.status(403).json({ message: "成绩天梯暂未开放" });
  return false;
}
~~~~

### [src/server/routes/ladder.ts:67](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/routes/ladder.ts#L67)

~~~~typescript
router.get("/exams/:examId", async (req: Request, res: Response) => {
  if (!(await checkLadderOpen(req, res))) return;
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId)) {
      res.status(400).json({ message: "无效的考试 ID" });
      return;
    }

    const analysisRepo = new AnalysisRepository();
    const scoreTable = await analysisRepo.getScoreTableData(examId, undefined, "percentile");

    if (!scoreTable || scoreTable.rows.length === 0) {
      const resp: LadderResponse = {
        scope: "single",
        scopeName: scoreTable?.examName ?? "",
        studentCount: 0,
        myRank: null,
        myScore: null,
        rows: [],
      };
      res.json(resp);
      return;
    }

    const { top10, myRank, myScore } = LadderService.fromScoreTableRows(
      scoreTable.rows,
      scoreTable.totalCount,
      req.user!.id,
    );

    const resp: LadderResponse = {
      scope: "single",
      scopeName: scoreTable.examName,
      studentCount: scoreTable.totalCount,
      myRank,
      myScore,
      rows: top10,
    };
    res.json(resp);
~~~~

### [src/server/routes/ladder.ts:115](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/routes/ladder.ts#L115)

~~~~typescript
router.get("/exam-groups/:groupId", async (req: Request, res: Response) => {
  if (!(await checkLadderOpen(req, res))) return;
  try {
    const db = getMysqlDb();
    const groupId = Number(req.params.groupId);
    if (!Number.isFinite(groupId)) {
      res.status(400).json({ message: "无效的考试组 ID" });
      return;
    }

    const group = await db.get<{ name: string; total_score_mode: string }>(
      `SELECT name, total_score_mode FROM exam_groups WHERE id = ?`,
      groupId,
    );
    if (!group) {
      res.status(404).json({ message: "大考不存在" });
      return;
    }

    const members = await db.all<{ exam_id: number; subject: string | null }>(
      `SELECT egm.exam_id, e.subject
         FROM exam_group_members egm
         JOIN exams e ON e.id = egm.exam_id
         WHERE egm.group_id = ?
         ORDER BY egm.sort_order, egm.id`,
      groupId,
    );

    if (members.length === 0) {
      const resp: LadderResponse = {
        scope: "group",
        scopeName: group.name,
        studentCount: 0,
        myRank: null,
        myScore: null,
        rows: [],
      };
      res.json(resp);
      return;
    }

    const memberIds = members.map((m) => m.exam_id);

    const allScores = await db.all<{
      student_id: number;
      exam_id: number;
      total_score: number;
      assigned_score: number | null;
      student_number: string;
      name: string;
      class_name: string | null;
      class_id: number | null;
      grade_name: string | null;
    }>(
      `SELECT ss.student_id, ss.exam_id, ss.total_score, ss.assigned_score,
                u.student_number, u.name,
                c.name as class_name, c.id as class_id,
                g.name as grade_name
         FROM student_scores ss
         JOIN users u ON u.id = ss.student_id
         LEFT JOIN class_students cs ON cs.student_id = ss.student_id
         LEFT JOIN classes c ON c.id = cs.class_id
         LEFT JOIN grades g ON g.id = c.grade_id
         WHERE ss.exam_id IN (${memberIds.map(() => "?").join(",")})`,
      ...memberIds,
    );
~~~~

### [src/server/routes/ladder.ts:294](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/routes/ladder.ts#L294)

~~~~typescript
router.get("/cross-exam", async (req: Request, res: Response) => {
  if (!(await checkLadderOpen(req, res))) return;
  try {
    const { mode, examIds, groupId, startDate, endDate } = req.query;

    const request: any = { mode: mode || "week" };
    if (mode === "selected" && examIds) {
      request.examIds = String(examIds)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
    }
    if (mode === "group" && groupId) {
      request.groupId = Number(groupId);
    }
    if (startDate) request.startDate = String(startDate);
    if (endDate) request.endDate = String(endDate);

    const analysisRepo = new AnalysisRepository();
    const crossExamData = await analysisRepo.getCrossExamTotal(request);
~~~~

### [src/server/services/LadderService.ts:29](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/b1ac78210777fb697a37248af724053c81fe7c2b/src/server/services/LadderService.ts#L29)

~~~~typescript
  static fromScoreTableRows(
    rows: ScoreTableRow[],
    totalCount: number,
    currentStudentId?: number,
  ): { top10: LadderRow[]; myRank: number | null; myScore: number | null } {
    const top10: LadderRow[] = rows.slice(0, 10).map((r) => ({
      rank: r.rank,
      studentId: r.studentId,
      studentNumber: r.studentNumber,
      studentName: r.studentName,
      className: r.className,
      classId: r.classId,
      gradeName: r.gradeName ?? null,
      totalScore: r.totalScore,
      assignedScore: r.assignedScore,
      classRank: r.classRank,
      rankTrend: LadderService.getRankTrend(r.rankChange),
      rankChange: r.rankChange,
      prevRank: r.prevRank,
      percentile: LadderService.percentile(r.rank, totalCount),
    }));
~~~~
