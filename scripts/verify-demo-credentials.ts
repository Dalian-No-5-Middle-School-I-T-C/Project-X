/**
 * 演示数据凭据与导入闸门回归验证（安全审查第五批 C · R33 / R48）
 *
 * 覆盖四条命题：
 *   1. 演示教师/学生口令默认随机换发，公开文档里的 teacher123 与「口令=学号」当场失效；
 *      教师范围收敛到 teacher_role='subject_teacher' + 两个演示班级，不再命中「未配置角色=全校可见」兼容分支。
 *   2. 库里已有真实数据时导入需显式确认串（或环境变量放行），拒绝发生在任何写入之前。
 *   3. 固定演示卡号撞上真实答题卡时整单拒绝，真实卡上不留任何演示题块/知识点（INSERT IGNORE 静默复用已封死）。
 *   4. 崩溃残留的 demo-teacher（未被真实业务用过）收编并换发口令；在用的真实同名教师则拒绝且零改动。
 *
 * 用法：
 *   npx tsx scripts/verify-demo-credentials.ts
 *   # MariaDB（需先在 13306 临时实例上建好一次性空库）：
 *   PROJECTX_MARIADB_HOST=127.0.0.1 PROJECTX_MARIADB_PORT=13306 \
 *   PROJECTX_MARIADB_USER=projectx_ci PROJECTX_MARIADB_PASSWORD=px_ci_local_pw \
 *   PROJECTX_MARIADB_DATABASE=projectx_demo_credentials_test \
 *     npx tsx scripts/verify-demo-credentials.ts --mariadb
 *
 * 期望输出：所有断言通过，退出码 0。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 本脚本自行接管的环境变量清单。末节断言它必须与 demoDataPolicy 的 DEMO_POLICY_ENV_VARS 完全一致——
 * 新增开关却忘了在验证脚本里清空，会让「默认关闭」的断言在带脏环境的机器上假通过。
 */
const MANAGED_ENV_VARS = [
  "PROJECTX_DEMO_FIXED_CREDENTIALS",
  "PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT"
] as const;

const maria = process.argv.includes("--mariadb");
if (maria) {
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_demo_credentials_test", "MariaDB 模式需要一次性空库 projectx_demo_credentials_test");
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
} else {
  delete process.env.PROJECTX_MARIADB_HOST;
  delete process.env.PROJECTX_MYSQL_HOST;
  process.env.PROJECTX_DB_PATH = path.join(
    mkdtempSync(path.join(tmpdir(), "projectx-demo-credentials-")),
    "test.db"
  );
}
for (const name of MANAGED_ENV_VARS) delete process.env[name];

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role_id: number;
  student_number: string | null;
  teacher_role: string | null;
  initial_password: string | null;
  is_demo: number;
}

interface CountRow {
  n: number;
}

const { initializeDatabase, ensureDefaultAdmin, closeDatabase, hashPassword, verifyPassword } =
  await import("../src/server/db/index");
const { getMysqlDb, initMariadbSchema, resetAdapter } = await import("../src/server/db/mysql");
const { decryptField } = await import("../src/server/lib/field-crypto");
const { ROLE_IDS } = await import("../src/server/auth/permissions");
const { seedDemoData, clearDemoData, DEMO_CARD_IDS } = await import("../src/server/services/DemoDataService");
const { isDemoCard } = await import("../src/server/services/demo/demoCardIds");
const {
  DEMO_POLICY_ENV_VARS,
  DEMO_IMPORT_PRODUCTION_CONFIRM,
  LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD,
  DEMO_TEACHER_USERNAMES,
  demoFixedCredentialsEnabled,
  demoProductionImportAllowedByEnv
} = await import("../src/server/services/demo/demoDataPolicy");

if (!maria) initializeDatabase();
const db = getMysqlDb();
if (maria) {
  const tables = await db.get<CountRow>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()"
  );
  assert.equal(Number(tables?.n), 0, "MariaDB 模式请使用全新的一次性库");
  await initMariadbSchema();
}
await ensureDefaultAdmin();

const count = async (sql: string, ...params: unknown[]): Promise<number> =>
  Number((await db.get<CountRow>(sql, ...params))?.n ?? 0);

