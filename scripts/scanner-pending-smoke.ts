import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
const { sessionCorrection, saveSessionCorrection, storeCorrectionPage } = await import("../src/server/services/scanCorrection");
const { correctionCells, toggleCorrectionCell } = await import("../src/shared/scanCorrection");
const { listPendingScans, confirmPendingScan } = await import(
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
card.studentInfo.studentNumberDigits = 5;
await new CardRepository().updateCard(card);
Object.assign(card, (await new CardRepository().findById(card.id))!);
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
  await storeCorrectionPage(card, "twain_scan_record", record.id, {
    status: "ok", pageNumber: 1, identity: { status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 },
    geometry: { imageWidth: 24, imageHeight: 24, imageToLayout: [1,0,0,0,1,0,0,0,1], layoutToImage: [1,0,0,0,1,0,0,0,1] },
    studentId: { status: "ok", value: number }, questions: [{ questionNumber: 1, selectedOptions: [option], confidence: 1 }], subjectiveQuestions: [],
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
  const unaffected = JSON.stringify(await score("91002"));
  const original = (await db.get<{ session_id: string }>("SELECT session_id FROM scanner_submissions WHERE exam_id=? AND student_number='91001' AND state='saved'", exam.id))!;
  const duplicate = await scan("91001", "B");
  assert.equal(await score("91001"), null, "published duplicate withdraws the previously saved grade");
  assert.equal(JSON.stringify(await score("91002")), unaffected, "unrelated student remains saved");
  assert.equal((await listPendingScans(exam.id)).length, 2, "both duplicate originals appear in teacher abnormal queue");
  const healthySibling = await store.createScanRecord({sessionId:duplicate.session.id,cardId:card.id,pageNum:2,imagePath:duplicate.record.image_path});
  await db.run("UPDATE twain_scan_records SET student_id='91007',ocr_status='done',identity_json=? WHERE id=?",JSON.stringify({status:"verified",code:"QR_VERIFIED",cardId:card.id,pageNumber:1}),healthySibling.id);
  await store.upsertRecognitionResult({scanRecordId:healthySibling.id,objectiveJson:JSON.stringify([{questionNumber:1,selectedOptions:["A"],confidence:1}]),subjectiveJson:"[]"});
  await processScannerSession(card,duplicate.session.id,"save");
  assert.equal(Number((await score("91007"))!.total_score),5,"healthy paper in the conflicting batch saves independently");
  assert.equal(await score("91001"),null);

  await processScannerSession(card, duplicate.session.id, "save");
  assert.equal(await score("91001"), null, "scanner retry cannot approve duplicate");
  assert.equal((await call("GET", undefined, outsiderToken)).status, 403);
  const keyRead = await fetch(`${base}/api/exams/${exam.id}/scanner-pending`, { headers: { "X-Api-Key": info.key } });
  assert([401, 403].includes(keyRead.status), "scanner key cannot read teacher abnormal queue");
  let item = (await call("GET")).body.items[0];
  assert.equal((await call("POST", { ...item, action: "accept" })).status, 409, "duplicate cannot bypass mark correction by adopting one attempt");
  async function saveMarks(sessionId: string, number?: string) {
    const doc = await sessionCorrection(card, sessionId, "0", false), page = doc.pages[0];
    let selected = page.selected;
    if (number) for (const [digitIndex, character] of [...number].entries()) {
      const digit = correctionCells(page.layout).find(c => c.type === "student_digit" && c.digitIndex === digitIndex && c.digit === Number(character))!;
      selected = toggleCorrectionCell(card, page, selected, digit.id);
    }
    return saveSessionCorrection(card, sessionId, "0", [{ sourceId: page.sourceId, revision: page.revision, selected }], teacher.id);
  }
  assert.equal((await saveMarks(original.session_id)).saved, false, "unchanged duplicate remains abnormal");
  assert.equal((await saveMarks(duplicate.session.id, "91004")).saved, true, "teacher mark correction resolves the mistaken ID");
  assert.equal(await score("91001"), null, "withdrawn original requires an explicit save after conflict resolution");
  assert.equal((await saveMarks(original.session_id)).saved, true);
  assert.equal(Number((await score("91001"))!.total_score), 5);
  assert.equal(Number((await score("91004"))!.total_score), 0);
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
  // Pause an actual upload after its ownership read, then confirm the same source.
  const rosterSource = (await db.get<{session_id:string}>("SELECT session_id FROM scanner_submissions WHERE exam_id=? AND student_number='91999' AND state='roster'", exam.id))!;
  const rosterRecord = (await db.get<{id:string,image_path:string}>("SELECT id,image_path FROM twain_scan_records WHERE session_id=?", rosterSource.session_id))!;
  await db.run("UPDATE twain_scan_sessions SET status='incomplete' WHERE id=?", rosterSource.session_id);
  item = (await call("GET")).body.items.find((i:{sessionId:string}) => i.sessionId === rosterSource.session_id);
  const uploadPage = () => {
    const body = new FormData(); body.set("token", rosterRecord.id); body.set("pageNum", "1"); body.set("side", "front");
    body.set("image", new Blob([Buffer.from(info.images.different,"base64")], {type:"image/png"}), "retry.png");
    body.set("recognition", JSON.stringify({status:"ok", identity:{status:"verified",code:"QR_VERIFIED",cardId:card.id,pageNumber:1},
      studentId:{status:"ok",value:"91999"}, questions:[{questionNumber:1,selectedOptions:["B"],confidence:1}],subjectiveQuestions:[]}));
    return fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${rosterSource.session_id}/pages`, {method:"POST",headers:{"X-Api-Key":info.key},body});
  };
  let releaseUpload!:()=>void, ownershipRead!:()=>void;
  const uploadGate = new Promise<void>(resolve=>{releaseUpload=resolve;});
  const ownershipGate = new Promise<void>(resolve=>{ownershipRead=resolve;});
  const originalTransaction = db.transaction.bind(db);
  let pauseUpload = true;
  db.transaction = fn => originalTransaction(async tx => {
    const all = tx.all.bind(tx);
    tx.all = async (sql,...params) => {
      const result = await all(sql,...params);
      if (pauseUpload && sql.includes("state = 'saved' OR") && params[0] === rosterSource.session_id) {
        pauseUpload = false; ownershipRead(); await uploadGate;
      }
      return result;
    };
    try { return await fn(tx); } finally { tx.all = all; }
  });
  try {
    const upload = uploadPage();
    await ownershipGate;
    // Enqueues synchronously while upload is paused. It must see the committed new evidence.
    const staleConfirmation = assert.rejects(confirmPendingScan(exam.id,item.sessionId,item.groupId,"accept",item.token,teacher.id,null), /原卷或正式成绩已更新/);
    releaseUpload();
    const response = await upload;
    assert.equal(response.status,200,await response.clone().text());
    await staleConfirmation;
    assert.equal(await score("91999"),null,"confirmation never saves scores from the evidence preceding an in-flight upload");
  } finally { releaseUpload(); db.transaction = originalTransaction; }
  item = (await call("GET")).body.items.find((i:{sessionId:string})=>i.sessionId===rosterSource.session_id);
  // Assignment failures still roll back teacher admission before any grades become visible.
  await db.run("UPDATE exams SET assigned_formula=? WHERE id=?",JSON.stringify({enabled:true,type:"linear"}),exam.id);
  assert.equal((await call("POST",{...item,action:"accept"})).status,409);
  assert.equal(await score("91999"),null);
  await db.run("UPDATE exams SET assigned_formula=NULL WHERE id=?",exam.id);
  const admitted = await call("POST", { ...item, action: "accept" });
  assert.equal(admitted.status, 200, JSON.stringify(admitted));
  assert.equal(Number((await score("91999"))!.total_score), 0);
  assert(
    await db.get(
      "SELECT 1 FROM exam_participants WHERE exam_id=? AND student_id=?",
      exam.id,
      extra.id,
    ),
  );
  const acceptedSource = async () => JSON.stringify(await Promise.all([
    db.get("SELECT * FROM twain_scan_records WHERE id=?",rosterRecord.id),
    db.get("SELECT * FROM twain_recognition_results WHERE scan_record_id=?",rosterRecord.id),
    db.get("SELECT * FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,extra.id),
  ]));
  const acceptedBefore = await acceptedSource();
  const acceptedImagePath = (await db.get<{image_path:string}>("SELECT image_path FROM twain_scan_records WHERE id=?",rosterRecord.id))!.image_path;
  const acceptedBytes = await readFile(acceptedImagePath);
  assert.equal((await uploadPage()).status,409,"late page retry cannot overwrite the teacher-accepted original");
  const cropBody = new FormData(); cropBody.set("manifest","[]");
  assert.equal((await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${rosterSource.session_id}/pages/${rosterRecord.id}/crops`,
    {method:"POST",headers:{"X-Api-Key":info.key},body:cropBody})).status,409,"late crop retry cannot replace accepted review images");
  assert.equal(await acceptedSource(),acceptedBefore);
  assert.deepEqual(await readFile(acceptedImagePath),acceptedBytes);
  assert.equal((await call("POST",{...item,action:"accept"})).status,409,"double approval rejected");
  if (db.dialect === "mariadb") {
    // A second process has its own queue. Model its uncommitted confirmation on
    // an independent connection; the real upload must wait for the exam row lock.
    await db.run("UPDATE scanner_submissions SET state='roster' WHERE session_id=? AND group_id='0'",rosterSource.session_id);
    let locked!:()=>void, commit!:()=>void, attemptingLock!:()=>void;
    const lockedGate = new Promise<void>(resolve=>{locked=resolve;});
    const commitGate = new Promise<void>(resolve=>{commit=resolve;});
    const attemptGate = new Promise<void>(resolve=>{attemptingLock=resolve;});
    const confirmation = originalTransaction(async tx=>{
      await tx.run("UPDATE exams SET id=id WHERE id=?",exam.id);
      await tx.run("UPDATE scanner_submissions SET state='saved' WHERE session_id=? AND group_id='0'",rosterSource.session_id);
      locked(); await commitGate;
    });
    await lockedGate;
    db.transaction = fn=>originalTransaction(async tx=>{
      const run=tx.run.bind(tx);
      tx.run=async (sql,...params)=>{
        if (/UPDATE exams SET id = id/.test(sql)) attemptingLock();
        return run(sql,...params);
      };
      try { return await fn(tx); } finally { tx.run=run; }
    });
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try {
      const retry=uploadPage();
      await Promise.race([attemptGate,new Promise<void>((_,reject)=>{timeout=setTimeout(()=>reject(new Error("upload did not acquire the common exam lock")),5000);})]);
      assert.deepEqual(await readFile(acceptedImagePath),acceptedBytes,"upload cannot write while another connection confirms its source");
      commit(); await confirmation;
      const response=await retry;
      assert.equal(response.status,409,await response.clone().text());
      assert.equal(await acceptedSource(),acceptedBefore,"post-lock reads observe the saved receipt after commit");
    } finally { if(timeout) clearTimeout(timeout); commit(); await confirmation; db.transaction=originalTransaction; }
  }

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
  // Withdrawal policy affects publication, while both copies are abnormal in either mode.
  await db.run("INSERT INTO system_settings (`key`,value) VALUES ('auto_unpublish_on_score_change','1')");
  const next = await scan("91001", "B");
  assert.equal(Number((await db.get<{score_published:number}>("SELECT score_published FROM exams WHERE id=?", exam.id))!.score_published), 0);
  assert.equal(await score("91001"), null);
  assert.equal((await saveMarks(next.session.id, "91005")).saved, true);
  assert.equal((await saveMarks(original.session_id)).saved, true);
  const afterWithdrawal = await scan("91002", "B");
  assert.equal(await score("91002"), null, "past publication also withdraws the conflicting formal grade");
  assert.equal((await saveMarks(afterWithdrawal.session.id, "91006")).saved, true);
  const secondOriginal = (await db.get<{session_id:string}>("SELECT session_id FROM scanner_submissions WHERE exam_id=? AND student_number='91002' AND previously_saved=1 AND state='pending'", exam.id))!;
  assert.equal((await saveMarks(secondOriginal.session_id)).saved, true);
  await scan("91003");
  assert.equal(Number((await score("91003"))!.total_score), 5, "listed newcomer still saves after withdrawal");
  await db.run("DELETE FROM system_settings WHERE `key`='auto_unpublish_on_score_change'");
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
  tables.push("answer_block_crops");
  const beforeBatch = await snapshot();
  const { blockCropsDir } = await import("../src/apps/answer-card/server/storage");
  const preservedFile = path.join(blockCropsDir, "preserved.png");
  await mkdir(blockCropsDir, { recursive: true });
  const cropBytes = Buffer.from(info.images.original, "base64");
  await writeFile(preservedFile, cropBytes);
  async function cropFiles(dir = blockCropsDir): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async entry => {
      const name = path.join(dir, entry.name);
      return entry.isDirectory() ? [name, ...await cropFiles(name)] : [name];
    }));
    return nested.flat().sort();
  }
  const beforeFiles = await cropFiles();
  const retryCrop = path.join(process.env.ANSWER_CARD_DATA_DIR!, "rollback-input.png");
  await writeFile(retryCrop, cropBytes);
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
      blockCrops: [{ blockId: "flow_q", blockTitle: "回滚切图", blockType: "objective", pageNumber: 1, segmentIndex: 0, questionNumbers: [1],
        rect: { x: 0, y: 0, width: 1, height: 1 }, path: retryCrop, widthPx: 24, heightPx: 24, dpi: 300 }],
    },
  } as CombinedGradingRow;
  await assert.rejects(
    persistGradingResults(String(exam.id), [row], teacher.id),
    /本批次成绩未保存/,
  );
  assert.deepEqual(await cropFiles(), beforeFiles, "batch rollback removes newly written files and empty directories");
  assert.deepEqual(await readFile(retryCrop), cropBytes, "batch rollback restores recognition input for retry");
  await assert.rejects(persistGradingResults(String(exam.id), [row], teacher.id), /本批次成绩未保存/);
  assert.deepEqual(await cropFiles(), beforeFiles, "repeated MariaDB/SQLite rollback does not accumulate orphan directories");
  assert.deepEqual(await readFile(preservedFile), cropBytes, "rollback preserves pre-existing crop files");
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
  await db.run("UPDATE exams SET status='closed' WHERE id=?", exam.id);
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
    const crop = await db.get<{image_path:string}>("SELECT image_path FROM answer_block_crops WHERE exam_id=? AND source_type='scan_record' ORDER BY source_record_id DESC LIMIT 1", exam.id);
    assert(crop && existsSync(crop.image_path), "retry after fixing the formula commits its crop file");
    assert(!existsSync(retryCrop), "successful commit consumes the restored retry input");
  } finally { db.transaction = transaction; }
  const partialInputs = ["partial-good.png", "partial-failed.png"].map(name=>path.join(process.env.ANSWER_CARD_DATA_DIR!,name));
  for (const input of partialInputs) await writeFile(input,cropBytes);
  const partialRows = ["91001","91002"].map((studentId,index)=>({ ...structuredClone(row),studentId,
    recognition:{...structuredClone(row.recognition),blockCrops:[{...row.recognition.blockCrops![0],path:partialInputs[index]}]},
  }));
  const secondStudent = (await db.get<{id:number}>("SELECT id FROM users WHERE student_number='91002'"))!;
  const previousSecondScore = JSON.stringify(await db.get("SELECT * FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,secondStudent.id));
  const beforePartialFiles = await cropFiles();
  db.transaction = async fn=>transaction(async tx=>{
    const run = tx.run.bind(tx);
    tx.run = async (sql,...params)=>{
      if (/INSERT INTO question_scores/i.test(sql) && Number(params[1])===Number(secondStudent.id)) throw new Error("forced per-student persistence failure");
      return run(sql,...params);
    };
    try { return await fn(tx); } finally { tx.run = run; }
  });
  try {
    const partial = await persistGradingResults(String(exam.id),partialRows,teacher.id);
    assert.equal(partial.status,"partial"); assert.equal(partial.persisted,1); assert.equal(partial.failedCount,1);
  } finally { db.transaction = transaction; }
  assert.equal(JSON.stringify(await db.get("SELECT * FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,secondStudent.id)),previousSecondScore,"row savepoint failure preserves prior student grade");
  assert(!existsSync(partialInputs[0]),"successful student retains its moved crop");
  assert.deepEqual(await readFile(partialInputs[1]),cropBytes,"row savepoint rollback restores only failed student's input");
  const addedFiles = (await cropFiles()).filter(name=>!beforePartialFiles.includes(name));
  assert.equal(addedFiles.length,2,"partial batch keeps one successful crop file and its directory, without failed-row leftovers");
  assert.deepEqual(await readFile(preservedFile),cropBytes);
  console.log(
    `PASS scanner pending (${db.dialect}): auto admission, published duplicate withdrawal and mark correction, authority, stale approval, roster, configurable withdrawal and atomic batch assignment`,
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
