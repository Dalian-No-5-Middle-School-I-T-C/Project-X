import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import { cardFingerprint } from "../src/shared/cardVersion";
import type { CombinedGradingRow } from "../src/shared/types";
const fixture = await startScannerFlowFixture();
const { getMysqlDb } = await import("../src/server/db");
const { CardRepository } = await import(
  "../src/server/repositories/CardRepository"
);
const store = await import(
  "../src/apps/answer-card/server/database/scan-store"
);
const { processScannerSession } = await import(
  "../src/server/services/scannerSubmissions"
);
const { listPendingScans } = await import(
  "../src/server/services/scannerPending"
);
const { UserRepository } = await import(
  "../src/server/repositories/UserRepository"
);
const { authService } = await import("../src/server/services/AuthService");
const { createApp, persistGradingResults } = await import(
  "../src/apps/answer-card/server/index"
);
const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
const db = getMysqlDb(),
  card = (await new CardRepository().findById(info.cardId))!;
const exam = (await db.get<{ id: number }>(
  "SELECT id FROM exams WHERE card_id=?",
  card.id,
))!;
const teacher = await new UserRepository().createUser({
  username: "pending-teacher",
  password: "PendingTest2026!",
  name: "待确认测试教师",
  role_id: 2,
  teacher_role: "subject_teacher",
  subject: "数学",
});
const outsider = await new UserRepository().createUser({
  username: "pending-outsider",
  password: "PendingTest2026!",
  name: "无关教师",
  role_id: 2,
  teacher_role: "subject_teacher",
  subject: "数学",
});
await db.run(
  "UPDATE exams SET created_by=?,exam_mode='quiz',name='待确认交互验证' WHERE id=?",
  teacher.id,
  exam.id,
);
await db.run(
  "UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE id=?) WHERE student_number='91001'",
  teacher.id,
);
const app = await createApp();
const server = app.listen(
  process.argv.includes("--serve-pending") ? 5174 : 0,
  "127.0.0.1",
);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const token = (await authService.login(teacher.username, "PendingTest2026!"))
  .token!;
