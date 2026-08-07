import { useWorkspace } from "../WorkspaceContext";
import { ExamSelectPage } from "../components/ExamSelectPage";
import { ExamGroupDetailPage } from "../components/ExamGroupDetailPage";
import { ScoreDetailPage } from "../components/ScoreDetailPage";

/**
 * /analysis 路由页：含 analysisTab 三分支（select / group detail / exam detail）。
 *
 * 迁移说明：三分支路由逻辑原样保留，仅把 `main-grid analysis-grid` /
 * `preview-panel analysis-results-panel` 旧布局类换成 Tailwind 语义类。
 */
export function AnalysisRoutePage() {
  const {
    analysisTab,
    setAnalysisTab,
    selectedAnalysisExamId,
    setSelectedAnalysisExamId,
    analysisGroupId,
    setAnalysisGroupId,
    setShowGroupExport,
    examListRefreshKey,
    exams,
  } = useWorkspace();

  return (
    <div className="grid h-full min-h-0 w-full grid-cols-1 overflow-hidden">
      <section className="col-span-full flex min-h-0 flex-col overflow-y-auto bg-background">
        {analysisTab === "select" && analysisGroupId == null && (
          <ExamSelectPage
            refreshKey={examListRefreshKey}
            onSelectExam={(examId) => {
              setSelectedAnalysisExamId(examId);
              setAnalysisTab("detail");
            }}
            onSelectGroup={(groupId) => {
              setAnalysisGroupId(groupId);
            }}
          />
        )}
        {analysisGroupId != null && (
          <ExamGroupDetailPage
            groupId={analysisGroupId}
            onBack={() => setAnalysisGroupId(null)}
            onExport={() => setShowGroupExport(true)}
          />
        )}
        {analysisTab === "detail" &&
          selectedAnalysisExamId != null &&
          analysisGroupId == null && (
            <ScoreDetailPage
              examId={selectedAnalysisExamId}
              examName={
                exams.find((e) => e.id === selectedAnalysisExamId)?.name ?? ""
              }
              subject={
                exams.find((e) => e.id === selectedAnalysisExamId)?.subject ??
                null
              }
              onBack={() => {
                setSelectedAnalysisExamId(null);
                setAnalysisTab("select");
              }}
            />
          )}
      </section>
    </div>
  );
}
