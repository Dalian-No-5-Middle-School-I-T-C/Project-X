import type { SubjectiveRenderItem } from "./types";

/**
 * 手动得分填涂格渲染门控（SVG 预览 / PDF 导出共用，防止两端行为漂移）。
 *
 * 判定规则：
 * 1. 仅 `manual_score_grid` 样式绘制得分格；
 * 2. `scoreGrid.enabled === false` 显式关闭；缺省（undefined / 旧数据）视为开启，向后兼容；
 * 3. V2 布局要求存在实际方格（layout 层已按 enabled 裁剪 scoreCells）；
 *    V1 布局按样式放行（layout 层仍可能预留表头行，但方格/分隔线绘制统一由本判定控制）。
 */
export function shouldRenderScoreGrid(question: SubjectiveRenderItem, isV2: boolean): boolean {
  return (
    question.style === "manual_score_grid" &&
    question.scoreGrid?.enabled !== false &&
    (!isV2 || question.scoreCells.length > 0)
  );
}
