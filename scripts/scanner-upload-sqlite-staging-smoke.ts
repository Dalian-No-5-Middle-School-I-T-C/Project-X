/** SQLite: unrelated committed writes survive when page image staging fails outside the upload transaction. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { scannerPageImageStaging } from "../src/server/services/scannerPageImageStaging";
import { hashPassword, verifyPassword } from "../src/server/db";

const root = await mkdtemp(path.join(tmpdir(), "projectx-scanner-staging-"));
process.env.PROJECTX_DB_PATH = path.join(root, "scanner.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(root, "cards");
process.env.PROJECTX_TOKEN_DIR = path.join(root, "tokens");
process.env.PROJECTX_AUTH_ENFORCE = "1";
for (const name of Object.keys(process.env)) if (/^PROJECTX_(MARIADB|MYSQL)_/.test(name)) delete process.env[name];
await mkdir(process.env.ANSWER_CARD_DATA_DIR, { recursive: true });
process.chdir(root);

const { initializeDatabase, getMysqlDb, closeDatabase } = await import("../src/server/db");
const { resetAdapter } = await import("../src/server/db/mysql");
initializeDatabase();
const db = getMysqlDb();
assert.equal(db.dialect, "sqlite");

const { createDefaultCard } = await import("../src/shared/defaultCard");
const { CardRepository } = await import("../src/server/repositories/CardRepository");
const { cardFingerprint } = await import("../src/shared/cardVersion");
const card = createDefaultCard("91514002");
card.bodyBlocks = [{ id: "flow_q", type: "objective", title: "选择题", questionStart: 1, questionCount: 1,
  optionCount: 4, mode: "single", scorePerQuestion: 5, answerKey: { "1": ["A"] }, density: "normal" }];
await new CardRepository().createCard(card);
await new CardRepository().updateCard(card);
const version = cardFingerprint((await new CardRepository().findById(card.id))!);
const key = "isolated-staging-smoke";
const { hashSecret } = await import("../src/server/lib/field-crypto");
await db.run("INSERT INTO api_keys (name,api_key,scope,is_active) VALUES (?,?,?,1)", "staging-test", hashSecret(key), "scanner");

const oldPassword = "Staging-Original-2026!";
const newPassword = "Staging-Replaced-2026!";
const teacherId = Number((await db.run(
  "INSERT INTO users (username, password_hash, name, role_id) VALUES (?,?,?,2)",
  "staging_teacher", await hashPassword(oldPassword), "回归教师",
)).lastInsertRowid);

const { default: sharp } = await import("sharp");
const image = (await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 90, g: 120, b: 200 } } }).png().toBuffer()).toString("base64");
const recognition = { status: "ok", pageNumber: 1,
  identity: { status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 },
  studentId: { status: "ok", value: "91001" }, questions: [], subjectiveQuestions: [],
  geometry: { imageWidth: 24, imageHeight: 24, imageToLayout: [1,0,0,0,1,0,0,0,1], layoutToImage: [1,0,0,0,1,0,0,0,1] },
};

let releaseStaging!: () => void;
let signalStagingEntered!: () => void;
const stagingEntered = new Promise<void>(resolve => { signalStagingEntered = resolve; });
const stagingPaused = new Promise<void>(resolve => { releaseStaging = resolve; });
const originalWrite = scannerPageImageStaging.write.bind(scannerPageImageStaging);
scannerPageImageStaging.write = async (target, data) => {
  signalStagingEntered();
  await stagingPaused;
  const err = Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
  throw err;
};

const { default: express } = await import("express");
const { default: router } = await import("../src/server/routes/scanner-upload");
const app = express();
app.use(express.json());
app.use("/api/scanner/upload", router);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const request = (url: string, init?: RequestInit) => fetch(`${base}${url}`, {
  ...init, headers: { ...init?.headers, "X-Api-Key": key },
});

try {
  const created = await request("/api/scanner/upload/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId: card.id, cardVersion: version, pageCount: 1, name: "staging" }),
  });
  assert.equal(created.status, 201);
  const remote = await created.json();

  const form = new FormData();
  form.append("image", new Blob([Buffer.from(image, "base64")], { type: "image/png" }), "page.png");
  form.append("token", remote.uploadTokens[0]);
  form.append("pageNum", "1");
  form.append("side", "front");
  form.append("recognition", JSON.stringify(recognition));
  const uploadPromise = request(`/api/scanner/upload/sessions/${remote.sessionId}/pages`, { method: "POST", body: form });
  await stagingEntered;

  const { authService } = await import("../src/server/services/AuthService");
  const changed = await authService.changePassword(teacherId, oldPassword, newPassword);
  assert.equal(changed.success, true, changed.message);
  const hashAfterChange = (await db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", teacherId))!.password_hash;
  assert.equal(await verifyPassword(newPassword, hashAfterChange), true);
  releaseStaging();

  assert.equal((await uploadPromise).status, 500);
  const hashAfterUpload = (await db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", teacherId))!.password_hash;
  assert.equal(await verifyPassword(newPassword, hashAfterUpload), true, "password change must not roll back with failed upload staging");
  assert.equal(await verifyPassword(oldPassword, hashAfterUpload), false);
  scannerPageImageStaging.write = originalWrite;
  console.log("PASS sqlite: committed password change survives EIO during page image staging");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  resetAdapter();
  closeDatabase();
}
