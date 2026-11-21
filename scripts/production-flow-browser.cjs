/** Run in Windows against disposable services; every business mutation uses the real UI. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, request } = require('./tools/node_modules/playwright-core');
const work = __dirname;
const step = process.argv[2] || 'scanner-prepare';
const shared = process.env.PROJECTX_FLOW_SHARED_ROOT;
assert(shared, 'Run this file through production-flow-windows.ps1');
const state = JSON.parse(fs.readFileSync(path.join(shared, step === 'admin-bootstrap' ? 'config.json' : 'state.json'), 'utf8'));
const evidence = path.join(shared, 'evidence');
const { validateTargets } = require("./production-flow-target.cjs");
validateTargets(state);
const stages = new Set([
  'scanner-prepare', 'scanner-live', 'scanner-scan', 'teacher-login-retest', 'admin-bootstrap',
  'teacher-roster-extra', 'teacher-grading-draft', 'teacher-essay-pages', 'teacher-text-annotation', 'teacher-touch-annotation',
  'teacher-legacy-ui', 'admin-retention-setup', 'admin-retention-restore', 'admin-backup-export',
  'admin-backup-restore', 'admin-provider-ui', 'admin-tools-ui', 'admin-student-background',
  'admin-feedback-paging', 'admin-designer-lifecycle', 'admin-card-previews', 'admin-mobile-drawer',
  'admin-review-viewport', 'admin-account-appearance', 'admin-analysis-bands', 'admin-feedback-ui',
  'teacher-feedback-ui', 'teacher-print', 'teacher-analysis-dialogs', 'teacher-preview-rotation',
  'teacher-card-rotation', 'admin-responsive', 'student10008:account-controls', 'student10008:file-formats',
  'student10008:rotation', 'student10008:responsive',
]);
assert.match(step, /^[a-zA-Z0-9]+(?:[:-][a-zA-Z0-9]+)*$/, 'Invalid browser stage');
const actionsFile = path.join(shared, `actions-${step.replaceAll(':', '-')}.json`);
const actions = fs.existsSync(actionsFile) ? JSON.parse(fs.readFileSync(actionsFile, 'utf8')) : [];
assert.ok(Array.isArray(actions), 'Browser stage actions must be an array');
const watch = /^student[0-9]+:watch$/.test(step);
assert.ok(stages.has(step) || watch || actions.length > 0, 'Unknown browser stage or missing actions: ' + step);
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
    let root = action.scopeInput ? page.getByRole('group', { name: action.scopeInput.replace(/ 订正学号$/, ''), exact: true })
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
    const submit = () => Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST'),
      page.getByRole('button', { name: /^登录$|登录系统/ }).click(),
    ]).then(([response]) => response);
    let response = await submit();
    if (response.status() === 401 && identifier !== 'admin') {
      await page.getByPlaceholder(scanner ? '请输入密码' : '密码', { exact: true }).fill(state.changedPassword);
      response = await submit();
    }
    assert.equal(response.status(), 200);
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
async function checkBootstrap(page) {
  const api = await request.newContext({ baseURL: state.server });
  try {
    const password = process.env.PROJECTX_FLOW_BOOTSTRAP_STDIN ? fs.readFileSync(0, 'utf8').trim() : state.bootstrapPassword;
    assert.ok(password, 'Supply the disposable service bootstrap password');
    const credentials = { identifier: 'admin', password };
    const bearerLogin = await api.post('/api/auth/login', { data: credentials });
    assert.equal(bearerLogin.status(), 200);
    const { token } = await bearerLogin.json();
    assert.ok(token);
    const headers = { Authorization: `Bearer ${token}` };
    const locked = await api.get('/api/users', { headers });
    assert.equal(locked.status(), 428);
    assert.equal((await locked.json()).code, 'PASSWORD_CHANGE_REQUIRED');

    await page.goto(state.server, { waitUntil: 'networkidle' });
    await onboard(page);
    await page.getByPlaceholder('工号 / 学号').fill('admin');
    await page.getByPlaceholder('密码', { exact: true }).fill(credentials.password);
    const [login] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/auth/login')),
      page.getByRole('button', { name: '登录', exact: true }).click(),
    ]);
    assert.equal(login.status(), 200);
    assert.equal(Object.hasOwn(await login.json(), 'token'), false);
    const cookie = (await context.cookies()).find(c => c.name === 'projectx_auth_token');
    assert.ok(cookie?.httpOnly && cookie.sameSite === 'Lax');
    assert.equal(cookie.secure, state.server.startsWith('https://'));
    await page.getByText('首次登录安全设置', { exact: true }).waitFor();
    await snapshot(page, '首次登录强制改密');
    await page.getByPlaceholder('请输入当前一次性密码').fill(credentials.password);
    for (const [value, status] of [['short', 400], [state.adminPassword, 200]]) {
      await page.getByPlaceholder('设置新密码', { exact: true }).fill(value);
      await page.getByPlaceholder('再次输入新密码').fill(value);
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/api/auth/change-password')),
        page.getByRole('button', { name: '修改密码并重新登录' }).click(),
      ]);
      assert.equal(response.status(), status);
    }
    assert.equal((await api.get('/api/users', { headers })).status(), 401);
    await loginAfterBootstrap(page);
    const accessible = await context.request.get(state.server + '/api/users');
    assert.equal(accessible.status(), 200);
    console.log('Bootstrap gate 428, weak password 400, credential rotation 200, old token 401, fresh browser session 200.');
  } finally { await api.dispose(); }
}
async function loginAfterBootstrap(page) {
  await page.getByPlaceholder('工号 / 学号').waitFor();
  await login(page, 'admin');
}
async function decideExtraPapers(page) {
  const spec=JSON.parse(fs.readFileSync(path.join(shared,'matrix-exams.json'))).B;
  const pending=state.server+'/api/exams/'+spec.exam+'/scanner-pending';
  await page.goto(state.server+'/analysis',{waitUntil:'networkidle'});
  const exam=await (await page.request.get(state.server+'/api/exams/'+spec.exam)).json();
  await page.getByRole('row',{name:new RegExp(exam.name)}).first().click();
  const banner=page.getByRole('region',{name:'异常扫描卷'});
  await banner.getByText('2 份扫描卷待处理',{exact:true}).waitFor();
  await banner.getByRole('button',{name:'查看异常卷'}).click();
  for(const [student,action] of [['10013','确认加入名单并入库'],['10014','忽略此卷']]){
    const item=banner.getByText('学号 '+student+' · 不在应考名单',{exact:true}).locator('..');
    await item.getByRole('button',{name:action}).click();
    const dialog=page.getByRole('dialog');
    const [reply]=await Promise.all([
      page.waitForResponse(r=>r.url()===pending&&r.request().method()==='POST'),
      dialog.getByRole('button',{name:'确认',exact:true}).click(),
    ]);
    assert.equal(reply.status(),200);
    await item.waitFor({state:'hidden'});
  }
  await banner.waitFor({state:'hidden'});
  const scores=await (await page.request.get(state.server+'/api/analysis/exams/'+spec.exam+'/students')).json();
  assert.ok(scores.some(r=>String(r.studentNumber)==='10013'));
  assert.ok(!scores.some(r=>String(r.studentNumber)==='10014'));
  console.log('Teacher used both confirmation dialogs; roster exhausted; only 10013 received a score');
}

async function accountAppearance(page) {
  const pref=state.server+'/api/users/me/settings';
  const bg=state.server+'/api/users/me/background';
  const clientTab=async()=>{
    await page.goto(state.server+'/account-settings',{waitUntil:'networkidle'});
    await page.getByRole('tab',{name:/客户端/}).click();
  };
  const changeAccount=async(username)=>{
    await page.getByRole('button',{name:'账号菜单',exact:true}).first().click();
    await page.getByRole('menuitem',{name:'退出登录'}).click();
    await page.getByPlaceholder('工号 / 学号').waitFor();
    await login(page,username);
    await clientTab();
  };
  const prefs=async()=> (await page.request.get(pref)).json();
  const chooseSkin=async(skin)=>{
    const button=page.getByRole('button',{name:'切换外观与皮肤'}).first();
    await button.click();
    await page.getByRole('menuitemradio',{name:skin==='flat'?/明澈/:/纸锋/}).click();
    await page.waitForFunction(s=>document.documentElement.dataset.skin===s,skin);
  };
  await clientTab();
  const adminBefore=await prefs();
  await chooseSkin('paper-edge');
  await changeAccount('flow_teacher');
  const teacherBefore=await prefs();
  await chooseSkin('flat');
  const background=await page.request.get(state.server+'/api/app/background');
  if (background.ok()) {
    const bytes=await background.body();
    assert.ok([path.join(process.env.PROJECTX_FLOW_SOURCE_ROOT,'resources','background.jpg'),path.join(shared,'evidence','首次登录强制改密.png')].some(file=>fs.readFileSync(file).equals(bytes)), 'Use the default background or this run’s synthetic image');
  }
  else assert.equal(background.status(),404);
  const upload=page.waitForResponse(r=>r.url()===bg&&r.request().method()==='POST');
  const pick=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'上传背景图'}).click();
  await (await pick).setFiles(path.join(shared,'evidence','首次登录强制改密.png'));
  assert.ok((await upload).ok());
  try {
    const slider=page.getByRole('heading',{name:'背景图透明度'}).locator('..').getByRole('slider');
    await slider.scrollIntoViewIfNeeded();
    const box=await slider.boundingBox();
    const y=box.y+box.height/2;
    const persisted=page.waitForResponse(r=>r.url()===pref&&r.request().method()==='PATCH'&&r.request().postDataJSON()?.backgroundOpacity!==undefined);
    await page.mouse.move(box.x+box.width*.2,y);
    await page.mouse.down();
    for (const position of [.82,.1,.72]) await page.mouse.move(box.x+box.width*position,y,{steps:5});
    await page.mouse.up();
    const expected=Number(await slider.inputValue());
    assert.ok(expected>.3 && expected<.4);
    assert.ok((await persisted).ok());
    await page.waitForFunction(async ([url,v])=>(await (await fetch(url)).json()).backgroundOpacity===v,[pref,expected]);
    await page.reload({waitUntil:'networkidle'});
    await page.getByRole('tab',{name:/客户端/}).click();
    assert.equal(Number(await slider.inputValue()),expected);
    console.log('Windows pointer input, database readback and refreshed slider',expected);
  } finally {
    await page.getByRole('button',{name:'移除背景图'}).click();
    const [deleted]=await Promise.all([
      page.waitForResponse(r=>r.url()===bg&&r.request().method()==='DELETE'),
      page.getByRole('button',{name:'移除',exact:true}).click(),
    ]);
    assert.ok(deleted.ok());
  }
  assert.equal((await prefs()).backgroundOpacity,0);
  await changeAccount('admin');
  assert.equal(await page.locator('html').getAttribute('data-skin'),'paper-edge');
  await chooseSkin(adminBefore.themeSkin||'paper-edge');
  await changeAccount('flow_teacher');
  assert.equal(await page.locator('html').getAttribute('data-skin'),'flat');
  await chooseSkin(teacherBefore.themeSkin||'paper-edge');
  await changeAccount('admin');
  console.log('Independent skin preferences survived admin/teacher login changes in the same browser');
}

async function checkDesignerLifecycle(page) {
  const tag='设计器回归'+Date.now();
  const make=async(route,data)=>{
    const reply=await page.request.post(state.server+route,{data});
    assert.ok(reply.ok(),route+' '+reply.status());
    return reply.json();
  };
  const build=async letter=>{
    const name=tag+letter;
    const card=await make('/api/cards',{subject:'math',subjectLabel:'数学',title:name,examDate:new Date().toISOString().slice(0,10)});
    const exam=await make('/api/exams',{name,cardId:card.id,mode:'formal',subject:'数学',gradeId:state.grade.id,classId:state.cls.id});
    return {card,exam,name};
  };
  const [one,two]=[await build('甲'),await build('乙')];
  await page.goto(state.server+'/home',{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'答题卡设计',exact:true}).first().click();
  await page.getByText(one.name,{exact:true}).first().click();
  await page.getByRole('button',{name:'基本信息',exact:true}).click();
  const title=page.getByText('标题',{exact:true}).locator('../..').getByRole('textbox');
  assert.equal(await title.inputValue(),one.name);
  await title.fill(one.name+'改');
  await page.evaluate(()=>history.back());
  const guard=page.getByRole('alertdialog',{name:'未保存的更改'});
  await guard.getByRole('button',{name:'留在此页'}).click();
  assert.equal(await title.inputValue(),one.name+'改');
  await title.fill(one.name+'复核');
  await page.evaluate(()=>history.back());
  await guard.getByRole('button',{name:'离开',exact:true}).click();
  await page.waitForURL('**/home');
  const saved=await (await page.request.get(state.server+'/api/cards/'+one.card.id)).json();
  assert.equal(saved.title,one.name+'复核');
  await page.goto(state.server+'/exam-manage',{waitUntil:'networkidle'});
  for(const test of [one,two]) await page.getByRole('checkbox',{name:'选择考试 '+test.name,exact:true}).click();
  const remove=page.getByRole('button',{name:'删除选中答题卡',exact:true});
  const choose=async confirm=>{
    const dialog=page.waitForEvent('dialog').then(async event=>{
      const safe=event.message().includes('这 2 张')&&[one,two].every(x=>event.message().includes(x.name))&&event.message().includes('2 场考试');
      if(confirm&&safe) await event.accept(); else await event.dismiss();
      assert.ok(safe,'Only the two newly created exams may be affected');
    });
    await Promise.all([dialog,remove.click()]);
  };
  await choose(false);
  for(const test of [one,two]) assert.equal((await page.request.get(state.server+'/api/cards/'+test.card.id)).status(),200);
  await choose(true);
  await page.getByText('已删除 2 张答题卡',{exact:true}).waitFor();
  for(const test of [one,two]){
    assert.equal((await page.request.get(state.server+'/api/cards/'+test.card.id)).status(),404);
    const kept=await (await page.request.get(state.server+'/api/exams/'+test.exam.id)).json();
    assert.equal(kept.id,test.exam.id);
    assert.equal(kept.card_id,null);
  }
  console.log('Dirty editor supported stay and leave; bulk removal unlinked exactly the two dedicated exams.');
}

