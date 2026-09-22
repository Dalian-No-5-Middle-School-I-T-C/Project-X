/** Isolated SQLite / MariaDB regressions for PR 285 review findings. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createDefaultCard } from "../src/shared/defaultCard";
import { validateCardScores } from "../src/shared/cardScoreValidation";

const temp = await mkdtemp(path.join(tmpdir(), "projectx-review-285-"));
process.chdir(temp);
process.env.PROJECTX_DB_PATH = path.join(temp, "test.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(temp, "data");
process.env.PROJECTX_AUTH_ENFORCE = "0";
if (process.env.REVIEW_285_MARIADB === "1") {
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_review_285");
} else {
  for (const key of Object.keys(process.env)) if (/^PROJECTX_(MYSQL|MARIADB)_/.test(key)) delete process.env[key];
}
const { initializeDatabase, closeDatabase } = await import("../src/server/db");
const { getMysqlDb, initMariadbSchema, resetAdapter } = await import("../src/server/db/mysql");
if (process.env.REVIEW_285_MARIADB === "1") {
  assert.equal((await getMysqlDb().all("SHOW TABLES")).length, 0, "Disposable database must be empty");
  await initMariadbSchema();
} else initializeDatabase();
const db = getMysqlDb();
const { CardRepository } = await import("../src/server/repositories/CardRepository");
const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");
const { analysisCache } = await import("../src/server/services/analysisCache");
const cards = new CardRepository();
const analysis = new AnalysisRepository();
const { default: analysisRouter } = await import("../src/apps/answer-card/server/routes/analysis");
const { default: groupRouter } = await import("../src/server/routes/exam-groups-analysis");
const { setAuthEnforced } = await import("../src/apps/answer-card/server/middleware");
const app = express();
app.use("/analysis", analysisRouter);
app.use("/groups/:groupId", groupRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  const card = createDefaultCard("review285");
  card.bodyBlocks = [{ id: "review285_obj", type: "objective", title: "选择", questionStart: 1, questionCount: 2,
    optionCount: 4, mode: "single", scorePerQuestion: 10, density: "normal",
    questions: [{ questionNumber: 1, score: 10 }, { questionNumber: 2, score: 20 }] }];
  await cards.createCard(card);
  await cards.updateCard(card);
  const exam = (await db.run("INSERT INTO exams (name,card_id,status) VALUES (?,?,'closed')", "one", card.id)).lastInsertRowid;
  const second = (await db.run("INSERT INTO exams (name,card_id) VALUES (?,?)", "two", card.id)).lastInsertRowid;
  const student = (await db.run("INSERT INTO users (username,password_hash,name,role_id) VALUES ('review285','unused','test',3)")).lastInsertRowid;
  await db.run("INSERT INTO student_scores (exam_id,student_id,objective_score,subjective_score,total_score) VALUES (?,?,20,0,20)", exam, student);
  assert.equal((await analysis.getExamOverview(exam)).fullScore, 30);
  assert.equal((await analysis.getExamOverview(exam)).passRate, 100);
  assert.equal((await analysis.getExamOverview(second)).fullScore, 30);
  analysisCache.set(`overview:${exam}:123`, { fullScore: 30 });
  analysisCache.set("overview:999999:all", "unrelated");
  card.bodyBlocks[0].questions![1].score = 40;
  await cards.updateCard(card);
  assert.equal(analysisCache.get(`overview:${exam}:123`), undefined);
  assert.equal(analysisCache.get("overview:999999:all"), "unrelated");
  assert.equal((await analysis.getExamOverview(exam)).fullScore, 50);
  assert.equal((await analysis.getExamOverview(exam)).passRate, 0);
  assert.equal((await analysis.getExamOverview(second)).fullScore, 50);
  assert.equal((await analysis.getExamFullScoreMap([exam, second])).get(exam), 50);

  const ids = [card.id];
  for (let i = 0; i < 12; i++) {
    const c = createDefaultCard(`batch${i}`);
    c.bodyBlocks = [
      { id: `o${i}`, type: "objective", title: "legacy", questionStart: 1, questionCount: 3, optionCount: 4, mode: "single", scorePerQuestion: 2.25, density: "normal" },
      { id: `s${i}`, type: "subjective", title: "填空题", blockKind: "fill_blank", questions: [
        { id: `q${i}a`, number: 4, score: 99, kind: "blank", style: "blank", minHeightMm: 10 },
        { id: `q${i}b`, number: 5, score: 12.5, kind: "blank", style: "manual_score_grid", minHeightMm: 10 },
      ] },
      { id: `a${i}`, type: "subjective", title: "解答题", blockKind: "answer", questions: [
        { id: `a${i}q`, number: 6, score: 8.75, kind: "answer", style: "blank", minHeightMm: 10 },
      ] },
    ];
    await cards.createCard(c); await cards.updateCard(c); ids.push(c.id);
    if (i % 2 === 0) await db.run("DELETE FROM objective_questions WHERE block_id = ?", `o${i}`);
    if (i % 3 === 0) await db.run("UPDATE subjective_blocks SET block_kind = NULL WHERE id = ?", `s${i}`);
  }
  const empty = createDefaultCard("empty285"); await cards.createCard(empty); ids.push(empty.id);
  const expected = new Map<string, number>();
  for (const id of ids) expected.set(id, validateCardScores((await cards.findById(id))!).totalScore);
  const queries: string[] = [];
  const counted = new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === "all" || key === "get") return (sql: string, ...args: unknown[]) => { queries.push(sql); return value.call(target, sql, ...args); };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const batchCards = new CardRepository(counted);
  assert.deepEqual(await batchCards.getFullScoreMap([]), new Map());
  assert.equal(queries.length, 0);
  assert.deepEqual(await batchCards.getFullScoreMap([...ids, card.id, "missing"]), expected);
  assert.equal(queries.length, 5, "Many cards use five queries, not N+1");
  assert(!queries.some(sql => /images|answer_keys|scoring_rule_json/.test(sql)));

  const paths = [`/analysis/exams/${exam}/ai-analysis`];
  for (const route of paths) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { job: null });
  }
  assert.equal((await fetch(base + "/groups/1/ai-analysis")).status, 403, "Group access already rejects anonymous users");
  setAuthEnforced(true);
  process.env.PROJECTX_AUTH_ENFORCE = "1";
  for (const route of paths) assert.equal((await fetch(base + route)).status, 401, "Enforced authentication remains required");
  console.log(`PASS review-285 (${db.dialect}): cache invalidation, score parity, bounded queries, anonymous restore and auth enforcement`);
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  resetAdapter(); closeDatabase();
}
