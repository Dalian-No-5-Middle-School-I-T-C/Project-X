/**
 * 集成测试：在真实临时 SQLite 上验证 recomputeExamRankings 数据路径。
 * 断言：同分并列使用 competitionRank（1,1,3,4），百分位使用公式 A（末名 0）。
 * 运行：npx tsx scripts/ranking-integration-check.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-rank-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "rank.db");
for (const k of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST"
]) delete process.env[k];

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const { initializeDatabase, getDatabase, getMysqlDb, closeDatabase } = await import("../src/server/db");
  const { recomputeExamRankings } = await import("../src/server/services/rankingUpdate");

  initializeDatabase();
  const sqlite = getDatabase();

  // 满足外键：先建答题卡与学生用户
  sqlite.prepare("INSERT INTO answer_cards (id, title) VALUES ('99999999', '排名测试卷')").run();
  const insUser = sqlite.prepare(
    "INSERT INTO users (id, username, password_hash, name, role_id, student_number) VALUES (?,?,'','',3,?)"
  );
  for (const sid of [9001, 9002, 9003, 9004]) insUser.run(sid, `u${sid}`, String(sid));

  const examId = Number(
    (sqlite.prepare(
      "INSERT INTO exams (name, card_id, subject, status) VALUES ('并列排名测试', '99999999', '数学', 'closed')"
    ).run() as { lastInsertRowid: number | bigint }).lastInsertRowid
  );

  // 四名学生，分数 90/90/80/70，前两名并列（写入时已 roundScore，故为干净的相等值）。
  const seed = [
    { sid: 9001, total: 90 },
    { sid: 9002, total: 90 },
    { sid: 9003, total: 80 },
    { sid: 9004, total: 70 }
  ];
  const ins = sqlite.prepare(
    "INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,0,0,?)"
  );
  for (const s of seed) ins.run(examId, s.sid, s.total);

  const db = getMysqlDb();
  await recomputeExamRankings(db, examId);

  const rows = sqlite.prepare(
    "SELECT student_id, `rank` AS rank, percentile FROM student_scores WHERE exam_id = ? ORDER BY total_score DESC, student_id ASC"
  ).all(examId) as Array<{ student_id: number; rank: number; percentile: number }>;

  const rankByStudent = new Map(rows.map((r) => [r.student_id, r.rank]));
  const pctByStudent = new Map(rows.map((r) => [r.student_id, r.percentile]));

  check("9001 与 9002 同分并列名次 1", rankByStudent.get(9001) === 1 && rankByStudent.get(9002) === 1,
    `got ${rankByStudent.get(9001)} / ${rankByStudent.get(9002)}`);
  check("并列后名次跳到 3（competition ranking）", rankByStudent.get(9003) === 3,
    `got ${rankByStudent.get(9003)}`);
  check("末名名次 4", rankByStudent.get(9004) === 4, `got ${rankByStudent.get(9004)}`);
  check("第一名百分位 100（公式 A）", pctByStudent.get(9001) === 100, `got ${pctByStudent.get(9001)}`);
  check("末名百分位 0（公式 A）", pctByStudent.get(9004) === 0, `got ${pctByStudent.get(9004)}`);

  closeDatabase?.();
  rmSync(tmpDir, { recursive: true, force: true });

  if (failed > 0) {
    console.error(`\nranking-integration-check FAILED (${failed})`);
    process.exit(1);
  }
  console.log("\nranking-integration-check ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
