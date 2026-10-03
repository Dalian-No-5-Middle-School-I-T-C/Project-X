// UCRT 可再发行目录探测回归（评审 P2「UCRT 的 SDK 查找路径拼错」）。
//
// 现象复盘：Windows 10 SDK 里 UCRT 的 redist 有两种真实布局
//   新版 <Kits>\10\Redist\<SDK版本>\ucrt\DLLs\<x64|x86>
//   旧版 <Kits>\10\Redist\ucrt\DLLs\<x64|x86>
// 原实现认定 `Redist\ucrt\DLLs` 的第一层子项是 SDK 版本目录，在其后再追加一次架构，
// 于是实际去找 `DLLs\x86\x86` 这种必然不存在的目录，返回 null 后只能回退系统目录；
// 而 System32 只有 ucrtbase.dll、没有 api-ms-win-crt-* 转发桩，
// 恰好复现不了老目标机的 0xC0000142。
//
// 这里用临时目录搭出两种真实布局来验证探测与完整性校验，不依赖本机是否装了 SDK。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const stage = require("../scripts/stage-vc-runtime.cjs") as {
  findUcrtDir: (arch: string, explicitSource?: string, kitsBases?: string[]) => string | null;
  isCompleteUcrtDir: (dir: string | null) => boolean;
  ucrtMissingFiles: (dir: string | null) => string[];
  UCRT_STUB_NAMES: string[];
  UCRT_BASE: string;
};
const { findUcrtDir, isCompleteUcrtDir, ucrtMissingFiles, UCRT_STUB_NAMES, UCRT_BASE } = stage;

const root = mkdtempSync(path.join(tmpdir(), 'stage-vc-ucrt-'));
/** 在 fake Program Files 根下建一个 UCRT 目录并填充文件。 */
function makeUcrtDir(base: string, rel: string, opts: { skip?: string[] } = {}): string {
  const dir = path.join(base, rel);
  mkdirSync(dir, { recursive: true });
  const skip = new Set(opts.skip ?? []);
  if (!skip.has(UCRT_BASE)) writeFileSync(path.join(dir, UCRT_BASE), 'stub');
  for (const name of UCRT_STUB_NAMES) {
    if (!skip.has(name)) writeFileSync(path.join(dir, name), 'stub');
  }
  return dir;
}

