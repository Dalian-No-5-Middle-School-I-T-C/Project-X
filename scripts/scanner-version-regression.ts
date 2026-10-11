import assert from 'node:assert/strict';
import { startScannerFlowFixture } from '../scripts/scanner-upload-flow-fixture.ts';
const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import('../src/server/db/index.ts');
  const { CardRepository } = await import('../src/server/repositories/CardRepository.ts');
  const { cardFingerprint } = await import('../src/shared/cardVersion.ts');
  const store = await import('../src/apps/answer-card/server/database/scan-store.ts');
  const db = getMysqlDb();
  const repo = new CardRepository();
  const card = (await repo.findById(info.cardId))!;
  const session = await store.createSession(card.id,'historical-card-version');
  const record = await store.createScanRecord({sessionId:session.id,cardId:card.id,pageNum:1,imagePath:'historic-page.png'});
  await db.run('UPDATE twain_scan_records SET identity_json=? WHERE id=?',JSON.stringify({status:'verified',code:'QR_VERIFIED',cardId:card.id,pageNumber:1}),record.id);
  await store.updateScanOcrResult(record.id,'91001',1,'uploaded');
  await store.upsertRecognitionResult({scanRecordId:record.id,objectiveJson:JSON.stringify([{questionNumber:1,selectedOptions:['A'],confidence:1}]),subjectiveJson:'[]',gradeStatus:'recognized'});
  await db.run("UPDATE twain_scan_sessions SET card_version=NULL,version_source='legacy' WHERE id=?",session.id);
  const oldVersion=cardFingerprint(card);
  const block=card.bodyBlocks[0];
  assert.equal(block.type,'objective');
  if(block.type==='objective'){block.answerKey={'1':['B']}; for(const q of block.questions??[])q.answerKey=['B'];}
  await repo.updateCard(card);
  const newVersion=cardFingerprint((await repo.findById(card.id))!);
  const response=await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${session.id}/complete`,{method:'POST',headers:{'X-Api-Key':info.key,'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,400); assert.equal((await db.all('SELECT * FROM student_scores')).length,0);
  console.log(JSON.stringify({oldVersion,newVersion,status:response.status,body:await response.json(),session:await db.get('SELECT card_version,version_source FROM twain_scan_sessions WHERE id=?',session.id),scores:await db.all('SELECT total_score FROM student_scores')},null,2));
} finally {await fixture.close();}
