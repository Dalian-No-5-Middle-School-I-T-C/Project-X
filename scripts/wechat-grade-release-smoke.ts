/**
 * 成绩发布微信订阅消息 —— 冒烟验证（SQLite 方言 + 打桩 fetch）
 * ----------------------------------------------------------------
 * 覆盖：
 *   1. v52 建表：UNIQUE(student_id, template_id) 生效；openid 为普通索引，
 *      允许同一 openid 绑定多个学生（共用设备 / 一个家长多个孩子）。
 *   2. 绑定写入语义（路由的 DELETE + INSERT）：同一学生重复订阅只保留一条。
 *   3. 收件人查询：COALESCE(assigned_score, total_score) 取分。
 *   4. 去重位「失败不占用」：token 故障 / 全员 43101 / 无收件人 / 未公布
 *      → 释放认领行；有 1 条送达 → 保留并写 completed。
 *   5. 首次发布只推一次：已 completed 的场次再次调用不产生任何发送。
 *   6. 进程崩溃遗留的 sending 超时行可被重新认领。
 *   7. access_token 并发刷新单飞：批量公布同时取 token 只请求一次（重复刷新会互相作废旧 token）。
 *
 * 运行：npm run verify:wechat-grade-release
 * 说明：全程使用临时 SQLite 库与打桩 fetch，不访问微信服务器。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 必须在导入任何 db 模块前设置数据库路径（getDatabase 在模块求值期读取该变量）
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-wechat-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "smoke.db");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PROJECTX_MARIADB_") || key.startsWith("PROJECTX_MYSQL_")) delete process.env[key];
}

const TEMPLATE_ID = "TEST_TEMPLATE_ID";
process.env.WECHAT_MINIPROGRAM_APP_ID = "test-appid";
process.env.WECHAT_MINIPROGRAM_APP_SECRET = "test-secret";
process.env.WECHAT_GRADE_RELEASE_TEMPLATE_ID = TEMPLATE_ID;

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

type SendResult = { errcode: number; errmsg?: string };

const calls = { token: 0, send: 0, session: 0 };
let sendResults: SendResult[] = [];
let tokenResult: SendResult | null = null;
let tokenTtlSeconds = 7200;
let tokenDelayMs = 0;
let sendIndex = 0;

/** 每个场景前重置，按调用顺序依次返回 sendResults 中的错误码。 */
function nextScenario(results: SendResult[]): void {
  sendResults = results;
  sendIndex = 0;
}

