// 双面扫描页号回归（评审 P1「新页码算法破坏双面扫描」）。
//
// 现象复盘：原生桥的 `page` 是**物理纸张号**，同一张纸的正反面共用一个号
// （twain_controller.cpp:473 与 :513 写的是同一个 pageNum）。
// 一旦落库页号改成「按图片下标递增」，两份双面卷的分组就从 [0,0,1,1] 变成 [0,1,2,3]，
// 正反面被拆到相邻两张「纸」上：首页学号继承、完整性校验全部失效。
// 反过来，若原样沿用 native 的页号，每次重启扫描都是新进程、又从 1 起算，
// groupIndex 恒为 0，表现为「扫进 100 张只显示 1 份答题卡」（B13 的原始现象）。
//
// 因此本页号换算同时受两条约束，这里把两条都钉住。
//
// ⑧ 另钉住安全 R34：页号正确不等于归属正确。兼容模式（无二维码）下分组只有物理页序可依，
// 缺页/乱序/ADF 双进纸造成的错位会把后一名学生的答卷静默挂到前一名学生名下，
// 因此学号只认本组第 1 页（学号填涂区只在第 1 页生成），且一份不可信就整批失败闭合。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assignScanRecordPageNums, mapScanPageToLayout } from '../src/shared/scanPages';
import { legacyIdentityProblems, legacySessionBlockReason } from '../src/apps/answer-card/server/scanner/session-results';
import type { ScanRecordWithResult } from '../src/apps/answer-card/server/database/scan-store';

type Side = "front" | "back";

function layoutOf(pageNums: number[], sides: Side[], layoutPageCount: number, sided: "single" | "double") {
  return pageNums.map((pageNum, i) => {
    const { groupIndex, layoutPage, unusedSide } = mapScanPageToLayout(pageNum, sides[i], layoutPageCount, sided);
    return { groupIndex, layoutPage, unusedSide };
  });
}

// ① 两份双面卷（2 张纸、4 张图）：正反同页，分组必须是 [0,0,1,1]
{
  const pages = [{ page: 1 }, { page: 1 }, { page: 2 }, { page: 2 }];
  const sides: Side[] = ["front", "back", "front", "back"];
  const nums = assignScanRecordPageNums(pages, { sheetOffset: 0, sidesPerSheet: 2 });
  assert.deepEqual(nums, [1, 1, 2, 2], `①: 双面页号必须按纸给，实际 ${nums}`);
  const layout = layoutOf(nums, sides, 2, "double");
  assert.deepEqual(layout.map((r) => r.groupIndex), [0, 0, 1, 1], "①: 分组必须按份聚合正反两面");
  assert.deepEqual(layout.map((r) => r.layoutPage), [1, 2, 1, 2], "①: 正→布局页1，背→布局页2");
  assert.equal(layout.some((r) => r.unusedSide), false, "①: 双面卡不应有废弃页");
  const grouped = new Map<number, string[]>();
  layout.forEach((r, i) => grouped.set(r.groupIndex, [...(grouped.get(r.groupIndex) ?? []), `${sides[i]}@${r.layoutPage}`]));
  assert.deepEqual([...grouped.entries()], [[0, ["front@1", "back@2"]], [1, ["front@1", "back@2"]]],
    "①: 每份卡都齐正反两页，完整性校验才不会缺页");
}

// ② 反向对照：把页号按图片下标递增（评审复现的错误算法）确实会拆散双面卷。
//    这条断言锁住「为什么不能那样写」，防止后人又改回去。
{
  const sides: Side[] = ["front", "back", "front", "back"];
  const broken = [1, 2, 3, 4];
  const layout = layoutOf(broken, sides, 2, "double");
  assert.deepEqual(layout.map((r) => r.groupIndex), [0, 1, 2, 3], "②: 逐张递增会把一份卡的正反面拆成四份");
  const byGroup = new Map<number, Side[]>();
  layout.forEach((r, i) => byGroup.set(r.groupIndex, [...(byGroup.get(r.groupIndex) ?? []), sides[i]]));
  assert.deepEqual([...byGroup.values()].map((g) => g.join("+")), ["front", "back", "front", "back"],
    "②: 每个分组都只剩半张卡——完整性校验据此报缺页/重复页");
  assert.deepEqual(assignScanRecordPageNums([{ page: 1 }, { page: 1 }, { page: 2 }, { page: 2 }], { sheetOffset: 0, sidesPerSheet: 2 }),
    [1, 1, 2, 2], "②: 现实现不得与该错误算法同值");
}

