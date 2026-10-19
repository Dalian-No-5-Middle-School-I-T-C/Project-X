/** Disposable Linux API fixture; --serve also supports a Windows VM client. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

export async function startScannerFlowFixture(port = 0, host = "127.0.0.1", options: { duplex?: boolean; localScanner?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "projectx-scanner-flow-"));
  process.env.PROJECTX_DB_PATH = path.join(root, "scanner.db");
  process.env.ANSWER_CARD_DATA_DIR = path.join(root, "cards");
  process.env.PROJECTX_TOKEN_DIR = path.join(root, "tokens");
  process.env.PROJECTX_AUTH_ENFORCE = "1";
  await mkdir(process.env.ANSWER_CARD_DATA_DIR, { recursive: true });
  process.chdir(root);
  if (process.env.SCANNER_BATCH_MARIADB === "1") {
    assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
    assert.match(process.env.PROJECTX_MARIADB_DATABASE ?? "", /^projectx_scanner_batch_[a-z0-9_]+$/);
  } else {
    for (const name of Object.keys(process.env)) if (/^PROJECTX_(MARIADB|MYSQL)_/.test(name)) delete process.env[name];
  }
  const { initializeDatabase, getMysqlDb, closeDatabase, initMariadbSchema } = await import("../src/server/db");
  const { resetAdapter } = await import("../src/server/db/mysql");
  initializeDatabase();
  const db = getMysqlDb();
  if (process.env.SCANNER_BATCH_MARIADB === "1") {
    assert.equal((await db.all("SHOW TABLES")).length, 0, "Fixture requires an empty disposable database");
    await initMariadbSchema();
  }
  const { createDefaultCard } = await import("../src/shared/defaultCard");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const { cardFingerprint } = await import("../src/shared/cardVersion");
  const card = createDefaultCard("91514001");
  card.bodyBlocks = [{ id: "flow_q", type: "objective", title: "选择题", questionStart: 1, questionCount: 1,
    optionCount: 4, mode: "single", scorePerQuestion: 5, answerKey: { "1": ["A"] }, density: "normal" }];
  if (options.duplex) {
    card.sided = "double";
    const { buildLayout } = await import("../src/shared/layout");
    for (let count = 10; count <= 400 && buildLayout(card).pages.length < 2; count += 10) card.bodyBlocks[0].questionCount = count;
    assert.equal(buildLayout(card).pages.length, 2, "Duplex fixture must have two layout pages");
  }
  await new CardRepository().createCard(card);
  await new CardRepository().updateCard(card);
  const version = cardFingerprint((await new CardRepository().findById(card.id))!);
  const exam = await db.run("INSERT INTO exams (name,card_id,status) VALUES (?,?,'grading')", "上传异常流程模拟", card.id);
  for (let i = 1; i <= 10; i++) {
    const number = `910${String(i).padStart(2, "0")}`;
    const user = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,3,?)", `flow_${number}`, "test-only", number, number);
    await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, user.lastInsertRowid);
  }
  const key = "isolated-scanner-flow-only";
  const { hashSecret } = await import("../src/server/lib/field-crypto");
  await db.run("INSERT INTO api_keys (name,api_key,scope,is_active) VALUES (?,?,?,1)", "flow-test", hashSecret(key), "scanner");
  const { default: sharp } = await import("sharp");
  const images: Record<string, string> = {};
  for (const [index, name] of ["original", "different", "normal", "blank", "replacement", "unknown", "after", "discard"].entries()) {
    images[name] = (await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: index * 25, g: 120, b: 200 } } }).png().toBuffer()).toString("base64");
  }
  images.unreadable = Buffer.from("not-a-readable-scan").toString("base64");
  const { default: express } = await import("express");
  const { default: router } = await import("../src/server/routes/scanner-upload");
  const app = express();
  // This server exists only in a disposable verification environment.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, Authorization");
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });
  app.use(express.json());
  app.get("/test/fixture", (_req, res) => res.json({ cardId: card.id, version, key, images, dialect: db.dialect }));
  app.get("/api/app/health", (_req, res) => res.json({ ok: true, capabilities: { scannerClientApi: true, scanner: false } }));
  app.get("/test/state", async (req, res) => {
    if (req.headers["x-api-key"] !== key) { res.sendStatus(401); return; }
    res.json({ scores: await db.all("SELECT u.student_number,ss.total_score FROM student_scores ss JOIN users u ON u.id=ss.student_id WHERE ss.exam_id=?", exam.lastInsertRowid),
      receipts: await db.all("SELECT session_id,group_id,student_number,state FROM scanner_submissions WHERE exam_id=?", exam.lastInsertRowid) });
  });
  app.use("/api/scanner/upload", router);
  if (options.localScanner) {
    const { authMiddleware } = await import("../src/server/middleware/auth");
    const { createScannerRouter } = await import("../src/apps/answer-card/server/scanner");
    app.use("/api/scanner", authMiddleware, createScannerRouter(false));
  }
  app.use((error: Error, _req: unknown, res: import("express").Response, _next: unknown) => res.status(409).json({ message: error.message }));
  const server = app.listen(port, host);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    resetAdapter(); closeDatabase();
  } };
}

if (process.argv.includes("--serve")) {
  const fixture = await startScannerFlowFixture(Number(process.env.SCANNER_RECOVERY_PORT ?? 5179), "0.0.0.0");
  console.log(`SCANNER_FLOW_READY ${fixture.baseUrl}`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void fixture.close().then(() => process.exit(0)); });
}