const outsiderToken = (
  await authService.login(outsider.username, "PendingTest2026!")
).token!;
const call = async (method: string, body?: unknown, auth = token) => {
  const res = await fetch(`${base}/api/exams/${exam.id}/scanner-pending`, {
    method,
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};
async function scan(number: string, option = "A") {
  const session = await store.createSession(card.id, "待确认模拟卷");
  await db.run(
    "UPDATE twain_scan_sessions SET card_version=?,version_source='upload',status='completed' WHERE id=?",
    cardFingerprint(card),
    session.id,
  );
  const imagePath = path.join(
    process.env.ANSWER_CARD_DATA_DIR!,
    `${session.id}.png`,
  );
  await writeFile(
    imagePath,
    Buffer.from(
      info.images[option === "A" ? "original" : "different"],
      "base64",
    ),
  );
  const record = await store.createScanRecord({
    sessionId: session.id,
    cardId: card.id,
    pageNum: 1,
    imagePath,
  });
  await db.run(
    "UPDATE twain_scan_records SET student_id=?,ocr_status='done',identity_json=? WHERE id=?",
    number,
    JSON.stringify({
      status: "verified",
      code: "QR_VERIFIED",
      cardId: card.id,
      pageNumber: 1,
    }),
    record.id,
  );
  await store.upsertRecognitionResult({
    scanRecordId: record.id,
    objectiveJson: JSON.stringify([
      { questionNumber: 1, selectedOptions: [option], confidence: 1 },
    ]),
    subjectiveJson: "[]",
  });
  const response = await processScannerSession(card, session.id, "save");
  return { session, record, response };
}
const score = async (number: string) =>
  db.get<{ total_score: number }>(
    "SELECT ss.total_score FROM student_scores ss JOIN users u ON u.id=ss.student_id WHERE ss.exam_id=? AND u.student_number=?",
    exam.id,
    number,
  );
try {
  await scan("91001");
  await db.run(
    "UPDATE exams SET score_published=1,status='closed' WHERE id=?",
    exam.id,
  );
  await scan("91002");
  assert.equal(
    Number((await score("91002"))!.total_score),
    5,
    "listed newcomer auto saves to published closed exam",
  );
  const before = JSON.stringify(
    await db.all(
      "SELECT * FROM student_scores WHERE exam_id=? ORDER BY student_id",
      exam.id,
    ),
  );
  const duplicate = await scan("91001", "B");
  assert.equal(
    JSON.stringify(
      await db.all(
        "SELECT * FROM student_scores WHERE exam_id=? ORDER BY student_id",
        exam.id,
      ),
    ),
    before,
    "duplicate leaves formal grade and rank intact",
  );
  assert.equal(Number((await score("91001"))!.total_score), 5);
  assert.equal((await listPendingScans(exam.id)).length, 1);
  await processScannerSession(card, duplicate.session.id, "save");
  assert.equal(
    Number((await score("91001"))!.total_score),
    5,
    "scanner retry cannot approve duplicate",
  );
  assert.equal((await call("GET", undefined, outsiderToken)).status, 403);
  const keyRead = await fetch(`${base}/api/exams/${exam.id}/scanner-pending`, {
    headers: { "X-Api-Key": info.key },
  });
  assert(
    [401, 403].includes(keyRead.status),
    "scanner key cannot read teacher approval queue",
  );
  let item = (await call("GET")).body.items[0];
  await db.run(
    "UPDATE student_scores SET total_score=4 WHERE exam_id=? AND student_id=(SELECT id FROM users WHERE student_number='91001')",
    exam.id,
  );
  assert.equal(
    (await call("POST", { ...item, action: "accept" })).status,
    409,
    "stale teacher view rejected",
  );
  item = (await call("GET")).body.items[0];
  await db.run(
    "UPDATE exams SET assigned_formula=? WHERE id=?",
    JSON.stringify({ enabled: true, type: "linear" }),
    exam.id,
  );
  assert.equal(
    (await call("POST", { ...item, action: "accept" })).status,
    409,
    "failed assignment rolls back confirmation",
  );
  assert.equal(Number((await score("91001"))!.total_score), 4);
  await db.run("UPDATE exams SET assigned_formula=NULL WHERE id=?", exam.id);
  const accepted = await call("POST", { ...item, action: "accept" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(Number((await score("91001"))!.total_score), 0);
  assert.equal(
    (await call("POST", { ...item, action: "accept" })).status,
    409,
    "double approval rejected",
  );
  assert.equal((await listPendingScans(exam.id)).length, 0);
  // An existing account outside the snapshot requires an authorized teacher to add it.
  const extra = await new UserRepository().createUser({
    username: "pending-extra",
    password: "PendingTest2026!",
    name: "名单外测试学生",
    role_id: 3,
    student_number: "91999",
  });
  await scan("91999");
  assert.equal(await score("91999"), null);
  item = (await call("GET")).body.items[0];
  assert.equal(item.reason, "roster");
  assert.equal(
    (await call("POST", { ...item, action: "accept" })).status,
    409,
    "teacher cannot add an unrelated student to the roster",
  );
  const grade = await db.run(
    "INSERT INTO grades (name,sort_order) VALUES ('待确认年级',1)",
  );
  const cls = await db.run(
    "INSERT INTO classes (name,grade_id,sort_order) VALUES ('待确认班',?,1)",
    grade.lastInsertRowid,
  );
  await db.run(
    "INSERT INTO teacher_classes (teacher_id,class_id,subject) VALUES (?,?,?)",
    teacher.id,
    cls.lastInsertRowid,
    "数学",
  );
  await db.run(
    "INSERT INTO class_students (class_id,student_id) VALUES (?,?)",
    cls.lastInsertRowid,
    extra.id,
  );
  const admitted = await call("POST", { ...item, action: "accept" });
  assert.equal(admitted.status, 200, JSON.stringify(admitted));
  assert.equal(Number((await score("91999"))!.total_score), 5);
  assert(
    await db.get(
      "SELECT 1 FROM exam_participants WHERE exam_id=? AND student_id=?",
      exam.id,
      extra.id,
    ),
  );
  await scan("99999");
  item = (await call("GET")).body.items[0];
  assert.equal(
    (await call("POST", { ...item, action: "accept" })).status,
    409,
    "unknown accounts cannot be fabricated by approval",
  );
  assert.equal(
    (await call("POST", { ...item, action: "discard" })).status,
    200,
  );
  // Configurable withdrawal applies only after an actual accepted score change.
  await db.run(
    "INSERT INTO system_settings (`key`,value) VALUES ('auto_unpublish_on_score_change','1')",
  );
  const next = await scan("91001", "A");
  assert.equal(
    Number(
      (await db.get<{ score_published: number }>(
        "SELECT score_published FROM exams WHERE id=?",
        exam.id,
      ))!.score_published,
    ),
    1,
    "pending duplicate does not hide exam",
  );
  item = (await call("GET")).body.items.find(
    (i: { sessionId: string }) => i.sessionId === next.session.id,
  );
  assert.equal((await call("POST", { ...item, action: "accept" })).status, 200);
  assert.equal(
    Number(
      (await db.get<{ score_published: number }>(
        "SELECT score_published FROM exams WHERE id=?",
        exam.id,
      ))!.score_published,
    ),
    0,
  );
  const afterWithdrawal = await scan("91002", "B");
  item = (await call("GET")).body.items.find(
    (i: { sessionId: string }) => i.sessionId === afterWithdrawal.session.id,
  );
  assert(
    item,
    "second duplicate stays pending even after automatic withdrawal",
  );
  const secondAccept = await call("POST", { ...item, action: "accept" });
  assert.equal(secondAccept.status, 200, JSON.stringify(secondAccept));
  assert.equal(Number((await score("91002"))!.total_score), 0);
  await scan("91003");
  assert.equal(
    Number((await score("91003"))!.total_score),
    5,
    "listed newcomer still saves after withdrawal of a closed exam",
  );
  await db.run(
    "DELETE FROM system_settings WHERE `key`='auto_unpublish_on_score_change'",
  );
  await db.run(
    "UPDATE exams SET score_published=1,status='grading',assigned_formula=? WHERE id=?",
    JSON.stringify({ enabled: true, type: "linear" }),
    exam.id,
  );
  const tables = [
    "student_scores",
    "question_scores",
    "scan_batches",
    "scan_records",
    "answer_overrides",
    "exam_publish_events",
  ];
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all(
        tables.map((t) =>
          db.all(`SELECT * FROM ${t} WHERE exam_id=?`, exam.id),
        ),
      ),
    );
  // scan_records belong to batches rather than carrying exam_id.
  tables.splice(tables.indexOf("scan_records"), 1);
  const beforeBatch = await snapshot();
  const row = {
    fileName: "batch.png",
    studentId: "91001",
    recognitionStatus: "ok",
    score: 3,
    maxScore: 5,
    needsReviewCount: 0,
    issueCount: 0,
    objectiveScore: 3,
    objectiveMaxScore: 5,
    subjectiveScore: 0,
    subjectiveMaxScore: 0,
    totalScore: 3,
    totalMaxScore: 5,
    questions: [
      {
        questionNumber: 1,
        selectedOptions: ["A"],
        correctOptions: ["A"],
        score: 3,
        maxScore: 5,
        confidence: 1,
        status: "correct",
        needsReview: false,
      },
    ],
    subjectiveQuestions: [],
    recognition: {
      status: "ok",
      cardId: card.id,
      questions: [],
      subjectiveQuestions: [],
    },
  } as CombinedGradingRow;
  await assert.rejects(
    persistGradingResults(String(exam.id), [row], teacher.id),
    /本批次成绩未保存/,
  );
  assert.equal(
    await snapshot(),
    beforeBatch,
    "batch assignment failure restores all previously committed rows and batch state",
  );
  assert.equal(
    Number(
      (await db.get<{ score_published: number }>(
        "SELECT score_published FROM exams WHERE id=?",
        exam.id,
      ))!.score_published,
    ),
    1,
  );
  await db.run("UPDATE exams SET assigned_formula=NULL WHERE id=?", exam.id);
  const { analysisCache } = await import("../src/server/services/analysisCache");
  const cacheKey = `getExamOverview:${exam.id}:all`;
  const transaction = db.transaction.bind(db);
  let repopulatedBeforeCommit = false;
  // MariaDB readers see old committed scores until COMMIT, even if an earlier
  // invalidate removed their cache. Inject that observable state at the boundary.
  db.transaction = async fn => transaction(async tx => {
    const result = await fn(tx);
    analysisCache.set(cacheKey, { totalScore: "old committed scores" });
    repopulatedBeforeCommit = true;
    return result;
  });
  try {
    const persisted = await persistGradingResults(String(exam.id), [row], teacher.id);
    assert.equal(persisted.persisted, 1);
    assert(repopulatedBeforeCommit, "simulate a concurrent analysis read immediately before commit");
    assert.equal(analysisCache.get(cacheKey), undefined, "successful batch commit invalidates any repopulated old analysis");
  } finally { db.transaction = transaction; }
  console.log(
    `PASS scanner pending (${db.dialect}): auto admission, preserved grades, authority, stale/duplicate approval, roster, configurable withdrawal and atomic batch assignment`,
  );
  if (process.argv.includes("--serve-pending")) {
    await db.run(
      "UPDATE exams SET score_published=1,status='grading' WHERE id=?",
      exam.id,
    );
    await scan("91001", "B");
    await scan("99999");
    await db.run(
      "DELETE FROM exam_participants WHERE exam_id=? AND student_id=?",
      exam.id,
      extra.id,
    );
    await db.run(
      "DELETE FROM question_scores WHERE exam_id=? AND student_id=?",
      exam.id,
      extra.id,
    );
    await db.run(
      "DELETE FROM student_scores WHERE exam_id=? AND student_id=?",
      exam.id,
      extra.id,
    );
    // fresh roster case for the interactive browser fixture
    await scan("91999", "B");
    console.log(
      `PENDING_UI_READY ${base} exam=${exam.id} username=pending-teacher password=PendingTest2026!`,
    );
    await new Promise(() => {});
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.close();
}
