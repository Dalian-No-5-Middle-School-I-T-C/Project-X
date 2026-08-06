import type { ProjectXAppMode } from "../../../shared/appVariant";

/**
 * mode（工作模式）↔ URL 路径 的单一映射表。
 * 是 Phase 2「网页化」的核心：每个功能 = 一个真实 URL，
 * 可在新浏览器标签打开、可深链、刷新保持当前页。
 */
export const MODE_PATH: Record<ProjectXAppMode, string> = {
  design: "/design",
  "exam-manage": "/exam-manage",
  home: "/home",
  analysis: "/analysis",
  scores: "/scores",
  account: "/account",
  "account-settings": "/account-settings",
  "global-settings": "/global-settings",
  sponsor: "/sponsor",
  guide: "/guide",
  permissions: "/permissions",
};

/** 由当前 pathname 推断 mode；无法识别时返回 null（调用方回退到 design）。 */
export function pathToMode(pathname: string): ProjectXAppMode | null {
  // 根路径直接视作首页，避免首渲染依赖调用方 ?? 兜底产生的冗余状态/闪烁。
  if (pathname === "/" || pathname === "") return "home";
  const entry = (Object.entries(MODE_PATH) as [ProjectXAppMode, string][]).find(
    ([, p]) => pathname === p || pathname.startsWith(p + "/")
  );
  return entry ? entry[0] : null;
}
