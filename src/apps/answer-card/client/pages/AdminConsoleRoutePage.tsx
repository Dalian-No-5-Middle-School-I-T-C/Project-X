import { AdminConsolePage } from "../components/AdminConsolePage";

/**
 * /admin-console 路由页：管理员控制台（SYSTEM_MANAGE）。
 * 消费 /api/admin/console/* 五端点 + /api/admin/data-retention-policies。
 */
export function AdminConsoleRoutePage({ onBack }: { onBack: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6 lg:px-8">
      <AdminConsolePage onBack={onBack} />
    </div>
  );
}
