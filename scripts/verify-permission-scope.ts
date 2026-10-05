/**
 * 第三批「权限边界」整改回归（安全 R03/R06/R08/R09/R13/R15/R18/R21/R29/R47）
 *
 * 隔离 SQLite 库 + 真实 HTTP，逐条验证「谁能读/写谁的数据」：
 *  R21 花名册按教师可访问班级收敛
 *  R29 应考名单读取（学生 403）与整体替换（范围外学生 403）
 *  R18 创建/变更考试不得越出本人任教范围
 *  R09 整卷成绩与答案写不再继承「可见即可写」（晨测放大旁路）
 *  R08 成绩详情读取按题块范围收敛
 *  R03 网阅读取（题块/切块/溯源）与批注按题块与所有者收敛
 *  R15 试卷池领取按逐生分配 + 持有量闸门
 *  R13 学生不得读取未参与的已公布天梯
 *  R47 争议复评按评阅人去重，不叠加票数
 *  R06 删除/解绑答题卡只作用于与考试有组织归属关系的行
 *  PR #312 CR1/CR6/CR9 复核轮次跨切片可承接、清单与切块原图按题块+逐生收敛、领取锁预算
 *
 * 用法: npm run verify:permission-scope
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-perm-scope-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST",
  // R01 逃生阀：宿主机设置后会改变引导口令语义，本脚本不依赖它
  "PROJECTX_ADMIN_PASSWORD",
  // 上传与试卷池配额：宿主机任一档位都会让「按默认值断言」失真，统一清掉
  "PROJECTX_UPLOAD_MAX_SCAN_IMAGE_MIB", "PROJECTX_UPLOAD_MAX_SESSION_PAGES",
  "PROJECTX_UPLOAD_MAX_CROPS_PER_REQUEST", "PROJECTX_UPLOAD_MAX_CROP_IMAGE_MIB",
  "PROJECTX_UPLOAD_MAX_CROPS_TOTAL_MIB", "PROJECTX_UPLOAD_MAX_PAGE_REQUEST_TOTAL_MIB",
  "PROJECTX_UPLOAD_MAX_BATCH_FILES", "PROJECTX_UPLOAD_MAX_BATCH_TOTAL_MIB",
  "PROJECTX_REVIEW_MAX_HELD_PER_BLOCK", "PROJECTX_REVIEW_MAX_HELD_TOTAL", "PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS"
]) delete process.env[key];

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}

async function main(): Promise<void> {
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import("../src/server/db/index");
  initializeDatabase();
  await ensureDefaultAdmin();
  const db = getDatabase();
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { UserRepository } = await import("../src/server/repositories/UserRepository");
  const { authService } = await import("../src/server/services/AuthService");
  const limits = await import("../src/shared/reviewPoolLimits");

  const users = new UserRepository();
  const teacherA = await users.createUser({ username: "t-math", password: "pass-1234", name: "数学任教师", role_id: 2, teacher_role: "subject_teacher", subject: "数学" });
  const teacherB = await users.createUser({ username: "t-cn", password: "pass-1234", name: "语文任教师", role_id: 2, teacher_role: "subject_teacher", subject: "语文" });
  const adminRow = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number } | undefined;
  const adminId = adminRow?.id ?? 1;

  const gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('权限年级', 1)").run().lastInsertRowid);
  const classA = Number(db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, 'A班')").run(gradeId).lastInsertRowid);
  const classB = Number(db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, 'B班')").run(gradeId).lastInsertRowid);
  const sids: Record<string, number> = {};
  for (const [num, cls] of [["9001", classA], ["9002", classA], ["9003", classB], ["9004", classB]] as Array<[string, number]>) {
    const u = await users.createUser({ username: `s-${num}`, password: "pass-1234", name: `学生${num}`, role_id: 3, student_number: num });
    sids[num] = u.id;
    db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(cls, u.id);
  }
  const cardId = "PERMCARD001";
  db.prepare(
    `INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by)
     VALUES (?, '权限卡', 'math', '数学', '2026-09-01', 'A4', 'portrait', '{}', 4, 'single', 1, ?)`
  ).run(cardId, adminId);
  function makeExam(name: string, opts: { classId: number | null; subject: string; mode?: string; createdBy: number; published?: boolean; card?: string }): number {
    return Number(db.prepare(
      `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, score_published, exam_mode, created_by)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'closed', ?, ?, ?)`
    ).run(name, opts.card ?? cardId, gradeId, opts.classId, opts.subject, opts.published ? 1 : 0, opts.mode ?? "formal", opts.createdBy).lastInsertRowid);
  }
  const examA = makeExam("A班数学考", { classId: classA, subject: "数学", createdBy: adminId, published: true });
  const examQuiz = makeExam("A班晨测", { classId: classA, subject: "数学", mode: "quiz", createdBy: adminId, published: true });
  for (const num of ["9001", "9002"]) {
    db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,0,60,60)").run(examA, sids[num]);
    db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type, block_id) VALUES (?,?,?,?,?,'subjective','B1')")
      .run(examA, sids[num], 21, 20, 20);
    db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type, block_id) VALUES (?,?,?,?,?,'subjective','B2')")
      .run(examA, sids[num], 22, 15, 15);
  }
  db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,0,55,55)").run(examA, sids["9003"]);
  for (const [cropId, block, qn, sid] of [
    ["pc-b1-9001", "B1", 21, sids["9001"]], ["pc-b2-9001", "B2", 22, sids["9001"]], ["pc-b1-9003", "B1", 21, sids["9003"]]
  ] as Array<[string, string, number, number]>) {
    db.prepare(
      `INSERT INTO answer_block_crops (id, card_id, exam_id, student_id, student_number, source_type, source_record_id, block_id, block_type, page_number, segment_index, question_numbers, rect_json, image_path, width_px, height_px, dpi, status, review_round)
       VALUES (?, ?, ?, ?, ?, 'test', ?, ?, 'subjective', 1, 0, ?, '{}', '', 0, 0, 300, 'ready', 0)`
    ).run(cropId, cardId, examA, sid, `S${sid}`, `rec-${cropId}`, block, `[${qn}]`);
  }
  db.prepare("INSERT INTO review_annotations (id, crop_id, reviewer_id, type, data_json) VALUES ('ann-b1-9001', 'pc-b1-9001', ?, 'text', '{}')").run(teacherA.id);

  const app = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const tokenA = (await authService.login(teacherA.username, "pass-1234")).token!;
  const tokenB = (await authService.login(teacherB.username, "pass-1234")).token!;
  const tokenS1 = (await authService.login("s-9001", "pass-1234")).token!;
  const json = async (urlPath: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${base}${urlPath}`, init);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const get = (urlPath: string, token: string) => json(urlPath, { headers: { Authorization: `Bearer ${token}` } });
  const send = (urlPath: string, method: string, token: string, body?: unknown) =>
    json(urlPath, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const matrix = (teacherId: number, extra: { block_id?: string | null; class_id?: number | null; can_grade?: number; can_view_scores?: number; can_view_students?: number }) =>
    db.prepare(
      `INSERT INTO teacher_permissions (teacher_id, grade_id, subject, class_id, block_id, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign)
       VALUES (?, NULL, NULL, ?, ?, ?, 0, ?, ?, 0)`
    ).run(teacherId, extra.class_id ?? null, extra.block_id ?? null, extra.can_view_scores ?? 1, extra.can_view_students ?? 1, extra.can_grade ?? 1);
  const clearMatrix = (teacherId: number) => db.prepare("DELETE FROM teacher_permissions WHERE teacher_id = ?").run(teacherId);

  console.log("\n== R21 花名册按可访问班级收敛 ==");
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, '数学')").run(teacherA.id, classA);
  ok((await get(`/api/classes/${classA}/students`, tokenA)).status === 200, "任教教师可读自己班级花名册");
  const r21Other = await get(`/api/classes/${classB}/students`, tokenA);
  ok(r21Other.status === 403, `任教教师读其它班级花名册被 403（实际 ${r21Other.status}）`);
  ok((await get(`/api/classes/${classB}/students`, tokenA)).body?.message?.includes("花名册") === true, "越权花名册返回可读原因");
  matrix(teacherA.id, { class_id: classA, can_view_students: 0 });
  ok((await get(`/api/classes/${classA}/students`, tokenA)).status === 403, "矩阵关闭 can_view_students 后本人班级也 403");
  clearMatrix(teacherA.id);

  console.log("\n== R29 应考名单读取与整体替换 ==");
  ok((await get(`/api/exams/${examA}/participants`, tokenS1)).status === 403, "学生读取应考名单被 403");
  ok((await get(`/api/exams/${examA}/participants`, tokenA)).status === 200, "任教教师读取应考名单成功");
  const putOwn = await send(`/api/exams/${examA}/participants`, "PUT", tokenA, { studentIds: [sids["9001"]] });
  ok(putOwn.status === 200, `教师设置本班学生为显式名单成功（实际 ${putOwn.status}）`);
  const putOutsider = await send(`/api/exams/${examA}/participants`, "PUT", tokenA, { studentIds: [sids["9001"], sids["9003"]] });
  ok(putOutsider.status === 403 && putOutsider.body?.code === "PARTICIPANT_OUT_OF_SCOPE", `把范围外学生写入名单被 403（实际 ${putOutsider.status}）`);
  ok((await get(`/api/exams/${examA}/participants`, tokenA)).body?.students?.length === 1, "越权写入被整批拒绝，原名单未被改写");
  await send(`/api/exams/${examA}/participants`, "DELETE", tokenA);

  console.log("\n== R18 创建/变更考试不得越出任教范围 ==");
  const createOut = await send("/api/exams", "POST", tokenA, { name: "越权建考", cardId, classId: classB, subject: "语文" });
  ok(createOut.status === 403 && createOut.body?.code === "ORG_OUT_OF_SCOPE", `教师把考试落到非任教班级被 403（实际 ${createOut.status}）`);
  const createOwn = await send("/api/exams", "POST", tokenA, { name: "本班建考", cardId, classId: classA, subject: "数学" });
  ok(createOwn.status === 201 || createOwn.status === 200, `教师在任教班级建考成功（实际 ${createOwn.status}）`);
  const patchOut = await send(`/api/exams/${examA}`, "PATCH", tokenA, { classId: classB });
  ok(patchOut.status === 403 && patchOut.body?.code === "ORG_OUT_OF_SCOPE", `把考试改到非任教班级被 403（实际 ${patchOut.status}）`);
  const patchRename = await send(`/api/exams/${examA}`, "PATCH", tokenA, { name: "A班数学考·改名" });
  ok(patchRename.status === 200, `不动范围的普通编辑仍成功（实际 ${patchRename.status}）`);

  console.log("\n== R09 整卷成绩/答案写不再继承「可见即可写」 ==");
  const quizPut = await send(`/api/exams/${examQuiz}/student/${sids["9001"]}/scores`, "PUT", tokenB, { scores: [{ questionNumber: 21, scoreType: "subjective", score: 1 }] });
  ok(quizPut.status === 403, `非本场教师借晨测全量可见改整卷成绩被 403（实际 ${quizPut.status}）`);
  const quizAnswers = await send(`/api/exams/${examQuiz}/answers`, "PUT", tokenB, { answers: { "1": ["A"] } });
  ok(quizAnswers.status === 403, `非本场教师改晨测答案键被 403（实际 ${quizAnswers.status}）`);
  const ownPut = await send(`/api/exams/${examA}/student/${sids["9001"]}/scores`, "PUT", tokenA, { scores: [{ questionNumber: 21, scoreType: "subjective", score: 18 }] });
  ok(ownPut.status === 200, `本班教师改学生成绩仍成功（实际 ${ownPut.status}）`);
  matrix(teacherA.id, { class_id: classA, block_id: "B1" });
  const blockScopedPut = await send(`/api/exams/${examA}/student/${sids["9001"]}/scores`, "PUT", tokenA, { scores: [{ questionNumber: 21, scoreType: "subjective", score: 19 }] });
  ok(blockScopedPut.status === 403, "仅有题块级授权者走整卷改分被 403（改分请走题块网阅）");
  const formulaBlocked = await send(`/api/exams/${examA}/assigned-formula`, "PUT", tokenA, { formula: { type: "proportional", enabled: true, params: { minIn: 0, maxIn: 20, minOut: 10, maxOut: 20 } }, recalculate: true });
  ok(formulaBlocked.status === 403, "仅有题块级授权者重算赋分被 403");
  clearMatrix(teacherA.id);

  console.log("\n== R08 成绩详情按题块范围收敛 ==");
  const detailAll = await get(`/api/exams/${examA}/student/${sids["9001"]}/scores`, tokenA);
  ok(detailAll.status === 200 && Array.isArray(detailAll.body?.questionScores), `整卷授权可读成绩详情（实际 ${detailAll.status}）`);
  matrix(teacherA.id, { class_id: classA, block_id: "B1" });
  const detailScoped = await get(`/api/exams/${examA}/student/${sids["9001"]}/scores`, tokenA);
  ok(detailScoped.status === 403, `仅有题块授权读整卷成绩详情被 403（实际 ${detailScoped.status}）`);
  const detailOther = await get(`/api/exams/${examA}/student/${sids["9003"]}/scores`, tokenB);
  ok(detailOther.status === 403, "非任教班级学生成绩详情被 403");
  clearMatrix(teacherA.id);

  console.log("\n== R03 网阅读取与批注的题块/所有者范围 ==");
  matrix(teacherA.id, { class_id: classA, block_id: "B1" });
  const blocks = await get(`/api/review/exams/${examA}/blocks`, tokenA);
  const listed = (blocks.body?.blocks ?? []).map((b: { blockId: string }) => b.blockId);
  ok(blocks.status === 200 && listed.length === 1 && listed[0] === "B1", `题块列表只含本人题块（实际 ${JSON.stringify(listed)}）`);
  // 满分汇总SQL 改写为「独立聚合 + 内存合并」后，两方言都要给出与旧语义一致的值
  const listedB1 = (blocks.body?.blocks ?? [])[0] as { maxScore?: number } | undefined;
  ok(Number(listedB1?.maxScore) === 20, `题块满分按各小题满分汇总（实际 ${listedB1?.maxScore}）`);
  ok((await get(`/api/review/exams/${examA}/block-crops?blockId=B2`, tokenA)).status === 403, "读取未分配题块的切块清单被 403");
  const cropsB1 = await get(`/api/review/exams/${examA}/block-crops?blockId=B1`, tokenA);
  ok(cropsB1.status === 200 && cropsB1.body?.rows?.length === 2, `本人题块切块清单只含该块（实际 ${cropsB1.body?.rows?.length}）`);
  const trace = await get(`/api/review/exams/${examA}/trace`, tokenA);
  const traceCrops = (trace.body?.data ?? []).map((t: { cropId: string }) => String(t.cropId));
  ok(trace.status === 200 && traceCrops.length > 0 && traceCrops.every((c: string) => c.startsWith("pc-b1-")), `溯源只覆盖本人题块（实际 ${JSON.stringify(traceCrops)}）`);
  ok((await get(`/api/review-annotations?cropId=pc-b1-9001`, tokenA)).status === 200, "本人题块的批注可读");
  // teacherB 配一行「只授权 B2」的矩阵：既证明越权写入被拦，也避免落到「无任何配置」的兼容放行
  matrix(teacherB.id, { class_id: classB, block_id: "B2" });
  const annForeignBlock = await json(`/api/review-annotations?cropId=pc-b1-9001`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenB}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cropId: "pc-b1-9001", type: "text", dataJson: { x: 1 } })
  });
  ok(annForeignBlock.status === 403, `向他人题块写批注被 403（实际 ${annForeignBlock.status}）`);
  const annDeleteOther = await json(`/api/review-annotations/ann-b1-9001`, { method: "DELETE", headers: { Authorization: `Bearer ${tokenB}` } });
  ok(annDeleteOther.status === 403, "删除他人批注被 403");
  const annMine = await json(`/api/review-annotations/ann-b1-9001`, { method: "DELETE", headers: { Authorization: `Bearer ${tokenA}` } });
  ok(annMine.status === 200, "删除本人批注成功");
  clearMatrix(teacherA.id);

  console.log("\n== R15 试卷池逐生分配与持有量闸门 ==");
  const { claimSpecificPaper, claimNextPaper, getAssignedStudentIdSet, countHeldPapers, ReviewPoolScopeError, ReviewPoolError } =
    await import("../src/server/services/ReviewPoolService");
  ok(limits.MAX_HELD_PAPERS_PER_BLOCK === 20 && limits.MAX_HELD_PAPERS_TOTAL === 60, "默认持有量配额：题块 20 份 / 全局 60 份");
  assert.equal(limits.resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_TOTAL: "5" }).limits.maxHeldPapersTotal, 5);
  assert.equal(limits.resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_TOTAL: "0" }).limits.maxHeldPapersTotal, 60);
  assert.equal(limits.resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_PER_BLOCK: "99999" }).limits.maxHeldPapersPerBlock, 500);
  assert.equal(limits.resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_TOTAL: "99999" }).limits.maxHeldPapersTotal, 2000);
  ok(limits.resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_TOTAL: "99999" }).notices[0].includes("天花板"), "超天花板时给出夹紧提示");
  ok((await getAssignedStudentIdSet(examA, "B1", teacherA.id)) === null, "无分配行 → 不受逐生约束（兼容旧部署）");
  db.prepare("INSERT INTO review_assignments (exam_id, block_id, teacher_id, student_count, assigned_student_ids) VALUES (?, 'B1', ?, 1, ?)")
    .run(examA, teacherA.id, JSON.stringify([sids["9001"]]));
  const assigned = await getAssignedStudentIdSet(examA, "B1", teacherA.id);
  ok(assigned?.has(sids["9001"]) === true && assigned?.has(sids["9003"]) === false, "逐生分配集合按 JSON 生效");
  await assert.rejects(
    () => claimSpecificPaper(examA, "B1", "pc-b1-9003", teacherA.id),
    (err: unknown) => err instanceof ReviewPoolScopeError,
    "领取分配范围外学生的卷子被拒"
  );
  ok((await claimSpecificPaper(examA, "B1", "pc-b1-9001", teacherA.id)).id === "pc-b1-9001", "领取分配范围内卷子成功");
  const held = await countHeldPapers(teacherA.id, { examId: examA, blockId: "B1" });
  ok(held.inBlock === 1 && held.total === 1, "持有量统计含题块内与全局两个口径");
  await assert.rejects(
    () => claimNextPaper(examA, "B1", teacherA.id),
    (err: unknown) => err instanceof ReviewPoolError,
    "范围内已领完时自动领取报「无卷可领」，而不是伸手去拿范围外的卷子"
  );
  ok(
    db.prepare("SELECT 1 FROM answer_block_crops WHERE exam_id = ? AND block_id = 'B1' AND student_id = ? AND claimed_by IS NOT NULL")
      .get(examA, sids["9003"]) === undefined,
    "分配范围外学生的卷子始终保持未领取"
  );
  db.prepare("UPDATE answer_block_crops SET claimed_by = NULL WHERE exam_id = ?").run(examA);
  const cropsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='answer_block_crops'").get();
  ok(Boolean(cropsTable), "题块表存在（夹具自校验）");

  console.log("\n== R13 学生不得读取未参与的天梯 ==");
  db.prepare("REPLACE INTO system_settings (`key`, value) VALUES ('ladder_enabled', '1')").run();
  // 上面的改分/建考步骤会触发「改分自动撤回公布」，这里显式恢复公布态再验证参与范围
  db.prepare("UPDATE exams SET score_published = 1, status = 'closed' WHERE id = ?").run(examA);
  const groupId = Number(db.prepare("INSERT INTO exam_groups (name, grade_id, total_score_mode, only_full_participants) VALUES ('权限组', ?, 'raw', 0)").run(gradeId).lastInsertRowid);
  db.prepare("INSERT INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, 0)").run(groupId, examA);
  const ladderOwn = await get(`/api/ladder/cross-exam?mode=selected&examIds=${examA}`, tokenS1);
  ok(ladderOwn.status === 200, `学生读取自己参与的跨考天梯成功（实际 ${ladderOwn.status} ${ladderOwn.body?.message ?? ""}）`);
  // 9003 在 examA 有成绩记录（被 R15 的越权领卷夹具引用），真正未参考的是没有任何成绩行的 9004
  const tokenS4 = (await authService.login("s-9004", "pass-1234")).token!;
  const ladderForeign = await get(`/api/ladder/cross-exam?mode=selected&examIds=${examA}`, tokenS4);
  ok(ladderForeign.status === 403, `学生读取未参与考试的跨考天梯被 403（实际 ${ladderForeign.status} ${ladderForeign.body?.message ?? ""}）`);
  const groupForeign = await get(`/api/ladder/exam-groups/${groupId}`, tokenS4);
  ok(groupForeign.status === 403, `学生经组天梯读取未参与的大考被 403（实际 ${groupForeign.status} ${groupForeign.body?.message ?? ""}）`);
  const groupOwn = await get(`/api/ladder/exam-groups/${groupId}`, tokenS1);
  ok(groupOwn.status === 200, `学生读取本人参与的大考组天梯成功（实际 ${groupOwn.status} ${groupOwn.body?.message ?? ""}）`);

  console.log("\n== PR #312 CR7/CR10/CR11/CR12 天梯参与子集、冻结名单出路、只读教师与 403 脱敏 ==");
  // created_by 挂在 teacherA 名下：末尾 R06 的解绑步骤要求卡上每场考试都在调用者范围内，
  // 这场是新增的，若归 admin 会把那条断言变成 403（考试归属 ≠ 天梯可见范围，后者按班+学科判定）。
  const examL2 = makeExam("B班数学考（本人未参加）", { classId: classB, subject: "数学", createdBy: teacherA.id, published: true });
  db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,0,77,77)")
    .run(examL2, sids["9004"]);
  db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,0,66,66)")
    .run(examL2, sids["9003"]);
  const hasLadderNumber = (body: any, num: string) =>
    (body?.rows ?? []).some((r: { studentNumber?: string }) => String(r.studentNumber) === num);

  // CR7 ①：混合选择只要求「参加过其中一场」，未参加那场的整榜照读——现在按参与子集聚合
  const { AnalysisRepository: LadderRepo } = await import("../src/server/repositories/AnalysisRepository");
  const ladParticipated = await new LadderRepo().filterParticipatedExamIds([examA, examL2], sids["9001"]);
  ok(ladParticipated.length === 1 && Number(ladParticipated[0]) === examA,
    `参与子集只保留本人参加的那场、保持原顺序（实际 ${JSON.stringify(ladParticipated)}）`);
  const ladMixed = await get(`/api/ladder/cross-exam?mode=selected&examIds=${examA},${examL2}`, tokenS1);
  ok(ladMixed.status === 200, `混合选择含本人未参加场次时仍返回本人可读的子集（实际 ${ladMixed.status}）`);
  ok(hasLadderNumber(ladMixed.body, "9001"), "参与子集里本人仍在榜（空榜会让下面的断言白过）");
  ok(!hasLadderNumber(ladMixed.body, "9004"), "未参加场次的独有学生不出现在榜单（修复前其姓名/学号/分数整行泄露）");
  // 教师侧对照用的是「同时任教 A、B 两班」的账号：teacherA 只任教 A 班，
  // 请求含 examL2 会先在 validateExamIdsAccess 处 403，测不到参与收敛这条口径。
  const teacherBoth = await users.createUser({ username: "t-both", password: "pass-1234", name: "跨班教师", role_id: 2, teacher_role: "subject_teacher", subject: "数学" });
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, '数学')").run(teacherBoth.id, classA);
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, '数学')").run(teacherBoth.id, classB);
  const tokenBoth = (await authService.login("t-both", "pass-1234")).token!;
  const ladMixedTeacher = await get(`/api/ladder/cross-exam?mode=selected&examIds=${examA},${examL2}`, tokenBoth);
  ok(ladMixedTeacher.status === 200 && hasLadderNumber(ladMixedTeacher.body, "9004"),
    `教师侧不受参与收敛影响，仍能读到完整榜单（实际 ${ladMixedTeacher.status} ${ladMixedTeacher.body?.message ?? ""}）`);

  // CR7 ②：日期模式（week）没有调用者给定的考试集合，原先直接放行
  const ladWeek = await get(`/api/ladder/cross-exam?mode=week&startDate=2026-08-25&endDate=2026-09-07`, tokenS1);
  ok(ladWeek.status === 200, `学生读取日期包天梯成功（实际 ${ladWeek.status} ${ladWeek.body?.message ?? ""}）`);
  ok(hasLadderNumber(ladWeek.body, "9001"), "日期包内本人参加的场次照常聚合");
  ok(!hasLadderNumber(ladWeek.body, "9004"), "日期包内本人未参加的场次不再进榜");

  // CR10：调班后，冻结名单里的历史应考者必须还能被保留（否则「剔除缺考者」这条唯一出路被拦死）
  db.prepare("INSERT OR IGNORE INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'roster')").run(examA, sids["9001"]);
  db.prepare("INSERT OR IGNORE INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'roster')").run(examA, sids["9002"]);
  db.prepare("DELETE FROM class_students WHERE student_id = ?").run(sids["9001"]);
  const cr10KeepFrozen = await send(`/api/exams/${examA}/participants`, "PUT", tokenA, { studentIds: [sids["9001"], sids["9002"]] });
  ok(cr10KeepFrozen.status === 200, `调班后仍可保留冻结名单里的历史应考者（实际 ${cr10KeepFrozen.status} ${cr10KeepFrozen.body?.message ?? ""}）`);
  const cr10RejectNew = await send(`/api/exams/${examA}/participants`, "PUT", tokenA, { studentIds: [sids["9001"], sids["9003"]] });
  ok(cr10RejectNew.status === 403 && cr10RejectNew.body?.code === "PARTICIPANT_OUT_OF_SCOPE",
    `冻结名单不放宽 R29：新塞入的范围外学生仍被 403（实际 ${cr10RejectNew.status}）`);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, sids["9001"]);
  await send(`/api/exams/${examA}/participants`, "DELETE", tokenA);

  // CR12：拒绝越权时只回显调用者自己给的标识，不得把范围外学生的姓名拼进消息
  const cr12Labels = String(cr10RejectNew.body?.message ?? "");
  ok(!cr12Labels.includes("学生9003"), `403 消息不含范围外学生姓名（实际 ${cr12Labels}）`);
  ok(cr12Labels.includes(String(sids["9003"])), "403 消息仍回显调用者提交过的学生 ID，够定位问题");
  const cr12ByNumber = await send(`/api/exams/${examA}/participants`, "PUT", tokenA, { studentNumbers: ["9001", "9003"] });
  ok(cr12ByNumber.status === 403 && !String(cr12ByNumber.body?.message ?? "").includes("学生9003")
    && String(cr12ByNumber.body?.message ?? "").includes("9003"),
    `学号入口同样只回显请求里的学号（实际 ${JSON.stringify(cr12ByNumber.body?.message ?? "")}）`);

  // CR11：只读教师（can_view_scores=1 / can_view_students=1 / can_grade=0）不是「题块级受限」
  const teacherView = await users.createUser({ username: "t-view", password: "pass-1234", name: "只读教师", role_id: 2, teacher_role: "subject_teacher", subject: "数学" });
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, '数学')").run(teacherView.id, classA);
  const tokenV = (await authService.login("t-view", "pass-1234")).token!;
  matrix(teacherView.id, { class_id: classA, can_grade: 0 });
  const cr11ReadOnly = await get(`/api/exams/${examA}/student/${sids["9001"]}/scores`, tokenV);
  ok(cr11ReadOnly.status === 200, `只读教师读取整卷成绩详情成功（实际 ${cr11ReadOnly.status} ${cr11ReadOnly.body?.message ?? ""}）`);
  clearMatrix(teacherView.id);
  matrix(teacherView.id, { class_id: classA, can_grade: 0, can_view_scores: 0 });
  const cr11NoView = await get(`/api/exams/${examA}/student/${sids["9001"]}/scores`, tokenV);
  // 拒绝理由必须落在「查看权限」上：can_view_scores=0 先在 getVisibleExamIds 的矩阵过滤里
  // 把考试移出可见集合（requireExamAccess 报「无权访问此考试」），到不了路由上的查看门，
  // 两道门是同一条口径。反过来，若理由变成「题块」就说明 CR11 的放宽被写坏了。
  ok(cr11NoView.status === 403 && !String(cr11NoView.body?.message ?? "").includes("题块"),
    `关掉 can_view_scores 后仍被拒（读权限缺失才是 403 的理由，实际 ${cr11NoView.status} ${cr11NoView.body?.message ?? ""}）`);
  clearMatrix(teacherView.id);
  const cr11NoMatrix = await get(`/api/exams/${examA}/student/${sids["9001"]}/scores`, tokenV);
  ok(cr11NoMatrix.status === 200, `未配置矩阵的教师保持旧部署兼容放行（实际 ${cr11NoMatrix.status}）`);
  matrix(teacherA.id, { class_id: classA, block_id: "B1", can_grade: 1 });
  const cr11BlockScoped = await get(`/api/exams/${examA}/student/${sids["9001"]}/scores`, tokenA);
  ok(cr11BlockScoped.status === 403, `确实只有题块级阅卷授权的教师仍被拦在整卷详情外（实际 ${cr11BlockScoped.status}）`);
  clearMatrix(teacherA.id);

  console.log("\n== R47 争议复评按人去重，不叠加票数 ==");
  const { submitReviewCropScores } = await import("../src/server/services/ReviewService");
  db.prepare(
    `INSERT INTO block_grading_config (exam_id, block_id, dispute_threshold, rounding, review_mode, auto_reassign_no_arb, scoring_mode)
     VALUES (?, 'B2', 1, 'none', 2, 0, 'per_question')`
  ).run(examA);
  const cropB2 = await claimSpecificPaper(examA, "B2", "pc-b2-9001", teacherA.id);
  const firstRound = await submitReviewCropScores({
    examId: examA, cropId: cropB2.id, userId: teacherA.id,
    scores: [{ questionNumber: 22, scoreType: "subjective", score: 14 }]
  });
  ok(firstRound.ok === true && firstRound.status === "pending", `首评后等待二评（实际 ${firstRound.status}）`);
  await claimSpecificPaper(examA, "B2", "pc-b2-9001", teacherB.id);
  const secondRound = await submitReviewCropScores({
    examId: examA, cropId: cropB2.id, userId: teacherB.id,
    scores: [{ questionNumber: 22, scoreType: "subjective", score: 3 }]
  });
  ok(secondRound.disputed === true && secondRound.finalScore === null, "两评分差超阈值 → 判为争议，不落正式分");
  // 争议卷回退给原老师复评（此处以管理员通道提交，等价于自动回退后的原教师）：
  // 修复前 [14,3,14] 会被当成三票、按「取接近分平均」把争议判成 14 分。
  const reReview = await submitReviewCropScores({
    examId: examA, cropId: cropB2.id, userId: teacherA.id, isAdmin: true,
    scores: [{ questionNumber: 22, scoreType: "subjective", score: 14 }]
  });
  ok(reReview.disputed === true && reReview.finalScore === null,
    `原老师复评不把自己的票变成两票（实际 disputed=${reReview.disputed}, finalScore=${reReview.finalScore}）`);
  const disputedRow = db.prepare("SELECT final_score, status FROM answer_block_crops WHERE id = ?").get(cropB2.id) as { final_score: number | null; status: string };
  ok(disputedRow.final_score === null && disputedRow.status === "disputed", "争议卷仍留在争议池，未被重复计票改判为已阅");
  const authoritativeRow = db.prepare(
    "SELECT score FROM question_scores WHERE exam_id = ? AND student_id = ? AND question_number = 22 AND block_id = 'B2'"
  ).get(examA, sids["9001"]) as { score: number };
  ok(Number(authoritativeRow.score) === 15, "争议未决期间不写入逐题正式分");

  console.log("\n== PR #312 CR3/CR4/CR5 扫描接口的考试与题块范围 ==");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const { buildLayout } = await import("../src/shared/layout");
  const scanCardId = "PERMSCAN001";
  db.prepare(
    `INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by)
     VALUES (?, '扫描范围卡', 'math', '数学', '2026-09-01', 'A4', 'portrait', '{}', 4, 'single', 1, ?)`
  ).run(scanCardId, adminId);
  for (const [block, question, order] of [["B1", 21, 0], ["B2", 22, 1]] as Array<[string, number, number]>) {
    db.prepare("INSERT INTO subjective_blocks (id, card_id, sort_order, block_kind, title, title_locked) VALUES (?, ?, ?, 'answer', ?, 0)")
      .run(block, scanCardId, order, `${block} 题块`);
    db.prepare(
      `INSERT INTO subjective_questions (id, block_id, number, score, style, kind, min_height_mm, line_grid_enabled, line_spacing_mm, sort_order)
       VALUES (?, ?, ?, 20, 'manual_score_grid', 'plain_box', 200, 0, 8, 0)`
    ).run(`q-${block}`, block, question);
  }
  const scanCard = await new CardRepository().findById(scanCardId);
  ok(Boolean(scanCard), "夹具自校验：扫描范围卡可读（含两个题块）");
  const scanLayout = buildLayout(scanCard!);
  const pageOfBlock = new Map<string, number>();
  for (const page of scanLayout.pages) for (const b of page.blocks) pageOfBlock.set(b.blockId, page.pageNumber);
  const [pageB1, pageB2] = [pageOfBlock.get("B1") ?? 0, pageOfBlock.get("B2") ?? 0];
  ok(pageB1 > 0 && pageB2 > 0 && pageB1 !== pageB2,
    `夹具自校验：两个题块分处不同排版页（实际 ${pageB1} / ${pageB2}，共 ${scanLayout.pages.length} 页）`);

  const examScan = makeExam("扫描范围考", { classId: classA, subject: "数学", createdBy: adminId, published: true, card: scanCardId });
  const scanSession = "perm-scan-session";
  db.prepare("INSERT INTO twain_scan_sessions (id, card_id, name, status, identity_mode, page_count) VALUES (?, ?, '范围验收', 'completed', 'strict', 2)")
    .run(scanSession, scanCardId);
  for (const [rec, page] of [["rec-p1", pageB1], ["rec-p2", pageB2]] as Array<[string, number]>) {
    db.prepare(
      `INSERT INTO twain_scan_records (id, session_id, card_id, student_id, image_path, page_num, side, ocr_status, identity_json)
       VALUES (?, ?, ?, '9001', ?, ?, 'front', 'uploaded', '{}')`
    ).run(rec, scanSession, scanCardId, path.join(tmpDir, `${rec}.png`), page);
    // 两条识别结果都同时含 B1/B2：即使在同一排版页上，他人题块也不该外发。
    db.prepare(
      `INSERT INTO twain_recognition_results (id, scan_record_id, objective_json, subjective_json, total_score, max_score, grade_status)
       VALUES (?, ?, ?, '[]', 35, 35, 'recognized')`
    ).run(`rr-${rec}`, rec, JSON.stringify([
      { blockId: "B1", questionNumber: 21, score: 20 },
      { blockId: "B2", questionNumber: 22, score: 15 }
    ]));
  }

  // CR3：只带 cardId / sessionId 的列表与进度端点，此前完全绕开考试范围。
  const foreignSessions = await get(`/api/scanner/sessions/${scanCardId}`, tokenB);
  ok(foreignSessions.status === 403, `范围外教师按卡号读会话列表被 403（实际 ${foreignSessions.status}）`);
  const foreignScans = await get(`/api/scanner/card/${scanCardId}/scans`, tokenB);
  ok(foreignScans.status === 403 && !JSON.stringify(foreignScans.body).includes("9001"),
    `范围外教师按卡号读扫描列表被 403，学号与总分不落进响应体（实际 ${JSON.stringify(foreignScans.body).slice(0, 80)}）`);
  const foreignProgress = await get(`/api/scanner/progress/${scanSession}`, tokenB);
  ok(foreignProgress.status === 403, `范围外教师订阅扫描进度流被 403（实际 ${foreignProgress.status}）`);
  const foreignRecord = await get(`/api/scanner/record/rec-p1`, tokenB);
  ok(foreignRecord.status === 403, "同一记录在详情端点上同样被拒（列表与详情口径一致）");
  const foreignPreview = await get(`/api/scanner/exam/${examScan}/student/${sids["9001"]}/scans`, tokenB);
  ok(foreignPreview.status === 403, `范围外教师读评分表原卷预览被 403（实际 ${foreignPreview.status}）`);
  const foreignImage = await get(`/api/scanner/grading-image/${scanCardId}/x.png`, tokenB);
  ok(foreignImage.status === 403, `阅卷上传目录的图片读取按答题卡范围收口（实际 ${foreignImage.status}）`);
  ok((await get(`/api/scanner/exam/${examScan}/student/${sids["9001"]}/scans`, tokenA)).status === 200,
    "整卷授权的本场教师仍能正常预览");

  // CR5：题块教师只能读到含本人题块的排版页，同页他人题块与整卷总分一并剔除。
  matrix(teacherA.id, { class_id: classA, block_id: "B1" });
  const scopedForeignPage = await get(`/api/scanner/record/rec-p2`, tokenA);
  ok(scopedForeignPage.status === 403, `题块教师读取他人题块所在页被 403（实际 ${scopedForeignPage.status}）`);
  const scopedOwnPage = await get(`/api/scanner/record/rec-p1`, tokenA);
  const ownObjective = String(scopedOwnPage.body?.recognition?.objective_json ?? "");
  ok(scopedOwnPage.status === 200 && ownObjective.includes("B1") && !ownObjective.includes("B2"),
    `本人页上他人题块的识别结果被剔除（实际 ${ownObjective.slice(0, 90)}）`);
  ok(scopedOwnPage.body?.recognition?.total_score === null && scopedOwnPage.body?.recognition?.max_score === null,
    "整卷总分不再随识别结果外发");
  const scopedSessionView = await get(`/api/scanner/scan/${scanSession}`, tokenA);
  const listedRecords = (scopedSessionView.body?.records ?? []).map((r: { id: string }) => r.id);
  ok(scopedSessionView.status === 200 && listedRecords.length === 1 && listedRecords[0] === "rec-p1",
    `会话详情只列出本人题块所在页（实际 ${JSON.stringify(listedRecords)}）`);
  const scopedCardList = await get(`/api/scanner/card/${scanCardId}/scans`, tokenA);
  ok(Array.isArray(scopedCardList.body) && scopedCardList.body.length === 1
    && scopedCardList.body[0]?.recognition?.totalScore === null,
    `扫描列表按排版页收口且不含整卷分（实际 ${JSON.stringify(scopedCardList.body).slice(0, 120)}）`);
  // 扫描端的整卷聚合入口（会话结果）：返回全卷识别结果与总分，题块级账号没有可读子集。
  const scopedSessionResults = await get(`/api/scanner/session/${scanSession}/results`, tokenA);
  ok(scopedSessionResults.status === 403,
    `题块教师读取整卷会话结果被 403（扫描端点是整卷操作面，实际 ${scopedSessionResults.status}）`);
  clearMatrix(teacherA.id);
  const wholePaperResults = await get(`/api/scanner/session/${scanSession}/results`, tokenA);
  ok(wholePaperResults.status !== 403,
    `整卷授权教师未被范围校验误拦（放行到业务层，实际 ${wholePaperResults.status}）`);

  // CR4：卡上唯一考试被软删除后，不得退化成「未绑定考试」而直接放行。
  db.prepare("INSERT INTO exam_archives (exam_id, is_deleted, deleted_at) VALUES (?, 1, CURRENT_TIMESTAMP)").run(examScan);
  const archivedCardList = await get(`/api/scanner/card/${scanCardId}/scans`, tokenA);
  ok(archivedCardList.status === 404, `考试归档后按卡号读扫描列表返回 404 而非放行（实际 ${archivedCardList.status}）`);
  const archivedRecord = await get(`/api/scanner/record/rec-p1`, tokenA);
  ok(archivedRecord.status === 404, `考试归档后按记录 ID 读原卷同样 404（实际 ${archivedRecord.status}）`);
  db.prepare("DELETE FROM exam_archives WHERE exam_id = ?").run(examScan);

  console.log("\n== PR #312 CR1/CR6/CR9 试卷池的复核轮次与读取范围 ==");
  const { isClaimableForAssignedSet } = await import("../src/server/services/ReviewPoolService");
  // 双评的第二评人：同一场、同一题块、同一班，但逐生切片与 teacherA 互不重叠（A=9001 / D=9003）。
  // 修复前复核轮次仍按切片过滤 → 首评人被评分历史挡住、其他人被切片挡住，第二评永远无人可领。
  const teacherD = await users.createUser({ username: "t-second", password: "pass-1234", name: "同题块二评教师", role_id: 2, teacher_role: "subject_teacher", subject: "数学" });
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, '数学')").run(teacherD.id, classA);
  db.prepare("INSERT INTO review_assignments (exam_id, block_id, teacher_id, student_count, assigned_student_ids) VALUES (?, 'B1', ?, 1, ?)")
    .run(examA, teacherD.id, JSON.stringify([sids["9003"]]));
  // 无人被分配到的学生卷子：既不该被自动领取，也不该出现在任何人的清单与原图里
  db.prepare(
    `INSERT INTO answer_block_crops (id, card_id, exam_id, student_id, student_number, source_type, source_record_id, block_id, block_type, page_number, segment_index, question_numbers, rect_json, image_path, width_px, height_px, dpi, status, review_round)
     VALUES ('pc-b1-9002', ?, ?, ?, 'S5', 'test', 'rec-pc-b1-9002', 'B1', 'subjective', 1, 0, '[21]', '{}', '', 0, 0, 300, 'ready', 0)`
  ).run(cardId, examA, sids["9002"]);
  // 9003 的 B1 小题满分行：夹具只给它建过 student_scores，逐题判分范围按 question_scores 取值
  db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type, block_id) VALUES (?,?,?,?,?,'subjective','B1')")
    .run(examA, sids["9003"], 21, 20, 20);
  const cropImageFile = path.join(tmpDir, "crop-image.png");
  writeFileSync(cropImageFile, "not-a-real-png");
  db.prepare("UPDATE answer_block_crops SET image_path = ? WHERE id LIKE 'pc-b1-%' OR id = 'pc-b2-9001'").run(cropImageFile);
  db.prepare(
    `INSERT INTO block_grading_config (exam_id, block_id, dispute_threshold, rounding, review_mode, auto_reassign_no_arb, scoring_mode)
     VALUES (?, 'B1', 1, 'none', 2, 0, 'per_question')`
  ).run(examA);

  const cropA1 = await claimSpecificPaper(examA, "B1", "pc-b1-9001", teacherA.id);
  ok(cropA1.id === "pc-b1-9001" && cropA1.claimedBy === teacherA.id, "首评教师领取自己切片内的卷子");
  const cr1First = await submitReviewCropScores({
    examId: examA, cropId: "pc-b1-9001", userId: teacherA.id,
    scores: [{ questionNumber: 21, scoreType: "subjective", score: 12 }]
  });
  ok(cr1First.ok === true && cr1First.status === "pending", `首评后卷子回到池中等待第二评（实际 ${cr1First.status}）`);
  await assert.rejects(
    () => claimSpecificPaper(examA, "B1", "pc-b1-9001", teacherA.id),
    (err: unknown) => err instanceof ReviewPoolError && err.message.includes("已批阅过"),
    "同一人不重复评同一份卷子（复核轮次也不例外）"
  );
  ok(
    isClaimableForAssignedSet({ studentId: sids["9001"], status: "ready", reviewRound: 0 }, new Set([sids["9003"]])) === false
    && isClaimableForAssignedSet({ studentId: sids["9001"], status: "pending", reviewRound: 1 }, new Set([sids["9003"]])) === true
    && isClaimableForAssignedSet({ studentId: sids["9001"], status: "ready", reviewRound: 0 }, null) === true,
    "放行只针对离开首评队列的卷子：切片外首评仍拒、待复核放行、整块可阅不受限"
  );
  // 切片内的首评优先：他人待复核的卷子按学号排在前头时，也不该挤掉本人未开评的首评工作量
  const autoOwnSlice = await claimNextPaper(examA, "B1", teacherD.id);
  ok(autoOwnSlice.id === "pc-b1-9003", `自动领取优先本人切片内的首评卷（实际 ${autoOwnSlice.id}）`);
  await assert.rejects(
    () => claimSpecificPaper(examA, "B1", "pc-b1-9002", teacherD.id),
    (err: unknown) => err instanceof ReviewPoolScopeError,
    "切片外且尚未首评的卷子依旧拒绝指定领取（放行不覆盖首评队列）"
  );

  // CR6：清单读取同样要过题块级正向授权
  const teacherC = await users.createUser({ username: "t-pe", password: "pass-1234", name: "同场非本题块教师", role_id: 2, teacher_role: "subject_teacher", subject: "数学" });
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, '数学')").run(teacherC.id, classA);
  const tokenC = (await authService.login("t-pe", "pass-1234")).token!;
  const tokenD = (await authService.login("t-second", "pass-1234")).token!;
  const poolForeign = await get(`/api/review-pool/exams/${examA}/blocks/B1`, tokenC);
  ok(poolForeign.status === 403, `未分配本题块的教师读取试卷池清单被 403（实际 ${poolForeign.status}）`);
  ok(!JSON.stringify(poolForeign.body).includes(String(sids["9001"])), "越权清单不返回学生 ID");
  const poolIdsOf = async (token: string): Promise<string[]> =>
    ((await get(`/api/review-pool/exams/${examA}/blocks/B1`, token)).body?.data?.entries ?? [])
      .map((e: { id: string }) => e.id);
  const poolIds = await poolIdsOf(tokenA);
  ok(poolIds.includes("pc-b1-9001") && !poolIds.includes("pc-b1-9002") && !poolIds.includes("pc-b1-9003"),
    `首评人清单只含本人切片（实际 ${JSON.stringify(poolIds)}）`);
  const secondIds = await poolIdsOf(tokenD);
  ok(secondIds.includes("pc-b1-9003") && secondIds.includes("pc-b1-9001") && !secondIds.includes("pc-b1-9002"),
    `二评人清单同时含本人首评卷与跨切片待复核卷（实际 ${JSON.stringify(secondIds)}）`);

  // CR6：切块原图入口按 cropId 直连，此前只校验权限位，不校验考试与题块范围
  ok((await get(`/api/answer-block-crops/pc-b1-9001/image`, tokenA)).status === 200, "本人切片内的切块原图可读");
  const imgNoOwner = await get(`/api/answer-block-crops/pc-b1-9002/image`, tokenA);
  ok(imgNoOwner.status === 403, `无人被分配的首评切块原图不会被顺带读到（实际 ${imgNoOwner.status}）`);
  const imgForeignSlice = await get(`/api/answer-block-crops/pc-b1-9003/image`, tokenA);
  ok(imgForeignSlice.status === 403, `切片外仍待首评的切块原图被 403，即使已被他人领取（实际 ${imgForeignSlice.status}）`);
  ok((await get(`/api/answer-block-crops/pc-b1-9001/image`, tokenD)).status === 200,
    "跨切片但已离开首评队列的切块原图可读（与领取/清单同一谓词）");
  const imgForeignTeacher = await get(`/api/answer-block-crops/pc-b1-9001/image`, tokenC);
  ok(imgForeignTeacher.status === 403, `未分配本题块的教师按 cropId 直读原图被 403（实际 ${imgForeignTeacher.status}）`);
  ok((await get(`/api/answer-block-crops/pc-b1-9001/image`, tokenS1)).status === 200, "学生读取本人切块原图不受影响");
  ok((await get(`/api/answer-block-crops/pc-b2-9001/image`, tokenA)).status === 200,
    "该题块完全没有分配数据时按旧部署放行（兼容回退不误拦）");

  // CR1 全流程：跨切片承接第二评 → 首评人再承接另一份的第二评，双评走得完
  const crossClaim = await claimSpecificPaper(examA, "B1", "pc-b1-9001", teacherD.id);
  ok(crossClaim.claimedBy === teacherD.id && crossClaim.status === "pending",
    `切片外的教师领取待复核卷子成功（实际 claimedBy=${crossClaim.claimedBy}）`);
  const crossSubmit = await submitReviewCropScores({
    examId: examA, cropId: "pc-b1-9001", userId: teacherD.id,
    scores: [{ questionNumber: 21, scoreType: "subjective", score: 12 }]
  });
  ok(crossSubmit.ok === true && crossSubmit.status === "reviewed", `双评流程走通（实际 ${crossSubmit.status}）`);
  await submitReviewCropScores({
    examId: examA, cropId: "pc-b1-9003", userId: teacherD.id,
    scores: [{ questionNumber: 21, scoreType: "subjective", score: 15 }]
  });
  const autoCross = await claimNextPaper(examA, "B1", teacherA.id);
  ok(autoCross.id === "pc-b1-9003", `自动领取能拿到切片外的待复核卷（实际 ${autoCross.id}）`);
  const autoSubmit = await submitReviewCropScores({
    examId: examA, cropId: "pc-b1-9003", userId: teacherA.id,
    scores: [{ questionNumber: 21, scoreType: "subjective", score: 15 }]
  });
  ok(autoSubmit.ok === true && autoSubmit.status === "reviewed", `两份卷子都完成双评（实际 ${autoSubmit.status}）`);
  ok(
    db.prepare("SELECT 1 FROM answer_block_crops WHERE id = 'pc-b1-9002' AND claimed_by IS NOT NULL").get() === undefined,
    "无人被分配到的首评卷始终没有被切片外教师顺手领走"
  );

  // CR9：持有量预留的临界区预算与既有配额共用同一套三档设计
  ok(limits.CLAIM_LOCK_TIMEOUT_MS === 3000, "默认领取锁等待预算 3000 毫秒");
  assert.equal(limits.resolveReviewPoolLimits({ PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS: "500" }).limits.claimLockTimeoutMs, 500);
  assert.equal(limits.resolveReviewPoolLimits({ PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS: "0" }).limits.claimLockTimeoutMs, 3000);
  assert.equal(limits.resolveReviewPoolLimits({ PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS: "999999" }).limits.claimLockTimeoutMs, 30000);
  ok(limits.describeReviewPoolLimits().includes("claimLockTimeoutMs=3000"), "锁预算进入启动摘要");

  console.log("\n== R06 删除答题卡不得改写/点名范围外考试（破坏性步骤，放在最后） ==");
  const referencedCount = (db.prepare("SELECT COUNT(*) AS n FROM exams WHERE card_id = ?").get(cardId) as { n: number }).n;
  ok(referencedCount >= 2, `夹具自校验：本卡被多场考试引用（实际 ${referencedCount}）`);
  const blockedNames = await json(`/api/cards/${cardId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tokenB}`, "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  ok(
    blockedNames.status === 409 && (blockedNames.body?.referencedExamNames ?? []).length === 0,
    `无归属关系的教师只被告知引用数量，拿不到考试名单（实际 ${JSON.stringify(blockedNames.body?.referencedExamNames)}）`
  );
  const unlinkForeign = await json(`/api/cards/${cardId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tokenB}`, "Content-Type": "application/json" },
    body: JSON.stringify({ unlinkExams: true })
  });
  ok(unlinkForeign.status === 403 && unlinkForeign.body?.code === "EXAM_OUT_OF_SCOPE", "解绑他人范围的考试被 403");
  ok((db.prepare("SELECT COUNT(*) AS n FROM exams WHERE card_id = ?").get(cardId) as { n: number }).n === referencedCount, "越权解绑未产生任何改写");
  const unlinkOwn = await json(`/api/cards/${cardId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ unlinkExams: true })
  });
  ok(
    unlinkOwn.status === 200 && unlinkOwn.body?.unlinkedExamCount === referencedCount,
    `有归属关系的教师可解绑并删除卡（实际 ${unlinkOwn.status} ${JSON.stringify(unlinkOwn.body).slice(0, 120)}）`
  );
  ok((db.prepare("SELECT COUNT(*) AS n FROM exams WHERE card_id = ?").get(cardId) as { n: number }).n === 0, "解绑后考试不再指向已删除的卡");

  // fetch 的 keep-alive 会让 close() 之后进程仍持有活动连接，显式断开后直接退出
  (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  server.close();
  closeDatabase();
  console.log(`\n权限边界验收：${passed} 通过，${failed} 失败`);
  removeTmpDir();
  process.exit(failed > 0 ? 1 : 0);
}

function removeTmpDir(): void {
  // Windows 上句柄未释放时 rmSync 会 EPERM，临时目录由系统清理，不影响验收结论
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    console.log(`（临时目录 ${tmpDir} 未能即时删除，交由系统清理）`);
  }
}

main().catch((err) => {
  console.error(err);
  removeTmpDir();
  process.exit(1);
});
