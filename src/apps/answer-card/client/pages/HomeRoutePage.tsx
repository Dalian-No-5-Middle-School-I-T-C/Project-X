import { useWorkspace } from "../WorkspaceContext";
import { HomePage } from "../components/HomePage";
import type { AppMode } from "../WorkspaceContext";

/**
 * /home 路由页：从 App.tsx 1732-1754 行抽离。
 * 状态经 useWorkspace() 消费，零 props 透传。
 */
export function HomeRoutePage() {
  const { user, switchMode, setSelectedExamId } = useWorkspace();

  return (
    <div className="grid w-full gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="col-span-full p-0">
        <HomePage
          userName={user?.name ?? ""}
          userRole={user?.role_name ?? ""}
          teacherRole={user?.teacher_role ?? null}
          onNavigate={(m) => switchMode(m as AppMode)}
          onOpenNewTab={(m) => switchMode(m as AppMode)}
          onEnterExam={(id) => { switchMode("exam-manage"); setSelectedExamId(id); }}
        />
      </section>
    </div>
  );
}
