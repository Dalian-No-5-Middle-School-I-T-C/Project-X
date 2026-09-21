/** DOCX analysis routing and upload authorization checks against real HTTP routes. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";
import AdmZip from "adm-zip";

const temp = await mkdtemp(path.join(tmpdir(), "projectx-deployment-regression-"));
process.env.PROJECTX_DB_PATH = path.join(temp, "test.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(temp, "cards-data");
process.env.LLMCLIENT_AUTOSTART = "false";
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function docx(text: string): Buffer {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile("_rels/.rels", Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile("word/document.xml", Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  return zip.toBuffer();
}

const captured: Array<{ mode: string; paperText?: string; files?: unknown[] }> = [];
const llm = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  captured.push(JSON.parse(raw));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ knowledgePoints: [{ questionNumber: 1, points: ["测试知识点"] }] }));
});
process.env.LLMCLIENT_URL = await listen(llm);
const { initializeDatabase, closeDatabase } = await import("../src/server/db/index");
const { getMysqlDb } = await import("../src/server/db/mysql");
const { paperDir } = await import("../src/apps/answer-card/server/storage");
const { paperRoutes } = await import("../src/apps/answer-card/server/routes/paper-routes");
const { default: uploadRoutes } = await import("../src/server/routes/scanner-upload");
const { hashSecret } = await import("../src/server/lib/field-crypto");
await initializeDatabase();
const db = getMysqlDb();
await db.run("INSERT INTO users (id, username, password_hash, name, role_id) VALUES (1, 'regression', 'unused', '回归测试', 1)");
await db.run("INSERT INTO ai_providers (user_id, name, provider_type, base_url, api_key, models, is_system, is_active) VALUES (1, 'fixture', 'openai', 'http://127.0.0.1', '', '[\"gpt-4o\"]', 1, 1)");
const app = express();
app.use(express.json());
app.use(paperRoutes());
app.use("/api/scanner/upload", uploadRoutes);
const server = createServer(app);
const base = await listen(server);
try {
  for (const card of ["docx", "empty", "missing", "image"]) {
    await db.run("INSERT INTO answer_cards (id, title) VALUES (?, ?)", card, card);
    await mkdir(paperDir(card), { recursive: true });
  }
  await writeFile(path.join(paperDir("docx"), "original.docx"), docx("第一份数学原卷：二加三等于多少？"));
  await writeFile(path.join(paperDir("docx"), "original-2.docx"), docx("第二份数学原卷：一次函数的斜率。"));
  await writeFile(path.join(paperDir("docx"), "original-10.docx"), docx("第十份数学原卷：圆的面积。"));
  await writeFile(path.join(paperDir("empty"), "original.docx"), docx(""));
  await writeFile(path.join(paperDir("image"), "original.png"), Buffer.from("fixture-image"));
  const analyze = (card: string) => fetch(`${base}/api/cards/${card}/knowledge-points/analyze`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionRange: "全部" }),
  });
  const result = await analyze("docx");
  const resultBody = await result.json();
  assert.equal(result.status, 200, JSON.stringify(resultBody));
  assert.deepEqual(resultBody.knowledgePoints, [{ questionNumber: 1, points: ["测试知识点"] }]);
  assert.equal(captured[0].mode, "text");
  assert.match(captured[0].paperText!, /第一份[\s\S]*第二份[\s\S]*第十份/);
  assert.equal((await analyze("empty")).status, 400);
  const missing = await analyze("missing");
  assert.equal((await missing.json()).error, "NO_FILES");
  assert.equal((await analyze("image")).status, 200);
  assert.equal(captured[1].mode, "direct");
  assert.equal(captured[1].files?.length, 1);
  console.log("PASS: multi-DOCX text, numeric page order, empty/missing input, image direct mode");

  for (const [key, scope, active] of [["valid", "scanner", 1], ["disabled", "scanner", 0], ["wrong-scope", "other", 1]] as const) {
    await db.run("INSERT INTO api_keys (name, api_key, scope, is_active) VALUES (?, ?, ?, ?)", key, hashSecret(key), scope, active);
  }
  for (const [key, status] of [["valid", 200], ["disabled", 403], ["wrong-scope", 403], ["bad", 401], ["", 401]] as const) {
    const response = await fetch(`${base}/api/scanner/upload/check`, { headers: key ? { "X-Api-Key": key } : {} });
    assert.equal(response.status, status, `key case ${key}`);
  }
  assert.equal((await db.get<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM twain_scan_sessions"))?.cnt, 0);
  console.log("PASS: upload check validates key, scope, activation without creating sessions");
} finally {
  await close(server);
  await close(llm);
  closeDatabase();
}
