/** Exercise historical recovery through pending admission and subsequent edits. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import { cardFingerprint } from "../src/shared/cardVersion";
import { correctionCells, toggleCorrectionCell, type CorrectionDocument } from "../src/shared/scanCorrection";

const fixture = await startScannerFlowFixture(0,"127.0.0.1",{scoreEditing:true});
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb, getDatabase, initMariadbSchema } = await import("../src/server/db");
  const { runMigrations } = await import("../src/server/db/migrations");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const { recognizeSessionCorrection, recognizeStudentCorrection, sessionCorrection, storeCorrectionPage, studentCorrection, saveStudentCorrection } = await import("../src/server/services/scanCorrection");
  const { hasCorrectionProvenance } = await import("../src/server/services/scanCorrectionProvenance");
  const { processScannerSession } = await import("../src/server/services/scannerSubmissions");
  const { listPendingScans, confirmPendingScan } = await import("../src/server/services/scannerPending");
  const db = getMysqlDb(), card = (await new CardRepository().findById(info.cardId))!;
  const exam = (await db.get<{id:number}>("SELECT id FROM exams WHERE card_id=?",card.id))!;
  const admin = await db.run("INSERT INTO users(username,password_hash,name,role_id) VALUES ('legacy_admin','disabled','管理员',1)");
  // Upgrade a v63 database twice; existing snapshots must survive without invented evidence.
  await db.run("INSERT INTO scan_correction_pages(source_type,source_id,card_version,layout_json,recognition_json,revision) VALUES ('twain_scan_record','upgrade-only',?,'{}','{}',17)",cardFingerprint(card));
  await db.run("ALTER TABLE scan_correction_pages DROP COLUMN recovery_fingerprint");
  await db.run("DELETE FROM schema_migrations WHERE version=64");
  if (db.dialect === "sqlite") { runMigrations(getDatabase()); runMigrations(getDatabase()); }
  else { await initMariadbSchema(); await initMariadbSchema(); }
  const historical = await db.get<{revision:number;recovery_fingerprint:string|null}>("SELECT revision,recovery_fingerprint FROM scan_correction_pages WHERE source_id='upgrade-only'");
  assert.equal(Number(historical!.revision),17); assert.equal(historical!.recovery_fingerprint,null);
  await db.run("DELETE FROM exam_participants WHERE exam_id=? AND student_id IN (SELECT id FROM users WHERE student_number IN ('91009','91010'))",exam.id);
  const session = await store.createSession(card.id,"legacy isolated recovery");
  await db.run("UPDATE twain_scan_sessions SET card_version=NULL,version_source='legacy',status='completed' WHERE id=?",session.id);
  const bytes = await sharp({create:{width:2100,height:2970,channels:3,background:"white"}}).png().toBuffer();
  const identity = {status:"verified",code:"QR_VERIFIED",cardId:card.id,pageNumber:1} as const;
  const recognition = (number:string) => ({status:"ok" as const,pageNumber:1,identity,
    geometry:{imageWidth:2100,imageHeight:2970,imageToLayout:[.1,0,0,0,.1,0,0,0,1],layoutToImage:[10,0,0,0,10,0,0,0,1]},
    studentId:{status:"ok",value:number},questions:[{questionNumber:1,selectedOptions:["A"],confidence:1}],subjectiveQuestions:[]});
  const records = [];
  for (const [index,number] of ["91010","91009"].entries()) {
    const imagePath = path.join(process.env.ANSWER_CARD_DATA_DIR!,`legacy-${index}.png`); await writeFile(imagePath,bytes);
    const record = await store.createScanRecord({sessionId:session.id,cardId:card.id,pageNum:index+1,imagePath}); records.push(record);
    await db.run("UPDATE twain_scan_records SET student_id=?,identity_json=?,ocr_status='done' WHERE id=?",number,JSON.stringify(identity),record.id);
    await store.upsertRecognitionResult({scanRecordId:record.id,objectiveJson:JSON.stringify(recognition(number).questions),subjectiveJson:"[]"});
    // Reproduce the already-recovered production page without durable provenance.
    if(index===0) {
      const corrected = {...recognition(number),questions:[{questionNumber:1,selectedOptions:["B"],confidence:1}]};
      await storeCorrectionPage(card,"twain_scan_record",record.id,corrected);
      await store.upsertRecognitionResult({scanRecordId:record.id,objectiveJson:JSON.stringify(corrected.questions),subjectiveJson:"[]"});
      await db.run("UPDATE scan_correction_pages SET modified_by=? WHERE source_id=?",admin.lastInsertRowid,record.id);
    }
  }
  await processScannerSession(card,session.id,"save");
  const items = () => listPendingScans(exam.id);
  const current = async (groupId:string) => (await items()).find(x=>x.sessionId===session.id && x.groupId===groupId)!;
  const url = (groupId:string) => `${fixture.baseUrl}/api/scanner/upload/sessions/${session.id}/groups/${groupId}/correction`;
  const put = async (groupId:string,doc:CorrectionDocument) => {
    const res = await fetch(url(groupId),{method:"PUT",headers:{"X-Api-Key":info.key,"Content-Type":"application/json"},body:JSON.stringify({pages:doc.pages.map(p=>({sourceId:p.sourceId,revision:p.revision,selected:p.selected,touched:[],...(p.recovery?{recovery:{fingerprint:p.recovery.fingerprint,signature:p.recovery.signature,recognition:p.recognition}}:{})}))})});
    const body = await res.json(); return {status:res.status,body};
  };
  async function recover(groupId:string,number:string) {
    const doc = await sessionCorrection(card,session.id,groupId,true);
    assert(doc.pages.every(p=>p.recovery && !p.recognition.geometry));
    return recognizeSessionCorrection(card,session.id,groupId,{version:doc.version,pages:doc.pages.map(p=>({sourceId:p.sourceId,fingerprint:p.recovery!.fingerprint}))},async()=>recognition(number));
  }
  assert.match((await current("0")).issue!,/版本核验/);
  const stale = await current("0"), draft = await recover("0","91010");
  assert.deepEqual(draft.pages[0].recognition.questions[0].selectedOptions,["B"],"re-verifying a historical snapshot retains saved teacher marks");
  const unsigned = structuredClone(draft); unsigned.pages[0].recovery!.signature="0".repeat(64);
  assert.equal((await put("0",unsigned)).status,409);
  const saved = await put("0",draft); assert.equal(saved.status,200,JSON.stringify(saved)); assert.equal(saved.body.saved,false);
  let item = await current("0"); assert.equal(item.issue,undefined); assert.equal(item.proposedScore,0);
  assert.match((await current("1")).issue!,/版本核验/,"one recovered paper cannot certify its sibling");
  await db.run("UPDATE twain_scan_sessions SET card_version=?,version_source='legacy_verified' WHERE id=?",cardFingerprint(card),session.id);
  assert.equal((await current("0")).issue,undefined);
  assert.match((await current("1")).issue!,/版本核验/,"a historical caller-supplied version also needs per-paper recovery");
  await db.run("UPDATE twain_scan_sessions SET card_version=NULL,version_source='legacy' WHERE id=?",session.id);
  assert.equal((await db.get<{card_version:string|null}>("SELECT card_version FROM twain_scan_sessions WHERE id=?",session.id))!.card_version,null);
  const reopened = await sessionCorrection(card,session.id,"0",true); assert.equal(reopened.pages[0].recovery,undefined);
  await assert.rejects(confirmPendingScan(exam.id,session.id,"0","accept",stale.token,admin.lastInsertRowid,null),/已更新/);
  // Original image changes invalidate both an open approval and the stored proof.
  await writeFile(records[0].image_path,await sharp({create:{width:2100,height:2970,channels:3,background:"red"}}).png().toBuffer());
  assert.match((await current("0")).issue!,/凭据已失效/);
  await assert.rejects(confirmPendingScan(exam.id,session.id,"0","accept",item.token,admin.lastInsertRowid,null),/已更新/);
  assert((await sessionCorrection(card,session.id,"0",true)).pages[0].recovery);
  await writeFile(records[0].image_path,bytes);
  // A subsequent normal correction refreshes provenance along with the saved marks.
  const changed = await sessionCorrection(card,session.id,"0",true), page = changed.pages[0];
  const aCell = correctionCells(page.layout).find(c=>c.type==="objective_option" && c.option==="A")!;
  page.selected = toggleCorrectionCell(card,page,page.selected,aCell.id);
  assert.equal((await put("0",changed)).status,200);
  item = await current("0"); assert.equal(item.issue,undefined); assert.equal(item.proposedScore,5);
  await confirmPendingScan(exam.id,session.id,"0","accept",item.token,admin.lastInsertRowid,null);
  const score = await db.get<{total_score:number}>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=(SELECT id FROM users WHERE student_number='91010')",exam.id);
  assert.equal(Number(score!.total_score),5); assert.equal(await current("0"),undefined);
  const student = (await db.get<{id:number}>("SELECT id FROM users WHERE student_number='91010'"))!;
  const manual = await studentCorrection(card,exam.id,student.id), manualPage = manual.pages[0];
  const a = correctionCells(manualPage.layout).find(c=>c.type==="objective_option" && c.option==="A")!;
  await saveStudentCorrection(card,exam.id,student.id,[{sourceId:manualPage.sourceId,revision:manualPage.revision,selected:toggleCorrectionCell(card,manualPage,manualPage.selected,a.id)}],admin.lastInsertRowid);
  assert(await hasCorrectionProvenance(db,card,records[0].id),"later grade editing retains valid recovery evidence");
  const admittedScore = Number((await db.get<{total_score:number}>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,student.id))!.total_score);
  const proof = (await db.get<{recovery_fingerprint:string}>("SELECT recovery_fingerprint FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?",records[0].id))!.recovery_fingerprint;
  await db.run("UPDATE scan_correction_pages SET recovery_fingerprint=? WHERE source_type='twain_scan_record' AND source_id=?", "f".repeat(64), records[0].id);
  const staleDoc = await studentCorrection(card,exam.id,student.id), stalePage = staleDoc.pages[0];
  const optionB = correctionCells(stalePage.layout).find(c=>c.type==="objective_option" && c.option==="B")!;
  await assert.rejects(
    () => saveStudentCorrection(card,exam.id,student.id,[{sourceId:stalePage.sourceId,revision:stalePage.revision,selected:toggleCorrectionCell(card,stalePage,stalePage.selected,optionB.id)}],admin.lastInsertRowid),
    /凭据已失效/,
  );
  assert.equal(Number((await db.get<{total_score:number}>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,student.id))!.total_score), admittedScore, "stale recovery proof must not change the formal grade");
  assert.equal(await hasCorrectionProvenance(db,card,records[0].id), false);
  await db.run("UPDATE scan_correction_pages SET recovery_fingerprint=? WHERE source_type='twain_scan_record' AND source_id=?", proof, records[0].id);
  assert.equal(await hasCorrectionProvenance(db,card,records[0].id), true, "restoring the matching fingerprint makes the page editable again");
  // A saved legacy paper can re-verify through its existing, authorized score editor.
  const { hashPassword } = await import("../src/server/db");
  const { authService } = await import("../src/server/services/AuthService");
  const password = "Legacy-Reverify-Test-2026!", passwordHash = await hashPassword(password);
  await db.run("UPDATE users SET password_hash=? WHERE id IN (?,?)",passwordHash,admin.lastInsertRowid,student.id);
  const adminToken = (await authService.login("legacy_admin",password)).token!;
  const studentToken = (await authService.login("flow_91010",password)).token!;
  await db.run("INSERT INTO users(username,password_hash,name,role_id) VALUES ('legacy_outsider',?,'无关教师',2)",passwordHash);
  const outsiderToken = (await authService.login("legacy_outsider",password)).token!;
  const scoreUrl = `${fixture.baseUrl}/api/exams/${exam.id}/student/${student.id}/correction`;
  const scoreRequest = (method="GET",body?:unknown,token=adminToken,suffix="") => fetch(scoreUrl+suffix,{method,
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await fetch(scoreUrl+"/recognize",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,401);
  assert.equal((await scoreRequest("POST",{},studentToken,"/recognize")).status,403);
  assert.equal((await scoreRequest("POST",{},outsiderToken,"/recognize")).status,403);
  await writeFile(records[0].image_path,await sharp({create:{width:2100,height:2970,channels:3,background:"red"}}).png().toBuffer());
  const reverifyRead = await scoreRequest(); assert.equal(reverifyRead.status,200);
  const reverifyDoc = await reverifyRead.json() as CorrectionDocument;
  assert.equal(reverifyDoc.pages[0].recovery?.reason,"provenance");assert.equal(reverifyDoc.pages[0].recognition.geometry,undefined);
  assert.equal((await scoreRequest("POST",{},adminToken,"/recognize")).status,409,"recognition endpoint checks the requested source before running native work");
  assert.equal((await fetch(url("0"),{headers:{"X-Api-Key":info.key}})).status,409,"session recovery cannot bypass saved ownership");
  const recoverStudent = async () => {
    const doc = await studentCorrection(card,exam.id,student.id);
    return recognizeStudentCorrection(card,exam.id,student.id,{version:doc.version,pages:doc.pages.filter(p=>p.recovery).map(p=>({sourceId:p.sourceId,fingerprint:p.recovery!.fingerprint}))},async()=>recognition("91010"));
  };
  const reverifyEdits = (doc:CorrectionDocument) => ({pages:doc.pages.map(p=>({sourceId:p.sourceId,revision:p.revision,selected:p.selected,
    ...(p.recovery?{recovery:{fingerprint:p.recovery.fingerprint,signature:p.recovery.signature,recognition:p.recognition}}:{})}))});
  let reverified = await recoverStudent();
  const tampered = reverifyEdits(reverified);tampered.pages[0].recovery!.signature="0".repeat(64);
  assert.equal((await scoreRequest("PUT",tampered)).status,409);
  await writeFile(records[0].image_path,bytes);
  assert.equal((await scoreRequest("PUT",reverifyEdits(reverified))).status,409,"source replacement invalidates a signed saved-paper draft");
  // Force another real mismatch so re-verification is needed again.
  await writeFile(records[0].image_path,await sharp({create:{width:2100,height:2970,channels:3,background:"blue"}}).png().toBuffer());
  reverified = await recoverStudent();
  await db.run("UPDATE scanner_submissions SET state='discarded' WHERE session_id=? AND group_id='0'",session.id);
  assert.equal((await scoreRequest("PUT",reverifyEdits(reverified))).status,409,"a recovered draft cannot revive a discarded receipt");
  await db.run("UPDATE scanner_submissions SET state='saved' WHERE session_id=? AND group_id='0'",session.id);
  const beforeReverify = JSON.stringify(await db.all("SELECT * FROM question_scores WHERE exam_id=? AND student_id=?",exam.id,student.id));
  await db.run("UPDATE exams SET score_published=1 WHERE id=?",exam.id);
  const reverifySaved = await scoreRequest("PUT",reverifyEdits(reverified));assert.equal(reverifySaved.status,200,await reverifySaved.clone().text());
  assert.equal(JSON.stringify(await db.all("SELECT * FROM question_scores WHERE exam_id=? AND student_id=?",exam.id,student.id)),beforeReverify,"re-verification alone preserves existing manual grades");
  assert.equal(Number((await db.get<{score_published:number}>("SELECT score_published FROM exams WHERE id=?",exam.id))!.score_published),1);
  assert(await hasCorrectionProvenance(db,card,records[0].id));
  assert.equal((await studentCorrection(card,exam.id,student.id)).pages[0].recovery,undefined);
  assert(await db.get("SELECT id FROM answer_overrides WHERE exam_id=? AND new_value LIKE '%correction_reverify%'",exam.id));
  // A saved legacy page from before v64 has no fingerprint. It must not be editable
  // as an ordinary scan; signed re-recognition is the only way back.
  await db.run("UPDATE scan_correction_pages SET recovery_fingerprint=NULL WHERE source_type='twain_scan_record' AND source_id=?", records[0].id);
  const preMigration = await studentCorrection(card,exam.id,student.id);
  assert.equal(preMigration.pages[0].recovery?.reason,"provenance","pre-v64 saved legacy page needs signed re-recognition");
  const preMigrationCell = correctionCells(preMigration.pages[0].layout).find(c=>c.type==="objective_option" && c.option==="B")!;
  await assert.rejects(
    () => saveStudentCorrection(card,exam.id,student.id,[{sourceId:preMigration.pages[0].sourceId,revision:preMigration.pages[0].revision,selected:toggleCorrectionCell(card,preMigration.pages[0],preMigration.pages[0].selected,preMigrationCell.id)}],admin.lastInsertRowid),
    /凭据已失效/,
  );
  const preMigrationRecovered = await recoverStudent();
  await saveStudentCorrection(card,exam.id,student.id,reverifyEdits(preMigrationRecovered).pages,admin.lastInsertRowid);
  assert(await hasCorrectionProvenance(db,card,records[0].id),"signed re-recognition restores provenance for pre-v64 saved pages");
  assert.equal((await scoreRequest("PUT",reverifyEdits(reverified))).status,409,"re-verification increments the revision");
  assert.match((await current("1")).issue!,/版本核验/);
  const second = await recover("1","91009"); assert.equal((await put("1",second)).status,200);
  item = await current("1"); assert.equal(item.issue,undefined);
  await confirmPendingScan(exam.id,session.id,"1","accept",item.token,admin.lastInsertRowid,null);
  assert.equal((await items()).length,0);
  // When two never-saved originals conflict, correcting one must leave the other
  // visible as pending even though it has no withdrawn-score snapshot.
  const duplicates = await store.createSession(card.id,"legacy duplicate originals");
  await db.run("UPDATE twain_scan_sessions SET card_version=NULL,version_source='legacy',status='completed' WHERE id=?",duplicates.id);
  for (let i=0;i<2;i++) {
    const imagePath=path.join(process.env.ANSWER_CARD_DATA_DIR!,`duplicate-${i}.png`);await writeFile(imagePath,bytes);
    const record=await store.createScanRecord({sessionId:duplicates.id,cardId:card.id,pageNum:i+1,imagePath});
    await db.run("UPDATE twain_scan_records SET student_id='91007',identity_json=?,ocr_status='done' WHERE id=?",JSON.stringify(identity),record.id);
    await store.upsertRecognitionResult({scanRecordId:record.id,objectiveJson:JSON.stringify(recognition("91007").questions),subjectiveJson:"[]"});
  }
  await processScannerSession(card,duplicates.id,"save");
  for (const [groupId,number] of ["91008","91007"].entries()) {
    const group=String(groupId), doc=await sessionCorrection(card,duplicates.id,group,true);
    const draft=await recognizeSessionCorrection(card,duplicates.id,group,{version:doc.version,pages:doc.pages.map(p=>({sourceId:p.sourceId,fingerprint:p.recovery!.fingerprint}))},async()=>recognition(number));
    const response=await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${duplicates.id}/groups/${group}/correction`,{method:"PUT",headers:{"X-Api-Key":info.key,"Content-Type":"application/json"},body:JSON.stringify({pages:draft.pages.map(p=>({sourceId:p.sourceId,revision:p.revision,selected:p.selected,recovery:{fingerprint:p.recovery!.fingerprint,signature:p.recovery!.signature,recognition:p.recognition}}))})});
    assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).saved,true);
    if(groupId===0) {
      const remaining=(await items()).find(x=>x.sessionId===duplicates.id&&x.groupId==="1");
      assert(remaining,"remaining never-saved original stays in the web queue");assert.equal(remaining.reason,"correction");
      assert.equal((await db.get<{state:string}>("SELECT state FROM scanner_submissions WHERE session_id=? AND group_id='1'",duplicates.id))!.state,"correction");
    }
  }
  assert.equal((await items()).length,0);
  // Ordinary validation and partial saves do not create false exception warnings.
  const normal = await store.createSession(card.id,"validate without exceptions");
  await db.run("UPDATE twain_scan_sessions SET card_version=?,version_source='upload',status='completed' WHERE id=?",cardFingerprint(card),normal.id);
  for (const [index,number] of ["91001","91002"].entries()) {
    const imagePath=path.join(process.env.ANSWER_CARD_DATA_DIR!,`normal-${index}.png`);await writeFile(imagePath,bytes);
    const record=await store.createScanRecord({sessionId:normal.id,cardId:card.id,pageNum:index+1,imagePath});
    await db.run("UPDATE twain_scan_records SET student_id=?,identity_json=?,ocr_status='done' WHERE id=?",number,JSON.stringify(identity),record.id);
    await store.upsertRecognitionResult({scanRecordId:record.id,objectiveJson:JSON.stringify(recognition(number).questions),subjectiveJson:"[]"});
  }
  assert.equal((await processScannerSession(card,normal.id,"validate")).failures.length,0);
  assert.equal((await items()).length,0,"validate-only pending receipts stay out of exception list");
  await processScannerSession(card,normal.id,"save",undefined,new Set(["0"]));
  assert.equal((await items()).length,0,"unselected ordinary papers stay out of exception list after partial save");
  const complete = await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${session.id}/complete`,{method:"POST",headers:{"X-Api-Key":info.key,"Content-Type":"application/json"},body:"{}"});
  assert.equal(complete.status,409); assert.equal((await complete.json()).code,"SESSION_CARD_VERSION_UNKNOWN");
  await db.run("UPDATE twain_scan_sessions SET card_version=?,version_source='upload' WHERE id=?","0".repeat(24),session.id);
  await assert.rejects(sessionCorrection(card,session.id,"0",true),/版本已变化/);
  console.log(`PASS legacy correction (${db.dialect}): v63 upgrade, signed recovery, saved-paper re-verification and authorization, stale source/receipt rejection, grade preservation, ordinary pending exclusion, resolved duplicate retention and unknown-session upload guard`);
} finally { await fixture.close(); }