const findUser = (username: string) =>
  db.get<UserRow>(
    `SELECT id, username, password_hash, role_id, student_number, teacher_role, initial_password, is_demo
       FROM users WHERE username = ?`,
    username
  );

async function refuseOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; code?: string; confirm?: string; cardIds?: string[]; usernames?: string[]; realExams?: number; realUsers?: number; message?: string };
  }
  return null;
}

// ── 0. 环境变量清单一致性 ──────────────────────────────────────
section("0. 开关清单：脚本接管的变量 == 模块声明的变量");
ok(
  JSON.stringify([...DEMO_POLICY_ENV_VARS].sort()) === JSON.stringify([...MANAGED_ENV_VARS].sort()),
  `demoDataPolicy 声明 ${DEMO_POLICY_ENV_VARS.length} 个开关，脚本清空 ${MANAGED_ENV_VARS.length} 个`
);
ok(!demoFixedCredentialsEnabled(), "未设变量时固定演示口令开关为关闭");
ok(!demoProductionImportAllowedByEnv(), "未设变量时生产库免确认开关为关闭");
process.env.PROJECTX_DEMO_FIXED_CREDENTIALS = "maybe";
ok(!demoFixedCredentialsEnabled(), "开关取值非法（maybe）时按关闭处理，不静默放宽");
delete process.env.PROJECTX_DEMO_FIXED_CREDENTIALS;

// ── 1. 默认导入：随机口令 + 任课教师范围 ────────────────────────
section("1. 默认导入：教师口令随机、teacher123 失效、范围收敛到演示班级");
const stats1 = await seedDemoData();
ok(stats1.teacherCredentials.length === 2, `返回 2 条教师凭据（实际 ${stats1.teacherCredentials.length}）`);
ok(
  JSON.stringify(stats1.teacherCredentials.map((c) => c.username)) === JSON.stringify([...DEMO_TEACHER_USERNAMES]),
  `凭据用户名与保留名一致（${stats1.teacherCredentials.map((c) => c.username).join("、")}）`
);
ok(stats1.teacherCredentials.every((c) => c.fixed === false), "凭据标记 fixed=false（非公开固定口令）");
ok(
  stats1.teacherCredentials.every((c) => c.password !== LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD),
  `教师口令不是公开文档里的 ${LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD}`
);
ok(
  new Set(stats1.teacherCredentials.map((c) => c.password)).size === 2,
  "两名演示教师口令互不相同（不是同一个随机值复用）"
);
ok(
  stats1.teacherCredentials.every((c) => c.password.length >= 16),
  `教师口令长度 ≥ 16（实际 ${stats1.teacherCredentials.map((c) => c.password.length).join("/")}）`
);
ok(stats1.studentPasswordIsStudentNumber === false, "学生口令不等于学号（studentPasswordIsStudentNumber=false）");

for (const cred of stats1.teacherCredentials) {
  const row = await findUser(cred.username);
  ok(row?.is_demo === 1, `${cred.username} 标记 is_demo=1（清理可回收）`);
  ok(row?.role_id === ROLE_IDS.TEACHER, `${cred.username} 角色为教师（role_id=${row?.role_id}）`);
  ok(
    row?.teacher_role === "subject_teacher",
    `${cred.username} teacher_role='subject_teacher'（不再命中「未配置角色=全校可见」兼容分支，实际 ${row?.teacher_role}）`
  );
  ok(await verifyPassword(cred.password, row!.password_hash), `${cred.username} 返回的口令能通过校验`);
  ok(
    !(await verifyPassword(LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD, row!.password_hash)),
    `${cred.username} 用 ${LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD} 登录失败`
  );
  ok(
    decryptField(row?.initial_password) === cred.password,
    `${cred.username} 口令已加密存入 initial_password（管理员可从既有账号导出查回）`
  );
  const links = (await db.all<{ class_id: number; is_demo: number }>(
    `SELECT tc.class_id, c.is_demo FROM teacher_classes tc JOIN classes c ON c.id = tc.class_id WHERE tc.teacher_id = ?`,
    row!.id
  )) as Array<{ class_id: number; is_demo: number }>;
  ok(links.length === 2, `${cred.username} 任课 2 个班级（实际 ${links.length}）`);
  ok(links.every((l) => Number(l.is_demo) === 1), `${cred.username} 任课班级全部是演示班级`);
  const realLinks = await count(
    `SELECT COUNT(*) AS n FROM teacher_classes tc JOIN classes c ON c.id = tc.class_id
      WHERE tc.teacher_id = ? AND c.is_demo = 0`,
    row!.id
  );
  ok(realLinks === 0, `${cred.username} 没有任课到任何真实班级（实际 ${realLinks}）`);
}

