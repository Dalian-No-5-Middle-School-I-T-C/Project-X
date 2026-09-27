/**
 * 答题卡注记文字的极简富文本：`**加粗**`、`*斜体*`、`***加粗斜体***`。
 *
 * 选择标记式而非结构化数据，是为了不新增数据库列：注记沿用 subjective_questions.annotation，
 * 预览（SVG）、导出（PDF）与排版（layout）三处共用本模块解析结果。
 */
export type RichTextRun = { text: string; bold: boolean; italic: boolean };

/** 解析标记文本；未闭合的标记按「切换开关」处理，不抛错。 */
export function parseRichText(text: string): RichTextRun[] {
  const runs: RichTextRun[] = [];
  let bold = false;
  let italic = false;
  let buffer = "";
  const flush = () => {
    if (buffer) runs.push({ text: buffer, bold, italic });
    buffer = "";
  };

  for (let i = 0; i < text.length; i += 1) {
    const three = text.startsWith("***", i);
    const two = !three && text.startsWith("**", i);
    const one = !three && !two && text[i] === "*";
    if (!three && !two && !one) {
      buffer += text[i];
      continue;
    }

    const marker = three ? "***" : two ? "**" : "*";
    const closing = three ? bold && italic : two ? bold : italic;
    // 未成对的单个 * 按普通字符处理：`2*3` 这类正文不能被吞掉
    if (!closing && text.indexOf(marker, i + marker.length) === -1) {
      buffer += marker;
      i += marker.length - 1;
      continue;
    }

    flush();
    if (three) {
      bold = !bold;
      italic = !italic;
      i += 2;
    } else if (two) {
      bold = !bold;
      i += 1;
    } else {
      italic = !italic;
    }
  }
  flush();

  return runs.length > 0 ? runs : [{ text: "", bold: false, italic: false }];
}

/** 去掉标记后的纯文本（宽度估算 / 换行用）。 */
export function richTextPlain(text: string): string {
  return parseRichText(text).map((run) => run.text).join("");
}

/** 取纯文本 [start, end) 区间对应的富文本片段（按行切片时用）。 */
export function sliceRichText(text: string, start: number, end: number): RichTextRun[] {
  const out: RichTextRun[] = [];
  let cursor = 0;
  for (const run of parseRichText(text)) {
    const runEnd = cursor + run.text.length;
    const from = Math.max(start, cursor);
    const to = Math.min(end, runEnd);
    if (to > from) {
      out.push({ text: run.text.slice(from - cursor, to - cursor), bold: run.bold, italic: run.italic });
    }
    cursor = runEnd;
  }
  return out;
}

/**
 * 折叠连续空白为单个空格并去掉首尾空白（跨 run 边界一并处理），空 run 剔除、
 * 相邻同样式 run 合并。返回的 run 序列拼接后即折行用的纯文本，行切片必须基于
 * 同一个序列进行（sliceRichTextRuns），否则 runs 与行文本会因折叠/trim 错位。
 */
export function compactRichTextRuns(runs: RichTextRun[]): RichTextRun[] {
  const out: RichTextRun[] = [];
  let pendingSpace = true; // 序列开头的空白视为待丢弃，顺带完成首部 trim
  for (const run of runs) {
    let text = run.text.replace(/\s+/g, " ");
    if (pendingSpace) text = text.replace(/^ /, "");
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic) {
      last.text += text;
    } else {
      out.push({ text, bold: run.bold, italic: run.italic });
    }
    pendingSpace = text.endsWith(" ");
  }
  while (out.length > 0 && out[out.length - 1].text.endsWith(" ")) {
    const last = out[out.length - 1];
    last.text = last.text.slice(0, -1);
    if (!last.text) out.pop();
  }
  return out;
}

/** 在 compactRichTextRuns 产出的 run 序列上取纯文本 [start, end) 区间对应的片段。 */
export function sliceRichTextRuns(runs: RichTextRun[], start: number, end: number): RichTextRun[] {
  const out: RichTextRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runEnd = cursor + run.text.length;
    const from = Math.max(start, cursor);
    const to = Math.min(end, runEnd);
    if (to > from) {
      out.push({ text: run.text.slice(from - cursor, to - cursor), bold: run.bold, italic: run.italic });
    }
    cursor = runEnd;
  }
  return out;
}
