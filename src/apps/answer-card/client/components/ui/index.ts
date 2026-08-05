/**
 * components/ui —— 兼容桶（P5 清理后）
 *
 * 旧的 PascalCase 组件（Button/Modal/SegmentedControl/Input/Panel/Table/
 * DataCard/Spinner/LoadingScreen）依赖 styles.css 的 legacy 类，已于 P5 删除。
 * 本文件仅作为过渡期的转发入口，唯一事实源是 `components/ui/v2`。
 *
 * 新代码请直接 `import { … } from "…/components/ui/v2"`，不要经由本文件。
 */
export * from "./v2";
