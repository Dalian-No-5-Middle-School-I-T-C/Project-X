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
  assert.notEqual(oldVersion,newVersion);
  const snapshot=async()=>JSON.stringify(await Promise.all(['student_scores','question_scores','scanner_submissions','twain_scan_sessions','twain_scan_records','exams'].map(table=>db.all(`SELECT * FROM ${table}`))));
  const before=await snapshot();
  for(const body of [{},{cardVersion:oldVersion},{cardVersion:newVersion},{cardVersion:'invalid'}]) {
    const response=await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${session.id}/complete`,{method:'POST',headers:{'X-Api-Key':info.key,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,409);
    assert.equal((await response.json()).code,'SESSION_CARD_VERSION_UNKNOWN');
    assert.equal(await snapshot(),before,'A caller cannot certify unknown history or write scores/receipts');
  }
  // Previous releases could promote a caller value to legacy_verified. That
  // marker is not independent provenance, even though it is now non-null.
  await db.run("UPDATE twain_scan_sessions SET card_version=?,version_source='legacy_verified' WHERE id=?",newVersion,session.id);
  const promoted=await snapshot();
  const rejected=await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${session.id}/complete`,{method:'POST',headers:{'X-Api-Key':info.key,'Content-Type':'application/json'},body:JSON.stringify({cardVersion:newVersion})});
  assert.equal(rejected.status,409);
  assert.equal((await rejected.json()).code,'SESSION_CARD_VERSION_UNKNOWN');
  assert.equal(await snapshot(),promoted);
  console.log('PASS unknown historical version: empty, old, current, malformed and previously promoted fingerprints reject without mutations');
} finally {await fixture.close();}
