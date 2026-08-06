/**
 * 成绩相关的纯函数工具。
 *
 * 迁移说明（UI-6 / O-2）：
 * 服务端在不同接口里把「人工订正过」这个标记序列化成过 `true` / `1` 两种形态
 * （SQLite 的 INTEGER 布尔与 JSON 布尔混用），此前 ScoreFixPage 与
 * StudentScoreDetail 各写各的判断，容易漏掉其中一种。统一收口到这里。
 */

/**
 * 判断一条成绩是否被人工订正过。
 *
 * 容忍服务端返回的两种真值形态：JSON 布尔 `true` 与 SQLite INTEGER `1`。
 * 其余一律视为「未订正」，包括 `null` / `undefined` / `0` / `false`。
 *
 * @param value 服务端返回的 `manuallyModified` / `manually_modified` 字段
 * @returns 该成绩是否被人工订正过
 */
export function isManuallyModified(
  value: boolean | number | null | undefined,
): boolean {
  return value === true || value === 1;
}
