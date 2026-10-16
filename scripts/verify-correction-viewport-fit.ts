/**
 * 整卡改分/异常卷弹层的视口高度 —— 自动化验证脚本（issue #331 ④「处理异常卷页面滚动有问题」）
 * ----------------------------------------------------------------
 * 症状定位：`DialogContent` 是 `fixed` 定位、自身不滚动，靠 `max-h-[calc(100vh-64px)]` 收高度；
 *   `AppShell` 同理是 `h-screen` + `overflow-hidden`。而 vh 是「布局视口」，在 iOS/Android 上
 *   含浏览器工具栏那几十像素，fixed 元素又不跟随视觉视口——于是弹层底部（取消 / 保存修改）
 *   和列表最后一行落在看不见的地方，滚不动也点不到，现场只能描述成「页面滚动有问题」。
 *
 * 修法：高度钉到可视视口 `dvh`，但项目兼容目标是 safari15（dvh 要 15.4+），所以留 `vh` 兜底，
 *   只在 `@supports (height: 100dvh)` 时升级。两条类必须同时存在，删掉任何一条都会退化。
 *
 * 断言方式：① 用 tailwind-merge 真实合并一遍类名，确认「兜底 + supports 升级」不被当成同族冲突
 *   删掉（这是日后样式清理最容易踩的坑）；② 源码接线检查——三处视口高度、工具条 shrink-0、
 *   异常卷入口共用同一个弹层。
 *
 * 全部用例通过则进程退出码为 0，否则为 1。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { twMerge } from "tailwind-merge";

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
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const SUPPORTS_DVH = "supports-[height:100dvh]";

function main(): void {
  console.log("\n\x1b[36m== 类名合并：兜底与升级要同时活着 ==\x1b[0m");

  const mergedMaxHeight = twMerge("flex max-h-[calc(100vh-64px)]", `${SUPPORTS_DVH}:max-h-[calc(100dvh-64px)]`);
  check(mergedMaxHeight.includes("max-h-[calc(100vh-64px)]") && mergedMaxHeight.includes(`${SUPPORTS_DVH}:max-h-[calc(100dvh-64px)]`),
    `vh 兜底与 dvh 升级共存，不被 tailwind-merge 折叠 (合并结果: ${mergedMaxHeight})`);

  const mergedHeight = twMerge("h-[calc(100vh-64px)]", `${SUPPORTS_DVH}:h-[calc(100dvh-64px)]`);
  check(mergedHeight.split(" ").length === 2, `整卡改分的定高同样保留两条 (合并结果: ${mergedHeight})`);

  const mergedShell = twMerge("flex h-screen w-full overflow-hidden", `${SUPPORTS_DVH}:h-[100dvh]`);
  check(mergedShell.includes("h-screen") && mergedShell.includes(`${SUPPORTS_DVH}:h-[100dvh]`),
    "AppShell 的 h-screen 兜底不被 dvh 覆盖掉");

  console.log("\n\x1b[36m== 接线检查：三处视口高度都要收口 ==\x1b[0m");

  const dialogSource = read("src/apps/answer-card/client/components/ui/v2/dialog.tsx");
  check(dialogSource.includes(`${SUPPORTS_DVH}:max-h-[calc(100dvh-64px)]`),
    "DialogContent 高度上限按可视视口收口（所有弹层共用）");
  check(/max-h-\[calc\(100vh-64px\)\]\s*.*supports|supports[\s\S]{0,40}max-h-\[calc\(100vh-64px\)\]/.test(dialogSource),
    "升级的同时保留 100vh 兜底——safari15 没有 dvh，删掉兜底会让弹层彻底不限高");

  const shellSource = read("src/apps/answer-card/client/components/ui/v2/shell.tsx");
  check(shellSource.includes(`${SUPPORTS_DVH}:h-[100dvh]`),
    "AppShell（overflow-hidden 根容器）高度按可视视口收口");

  const editorSource = read("src/apps/answer-card/client/components/CardCorrectionEditor.tsx");
  check(editorSource.includes(`${SUPPORTS_DVH}:h-[calc(100dvh-64px)]`),
    "整卡改分弹层的定高与 DialogContent 的上限同档（旧值 -48px 被上限静默夹紧，等于白写）");
  check(!editorSource.includes("100vh-48px"), "不再用比 DialogContent 上限更大的高度");
  check(/className="flex shrink-0 flex-wrap[^"]*"[^>]*>\s*<span className="text-correction-normal"/.test(editorSource),
    "翻页/缩放工具条 shrink-0：DialogBody 是 flex-basis:0，视口矮时挤扁的是没设收缩权的工具条");
  check(editorSource.includes('DialogBody className="min-h-0 flex-1 overflow-auto'),
    "原卷区仍可双向滚动（放大后的整页超出宽度时横向滚动）");

  console.log("\n\x1b[36m== 异常卷入口共用同一个弹层 ==\x1b[0m");

  for (const [file, label] of [
    ["src/apps/answer-card/client/components/ScoreFixPage.tsx", "成绩修正页"],
    ["src/apps/answer-card/client/components/PendingScanBanner.tsx", "待处理异常卷横幅"],
    ["src/apps/answer-card/client/components/ScannerConflictCards.tsx", "重复学号冲突卷"],
    ["src/apps/answer-card/client/components/ScannerPanel.tsx", "扫描端批量结果"]
  ] as const) {
    check(read(file).includes("CardCorrectionButton"), `${label}走同一个整卡改分弹层，修一处即全覆盖`);
  }

  console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("verify-correction-viewport-fit: ALL PASS");
}

main();
