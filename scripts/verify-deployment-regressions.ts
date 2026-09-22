/** DOCX analysis routing and upload authorization checks against real HTTP routes. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";
import AdmZip from "adm-zip";
import { randomBytes } from "node:crypto";

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
const { autoExtractPaperText } = await import("../src/apps/answer-card/server/paper-ocr");
const { extractDocxFiles, PaperInputError, DOCX_LIMITS } = await import("../src/apps/answer-card/server/paper-docx");
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

  const makeCard = async (id: string, files: Record<string, Buffer>) => {
    await db.run("INSERT INTO answer_cards (id, title) VALUES (?, ?)", id, id);
    await mkdir(paperDir(id), { recursive: true });
    for (const [name, data] of Object.entries(files)) await writeFile(path.join(paperDir(id), name), data);
  };
  const inputError = (code: string) => (error: unknown) => error instanceof PaperInputError && error.code === code;
  await makeCard("mixed-image", { "original.png": Buffer.from("image"), "original-2.docx": docx("后页文字不能代替完整原卷") });
  await makeCard("mixed-pdf", { "original.pdf": Buffer.from("pdf"), "original-2.docx": docx("后页文字不能代替完整原卷") });
  await makeCard("mixed-reverse", { "original.docx": docx("首页文字不能代替完整原卷"), "original-2.png": Buffer.from("image") });
  const beforeRejected = captured.length;
  for (const model of ["gpt-4o", "gpt-3.5-turbo"]) {
    await db.run("UPDATE ai_providers SET models = ?", JSON.stringify([model]));
    for (const id of ["mixed-image", "mixed-pdf", "mixed-reverse"]) {
      const response = await analyze(id);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "MIXED_PAPER_FORMATS");
      await assert.rejects(autoExtractPaperText(id), inputError("MIXED_PAPER_FORMATS"));
    }
  }
  await db.run("UPDATE ai_providers SET models = '[\"gpt-4o\"]'");
  console.log("PASS: mixed DOCX/image/PDF rejected in both model modes and extraction entry point");

  // Real compressed data; no need to risk expanding the review's 128 MiB payload.
  const largeZip = new AdmZip(docx("有效数学原卷内容用于资源限制测试"));
  largeZip.addFile("padding.bin", Buffer.alloc(DOCX_LIMITS.expandedBytes + 1, 65));
  const oversized = largeZip.toBuffer();
  assert(oversized.length < 100_000, "fixture must exercise high compression ratio");
  await makeCard("oversized", { "original.docx": oversized });
  const tooLarge = await analyze("oversized");
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error, "PAPER_TOO_LARGE");

  // Forge the central-directory size; streaming validation must still reject.
  const forged = Buffer.from(oversized);
  let offset = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  let patched = false;
  while (offset >= 0 && forged.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = forged.readUInt16LE(offset + 28);
    const name = forged.subarray(offset + 46, offset + 46 + nameLength).toString();
    if (name === "padding.bin") { forged.writeUInt32LE(1, offset + 24); patched = true; break; }
    offset += 46 + nameLength + forged.readUInt16LE(offset + 30) + forged.readUInt16LE(offset + 32);
  }
  assert(patched);
  await makeCard("forged", { "original.docx": forged });
  assert.equal((await analyze("forged")).status, 422);

  const expandedZip = new AdmZip(docx("有效数学原卷内容用于累计资源测试"));
  expandedZip.addFile("padding.bin", Buffer.alloc(17 * 1024 * 1024, 65));
  const expandedPart = expandedZip.toBuffer();
  await makeCard("expanded-total", { "original.docx": expandedPart, "original-2.docx": expandedPart });
  assert.equal((await analyze("expanded-total")).status, 413);
  const compressedZip = new AdmZip(docx("有效数学原卷内容用于累计压缩测试"));
  compressedZip.addFile("padding.bin", randomBytes(11 * 1024 * 1024));
  const compressedPart = compressedZip.toBuffer();
  await makeCard("compressed-total", { "original.docx": compressedPart, "original-2.docx": compressedPart });
  assert.equal((await analyze("compressed-total")).status, 413);
  const textPart = docx("字".repeat(DOCX_LIMITS.textCharacters / 2 + 1));
  await makeCard("text-total", { "original.docx": textPart, "original-2.docx": textPart });
  assert.equal((await analyze("text-total")).status, 413);
  assert.equal(captured.length, beforeRejected, "rejected papers must never reach the model");

  const validPaths = [path.join(paperDir("docx"), "original.docx")];
  await assert.rejects(extractDocxFiles(Array(41).fill(validPaths[0])), inputError("PAPER_TOO_LARGE"));
  const pendingExtraction = extractDocxFiles(validPaths);
  await assert.rejects(extractDocxFiles(validPaths), inputError("PAPER_ANALYSIS_BUSY"));
  assert.match((await pendingExtraction)!, /数学原卷/);
  assert.equal((await analyze("docx")).status, 200, "failures must release the extraction slot");
  console.log("PASS: high expansion, forged size, aggregate compressed/expanded/text budgets, concurrency and recovery");

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
