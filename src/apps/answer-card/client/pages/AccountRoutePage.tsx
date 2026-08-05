import { AccountManagement } from "../components/AccountManagement";

/**
 * /account 路由页：从 App.tsx 1798-1807 行抽离。
 */
export function AccountRoutePage() {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6 lg:px-8">
      <AccountManagement />
    </div>
  );
}
