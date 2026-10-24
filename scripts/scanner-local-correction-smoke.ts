/** Authenticated scanner corrections after card sync, with no local exam or roster. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import { createDefaultCard } from "../src/shared/defaultCard";
import { cardFingerprint } from "../src/shared/cardVersion";
import { buildLayout } from "../src/shared/layout";
import { correctionCells, toggleCorrectionCell, type CorrectionDocument } from "../src/shared/scanCorrection";
import type { CombinedRecognitionResult } from "../src/shared/types";

const fixture = await startScannerFlowFixture(0, "127.0.0.1", { localScanner: true });
try {
  const { getMysqlDb, hashPassword } = await import("../src/server/db");
  const { authService } = await import("../src/server/services/AuthService");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const { storeCorrectionPage } = await import("../src/server/services/scanCorrection");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const db = getMysqlDb(), repo = new CardRepository();
  const password = "Local-Correction-Test-2026!", hash = await hashPassword(password);
  const tokens: Record<string, string> = {};
  for (const [name, roleId] of [["admin", 1], ["teacher", 2], ["student", 3]] as const) {
    await db.run("INSERT INTO users(username,password_hash,name,role_id) VALUES (?,?,?,?)", `local_${name}`, hash, name, roleId);
    const login = await authService.login(`local_${name}`, password);
    assert(login.success && login.token); tokens[name] = login.token;
  }
  const card = createDefaultCard("91519002");
  card.studentInfo.studentNumberDigits = 5;
  card.bodyBlocks = [{ id: "local_obj", type: "objective", title: "local", questionStart: 1, questionCount: 1,
    optionCount: 4, mode: "single", scorePerQuestion: 5, answerKey: { "1": ["A"] }, density: "normal" }];
  await repo.createCard(card); await repo.updateCard(card);
  const current = (await repo.findById(card.id))!, version = cardFingerprint(current);
  const session = await store.createSession(card.id, "synced card without local exam");
  await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=? WHERE id=?", version, session.id);
  const imagePath = path.join(process.env.ANSWER_CARD_DATA_DIR!, "local.png");
  await writeFile(imagePath, await sharp({ create: { width: 210, height: 297, channels: 3, background: "white" } }).png().toBuffer());
  const record = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: 1, imagePath });
  const recognition: CombinedRecognitionResult = { status: "ok", pageNumber: 1,
    identity: { status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 },
    geometry: { imageWidth: 210, imageHeight: 297, imageToLayout: [1,0,0,0,1,0,0,0,1], layoutToImage: [1,0,0,0,1,0,0,0,1] },
    studentId: { status: "ok", value: "91001" }, questions: [{ questionNumber: 1, selectedOptions: ["B"], confidence: 1 }], subjectiveQuestions: [] };
  await db.run("UPDATE twain_scan_records SET student_id='91001',ocr_status='done',identity_json=? WHERE id=?", JSON.stringify(recognition.identity), record.id);
  await store.upsertRecognitionResult({ scanRecordId: record.id, objectiveJson: JSON.stringify(recognition.questions), subjectiveJson: "[]" });
  await storeCorrectionPage(current, "twain_scan_record", record.id, recognition);
  const url = `${fixture.baseUrl}/api/scanner/session/${session.id}/groups/0/correction`;
  const request = (role: string, method = "GET", body?: unknown, target = url) => fetch(target, { method,
    headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await request("student")).status, 403);
  assert.equal((await request("teacher")).status, 200);
  const read = await request("admin"); assert.equal(read.status, 200, await read.clone().text());
  const doc = await read.json() as CorrectionDocument;
  assert.equal(doc.pages.length, 1);
  assert.equal((await request("admin", "GET", undefined, fixture.baseUrl + doc.pages[0].imageUrl)).status, 200);
  const page = doc.pages[0], a = correctionCells(buildLayout(current).pages[0]).find(c => c.type === "objective_option" && c.option === "A")!;
  const edit = { sourceId: page.sourceId, revision: page.revision, selected: toggleCorrectionCell(current, page, page.selected, a.id) };
  const saved = await request("teacher", "PUT", { pages: [edit], draft: true });
  assert.equal(saved.status, 200, await saved.clone().text()); assert.equal((await saved.json()).drafted, true);
  const reopened = await (await request("teacher")).json() as CorrectionDocument;
  assert.deepEqual(reopened.pages[0].recognition.questions[0].selectedOptions, ["A"]);
  assert(reopened.pages[0].revision > page.revision);
  assert.equal((await request("teacher", "PUT", { pages: [edit], draft: true })).status, 409);
  const standalone = await request("admin", "PUT", { pages: [{ sourceId: page.sourceId,
    revision: reopened.pages[0].revision, selected: reopened.pages[0].selected }] });
  assert.equal(standalone.status, 200, await standalone.clone().text());
  assert.equal((await standalone.json()).saved, false, "the standalone editor keeps corrected marks until upload");
  assert.equal(await db.get("SELECT id FROM student_scores WHERE student_id IN (SELECT id FROM users WHERE student_number='91001')"), null);
  assert.equal((await request("admin", "GET", undefined, url.replace("/session/", "/upload/sessions/"))).status, 409, "server-side correction still requires an exam");
  const firstExam = await db.run("INSERT INTO exams(name,card_id,status) VALUES (?,?,'grading')", "first", card.id);
  const secondExam = await db.run("INSERT INTO exams(name,card_id,status) VALUES (?,?,'grading')", "second", card.id);
  const ambiguous = await request("admin");
  assert.equal(ambiguous.status, 200, "multiple candidate exams must not block local card correction");
  const ambiguousDoc = await ambiguous.json() as CorrectionDocument;
  const ambiguousSave = await request("admin", "PUT", { pages: ambiguousDoc.pages.map(p => ({
    sourceId: p.sourceId, revision: p.revision, selected: p.selected })) });
  assert.equal(ambiguousSave.status, 200, "ambiguous ownership must still allow saving the local card");
  assert.equal((await ambiguousSave.json() as { saved: boolean }).saved, false, "ambiguous ownership must not admit grades");
  assert.equal(await db.get("SELECT id FROM student_scores WHERE exam_id IN (?,?)", firstExam.lastInsertRowid, secondExam.lastInsertRowid), null,
    "ambiguous local correction must never write formal grades");
  // 只有单题块授权的教师：看得到考试，但不能借归属歧义读改整张卡。
  const scoped = await db.run("INSERT INTO users(username,password_hash,name,role_id) VALUES ('local_blockscoped',?,'单题块教师',2)", hash);
  await db.run("INSERT INTO teacher_permissions(teacher_id,block_id,can_grade,can_view_scores) VALUES (?,?,?,?)", scoped.lastInsertRowid, "local_obj", 1, 1);
  const scopedLogin = await authService.login("local_blockscoped", password);
  assert(scopedLogin.success && scopedLogin.token);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${scopedLogin.token}` } })).status, 403,
    "block-scoped teachers must not correct an ambiguous whole card");
  // 有整卷授权（这里是考试创建者）的教师仍可用，说明收口没有把正常改分也挡掉。
  const owner = await db.run("INSERT INTO users(username,password_hash,name,role_id,teacher_role,subject) VALUES ('local_owner',?,'整卷教师',2,'subject_teacher','shuxue')", hash);
  await db.run("UPDATE exams SET created_by=? WHERE id IN (?,?)", owner.lastInsertRowid, firstExam.lastInsertRowid, secondExam.lastInsertRowid);
  const ownerLogin = await authService.login("local_owner", password);
  assert(ownerLogin.success && ownerLogin.token);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${ownerLogin.token}` } })).status, 200,
    "teachers with whole-exam grading access keep the ambiguous correction available");
  await db.run("UPDATE exams SET created_by=NULL WHERE id IN (?,?)", firstExam.lastInsertRowid, secondExam.lastInsertRowid);
  // 会话曾绑定第二场考试，而那场已被保留策略清理：不能把这张卡改挂到仍在用的第一场上。
  await db.run("INSERT INTO exam_archives(exam_id,is_deleted,deleted_at) VALUES (?,1,CURRENT_TIMESTAMP)", secondExam.lastInsertRowid);
  await db.run("INSERT INTO scanner_submissions(exam_id,session_id,group_id,student_number,state,pages_json) VALUES (?,?,?,'91001','saved','{}')",
    secondExam.lastInsertRowid, session.id, "0");
  assert.equal((await request("teacher")).status, 404, "archived bindings must not be re-homed onto another active exam");
  assert.equal((await request("admin")).status, 200, "admins keep the CR4 read-through on cleaned exams");
  // 混合绑定（同一会话既传过被清理的考试、也传过在用考试）同样不能放行：订正保存会连带改写
  // 已清理考试留下的成绩快照，只看「有没有一场还在用」会把这份保留数据暴露出去。
  await db.run("INSERT INTO scanner_submissions(exam_id,session_id,group_id,student_number,state,pages_json) VALUES (?,?,?,'91001','saved','{}')",
    firstExam.lastInsertRowid, session.id, "0");
  await db.run("UPDATE exams SET created_by=? WHERE id IN (?,?)", owner.lastInsertRowid, firstExam.lastInsertRowid, secondExam.lastInsertRowid);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${ownerLogin.token}` } })).status, 404,
    "mixed archived + active bindings must still reject the archived receipt");
  // 记录级路由会连带删除共享的订正快照，同一会话不能被「还有一场在用考试」放行（评审 P1）。
  const boundRecord = await db.get<{ id: string }>("SELECT id FROM twain_scan_records WHERE session_id=? LIMIT 1", session.id);
  assert(boundRecord, "混绑场景仍有本机扫描记录");
  assert.equal((await fetch(`${fixture.baseUrl}/api/scanner/scan-image/${boundRecord.id}`, { headers: { Authorization: `Bearer ${ownerLogin.token}` } })).status, 404,
    "mixed bindings must not expose the archived session's original image");
  assert.equal((await fetch(`${fixture.baseUrl}/api/scanner/record/${boundRecord.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerLogin.token}` } })).status, 404,
    "mixed bindings must not allow deleting shared correction evidence");
  assert(await db.get("SELECT id FROM twain_scan_records WHERE id=?", boundRecord.id), "被拒的删除不得真的移除记录");
  await db.run("UPDATE exams SET created_by=NULL WHERE id IN (?,?)", firstExam.lastInsertRowid, secondExam.lastInsertRowid);
  await db.run("DELETE FROM scanner_submissions WHERE session_id=?", session.id);
  await db.run("DELETE FROM exam_archives WHERE exam_id=?", secondExam.lastInsertRowid);
  // 同一张答题卡被一场与本会话无关的在用考试复用：授权只看会话真正绑过的考试，
  // 不能因为那场无关考试的教师没有整卷授权就把正常归属人也挡在门外（评审 P2）。
  const thirdExam = await db.run("INSERT INTO exams(name,card_id,status) VALUES('同卡复用无关考试',?,'grading')", card.id);
  for (const examId of [firstExam.lastInsertRowid, secondExam.lastInsertRowid]) {
    await db.run("INSERT INTO scanner_submissions(exam_id,session_id,group_id,student_number,state,pages_json) VALUES (?,?,?,'91001','saved','{}')",
      examId, session.id, "0");
  }
  await db.run("UPDATE exams SET created_by=? WHERE id IN (?,?)", owner.lastInsertRowid, firstExam.lastInsertRowid, secondExam.lastInsertRowid);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${ownerLogin.token}` } })).status, 200,
    "reused-card exams must not be part of the authorization candidates when the session is already bound");
  // 订正文档、文档里的原图与进订正前必读的结果演算必须是同一套候选范围，
  // 否则页面能打开、图片却 403，或者根本点不进订正（评审 P2）。
  const authHeaders = { Authorization: `Bearer ${ownerLogin.token}` };
  const readProbe = async (path: string, init?: RequestInit) => {
    const response = await fetch(fixture.baseUrl + path, { ...init, headers: { ...authHeaders, ...(init?.headers ?? {}) } });
    return `${response.status} ${(await response.clone().text()).slice(0, 120)}`;
  };
  assert.equal((await fetch(`${fixture.baseUrl}/api/scanner/scan-image/${record.id}`, { headers: authHeaders })).status, 200,
    "订正文档里的原图必须与订正同范围放行");
  assert.match(await readProbe(`/api/scanner/session/${session.id}/results?previewOnly=1`), /^200 /,
    "远端模式后处理页的结果预览必须放行，否则进不去订正");
  assert.match(await readProbe(`/api/scanner/session/${session.id}/validate`, { method: "POST" }), /^200 /,
    "本机模式的结果演算必须放行，否则进不去订正");
  assert.match(await readProbe(`/api/scanner/session/${session.id}/results`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
    /^409 .*无法确定扫描会话的考试归属/, "正式入库仍要求唯一考试归属，不能被一起放开");
  await db.run("UPDATE exams SET created_by=NULL WHERE id IN (?,?)", firstExam.lastInsertRowid, secondExam.lastInsertRowid);
  await db.run("DELETE FROM scanner_submissions WHERE session_id=?", session.id);
  await db.run("DELETE FROM exams WHERE id=?", thirdExam.lastInsertRowid);
  await db.run("DELETE FROM exams WHERE id=?", secondExam.lastInsertRowid);
  await db.run("INSERT INTO exam_archives(exam_id,is_deleted,deleted_at) VALUES (?,1,CURRENT_TIMESTAMP)", firstExam.lastInsertRowid);
  assert.equal((await request("teacher")).status, 404, "a cleaned exam must not become an unbound local scan");
  // ── 扫描端 Key 的归档绑定门（评审 P1）────────────────────────────────────────
  // 机器分支过去只拒绝「全部绑定都被清理」，混合绑定照样放行：同一把 Key 能把已清理考试留下的
  // 成绩快照改写掉，等于给人用的 CR4 口径对扫描端不成立。
  const machineKey = String((await (await fetch(`${fixture.baseUrl}/test/fixture`)).json()).key);
  const keyHeaders = { "X-Api-Key": machineKey };
  const remoteUrl = url.replace("/session/", "/upload/sessions/");
  await db.run("DELETE FROM scanner_submissions WHERE session_id=?", session.id);
  const liveExam = await db.run("INSERT INTO exams(name,card_id,status) VALUES('Key 对照考试',?,'grading')", card.id);
  const liveSnapshot = JSON.stringify({ totalScore: 5, studentNumber: "91001" });
  await db.run("INSERT INTO scanner_submissions(exam_id,session_id,group_id,student_number,state,pages_json,score_snapshot) VALUES (?,?,?,'91001','saved','{}',?)",
    liveExam.lastInsertRowid, session.id, "0", liveSnapshot);
  const keyRead = await fetch(remoteUrl, { headers: keyHeaders });
  assert.equal(keyRead.status, 200, "正常归属下扫描 Key 仍要能读写远端整卡订正");
  const keyDoc = await keyRead.json() as CorrectionDocument;
  // 混合绑定：这场仍在用的考试 + 一场已按保留策略清理的考试同属一个会话。
  const cleanedSnapshot = JSON.stringify({ totalScore: 0, studentNumber: "91001" });
  await db.run("INSERT INTO scanner_submissions(exam_id,session_id,group_id,student_number,state,pages_json,score_snapshot) VALUES (?,?,?,'91001','saved','{}',?)",
    firstExam.lastInsertRowid, session.id, "0", cleanedSnapshot);
  assert.equal((await fetch(remoteUrl, { headers: keyHeaders })).status, 404,
    "扫描 Key 不得借「还有一场在用考试」读到已清理考试的订正文档");
  const keyWrite = await fetch(remoteUrl, { method: "PUT", headers: { ...keyHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ pages: keyDoc.pages.map(p => ({ sourceId: p.sourceId, revision: p.revision, selected: p.selected })) }) });
  assert.equal(keyWrite.status, 404, "扫描 Key 不得改写混合绑定里已清理考试的成绩快照");
  assert.equal((await db.get<{ score_snapshot: string }>("SELECT score_snapshot FROM scanner_submissions WHERE exam_id=? AND session_id=?",
    firstExam.lastInsertRowid, session.id))?.score_snapshot, cleanedSnapshot, "被拒的 Key 写入必须原样留下清理后的快照");
  assert.equal((await db.get<{ score_snapshot: string }>("SELECT score_snapshot FROM scanner_submissions WHERE exam_id=? AND session_id=?",
    liveExam.lastInsertRowid, session.id))?.score_snapshot, liveSnapshot, "被拒的 Key 写入同样不得改动在用考试的快照");
  console.log(`PASS scanner local correction: ${db.dialect}; authenticated card-only sync, image, draft persistence, stale edits, student/anonymous/remote/ambiguous/deleted scope, scanner-key archived-binding gate`);
} finally { await fixture.close(); }