try {
  // ① 新布局：版本号目录 + ucrt\DLLs\<arch>，x64 与 ia32 分别命中 x64 / x86
  {
    const base = path.join(root, 'versioned');
    const x64 = makeUcrtDir(base, path.join('Windows Kits', '10', 'Redist', '10.0.26100.0', 'ucrt', 'DLLs', 'x64'));
    const x86 = makeUcrtDir(base, path.join('Windows Kits', '10', 'Redist', '10.0.26100.0', 'ucrt', 'DLLs', 'x86'));
    // 同级的无关 redist 目录（D3D/MBN）不得干扰探测
    mkdirSync(path.join(base, 'Windows Kits', '10', 'Redist', 'D3D'), { recursive: true });
    assert.equal(findUcrtDir('x64', undefined, [base]), x64, '①: x64 应命中新版布局的 DLLs\\x64');
    assert.equal(findUcrtDir('ia32', undefined, [base]), x86, '①: ia32 应映射到 DLLs\\x86，而不是 x86\\x86');
  }

  // ② 旧布局：Redist\ucrt\DLLs\<arch>（第一层就是架构目录，不能再追加一次架构）
  {
    const base = path.join(root, 'legacy');
    const x64 = makeUcrtDir(base, path.join('Windows Kits', '10', 'Redist', 'ucrt', 'DLLs', 'x64'));
    const x86 = makeUcrtDir(base, path.join('Windows Kits', '10', 'Redist', 'ucrt', 'DLLs', 'x86'));
    assert.equal(findUcrtDir('x64', undefined, [base]), x64, '②: 旧布局同样要能命中');
    assert.equal(findUcrtDir('ia32', undefined, [base]), x86, '②: 旧布局 ia32 命中 x86');
  }

  // ③ 反向对照：原实现的拼法（把架构目录当版本目录再追加一次架构）必然落空。
  //    这里断言的是「现实现不会退化成那种拼法」，而不是复刻旧代码。
  {
    const base = path.join(root, 'legacy');
    assert.equal(
      isCompleteUcrtDir(path.join(base, 'Windows Kits', '10', 'Redist', 'ucrt', 'DLLs', 'x86', 'x86')),
      false,
      '③: DLLs\\x86\\x86 不是合法 UCRT 目录，旧拼法找的就是这种路径',
    );
  }

  // ④ 多版本并存时取更高的 SDK 版本号
  {
    const base = path.join(root, 'multi');
    makeUcrtDir(base, path.join('Windows Kits', '10', 'Redist', '10.0.17763.0', 'ucrt', 'DLLs', 'x64'));
    const newer = makeUcrtDir(base, path.join('Windows Kits', '10', 'Redist', '10.0.26100.0', 'ucrt', 'DLLs', 'x64'));
    assert.equal(findUcrtDir('x64', undefined, [base]), newer, '④: 应优先较新的 SDK 版本目录');
  }

  // ⑤ 完整性校验：缺转发桩的目录不得采用（宁可不部署，也不部署半套）
  {
    const base = path.join(root, 'partial');
    const broken = makeUcrtDir(base, path.join('Windows Kits', '10', 'Redist', '10.0.26100.0', 'ucrt', 'DLLs', 'x64'),
      { skip: ['api-ms-win-crt-stdio-l1-1-0.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'] });
    assert.deepEqual(ucrtMissingFiles(broken).sort(),
      ['api-ms-win-crt-runtime-l1-1-0.dll', 'api-ms-win-crt-stdio-l1-1-0.dll'], '⑤: 缺失项要被点名');
    const picked = findUcrtDir('x64', undefined, [base]);
    assert.notEqual(picked, broken, '⑤: 不完整的 SDK 目录不得被采用');
    // 补全后即可采用
    writeFileSync(path.join(broken, 'api-ms-win-crt-stdio-l1-1-0.dll'), 'stub');
    writeFileSync(path.join(broken, 'api-ms-win-crt-runtime-l1-1-0.dll'), 'stub');
    assert.equal(findUcrtDir('x64', undefined, [base]), broken, '⑤: 补全后应采用该目录');
  }

  // ⑥ 只有 ucrtbase.dll 的目录（典型系统目录）不足以支撑老目标机
  {
    const base = path.join(root, 'syslike');
    const dir = path.join(base, 'Windows Kits', '10', 'Redist', '10.0.26100.0', 'ucrt', 'DLLs', 'x64');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, UCRT_BASE), 'stub');
    const missing = ucrtMissingFiles(dir);
    assert.equal(missing.length, UCRT_STUB_NAMES.length, '⑥: 系统目录式来源应报出全部转发桩缺失');
    assert.notEqual(findUcrtDir('x64', undefined, [base]), dir, '⑥: 缺全部转发桩时不得采用');
  }

  // ⑦ --source 指向 CRT 目录时，同级 ..\..\ucrt\DLLs\<arch> 若完整则优先采用
  {
    const base = path.join(root, 'explicit');
    const crt = path.join(base, 'Windows Kits', '10', 'MSVC', '14.40.0', 'bin', 'Hostx64', 'x64');
    mkdirSync(crt, { recursive: true });
    const guess = makeUcrtDir(base, path.join('Windows Kits', '10', 'MSVC', '14.40.0', 'bin', 'ucrt', 'DLLs', 'x64'));
    assert.equal(findUcrtDir('x64', crt, [path.join(root, 'nothing')]), guess, '⑦: --source 的同级推断仍要生效');
  }

  console.log(`verify-stage-vc-runtime: 全部通过（${UCRT_STUB_NAMES.length} 个转发桩 + ${UCRT_BASE} 的两种 SDK 布局）`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
