/** Render the VM UI scenario; private state and generated commands stay ignored. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('ignored/production-flow');
const command = process.argv[2] || 'prepare';
assert(['prepare', 'early', 'sync', 'final', 'close'].includes(command), 'Usage: node scripts/production-flow-actions.mjs prepare|early|sync|final|close');
const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
assert.equal(state.server, 'http://10.211.55.4:5196');
assert.equal(state.scanner, 'http://127.0.0.1:5186');
const values = { server: state.server, cardTitle: state.cardTitle, examId: String(state.examId),
  groupName: state.groupName || '五十人复测大考组20261015' };
assert(values.cardTitle && Number.isSafeInteger(state.examId), 'Seed an isolated exam first');
const render = value => {
  if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    assert(Object.hasOwn(values, key), `Unknown scenario placeholder: ${key}`);
    return values[key];
  });
  if (Array.isArray(value)) return value.map(render);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item)]));
  return value;
};
const save = (file, data) => writeFile(path.join(root, file), JSON.stringify(data, null, 2) + '\n');

if (command === 'prepare') {
  const templates = JSON.parse(await readFile(new URL('./fixtures/production-flow-actions.json', import.meta.url), 'utf8'));
  for (const [stage, actions] of Object.entries(templates)) await save(`actions-${stage}.json`, render(actions));
  console.log(`Prepared ${Object.keys(templates).length} UI stages for exam ${state.examId}`);
} else {
  let actions = [];
  if (command === 'early' || command === 'final') {
    const requests = JSON.parse(await readFile(path.join(root, 'evidence/scanner-live-requests.json'), 'utf8'));
    const labels = new Map();
    for (const request of requests) {
      if (request.method !== 'POST' || !request.url.endsWith('/sessions') || request.request?.cardId !== state.cardId || !request.body?.sessionId) continue;
      const match = request.request.name?.match(/_第(\d+)份$/);
      if (match) labels.set(Number(match[1]) - 1, `原卷 ${request.body.sessionId}/${Number(match[1]) - 1} 订正学号`);
    }
    const fixPair = (old, next, studentId) => {
      assert(labels.has(old) && labels.has(next), 'Wait for the current scanner-live session evidence');
      return [{ role: 'textbox', name: labels.get(next), fill: studentId },
        { scopeInput: labels.get(next), name: '订正此卷' },
        { scopeInput: labels.get(old), name: '重新保存此会话' },
        { scopeInput: labels.get(next), name: '重新保存此会话' },
        { assertRow: `答题卡-${studentId}.png`, includes: [studentId, 'ok'] },
        { assertRow: `答题卡-${Number(studentId) - 1}.png`, includes: ['ok'] }];
    };
    if (command === 'early') actions = [...fixPair(0, 1, '10002'), ...fixPair(2, 3, '10004')];
    else actions = [...fixPair(4, 5, '10006'),
      { role: 'textbox', name: '订正上传卷学号', fill: '10007' }, { name: '订正学号并重试' },
      { assertRow: '答题卡-10007.png', includes: ['10007', 'ok', '27/50'] },
      { assertRow: '答题卡-10008.png', includes: ['10008', 'ok', '45/50'] }];
  } else if (command === 'sync') actions = [
    { assertRow: '答题卡-10008.png', includes: ['10008', 'ok', '45/50', '20/20 · 25/30'] },
    { role: 'row', name: '答题卡-10008.png', regex: true }, { snapshot: '扫描主表最新填涂明细' },
    { role: 'row', name: '答题卡-10008.png', regex: true }];
  if (command !== 'close') actions.push({ role: 'alert', wait: 'hidden' }, { snapshot: `扫描阶段-${command}` });
  await save('ui-command.json', { id: `${command}-${Date.now()}`, actions, ...(command === 'close' ? { close: true } : {}) });
  console.log(`Queued ${command}; inspect evidence/扫描操作结果.json before advancing`);
}