async function checkResponsivePages(page) {
  const observations = [];
  const student = step.startsWith('student');
  const routes = student ? ['/scores'] : ['/home', '/design', '/exam-manage', '/analysis', '/admin-console', '/guide', '/sponsor'];
  for (const [skin, label] of [['flat', /明澈/], ['paper-edge', /纸锋/]]) {
    for (const [theme, themeLabel] of [['light', '亮色'], ['dark', '暗色']]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(state.server + '/account-settings', { waitUntil: 'networkidle' });
      await page.getByRole('tab',{name:/客户端/}).click();
      const switcher = page.getByRole('button', { name: '切换外观与皮肤' }).first();
      await switcher.click();
      await page.getByRole('menuitemradio', { name: label }).click();
      await page.getByRole('menuitemradio', {name:label}).waitFor({state:'hidden'});
      await switcher.click();
      await page.getByRole('menuitemradio', {name:themeLabel}).click();
      for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
        await page.setViewportSize({width,height});
        for (const route of routes) {
          await page.goto(state.server + route, { waitUntil: 'networkidle' });
          if (student) {
            if (width === 390) {
              await page.goto(state.server+'/account-settings', {waitUntil:'networkidle'});
              const nav = page.getByRole('navigation',{name:'主导航'}).filter({has:page.getByRole('button',{name:/成绩/})}).last();
              await nav.getByRole('button',{name:/成绩/}).click();
            }
            await page.getByText(state.cardTitle,{exact:true}).click();
            await page.getByRole('button',{name:/返回/}).first().waitFor();
          }
          const row = await page.evaluate(() => ({
            path: location.pathname, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            skin: document.documentElement.dataset.skin, theme: document.documentElement.dataset.theme,
            textLength: document.body.innerText.length
          }));
          observations.push({...row, expected:route, viewportHeight:height});
          fs.writeFileSync(path.join(shared,'evidence',student?'学生详情尺寸巡检.json':'界面尺寸巡检.json'),JSON.stringify(observations,null,2));
          assert.equal(row.skin,skin); assert.equal(row.theme,theme); assert.equal(row.path,route);
          assert.ok(row.textLength>15);
          await page.screenshot({path:path.join(shared,'evidence',skin+'-'+theme+'-'+width+'-'+route.slice(1)+'.png')});
        }
      }
    }
  }
  const overflow=observations.filter(r=>r.scrollWidth>r.width+1);
  console.log('Measured pages',observations.length,'with horizontal overflow',overflow.map(r=>[r.path,r.width,r.scrollWidth]));
  assert.deepEqual(overflow,[], 'Pages with unintended horizontal overflow');
}
async function verifyAnalysisBands(page) {
  const settings = state.server+'/api/system-settings';
  const bands = state.server+'/api/analysis/config/bands';
  const before = await (await page.request.get(bands)).json();
  const prev = (await (await page.request.get(settings)).json()).data;
  const keys = ['analysis_difficulty_bands','analysis_discrimination_bands'];
  await page.goto(state.server+'/global-settings', {waitUntil:'networkidle'});
  try {
    for (const [type, name] of [['难度系数 P 档位','难度验收'],['区分度 D 档位','区分验收']]) {
      const area = page.getByText(type,{exact:true}).locator('..');
      await area.getByPlaceholder('档位名').last().fill(name);
      await area.locator('input[type=color]').last().fill('#876543');
    }
    const [saved]=await Promise.all([
      page.waitForResponse(r=>r.url()===settings&&r.request().method()==='PUT'),
      page.getByRole('button',{name:'保存全局设置',exact:true}).click(),
    ]);
    assert.equal(saved.status(),200);
    const updated=await (await page.request.get(bands)).json();
    assert.equal(updated.difficulty.at(-1).label,'难度验收');
    assert.equal(updated.discrimination.at(-1).label,'区分验收');
    assert.equal(updated.discrimination.at(-1).color,'#876543');
    await page.goto(state.server+'/analysis',{waitUntil:'networkidle'});
    await page.getByRole('row',{name:new RegExp(state.cardTitle)}).first().click();
    await page.getByRole('tab',{name:'题目分析'}).click();
    await page.getByText(/难度验收 0\.80/).first().waitFor();
    await page.getByText(/区分验收 1\.00/).first().waitFor();
    await snapshot(page,'更新后的难度与区分度档位');
  } finally {
    const restored=await page.request.put(settings,{data:{settings:Object.fromEntries(keys.map(key=>[key,prev[key]??'']))}});
    assert.ok(restored.ok());
    assert.deepEqual(await (await page.request.get(bands)).json(),before);
  }
}
async function verifyAdminTools(page) {
  const response = (path, status) => page.waitForResponse(r => new URL(r.url()).pathname === path && r.status() === status);
  await page.goto(state.server + '/global-settings', {waitUntil: 'networkidle'});
  const dialogs = [];
  const confirmDemo = async d => {
    if (d.type() === 'confirm' && d.message().includes('演示')) {
      dialogs.push(d.type());
      await d.accept();
    } else await d.dismiss();
  };
  page.on('dialog', confirmDemo);
  try {
    const [first, second] = await Promise.all([
      response('/api/db/import-demo', 409), response('/api/db/import-demo', 200),
      page.getByRole('button', {name:'导入演示数据',exact:true}).click(),
    ]);
    assert.equal((await first.json()).code, 'DEMO_IMPORT_REQUIRES_CONFIRMATION');
    assert.ok((await second.json()).stats.exams > 0);
    await Promise.all([response('/api/db/clear-demo', 200), page.getByRole('button', {name:'清除演示数据',exact:true}).click()]);
    assert.equal(dialogs.length,3);
  } finally { page.off('dialog',confirmDemo); }
  const original = await page.request.get(state.server+'/api/exams/'+state.examId);
  assert.equal((await original.json()).name, state.cardTitle);
  await Promise.all([response('/api/wechat/subscriptions/diagnostic',200), page.getByRole('button',{name:'开始自检'}).click()]);
  await page.getByText(/缺少|未配置/).first().waitFor();
  await page.goto(state.server+'/sponsor',{waitUntil:'networkidle'});
  await page.goto(state.server+'/guide',{waitUntil:'networkidle'});
  assert.ok((await page.locator('main').innerText()).length > 200);
  console.log('Windows UI completed demo import confirmation, cleanup, WeChat environment check, and help');
}
async function checkReadOnlyRotation(page) {
  let viewer = page;
  if (step==='teacher-preview-rotation') {
    await page.goto(state.server+'/analysis',{waitUntil:'networkidle'});
    await page.getByRole('row',{name:new RegExp(state.cardTitle)}).first().click();
    await page.getByRole('tab',{name:'成绩',exact:true}).click();
    await page.getByRole('row').filter({hasText:'10008'}).getByRole('button',{name:'预览',exact:true}).click();
    viewer=page.getByRole('dialog');
  } else if (step.startsWith('teacher')) {
    const spec=JSON.parse(fs.readFileSync(path.join(shared,'cache-exam.json')));
    await page.goto(state.server+'/analysis',{waitUntil:'networkidle'});
    await page.getByRole('row',{name:new RegExp(spec.title)}).first().click();
    await page.getByRole('button',{name:'分数有问题？'}).click();
    await page.getByRole('button',{name:/^个别改分/}).click();
    await page.getByRole('textbox',{name:'搜索学生'}).fill('10009');
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await page.getByRole('button',{name:/测试学生10009/}).first().click();
    await page.locator('button').filter({has:page.locator('img')}).filter({hasText:/选择题|解答题|答题卡/}).first().click();
    viewer=page.getByRole('dialog');
  } else {
    await page.goto(state.server+'/scores',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'查看原卷'}).first().click();
    await page.getByRole('button',{name:'返回成绩'}).waitFor();
  }
  const initial=viewer.locator('img[alt]:not([alt=""])').first();
  await initial.scrollIntoViewIfNeeded();
  const [width,height,alt]=await initial.evaluate(async image=>{
    await image.decode();
    return [image.naturalWidth,image.naturalHeight,image.alt];
  });
  assert.ok(width>0 && height>0);
  for (const angle of [90,180,270,0]) {
    await viewer.getByRole('button',{name:'顺时针旋转 90 度'}).click();
    await viewer.getByText(angle+'°',{exact:true}).waitFor();
    if (angle) {
      const image=viewer.getByRole('img',{name:alt,exact:true}).first();
      const box=[0,0,...(angle===180?[width,height]:[height,width])].join(' ');
      assert.equal(await image.getAttribute('viewBox'),box);
      const displayed=await image.boundingBox();
      assert.ok(Math.abs(displayed.width/displayed.height-(angle===180?width/height:height/width))<0.03);
    } else {
      assert.equal(await initial.evaluate(async image=>{await image.decode();return image.naturalWidth}),width);
    }
  }
  console.log('Read-only image rotated through 90, 180, 270, 0:',alt,width,height);
}
async function checkAnalysisDialogs(page) {
  await page.goto(state.server+'/analysis', {waitUntil:'networkidle'});
  await page.getByRole('row',{name:new RegExp(state.cardTitle)}).first().click();
  await page.getByRole('button',{name:/临界生完整名单/}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('临界生名单',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('tab',{name:'题目分析'}).click();
  await page.getByRole('row').filter({has:page.getByRole('cell',{name:'1',exact:true})}).filter({hasText:'客观'}).first().click();
  await dialog.getByText(/第 1 题 · 全班得分/).waitFor();
  await dialog.getByText(/测试学生10008/).first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'导出',exact:true}).click();
  const templates = state.server+'/api/export/templates';
  const original = await (await page.request.get(templates)).json();
  const touched = [];
  try {
    for (const slot of [1,2,3,4]) {
      const field = dialog.getByPlaceholder('模板名称').nth(slot-1);
      const name = '双机模板 '+slot;
      await field.fill(name);
      const [response] = await Promise.all([
        page.waitForResponse(r=>r.url()===templates+'/'+slot && r.request().method()==='PUT'),
        dialog.getByRole('button',{name:'保存',exact:true}).nth(slot-1).click(),
      ]);
      assert.equal(response.status(),200);
      touched.push(slot);
      const saved=(await (await page.request.get(templates)).json()).find(t=>t.slot===slot);
      assert.equal(saved.name,name);
      assert.ok(saved.columns.length>0);
    }
    await dialog.getByText('模板4',{exact:true}).click();
    const [download]=await Promise.all([page.waitForEvent('download'),dialog.getByRole('button',{name:'导出 Excel'}).click()]);
    await download.saveAs(path.join(shared,'evidence','模板四成绩导出.xlsx'));
  } finally {
    for (const slot of touched) {
      const saved=original.find(row=>row.slot===slot);
      const url=templates+'/'+slot;
      const response=saved?await page.request.put(url,{data:{name:saved.name,columns:saved.columns,sideTableN:saved.side_table_n,gapCols:saved.gap_cols}}):await page.request.delete(url);
      assert.ok(response.ok());
    }
  }
  console.log('Question 1 and borderline dialogs rendered; four templates persisted, template 4 exported, original slots restored');
}
async function printStudentReport(page){
  await page.goto(state.server+'/analysis',{waitUntil:'networkidle'});
  await page.getByRole('row',{name:new RegExp(state.cardTitle)}).first().click();
  await page.getByRole('tab',{name:'成绩',exact:true}).click();
  await page.getByRole('row').filter({hasText:'测试学生10008'}).first().click();
  await page.getByRole('button',{name:'打印报告单',exact:true}).click();
  await page.getByText('成绩报告单预览',{exact:true}).waitFor();
  await page.waitForLoadState('networkidle');
  await snapshot(page,'学生个人报告单预览');
  const bytes=await page.pdf({format:'A4',printBackground:true,preferCSSPageSize:true,path:path.join(shared,'evidence','学生个人报告单.pdf')});
  assert.ok(bytes.length>1000);
}
async function feedbackUi(page){
  const file=path.join(shared,'feedback-ui.json');
  if(step==='teacher-feedback-ui'){
    await page.goto(state.server+'/account-settings',{waitUntil:'networkidle'});
    await page.getByRole('tab',{name:'问题反馈'}).click();
    await page.getByRole('button',{name:/＋ 提交反馈/}).click();
    const form=page.locator('form').filter({has:page.getByPlaceholder(/一句话说明问题/)});
    const title='双机界面反馈 '+Date.now(),content='在测试账号的设置页面提交两张界面截图，供管理员核对。';
    const first=path.join(shared,'evidence','反馈提交前.png'),second=path.join(shared,'evidence','反馈填写后.png');
    await form.screenshot({path:first});
    await form.getByPlaceholder(/一句话说明问题/).fill(title);await form.getByPlaceholder(/操作步骤：/).fill(content);
    await form.screenshot({path:second});
    await form.locator('input[type=file]').setInputFiles([first,second]);
    const [saved]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/feedback'&&r.request().method()==='POST'),form.getByRole('button',{name:'提交反馈',exact:true}).click()]);
    assert.equal(saved.status(),201);
    const data=(await saved.json()).data;
    fs.writeFileSync(file,JSON.stringify({title,content,id:data.id,files:[first,second].map(f=>path.basename(f))}));
    await page.getByText(title,{exact:true}).waitFor();
  }else{
    const f=JSON.parse(fs.readFileSync(file));
    await page.goto(state.server+'/global-settings',{waitUntil:'networkidle'});
    const title=page.getByText(f.title,{exact:true});await title.waitFor();
    const entry=title.locator('xpath=ancestor::div[.//button[normalize-space(.)="详情"]][1]');
    const details=entry.getByRole('button',{name:'详情',exact:true});await details.click();
    const record=title.locator('xpath=ancestor::div[.//button[normalize-space(.)="收起"] and .//details][1]');
    await record.getByText(f.content,{exact:true}).waitFor();
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:state.server});
    await record.getByRole('button',{name:'复制',exact:true}).click();
    const markdown=await page.evaluate(()=>navigator.clipboard.readText());
    assert.ok(markdown.includes(f.title)&&markdown.includes(f.content)&&markdown.includes(f.files[0]));
    for(const name of f.files){
      const [dl]=await Promise.all([page.waitForEvent('download'),record.getByRole('button',{name:new RegExp(name)}).click()]);
      assert.deepEqual(fs.readFileSync(await dl.path()),fs.readFileSync(path.join(shared,'evidence',name)));
    }
    await record.getByRole('button',{name:'标记已处理'}).click();
    await page.getByText('重新打开',{exact:true}).first().waitFor();
    await page.getByText('已处理',{exact:true}).first().click();
    await title.waitFor();
    await snapshot(page,'管理员处理双附件反馈');
    const marked=title.locator('xpath=ancestor::div[.//button[normalize-space(.)="重新打开"]][1]');
    await marked.getByRole('button',{name:'删除',exact:true}).click();
    const confirm=page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
    await confirm.getByRole('button',{name:/删除/}).click();
    await title.waitFor({state:'hidden'});
  }
}

