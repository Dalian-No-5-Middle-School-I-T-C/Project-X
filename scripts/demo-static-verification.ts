/**
 * 校验 public/demo/demo-data.json 与 demo-dataset 一致，并验证百分位公式 A + 跨班对比数据。
 * 运行：npx tsx scripts/demo-static-verification.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStaticDemoPayload } from "../testdata/demo-exams/demo-dataset.ts";
import { rankPercentile } from "../src/server/services/rankingUpdate.ts";
import { competitionRank } from "../src/shared/ranking.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = path.join(__dirname, "..", "public", "demo", "demo-data.json");
const appJsPath = path.join(__dirname, "..", "public", "demo", "app.js");

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed++;
}

const expected = buildStaticDemoPayload();
const onDisk = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as typeof expected;
const appJs = fs.readFileSync(appJsPath, "utf8");

check("student count", onDisk.students.length === expected.students.length);
check("exam count", onDisk.exams.length === expected.exams.length);
check("test scenario count", onDisk.testScenarios.length === expected.testScenarios.length);
check("version bumped", onDisk.version === "1.1.0");
check("offline demo account documented", !!(onDisk.accounts as any).offlineDemo);

const math = onDisk.exams.find((e) => e.name === "演示-数学");
if (!math) throw new Error("missing 演示-数学 exam");

const present = Object.entries(math.scores)
  .map(([studentNo, score]) => ({ studentNo, score }))
  .sort((a, b) => b.score - a.score);
const ranks = new Map<string, number>();
competitionRank(
  present,
  (r) => r.score,
  (r, rank) => ranks.set(r.studentNo, rank)
);
const n = present.length;
const tie128 = present.filter((r) => r.score === 128);
check("4 students tie at 128", tie128.length === 4);
for (const row of tie128) {
  check(`tie rank for ${row.studentNo}`, ranks.get(row.studentNo) === 6);
  check(
    `percentile for ${row.studentNo}`,
    rankPercentile(6, n) === rankPercentile(ranks.get(row.studentNo)!, n)
  );
}
check("last place percentile is 0", rankPercentile(n, n) === 0);
check("first place percentile is 100", rankPercentile(1, n) === 100);

// 跨班深度对比数据
const kp = (onDisk as any).knowledgePoints?.["88000002"];
check("math knowledge points present", Array.isArray(kp) && kp.length === 3);
check(
  "class-compare scenario listed",
  onDisk.testScenarios.some((s) => s.id === "class-compare")
);
check("demo app has classCompare nav", appJs.includes('id: "classCompare"'));
check("demo app has renderClassCompare", appJs.includes("function renderClassCompare"));
check("exam group uses competition tieSize", appJs.includes("tieSizeMap.get(r.studentNo)"));
check("questions pad missing cells", appJs.includes("p ? `${p.score}/${p.max}` : \"—\"") || appJs.includes("p ? `${p.score}/${p.max}` : \"—\""));

// 两班均有成绩，且 1 班均分应高于 2 班（演示数据设计）
const class1 = onDisk.students.filter((s) => s.className === "演示1班");
const class2 = onDisk.students.filter((s) => s.className === "演示2班");
const avg = (list: typeof class1) => {
  const scores = list.map((s) => math.scores[s.studentNo]).filter((v) => v != null) as number[];
  return scores.reduce((a, b) => a + b, 0) / scores.length;
};
check("two classes of 8", class1.length === 8 && class2.length === 8);
check("class1 math avg > class2", avg(class1) > avg(class2));

console.log(`demo-static-verification: ${passed} checks passed`);
