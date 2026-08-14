import { useWorkspace } from "../WorkspaceContext";
import { HomePage } from "../components/HomePage";
import type { AppMode } from "../WorkspaceContext";

/**
 * /home 路由页。
 * 最新出分卡片：先设分析状态（detail + examId），再切到 analysis 模式。
 */
export function HomeRoutePage() {
  const {
    user,
    switchMode,
    setSelectedExamId,
    loadExams,
    setAnalysisTab,
    setSelectedAnalysisExamId,
    setAnalysisGroupId,
  } = useWorkspace();

  return (
    <div className="grid w-full gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="col-span-full p-0">
        <HomePage
          userName={user?.name ?? ""}
          userRole={user?.role_name ?? ""}
          teacherRole={user?.teacher_role ?? null}
          onNavigate={(m) => {
            if (m === "analysis") {
              setAnalysisGroupId(null);
              setAnalysisTab("select");
              setSelectedAnalysisExamId(null);
            }
            switchMode(m as AppMode);
          }}
          onOpenNewTab={(m) => switchMode(m as AppMode)}
          onEnterExam={(id) => { switchMode("exam-manage"); setSelectedExamId(id); }}
          onOpenAnalysis={(examId) => {
            setAnalysisGroupId(null);
            setAnalysisTab("detail");
            setSelectedAnalysisExamId(examId);
            void loadExams();
            switchMode("analysis");
          }}
        />
      </section>
    </div>
  );
}