async function providerUi(page){
  await page.goto(state.server+'/global-settings',{waitUntil:'networkidle'});
  await page.getByRole('button',{name:/新增系统服务商/}).click();
  const form=page.getByText('新增系统服务商',{exact:true}).locator('..');
  const name='界面回环服务 '+Date.now(), mockKey='fixture-only-'+Date.now();
  const fields=form.locator('input');
  assert.equal(await fields.count(),4);
  await fields.nth(0).fill(name);
  await fields.nth(1).fill('http://127.0.0.1:8000');
  await fields.nth(2).fill(mockKey);await fields.nth(3).fill(JSON.stringify(['e2e-local']));
  const [response]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/ai/providers/system'&&r.request().method()==='POST'),form.getByRole('button',{name:'保存',exact:true}).click()]);
  assert.equal(response.status(),201);
  const provider=await response.json();assert.ok(provider.id);
  await page.getByText(name,{exact:false}).first().waitFor();await snapshot(page,'全局设置中的回环服务商');
  const route='/api/analysis/exams/'+state.examId+'/ai-analysis';
  const result=await page.evaluate(async ({provider,route,mockKey})=>{
    async function request(url,method='GET',payload){
      const response=await fetch(url,{method,headers:payload?{'Content-Type':'application/json'}:{},body:payload?JSON.stringify(payload):undefined});
      return {status:response.status,body:await response.json()};
    }
    const url='/api/ai/providers/system/'+provider.id;
    try{
      const row=(await request('/api/ai/providers/system')).body.find(p=>p.id===provider.id);
      const created=await request(route,'POST',{model:'e2e-local',providerId:provider.id,force:true});
      if(created.status!==202)throw Error('AI job '+created.status);
      let final;
      for(let i=0;i<40;i++){
        final=(await request('/api/analysis/ai-analysis/jobs/'+created.body.jobId)).body;
        if(['completed','succeeded','done','failed','error'].includes(final.status))break;
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      const disabled=await request(url,'PUT',{isActive:false});
      const rejected=await request(route,'POST',{model:'e2e-local',providerId:provider.id,force:true});
      return {baseUrl:row.baseUrl,masked:row.apiKey!==mockKey,disabled:disabled.status,rejected:rejected.status,status:final.status,hasReport:Boolean(final.result?.report?.overallJudgement),tools:final.result?.toolCalls?.map(x=>x.name)};
    }finally{await request(url,'DELETE');}
  },{provider,route,mockKey});
  fs.writeFileSync(path.join(shared,'evidence','浏览器回环服务商.json'),JSON.stringify(result,null,2));
  assert.equal(result.baseUrl,'http://127.0.0.1:8000/v1');assert.ok(result.masked&&result.hasReport);
  assert.equal(result.disabled,200);assert.equal(result.rejected,409);assert.ok(result.tools.includes('get_exam_overview'));
}

async function accountBackup(page){
  await page.getByRole('button',{name:'账号菜单',exact:true}).first().click();
  const backup=path.join(shared,'账户菜单MariaDB备份.zip');
  if(step==='admin-backup-export'){
    const [download]=await Promise.all([page.waitForEvent('download',{timeout:180000}),page.getByRole('menuitem',{name:'导出数据',exact:true}).click()]);
    const bytes=fs.readFileSync(await download.path());
    assert.equal(bytes.readUInt32LE(0),0x04034b50);
    fs.writeFileSync(backup,bytes);console.log('Saved backup from account menu',bytes.length);
  }else{
    const bytes=fs.readFileSync(backup);
    assert.equal(bytes.readUInt32LE(0),0x04034b50);
    const destination=await page.request.get(state.server+'/api/exams/'+state.examId);
    assert.equal(destination.status(),200);
    const exam=await destination.json();
    assert.equal(exam.card_id,state.cardId,'Restore only to the service containing this run’s seeded card');
    assert.equal(exam.name,state.cardTitle);
    assert.equal(exam.class_id,state.cls.id);
    const snapshot=JSON.parse(fs.readFileSync(path.join(shared,'备份恢复前快照.json')));
    assert.ok(snapshot.id&&snapshot.sha256===require('node:crypto').createHash('sha256').update(bytes).digest('hex'),'Use the exported archive verified against the pre-restore snapshot');
    const [picker]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('menuitem',{name:'导入数据',exact:true}).click()]);
    const restored=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/db/restore'&&r.request().method()==='POST',{timeout:180000});
    await picker.setFiles(backup);const response=await restored;
    assert.equal(response.status(),200);
    const status=await page.evaluate(async()=> (await fetch('/api/auth/me')).status);assert.equal(status,401);
    console.log('Restored account-menu ZIP; previous session:',status);
  }
}

async function retentionUi(page){
  const setup=JSON.parse(fs.readFileSync(path.join(shared,'retention-test.json')));
  const spec=JSON.parse(fs.readFileSync(path.join(shared,'cache-exam.json')));
  await page.goto(state.server+'/admin-console',{waitUntil:'networkidle'});
  if(step==='admin-retention-setup'){
    const row=page.getByText(setup.policy.name,{exact:true}).locator('xpath=ancestor::div[.//input[@type="number"]][1]');
    await row.getByRole('spinbutton').fill('1');
    for(const toggle of await row.getByRole('switch').all())if(await toggle.getAttribute('aria-checked')!=='true')await toggle.click();
    await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/data-retention-policies/'+setup.policy.id)&&r.request().method()==='PUT'&&r.ok()),row.getByRole('button',{name:'保存',exact:true}).click()]);
    const status=await page.evaluate(async ({exam,policy})=>(await fetch('/api/exams/'+exam,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({retentionPolicyId:policy})})).status,{exam:spec.exam,policy:setup.policy.id});
    assert.equal(status,200);
  }else{
    const row=page.getByText(new RegExp('^#'+spec.exam+' '+spec.title)).locator('xpath=ancestor::div[.//button][1]');
    await Promise.all([page.waitForResponse(r=>r.url().includes('/restore')&&r.request().method()==='POST'&&r.status()===200),row.getByRole('button',{name:'恢复',exact:true}).click()]);
    await page.getByText(new RegExp('考试 #'+spec.exam+' 已恢复')).waitFor();
    await snapshot(page,'管理员恢复被清理考试');
  }
}

async function legacyTeacherUi(page){
  const spec=JSON.parse(fs.readFileSync(path.join(shared,'cache-exam.json')));
  const legacy=JSON.parse(fs.readFileSync(path.join(shared,'legacy-browser.json')));
  validateTargets({server:legacy.origin,scanner:state.scanner});
  await page.goto(legacy.origin+'/analysis',{waitUntil:'networkidle'});
  await login(page,'flow_teacher');
  await page.goto(legacy.origin+'/analysis',{waitUntil:'networkidle'});
  await page.getByRole('row',{name:new RegExp(spec.title)}).first().click();
  await page.getByRole('button',{name:'分数有问题？'}).click();
  await page.getByRole('button',{name:/^个别改分/}).click();
  await page.getByRole('textbox',{name:'搜索学生'}).fill('10009');
  await page.getByRole('button',{name:'搜索',exact:true}).click();
  await page.getByRole('button',{name:/测试学生10009/}).first().click();
  await page.getByRole('button',{name:'整卡改分',exact:true}).click();
  await page.getByRole('button',{name:'重新识别旧卷'}).waitFor();
  const [recognized]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/correction/recognize')&&r.request().method()==='POST'),page.getByRole('button',{name:'重新识别旧卷'}).click()]);
  assert.equal(recognized.status(),200);
  const draft=await recognized.json();
  assert.equal(draft.pages[0].recognition.identity.status,'verified');assert.ok(draft.pages[0].recovery.signature);
  const route='/api/exams/'+spec.exam+'/student/'+state.students.find(u=>u.username==='flow_10009').id+'/correction';
  const fresh=await page.evaluate(async path=>await fetch(path).then(r=>r.json()),route);
  assert.ok(!fresh.pages[0].recognition.geometry);
  await snapshot(page,'Windows教师核对Linux补识别草稿');
  const [save]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===route&&r.request().method()==='PUT'),page.getByRole('button',{name:'保存修改',exact:true}).click()]);
  assert.equal(save.status(),200);
  const saved=await page.evaluate(async path=>await fetch(path).then(r=>r.json()),route);
  assert.ok(saved.pages[0].recognition.geometry);assert.ok(!saved.pages[0].recovery);
  console.log('Windows teacher saved verified recognition',draft.pages[0].sourceId,saved.pages[0].revision);
}

async function main() {
  const args = ['--no-sandbox'];
  if (process.env.PROJECTX_FLOW_CERT_SPKI) {
    assert.match(process.env.PROJECTX_FLOW_CERT_SPKI, /^[A-Za-z0-9+/]{43}=$/);
    args.push(`--ignore-certificate-errors-spki-list=${process.env.PROJECTX_FLOW_CERT_SPKI}`);
  }
  const annotationStage=step==='teacher-text-annotation'||step==='teacher-touch-annotation';
  const reviewerStage=annotationStage||step==='teacher-grading-draft'||step==='teacher-essay-pages';
  context = await chromium.launchPersistentContext(path.join(work, reviewerStage?'edge-annotation-reviewer':step==='teacher-roster-extra' ? 'edge-review-lead' : `edge-${profile}`), {
    ...(process.env.PROJECTX_FLOW_BROWSER ? { executablePath: process.env.PROJECTX_FLOW_BROWSER } : { channel: 'msedge' }),
    headless: true, hasTouch: step==='teacher-touch-annotation', viewport: { width: 1600, height: 1100 }, args, timeout: 60000,
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => {
      const observed = new URL(response.url());
      for (const key of ["mt","token","access_token"]) observed.searchParams.delete(key);
      const url = observed.toString();
      if (!url.includes('/api/') || url.includes('/auth/')) return;
      const entry = { at: new Date().toISOString(), method: response.request().method(), url, status: response.status() };
      if (entry.method === 'POST' && url.endsWith('/scanner/upload/sessions')) {
        const { cardId, name } = response.request().postDataJSON();
        entry.request = { cardId, name };
      }
      requests.push(entry);
      if (entry.request) {
        try { entry.body = { sessionId: (await response.json()).sessionId }; } catch {}
      }
      if (!logTimer) logTimer = setTimeout(() => { logTimer = undefined; flushRequests(); }, 1000);
    });
  });
  if (step === 'teacher-login-retest') await context.clearCookies();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  if (step === 'admin-bootstrap') {
    await checkBootstrap(page);
  } else if (step.startsWith('scanner')) {
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
    const cardText = page.getByText(state.cardTitle, { exact: true }).first();
    if (await cardText.isVisible().catch(() => false)) {
      await cardText.click();
      await page.waitForLoadState('networkidle');
    }
    if (step === 'scanner-scan' || step === 'scanner-live') {
      await page.getByText('本地判分+上传服务器', { exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem('projectx_scanner_mode') === 'remote');
      const files = JSON.parse(fs.readFileSync(path.join(shared, 'manifest.json'), 'utf8')).map(row => path.join(shared, 'images', row.image));
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
    const settingsPath = '/api/system-settings/public';
    if (step === 'teacher-login-retest')
      assert.ok(!requests.some(r => new URL(r.url).pathname === settingsPath), 'Preferences requested before login');
    const settingsAfterLogin = step === 'teacher-login-retest'
      ? page.waitForResponse(response => new URL(response.url()).pathname === settingsPath)
      : null;
    const identifier = reviewerStage ? 'flow_review_1' : step === 'teacher-roster-extra' ? 'flow_review_lead' : profile === 'teacher' ? 'flow_teacher' : profile.startsWith('student') ? `flow_${profile.slice(7)}` : 'admin';
    const [received] = await Promise.all([settingsAfterLogin, login(page, identifier)]);
    if (step === 'teacher-login-retest') {
      assert.equal(received.status(), 200);
      await page.waitForURL('**/home');
      const settings=requests.filter(r=>new URL(r.url).pathname===settingsPath);
      assert.ok(settings.every(r=>r.status===200),'Authenticated preferences must load after login');
      console.log('Fresh teacher login loaded preferences with HTTP', received.status());
    }
    await snapshot(page, `${profile}登录界面`);
    if (step === 'student10008:account-controls') {
      await page.goto(state.server+'/account-settings', {waitUntil:'networkidle'});
      await page.getByRole('tab', {name:'客户端设置'}).click();
      await page.getByText('显示底部 Tab 导航栏', {exact:true}).waitFor();
      for (const name of ['阅卷设置', '问题反馈']) {
        assert.equal(await page.getByRole('tab', {name, exact:true}).count(), 0);
      }
      assert.equal(await page.getByText('背景图透明度', {exact:true}).count(), 0);
      assert.equal(await page.locator('input[type=file], input[type=range]').count(), 0);
    }
    if (step === 'student10008:file-formats') {
      await page.goto(state.server+'/scores',{waitUntil:'networkidle'});
      await page.getByText('纯客观信度验收四题',{exact:true}).locator('../../..').getByRole('button',{name:'查看原卷'}).click();
      const image=page.getByRole('img',{name:'答案第 1 页',exact:true});
      await image.waitFor();
      assert.ok(await image.evaluate(async n=>{await n.decode();return n.naturalWidth>0}));
      for(const [i,original] of ['答题卡原版.pdf','原卷练习.docx'].entries()){
        const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'下载',exact:true}).nth(i).click()]);
        assert.deepEqual(fs.readFileSync(await download.path()),fs.readFileSync(path.join(shared,original)));
      }
      console.log('Student read the answer PNG inline and downloaded byte-identical PDF and DOCX');
    }
    if (step === 'teacher-roster-extra') await decideExtraPapers(page);
    if (step === 'teacher-essay-pages') {
      const { B: spec } = JSON.parse(fs.readFileSync(path.join(shared, 'matrix-exams.json')));
      assert.equal(spec.title, '跨页作文评分补测');
      assert.ok(spec.parts.length >= 2);
      const who = await (await page.request.get(state.server + '/api/auth/me')).json();
      const reviewer = who.user || who;
      assert.equal(reviewer.username, 'flow_review_1');
      await page.goto(state.server + '/exam-manage', { waitUntil: 'networkidle' });
      const row = page.getByRole('row').filter({ has: page.getByText(spec.title, { exact: true }) });
      await row.getByRole('button', { name: '网阅', exact: true }).click();
      await page.getByRole('button', { name: /作文/ }).first().click();
      const poolPath = '/api/review-pool/exams/' + spec.exam + '/blocks/' + spec.block;
      const own = await (await page.request.get(state.server + poolPath + '?mine=1')).json();
      let paper = own.data.entries.find(item => item.studentNumber === '10001' && item.claimedBy === reviewer.id);
      if (!paper) {
        const [claimed] = await Promise.all([
          page.waitForResponse(r => new URL(r.url()).pathname === poolPath + '/claim' && r.request().method() === 'POST'),
          page.getByRole('button', { name: '从试卷池领取试卷', exact: true }).click(),
        ]);
        assert.equal(claimed.status(), 200);
        paper = (await claimed.json()).data;
        fs.writeFileSync(path.join(evidence, '跨页作文教师领卷.json'), JSON.stringify({ reviewer: reviewer.id, exam: spec.exam, cropId: paper.id }, null, 2));
      }
      assert.equal(paper.studentNumber, '10001');
      assert.deepEqual(paper.reviewImages.map(img => img.pageNumber), spec.parts.map(part => part.page));
      const seen = [];
      for (const [i, image] of paper.reviewImages.entries()) {
        const label = `作文第 ${i + 1} 段（第 ${image.pageNumber} 页）`;
        await page.getByRole('button', { name: label, exact: true }).click();
        const img = page.getByRole('img', { name: label, exact: true });
        await img.waitFor();
        const dimensions = await img.evaluate(async node => {
          await node.decode();
          return [new URL(node.currentSrc).pathname, node.naturalWidth, node.naturalHeight];
        });
        assert.deepEqual(dimensions, [new URL(image.imageUrl, state.server).pathname, image.widthPx, image.heightPx]);
        const fetched = await page.request.get(await img.evaluate(node => node.currentSrc));
        assert.equal(fetched.status(), 200);
        const mime = fetched.headers()['content-type'].split(';')[0];
        assert.ok(['image/png', 'image/jpeg', 'image/webp'].includes(mime));
        const bytes = await fetched.body();
        const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
        fs.writeFileSync(path.join(evidence, `作文切图第${image.pageNumber}页.${mime.split('/')[1]}`), bytes);
        seen.push({ page: image.pageNumber, cropId: image.id, width: image.widthPx, height: image.heightPx, sha256 });
        await snapshot(page, '跨页作文第' + image.pageNumber + '页');
      }
      assert.equal(new Set(seen.map(item => item.cropId)).size, spec.parts.length);
      assert.equal(new Set(seen.map(item => item.sha256)).size, spec.parts.length);
      const savePath = '/api/review/exams/' + spec.exam + '/block-crops/' + paper.id + '/submit';
      await page.getByRole('button', { name: '30', exact: true }).click();
      const [saved] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === savePath && r.request().method() === 'POST'),
        page.getByRole('button', { name: '保存并下一份', exact: true }).click(),
      ]);
      assert.equal(saved.status(), 200);
      const submission = await saved.json();
      assert.equal(submission.finalScore ?? submission.data?.finalScore, 30);
      assert.equal(requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === savePath).length, 1);
      fs.writeFileSync(path.join(evidence, '跨页作文教师评分.json'), JSON.stringify({ exam: spec.exam, block: spec.block, reviewer: reviewer.id, seen, score: 30, submission }, null, 2));
    }
    if (step === 'teacher-grading-draft') {
      const enter=async()=>{
        await page.goto(state.server+'/exam-manage',{waitUntil:'networkidle'});
        const row=page.getByRole('row').filter({has:page.getByText('双机识别 B',{exact:true})});
        await row.getByRole('button',{name:'网阅',exact:true}).click();
        await page.getByRole('button',{name:/作文/}).first().click();
        await page.getByRole('button',{name:'30',exact:true}).waitFor();
      };
      await enter();
      const session=state.server+new URL(requests.findLast(r=>r.url.includes('/api/review-session/')).url).pathname;
      const prior=(await (await page.request.get(session)).json()).data;
      try {
        await page.getByRole('button',{name:'30',exact:true}).click();
        const draft=page.getByRole('button',{name:'30',exact:true});
        assert.equal(await draft.getAttribute('aria-pressed'),'true');
        await page.waitForLoadState('networkidle');
        await page.reload({waitUntil:'domcontentloaded'});
        await enter();
        assert.equal(await draft.getAttribute('aria-pressed'),'true','The selected score should return after reopening the marking panel');
        console.log('Grading panel restored the 30-point draft after reload');
      } finally {
        if (prior) await page.request.put(session,{data:{currentIndex:prior.currentIndex,positionJson:prior.positionJson,draftScores:prior.draftScores}});
        else await page.request.delete(session);
      }
    }
    if (annotationStage) {
      if (step==='teacher-text-annotation') {
        await page.addInitScript(()=>{
          Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,value:0});
          delete window.ontouchstart;
        });
      }
      await page.goto(state.server+'/exam-manage',{waitUntil:'networkidle'});
      const row=page.getByRole('row').filter({has:page.getByText('双机识别 B',{exact:true})});
      await row.getByRole('button',{name:'网阅',exact:true}).click();
      await page.getByRole('button',{name:/作文/}).first().click();
      const mark=page.getByRole('button',{name:'批注',exact:true});
      const empty=page.getByRole('button',{name:'从试卷池领取试卷',exact:true});
      await Promise.race([mark.waitFor(),empty.waitFor()]);
      await page.waitForLoadState('networkidle');
      if (await empty.isVisible()) await empty.click();
      else if (!await page.locator('img[draggable=false]').last().isVisible()) await page.getByRole('button',{name:'领取下一份',exact:true}).click();
      await mark.waitFor();
      if (await mark.getAttribute('aria-pressed')!=='true') await mark.click();
      const overlay=page.locator('[data-crop-id]').last();
      await overlay.waitFor();
      console.log('Annotation input capabilities', await page.evaluate(()=>({points:navigator.maxTouchPoints,hasTouch:'ontouchstart' in window,canvas:Boolean(document.querySelector('[data-crop-id] canvas'))})));
      const crop=await overlay.getAttribute('data-crop-id');
      const endpoint='/api/review-annotations';
      const save=page.waitForResponse(r=>new URL(r.url()).pathname===endpoint&&r.request().method()==='POST');
      if (step==='teacher-text-annotation') {
        await overlay.click({position:{x:30,y:30}});
        const input=page.getByRole('textbox',{name:'输入批注'});
        await input.fill('检查论据');
        await input.press('Tab');
      } else {
        const canvas=overlay.locator('canvas');
        await canvas.scrollIntoViewIfNeeded();
        const box=await canvas.boundingBox();
        assert.ok(box && box.width>40 && box.height>40);
        const cdp=await page.context().newCDPSession(page);
        const x=box.x+box.width/2,y=box.y+box.height/2;
        for(const [type,offset] of [['touchStart',0],['touchMove',8],['touchMove',16],['touchEnd',null]]) {
          await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:offset===null?[]:[{x:x+offset,y:y+offset,radiusX:1,radiusY:1}]});
        }
        await cdp.detach();
      }
      const response=await save;
      assert.ok(response.ok());
      const saved=(await response.json()).data;
      const rows=(await (await page.request.get(state.server+endpoint+'?cropId='+encodeURIComponent(crop))).json()).data;
      const read=rows.find(r=>r.id===saved.id);
      assert.ok(read);
      if(step==='teacher-text-annotation') assert.equal(read.dataJson.text,'检查论据');
      else assert.ok(read.dataJson.strokes[0].points.length>=2);
      await snapshot(page,step+'-保存后');
      const other=await request.newContext({baseURL:state.server});
      try {
        const signin=password=>other.post('/api/auth/login',{data:{identifier:'flow_review_2',password}});
        let session=await signin(state.changedPassword);
        if(session.status()===401) session=await signin(state.password);
        assert.ok(session.ok());
        assert.equal((await other.delete(endpoint+'/'+saved.id)).status(),403);
      } finally { await other.dispose(); }
      assert.ok((await page.request.delete(state.server+endpoint+'/'+saved.id)).ok());
      console.log('Saved and read back',read.type,'on the uploaded crop; peer deletion denied; author deleted');
    }
    if (step === 'teacher-legacy-ui') await legacyTeacherUi(page);
    if (['admin-retention-setup', 'admin-retention-restore'].includes(step)) await retentionUi(page);
    if (['admin-backup-export','admin-backup-restore'].includes(step)) await accountBackup(page);
    if (step === 'admin-provider-ui') await providerUi(page);
    if (step === 'admin-tools-ui') await verifyAdminTools(page);
    if (step === 'admin-student-background') {
      await page.goto(state.server+'/global-settings', {waitUntil:'networkidle'});
      await page.getByRole('button', {name:'清除学生历史背景', exact:true}).click();
      const [result] = await Promise.all([
        page.waitForResponse(r=>r.url()===state.server+'/api/admin/backgrounds/purge-students'&&r.request().method()==='POST'),
        page.getByRole('button', {name:'清除', exact:true}).click(),
      ]);
      assert.equal(result.status(), 200);
      await page.getByText('没有需要清除的学生背景', {exact:true}).waitFor();
    }
    if (step === 'admin-feedback-paging') {
      await page.goto(state.server+'/global-settings',{waitUntil:'networkidle'});
      const oldest=page.getByText(/^双机反馈分页-\d+-001$/);
      const newest=page.getByText(/^双机反馈分页-\d+-101$/);
      await newest.waitFor();
      assert.equal(await oldest.count(),0);
      await page.getByRole('button',{name:'加载更多'}).click();
      await oldest.waitFor();
      assert.equal(await newest.count(),1);
      assert.equal(await page.getByText(/^双机反馈分页-\d+-\d{3}$/).count(),101);
    }
    if (step === 'admin-designer-lifecycle') await checkDesignerLifecycle(page);
    if (step === 'admin-card-previews') {
      const cards=JSON.parse(fs.readFileSync(path.join(shared,'card-matrix.json')));
      const cases=[['A',69,'11.1.（20分）'],['B',104,'（60分）'],['C',182,'55.（20分）'],['D',13,'1.（3分）']];
      await page.goto(state.server+'/design',{waitUntil:'networkidle'});
      for(const [key,total,label] of cases) {
        const list=page.getByRole('button',{name:'卡片列表',exact:true});
        if(await list.isVisible()) await list.click();
        const card=(await (await page.request.get(state.server+'/api/cards/'+cards[key].id)).json());
        await page.getByText(card.title,{exact:true}).first().click();
        const paper=page.locator('svg.paper-a4-preview:visible');
        await paper.first().getByText('ID:'+card.id,{exact:true}).waitFor();
        const preview=(await paper.allTextContents()).join('').replace(/\s+/g,'');
        assert.ok(preview.includes(label),key+' preview is missing '+label);
        if(key==='A') assert.match(preview,/填空题（共2题，共4分）/);
        await page.getByRole('button',{name:'PDF',exact:true}).click();
        const dialog=page.getByRole('dialog');
        await dialog.getByRole('heading',{name:'总分 '+total+' 分',exact:true}).waitFor();
        console.log('Preview and export',key,await paper.count(),label,total);
        await page.keyboard.press('Escape');
        await dialog.waitFor({state:'hidden'});
      }
    }
    if (step === 'admin-mobile-drawer') {
      await page.setViewportSize({width:390,height:844});
      await page.goto(state.server+'/home',{waitUntil:'networkidle'});
      await page.getByRole('button',{name:'打开导航菜单'}).click();
      const dialog=page.getByRole('dialog');
      await dialog.getByRole('heading',{name:'Project-X 导航'}).waitFor();
      await dialog.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
      const bounds=await dialog.boundingBox();
      console.log('Mobile drawer dimensions',bounds);
      assert.ok(bounds.x>=-1 && bounds.x+bounds.width<=391 && bounds.y>=-1 && bounds.y+bounds.height<=845);
      await dialog.getByRole('button',{name:'考试管理'}).click();
      await dialog.waitFor({state:'hidden'});
      await page.waitForURL('**/exam-manage');
      console.log('Mobile navigation drawer stayed within viewport and opened exam management');
    }
    if (step === 'admin-review-viewport') {
      const { checkViewports } = require('./production-flow-viewports.cjs');
      await page.setViewportSize({width:1440,height:900});
      await page.goto(state.server + '/exam-manage', {waitUntil:'networkidle'});
      const row=page.getByRole('row').filter({has:page.getByText('双机识别 B',{exact:true})});
      await row.getByRole('button',{name:'网阅',exact:true}).click();
      const tab=page.getByRole('tab',{name:'阅卷分配',exact:true});
      await tab.click();
      const exam=JSON.parse(fs.readFileSync(path.join(shared,'matrix-exams.json'))).B.exam;
      const {blocks}=await (await page.request.get(state.server+'/api/review/exams/'+exam+'/blocks')).json();
      assert.ok(blocks.length >= 2);
      const choice=page.getByRole('combobox',{name:'选择题块'});
      for (const block of blocks) {
        await choice.click();
        await page.getByRole('option').filter({hasText:block.blockTitle}).click();
        await page.getByText('总量 '+block.totalCount,{exact:true}).waitFor();
      }
      await checkViewports(page, path.join(shared,'evidence'), '网阅分配尺寸', tab);
      await page.getByRole('tab',{name:'网阅设置',exact:true}).click();
      for (const block of blocks) await page.getByRole('checkbox',{name:'选择 '+block.blockTitle,exact:true}).waitFor();
      await page.getByRole('button',{name:'保存网阅默认',exact:true}).waitFor();
      console.log('Displayed assignment pools and grading settings for', blocks.map(b=>[b.blockTitle,b.totalCount]));
    }
    if (step === 'admin-account-appearance') await accountAppearance(page);
    if (step === 'admin-analysis-bands') await verifyAnalysisBands(page);
    if (['admin-feedback-ui', 'teacher-feedback-ui'].includes(step)) await feedbackUi(page);
    if (step === 'teacher-print') await printStudentReport(page);
    if (step === 'teacher-analysis-dialogs') await checkAnalysisDialogs(page);
    if (['teacher-preview-rotation','teacher-card-rotation','student10008:rotation'].includes(step)) await checkReadOnlyRotation(page);
    if (step === 'admin-responsive') await checkResponsivePages(page);
    if (step === 'student10008:responsive') {
      const url=state.server+'/api/users/me/settings';
      const previous=await (await page.request.get(url)).json();
      try {
        assert.ok((await page.request.patch(url,{data:{showTabBar:true}})).ok());
        await checkResponsivePages(page);
      } finally {
        assert.ok((await page.request.patch(url,{data:{showTabBar:Boolean(previous.showTabBar)}})).ok());
      }
    }
  }
  if (actions.length) await performActions(page, actions);
  if (watch) {
    await snapshot(page, '补录前学生界面');
    await page.getByText(state.cardTitle, { exact: true }).waitFor({ timeout: 180000 });
    await snapshot(page, '补录后学生自动更新');
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
