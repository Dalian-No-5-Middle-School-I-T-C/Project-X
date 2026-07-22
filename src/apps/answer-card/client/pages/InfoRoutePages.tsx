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
    <div className="main-grid sponsor-grid">
      <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
        <SponsorPage onBack={navigateBackFromInfo} />
      </section>
    </div>
  );
}

export function PermissionsRoutePage() {
  const { navigateBackFromInfo } = useWorkspace();
  return (
    <div className="main-grid permissions-grid">
      <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
        <PermissionManager onBack={navigateBackFromInfo} />
      </section>
    </div>
  );
}

export function GuideRoutePage() {
  const { navigateBackFromInfo } = useWorkspace();
  return (
    <div className="main-grid guide-grid">
      <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
        <UserGuidePage onBack={navigateBackFromInfo} />
      </section>
    </div>
  );
}