// ③ 跨进程累计：本会话已落库 2 张纸（两份双面卡），重启扫描后再扫一张纸，
//    native 又从 1 起算，落库页号必须是 3 而不是 1——否则新旧记录撞进同一 groupIndex，
//    被当成同一份卡的重复页（B13 原始现象的反向）。
{
  const nums = assignScanRecordPageNums([{ page: 1 }, { page: 1 }], { sheetOffset: 2, sidesPerSheet: 2 });
  assert.deepEqual(nums, [3, 3], `③: 偏移要加在纸上，实际 ${nums}`);
  assert.equal(new Set(nums).size, 1, "③: 同一张纸的正反面页号相同");
  const layout = layoutOf(nums, ["front", "back"], 2, "double");
  assert.deepEqual(layout.map((r) => r.groupIndex), [2, 2], "③: 续扫的这张纸自成第三份卡");
  assert.deepEqual(layout.map((r) => r.layoutPage), [1, 2], "③: 续扫页仍要还原成正反布局页");
  // 对照：不加偏移时新旧两次扫描会叠在同一个分组里
  const collide = layoutOf([1, 1], ["front", "back"], 2, "double").map((r) => r.groupIndex);
  assert.deepEqual(collide, [0, 0], "③: 未累计时续扫会复用已有分组，即「多份塌缩成一份」");
  assert.notDeepEqual(layout.map((r) => r.groupIndex), collide, "③: 累计偏移后不得与首批分组重叠");
}

// ④ 单面卡（每份 2 页 = 2 张纸）：页号逐张递增，每 2 张纸聚成一份。
{
  const nums = assignScanRecordPageNums([{ page: 1 }, { page: 2 }, { page: 3 }, { page: 4 }], { sheetOffset: 0, sidesPerSheet: 1 });
  assert.deepEqual(nums, [1, 2, 3, 4], "④: 单面累计按张递增");
  const layout = layoutOf(nums, ["front", "front", "front", "front"], 2, "single");
  assert.deepEqual(layout.map((r) => r.groupIndex), [0, 0, 1, 1], "④: 每两张纸合成一份卡");
  assert.deepEqual(layout.map((r) => r.layoutPage), [1, 2, 1, 2], "④: 布局页按纸张序号还原");
  assert.equal(layout.some((r) => r.unusedSide), false, "④: 单面卡正面页不应被判定为废弃");
  // 续扫：已落库 2 张纸，再来的 2 张必须是第二份卡，且页序连续
  const more = assignScanRecordPageNums([{ page: 1 }, { page: 2 }], { sheetOffset: 2, sidesPerSheet: 1 });
  const moreLayout = layoutOf(more, ["front", "front"], 2, "single");
  assert.deepEqual(moreLayout.map((r) => r.groupIndex), [1, 1], "④: 续扫的两页应落在同一份卡内");
  assert.deepEqual(moreLayout.map((r) => r.layoutPage), [1, 2], "④: 续扫仍按累计页序还原布局页");
}

// ⑤ native 未给出有效纸张号（旧桥 / 0 / NaN / 负数）时按「第几张纸」兜底，正反仍同页。
{
  const nums = assignScanRecordPageNums(
    [{ page: 0 }, { page: Number.NaN }, { page: -3 }, { page: undefined }],
    { sheetOffset: 0, sidesPerSheet: 2 },
  );
  assert.deepEqual(nums, [1, 1, 2, 2], `⑤: 无效纸张号必须回落到按纸推导，实际 ${nums}`);
  const single = assignScanRecordPageNums([{}, {}, {}], { sheetOffset: 0, sidesPerSheet: 1 });
  assert.deepEqual(single, [1, 2, 3], "⑤: 单面兜底逐张递增");
}

// ⑥ 异常偏移不得把页号压成 0 或负数（0 会让 mapScanPageToLayout 的 sheetIndex 变 0）
{
  assert.deepEqual(assignScanRecordPageNums([{ page: 1 }], { sheetOffset: -5, sidesPerSheet: 2 }), [1], "⑥: 负偏移夹到 0");
  assert.deepEqual(assignScanRecordPageNums([{ page: 1 }], { sheetOffset: Number.NaN, sidesPerSheet: 0 }), [1], "⑥: 非法偏移/边数取安全默认");
}

// ⑦ 接线检查：扫描服务必须调用该纯函数，而不是自己按图片下标编号。
//    （纯函数测试能锁住算法，但改回 index+1 的写法只出现在服务里，故在此把调用点钉住；
//     直接 import scanner-service 会拖进数据库与 sharp，这里用源码静态检查。）
{
  const src = readFileSync(
    fileURLToPath(new URL("../src/apps/answer-card/server/scanner/scanner-service.ts", import.meta.url)), "utf8");
  assert.match(src, /assignScanRecordPageNums\(filteredPages,\s*\{\s*sheetOffset,\s*sidesPerSheet\s*\}\)/,
    "⑦: runScanSession 必须改用 assignScanRecordPageNums");
  assert.doesNotMatch(src, /const cumulativePageNum = index \+ 1|pageNum:\s*index \+ 1/,
    "⑦: 不得回退为按图片下标编号");
  assert.match(src, /Math\.max\(max, Number\(record\.page_num\) \|\| 0\)/,
    "⑦: 会话偏移必须取已落库的最大纸张号");
}