const demoStudents = (await db.all<UserRow>(
  "SELECT id, username, password_hash, student_number, initial_password, is_demo FROM users WHERE is_demo = 1 AND role_id = ?",
  ROLE_IDS.STUDENT
)) as UserRow[];
ok(demoStudents.length === 16, `演示学生 16 名（实际 ${demoStudents.length}）`);
let studentPasswordEqualsNumber = 0;
let studentInitialMissing = 0;
for (const stu of demoStudents) {
  const number = String(stu.student_number);
  if (await verifyPassword(number, stu.password_hash)) studentPasswordEqualsNumber += 1;
  const initial = decryptField(stu.initial_password);
  if (!initial || initial === number) studentInitialMissing += 1;
}
ok(studentPasswordEqualsNumber === 0, `没有一个演示学生能用学号登录（实际 ${studentPasswordEqualsNumber} 个）`);
ok(studentInitialMissing === 0, `每个演示学生都有可查回的随机初始口令（异常 ${studentInitialMissing} 个）`);

// ── 2. 重复导入：口令换发，旧口令立即失效 ──────────────────────
section("2. 重复导入：教师口令换发，上一轮口令立即失效");
const previousPasswords = new Map(stats1.teacherCredentials.map((c) => [c.username, c.password]));
const stats2 = await seedDemoData();
for (const cred of stats2.teacherCredentials) {
  const old = previousPasswords.get(cred.username)!;
  ok(cred.password !== old, `${cred.username} 第二次导入口令已换发`);
  ok(cred.password !== LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD, `${cred.username} 换发后仍不是公开固定口令`);
  const row = await findUser(cred.username);
  ok(!(await verifyPassword(old, row!.password_hash)), `${cred.username} 上一轮口令已失效`);
  ok(await verifyPassword(cred.password, row!.password_hash), `${cred.username} 新口令可用`);
}
ok(
  (await count("SELECT COUNT(*) AS n FROM users WHERE is_demo = 1")) === 18,
  `重复导入不叠加演示账号（16 学生 + 2 教师，实际 ${await count("SELECT COUNT(*) AS n FROM users WHERE is_demo = 1")}）`
);

// ── 3. 固定凭据开关：只在显式声明的隔离环境恢复旧口径 ───────────
section("3. PROJECTX_DEMO_FIXED_CREDENTIALS=1 时恢复固定口令，且带警告");
process.env.PROJECTX_DEMO_FIXED_CREDENTIALS = "1";
const stats3 = await seedDemoData();
ok(stats3.teacherCredentials.every((c) => c.fixed === true), "凭据标记 fixed=true（调用方据此加警告）");
ok(
  stats3.teacherCredentials.every((c) => c.password === LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD),
  `固定模式下教师口令为 ${LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD}`
);
ok(stats3.studentPasswordIsStudentNumber === true, "固定模式下学生口令=学号（仅隔离测试环境）");
const fixedRow = await findUser(DEMO_TEACHER_USERNAMES[0]);
ok(
  await verifyPassword(LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD, fixedRow!.password_hash),
  "固定模式下公开口令确实可登录（证明开关生效，而非被静默忽略）"
);
delete process.env.PROJECTX_DEMO_FIXED_CREDENTIALS;

// ── 4. 生产库导入闸门（R33） ───────────────────────────────────
section("4. 库里已有真实数据：未确认整单拒绝，确认后放行");
await clearDemoData();
const realExamId = (await db.run("INSERT INTO exams (name) VALUES (?)", "真实月考")).lastInsertRowid;
const snapshot4 = {
  users: await count("SELECT COUNT(*) AS n FROM users"),
  exams: await count("SELECT COUNT(*) AS n FROM exams"),
  cards: await count("SELECT COUNT(*) AS n FROM answer_cards"),
  grades: await count("SELECT COUNT(*) AS n FROM grades"),
  blocks: await count("SELECT COUNT(*) AS n FROM subjective_blocks")
};

