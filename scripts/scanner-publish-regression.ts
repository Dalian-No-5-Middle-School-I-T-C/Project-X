import assert from 'node:assert/strict';
import { startScannerFlowFixture } from '../scripts/scanner-upload-flow-fixture.ts';
const fixture=await startScannerFlowFixture();
try {
 const info=await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
 const {getMysqlDb}=await import('../src/server/db/index.ts');
 const {CardRepository}=await import('../src/server/repositories/CardRepository.ts');
 const {processScannerSession,discardScannerGroup}=await import('../src/server/services/scannerSubmissions.ts');
 const store=await import('../src/apps/answer-card/server/database/scan-store.ts');
 const db=getMysqlDb();
 const autoUnpublish = process.env.TEST_AUTO_UNPUBLISH === "1";
 const publicationAfterMutation = autoUnpublish ? 0 : 1;
 if (autoUnpublish) await db.run("INSERT INTO system_settings (`key`, value) VALUES ('auto_unpublish_on_score_change', '1')");
 const card=(await new CardRepository().findById(info.cardId))!;
 const exam=(await db.get('SELECT id FROM exams WHERE card_id=?',card.id))!;
 async function makeSession(name:string,student='91001'){
  const session=await store.createSession(card.id,name);
  // Model metadata persisted by POST /upload/sessions before recognition.
  await db.run("UPDATE twain_scan_sessions SET card_version=?,version_source='upload' WHERE id=?",info.version,session.id);
  const record=await store.createScanRecord({sessionId:session.id,cardId:card.id,pageNum:1,imagePath:`${name}.png`});
  await db.run('UPDATE twain_scan_records SET identity_json=? WHERE id=?',JSON.stringify({status:'verified',code:'QR_VERIFIED',cardId:card.id,pageNumber:1}),record.id);
  await store.updateScanOcrResult(record.id,student,1,'uploaded');
  await store.upsertRecognitionResult({scanRecordId:record.id,objectiveJson:JSON.stringify([{questionNumber:1,selectedOptions:['A'],confidence:1}]),subjectiveJson:'[]',gradeStatus:'recognized'});
  return session;
 }
 const original=await makeSession('original');
 assert.equal((await processScannerSession(card,original.id,'save')).results[0].saved,true);
 await db.run('UPDATE student_scores SET total_score=4,objective_score=4,manually_modified=1 WHERE exam_id=?',exam.id);
 const normal=await makeSession('normal','91002');
 assert.equal((await processScannerSession(card,normal.id,'save')).results[0].saved,true);
 const duplicate=await makeSession('duplicate');
 assert.equal((await processScannerSession(card,duplicate.id,'save')).failures.length,1);
 await discardScannerGroup(card,duplicate.id,'0');
 const {setExplicitParticipants}=await import('../src/server/services/examParticipants.ts');
 const {assertScoresPublishable}=await import('../src/server/services/examPublication.ts');
 const normalUser=(await db.get('SELECT id FROM users WHERE student_number=?','91002'))!;
 const originalUser=(await db.get('SELECT id FROM users WHERE student_number=?','91001'))!;
 await setExplicitParticipants(db,exam.id,[normalUser.id]);
 await assertScoresPublishable(db,exam);
 await db.run("UPDATE exams SET status='grading',score_published=1 WHERE id=?",exam.id);
 await setExplicitParticipants(db,exam.id,[normalUser.id,originalUser.id]);
 const before=await db.get('SELECT score_published FROM exams WHERE id=?',exam.id);
 const response=await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${original.id}/complete`,{method:'POST',headers:{'X-Api-Key':info.key,'Content-Type':'application/json'},body:JSON.stringify({cardVersion:info.version})});
 assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 const {ScoreRepository}=await import('../src/server/repositories/ScoreRepository.ts');
 assert.equal((await db.get('SELECT score_published FROM exams WHERE id=?',exam.id)).score_published,publicationAfterMutation);
 assert.equal((await new ScoreRepository().getStudentScores(originalUser.id)).length,autoUnpublish ? 0 : 1);
 console.log(JSON.stringify({studentVisible:await new ScoreRepository().getStudentScores(originalUser.id),before,status:response.status,response:await response.json(),after:await db.get('SELECT score_published FROM exams WHERE id=?',exam.id),scores:await db.all('SELECT total_score,manually_modified FROM student_scores'),publishEvents:await db.all('SELECT reason FROM exam_publish_events')},null,2));
}finally{await fixture.close();}
