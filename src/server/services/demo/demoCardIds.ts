/**
 * 演示数据用到的答题卡 ID 单一来源（安全 R48）。
 *
 * 这些 ID 是**固定的**，而真实答题卡 ID 由 `generateCardId()` 生成，落在
 * 10000000–99999999 的纯数字区间里——演示 ID 正好在同一个区间内，撞上是可能的。
 * 撞上的后果过去是静默的：`INSERT ... IGNORE` 跳过建卡，演示考试直接挂到那张真实卡上，
 * 接着 `ensureDemoObjectiveBlock()` 给真实卡补一个 5 题选择题块（标准答案 A/B/C/D/A）、
 * 作文/填空块与 `assets/<cardId>/` 下的演示图片——**真实考试从此按演示答案判分**。
 * 所以导入前必须拿这份清单去比对真实卡，命中就整单拒绝（见 DemoDataService）。
 */

import type { DbAdapter } from "../../db";

/** 演示-语文卡：填空题块 + 作文格块都补在它上面。 */
export const DEMO_LANGUAGE_CARD_ID = "88000001";

/** 演示-数学卡：客观题块用「选项竖排」布局（与 manifest 的竖排用例一一对应）。 */
export const DEMO_VERTICAL_OPTIONS_CARD_ID = "88000002";

/** 演示-网阅卡：双评/仲裁/断点续批演示。 */
export const DEMO_REVIEW_CARD_ID = "88000999";

/**
 * 安全 R48：往卡上补演示块之前，先确认它**确实是演示卡**。
 * 命中真实卡时宁可少一块演示内容，也不能给它加块——那会直接改变真实考试的判分。
 * 卡不存在同样返回 false（演示卡由 seedDemoData 先建，走到这里不该缺）。
 */
export async function isDemoCard(db: DbAdapter, cardId: string): Promise<boolean> {
  const row = await db.get("SELECT is_demo FROM answer_cards WHERE id = ?", cardId) as
    | { is_demo: number | null }
    | undefined;
  if (!row) return false;
  if (Number(row.is_demo) === 1) return true;
  console.warn(`[seed] 答题卡 ${cardId} 不是演示卡（is_demo=${row.is_demo}），已跳过演示块写入`);
  return false;
}
