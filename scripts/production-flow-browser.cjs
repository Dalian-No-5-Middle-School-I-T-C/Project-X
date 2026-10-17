/** Run in Windows against disposable services; every business mutation uses the real UI. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('./tools/node_modules/playwright-core');
const work = __dirname;
const state = JSON.parse(fs.readFileSync(path.join(work, 'state.json'), 'utf8'));
const step = process.argv[2] || 'scanner-prepare';
const evidence = path.join(work, 'evidence');
const shared = process.env.PROJECTX_FLOW_SHARED_ROOT;
assert(shared, 'Run this file through production-flow-windows.ps1');
assert.equal(state.server, 'http://10.211.55.4:5196');
assert.equal(state.scanner, 'http://127.0.0.1:5186');
fs.mkdirSync(evidence, { recursive: true });
const profile = step.startsWith('scanner') ? 'scanner' : step.startsWith('teacher') ? 'teacher' : step.startsWith('student') ? step.split(':')[0] : 'admin';
const errors = [], requests = [];
let context;
let logTimer;
function flushRequests() {
  fs.writeFileSync(path.join(evidence, `${step.replaceAll(':', '-')}-requests.json`), JSON.stringify(requests, null, 2));
}

async function snapshot(page, name) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled', timeout: 60000 });
  fs.writeFileSync(path.join(evidence, `${name}.txt`), await page.locator('body').innerText());
}
async function performActions(page, actions) {
  for (const action of actions) {
    if (action.assertText) {
      for (const expected of [].concat(action.assertText)) await page.getByText(expected, { exact: action.exact ?? false }).first().waitFor();
      continue;
    }
    if (action.assertRow) {
      const row = page.getByRole('row').filter({ has: page.getByText(action.assertRow, { exact: true }) });
      for (const expected of action.includes) await row.getByText(expected, { exact: true }).waitFor({ timeout: action.timeout ?? 60000 });
      continue;
    }
    if (action.assertNoApiErrors) {
      assert.deepEqual(requests.filter(r => r.status >= 400), [], 'Unexpected API error in the real UI');
      assert.deepEqual(errors, [], 'Unexpected frontend exception');
      continue;
    }
    if (action.assertNoStatus) {
      assert.deepEqual(requests.filter(r => action.assertNoStatus.includes(r.status)), [], 'Unexpected response status');
      assert.deepEqual(errors, [], 'Unexpected frontend exception');
      continue;
    }
    if (action.goto) { await page.goto(action.goto, { waitUntil: 'networkidle' }); continue; }
    if (action.snapshot) { await snapshot(page, action.snapshot); continue; }
    if (action.settle) { await page.waitForLoadState('networkidle'); continue; }
    if (action.checkImages) {
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('img')];
        return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0);
      });
      continue;
    }
    let root = action.scopeInput ? page.getByRole('textbox', { name: action.scopeInput, exact: true }).locator('..')
      : action.scopeRow ? page.getByRole('row', { name: new RegExp(action.scopeRow) }) : page;
    let target = action.selector ? root.locator(action.selector) : action.text ? root.getByText(action.text, { exact: action.exact ?? true })
      : root.getByRole(action.role || 'button', { name: action.regex ? new RegExp(action.name) : action.name, exact: !action.regex });
    if (action.nth !== undefined) target = target.nth(action.nth);
    if (action.download) {
      const [download] = await Promise.all([page.waitForEvent('download'), target.click()]);
      await download.saveAs(path.join(evidence, action.download));
    }
    else if (action.fill !== undefined) await target.fill(action.fill);
    else if (action.wait) await target.waitFor({ state: action.wait });
    else if (action.responseIncludes) await Promise.all([
      page.waitForResponse(r => r.url().includes(action.responseIncludes) && r.request().method() !== 'GET', { timeout: 180000 }),
      target.click(),
    ]);
    else await target.click();
  }
}
async function controlScanner(page) {
  let last = '';
  fs.writeFileSync(path.join(evidence, '扫描会话就绪.json'), JSON.stringify({ ready: true, at: new Date().toISOString() }));
  fs.cpSync(evidence, path.join(shared, 'evidence'), { recursive: true });
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const file = path.join(shared, 'ui-command.json');
    if (!fs.existsSync(file)) continue;
    const command = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (command.id === last) continue;
    last = command.id;
    if (command.close) return;
    let error;
    try {
      await performActions(page, command.actions || []);
    } catch (e) { error = e.message; }
    await snapshot(page, command.id);
    const result = { id: command.id, error, text: await page.locator('body').innerText(), inputs: await page.locator('input').evaluateAll(nodes => nodes.map(n => ({ label: n.getAttribute('aria-label'), placeholder: n.placeholder }))), buttons: await page.getByRole('button').allTextContents() };
    fs.writeFileSync(path.join(evidence, '扫描操作结果.json'), JSON.stringify(result, null, 2));
    fs.cpSync(evidence, path.join(shared, 'evidence'), { recursive: true });
  }
}
async function onboard(page) {
  if (await page.getByRole('radio', { name: /明澈/ }).isVisible().catch(() => false)) {
    await page.getByRole('radio', { name: /明澈/ }).click();
    await page.getByRole('button', { name: /确认|使用此风格|开始使用|进入登录/ }).click();
  }
}
async function login(page, identifier, scanner = false) {
  await onboard(page);
  const input = page.getByPlaceholder(scanner ? '请输入用户名 / 学号' : /用户名|学号/).first();
  if (await input.isVisible().catch(() => false)) {
    await input.fill(identifier);
    await page.getByPlaceholder(scanner ? '请输入密码' : '密码', { exact: true }).fill(identifier === 'admin' && !scanner ? state.adminPassword : state.password);
    await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST'),
      page.getByRole('button', { name: /^登录$|登录系统/ }).click(),
    ]);
    await input.waitFor({ state: 'hidden' });
  }
  if (await page.getByText('首次登录安全设置', { exact: true }).isVisible().catch(() => false)) {
    assert(typeof state.changedPassword === 'string' && state.changedPassword.length >= 12, 'Set private config.changedPassword before first login');
    await page.getByPlaceholder('请输入当前一次性密码').fill(state.password);
    await page.getByPlaceholder('设置新密码', { exact: true }).fill(state.changedPassword);
    await page.getByPlaceholder('再次输入新密码').fill(state.changedPassword);
    await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/auth/change-password')),
      page.getByRole('button', { name: '修改密码并重新登录' }).click(),
    ]);
    await page.getByText('首次登录安全设置', { exact: true }).waitFor({ state: 'hidden' });
    if (await input.isVisible().catch(() => false)) {
      await input.fill(identifier);
      await page.getByPlaceholder(scanner ? '请输入密码' : '密码', { exact: true }).fill(state.changedPassword);
      await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST'),
        page.getByRole('button', { name: /^登录$|登录系统/ }).click(),
      ]);
      await input.waitFor({ state: 'hidden' });
    }
  }
}
async function main() {
  context = await chromium.launchPersistentContext(path.join(work, `edge-${profile}`), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, viewport: { width: 1600, height: 1100 }, args: ['--no-sandbox'], timeout: 60000,
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => {
      const url = response.url();
      if (!url.includes('/api/') || url.includes('/auth/')) return;
      const entry = { at: new Date().toISOString(), method: response.request().method(), url, status: response.status() };
      if (entry.method === 'POST' && url.endsWith('/scanner/upload/sessions')) entry.request = response.request().postDataJSON();
      requests.push(entry);
      if ((url.includes('/scanner/upload/') && !url.includes('/image')) || url.includes('/api/scores/me')) {
        try { entry.body = await response.json(); } catch {}
      }
      if (!logTimer) logTimer = setTimeout(() => { logTimer = undefined; flushRequests(); }, 1000);
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  if (step.startsWith('scanner')) {
    await page.goto(state.scanner, { waitUntil: 'networkidle' });
    await onboard(page);
    if (step === 'scanner-prepare' && await page.getByRole('button', { name: '服务器连接（可选）' }).isVisible().catch(() => false)) {
      if (!await page.getByPlaceholder('https://projectx.school.edu.cn').isVisible()) await page.getByRole('button', { name: '服务器连接（可选）' }).click();
      await page.getByPlaceholder('https://projectx.school.edu.cn').fill(state.server);
      const allowance = page.getByRole('checkbox', { name: /隔离的内网测试环境/ });
      if (await allowance.isVisible().catch(() => false)) await allowance.check();
      await page.getByPlaceholder('sk-xxx...').fill(state.scannerKey);
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await page.getByText('服务器可达，上传权限有效', { exact: true }).waitFor();
      await snapshot(page, '扫描端服务器连接成功');
      await page.getByRole('button', { name: '保存配置', exact: true }).click();
      await login(page, 'admin', true);
    } else {
      await login(page, 'admin', true);
    }
    const cardText = page.getByText(state.cardTitle || '五十张答题卡全链路测试20261015', { exact: true }).first();
    if (await cardText.isVisible().catch(() => false)) {
      await cardText.click();
      await page.waitForLoadState('networkidle');
    }
    if (step === 'scanner-scan' || step === 'scanner-live') {
      await page.getByText('本地判分+上传服务器', { exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem('projectx_scanner_mode') === 'remote');
      const files = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8')).map(row => path.join(work, 'images', row.image));
      await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(files);
      await snapshot(page, '扫描端五十张卡导入');
      await page.getByRole('button', { name: /开始阅卷|开始识别/ }).click();
      await page.getByText(/阅卷完成：50 张/).first().waitFor({ timeout: 600000 });
      // Uploading is independent of batch grading. Wait for actual upload completion statuses.
      await page.waitForFunction(() => document.querySelectorAll('[role=progressbar]').length === 0 && !/排队等待上传/.test(document.body.innerText), null, { timeout: 600000 });
      await snapshot(page, '扫描端首次五十张识别结果');
      if (step === 'scanner-live') await controlScanner(page);
    }
  } else {
    await page.goto(state.server, { waitUntil: 'networkidle' });
    await login(page, profile === 'teacher' ? 'flow_teacher' : profile.startsWith('student') ? `flow_${profile.slice(7)}` : 'admin');
    await snapshot(page, `${profile}登录界面`);
    const actionsFile = path.join(shared, `actions-${step.replaceAll(':', '-')}.json`);
    if (fs.existsSync(actionsFile)) await performActions(page, JSON.parse(fs.readFileSync(actionsFile, 'utf8')));
    if (step.endsWith(':watch')) {
      await snapshot(page, '补录前学生界面');
      fs.cpSync(evidence, path.join(shared, 'evidence'), { recursive: true });
      await page.getByText(state.cardTitle, { exact: true }).waitFor({ timeout: 180000 });
      await snapshot(page, '补录后学生自动更新');
    }
  }
  console.log(JSON.stringify({ step, url: page.url(), text: (await page.locator('body').innerText()).slice(0, 8000), buttons: (await page.getByRole('button').allTextContents()).slice(0, 60), errors }, null, 2));
  await snapshot(page, `${step.replaceAll(':', '-')}-界面`);
}
main().catch(async error => {
  console.error(error);
  if (context?.pages().length) await snapshot(context.pages().at(-1), `${step.replaceAll(':', '-')}-失败`).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(logTimer);
  flushRequests();
  fs.writeFileSync(path.join(evidence, `${step.replaceAll(':', '-')}-errors.json`), JSON.stringify(errors, null, 2));
  await context?.close();
});
