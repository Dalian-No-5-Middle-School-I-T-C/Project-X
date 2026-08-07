import { GlobalSettingsPage } from "../components/GlobalSettingsPage";

/**
 * /global-settings 路由页：包裹 GlobalSettingsPage 并提供返回首页的 onBack。
 * v1.9.5: 修复「全局设置」按钮彻底失效（Routes 缺少该路径，点击后落到 * 重定向回 /home）。
 */
export function GlobalSettingsRoutePage({ onBack }: { onBack: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6 lg:px-8">
      <GlobalSettingsPage onBack={onBack} />
    </div>
  );
}
