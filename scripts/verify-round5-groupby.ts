/**
 * 五轮测试 A2 回归：AnalysisRepository 三处 GROUP BY 重写后行为等价
 * （getExamFullScoreMap 满分归并 / getStudentRanking 排名 / getStudentTrend 趋势）。
 * 用法：npx tsx scripts/verify-round5-groupby.ts（期望全绿，退出码 0）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-round5-groupby-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "round5.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

import { getMysqlDb } from "../src/server/db";
import { AnalysisRepository } from "../src/server/repositories/AnalysisRepository";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

async function main(): Promise<void> {
  const db = getMysqlDb();
  // 最小数据：1 场考试、2 学生、3 个 (题, 题型) 组（其中 q1 objective 两行取 MAX）
  await db.exec(`
    CREATE TABLE exams (id INTEGER PRIMARY KEY, name TEXT, subject TEXT, status TEXT, start_time TEXT, end_time TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, student_number TEXT);
    CREATE TABLE student_scores (exam_id INTEGER, student_id INTEGER, total_score REAL, objective_score REAL, subjective_score REAL, rank INTEGER, percentile REAL);
    CREATE TABLE question_scores (exam_id INTEGER, student_id INTEGER, question_number INTEGER, score REAL, max_score REAL, score_type TEXT);
    CREATE TABLE class_students (class_id INTEGER, student_id INTEGER);
  `);
  await db.run("INSERT INTO exams (id, name, subject, status) VALUES (1, '数学测验', '数学', 'closed')");
  await db.run("INSERT INTO users (id, name, student_number) VALUES (1, '张三', '1001'), (2, '李四', '1002')");
  await db.run("INSERT INTO student_scores (exam_id, student_id, total_score, objective_score, subjective_score) VALUES (1, 1, 92, 40, 52), (1, 2, 78, 36, 42)");
  // q1 objective 两行（MAX(max_score) 应取 100）；组 = (1,1,objective)/(1,1,subjective)/(1,2,subjective)
  await db.run("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type) VALUES"
    + " (1, 1, 1, 90, 100, 'objective'), (1, 1, 1, 85, 100, 'objective'), (1, 1, 1, 60, 100, 'subjective')"
    + ", (1, 2, 1, 70, 100, 'objective'), (1, 2, 2, 80, 100, 'subjective')");

  const repo = new AnalysisRepository();

  section("getExamFullScoreMap — 嵌套聚合等价（每题组取 MAX 后按考试求和）");
  const fsMap = await repo.getExamFullScoreMap([1]);
  ok(fsMap.get(1) === 300, `3 个 (题,题型) 组各 100 → 满分 300 (实际 ${fsMap.get(1)})`);
  ok(fsMap.size === 1, "仅 1 场考试有满分");

  section("getExamFullScoreMap — 空数组不进 SQL（无 IN() 语法风险）");
  const emptyMap = await repo.getExamFullScoreMap([]);
  ok(emptyMap.size === 0, "空 examIds 返回空 Map 且不抛错");

  section("getStudentRanking — 排名与低分题计数");
  const ranking = await repo.getStudentRanking(1);
  ok(ranking.length === 2, `返回 2 名学生 (${ranking.length})`);
  ok(ranking[0].studentNumber === "1001" && ranking[0].rank === 1, "张三总分 92 排第 1");
  ok(ranking.every((r) => r.lowScoreCount === 0), "无低分题（默认阈值 0.5，分数均 ≥ 50）");

  section("getStudentTrend — 单场趋势 + 年级均分");
  const trend = await repo.getStudentTrend(1);
  ok(trend.length === 1 && trend[0].totalScore === 92, "单场趋势返回 (91?) 实际 " + (trend[0]?.totalScore ?? "empty"));
  ok(trend[0].gradeAvg === 85, `年级均分 (92+78)/2=85 (实际 ${trend[0].gradeAvg})`);
  ok(trend[0].classSize === 2, `参加人数 2 (实际 ${trend[0].classSize})`);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });