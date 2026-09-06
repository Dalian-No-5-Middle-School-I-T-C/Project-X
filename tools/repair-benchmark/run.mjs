import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import mysql from 'mysql2/promise';
import sharp from 'sharp';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const n = argv.indexOf('--' + name); return n < 0 ? fallback : argv[n + 1]; };
const source = path.resolve(arg('source', path.join(here, '../..')));
const ref = arg('ref', 'working'), mode = arg('mode', 'candidate'), distro = arg('distro', 'Ubuntu');
assert(['candidate', 'baseline'].includes(mode));
const runId = `${mode}-${Date.now()}`;
const out = path.join(here, 'results', runId), stage = path.join(out, 'source');
await fs.mkdir(out, {recursive:true});
const results = [], processes = [], tokens = new Map();
const base = 'http://127.0.0.1:5291', local = 'http://127.0.0.1:5292';
const password = 'Benchmark-2026-Local!';
const linux = p => '/mnt/' + p[0].toLowerCase() + p.slice(2).replaceAll('\\', '/');
let db, browser, wslStarted = false, fatal, stopping=false;
const metadata = {runId, ref, mode, source, startedAt:new Date().toISOString(), fixtures:[]};
const harnessHash=createHash('sha256');
for(const file of ['run.mjs','python-probes.py','provider-stub.py','wsl-runtime.sh','package-lock.json'])harnessHash.update(file).update(await fs.readFile(path.join(here,file)));
metadata.harnessHash=harnessHash.digest('hex');
const delay = ms => new Promise(r=>setTimeout(r,ms));
function processRun(exe, args, cwd=stage, env=process.env, background=false, label='command') {
  const log = createWriteStream(path.join(out, `${label}.log`), {flags:'a'});
  const child = spawn(exe, args, {cwd, env, windowsHide:true, stdio:['ignore','pipe','pipe']});
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data=>{log.write(data); output=(output+data).slice(-200000);});
  const done = new Promise((resolve,reject)=>{
    child.on('error',reject);
    child.on('close',code=>{log.end(); code===0 ? resolve(output) : reject(new Error(`${label} exit ${code}; see ${label}.log: ${output.slice(-1500)}`));});
  });
  if (background) { done.catch(()=>{}); child.done=done; processes.push(child); return child; }
  return done;
}
const git = args => processRun('git', args, source, process.env, false, 'git');
const npm = args => processRun('cmd.exe', ['/d','/s','/c', 'npm.cmd '+args.join(' ')], stage, process.env, false, 'build');
const wsl = (args, background=false) => processRun('wsl.exe', ['-d',distro,'-u','root','--','bash',linux(path.join(out,'wsl-runtime.sh')),...args], here, process.env, background, 'wsl');
async function check(id,title,family,fn) {
  const started=Date.now();
  try { const evidence=await fn(); results.push({id,title,family,status:'PASS',evidence,durationMs:Date.now()-started}); }
  catch(error) { results.push({id,title,family,status:error.message.startsWith('Blocked:')?'BLOCKED':error.cause?.code?.startsWith('ECONN')?'ERROR':'FAIL',evidence:error.message,durationMs:Date.now()-started}); }
  console.log(`${results.at(-1).status} ${id} ${title}`);
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({metadata,results},null,2));
}
async function request(root,route,method='GET',body) {
  const response=await fetch(root+route,{method,headers:{...(tokens.has(root)?{Authorization:`Bearer ${tokens.get(root)}`} : {}),...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});
  const raw=await response.text();
  assert(response.ok,`${method} ${route}: HTTP ${response.status} ${raw.slice(0,900)}`);
  return raw?JSON.parse(raw):null;
}
const api=(route,method,body)=>request(base,route,method,body);
async function waitHealth(url, timeout=180000) {
  const until=Date.now()+timeout;
  while(Date.now()<until && !stopping) { try { if((await fetch(url,{signal:AbortSignal.timeout(2000)})).ok)return; }catch{} await delay(1000); }
  throw new Error(`Infrastructure: health timeout ${url}`);
}
async function login(root) {
  const result=await request(root,'/api/auth/login','POST',{identifier:'admin',password:'admin123'});
  tokens.set(root,result.token);
  if(result.passwordChangeRequired) {
    await request(root,'/api/auth/change-password','POST',{oldPassword:'admin123',newPassword:password});
    tokens.set(root,(await request(root,'/api/auth/login','POST',{identifier:'admin',password})).token);
  }
}
async function seedScores(examId,students,cardId,blockId,scores,max=150) {
  for(let i=0;i<students.length;i++) {
    await db.execute('INSERT INTO student_scores(exam_id,student_id,total_score,objective_score,`rank`) VALUES(?,?,?,?,?)',[examId,students[i].id,scores[i],scores[i],i+1]);
    await db.execute('INSERT INTO question_scores(exam_id,student_id,question_number,block_id,score,max_score,score_type) VALUES(?,?,1,?,?,?,?)',[examId,students[i].id,blockId,scores[i],max,'objective']);
  }
  metadata.fixtures.push({kind:'independent SQL scores',examId,scores,max,reason:'Does not repair or alter the end-to-end exam; isolates downstream assertions.'});
}
try {
  for(const port of [5290,5291,5292,5293,8791,3397]) {
    for(let attempt=0;attempt<15;attempt++) {
      try {await new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));});break;}
      catch(error){if(attempt===14)throw new Error(`Infrastructure: port ${port}: ${error.message}`);await delay(1000);}
    }
  }
  metadata.sha=(await git(['rev-parse',ref==='working'?'HEAD':ref])).trim();
  metadata.workingDiff=ref==='working'?(await git(['diff','--stat'])):null;
  await fs.mkdir(stage,{recursive:true});
  console.log(`Preparing isolated snapshot ${metadata.sha}`);
  if(ref==='working') {
    const list = await new Promise((resolve,reject)=>{let data='';const p=spawn('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:source,windowsHide:true});p.stdout.on('data',b=>data+=b);p.on('close',c=>c?reject(new Error('git ls-files failed')):resolve(data.split('\0').filter(Boolean)));});
    const contentHash=createHash('sha256');
    for(const file of list) {
      if(file.startsWith('tools/repair-benchmark/') || /(^|\/)(\.env|node_modules|data|\.venv)(\/|$)/.test(file))continue;
      const target=path.join(stage,file);await fs.mkdir(path.dirname(target),{recursive:true});const content=await fs.readFile(path.join(source,file));await fs.writeFile(target,content);contentHash.update(file).update(content);
    }
    metadata.workingContentHash=contentHash.digest('hex');
  } else { const zip=path.join(out,'snapshot.zip');await git(['archive','--format=zip',`--output=${zip}`,metadata.sha]);new AdmZip(zip).extractAllTo(stage,true); }
  const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
  assert.equal(await hash(path.join(stage,'package-lock.json')),await hash(path.join(source,'package-lock.json')),'Dependency lock differs: install matching source dependencies before running benchmark');
  await fs.symlink(path.join(source,'node_modules'),path.join(stage,'node_modules'),'junction');
  await fs.cp(path.join(source,'resources/native'),path.join(stage,'resources/native'),{recursive:true});
  for(const target of ['build:web','build:scanner','build:server']) {console.log(`Building ${target}`);await npm(['run',target]);}
  await processRun(process.execPath,['scripts/package-server-ubuntu.cjs'],stage,process.env,false,'package');
  const release=path.join(stage,'release/server-ubuntu24');
  const packageName=(await fs.readdir(release,{withFileTypes:true})).find(e=>e.isDirectory()).name;
  const packaged=path.join(release,packageName);
  await check('B16','Ubuntu 部署包包含可安装的 Python AI 服务','packaging-ai',async()=>{assert(existsSync(path.join(packaged,'llmclient/server.py')),'Deployment package omits llmclient/server.py');assert(existsSync(path.join(packaged,'llmclient/requirements.txt')));return 'Python source and requirements included';});
  await fs.writeFile(path.join(out,'wsl-runtime.sh'),(await fs.readFile(path.join(here,'wsl-runtime.sh'),'utf8')).replaceAll('\r\n','\n'));
  if(arg('ai-env',''))await fs.copyFile(path.resolve(arg('ai-env','')),path.join(out,'real-ai.env'));
  await fs.copyFile(path.join(here,'provider-stub.py'),path.join(out,'provider-stub.py'));
  console.log('Starting isolated WSL MariaDB, Nginx and application');
  wslStarted=true;wsl(['start',runId,linux(packaged),linux(stage),linux(out)],true);
  const env={...process.env,PORT:'5292',PROJECTX_AUTH_ENFORCE:'1',PROJECTX_ENABLE_SCANNER:'1',PROJECTX_DB_PATH:path.join(out,'scanner/projectx.db'),ANSWER_CARD_DATA_DIR:path.join(out,'scanner/cards'),ANSWER_CARD_CLIENT_DIST:path.join(stage,'dist/scanner'),USERPROFILE:path.join(out,'scanner/profile'),LLMCLIENT_AUTOSTART:'0'};
  for(const key of Object.keys(env))if(key.startsWith('PROJECTX_MARIADB_')||key.startsWith('MYSQL_'))delete env[key];
  processRun(process.execPath,['dist/server/index.mjs'],stage,env,true,'scanner');
  await Promise.race([Promise.all([waitHealth(base+'/api/app/health',1200000),waitHealth(local+'/api/app/health')]),...processes.map(p=>p.done.then(()=>{throw new Error('Infrastructure: service exited before readiness');}))]);
  await login(base);await login(local);
  db=await mysql.createConnection({host:'127.0.0.1',port:3397,user:'root',password:'benchmark-database-only',database:'projectx_bench'});
  await check('B01','全局设置保存并读回','mariadb-datetime',async()=>{await api('/api/system-settings','PUT',{settings:{benchmark_marker:runId}});assert.equal((await api('/api/system-settings')).data.benchmark_marker,runId);return 'Saved marker persisted';});
  await check('B02','分析阈值保存并读回','mariadb-datetime',async()=>{const value=await api('/api/analysis/config/thresholds');await api('/api/analysis/config/thresholds','PUT',value);assert.deepEqual(await api('/api/analysis/config/thresholds'),value);return value;});
  await db.query("INSERT INTO system_settings(`key`,value) VALUES('require_original_paper','0'),('analysis_pass_rate','0.6'),('analysis_excellent_rate','0.9') ON DUPLICATE KEY UPDATE value=VALUES(value)");
  metadata.fixtures.push({kind:'SQL system settings',reason:'Original-paper prerequisite and fixed score thresholds; B01/B02 results remain unchanged.'});
  const grade=await api('/api/classes/grades','POST',{name:'基准测试年级'});
  const cls=await api('/api/classes','POST',{gradeId:grade.id,name:'一班'});
  const cls2=await api('/api/classes','POST',{gradeId:grade.id,name:'二班'});
  const students=[];
  for(let i=0;i<4;i++)students.push(await api('/api/users','POST',{username:`bench_${i}`,name:`测试学生${i+1}`,role:'student',student_number:`8100${i}`,password}));
  await api(`/api/classes/${cls.id}/students`,'POST',{studentIds:students.slice(0,2).map(s=>s.id)});
  await api(`/api/classes/${cls2.id}/students`,'POST',{studentIds:students.slice(2).map(s=>s.id)});
  let card=await api('/api/cards','POST',{subject:'math',title:'自动化链路考试',examDate:'2026-09-06'});
  card.sided='single';const blockId='bench_objective';
  card.bodyBlocks=[{id:blockId,type:'objective',title:'选择题',questionStart:1,questionCount:4,optionCount:4,mode:'single',scorePerQuestion:5,density:'compact',answerKey:{'1':['A'],'2':['A'],'3':['A'],'4':['A']},questions:[1,2,3,4].map(questionNumber=>({questionNumber,mode:'single',optionCount:4,score:5,correctOptions:['A']}))}];
  card=await api(`/api/cards/${card.id}`,'PUT',card);
  const createExam=async name=>{const e=await api('/api/exams','POST',{name,cardId:card.id,gradeId:grade.id,subject:'math',mode:'quiz'});await api(`/api/exams/${e.id}/participants`,'PUT',{studentIds:students.map(s=>s.id)});return e;};
  const exam=await createExam(card.title);
  await request(local,`/api/cards/${card.id}`,'PUT',await api(`/api/scanner/sync/cards/${card.id}`));
  const layout=await api(`/api/cards/${card.id}/layout`);
  await check('F01','生成答题卡、编排考生、扫描端同步和 PDF 导出','flow-card',async()=>{const pdf=await fetch(base+`/api/cards/${card.id}/pdf`,{headers:{Authorization:`Bearer ${tokens.get(base)}`}});assert(pdf.ok,`PDF HTTP ${pdf.status}`);const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,4).toString(),'%PDF');await fs.writeFile(path.join(out,'答题卡.pdf'),bytes);return {cardId:card.id,examId:exam.id,students:4,pdfBytes:bytes.length};});
  const session=await api('/api/scanner/upload/sessions','POST',{cardId:card.id,pageCount:4,dpi:300});
  const recognitions=[];
  await check('F02','本机 C++ 识别四份填涂答题卡并上传','flow-native',async()=>{
    const rect=(r,fill)=>`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${fill}" stroke="#111" stroke-width="0.18"/>`;
    for(let i=0;i<4;i++) {
      const page=layout.pages[0],num=students[i].student_number;
      const marks=page.markers.map(m=>rect(m.rect,'#000')).join('');
      const digits=page.studentArea.digitCells.map(c=>rect(c.rect,Number(num[c.digitIndex])===c.digit?'#000':'#fff')).join('');
      const choices=page.blocks.flatMap(b=>b.type==='objective'?b.items:[]).flatMap((q,qi)=>q.options.map(o=>rect(o.rect,o.label===(qi<4-i?'A':'B')?'#000':'#fff'))).join('');
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}"><rect width="100%" height="100%" fill="white"/>${marks}${digits}${choices}</svg>`;
      const image=await sharp(Buffer.from(svg)).resize(Math.round(page.width/25.4*300),Math.round(page.height/25.4*300)).png().toBuffer();
      await fs.writeFile(path.join(out,`填涂答题卡${i+1}.png`),image);
      const form=new FormData();form.append('file',new Blob([image],{type:'image/png'}),'sheet.png');form.append('includeCrops','1');
      const recognition=await request(local,`/api/cards/${card.id}/recognition`,'POST',form);
      assert.equal(recognition.studentId.value,num);assert.equal(recognition.questions.length,4);recognitions.push(recognition);
      const upload=new FormData();upload.append('image',new Blob([image],{type:'image/png'}),'sheet.png');upload.append('token',session.uploadTokens[i]);upload.append('pageNum',String(i+1));upload.append('side','front');upload.append('recognition',JSON.stringify(recognition));
      await api(`/api/scanner/upload/sessions/${session.sessionId}/pages`,'POST',upload);
      if(recognition.cropImages?.length) {
        const crops=new FormData();const manifest=recognition.cropImages.map(({dataBase64,...crop},j)=>{const fileName=`crop_${j}.png`;crops.append('crops',new Blob([Buffer.from(dataBase64,'base64')],{type:'image/png'}),fileName);return {...crop,fileName};});crops.append('manifest',JSON.stringify(manifest));await api(`/api/scanner/upload/sessions/${session.sessionId}/pages/${session.uploadTokens[i]}/crops`,'POST',crops);
      }
    }
    return {recognized:recognitions.length,expectedStudentNumbers:students.map(s=>s.student_number)};
  });
  await check('B17','扫描识别接口返回可远程上传的题块图片','scanner-crops',async()=>{if(recognitions.length!==4)throw new Error('Blocked: F02 did not complete');assert(recognitions.every(r=>r.cropImages?.length>0),'includeCrops=1 returned no cropImages');return recognitions.map(r=>r.cropImages.length);});
  await check('B18','远程上传完成后真实落成绩并自动结束考试','scanner-completion',async()=>{await api(`/api/scanner/upload/sessions/${session.sessionId}/complete`,'POST');await api(`/api/scanner/upload/sessions/${session.sessionId}/complete`,'POST');const rows=await api(`/api/analysis/exams/${exam.id}/students`);assert.deepEqual(rows.map(s=>s.totalScore),[20,15,10,5]);const status=await api(`/api/scanner/upload/sessions/${session.sessionId}/status`);assert.equal(status.progress.recognized,4);return {scores:rows.map(s=>s.totalScore),status};});
  // A separate scored exam allows independent probes after a broken upload flow.
  const analysisBlockId='bench_analysis';
  let analysisCard=await api('/api/cards','POST',{subject:'math',title:'150 分制分析夹具',examDate:'2026-09-06'});
  analysisCard=await api(`/api/cards/${analysisCard.id}`,'PUT',{...analysisCard,sided:'single',bodyBlocks:[{id:analysisBlockId,type:'objective',title:'选择题',questionStart:1,questionCount:1,optionCount:4,mode:'single',scorePerQuestion:150,density:'compact',answerKey:{'1':['A']},questions:[{questionNumber:1,mode:'single',optionCount:4,score:150,correctOptions:['A']}]}]});
  const analysis=await api('/api/exams','POST',{name:'独立分析夹具',cardId:analysisCard.id,gradeId:grade.id,subject:'math',mode:'quiz'});
  await api(`/api/exams/${analysis.id}/participants`,'PUT',{studentIds:students.map(s=>s.id)});
  await seedScores(analysis.id,students,analysisCard.id,analysisBlockId,[59.5,75,90,150]);
  const fixture={analysisExamId:analysis.id,examId:exam.id,cardId:card.id,blockId:analysisBlockId,students:students.map(s=>({id:s.id,student_number:s.student_number}))};
  await fs.writeFile(path.join(out,'fixture.json'),JSON.stringify(fixture));
  await check('B03','网阅草稿保存并恢复','mariadb-datetime',async()=>{const route=`/api/review-session/exams/${analysis.id}/blocks/${analysisBlockId}`;await api(route,'PUT',{currentIndex:2,draftScores:{'1':3}});const saved=await api(route);assert.equal(saved.data.currentIndex,2);await api(route,'DELETE');return saved;});
  await check('B04','题块阅卷配置新增后再次修改并读回','mariadb-datetime',async()=>{const route=`/api/block-grading-config/exams/${analysis.id}/blocks/${analysisBlockId}`;await api(route,'PUT',{scoringMode:'per_question'});await api(route,'PUT',{scoringMode:'block_total'});const saved=await api(route);assert.equal(saved.data.scoringMode,'block_total');return saved;});
  await check('B05','人工改分持久化','mariadb-datetime',async()=>{await api(`/api/exams/${analysis.id}/student/${students[0].id}/scores`,'PUT',{scores:[{questionNumber:1,scoreType:'objective',score:5}]});const [rows]=await db.execute('SELECT score FROM question_scores WHERE exam_id=? AND student_id=?',[analysis.id,students[0].id]);assert.equal(rows[0].score,5);return rows;});
  // Restore only the independent analytical fixture after the mutation probe.
  await db.execute('UPDATE question_scores SET score=59.5 WHERE exam_id=? AND student_id=?',[analysis.id,students[0].id]);await db.execute('UPDATE student_scores SET total_score=59.5 WHERE exam_id=? AND student_id=?',[analysis.id,students[0].id]);
  const group=await api('/api/exam-groups','POST',{name:'联考夹具',grade_id:grade.id,examIds:[analysis.id]});
  await check('B06','联考总体分析聚合查询可执行','group-aggregate-sql',async()=>{const values={};for(const endpoint of ['overview','metrics','question-analysis','distribution','class-comparison','rankings'])values[endpoint]=await api(`/api/exam-groups/${group.id}/${endpoint}`);return values;});
  await db.execute("INSERT INTO answer_block_crops(id,card_id,exam_id,student_id,source_type,source_record_id,block_id,block_type,page_number,segment_index,question_numbers,rect_json,image_path,width_px,height_px,dpi) VALUES('bench-crop',?,?,?,'benchmark','fixture',?,'objective',1,0,'[1]','{}','fixture.png',100,100,300)",[analysisCard.id,analysis.id,students[0].id,analysisBlockId]);
  metadata.fixtures.push({kind:'independent annotation crop',id:'bench-crop',reason:'Avoids cascading failure from missing remote crops.'});
  await check('B07','网阅批注保存并读回坐标','review-annotation-schema',async()=>{const saved=await api('/api/review-annotations','POST',{cropId:'bench-crop',type:'text',dataJson:{text:'基准批注'},positionX:10,positionY:20});const rows=await api('/api/review-annotations?cropId=bench-crop');const row=rows.data.find(r=>r.id===saved.data.id);assert.equal(row.dataJson.text,'基准批注');assert.equal(row.dataJson.x,10);await api(`/api/review-annotations/${saved.data.id}`,'DELETE');return row;});
  const python=await wsl(['probe',runId,linux(path.join(here,'python-probes.py')),linux(path.join(out,'fixture.json'))]);
  const line=python.split('\n').find(s=>s.startsWith('BENCH_RESULTS='));assert(line,'Python probe output missing');for(const result of JSON.parse(line.slice(14))){results.push(result);console.log(`${result.status} ${result.id} ${result.title}`);}
  await check('B19','部署时自动启动 AI 侧车且内部鉴权一致','ai-sidecar-bootstrap',async()=>{await waitHealth('http://127.0.0.1:8791/health',15000);const status=await api('/api/analysis/ai/status');assert(status.available,JSON.stringify(status));return status;});
  await check('F05','AI 分析任务完成并保存非空报告','flow-ai-job',async()=>{
    const status=await api('/api/analysis/ai/status');const model=status.models?.find(m=>m.available)?.id;if(!status.available||!model)throw new Error('Blocked: AI readiness prerequisite failed');
    const job=await api(`/api/analysis/exams/${analysis.id}/ai-analysis`,'POST',{model});
    for(let i=0;i<90;i++){const result=await api(`/api/analysis/ai-analysis/jobs/${job.jobId}`);if(['done','completed','succeeded','failed','error'].includes(result.status)){assert(!['failed','error'].includes(result.status),JSON.stringify(result));assert(result.result?.report?.overallJudgement?.trim(),'Empty overall judgement');assert(result.result?.report?.distributionInsight?.trim(),'Empty distribution insight');return result;}await delay(2000);}throw new Error('AI job timeout');
  });
  const edge=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles].filter(Boolean).map(p=>path.join(p,'Microsoft/Edge/Application/msedge.exe')).find(existsSync);
  browser=await chromium.launch({headless:true,...(edge?{executablePath:edge}:{})});
  await check('B20','浏览器成绩概况绘制图表不崩溃','chart-registration',async()=>{
    const context=await browser.newContext();await context.addCookies([{name:'projectx_auth_token',value:tokens.get(base),url:base}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await context.addInitScript(()=>localStorage.setItem('projectx-skin-onboarded','1'));
    await page.goto(base+'/analysis');await page.waitForTimeout(1500);
    const skin=page.getByRole('radio',{name:/明澈 Flat/});if(await skin.count()){await skin.check();const next=page.getByRole('button',{name:/进入|确认|继续/});if(await next.count())await next.first().click();}
    await page.getByText('独立分析夹具',{exact:true}).first().click({timeout:20000});
    await page.waitForTimeout(2500);await page.screenshot({path:path.join(out,'成绩概况.png'),fullPage:true});
    const body=await page.locator('body').innerText();await fs.writeFile(path.join(out,'成绩概况页面.txt'),body);assert(!body.includes('Unexpected Application Error'),body.slice(0,1600));assert.equal(errors.length,0,errors.join('\n'));assert(await page.locator('canvas').count()>0,'No chart canvas rendered');await context.close();return 'Chart canvas rendered without pageerror';
  });
  await check('F03','所有成绩分析接口及跨考试总体分析','flow-analysis',async()=>{for(const endpoint of ['overview','students','score-table','questions','distribution','metrics','class-comparison?all=1','option-analysis','comparable'])await api(`/api/analysis/exams/${analysis.id}/${endpoint}`);return await api('/api/analysis/cross-exam/total','POST',{mode:'selected',examIds:[analysis.id]});});
  await check('F04','MariaDB 备份导出 ZIP','flow-backup',async()=>{const response=await fetch(base+'/api/db/backup',{headers:{Authorization:`Bearer ${tokens.get(base)}`}});assert(response.ok);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');await fs.writeFile(path.join(out,'测试库备份.zip'),bytes);return {bytes:bytes.length};});
  await check('F06','链路考试发布、导出及学生查分','flow-publish',async()=>{
    if(results.find(r=>r.id==='B18')?.status!=='PASS')throw new Error('Blocked: remote grading failure');
    await api(`/api/exams/${exam.id}/publish`,'POST');const csv=await fetch(base+`/api/analysis/exams/${exam.id}/export-csv`,{headers:{Authorization:`Bearer ${tokens.get(base)}`}});assert(csv.ok);await fs.writeFile(path.join(out,'成绩导出.csv'),await csv.text());
    const adminToken=tokens.get(base);
    try {const auth=await api('/api/auth/login','POST',{identifier:students[0].student_number,password});tokens.set(base,auth.token);if(auth.passwordChangeRequired){await api('/api/auth/change-password','POST',{oldPassword:password,newPassword:password+'Student'});tokens.set(base,(await api('/api/auth/login','POST',{identifier:students[0].student_number,password:password+'Student'})).token);}const detail=await api(`/api/scores/me/exams/${exam.id}`);await api('/api/scores/me/trends');await api('/api/scores/me/subject-comparison');return detail;}finally{tokens.set(base,adminToken);}
  });
  await check('F07','本机扫描端页面可加载并连接本机服务','flow-scanner-ui',async()=>{const context=await browser.newContext();await context.addCookies([{name:'projectx_auth_token',value:tokens.get(local),url:local}]);await context.addInitScript(()=>localStorage.setItem('projectx-skin-onboarded','1'));const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(local);await page.waitForTimeout(2000);await page.screenshot({path:path.join(out,'本机扫描端.png'),fullPage:true});assert.equal(errors.length,0,errors.join('\n'));assert.match(await page.locator('body').innerText(),/扫描/);await context.close();return 'Local scanner UI rendered';});
  await check('F08','扫描端页面配置服务器、导入图片并自动上传成绩','flow-scanner-ui-upload',async()=>{
    const created=await api('/api/cards','POST',{subject:'math',title:'扫描界面链路',examDate:'2026-09-06'});
    const uiCard=await api(`/api/cards/${created.id}`,'PUT',{...card,id:created.id,title:'扫描界面链路',bodyBlocks:card.bodyBlocks.map(b=>({...b,id:'bench_ui_objective',questions:b.questions?.map(q=>({...q,id:q.id?`${q.id}_ui`:undefined}))}))});
    const uiExam=await api('/api/exams','POST',{name:'扫描界面链路',cardId:uiCard.id,gradeId:grade.id,subject:'math',mode:'quiz'});
    await api(`/api/exams/${uiExam.id}/participants`,'PUT',{studentIds:students.map(s=>s.id)});
    const key=await api('/api/admin/api-keys','POST',{name:'benchmark-scanner',scope:'scanner'});
    const context=await browser.newContext();await context.addCookies([{name:'projectx_auth_token',value:tokens.get(local),url:local}]);await context.addInitScript(()=>localStorage.setItem('projectx-skin-onboarded','1'));
    const page=await context.newPage();let complete;const responses=[];
    page.on('response',response=>{if(response.url().includes('/api/scanner/upload/')){responses.push({url:new URL(response.url()).pathname,status:response.status()});if(response.url().endsWith('/complete'))complete=response;}});
    try {
      await page.goto(local);await page.getByRole('button',{name:'服务器连接',exact:true}).click();
      await page.getByPlaceholder('http://192.168.1.100:5174').fill(base);await page.getByPlaceholder('sk-xxx...').fill(key.api_key);
      await page.getByRole('button',{name:'测试连接',exact:true}).click();await page.getByText('服务器可达',{exact:true}).waitFor();await page.getByRole('button',{name:'保存配置',exact:true}).click();
      await page.reload();await page.getByRole('row').filter({hasText:'扫描界面链路'}).getByRole('button',{name:'选择',exact:true}).click();
      await page.getByRole('radio',{name:'本地判分+上传服务器',exact:true}).click();
      await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles([1,2,3,4].map(i=>path.join(out,`填涂答题卡${i}.png`)));
      await page.getByRole('button',{name:'开始识别判分',exact:true}).click();
      for(let i=0;i<60&&!complete;i++)await delay(1000);
      await page.screenshot({path:path.join(out,'扫描端自动上传.png'),fullPage:true});await fs.writeFile(path.join(out,'扫描端上传响应.json'),JSON.stringify(responses,null,2));
      assert(complete,'Scanner frontend did not complete remote upload');assert(complete.ok(),`Complete HTTP ${complete.status()}`);
      const rows=await api(`/api/analysis/exams/${uiExam.id}/students`);assert.deepEqual(rows.map(r=>r.totalScore),[20,15,10,5]);return {examId:uiExam.id,scores:rows.map(r=>r.totalScore),responses};
    } finally {await page.screenshot({path:path.join(out,'扫描端界面最终状态.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(out,'扫描端界面最终状态.txt'),await page.locator('body').innerText()).catch(()=>{});await context.close();await api(`/api/admin/api-keys/${key.id}`,'DELETE');}
  });
} catch(error) {fatal=error.stack;console.error(fatal);}
finally {
  stopping=true;
  await browser?.close();await db?.end();
  if(wslStarted)try{await wsl(['logs',runId,linux(out)]);}catch(e){console.error('Log collection:',e.message);}
  if(!argv.includes('--keep-running')) {
    for(const child of processes)if(child.spawnfile!=='wsl.exe')child.kill();
    if(wslStarted)try{await wsl(['stop',runId]);}catch(e){console.error('Cleanup:',e.message);}
  }
  await fs.rm(path.join(out,'real-ai.env'),{force:true});
  const failures=results.filter(r=>r.status==='FAIL'&&r.id.startsWith('B'));
  metadata.finishedAt=new Date().toISOString();metadata.defectFailures=failures.length;metadata.failureFamilies=[...new Set(failures.map(r=>r.family))];metadata.fatal=fatal;
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({metadata,results},null,2));
  const rows=results.map(r=>`| ${r.id} | ${r.title} | ${r.status} | ${r.family} |`).join('\n');
  await fs.writeFile(path.join(out,'测试报告.md'),`# 自动化修复基准报告\n\n源码：${metadata.sha}（${ref}）\n\n缺陷用例失败 ${failures.length} 项，涉及 ${metadata.failureFamilies.length} 个根因族。环境失败不计入缺陷数。\n\n${fatal?'运行未完成：'+fatal:'运行完成。'}\n\n| 编号 | 用例 | 结果 | 根因族 |\n|---|---|---|---|\n${rows}\n\n具体响应、断言和夹具说明见 results.json；阶段日志保存在同目录。\n`);
  console.log(`RESULT ${out}: ${failures.length} defects, ${metadata.failureFamilies.length} families`);
  process.exitCode=fatal||results.some(r=>r.status==='ERROR')?2:mode==='baseline'?(failures.length>=15?0:1):(results.every(r=>r.status==='PASS')?0:1);
}