function installFetchStub(): void {
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes("/cgi-bin/token")) {
      calls.token++;
      if (tokenDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
      if (tokenResult) return jsonResponse({ errcode: tokenResult.errcode, errmsg: "stub" });
      return jsonResponse({ access_token: "stub-token", expires_in: tokenTtlSeconds });
    }
    if (url.includes("/message/subscribe/send")) {
      const result = sendResults[sendIndex++] ?? sendResults[sendResults.length - 1] ?? { errcode: 0 };
      calls.send++;
      return jsonResponse(result);
    }
    if (url.includes("/sns/jscode2session")) {
      calls.session++;
      return jsonResponse({ openid: "stub-openid", session_key: "stub" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function main(): Promise<void> {
  console.log(`使用临时数据库: ${process.env.PROJECTX_DB_PATH}`);

  const { initializeDatabase, getMysqlDb, detectDialect } = await import("../src/server/db/index");
  const { notifyGradeReleaseSubscribers } = await import("../src/server/services/gradeReleaseNotifications");

  initializeDatabase();
  const db = getMysqlDb();
  ok(detectDialect() === "sqlite", "冒烟测试运行在 SQLite 方言（未接触 MariaDB）");

  // ── 1. 建表与索引 ────────────────────────────────────
  section("v52 表结构");
  const indexes = await db.all<{ name: string; uniq: number; origin: string }>(
    "SELECT name, \"unique\" AS uniq, origin FROM pragma_index_list('wechat_subscription_bindings')",
  );
  const openidIdx = indexes.find((row) => row.name === "idx_wsb_openid");
  ok(Boolean(openidIdx), "idx_wsb_openid 存在");
  ok(openidIdx?.uniq === 0, "openid 索引为普通索引（不再限制一个 openid 只能绑一个学生）");
  ok(indexes.some((row) => row.origin === "u" && row.uniq === 1), "UNIQUE(student_id, template_id) 仍在");
  const claimCols = await db.all<{ name: string }>(
    "SELECT name FROM pragma_table_info('wechat_grade_release_notifications')",
  );
  ok(claimCols.some((c) => c.name === "exam_id"), "去重表 wechat_grade_release_notifications 已建");

  // ── 2. 绑定数据 ──────────────────────────────────────
  section("绑定关系");
  let studentA = 0;
  let studentB = 0;
  let studentC = 0;
  let examPublished = 0;
  let examEmpty = 0;
  let examUnpublished = 0;

  async function makeStudent(username: string, name: string): Promise<number> {
    const r = await db.run(
      "INSERT INTO users (username, password_hash, name, role_id, student_number) VALUES (?, 'x', ?, 3, ?)",
      username, name, `S${username}`,
    );
    return r.lastInsertRowid;
  }
  async function makeExam(name: string, scorePublished: number): Promise<number> {
    const r = await db.run(
      "INSERT INTO exams (name, subject, score_published) VALUES (?, '数学', ?)",
      name, scorePublished,
    );
    return r.lastInsertRowid;
  }
  /** 复刻 POST /grade-release 的写入语义 */
  async function bind(studentId: number, openid: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.run(
        "DELETE FROM wechat_subscription_bindings WHERE template_id = ? AND student_id = ?",
        TEMPLATE_ID, studentId,
      );
      await tx.run(
        `INSERT INTO wechat_subscription_bindings (student_id, openid, template_id, accepted_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        studentId, openid, TEMPLATE_ID,
      );
    });
  }

  studentA = await makeStudent("stu-a", "学生甲");
  studentB = await makeStudent("stu-b", "学生乙");
  studentC = await makeStudent("stu-c", "学生丙");
  examPublished = await makeExam("高一数学期中", 1);
  examEmpty = await makeExam("无人订阅场", 1);
  examUnpublished = await makeExam("未公布场", 0);

  await bind(studentA, "openid-shared");
  await bind(studentB, "openid-shared"); // 同一设备/家长绑两个学生
  ok((await db.all("SELECT 1 FROM wechat_subscription_bindings WHERE openid = 'openid-shared'")).length === 2,
    "同一 openid 可绑定两个学生");

  await bind(studentA, "openid-a-2"); // 重复订阅：换 openid
  const aRows = await db.all<{ openid: string }>(
    "SELECT openid FROM wechat_subscription_bindings WHERE student_id = ?", studentA,
  );
  ok(aRows.length === 1 && aRows[0].openid === "openid-a-2", "同一学生重复订阅只保留最新一条");
  await bind(studentA, "openid-shared");

  await db.run(
    "INSERT INTO student_scores (exam_id, student_id, total_score, assigned_score) VALUES (?, ?, 80, 90)",
    examPublished, studentA,
  );
  await db.run(
    "INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?, ?, 77)",
    examPublished, studentB,
  );
  await db.run(
    "INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?, ?, 66)",
    examEmpty, studentC,
  );
  const joined = await db.all<{ score: number }>(
    `SELECT COALESCE(ss.assigned_score, ss.total_score) AS score
       FROM student_scores ss
       JOIN wechat_subscription_bindings wsb ON wsb.student_id = ss.student_id AND wsb.template_id = ?
      WHERE ss.exam_id = ?`,
    TEMPLATE_ID, examPublished,
  );
  ok(joined.length === 2 && Number(joined[0].score) === 90, "收件人查询取赋分优先（90 而非 80）");

  // ── 3. 推送：失败不占用去重位 ─────────────────────────
  section("去重位释放策略");
  installFetchStub();

  // 冷缓存（此时进程内还没有 token）+ token 接口慢 30ms：
  // 复刻「批量公布多场考试同时取 token」——没有单飞就会各刷一次，微信会让先发的 token 失效
  tokenTtlSeconds = 0;
  tokenDelayMs = 30;
  const batchB = await makeExam("并发公布-乙", 1);
  const batchC = await makeExam("并发公布-丙", 1);
  await db.run("INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?, ?, 81)", batchB, studentA);
  await db.run("INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?, ?, 82)", batchC, studentB);
  nextScenario([{ errcode: 0 }, { errcode: 0 }]);
  await Promise.all([
    notifyGradeReleaseSubscribers(batchB),
    notifyGradeReleaseSubscribers(batchC),
  ]);
  ok(calls.token === 1, "两场考试并发推送只取一次 access_token（重复刷新会互相作废旧 token）");
  ok(
    (await db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM wechat_grade_release_notifications WHERE exam_id IN (?, ?)",
      batchB, batchC,
    ))?.c === 2,
    "并发的两场都完成推送并各自占用去重位",
  );
  tokenTtlSeconds = 7200;
  tokenDelayMs = 0;

  tokenResult = { errcode: 40013 }; // appsecret 错 / IP 未白名单一类的基建故障
  nextScenario([{ errcode: 0 }]);
  await notifyGradeReleaseSubscribers(examPublished);
  ok((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM wechat_grade_release_notifications WHERE exam_id = ?", examPublished))?.c === 0,
    "access_token 获取失败 → 释放去重位");

  tokenResult = null;
  nextScenario([{ errcode: 43101 }, { errcode: 43101 }]); // 两人都没订阅额度
  await notifyGradeReleaseSubscribers(examPublished);
  ok((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM wechat_grade_release_notifications WHERE exam_id = ?", examPublished))?.c === 0,
    "全员 43101（零送达）→ 释放去重位");

  nextScenario([{ errcode: 40003 }, { errcode: 0 }]); // 第一条 openid 失效，第二条成功
  const beforeSuccessSend = calls.send;
  const tokensBefore = calls.token;
  await notifyGradeReleaseSubscribers(examPublished);
  const doneRow = await db.get<{ status: string; success_count: number; failure_count: number }>(
    "SELECT status, success_count, failure_count FROM wechat_grade_release_notifications WHERE exam_id = ?",
    examPublished,
  );
  ok(calls.send - beforeSuccessSend === 2, "部分送达场次逐人发送");
  ok(doneRow?.status === "completed_with_errors" && doneRow.success_count === 1 && doneRow.failure_count === 1,
    "有 1 条送达即保留去重位，并记录成功/失败计数");

  const beforeDedup = calls.send;
  await notifyGradeReleaseSubscribers(examPublished);
  ok(calls.send === beforeDedup, "已通知场次再次发布不再重复推送");
  ok(calls.token === tokensBefore, "多条发送复用进程内 access_token 缓存");

  const beforeEmpty = calls.send;
  await notifyGradeReleaseSubscribers(examEmpty);
  ok((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM wechat_grade_release_notifications WHERE exam_id = ?", examEmpty))?.c === 0
    && calls.send === beforeEmpty, "无收件人 → 不占用去重位、不发送");

  await notifyGradeReleaseSubscribers(examUnpublished);
  ok((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM wechat_grade_release_notifications WHERE exam_id = ?", examUnpublished))?.c === 0,
    "考试非公布态 → 释放去重位");

  // ── 4. 崩溃遗留的 sending 行 ─────────────────────────
  section("僵尸认领行");
  await db.run(
    `INSERT INTO wechat_grade_release_notifications (exam_id, status, created_at)
     VALUES (?, 'sending', datetime('now', '-30 minutes'))`,
    examPublished,
  ).catch(async () => {
    await db.run(
      "UPDATE wechat_grade_release_notifications SET status='sending', created_at = datetime('now','-30 minutes') WHERE exam_id = ?",
      examPublished,
    );
  });
  nextScenario([{ errcode: 0 }]);
  const beforeStale = calls.send;
  await notifyGradeReleaseSubscribers(examPublished);
  ok(calls.send > beforeStale, "超时的 sending 行可被重新认领并推送");

  await db.run(
    "UPDATE wechat_grade_release_notifications SET created_at = datetime('now','-1 minute') WHERE exam_id = ?",
    examPublished,
  );
  const beforeFresh = calls.send;
  await notifyGradeReleaseSubscribers(examPublished);
  ok(calls.send === beforeFresh, "未超时的 sending 行不重复认领");

  console.log(
    `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}通过 ${passed} / 失败 ${failed}\x1b[0m`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
