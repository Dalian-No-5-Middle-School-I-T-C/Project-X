import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { recoverCorrectionDocument } from "../src/apps/answer-card/client/lib/scanCorrectionRecovery";
import assert from "node:assert/strict";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import { buildLayout } from "../src/shared/layout";
import { cardFingerprint } from "../src/shared/cardVersion";
import { createDefaultCard } from "../src/shared/defaultCard";
import { correctionCells, correctionState, evaluateScoreCells, projectRect, recognizedCells, toggleCorrectionCell, type CorrectionPage } from "../src/shared/scanCorrection";
import type { CombinedRecognitionResult } from "../src/shared/types";

const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const {getMysqlDb} = await import("../src/server/db");
  const {CardRepository} = await import("../src/server/repositories/CardRepository");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const {recognizeSessionCorrection,storeCorrectionPage,studentCorrection,saveStudentCorrection,sessionCorrection,saveSessionCorrection} = await import("../src/server/services/scanCorrection");
  const {processScannerSession} = await import("../src/server/services/scannerSubmissions");
  const db = getMysqlDb(), repo = new CardRepository();
  const card = (await repo.findById(info.cardId))!;
  card.studentInfo.studentNumberDigits = 5;
  card.bodyBlocks.push({id:"manual",type:"subjective",title:"手阅",questions:[{id:"q2",number:2,score:30,style:"manual_score_grid",kind:"plain_box",minHeightMm:30}]});
  await repo.updateCard(card);
  const current = (await repo.findById(card.id))!;
  const layout = buildLayout(current).pages[0];
  const cells = correctionCells(layout);
  const session = await store.createSession(card.id,"整卡改分隔离验证");
  await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=?,version_source='upload' WHERE id=?",cardFingerprint(current),session.id);
  const record = await store.createScanRecord({sessionId:session.id,cardId:card.id,pageNum:1,imagePath:"test.png"});
  const identity = {status:"verified",code:"QR_VERIFIED",cardId:card.id,pageNumber:1} as const;
  const ten = cells.find(c => c.type === "score_cell" && c.score===10)!;
  const recognition:CombinedRecognitionResult = {status:"ok",pageNumber:1,identity,
    geometry:{imageWidth:2100,imageHeight:2970,imageToLayout:[.1,0,0,0,.1,0,0,0,1],layoutToImage:[10,0,0,0,10,0,0,0,1]},
    studentId:{status:"ok",value:"91001"},questions:[{questionNumber:1,selectedOptions:["B"],confidence:1}],
    subjectiveQuestions:[{blockId:"manual",questionId:"q2",questionNumber:2,maxScore:30,score:10,status:"ok",confidence:1,validCells:[{score:10,rect:ten.rect}],invalidCells:[]}]};
  await db.run("UPDATE twain_scan_records SET identity_json=?,student_id='91001',ocr_status='done' WHERE id=?",JSON.stringify(identity),record.id);
  await store.upsertRecognitionResult({scanRecordId:record.id,objectiveJson:JSON.stringify(recognition.questions),subjectiveJson:JSON.stringify(recognition.subjectiveQuestions)});
  await storeCorrectionPage(current,"twain_scan_record",record.id,recognition);
  const firstRevision = (await db.get<{revision:number}>("SELECT revision FROM scan_correction_pages WHERE source_id=?",record.id))!.revision;
  await storeCorrectionPage(current,"twain_scan_record",record.id,recognition);
  assert.equal(Number((await db.get<{revision:number}>("SELECT revision FROM scan_correction_pages WHERE source_id=?",record.id))!.revision),Number(firstRevision)+1,"re-recognition invalidates existing drafts even in the same millisecond");
  const sibling = await store.createScanRecord({sessionId:session.id,cardId:card.id,pageNum:2,imagePath:"sibling.png"});
  await db.run("UPDATE twain_scan_records SET identity_json=?,student_id='91003',ocr_status='done' WHERE id=?",JSON.stringify(identity),sibling.id);
  await store.upsertRecognitionResult({scanRecordId:sibling.id,objectiveJson:JSON.stringify(recognition.questions),subjectiveJson:JSON.stringify(recognition.subjectiveQuestions)});
  const url = `${fixture.baseUrl}/api/scanner/upload/sessions/${session.id}/groups/0/correction`;
  const request = (method="GET",body?:unknown) => fetch(url,{method,headers:{"X-Api-Key":info.key,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  const read = await request(); assert.equal(read.status,200,await read.clone().text());
  const doc = await read.json(); const page:CorrectionPage = doc.pages[0];
  assert.equal(page.selected.filter(id=>cells.find(c=>c.id===id)?.type==="student_digit").length,5);
  const a = cells.find(c=>c.type==="objective_option" && c.option==="A")!, b=cells.find(c=>c.type==="objective_option" && c.option==="B")!;
  assert(correctionState(current,page,page.selected).invalid.has(b.id));
  const selected = toggleCorrectionCell(current,page,page.selected,a.id);
  assert(selected.includes(a.id) && !selected.includes(b.id));
  assert(!correctionState(current,page,selected).invalid.has(a.id));
  const cleared = toggleCorrectionCell(current,page,selected,a.id);
  assert.deepEqual(correctionState(current,page,cleared).recognition.questions[0].selectedOptions,[],"single-choice false positive can be cleared");
  const digit = cells.find(c=>c.type==="student_digit" && selected.includes(c.id))!;
  assert(toggleCorrectionCell(current,page,selected,digit.id).includes(digit.id),"student digit stays mandatory");
  assert.equal((await db.get<{objective_json:string}>("SELECT objective_json FROM twain_recognition_results WHERE scan_record_id=?",record.id))!.objective_json,JSON.stringify(recognition.questions),"draft does not write");
  const edit = {sourceId:page.sourceId,revision:page.revision,selected};
  const saved = await request("PUT",{pages:[edit]}); assert.equal(saved.status,200,await saved.clone().text());
  assert.equal((await db.all("SELECT * FROM student_scores")).length,1,"saving the edited card must not save its sibling");
  assert.equal((await request("PUT",{pages:[edit]})).status,409,"stale edits rejected");
  assert.equal((await fetch(url)).status,401,"anonymous edits unavailable");
  const result = await processScannerSession(current,session.id,"save");
  assert.equal(result.results[0]?.saved,true,JSON.stringify(result));
  const exam = (await db.get<{id:number}>("SELECT id FROM exams WHERE card_id=?",card.id))!;
  const student = (await db.get<{id:number}>("SELECT id FROM users WHERE student_number='91001'"))!;
  await db.run("UPDATE question_scores SET score=17,manually_modified=1 WHERE exam_id=? AND student_id=? AND score_type='subjective'",exam.id,student.id);
  await db.run("UPDATE student_scores SET subjective_score=17,total_score=22 WHERE exam_id=? AND student_id=?",exam.id,student.id);
  await db.run("UPDATE exams SET score_published=1 WHERE id=?",exam.id);
  await db.run("INSERT INTO review_sessions (teacher_id,exam_id,block_id,current_index,draft_scores) VALUES (?,?,'manual',3,'{\"2\":17}')",student.id,exam.id);
  const reviewBefore = JSON.stringify(await db.all("SELECT * FROM review_sessions"));
  const scoreDoc = await studentCorrection(current,exam.id,student.id);
  const scorePage = scoreDoc.pages[0];
  const scoreEdit = {sourceId:scorePage.sourceId,revision:scorePage.revision,selected:toggleCorrectionCell(current,scorePage,scorePage.selected,b.id)};
  // A broken enabled formula must roll back the entire correction, including its revision.
  await db.run("UPDATE exams SET assigned_formula=? WHERE id=?",JSON.stringify({enabled:true,type:"linear"}),exam.id);
  const beforeFailure = JSON.stringify(await db.all("SELECT * FROM student_scores WHERE exam_id=?",exam.id));
  const questionsBeforeFailure = JSON.stringify(await db.all("SELECT * FROM question_scores WHERE exam_id=?",exam.id));
  const overridesBeforeFailure = JSON.stringify(await db.all("SELECT * FROM answer_overrides WHERE exam_id=?",exam.id));
  await assert.rejects(saveStudentCorrection(current,exam.id,student.id,[scoreEdit],null),/赋分重算失败，改分未保存/);
  assert.equal(JSON.stringify(await db.all("SELECT * FROM student_scores WHERE exam_id=?",exam.id)),beforeFailure);
  assert.equal(JSON.stringify(await db.all("SELECT * FROM question_scores WHERE exam_id=?",exam.id)),questionsBeforeFailure);
  assert.equal(JSON.stringify(await db.all("SELECT * FROM answer_overrides WHERE exam_id=?",exam.id)),overridesBeforeFailure);
  assert.equal((await studentCorrection(current,exam.id,student.id)).pages[0].revision,scorePage.revision);
  await db.run("UPDATE exams SET assigned_formula=NULL WHERE id=?",exam.id);
  await saveStudentCorrection(current,exam.id,student.id,[scoreEdit],null);
  let total = await db.get<{total_score:number;subjective_score:number}>("SELECT total_score,subjective_score FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,student.id);
  assert.equal(total?.total_score,17); assert.equal(total?.subjective_score,17,"unrelated manual/review score preserved");
  assert.equal(JSON.stringify(await db.all("SELECT * FROM review_sessions")),reviewBefore);
  assert.equal(Number((await db.get<{score_published:number}>("SELECT score_published FROM exams WHERE id=?",exam.id))!.score_published),1);
  await processScannerSession(current,session.id,"save");
  total = await db.get("SELECT total_score,subjective_score FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,student.id);
  assert.equal(total?.total_score,17,"scanner replay preserves corrected score");
  await assert.rejects(saveStudentCorrection(current,exam.id,student.id,[scoreEdit],null),/已更新/);
  const reopened = await studentCorrection(current,exam.id,student.id);
  assert(reopened.pages[0].selected.includes(b.id));
  const emptyPage = reopened.pages[0];
  await saveStudentCorrection(current,exam.id,student.id,[{sourceId:emptyPage.sourceId,revision:emptyPage.revision,selected:toggleCorrectionCell(current,emptyPage,emptyPage.selected,b.id)}],null);
  const emptyDoc = await studentCorrection(current,exam.id,student.id);
  assert.deepEqual(emptyDoc.pages[0].recognition.questions[0].selectedOptions,[],"blank single-choice persists after reopening");
  assert.equal(Number((await db.get<{score:number}>("SELECT score FROM question_scores WHERE exam_id=? AND student_id=? AND score_type='objective'",exam.id,student.id))!.score),0);
  assert.equal(JSON.stringify(await db.all("SELECT * FROM review_sessions")),reviewBefore);
  // Published conflicting originals retain human scores in a snapshot; edited marks must
  // update that snapshot, otherwise recovery silently loses the correction.
  const duplicateSession = await store.createSession(card.id,"duplicate");
  await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=?,version_source='upload' WHERE id=?",cardFingerprint(current),duplicateSession.id);
  const duplicate = await store.createScanRecord({sessionId:duplicateSession.id,cardId:card.id,pageNum:1,imagePath:"different.png"});
  await db.run("UPDATE twain_scan_records SET identity_json=?,student_id='91001',ocr_status='done' WHERE id=?",JSON.stringify(identity),duplicate.id);
  await store.upsertRecognitionResult({scanRecordId:duplicate.id,objectiveJson:JSON.stringify(recognition.questions),subjectiveJson:JSON.stringify(recognition.subjectiveQuestions)});
  await storeCorrectionPage(current,"twain_scan_record",duplicate.id,recognition);
  await processScannerSession(current,duplicateSession.id,"validate");
  assert.equal(await db.get("SELECT id FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,student.id),null);
  const conflicted = (await sessionCorrection(current,session.id,"0",false)).pages[0];
  await saveSessionCorrection(current,session.id,"0",[{sourceId:conflicted.sourceId,revision:conflicted.revision,selected:toggleCorrectionCell(current,conflicted,conflicted.selected,a.id)}],null);
  // Even while duplicate resolution is incomplete, a saved teacher correction is protected from late upload retries.
  await db.run("UPDATE twain_scan_sessions SET status='incomplete' WHERE id=?",session.id);
  const correctedBefore = JSON.stringify(await db.get("SELECT * FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?",record.id));
  const lateUpload = new FormData(); lateUpload.set("token",record.id); lateUpload.set("pageNum","1");
  lateUpload.set("image",new Blob([Buffer.from(info.images.original,"base64")],{type:"image/png"}),"late.png");
  lateUpload.set("recognition",JSON.stringify(recognition));
  const lateResponse = await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${session.id}/pages`,{method:"POST",headers:{"X-Api-Key":info.key},body:lateUpload});
  assert.equal(lateResponse.status,409);
  assert.equal((await lateResponse.json()).code,"SCAN_PAGE_CORRECTED");
  assert.equal(JSON.stringify(await db.get("SELECT * FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?",record.id)),correctedBefore);
  const snapshot = JSON.parse((await db.get<{score_snapshot:string}>("SELECT score_snapshot FROM scanner_submissions WHERE session_id=? AND group_id='0'",session.id))!.score_snapshot);
  assert.equal(snapshot.score.total_score,22); assert.equal(snapshot.score.subjective_score,17);
  const duplicatePage = (await sessionCorrection(current,duplicateSession.id,"0",false)).pages[0];
  const digit2 = correctionCells(duplicatePage.layout).find(c=>c.type==="student_digit" && c.digitIndex===4 && c.digit===2)!;
  await saveSessionCorrection(current,duplicateSession.id,"0",[{sourceId:duplicatePage.sourceId,revision:duplicatePage.revision,selected:toggleCorrectionCell(current,duplicatePage,duplicatePage.selected,digit2.id)}],null);
  await processScannerSession(current,duplicateSession.id,"validate");
  assert.equal((await processScannerSession(current,session.id,"save")).results[0]?.saved,true);
  assert.equal(Number((await db.get<{total_score:number}>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,student.id))!.total_score),22,"snapshot restores corrected answer and unrelated manual score");
  // An uploaded legacy scan obtains alignment only through a local, read-only draft.
  const recoverySession = await store.createSession(card.id,"remote recovery");
  await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=?,version_source='upload' WHERE id=?",cardFingerprint(current),recoverySession.id);
  const recoveryImage = path.join(process.env.ANSWER_CARD_DATA_DIR!,"recovery.png");
  const imageBytes = await sharp({create:{width:2100,height:2970,channels:3,background:"white"}}).png().toBuffer();
  await writeFile(recoveryImage,imageBytes);
  const recoveryRecord = await store.createScanRecord({sessionId:recoverySession.id,cardId:card.id,pageNum:1,imagePath:recoveryImage});
  await db.run("UPDATE twain_scan_records SET ocr_status='failed',ocr_error='old recognizer' WHERE id=?",recoveryRecord.id);
  const recoveryUrl = `${fixture.baseUrl}/api/scanner/upload/sessions/${recoverySession.id}/groups/0/correction`;
  const recoverRequest = (method="GET",body?:unknown) => fetch(recoveryUrl,{method,headers:{"X-Api-Key":info.key,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  const missingResponse = await recoverRequest(); assert.equal(missingResponse.status,200,await missingResponse.clone().text());
  const missing = await missingResponse.json();
  assert(missing.pages[0].recovery); assert(!missing.pages[0].recognition.geometry);
  let nativeCalls=0;
  const restoredRecognition: CombinedRecognitionResult = {...recognition,status:"failed",studentId:{status:"failed",value:null,
    digits:Array.from({length:5},(_,digitIndex)=>({digitIndex,selectedDigit:digitIndex===0 || digitIndex===4 ? null : Number("91004"[digitIndex]),
      selectedDigits:digitIndex===0 ? [] : digitIndex===4 ? [3,4] : [Number("91004"[digitIndex])]}))}};
  const draft = await recoverCorrectionDocument(missing,recoveryUrl,async (url,init)=>{
    assert.equal(url,`${recoveryUrl}/recognize`); assert.equal(init?.method,"POST");
    const result = await recognizeSessionCorrection(current,recoverySession.id,"0",JSON.parse(init!.body as string),async request=>{
      assert.equal(request.imagePath,recoveryImage); assert.equal(request.cropsDir,undefined); nativeCalls++;
      return restoredRecognition;
    });
    return Response.json(result);
  });
  assert.equal(nativeCalls,1);
  assert.equal(draft.pages[0].recognition.status,"partial","valid positioning with failed student marks becomes an editable draft");
  assert.equal(draft.pages[0].recognition.studentId?.status,"failed");
  assert.equal((await fetch(`${recoveryUrl}/recognize`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,401,"recognition requires existing scanner authorization");
  await recoverCorrectionDocument(draft,recoveryUrl,async()=>{throw new Error("must not recognize existing geometry");});
  assert.equal(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_id=?",recoveryRecord.id),null,"canceling recovery must not store metadata");
  assert.equal((await db.get<{ocr_status:string}>("SELECT ocr_status FROM twain_scan_records WHERE id=?",recoveryRecord.id))!.ocr_status,"failed");
  const rp = draft.pages[0];
  const redit = {sourceId:rp.sourceId,revision:0,selected:toggleCorrectionCell(current,rp,rp.selected,a.id),recovery:{fingerprint:rp.recovery!.fingerprint,signature:rp.recovery!.signature,recognition:rp.recognition}};
  const incomplete = await recoverRequest("PUT",{pages:[redit]});
  assert.equal(incomplete.status,409);
  assert.match((await incomplete.json()).message,/学号第/);
  assert.equal(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_id=?",recoveryRecord.id),null,"invalid student marks roll back recovery metadata");
  for (const digitIndex of [0,4]) {
    const digit = cells.find(c=>c.type==="student_digit" && c.digitIndex===digitIndex && c.digit===Number("91004"[digitIndex]))!;
    redit.selected = toggleCorrectionCell(current,rp,redit.selected,digit.id);
  }
  assert.equal((await recoverRequest("PUT",{pages:[{...redit,recovery:{...redit.recovery,signature:undefined}}]})).status,409,"unsigned client recognition is rejected");
  const wrongIdentity = structuredClone(redit); wrongIdentity.recovery.recognition.identity!.cardId="wrong";
  assert.equal((await recoverRequest("PUT",{pages:[wrongIdentity]})).status,409,"recovery identity cannot bypass QR checks");
  const wrongGeometry = structuredClone(redit); wrongGeometry.recovery.recognition.geometry!.imageWidth++;
  assert.equal((await recoverRequest("PUT",{pages:[wrongGeometry]})).status,409,"geometry must match original image size");
  assert.equal(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_id=?",recoveryRecord.id),null,"failed save rolls back metadata");
  await db.run("UPDATE twain_scan_records SET ocr_error='changed' WHERE id=?",recoveryRecord.id);
  assert.equal((await recoverRequest("PUT",{pages:[redit]})).status,409,"stale recovery draft rejected");
  const refreshed = await (await recoverRequest()).json(); redit.recovery.fingerprint=refreshed.pages[0].recovery.fingerprint;
  assert.equal((await recoverRequest("PUT",{pages:[redit]})).status,409,"a known new fingerprint cannot rebind an old signature");
  const recoveryInput = {version:refreshed.version,pages:[{sourceId:rp.sourceId,fingerprint:redit.recovery.fingerprint}]};
  await assert.rejects(recognizeSessionCorrection(current,recoverySession.id,"0",recoveryInput,async()=>({...restoredRecognition,geometry:undefined})),/geometry/);
  await assert.rejects(recognizeSessionCorrection(current,recoverySession.id,"0",recoveryInput,async()=>({...restoredRecognition,studentId:{status:"ok",value:"91004"}})),/无法生成订正草稿/);
  await assert.rejects(recognizeSessionCorrection(current,recoverySession.id,"0",recoveryInput,async()=>wrongGeometry.recovery.recognition),/尺寸/);
  await assert.rejects(recognizeSessionCorrection(current,recoverySession.id,"0",recoveryInput,async()=>wrongIdentity.recovery.recognition),/二维码/);
  const freshDraft = await recognizeSessionCorrection(current,recoverySession.id,"0",recoveryInput,async()=>restoredRecognition);
  redit.recovery.signature=freshDraft.pages[0].recovery!.signature;
  const recoverySaved = await recoverRequest("PUT",{pages:[redit]}); assert.equal(recoverySaved.status,200,await recoverySaved.clone().text());
  assert.equal((await recoverySaved.json()).saved,true);
  assert.equal((await recoverRequest("PUT",{pages:[redit]})).status,409,"recovery cannot overwrite an existing snapshot");
  assert((await db.get("SELECT source_id FROM scan_correction_pages WHERE source_id=?",recoveryRecord.id)));
  assert.equal((await db.get<{student_id:string}>("SELECT student_id FROM twain_scan_records WHERE id=?",recoveryRecord.id))!.student_id,"91004","corrected student number is persisted");
  assert.equal(JSON.stringify(await db.all("SELECT * FROM review_sessions")),reviewBefore,"recovery leaves online review unchanged");
  const multi = structuredClone(current); (multi.bodyBlocks[0] as any).mode="multiple"; (multi.bodyBlocks[0] as any).answerKey={1:["A","C"]}; (multi.bodyBlocks[0] as any).questions=[{questionNumber:1,mode:"multiple",answerKey:["A","C"],optionCount:4,score:5}];
  const multiSelected = toggleCorrectionCell(multi,page,page.selected,a.id);
  const mixed = correctionState(multi,page,multiSelected);
  assert(!mixed.invalid.has(a.id) && mixed.invalid.has(b.id));
  assert(!toggleCorrectionCell(multi,page,multiSelected,b.id).includes(b.id));
  const scoreCells = cells.filter((c):c is Extract<typeof c,{type:"score_cell"}>=>c.type==="score_cell");
  const values = (numbers:number[]) => scoreCells.filter(c=>numbers.includes(c.score));
  const invalid = evaluateScoreCells(values([10,20,3,.5]),30);
  assert.equal(invalid.invalid.size,2,"only conflicting tens marked red");
  assert.equal(evaluateScoreCells(values([20,3,.5]),30).score,23.5);
  assert.equal(evaluateScoreCells(values([30,1]),30).valid,false);
  assert.equal(evaluateScoreCells([],30).valid,false);
  assert.equal(projectRect({x:1,y:2,width:3,height:4},[0,-10,100,10,0,0,0,0,1]),"80,10 80,40 40,40 40,10","rotation maps all four corners");
  const noisy = structuredClone(page); noisy.recognition.subjectiveQuestions[0].invalidCells=[{score:10,rect:ten.rect}]; noisy.recognition.subjectiveQuestions[0].validCells=[];
  Object.assign(noisy,recognizedCells(noisy.layout,noisy.recognition));
  assert(correctionState(current,noisy,noisy.selected).invalid.has(ten.id));
  assert(!correctionState(current,noisy,noisy.selected,[ten.id]).invalid.has(ten.id),"explicit selection repairs detected invalid line");
  // Saving one corrected card must not admit unrelated siblings to the receipt
  // conflict pass, even when a sibling duplicates an already-saved student.
  async function correctionBatch(numbers:string[]) {
    const batch = await store.createSession(card.id,"targeted correction safety");
    await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=?,version_source='upload' WHERE id=?",cardFingerprint(current),batch.id);
    for (const [index,number] of numbers.entries()) {
      const row = await store.createScanRecord({sessionId:batch.id,cardId:card.id,pageNum:index+1,imagePath:`targeted-${index}.png`});
      await db.run("UPDATE twain_scan_records SET identity_json=?,student_id=?,ocr_status='done' WHERE id=?",JSON.stringify(identity),number,row.id);
      await store.upsertRecognitionResult({scanRecordId:row.id,objectiveJson:JSON.stringify(recognition.questions),subjectiveJson:JSON.stringify(recognition.subjectiveQuestions)});
      await storeCorrectionPage(current,"twain_scan_record",row.id,{...recognition,studentId:{status:"ok",value:number}});
    }
    return batch;
  }
  async function saveFirstCard(batchId:string) {
    const document = await sessionCorrection(current,batchId,"0",false), p=document.pages[0];
    return saveSessionCorrection(current,batchId,"0",[{sourceId:p.sourceId,revision:p.revision,selected:toggleCorrectionCell(current,p,p.selected,a.id)}],null);
  }
  const protectedOriginal = async()=>JSON.stringify(await Promise.all([
    db.all("SELECT objective_score,subjective_score,total_score,manually_modified,modified_by,modified_at FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,student.id),
    db.all("SELECT * FROM question_scores WHERE exam_id=? AND student_id=? ORDER BY id",exam.id,student.id),
    db.all("SELECT * FROM scanner_submissions WHERE exam_id=? AND student_number='91001' ORDER BY session_id,group_id",exam.id),
    db.all("SELECT * FROM answer_block_crops WHERE exam_id=? AND student_id=? ORDER BY id",exam.id,student.id),
    db.all("SELECT * FROM review_sessions ORDER BY id"),
  ]));
  await db.run(`INSERT INTO answer_block_crops
    (id,card_id,exam_id,student_id,source_type,source_record_id,block_id,block_type,page_number,segment_index,question_numbers,image_path,width_px,height_px,dpi,rect_json)
    VALUES ('targeted-protected-crop',?,?,?,'twain_scan_record',?,'manual','subjective',1,0,'[2]','protected-crop.png',1,1,300,'{}')`,card.id,exam.id,student.id,record.id);
  const unrelatedDuplicate = await correctionBatch(["91006","91001"]);
  const originalBefore = await protectedOriginal();
  assert.equal((await saveFirstCard(unrelatedDuplicate.id)).saved,true);
  assert.equal(await protectedOriginal(),originalBefore,"targeted correction must preserve an unrelated saved student's manual grades, receipts, crops and review data");
  assert.equal(await db.get("SELECT group_id FROM scanner_submissions WHERE session_id=? AND group_id='1'",unrelatedDuplicate.id),null,"unrequested unrelated sibling gets no receipt");
  const genuineDuplicate = await correctionBatch(["91002","91002"]);
  assert.equal((await saveFirstCard(genuineDuplicate.id)).saved,false,"target's actual duplicate must still block admission");
  assert.equal((await db.all("SELECT group_id FROM scanner_submissions WHERE session_id=? AND state='conflict'",genuineDuplicate.id)).length,2,"both locally conflicting papers enter review");
  const duplicateOwner = (await db.get<{id:number}>("SELECT id FROM users WHERE student_number='91002'"))!;
  assert.equal(await db.get("SELECT id FROM student_scores WHERE exam_id=? AND student_id=?",exam.id,duplicateOwner.id),null,"genuine conflict still withdraws the matching saved grade");
  assert.equal(await protectedOriginal(),originalBefore,"genuine conflict leaves unrelated saved student intact");
  const { ExamRepository } = await import("../src/server/repositories/ExamRepository");
  const examRepo = new ExamRepository(db);
  const historicalExam = await examRepo.createExam({name:"correction history",card_id:card.id});
  const historyStudent = (await db.get<{id:number}>("SELECT id FROM users WHERE student_number='91005'"))!;
  const historyIds:number[]=[];
  for (const status of ["done","partial","error"] as const) {
    const batch = await examRepo.createScanBatch(historicalExam.id,status);
    const id = await examRepo.addScanRecord({batch_id:batch,file_path:"history.png",file_name:"history.png",student_id:historyStudent.id,student_number:"91005"});
    await storeCorrectionPage(current,"scan_record",id,{...recognition,studentId:{status:"ok",value:"91005"}});
    await examRepo.finishBatchWithOutcome(batch,status,status==="error"?0:1,status==="done"?0:1,null);
    historyIds.push(id);
  }
  const latestDocument = await studentCorrection(current,historicalExam.id,historyStudent.id);
  assert.deepEqual(latestDocument.pages.map(p=>p.sourceId),[String(historyIds[1])],"latest successful student batch excludes old and failed runs");
  const deletingSession = await store.createSession(card.id,"snapshot deletion");
  const deletingRecords=[];
  for(let i=1;i<=2;i++) {
    const row = await store.createScanRecord({sessionId:deletingSession.id,cardId:card.id,pageNum:i,imagePath:"delete.png"});
    await storeCorrectionPage(current,"twain_scan_record",row.id,recognition); deletingRecords.push(row.id);
  }
  await store.deleteScanRecord(deletingRecords[0]);
  assert.equal(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?",deletingRecords[0]),null);
  assert(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_id=?",deletingRecords[1]),"individual deletion keeps sibling snapshot");
  await store.deleteSession(deletingSession.id);
  assert.equal(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_id=?",deletingRecords[1]),null,"session deletion clears cascaded snapshots");
  await db.run("UPDATE exams SET status='closed' WHERE id=?",historicalExam.id);
  await db.run("UPDATE scan_records SET expires_at='2000-01-01 00:00:00',file_path=NULL WHERE id=?",historyIds[0]);
  const { runCleanup } = await import("../src/server/db/cleanup");
  assert.deepEqual((await runCleanup()).errors,[]);
  assert.equal(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_type='scan_record' AND source_id=?",String(historyIds[0])),null,"retention cleanup clears expired recognition snapshot");
  assert(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_type='scan_record' AND source_id=?",String(historyIds[1])),"retention keeps current scan");
  const { deleteExamRows } = await import("../src/apps/answer-card/server/helpers");
  await deleteExamRows(db,[historicalExam.id]);
  for(const id of historyIds) assert.equal(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_type='scan_record' AND source_id=?",String(id)),null,"exam deletion clears scan snapshots");
  assert(await db.get("SELECT source_id FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?",record.id),"unrelated original remains");
  // Scanner metadata may report a different subjective number; both formal
  // edits and withdrawn-score snapshots must use the card's question definition.
  const numberedCard = createDefaultCard("91514004");
  numberedCard.studentInfo.studentNumberDigits=5;
  numberedCard.bodyBlocks=[{...card.bodyBlocks[0],id:"numbered-objective"}, {id:"numbered-manual",type:"subjective",title:"手阅题号验证",questions:[2,3].map(number=>({
    id:`numbered-q${number}`,number,score:30,style:"manual_score_grid" as const,kind:"plain_box" as const,minHeightMm:30,
  }))}];
  await repo.createCard(numberedCard); await repo.updateCard(numberedCard);
  const numberedCurrent = (await repo.findById(numberedCard.id))!;
  const numberedCells = correctionCells(buildLayout(numberedCurrent).pages[0]);
  const numberedExam = await db.run("INSERT INTO exams (name,card_id,status) VALUES (?,?,'grading')","订正题号验证",numberedCard.id);
  const numberedExamId = Number(numberedExam.lastInsertRowid);
  await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')",numberedExamId,student.id);
  const numberedRecognition: CombinedRecognitionResult = {...recognition,identity:{...identity,cardId:numberedCard.id},subjectiveQuestions:[2,3].map(number=>({
    blockId:"numbered-manual",questionId:`numbered-q${number}`,questionNumber:3,maxScore:300,score:10,status:"ok",confidence:1,
    validCells:[{score:10,rect:numberedCells.find(c=>c.type==="score_cell" && c.questionId===`numbered-q${number}` && c.score===10)!.rect}],invalidCells:[],
  }))};
  async function uploadNumberedCard(image = imageBytes) {
    const created = await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions`,{method:"POST",headers:{"X-Api-Key":info.key,"Content-Type":"application/json"},
      body:JSON.stringify({cardId:numberedCard.id,cardVersion:cardFingerprint(numberedCurrent),pageCount:1})});
    assert.equal(created.status,201,await created.clone().text());
    const session = await created.json();
    const form = new FormData();
    form.set("image",new Blob([image],{type:"image/png"}),"numbered.png");
    form.set("token",session.uploadTokens[0]); form.set("pageNum","1"); form.set("side","front");
    form.set("recognition",JSON.stringify(numberedRecognition));
    const uploaded = await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${session.sessionId}/pages`,{method:"POST",headers:{"X-Api-Key":info.key},body:form});
    assert.equal(uploaded.status,200,await uploaded.clone().text());
    return session.sessionId as string;
  }
  const numberedSessionId = await uploadNumberedCard();
  assert.equal((await processScannerSession(numberedCurrent,numberedSessionId,"save")).results[0]?.saved,true);
  const numberedScores = async()=> (await db.all<{question_number:number;score:number}>("SELECT question_number,score FROM question_scores WHERE exam_id=? AND student_id=? AND score_type='subjective' ORDER BY question_number",numberedExamId,student.id))
    .map(q=>({number:Number(q.question_number),score:Number(q.score)}));
  assert.deepEqual(await numberedScores(),[{number:2,score:10},{number:3,score:10}],"initial grading canonicalizes uploaded subjective numbers");
  const numberedDoc = await studentCorrection(numberedCurrent,numberedExamId,student.id), numberedPage = numberedDoc.pages[0];
  const numberedTen = numberedCells.find(c=>c.type==="score_cell" && c.questionId==="numbered-q2" && c.score===10)!;
  const numberedTwenty = numberedCells.find(c=>c.type==="score_cell" && c.questionId==="numbered-q2" && c.score===20)!;
  const numberedEdit = {sourceId:numberedPage.sourceId,revision:numberedPage.revision,
    selected:toggleCorrectionCell(numberedCurrent,numberedPage,toggleCorrectionCell(numberedCurrent,numberedPage,numberedPage.selected,numberedTen.id),numberedTwenty.id)};
  await saveStudentCorrection(numberedCurrent,numberedExamId,student.id,[numberedEdit],null);
  assert.deepEqual(await numberedScores(),[{number:2,score:20},{number:3,score:10}],"editing printed question 2 cannot write question 3");
  const numberedAudit = await db.get<{question_number:number}>("SELECT question_number FROM answer_overrides WHERE exam_id=? ORDER BY id DESC LIMIT 1",numberedExamId);
  assert.equal(Number(numberedAudit!.question_number),2,"audit uses the card's subjective number");
  const numberedCopyId = await uploadNumberedCard(await sharp(imageBytes).negate().png().toBuffer());
  await processScannerSession(numberedCurrent,numberedCopyId,"validate");
  const withdrawn = (await sessionCorrection(numberedCurrent,numberedSessionId,"0",false)).pages[0];
  const snapshotEdit = {sourceId:withdrawn.sourceId,revision:withdrawn.revision,
    selected:toggleCorrectionCell(numberedCurrent,withdrawn,toggleCorrectionCell(numberedCurrent,withdrawn,withdrawn.selected,numberedTwenty.id),numberedTen.id)};
  assert.equal((await saveSessionCorrection(numberedCurrent,numberedSessionId,"0",[snapshotEdit],null)).saved,false,"duplicate remains blocked after snapshot correction");
  const correctedSnapshot = JSON.parse((await db.get<{score_snapshot:string}>("SELECT score_snapshot FROM scanner_submissions WHERE exam_id=? AND session_id=? AND group_id='0'",numberedExamId,numberedSessionId))!.score_snapshot);
  assert.deepEqual(correctedSnapshot.questions.filter((q:{score_type:string})=>q.score_type==="subjective").map((q:{question_number:number;score:number})=>({number:Number(q.question_number),score:Number(q.score)})).sort((a:{number:number},b:{number:number})=>a.number-b.number),
    [{number:2,score:10},{number:3,score:10}],"withdrawn snapshot correction also canonicalizes subjective numbers");
  console.log(`PASS scan correction: ${db.dialect}; geometry, colours, toggles, draft isolation, stale-write rejection, persisted answers, rankings/publication, review preservation and scanner replay`);
} finally { await fixture.close(); }
