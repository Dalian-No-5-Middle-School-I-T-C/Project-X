import { detectDialect } from "./mysql";

/** Match mysql2's default local DATETIME encoding; keep SQLite's ISO contract. */
export function databaseTimestamp(value: Date | string = new Date(), dialect = detectDialect()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (dialect === "sqlite") return date.toISOString();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * 时间比较两侧的**归一化 SQL 片段**（PR #312 评审 B3 抽出来共用）。
 *
 * 坑在这里：SQLite 的 `CURRENT_TIMESTAMP` 列默认值写入的是**空格分隔的 UTC**
 * （`2026-10-04 06:00:00`），而本仓库的 `databaseTimestamp()` 在 SQLite 上按既有约定产出
 * **ISO**（`2026-10-04T06:00:00.000Z`）。两者直接做字符串比较时 `'T' > ' '`，任何由列默认值
 * 写入的行都会被判成「早于窗口起点」——过滤条件看着生效，实际永远筛不出东西。
 * 把两侧都截成 `YYYY-MM-DD HH:MM:SS` 再比即可消除分隔符差异：
 *  - SQLite：比较双方同为 UTC，只差分隔符与小数位；
 *  - MariaDB：`DATETIME` 与 `databaseTimestamp()` 同为本地时间，归一是无操作。
 * 只用 `REPLACE` / `SUBSTR`（两方言同名同义），不引入 `date_format`。
 *
 * `column` 只接受代码里写死的列名（不做参数拼接入口），调用方负责它是可信标识符。
 */
export function sqlTimeAt(column: string): string {
  return `SUBSTR(REPLACE(${column}, 'T', ' '), 1, 19)`;
}

/** 与 `sqlTimeAt` 配对的绑定参数侧片段。 */
export const SQL_TIME_ARG = "SUBSTR(REPLACE(?, 'T', ' '), 1, 19)";
