/**
 * 答题卡导出版本绑定回归验证（安全审查第五批 C · R45 / F072）
 *
 * 缺陷回顾：答题卡是 1200ms 防抖自动保存的，而导出 PDF 是直接从库里当前值渲染的。
 * 老师点「导出」时手上那版可能还没落库，落库那版也可能已被随后一次防抖覆盖——
 * 打印出来的答题卡和阅卷用的坐标布局于是可能不是同一版，且没有任何提示。
 * 前端原先虽然传了 ?v=，但 /pdf 路由从来不读它；而且传的是 updatedAt，
 * 它由 CURRENT_TIMESTAMP 写入（秒级精度），同一秒内的两次保存取到同一个值，本来就当不了版本令牌。
 *
 * 本脚本验证四件事：
 *   1. 版本闸门 resolvePdfRevisionGate 是纯函数，边界取值（含旧客户端的 ISO 时间串）判定正确；
 *   2. revision 单调递增、跨方言存在且 NOT NULL DEFAULT 0，同一秒内多次保存也能区分；
 *   3. revision 只由落库自增决定，请求体里自带的版本号一律不采信（防伪造）；
 *   4. 迁移可重入，存量库升级后旧卡 revision 归 0；路由与前端确实按新口径接线。
 *
 * 用法：
 *   npx tsx scripts/verify-card-export-revision.ts
 *   # MariaDB（需先在 13306 临时实例上建好一次性空库）：
 *   PROJECTX_MARIADB_HOST=127.0.0.1 PROJECTX_MARIADB_PORT=13306 \
 *   PROJECTX_MARIADB_USER=projectx_ci PROJECTX_MARIADB_PASSWORD=px_ci_local_pw \
 *   PROJECTX_MARIADB_DATABASE=projectx_card_revision_test \
 *     npx tsx scripts/verify-card-export-revision.ts --mariadb
 *
 * 期望输出：所有断言通过，退出码 0。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const maria = process.argv.includes("--mariadb");
if (maria) {
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_card_revision_test", "MariaDB 模式需要一次性空库 projectx_card_revision_test");
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
} else {
  delete process.env.PROJECTX_MARIADB_HOST;
  delete process.env.PROJECTX_MYSQL_HOST;
  process.env.PROJECTX_DB_PATH = path.join(
    mkdtempSync(path.join(tmpdir(), "projectx-card-revision-")),
    "test.db"
  );
}

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

interface CountRow { n: number }

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

const { initializeDatabase, getDatabase, closeDatabase } = await import("../src/server/db/index");
const { getMysqlDb, initMariadbSchema, resetAdapter } = await import("../src/server/db/mysql");
const { resolvePdfRevisionGate, pdfRevisionInvalidMessage, pdfRevisionMismatchMessage } =
  await import("../src/apps/answer-card/server/cardRevision");
const { createDefaultCard } = await import("../src/shared/defaultCard");

if (!maria) initializeDatabase();
const db = getMysqlDb();
if (maria) {
  const tables = await db.get<CountRow>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()"
  );
  assert.equal(Number(tables?.n), 0, "MariaDB 模式请使用全新的一次性库");
  await initMariadbSchema();
}

const { CardRepository } = await import("../src/server/repositories/CardRepository");
const cardRepo = new CardRepository(db);
const count = async (sql: string, ...params: unknown[]): Promise<number> =>
  Number((await db.get<CountRow>(sql, ...params))?.n ?? 0);

// ── 1. 版本闸门是纯函数，边界取值判定正确 ───────────────────────
section("1. resolvePdfRevisionGate：省略放行、相等放行、不等拒绝、畸形拒绝");
ok(resolvePdfRevisionGate(7, undefined).decision === "render", "不带 ?v= 时放行（冒烟脚本/修复工具直接打 /pdf）");
const omitted = resolvePdfRevisionGate(7, undefined);
ok(omitted.decision === "render" && omitted.revision === 7, "放行时回带当前 revision（供 X-Card-Revision 使用）");
const matched = resolvePdfRevisionGate(7, "7");
ok(matched.decision === "render", "版本号相等时放行");
ok(matched.decision === "render" && matched.revision === 7, "相等放行时 revision 一致");
ok(resolvePdfRevisionGate(0, "0").decision === "render", "revision=0 与 v=0 相等放行（存量卡升级后的初值）");

const stale = resolvePdfRevisionGate(9, "8");
ok(stale.decision === "mismatch", "版本号落后时判定 mismatch");
ok(
  stale.decision === "mismatch" && stale.requested === 8 && stale.current === 9,
  `mismatch 同时带回请求值与当前值（${stale.decision === "mismatch" ? `${stale.requested}/${stale.current}` : "n/a"}）`
);
ok(resolvePdfRevisionGate(8, "9").decision === "mismatch", "版本号超前同样判定 mismatch（不是只挡旧版）");
ok(
  pdfRevisionMismatchMessage(8, 9).includes("v8") && pdfRevisionMismatchMessage(8, 9).includes("v9"),
  "mismatch 文案点明两个版本号，老师能自己看出差了几版"
);

// 旧客户端传的是 updatedAt（ISO 串）——必须拒，不能悄悄当成「没传」。
const legacyIso = resolvePdfRevisionGate(7, "2026-10-05T08:30:00.000Z");
ok(legacyIso.decision === "invalid", "旧客户端的 ISO 时间戳判为 invalid，而不是被静默忽略");
ok(
  legacyIso.decision === "invalid" && pdfRevisionInvalidMessage(legacyIso.raw).includes("2026-10-05"),
  "invalid 文案回显原值，便于定位是哪个调用方没升级"
);

const invalidInputs: Array<[unknown, string]> = [
  ["", "空串"],
  [" ", "纯空格"],
  ["1 ", "尾随空格"],
  ["+1", "正号"],
  ["-1", "负号"],
  ["1.0", "小数"],
  ["0.5", "小数（0.5）"],
  ["1e2", "科学计数法"],
  ["0x10", "十六进制"],
  ["007", "前导零"],
  ["00", "前导零（00）"],
  ["12345678901", "超过 10 位"],
  ["NaN", "NaN 字面量"],
  ["Infinity", "Infinity 字面量"],
  [null, "null"],
  [["7"], "单元素数组"],
  [["7", "7"], "重复参数（?v=7&v=7）：取哪个都是猜，判畸形"],
  [["7", "8"], "重复且互不相同的参数"],
  [{ toString: () => "7" }, "对象"]
];
let invalidHandled = 0;
for (const [input, label] of invalidInputs) {
  if (resolvePdfRevisionGate(7, input).decision === "invalid") invalidHandled += 1;
  else console.log(`      漏判：${label}`);
}
ok(invalidHandled === invalidInputs.length, `${invalidInputs.length} 种畸形取值全部判为 invalid（实际 ${invalidHandled}）`);
ok(
  resolvePdfRevisionGate(7, " 7 ").decision === "invalid",
  "不做 trim：' 7 ' 判为 invalid（Number() 会悄悄接受前后空白，闸门不接受）"
);
ok(
  resolvePdfRevisionGate(7, "x".repeat(400)).decision === "invalid"
  && (resolvePdfRevisionGate(7, "x".repeat(400)) as { raw: string }).raw.length <= 32,
  "超长畸形值判为 invalid，且回显被截断到 32 字以内（不放大错误响应）"
);
ok(
  resolvePdfRevisionGate(7, 7).decision === "invalid",
  "非字符串取值（数字）按畸形处理：Express 的 query 只会给字符串或数组，不做 String() 兜底"
);
ok(
  resolvePdfRevisionGate(7, { toString: () => "7" }).decision === "invalid",
  "toString() 返回 '7' 的对象不能冒充版本号（不做隐式字符串化）"
);

// ── 2. revision 跨方言存在、单调递增，同一秒内也能区分 ────────────
section("2. revision 列：跨方言存在、默认 0、每次保存 +1");
const columnRows = maria
  ? await db.all<{ column_name: string; is_nullable: string; column_default: string | null; data_type: string }>(
      `SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'answer_cards' AND column_name = 'revision'`
    )
  : await db.all<{ name: string; "notnull": number; dflt_value: string | null; type: string }>(
      "SELECT name, \"notnull\", dflt_value, type FROM pragma_table_info('answer_cards') WHERE name = 'revision'"
    );
ok(columnRows.length === 1, `answer_cards.revision 列存在（实际 ${columnRows.length} 行元数据）`);
const column = columnRows[0] as Record<string, unknown>;
const notNull = maria ? String(column.is_nullable).toUpperCase() === "NO" : Number(column["notnull"]) === 1;
ok(notNull, "revision 为 NOT NULL（不允许出现「没有版本」的卡）");
ok(
  String(column[maria ? "column_default" : "dflt_value"] ?? "").includes("0"),
  `默认值为 0（实际 ${column[maria ? "column_default" : "dflt_value"]}）`
);

const migrationRow = await db.get<{ version: number; name: string }>(
  "SELECT version, name FROM schema_migrations WHERE version = 59"
);
ok(migrationRow?.name === "answer-card-revision", `迁移 59 已记录（实际 ${migrationRow?.name ?? "缺失"}）`);

const cardId = "59000001";
const fresh = createDefaultCard(cardId);
await cardRepo.createCard(fresh);
ok(
  Number((await db.get<{ revision: number }>("SELECT revision FROM answer_cards WHERE id = ?", cardId))?.revision) === 0,
  "新建卡 revision 初值为 0"
);

await cardRepo.updateCard({ ...fresh, title: "第 1 次保存" });
const afterFirst = await cardRepo.findById(cardId);
ok(afterFirst?.revision === 1, `第 1 次保存后 findById 返回 revision=1（实际 ${afterFirst?.revision}）`);

const secondRevision = await cardRepo.updateCard({ ...fresh, title: "第 2 次保存" });
ok(secondRevision === 2, `updateCard 直接返回落库后的 revision=2（实际 ${secondRevision}）`);
ok((await cardRepo.findById(cardId))?.revision === 2, "findById 与返回值一致（前端两处读到的版本号不会分叉）");

// 秒级 updated_at 分不开同一秒内的多次保存——这是当初 ?v=updatedAt 当不了令牌的原因。
const BURST = 25;
const seenRevisions = new Set<number>();
const seenTimestamps = new Set<string>();
for (let i = 0; i < BURST; i++) {
  const revision = await cardRepo.updateCard({ ...fresh, title: `连发第 ${i} 次` });
  seenRevisions.add(revision);
  const row = await db.get<{ updated_at: string }>("SELECT updated_at FROM answer_cards WHERE id = ?", cardId);
  seenTimestamps.add(String(row?.updated_at ?? ""));
}
ok(seenRevisions.size === BURST, `${BURST} 次连续保存产生 ${BURST} 个不同 revision（实际 ${seenRevisions.size}）`);
ok(
  seenTimestamps.size < seenRevisions.size,
  `同批保存的 updated_at 只有 ${seenTimestamps.size} 个不同取值 < ${seenRevisions.size}，证明秒级时间戳当不了版本令牌`
);
const timestamps = [...seenTimestamps];
ok(
  timestamps.every((value) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)),
  `updated_at 不含毫秒位（${timestamps[0]}），同一秒内的保存必然撞值`
);
ok(
  (await cardRepo.findById(cardId))?.revision === 2 + BURST,
  `连发后 revision = ${2 + BURST}（实际 ${(await cardRepo.findById(cardId))?.revision}），自增不漏号`
);

// ── 3. 请求体自带的 revision 一律不采信 ─────────────────────────
section("3. 防伪造：调用方自带 revision 不能改写库里的版本号");
const beforeForge = (await cardRepo.findById(cardId))?.revision ?? 0;
const forged = await cardRepo.updateCard({ ...fresh, title: "伪造版本号", revision: beforeForge + 5000 });
ok(forged === beforeForge + 1, `伪造 revision=${beforeForge + 5000} 后仍按 +1 落库（实际 ${forged}）`);
ok(
  Number((await db.get<{ revision: number }>("SELECT revision FROM answer_cards WHERE id = ?", cardId))?.revision) === beforeForge + 1,
  "库里的 revision 也不是伪造值"
);
ok(
  await cardRepo.updateCard({ ...fresh, title: "伪造负数", revision: -1 }) === beforeForge + 2,
  "伪造负数同样被忽略，版本号继续单调递增"
);
ok(
  resolvePdfRevisionGate(beforeForge + 2, String(beforeForge + 5000)).decision === "mismatch",
  "伪造出来的版本号过不了闸门（拿不到与之匹配的 PDF）"
);

// 未落库的卡（不存在的 id）不会让自增语句报错，也不会凭空产生版本号。
ok(await cardRepo.updateCard({ ...fresh, id: "59999999" }) === 0, "更新不存在的卡返回 0（不抛错、不造版本号）");
ok((await count("SELECT COUNT(*) AS n FROM answer_cards WHERE id = '59999999'")) === 0, "更新不存在的卡不会插入新行");

// ── 4. 迁移可重入 + 存量库升级 ─────────────────────────────────
section("4. 迁移可重入，存量库升级后旧卡 revision 归 0");
const revisionBeforeRerun = (await cardRepo.findById(cardId))?.revision;
if (maria) {
  await initMariadbSchema();
} else {
  const { runMigrations } = await import("../src/server/db/migrations");
  runMigrations(getDatabase());
}
ok(
  (await cardRepo.findById(cardId))?.revision === revisionBeforeRerun,
  `重复初始化不改动已有 revision（${revisionBeforeRerun} → ${(await cardRepo.findById(cardId))?.revision}）`
);

// 模拟「升级前就存在的老库」：摘掉列与迁移记录，重跑迁移把列补回来。
await db.run("ALTER TABLE answer_cards DROP COLUMN revision");
await db.run("DELETE FROM schema_migrations WHERE version = 59");
if (maria) {
  await initMariadbSchema();
} else {
  const { runMigrations } = await import("../src/server/db/migrations");
  runMigrations(getDatabase());
}
ok(
  (await count(
    maria
      ? `SELECT COUNT(*) AS n FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'answer_cards' AND column_name = 'revision'`
      : "SELECT COUNT(*) AS n FROM pragma_table_info('answer_cards') WHERE name = 'revision'"
  )) === 1,
  "存量库升级后 revision 列被补回"
);
ok(
  Number((await db.get<{ revision: number }>("SELECT revision FROM answer_cards WHERE id = ?", cardId))?.revision) === 0,
  "存量卡的 revision 回填为 0（老卡升级后第一次导出仍能匹配，不会被闸门误拦）"
);
ok(
  (await cardRepo.findById(cardId))?.revision === 0,
  "findById 对回填值返回 0 而不是 undefined/NaN"
);
ok(await cardRepo.updateCard({ ...fresh, title: "升级后首次保存" }) === 1, "升级后首次保存 revision 从 0 递增到 1");

await db.run("DELETE FROM answer_cards WHERE id = ?", cardId);

// ── 5. 路由与前端接线（静态核对源码） ───────────────────────────
section("5. 接线核对：闸门在渲染之前、前端传 revision 而不是 updatedAt");
const serverSource = readSource("src/apps/answer-card/server/index.ts");
const pdfRoute = serverSource.slice(
  serverSource.indexOf('app.get("/api/cards/:cardId/pdf"'),
  serverSource.indexOf("// ── 答题卡导出/导入/删除")
);
ok(pdfRoute.length > 0 && pdfRoute.includes("createPdf(card)"), "定位到 /api/cards/:cardId/pdf 路由体");
const gateAt = pdfRoute.indexOf("resolvePdfRevisionGate(");
const renderAt = pdfRoute.indexOf("createPdf(card)");
ok(gateAt > 0, "路由里调用了 resolvePdfRevisionGate");
ok(gateAt < renderAt, `闸门在 createPdf 之前（${gateAt} < ${renderAt}）——先判定后渲染，不浪费一次 PDF 生成`);
ok(pdfRoute.includes('res.setHeader("X-Card-Revision"'), "路由设置 X-Card-Revision 响应头");
ok(
  pdfRoute.indexOf('res.setHeader("X-Card-Revision"') < gateAt,
  "X-Card-Revision 在闸门判定之前设置（409/400 时调用方也能拿到服务器当前版本）"
);
ok(pdfRoute.includes("409") && pdfRoute.includes("CARD_REVISION_MISMATCH"), "版本不一致回 409 + CARD_REVISION_MISMATCH");
ok(pdfRoute.includes("400") && pdfRoute.includes("CARD_REVISION_INVALID"), "版本号畸形回 400 + CARD_REVISION_INVALID");
ok(!pdfRoute.includes("updatedAt"), "路由不再用 updatedAt 当版本令牌");

const saveFn = serverSource.slice(
  serverSource.indexOf("async function saveCardWithLayout("),
  serverSource.indexOf("async function prepareLayoutForCard(")
);
ok(saveFn.includes("return { ...normalized, revision }"), "saveCardWithLayout 返回落库后的 revision，而不是请求体里的那个");
ok(saveFn.includes("revision = await cardRepo.updateCard("), "revision 取自 updateCard 的返回值");

const clientSource = readSource("src/apps/answer-card/client/App.tsx");
ok(!clientSource.includes("/pdf?v=${encodeURIComponent(savedCard.updatedAt)}"), "前端不再把 updatedAt 当版本令牌");
ok(clientSource.includes("?v=${revision}"), "前端改用 revision 作为 ?v= 的值");
ok(clientSource.includes("settleCardForExport"), "导出前有界收敛待存改动");
ok(clientSource.includes("EXPORT_SETTLE_ATTEMPTS"), "收敛次数是有界常量（不会在用户连续敲键时无限重试）");
ok(
  /localRevision !== serverRevision/.test(clientSource),
  "导出前先 GET 一次卡比对 revision（PDF 在新标签页打开，409 客户端接不到）"
);

const repositorySource = readSource("src/server/repositories/CardRepository.ts");
ok(repositorySource.includes("revision = revision + 1"), "自增在 SQL 里完成（不读改写，避免并发丢号）");
ok(repositorySource.includes("revision: Number(cardRow.revision ?? 0)"), "findById 映射 revision");
ok(
  readSource("src/shared/types.ts").includes("revision?: number"),
  "AnswerCard 类型声明了 revision"
);
for (const [file, needle] of [
  ["src/server/db/schema.sql", "revision         INTEGER NOT NULL DEFAULT 0"],
  ["src/server/db/schema.mariadb.sql", "revision         INT NOT NULL DEFAULT 0"],
  ["src/server/db/schema.mysql.sql", "revision         INT NOT NULL DEFAULT 0"]
] as const) {
  ok(readSource(file).includes(needle), `${file} 新建库语句含 revision 列`);
}
ok(readSource("src/server/db/migrations.ts").includes('version: 59, name: "answer-card-revision"'), "SQLite 迁移 59 已登记");
ok(readSource("src/server/db/mysql.ts").includes('version: 59, name: "answer-card-revision"'), "MariaDB 迁移 59 已登记");

// 两个不带 ?v= 的内部调用方必须继续可用——闸门放行「省略」正是为它们留的口子。
ok(
  !readSource("scripts/deployment-business-smoke.ts").includes("/pdf?v="),
  "部署冒烟脚本仍不带 ?v=（省略即放行，不会被闸门拦住）"
);
ok(
  !readSource("tools/repair-benchmark/run.mjs").includes("/pdf?v="),
  "修复基准工具仍不带 ?v="
);

const packageJson = JSON.parse(readSource("package.json")) as { scripts: Record<string, string> };
ok(
  packageJson.scripts["verify:card-export-revision"]?.includes("verify-card-export-revision.ts"),
  "package.json 已挂 verify:card-export-revision"
);
ok(
  readSource(".github/workflows/ci.yml").includes("verify:card-export-revision"),
  "CI 会跑本脚本"
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