// ⑧ 安全 R34：兼容模式（无二维码）下的学生归属必须失败闭合，不能沿用前一名学生的学号。
//    硬事实：学号填涂区只在布局第 1 页生成（layout.ts 只对 page 1 调 layoutStudentArea），
//    所以兼容模式下一份卡的学号只可能来自本组第 1 页；其它页读到学号即说明页序错位。
{
  const row = (layoutPage: number, studentId: string | null, identityMode: "strict" | "legacy") =>
    ({ layoutPage, studentId, identityMode });

  // 正常：第 1 页读到学号，第 2 页继承同一个学号 → 放行
  assert.deepEqual(legacyIdentityProblems([row(1, "91001", "legacy"), row(2, "91001", "legacy")]), [],
    "⑧: 兼容模式正常卡（第 1 页有学号、背面继承）应放行");

  // 缺页错位：第 1 页没有学号，却在第 3 页读到 → 失败闭合，不得沿用前一名学生
  const shifted = legacyIdentityProblems([row(1, null, "legacy"), row(2, null, "legacy"), row(3, "91002", "legacy"), row(4, "91002", "legacy")]);
  assert.equal(shifted.length, 1, "⑧: 页序错位必须给出一条失败原因");
  assert.match(shifted[0], /第 3 页读到学号 91002/, "⑧: 原因要指明在哪一页读到了不该出现的学号");
  assert.match(shifted[0], /缺页|乱序|双进纸/, "⑧: 原因要指出可能的物理成因");
  assert.match(shifted[0], /人工归组/, "⑧: 原因要给出人工归组的处置");

  // 整组都没有学号 → 失败闭合（不能从别的卡推断）
  const noId = legacyIdentityProblems([row(1, null, "legacy"), row(2, null, "legacy")]);
  assert.equal(noId.length, 1, "⑧: 第 1 页无学号必须失败闭合");
  assert.match(noId[0], /第 1 页未识别到学号/, "⑧: 原因要说明第 1 页没有学号");
  assert.match(noId[0], /不能从其它页或前一份答题卡推断/, "⑧: 原因要写明不会沿用前一份答题卡");

  // 组内没有第 1 页（缺页/乱序）→ 失败闭合
  const noFirst = legacyIdentityProblems([row(3, "91003", "legacy"), row(4, "91003", "legacy")]);
  assert.equal(noFirst.length, 1, "⑧: 缺第 1 页必须失败闭合");
  assert.match(noFirst[0], /没有第 1 页/, "⑧: 原因要指明缺的是第 1 页");

  // 第 1 页与后续页学号不一致（ADF 双进纸把下一份卡的正面当成本卡背面）→ 失败闭合
  const conflict = legacyIdentityProblems([row(1, "91001", "legacy"), row(2, "91004", "legacy")]);
  assert.equal(conflict.length, 1, "⑧: 组内学号冲突必须失败闭合");
  assert.match(conflict[0], /与第 1 页的 91001 不一致/, "⑧: 原因要同时给出两个学号");

  // 严格模式有二维码逐页校验，不得被兼容模式的新规则误伤
  assert.deepEqual(legacyIdentityProblems([row(1, null, "strict"), row(2, "91005", "strict")]), [],
    "⑧: 严格模式沿用二维码校验，不适用兼容模式的第 1 页规则");
  assert.deepEqual(legacyIdentityProblems([]), [], "⑧: 空组不产生原因");

  // ── 会话级：一份卡不可信时整批不得静默入库 ──
  const rec = (pageNum: number, identityMode: "strict" | "legacy") => ({ page_num: pageNum, identity_mode: identityMode });
  const fakeRecord = (pageNum: number, side: Side, studentId: string | null, identityMode: "strict" | "legacy") =>
    ({ id: `r${pageNum}${side}`, page_num: pageNum, side, student_id: studentId, identity_mode: identityMode }) as ScanRecordWithResult;
  const groupOf = (entries: Array<[number, Side, string | null, "strict" | "legacy"]>) => {
    const rows = entries.map(([pageNum, side, studentId, mode]) => ({
      record: fakeRecord(pageNum, side, studentId, mode),
      page: {
        recordId: `r${pageNum}${side}`, pageNum, side,
        layoutPage: mapScanPageToLayout(pageNum, side, 4, "double").layoutPage,
      },
    }));
    return rows;
  };

  // 每份卡 2 张纸：只扫进 3 张 → 缺页/多进纸，整批阻断
  const shortBatch = legacySessionBlockReason({
    pageCount: 4, sided: "double",
    records: [rec(1, "legacy"), rec(2, "legacy"), rec(3, "legacy")],
    groups: new Map([["0", groupOf([[1, "front", "91001", "legacy"], [1, "back", "91001", "legacy"], [2, "front", null, "legacy"], [2, "back", null, "legacy"]])]]),
  });
  assert.match(shortBatch ?? "", /共 3 张纸/, "⑧: 会话级阻断要报出实际纸张数");
  assert.match(shortBatch ?? "", /不是每份答题卡 2 张的整数倍/, "⑧: 纸张数不整除即视为缺页/多进纸");

  // 4 张纸、每份第 1 页都读到学号 → 放行
  const healthy = new Map([
    ["0", groupOf([[1, "front", "91001", "legacy"], [1, "back", "91001", "legacy"], [2, "front", null, "legacy"], [2, "back", null, "legacy"]])],
    ["1", groupOf([[3, "front", "91002", "legacy"], [3, "back", "91002", "legacy"], [4, "front", null, "legacy"], [4, "back", null, "legacy"]])],
  ]);
  assert.equal(legacySessionBlockReason({
    pageCount: 4, sided: "double",
    records: [rec(1, "legacy"), rec(2, "legacy"), rec(3, "legacy"), rec(4, "legacy")],
    groups: healthy,
  }), null, "⑧: 兼容模式且页序可信时不得阻断整批");

  // 4 张纸但第 2 份卡的第 1 页读不到学号 → 逐份判定只会让那一份失败，
  // 而被顶替进来的第 1 份可能页数齐整、学号也读得到，因此必须整批阻断。
  const untrusted = new Map([
    ["0", groupOf([[1, "front", "91001", "legacy"], [1, "back", "91001", "legacy"], [2, "front", null, "legacy"], [2, "back", null, "legacy"]])],
    ["1", groupOf([[3, "front", null, "legacy"], [3, "back", null, "legacy"], [4, "front", null, "legacy"], [4, "back", null, "legacy"]])],
  ]);
  const blocked = legacySessionBlockReason({
    pageCount: 4, sided: "double",
    records: [rec(1, "legacy"), rec(2, "legacy"), rec(3, "legacy"), rec(4, "legacy")],
    groups: untrusted,
  });
  assert.match(blocked ?? "", /第 1 份答题卡的第 1 页学号不可信/, "⑧: 阻断原因要指明是哪一份卡不可信");
  assert.match(blocked ?? "", /本批成绩暂不入库/, "⑧: 阻断要写明整批不入库");
  assert.match(blocked ?? "", /人工指定学号/, "⑧: 阻断要给出处置（人工指定学号或重扫）");

  // 严格模式不受会话级阻断影响（二维码已逐页校验身份）
  assert.equal(legacySessionBlockReason({
    pageCount: 4, sided: "double",
    records: [rec(1, "strict"), rec(2, "strict"), rec(3, "strict")],
    groups: new Map([["0", groupOf([[1, "front", null, "strict"], [2, "front", "91009", "strict"]])]]),
  }), null, "⑧: 严格模式不得被兼容模式的会话级规则阻断");
  assert.equal(legacySessionBlockReason({ pageCount: 4, sided: "double", records: [], groups: new Map() }), null,
    "⑧: 无记录时不阻断（由既有的空结果处理）");

  // 接线检查：扫描服务不得让非第 1 页为分组定学号；汇总必须先过会话级判定
  const serviceSrc = readFileSync(
    fileURLToPath(new URL("../src/apps/answer-card/server/scanner/scanner-service.ts", import.meta.url)), "utf8");
  const resultsSrc = readFileSync(
    fileURLToPath(new URL("../src/apps/answer-card/server/scanner/session-results.ts", import.meta.url)), "utf8");
  assert.match(resultsSrc, /legacySessionBlockReason\(\{ pageCount, sided: card\.sided, records, groups \}\)/,
    "⑧: collectSessionResults 必须调用会话级兼容模式判定");
  assert.match(resultsSrc, /if \(legacyBlock\) throw new Error\(legacyBlock\);/,
    "⑧: 会话级阻断必须让每份卡失败闭合，而不是继续判分入库");
  assert.match(serviceSrc, /maySeedGroupStudentId = !legacyIdentity \|\| layoutPage === 1 \|\| Boolean\(retry\?\.studentId\)/,
    "⑧: 兼容模式下只有第 1 页（或人工订正）能为分组定学号");
  assert.match(serviceSrc, /if \(recognizedStudentId && maySeedGroupStudentId\)/,
    "⑧: 分组学号写入必须受该判定约束");
}

console.log("verify-scan-page-numbering: 全部通过（双面共享纸张号 / 跨进程按纸累计 / 兜底与接线 / 兼容模式归属失败闭合）");
