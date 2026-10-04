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
 *
 * 用法: npm run verify:permission-scope
 */
import { mkdtempSync, rmSync } from "node:fs";
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
  "PROJECTX_REVIEW_MAX_HELD_PER_BLOCK", "PROJECTX_REVIEW_MAX_HELD_TOTAL"
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
  function makeExam(name: string, opts: { classId: number | null; subject: string; mode?: string; createdBy: number; published?: boolean }): number {
    return Number(db.prepare(
      `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, score_published, exam_mode, created_by)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'closed', ?, ?, ?)`
    ).run(name, cardId, gradeId, opts.classId, opts.subject, opts.published ? 1 : 0, opts.mode ?? "formal", opts.createdBy).lastInsertRowid);
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
