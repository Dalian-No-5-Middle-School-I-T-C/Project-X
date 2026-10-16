/**
 * 扫描出图密度反查 —— 自动化验证脚本（issue #331 ①「软件里设的 DPI 没生效」）
 * ----------------------------------------------------------------
 * 运行方式：npx tsx scripts/verify-scanner-delivered-dpi.ts
 *
 * 背景：TWAIN 的 MSG_SET 返回成功只代表「请求被接受」，驱动完全可能替代成自己的档位
 *   （或因为 ICAP_UNITS 是厘米而把 300 读成 300 点/厘米）。native 已加 MSG_GETCURRENT
 *   回读并在 JSON 里回报 `dpi_x`/`dpi_y`，那是首选来源；但随包 exe 未必重编译，所以
 *   扫描端还要能用它**已经回报**的 width/height 反查实际密度，并把结论显示给操作者。
 *
 * 断言方式：① 纯函数正反例（含不能误报的纸型替代、横放交付）；② 接线检查——服务层确实
 *   调用了反查并以 type:"warning" 上报，客户端确实有对应分支（防止日后被改掉而无声失效）。
 *
 * 全部用例通过则进程退出码为 0，否则为 1。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { nearestScanDpiStep, paperInchesFor, verifyDeliveredScanDpi } from "../src/shared/scanDeliveredDpi";

let passed = 0;
const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

const root = process.cwd();

function main(): void {
  console.log("\n\x1b[36m== 反查：设定 DPI 与实际出图密度 ==\x1b[0m");

  const a4_300 = verifyDeliveredScanDpi([{ width: 2480, height: 3508 }], { dpi: 300, paperSize: "A4" });
  check(a4_300.status === "match" && a4_300.deliveredDpi === 300,
    `A4 @300dpi 标准出图（2480×3508）判为生效 (delivered=${a4_300.deliveredDpi}, status=${a4_300.status})`);

  const downgraded = verifyDeliveredScanDpi([{ width: 1654, height: 2339 }], { dpi: 300, paperSize: "A4" });
  check(downgraded.status === "mismatch" && downgraded.deliveredDpi === 200 && Boolean(downgraded.message),
    `设定 300 但驱动按 200 出图（1654×2339）报为未生效 (delivered=${downgraded.deliveredDpi}, status=${downgraded.status})`);
  check(Boolean(downgraded.message?.includes("200")), "提示里带出实际密度数值，便于现场核对");
  check(Boolean(downgraded.message?.includes(String(nearestScanDpiStep(200)))), "提示里给出可改的 DPI 档位建议");

  const icapUnitsBug = verifyDeliveredScanDpi([{ width: 4961, height: 7017 }], { dpi: 300, paperSize: "A4" });
  check(icapUnitsBug.status === "mismatch" && icapUnitsBug.deliveredDpi === 600,
    `ICAP_UNITS 当成厘米时的典型结果（实际 600dpi）也会被抓到 (delivered=${icapUnitsBug.deliveredDpi})`);

  const raised = verifyDeliveredScanDpi([{ width: 3307, height: 4677 }], { dpi: 300, paperSize: "A4" });
  check(raised.status === "mismatch" && raised.deliveredDpi === 400,
    `驱动把 300 抬成 400（3307×4677）同样算「设定未生效」 (delivered=${raised.deliveredDpi}, status=${raised.status})`);

  const letterAsA4 = verifyDeliveredScanDpi([{ width: 2550, height: 3300 }], { dpi: 300, paperSize: "A4" });
  check(letterAsA4.status === "match",
    `A4 档设了、驱动按 Letter 交付（2550×3300，密度仍为 300）不误报 (delivered=${letterAsA4.deliveredDpi})`);

  const landscape = verifyDeliveredScanDpi([{ width: 3508, height: 2480 }], { dpi: 300, paperSize: "A4" });
  check(landscape.status === "match", "驱动横放交付（长宽互换）不影响判定，按短边对短边匹配");

  const duplex = verifyDeliveredScanDpi(
    [{ width: 2480, height: 3508 }, { width: 2480, height: 3508 }, { width: 1654, height: 2339 }],
    { dpi: 300, paperSize: "A4" }
  );
  check(duplex.samplePages === 3 && duplex.status === "match",
    `多页取样不被个别异常页带偏（取中位数，samples=${duplex.samplePages}, delivered=${duplex.deliveredDpi}）`);

  const a3 = verifyDeliveredScanDpi([{ width: 3508, height: 4961 }], { dpi: 300, paperSize: "A3" });
  check(a3.status === "match", `A3 @300dpi（3508×4961）判为生效 (status=${a3.status})`);

  // A4 与 A3 长宽比相同：按 A3 反查时，A4 原尺寸会被算成「约 212dpi」。
  // 这条不是 bug，而是几何反查的固有歧义，所以 mismatch 提示必须让操作者核对纸型（见上面的用例）。
  const a4SheetOnA3Setting = verifyDeliveredScanDpi([{ width: 2480, height: 3508 }], { dpi: 300, paperSize: "A3" });
  check(a4SheetOnA3Setting.status === "mismatch" && a4SheetOnA3Setting.deliveredDpi === 212,
    `同比例纸张歧义：A4 出图按 A3 档反查出 ${a4SheetOnA3Setting.deliveredDpi}（提示里须同时提纸型）`);

  const letterSize = verifyDeliveredScanDpi([{ width: 2550, height: 3300 }], { dpi: 300, paperSize: "Letter" });
  check(letterSize.status === "match", "按所选纸型（Letter）换算，A4/Letter 常量取对档");

  const trimmed = verifyDeliveredScanDpi([{ width: 2472, height: 3496 }], { dpi: 300, paperSize: "A4" });
  check(trimmed.status === "match", "驱动留边裁剪（2472×3496，差 ~1%）不误报");

  console.log("\n\x1b[36m== 优先用桥接回报的 dpi_x/dpi_y ==\x1b[0m");

  // 桥接已强制 ICAP_UNITS=TWUN_INCHES 才允许出图，所以 TW_IMAGEINFO 的 X/Y 就是 DPI，
  // 比按尺寸反查更直接；老 exe 不带这两个字段时才回落到几何反查。
  const reported = verifyDeliveredScanDpi([{ width: 1654, height: 2339, dpi_x: 200, dpi_y: 200 }], { dpi: 300, paperSize: "A4" });
  check(reported.status === "mismatch" && reported.deliveredDpi === 200 && reported.source === "device",
    `回报值与出图尺寸一致（都指向 200）时按回报值定档 (delivered=${reported.deliveredDpi}, source=${reported.source})`);
  const reportedMatch = verifyDeliveredScanDpi([{ width: 2480, height: 3508, dpi_x: 300.5, dpi_y: 299.5 }], { dpi: 300, paperSize: "A4" });
  check(reportedMatch.status === "match" && reportedMatch.source === "device", "回报值与设定一致即判生效");
  const geometryFallback = verifyDeliveredScanDpi([{ width: 1654, height: 2339 }], { dpi: 300, paperSize: "A4" });
  check(geometryFallback.source === "geometry", "老 exe 不回报密度时仍走尺寸反查");
  const bogusReport = verifyDeliveredScanDpi([{ width: 2480, height: 3508, dpi_x: 12, dpi_y: 12 }], { dpi: 300, paperSize: "A4" });
  check(bogusReport.source === "geometry" && bogusReport.deliveredDpi === 300,
    "回报值明显不在合理区间（12）时退回尺寸反查，不拿坏数据下结论");

  console.log("\n\x1b[36m== 回报值与像素尺寸交叉核对（driver 谎报要能抓到）==\x1b[0m");

  // ① 最怕的一种失败：驱动把 300 标在图上，实际按 200 出图。只看回报值会判「生效」，
  // 现在两侧都算，对不上就不给「已生效」的结论。
  const liedUpward = verifyDeliveredScanDpi([{ width: 1654, height: 2339, dpi_x: 300, dpi_y: 300 }], { dpi: 300, paperSize: "A4" });
  check(liedUpward.status === "mismatch" && liedUpward.deliveredDpi === 200 && liedUpward.source === "geometry",
    `回报 300 但像素只够 200 → 判为无法确认生效 (status=${liedUpward.status}, delivered=${liedUpward.deliveredDpi})`);
  check(Boolean(liedUpward.message?.includes("对不上")), "矛盾结论要在提示里直说两个来源对不上");
  check(Boolean(liedUpward.message?.includes("纸型")), "同比例纸张分不清，提示里必须让操作者核对纸型");
  const liedDownward = verifyDeliveredScanDpi([{ width: 2480, height: 3508, dpi_x: 200, dpi_y: 200 }], { dpi: 300, paperSize: "A4" });
  check(liedDownward.status === "mismatch" && liedDownward.deliveredDpi === 300,
    `反方向矛盾（回报 200、像素 300）同样不作「已生效」结论 (delivered=${liedDownward.deliveredDpi})`);
  const tinyGap = verifyDeliveredScanDpi([{ width: 2472, height: 3496, dpi_x: 300, dpi_y: 300 }], { dpi: 300, paperSize: "A4" });
  check(tinyGap.status === "match" && tinyGap.source === "device", "留边裁剪带来的 ~1% 偏差不被当成矛盾");

  // 几何反查分不清「密度被替代」与「进了同比例的不同纸张」，提示必须同时点出纸型这一侧
  check(Boolean(downgraded.message?.includes("纸")), "尺寸反查的提示要提醒核对进纸纸张与纸型");
  check(Boolean(reported.message?.includes("驱动回报的密度")), "两种来源要在提示里说清是哪一种");

  console.log("\n\x1b[36m== 数据不可用时不下结论 ==\x1b[0m");

  const noDims = verifyDeliveredScanDpi([{ }, { width: 0, height: 0 }], { dpi: 300, paperSize: "A4" });
  check(noDims.status === "unknown" && noDims.deliveredDpi === undefined, "旧桥不回报尺寸 → unknown（不猜）");

  const oddAspect = verifyDeliveredScanDpi([{ width: 2480, height: 1000 }], { dpi: 300, paperSize: "A4" });
  check(oddAspect.status === "unknown", "长宽比与纸型对不上（2480×1000 这类异常尺寸）→ unknown，不把尺寸问题报成 DPI 问题");

  const badDpi = verifyDeliveredScanDpi([{ width: 2480, height: 3508 }], { dpi: 0, paperSize: "A4" });
  check(badDpi.status === "unknown", "设定 DPI 非法（0）→ unknown");

  check(paperInchesFor("letter")[0] === 8.5 && paperInchesFor(undefined)[1] === 11.69,
    "纸型英寸表：Letter 短边 8.5，未指定回落 A4 长边 11.69");

  console.log("\n\x1b[36m== 接线检查：结论要走到日志与界面 ==\x1b[0m");

  const serviceSource = readFileSync(path.join(root, "src/apps/answer-card/server/scanner/scanner-service.ts"), "utf8");
  check(serviceSource.includes("verifyDeliveredScanDpi(result.pages"), "扫描完成后按桥接回报尺寸反查");
  check(/type:\s*"warning"/.test(serviceSource), "反查结论以 type:\"warning\" 上报（不是会被 ocr_start 冲掉的进度文案）");
  check(serviceSource.includes("deliveredDpi="), "反查结果写进 [checkpoint] 扫描检查点日志");

  const typesSource = readFileSync(path.join(root, "src/apps/answer-card/server/scanner/scanner-types.ts"), "utf8");
  check(typesSource.includes('"warning"'), "ScanProgressEvent 类型里有 warning");

  const panelSource = readFileSync(path.join(root, "src/apps/answer-card/client/components/ScannerPanel.tsx"), "utf8");
  check(/case "warning":/.test(panelSource), "扫描端面板处理 warning 事件");
  check(panelSource.includes("scanWarnings"), "扫描端面板把告警显示出来（并计入「复制诊断」）");

  console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("verify-scanner-delivered-dpi: ALL PASS");
}

main();
