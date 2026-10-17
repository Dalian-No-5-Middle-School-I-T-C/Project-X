import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// Exercise actual child-process handling without requiring a physical scanner.
if (process.platform === 'win32') { console.log('DSM child fixture requires POSIX'); } else {
 const dir=await mkdtemp(path.join(tmpdir(),'scanner-dsm-'));
 const calls=path.join(dir,'calls'); const exe=path.join(dir,'bridge');
 process.env.SCANNER_BRIDGE_EXE=exe; delete process.env.TWAIN_DSM_DLL;
 const {scan}=await import('../src/apps/answer-card/server/scanner/twain-bridge');
 for(const [message,expected] of [['No pages captured',1],['该扫描仪不支持 A3 原稿（请在扫描设置中改选 A4）',1],['无法打开扫描仪',2]] as const){
  await writeFile(calls,'');
  await writeFile(exe,`#!/bin/sh\necho call >> '${calls}'\necho '${JSON.stringify({status:'error',page_count:0,pages:[],message})}'\nexit 1\n`,{mode:0o700});
  try {const result=await scan({sourceName:'fixture',dpi:300,duplex:false,colorMode:'gray',paperSize:'A3',outputDir:dir,filePrefix:'test',maxPages:1});assert.equal(result.message,message);}catch(e){if(expected!==2)throw e;}
  assert.equal((await readFile(calls,'utf8')).trim().split('\n').length,expected);
 }
 console.log('PASS DSM classification through real child processes');
}
