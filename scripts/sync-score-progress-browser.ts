/**
 * 把 src/shared/scoreProgress.ts 打成浏览器可直接执行的 IIFE，并内联进
 * Grade-Analysis-System-mobile.html。
 *
 * 独立成绩分析页按文档是单文件复制部署，外部 <script src="src/shared/..."> 在
 * Nginx 静态目录 / dist/web 下不存在，加载失败会让后面的内联脚本整段中断。
 * 因此生成物必须随 HTML 一起交付，而不是再维护一份手写阈值。
 *
 * 用法: npx tsx scripts/sync-score-progress-browser.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

export const SCORE_PROGRESS_HTML = path.resolve("Grade-Analysis-System-mobile.html");
const START = "/* SCORE_PROGRESS_BROWSER_START */";
const END = "/* SCORE_PROGRESS_BROWSER_END */";
const BLOCK = /<script>\s*\/\* SCORE_PROGRESS_BROWSER_START \*\/[\s\S]*?\/\* SCORE_PROGRESS_BROWSER_END \*\/\s*<\/script>/;
const LEGACY = /<script src="src\/shared\/scoreProgress\.global\.js"><\/script>/;

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

function browserBlock(js: string): string {
  return `<script>\n${START}\n${js}${END}\n</script>`;
}

export function extractInlinedScoreProgress(html: string): string | null {
  const match = html.match(BLOCK);
  if (!match) return null;
  const start = match[0].indexOf(START);
  const end = match[0].indexOf(END);
  return match[0].slice(start + START.length, end).trim().replace(/\r\n/g, "\n") + "\n";
}

export function inlineScoreProgressIntoHtml(html: string, js: string): string {
  const block = browserBlock(js);
  if (BLOCK.test(html)) return html.replace(BLOCK, block);
  if (LEGACY.test(html)) return html.replace(LEGACY, block);
  throw new Error("Grade-Analysis-System-mobile.html 里找不到 scoreProgress 生成块或旧的外部脚本标签");
}

const invokedDirectly = Boolean(process.argv[1] && path.resolve(process.argv[1]).endsWith(`${path.sep}sync-score-progress-browser.ts`));
if (invokedDirectly) {
  const js = await buildScoreProgressBrowser();
  const html = readFileSync(SCORE_PROGRESS_HTML, "utf8");
  writeFileSync(SCORE_PROGRESS_HTML, inlineScoreProgressIntoHtml(html, js));
  console.log(`inlined ${path.relative(".", SCORE_PROGRESS_HTML)}`);
}
