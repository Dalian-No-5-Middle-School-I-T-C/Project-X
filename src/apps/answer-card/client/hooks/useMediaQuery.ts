import { useEffect, useState } from "react";
import { BP, maxWidthQuery } from "../breakpoints";

/**
 * 通用 matchMedia hook,订阅媒体查询变化。
 * SSR/首屏安全:初始值在挂载时同步读取,不闪烁。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // 初始同步(应对 query 字符串变化)
    setMatches(mql.matches);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // iOS Safari < 14 兜底
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}

/** ≤ 480px 手机竖屏。与 styles.css 480px 主断点同源。 */
export function useIsMobile(): boolean {
  return useMediaQuery(maxWidthQuery("phone"));
}

/** ≤ 768px 平板竖屏/手机横屏。 */
export function useIsTablet(): boolean {
  return useMediaQuery(maxWidthQuery("tablet"));
}

/** ≤ 1024px 平板横屏/小桌面。 */
export function useIsDesktop(): boolean {
  return useMediaQuery(maxWidthQuery("desktop"));
}

/** 暴露数值常量,便于组件内做非媒体查询的宽度判断。 */
export { BP };
