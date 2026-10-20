/**
 * 把 src/shared/scoreProgress.ts 打成浏览器可直接加载的 IIFE。
 * 独立成绩分析页不能 import TypeScript，所以用这份生成物，而不是在 HTML 里再写一套阈值和舍入。
 *
 * 用法: npx tsx scripts/sync-score-progress-browser.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

export const SCORE_PROGRESS_BROWSER = path.resolve("src/shared/scoreProgress.global.js");

export async function buildScoreProgressBrowser(): Promise<string> {
  const result = await esbuild.build({
    absWorkingDir: path.resolve("."),
    entryPoints: ["src/shared/scoreProgress.ts"],
    bundle: true,
    format: "iife",
    globalName: "ScoreProgress",
    platform: "browser",
    target: "es2017",
    write: false,
    banner: {
      js: "/* Generated from src/shared/scoreProgress.ts — do not edit.\n   Regenerate: npx tsx scripts/sync-score-progress-browser.ts */",
    },
  });
  return result.outputFiles[0].text.endsWith("\n") ? result.outputFiles[0].text : `${result.outputFiles[0].text}\n`;
}

const invokedDirectly = Boolean(process.argv[1] && path.resolve(process.argv[1]).endsWith(`${path.sep}sync-score-progress-browser.ts`));
if (invokedDirectly) {
  const js = await buildScoreProgressBrowser();
  writeFileSync(SCORE_PROGRESS_BROWSER, js);
  console.log(`wrote ${path.relative(".", SCORE_PROGRESS_BROWSER)}`);
}
