/**
 * 冒烟：演示数据导入后，周报 getSummary 完整链路（active 汇总 / vsLastWeek / weakPoints）。
 * 临时隔离 SQLite 库，不碰真实数据。运行：npx tsx scripts/weekly-demo-smoke.ts
 *
 * 注：周报发布语义 = 每周六 08:00。导入时刻若未到本周六，默认选中的「本周」无报告属正常；
 * 本脚本显式验证「上周」「上上周」两份已发布报告与较上周对比。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-weekly-demo-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "smoke.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

const { initializeDatabase, ensureDefaultAdmin } = await import("../src/server/db/index");
const { seedDemoData } = await import("../src/server/services/DemoDataService");
const { WeeklyAuditService } = await import("../src/server/services/WeeklyAuditService");

initializeDatabase();
await ensureDefaultAdmin();
await seedDemoData();

const svc = new WeeklyAuditService();
const res = await svc.getSummary(undefined, undefined, new Date());

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("== 周报选项（近 5 周） ==");
for (const w of res.weeks) {
  console.log(`  ${w.label} ${w.rangeLabel} published=${w.published} pending=[${w.pendingExamNames.join(",")}]`);
}
const publishedWeeks = res.weeks.filter((w) => w.published).length;
ok(publishedWeeks >= 2, `近 5 周内 ≥2 周已发布（实际 ${publishedWeeks}）`);

const prev1 = res.weeks.find((w) => w.label.endsWith("第33周")) ?? res.weeks[1];
const prev2 = res.weeks.find((w) => w.label.endsWith("第32周")) ?? res.weeks[2];

const r1 = await svc.getSummary(prev1.weekStart, undefined, new Date());
ok(Boolean(r1.active), `上周（${prev1.label}）报告存在`);
const a = r1.active;
if (a) {
  ok(a.examCount === 5, `上周晨测场次 = 5（实际 ${a.examCount}）`);
  ok(a.coverageDays === 5, `覆盖 5 个工作日（实际 ${a.coverageDays}）`);
  ok(a.participantCount === 16, `参评 16 人（实际 ${a.participantCount}）`);
  ok(a.classSummaries.length === 2, `2 个班级对比（实际 ${a.classSummaries.length}）`);
  ok(a.weakPoints.length > 0, `薄弱题 Top5 非空（实际 ${a.weakPoints.length}）`);
  console.log("  薄弱题样例:", a.weakPoints.slice(0, 3).map((p) => `${p.subject}#${p.questionNumber} ${p.scoreRate}% ${p.knowledgePoint ?? ""}`).join(" | "));
  ok(a.vsLastWeek !== null, `较上周对比存在（avgScoreRateChange=${a.vsLastWeek?.avgScoreRateChange ?? "null"}）`);
  if (a.vsLastWeek) ok(a.vsLastWeek.avgScoreRateChange < 0, `较上周得分率下降（${a.vsLastWeek.avgScoreRateChange}%）`);
}

const r2 = await svc.getSummary(prev2.weekStart, undefined, new Date());
ok(Boolean(r2.active), `上上周（${prev2.label}）报告存在`);
if (r2.active) ok(r2.active.examCount === 3, `上上周晨测场次 = 3（实际 ${r2.active.examCount}）`);

console.log(`\n结果：${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
