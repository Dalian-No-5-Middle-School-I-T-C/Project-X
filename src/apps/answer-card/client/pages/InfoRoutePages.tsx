import { useWorkspace } from "../WorkspaceContext";
import { SponsorPage } from "../components/SponsorPage";
import { PermissionManager } from "../components/PermissionManager";
import { UserGuidePage } from "../components/UserGuidePage";

/**
 * /sponsor /permissions /guide 三个同构信息页：从 App.tsx 1808-1837 行抽离。
 * 结构均为 main-grid + preview-panel + 单个组件,onBack 统一改用 navigateBackFromInfo()。
 */
export function SponsorRoutePage() {
  const { navigateBackFromInfo } = useWorkspace();
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6 lg:px-8">
      <SponsorPage onBack={navigateBackFromInfo} />
    </div>
  );
}

export function PermissionsRoutePage() {
  const { navigateBackFromInfo } = useWorkspace();
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6 lg:px-8">
      <PermissionManager onBack={navigateBackFromInfo} />
    </div>
  );
}

export function GuideRoutePage() {
  const { navigateBackFromInfo } = useWorkspace();
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6 lg:px-8">
      <UserGuidePage onBack={navigateBackFromInfo} />
    </div>
  );
}
