/** Seed only through product APIs; refuse targets outside the disposable VM. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('ignored/production-flow');
const config = JSON.parse(await readFile(path.join(out, 'config.json'), 'utf8'));
assert.equal(config.server, 'http://10.211.55.4:5196');
for (const key of ['password', 'adminPassword', 'changedPassword']) {
  assert(typeof config[key] === 'string' && config[key].length >= 12 && !config[key].startsWith('__SET_'), `Set private config.${key}`);
}
await mkdir(path.join(out, 'evidence'), { recursive: true });
await mkdir(path.join(out, 'images'), { recursive: true });
let token = '';
async function api(route, method = 'GET', body) {
  const response = await fetch(config.server + route, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert(response.ok, `${method} ${route}: ${response.status} ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}
const reuse = process.argv.includes('--reuse-accounts') ? JSON.parse(await readFile(path.join(out, 'state.json'), 'utf8')) : null;
let login = await api('/api/auth/login', 'POST', { identifier: 'admin', password: reuse?.adminPassword ?? config.password });
token = login.token;
assert(token);
const adminPassword = reuse?.adminPassword ?? config.adminPassword;
if (login.passwordChangeRequired) {
  await api('/api/auth/change-password', 'POST', { oldPassword: config.password, newPassword: adminPassword });
  login = await api('/api/auth/login', 'POST', { identifier: 'admin', password: adminPassword });
  token = login.token;
}
const health = await api('/api/app/health');
await writeFile(path.join(out, 'evidence/服务端健康状态.json'), JSON.stringify(health, null, 2));
const scannerKey = reuse ? { api_key: reuse.scannerKey } : await api('/api/admin/api-keys', 'POST', { name: '五十张卡隔离测试', scope: 'scanner' });
const grade = reuse?.grade ?? await api('/api/classes/grades', 'POST', { name: '全链路测试年级20261015' });
const cls = reuse?.cls ?? await api('/api/classes', 'POST', { gradeId: grade.id, name: '五十人测试班' });
const teacher = reuse?.teacher ?? await api('/api/users', 'POST', {
  username: 'flow_teacher', name: '全链路任课老师', password: config.password,
  role: 'teacher', teacher_role: 'subject_teacher',
});
await api(`/api/teachers/${teacher.id}`, 'PUT', { subject: '数学', teacher_role: 'subject_teacher' });
await api(`/api/classes/${cls.id}/teachers`, 'POST', { teacherId: teacher.id, subject: '数学' });
const students = reuse?.students ?? [];
for (let n = 10001; !reuse && n <= 10050; n++) {
  students.push(await api('/api/users', 'POST', {
    username: `flow_${n}`, name: `测试学生${n}`, password: config.password,
    role: 'student', student_number: String(n),
  }));
}
await api(`/api/classes/${cls.id}/students`, 'POST', { studentIds: students.map(s => s.id) });
console.log(reuse ? 'Reused existing teacher, class and 50 students' : 'Created teacher, class and 50 students through product APIs');
let card = await api('/api/cards', 'POST', {
  subject: 'math', subjectLabel: '数学', title: '五十张答题卡全链路测试20261015', examDate: '2026-10-15',
});
card.sided = 'single';
card.studentInfo.studentNumberDigits = 5;
card.bodyBlocks = [{
  id: `flow_choices_${card.id}`, type: 'objective', title: '选择题', questionStart: 1, questionCount: 4,
  optionCount: 4, mode: 'single', scorePerQuestion: 5, density: 'normal',
  answerKey: { 1: ['A'], 2: ['B'], 3: ['C'], 4: ['D'] },
}, {
  id: `flow_manual_${card.id}`, type: 'subjective', title: '解答题（红笔划线给分）',
  questions: [{ id: `flow_q5_${card.id}`, number: 5, score: 30, style: 'manual_score_grid', kind: 'lined_answer', minHeightMm: 55 }],
}];
card = await api(`/api/cards/${card.id}`, 'PUT', card);
const exam = await api('/api/exams', 'POST', {
  name: card.title, cardId: card.id, gradeId: grade.id, classId: cls.id, subject: '数学', mode: 'quiz',
});
await api(`/api/exams/${exam.id}/participants`, 'PUT', { studentIds: students.map(s => s.id) });
const groupName = `全链路测试大考组 ${exam.id}`;
const group = await api('/api/exam-groups', 'POST', { name: groupName, grade_id: grade.id, examIds: [exam.id] });
const layout = await api(`/api/cards/${card.id}/layout`);
assert.equal(layout.pages.length, 1, 'All 50 cards must be single-page cards');
const pdf = await fetch(`${config.server}/api/cards/${card.id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
assert(pdf.ok, `PDF: ${pdf.status} ${await pdf.clone().text()}`);
await writeFile(path.join(out, '答题卡原版.pdf'), Buffer.from(await pdf.arrayBuffer()));
await writeFile(path.join(out, 'layout.json'), JSON.stringify(layout, null, 2));
await writeFile(path.join(out, 'card.json'), JSON.stringify(card, null, 2));
const state = { ...config, adminPassword, grade, cls, teacher, students, cardId: card.id, cardTitle: card.title, examId: exam.id, retestGroupId: group.id, groupName, adminToken: token, scannerKey: scannerKey.api_key };
await writeFile(path.join(out, 'state.json'), JSON.stringify(state, null, 2));
console.log(`Created card ${card.id}, exam ${exam.id}, exported actual program PDF`);
