import { AccountManagement } from "../components/AccountManagement";

/**
 * /account 路由页：从 App.tsx 1798-1807 行抽离。
 */
export function AccountRoutePage() {
  return (
    <div className="main-grid account-grid">
      <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
        <AccountManagement />
      </section>
    </div>
  );
}