const refusal4 = await refuseOf(seedDemoData());
ok(refusal4 !== null, "未确认时 seedDemoData 抛错");
ok(refusal4?.code === "DEMO_IMPORT_REQUIRES_CONFIRMATION", `错误码 DEMO_IMPORT_REQUIRES_CONFIRMATION（实际 ${refusal4?.code}）`);
ok(refusal4?.status === 409, `HTTP 状态 409（实际 ${refusal4?.status}）`);
ok(refusal4?.confirm === DEMO_IMPORT_PRODUCTION_CONFIRM, "错误里带回前端需回传的确认串");
ok(refusal4?.realExams === 1, `拒绝信息点明真实考试数（realExams=${refusal4?.realExams}）`);
ok(
  (await count("SELECT COUNT(*) AS n FROM users")) === snapshot4.users
  && (await count("SELECT COUNT(*) AS n FROM exams")) === snapshot4.exams
  && (await count("SELECT COUNT(*) AS n FROM answer_cards")) === snapshot4.cards
  && (await count("SELECT COUNT(*) AS n FROM grades")) === snapshot4.grades
  && (await count("SELECT COUNT(*) AS n FROM subjective_blocks")) === snapshot4.blocks,
  "拒绝时零改动：用户/考试/答题卡/年级/题块计数与拒绝前完全一致"
);
ok(
  (await count("SELECT COUNT(*) AS n FROM exams WHERE name LIKE '演示-%'")) === 0,
  "拒绝时没有写入任何「演示-」前缀考试"
);

const stats4 = await seedDemoData({ confirmedProductionImport: true });
ok(stats4.exams >= 9 && stats4.teacherCredentials.every((c) => c.fixed === false), "带确认串放行，且仍是随机口令");

await clearDemoData();
process.env.PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT = "on";
const refusal4b = await refuseOf(seedDemoData());
ok(refusal4b === null, "PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT=on 时免逐次确认（CI/自动化口径）");
delete process.env.PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT;
await clearDemoData();
const refusal4c = await refuseOf(seedDemoData());
ok(refusal4c?.code === "DEMO_IMPORT_REQUIRES_CONFIRMATION", "关掉环境变量后闸门恢复生效");

// ── 5. 演示卡号撞真实卡（R48） ─────────────────────────────────
section("5. 固定演示卡号被真实答题卡占用：整单拒绝，真实卡零污染");
const conflictCardId = DEMO_CARD_IDS[0];
await db.run(
  "INSERT INTO answer_cards (id, title, is_demo) VALUES (?, ?, 0)",
  conflictCardId,
  "真实答题卡（与演示卡号撞号）"
);
const snapshot5 = {
  users: await count("SELECT COUNT(*) AS n FROM users"),
  exams: await count("SELECT COUNT(*) AS n FROM exams"),
  cards: await count("SELECT COUNT(*) AS n FROM answer_cards"),
  blocks: await count("SELECT COUNT(*) AS n FROM subjective_blocks WHERE card_id = ?", conflictCardId),
  kp: await count("SELECT COUNT(*) AS n FROM knowledge_points WHERE card_id = ?", conflictCardId)
};

