/** Read-only assertions against the disposable VM's persisted score consumers. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const root = 'ignored/production-flow';
const state = JSON.parse(await readFile(`${root}/state.json`, 'utf8'));
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
assert.equal(state.server, 'http://10.211.55.4:5196');
const stage = process.argv[2];
assert(['initial', 'early', 'corrected', 'published', 'final'].includes(stage));
async function get(route) {
  const response = await fetch(state.server + route, { headers: { Authorization: `Bearer ${state.adminToken}` } });
  assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
const [exam, students, overview, pending] = await Promise.all([
  get(`/api/exams/${state.examId}`), get(`/api/analysis/exams/${state.examId}/students`),
  get(`/api/analysis/exams/${state.examId}/overview`), get(`/api/exams/${state.examId}/scanner-pending`),
]);
const missing = stage === 'initial' ? ['10001','10002','10003','10004','10005','10006','10007']
  : stage === 'final' ? [] : ['10005','10006','10007'];
const expected = manifest.filter(row => !missing.includes(row.physicalStudent));
assert.equal(students.length, expected.length, `${stage}: score row count`);
assert.equal(overview.gradedCount, expected.length, `${stage}: overview count`);
const manual = process.argv.includes('--manual-corrected') || ['corrected', 'published', 'final'].includes(stage);
for (const row of expected) {
  const actual = students.find(s => String(s.studentNumber) === row.physicalStudent);
  assert(actual, `Missing ${row.physicalStudent}`);
  const score = manual && row.physicalStudent === '10008' ? 45 : row.totalScore;
  assert.equal(actual.totalScore, score, `${row.physicalStudent}: total score`);
  const rank = 1 + expected.filter(other => (manual && other.physicalStudent === '10008' ? 45 : other.totalScore) > score).length;
  assert.equal(actual.rank, rank, `${row.physicalStudent}: competition rank`);
}
assert.equal(pending.items.length, stage === 'initial' ? 6 : stage === 'final' ? 0 : 2, `${stage}: unresolved duplicate papers`);
assert.equal(exam.score_published, ['published','final'].includes(stage) ? 1 : 0, `${stage}: publication state`);
const expectedAverage = expected.reduce((sum, row) => sum + (manual && row.physicalStudent === '10008' ? 45 : row.totalScore), 0) / expected.length;
assert.equal(overview.avgScore, Math.round(expectedAverage * 10) / 10, `${stage}: average score rounded to one decimal`);
await writeFile(`${root}/evidence/${stage}-成绩与排名核验.json`, JSON.stringify({ stage, exam, overview, students, pending, missing, expectedAverage, passed: true }, null, 2));
console.log(`PASS ${stage}: ${expected.length} scores, exact totals and ranks, ${pending.items.length} pending duplicates, published=${exam.score_published}`);
