import assert from 'node:assert/strict';
import { startScannerFlowFixture } from '../scripts/scanner-upload-flow-fixture.ts';
const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import('../src/server/db/index.ts');
  const { CardRepository } = await import('../src/server/repositories/CardRepository.ts');
  const { processScannerSession, discardScannerGroup } = await import('../src/server/services/scannerSubmissions.ts');
  const store = await import('../src/apps/answer-card/server/database/scan-store.ts');
  const db = getMysqlDb();
  const card = (await new CardRepository().findById(info.cardId))!;
  const session = await store.createSession(card.id, 'same-session-discard-repro');
  for (const pageNum of [1, 2]) {
    const record = await store.createScanRecord({sessionId:session.id,cardId:card.id,pageNum,imagePath:`test-${pageNum}.png`});
    await db.run('UPDATE twain_scan_records SET identity_json=? WHERE id=?', JSON.stringify({status:'verified',code:'QR_VERIFIED',cardId:card.id,pageNumber:1}),record.id);
    await store.updateScanOcrResult(record.id,'91001',1,'done');
    await store.upsertRecognitionResult({scanRecordId:record.id,objectiveJson:JSON.stringify([{questionNumber:1,selectedOptions:['A'],confidence:1}]),subjectiveJson:'[]',gradeStatus:'done'});
  }
  await store.updateSessionStatus(session.id,'completed');
  const before = await processScannerSession(card,session.id,'save');
  assert.equal(before.failures.length,2);
  await discardScannerGroup(card,session.id,'1');
  const after = await processScannerSession(card,session.id,'save');
  assert.equal(after.failures.length,0); assert.equal(after.results[0].saved,true);
  console.log(JSON.stringify({before,after,receipts:await db.all('SELECT group_id,state FROM scanner_submissions WHERE session_id=?',session.id),scores:await db.all('SELECT total_score FROM student_scores')},null,2));
} finally {await fixture.close();}