const refusal5 = await refuseOf(seedDemoData({ confirmedProductionImport: true }));
ok(refusal5?.code === "DEMO_CARD_ID_CONFLICT", `错误码 DEMO_CARD_ID_CONFLICT（实际 ${refusal5?.code}）`);
ok(refusal5?.status === 409, `HTTP 状态 409（实际 ${refusal5?.status}）`);
ok(
  JSON.stringify(refusal5?.cardIds) === JSON.stringify([conflictCardId]),
  `错误里点名冲突卡号（${refusal5?.cardIds?.join("、")}）`
);
ok(
  String(refusal5?.message ?? "").includes("真实答题卡（与演示卡号撞号）"),
  "错误信息带上真实卡标题，便于运维定位"
);
ok(
  (await count("SELECT COUNT(*) AS n FROM users")) === snapshot5.users
  && (await count("SELECT COUNT(*) AS n FROM exams")) === snapshot5.exams
  && (await count("SELECT COUNT(*) AS n FROM answer_cards")) === snapshot5.cards,
  "拒绝时零改动：用户/考试/答题卡计数不变"
);
ok(
  (await count("SELECT COUNT(*) AS n FROM subjective_blocks WHERE card_id = ?", conflictCardId)) === snapshot5.blocks,
  `真实卡上没有被写入演示题块（实际 ${await count("SELECT COUNT(*) AS n FROM subjective_blocks WHERE card_id = ?", conflictCardId)}）`
);
ok(
  (await count("SELECT COUNT(*) AS n FROM knowledge_points WHERE card_id = ?", conflictCardId)) === snapshot5.kp,
  "真实卡上没有被写入演示知识点"
);
ok(
  (await count("SELECT COUNT(*) AS n FROM exams WHERE card_id = ? AND name LIKE '演示-%'", conflictCardId)) === 0,
  "没有演示考试挂到真实卡上"
);
ok(!(await isDemoCard(db, conflictCardId)), `isDemoCard(${conflictCardId}) = false，题块写入的纵深防线同样会跳过它`);
await db.run("UPDATE answer_cards SET is_demo = 1 WHERE id = ?", conflictCardId);
ok(await isDemoCard(db, conflictCardId), "is_demo=1 后 isDemoCard = true（判据只看归属标记，不看卡号）");
await db.run("UPDATE answer_cards SET is_demo = 0 WHERE id = ?", conflictCardId);

// ── 6. 崩溃残留的 demo-teacher：收编 + 换发口令 ─────────────────
section("6. v1.9.8 崩溃残留的 demo-teacher（未被真实业务用过）：收编并换发口令");
await db.run("DELETE FROM answer_cards WHERE id = ?", conflictCardId);
const leftoverHash = await hashPassword(LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD);
await db.run(
  "INSERT INTO users (username, password_hash, name, role_id, is_demo) VALUES (?, ?, ?, ?, 0)",
  DEMO_TEACHER_USERNAMES[0],
  leftoverHash,
  "崩溃残留",
  ROLE_IDS.TEACHER
);
const stats6 = await seedDemoData({ confirmedProductionImport: true });
const cred6 = stats6.teacherCredentials.find((c) => c.username === DEMO_TEACHER_USERNAMES[0])!;
const row6 = await findUser(DEMO_TEACHER_USERNAMES[0]);
ok(row6 !== null, "残留账号被收编（未因 UNIQUE 撞名失败）");
ok(row6?.is_demo === 1, `收编后标记 is_demo=1，可被 clearDemoData 回收（实际 ${row6?.is_demo}）`);
ok(row6?.teacher_role === "subject_teacher", `收编后补上 teacher_role（实际 ${row6?.teacher_role}）`);
ok(!(await verifyPassword(LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD, row6!.password_hash)), `收编后 ${LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD} 当场失效`);
ok(
  await verifyPassword(cred6.password, row6!.password_hash),
  "收编后使用本次随机换发的口令"
);
ok(cred6.password !== LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD, "换发口令不是公开固定值");
await clearDemoData();
ok((await findUser(DEMO_TEACHER_USERNAMES[0])) === null, "清理后残留账号一并回收");

// ── 7. 在用的真实同名教师：拒绝且零改动 ────────────────────────
section("7. demo-teacher 已被真实教师占用：拒绝导入，账号原样不动");
const realGradeId = (await db.run("INSERT INTO grades (name, sort_order, is_demo) VALUES (?, ?, 0)", "高三真实", 90)).lastInsertRowid;
const realClassId = (await db.run("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, ?, ?, 0)", realGradeId, "高三1班", 1)).lastInsertRowid;
const realHash = await hashPassword("RealTeacher#2026");
const realTeacherId = (
  await db.run(
    "INSERT INTO users (username, password_hash, name, role_id, is_demo) VALUES (?, ?, ?, ?, 0)",
    DEMO_TEACHER_USERNAMES[0],
    realHash,
    "真实教师（占用保留名）",
    ROLE_IDS.TEACHER
  )
).lastInsertRowid;
await db.run("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, ?)", realTeacherId, realClassId, "数学");

