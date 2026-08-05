/**
 * P5 清理辅助脚本（临时分析工具，用完即删）
 *
 * 精确统计：styles.css 中定义的 class 选择器，在 client 其余源码的
 * className / class 属性（含模板字符串、cn()、条件表达式）中是否仍被引用。
 *
 * 做法：先抽出所有 className={...} / className="..." / class="..." 的**值区间**，
 * 从中切词得到候选 class token，再与 styles.css 定义集求交。
 * 这样可以避开 `.card` 匹配到 <Card>、`.page` 匹配到 page 变量之类的误报。
 */
import fs from "fs";
import path from "path";

const CLIENT = "src/apps/answer-card/client";
const stylesPath = path.join(CLIENT, "styles.css");
const css = fs.readFileSync(stylesPath, "utf8");

// ---------- 1. styles.css 定义了哪些 class ----------
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const defined = new Set();
const ruleRe = /(^|[};])\s*([^{};@]+)\{/g;
let r;
while ((r = ruleRe.exec(noComments)) !== null) {
  const cr = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g;
  let c;
  while ((c = cr.exec(r[2])) !== null) defined.add(c[1]);
}

// ---------- 2. 收集源文件 ----------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css|html)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(CLIENT).filter((f) => !f.endsWith("styles.css"));
for (const f of ["index.html", "index-scanner.html"]) {
  if (fs.existsSync(f)) files.push(f);
}

// ---------- 3. 抽取 className 值区间 ----------
/** 从 index 处的 `{` 或引号开始，返回配平后的值文本与结束下标 */
function extractValue(txt, start) {
  const ch = txt[start];
  if (ch === '"' || ch === "'") {
    const end = txt.indexOf(ch, start + 1);
    return end === -1 ? null : { value: txt.slice(start + 1, end), end };
  }
  if (ch === "{") {
    let depth = 0;
    for (let i = start; i < txt.length; i++) {
      if (txt[i] === "{") depth++;
      else if (txt[i] === "}") {
        depth--;
        if (depth === 0) return { value: txt.slice(start + 1, i), end: i };
      }
    }
  }
  return null;
}

const attrRe = /\b(className|class)\s*=\s*/g;
const used = new Map(); // class -> Set(locations)

function record(cls, file, line) {
  if (!used.has(cls)) used.set(cls, []);
  used.get(cls).push(file + ":" + line);
}

function lineOf(txt, idx) {
  return txt.slice(0, idx).split("\n").length;
}

for (const f of files) {
  const txt = fs.readFileSync(f, "utf8");

  if (f.endsWith(".css")) {
    // css 文件：找 @apply / 选择器里对 legacy 类的引用
    const cNo = txt.replace(/\/\*[\s\S]*?\*\//g, "");
    const cr = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g;
    let c;
    while ((c = cr.exec(cNo)) !== null) {
      if (defined.has(c[1])) record(c[1], f, lineOf(txt, c.index));
    }
    continue;
  }

  attrRe.lastIndex = 0;
  let m;
  while ((m = attrRe.exec(txt)) !== null) {
    const got = extractValue(txt, attrRe.lastIndex);
    if (!got) continue;
    const line = lineOf(txt, m.index);
    // 切词：任何非 class 字符都当分隔符
    for (const tok of got.value.split(/[^-_a-zA-Z0-9]+/)) {
      if (tok && defined.has(tok)) record(tok, f, line);
    }
    attrRe.lastIndex = got.end;
  }
}

console.log("styles.css 定义 class 总数:", defined.size);
console.log("仍被 className 引用的 legacy class 数:", used.size);
console.log("---- 仍在使用（class -> 次数, 位置） ----");
const sorted = [...used.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [cls, locs] of sorted) {
  console.log("." + cls + "  (" + locs.length + ")  " + [...new Set(locs)].slice(0, 6).join(" , "));
}

console.log("\n---- 按文件汇总 ----");
const byFile = new Map();
for (const [cls, locs] of used) {
  for (const l of locs) {
    const file = l.slice(0, l.lastIndexOf(":"));
    if (!byFile.has(file)) byFile.set(file, new Set());
    byFile.get(file).add(cls);
  }
}
for (const [file, set] of [...byFile.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(file + "  → " + set.size + " 个 legacy class: " + [...set].join(", "));
}
