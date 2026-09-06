import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';

const here=path.dirname(fileURLToPath(import.meta.url));
const [baselineDir,candidateDir]=process.argv.slice(2);
assert(baselineDir&&candidateDir,'Usage: node pack.mjs baseline-result-directory candidate-result-directory');
const baseline=JSON.parse(await fs.readFile(path.join(baselineDir,'results.json'),'utf8'));
const candidate=JSON.parse(await fs.readFile(path.join(candidateDir,'results.json'),'utf8'));
assert(baseline.metadata.harnessHash===candidate.metadata.harnessHash,'Mismatched harness versions');
const zip=new AdmZip();
for(const name of ['.gitignore','run.ps1','run.mjs','compare.mjs','pack.mjs','python-probes.py','provider-stub.py','wsl-runtime.sh','package.json','package-lock.json','使用说明.md','问题清单.md','本机验证结果.md','修复评分.md'])zip.addLocalFile(path.join(here,name),'repair-benchmark');
for(const [name,dir] of [['baseline',baselineDir],['candidate',candidateDir]]) {
  for(const file of ['results.json','测试报告.md','成绩概况.png','扫描端自动上传.png','扫描端上传响应.json']) {
    try{await fs.access(path.join(dir,file));zip.addLocalFile(path.join(dir,file),`repair-benchmark/evidence/${name}`);}catch{}
  }
}
const target=path.join(here,'Project-X独立修复基准.zip');
zip.writeZip(target);
console.log(target);
