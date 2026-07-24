import { GlobalSettingsPage } from "../components/GlobalSettingsPage";

/**
 * /global-settings 路由页：包裹 GlobalSettingsPage 并提供返回首页的 onBack。
 * v1.9.5: 修复「全局设置」按钮彻底失效（Routes 缺少该路径，点击后落到 * 重定向回 /home）。
 */
export function GlobalSettingsRoutePage({ onBack }: { onBack: () => void }) {
  return (
    <div className="main-grid account-grid">
      <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
        <GlobalSettingsPage onBack={onBack} />
      </section>
    </div>
  );
}