const snapshot7 = {
  users: await count("SELECT COUNT(*) AS n FROM users"),
  exams: await count("SELECT COUNT(*) AS n FROM exams"),
  cards: await count("SELECT COUNT(*) AS n FROM answer_cards"),
  demoGrades: await count("SELECT COUNT(*) AS n FROM grades WHERE is_demo = 1")
};
const refusal7 = await refuseOf(seedDemoData({ confirmedProductionImport: true }));
ok(refusal7?.code === "DEMO_TEACHER_USERNAME_TAKEN", `错误码 DEMO_TEACHER_USERNAME_TAKEN（实际 ${refusal7?.code}）`);
ok(refusal7?.status === 409, `HTTP 状态 409（实际 ${refusal7?.status}）`);
ok(
  JSON.stringify(refusal7?.usernames) === JSON.stringify([DEMO_TEACHER_USERNAMES[0]]),
  `错误里点名被占用的用户名（${refusal7?.usernames?.join("、")}）`
);
const row7 = await findUser(DEMO_TEACHER_USERNAMES[0]);
ok(row7?.password_hash === realHash, "拒绝时未改动真实教师口令");
ok(row7?.is_demo === 0, `拒绝时未把真实教师打成演示账号（实际 ${row7?.is_demo}）`);
ok(row7?.teacher_role === null, `拒绝时未改动真实教师的 teacher_role（实际 ${row7?.teacher_role}）`);
ok(
  (await count("SELECT COUNT(*) AS n FROM users")) === snapshot7.users
  && (await count("SELECT COUNT(*) AS n FROM exams")) === snapshot7.exams
  && (await count("SELECT COUNT(*) AS n FROM answer_cards")) === snapshot7.cards
  && (await count("SELECT COUNT(*) AS n FROM grades WHERE is_demo = 1")) === snapshot7.demoGrades,
  "拒绝时零改动：用户/考试/答题卡计数不变，没有留下演示年级"
);

// 换一条「在用」证据（exams.created_by）仍须拒绝：三条判据任一命中即拒绝，不是只认任课关系。
await db.run("DELETE FROM teacher_classes WHERE teacher_id = ?", realTeacherId);
await db.run("UPDATE exams SET created_by = ? WHERE id = ?", realTeacherId, realExamId);
const refusal7b = await refuseOf(seedDemoData({ confirmedProductionImport: true }));
ok(refusal7b?.code === "DEMO_TEACHER_USERNAME_TAKEN", "该教师创建过真实考试时同样拒绝（created_by 判据）");
await db.run("UPDATE exams SET created_by = NULL WHERE id = ?", realExamId);
await db.run(
  "INSERT INTO review_assignments (exam_id, block_id, teacher_id) VALUES (?, ?, ?)",
  realExamId,
  "verify-block-x",
  realTeacherId
);
const refusal7c = await refuseOf(seedDemoData({ confirmedProductionImport: true }));
ok(refusal7c?.code === "DEMO_TEACHER_USERNAME_TAKEN", "该教师被分配过阅卷任务时同样拒绝（review_assignments 判据）");
await db.run("DELETE FROM review_assignments WHERE teacher_id = ?", realTeacherId);
const refusal7d = await refuseOf(seedDemoData({ confirmedProductionImport: true }));
ok(refusal7d === null, "三条「在用」证据全部撤除后放行（残留账号按第 6 节收编）");
ok((await findUser(DEMO_TEACHER_USERNAMES[0]))?.is_demo === 1, "放行后同名账号按演示账号收编，真实教师身份不再被复用");

await clearDemoData();
ok(
  (await count("SELECT COUNT(*) AS n FROM users WHERE is_demo = 0")) >= 1
  && Boolean(await db.get("SELECT 1 AS x FROM exams WHERE id = ?", realExamId)),
  "全程收尾：真实考试仍在，演示数据已清空"
);

// closeDatabase() 只关 SQLite 实例；MariaDB 模式下真正持有连接的是 mariadbPool，
// 必须 resetAdapter() 才会 end()，否则进程挂在空闲连接上退不出去，CI 步骤会一直等到超时。
resetAdapter();
if (!maria) closeDatabase();
console.log(
  `\n────────────────────────────────────────\n结果（${maria ? "MariaDB" : "SQLite"}）：\x1b[32m${passed} 通过\x1b[0m，\x1b[31m${failed} 失败\x1b[0m`
);
if (failed > 0) {
  console.log("\x1b[31m失败项：\x1b[0m");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
