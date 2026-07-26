import { useWorkspace } from "../WorkspaceContext";
import { ExamSelectPage } from "../components/ExamSelectPage";
import { ExamGroupDetailPage } from "../components/ExamGroupDetailPage";
import { ScoreDetailPage } from "../components/ScoreDetailPage";

/**
 * /analysis 路由页：从 App.tsx 1757-1787 行抽离。
 * 含 analysisTab 三分支：select / group detail / exam detail。
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
    <div className="main-grid analysis-grid">
      <section className="preview-panel analysis-results-panel" style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column" }}>
        {analysisTab === "select" && analysisGroupId == null && (
          <ExamSelectPage
            refreshKey={examListRefreshKey}
            onSelectExam={(examId) => { setSelectedAnalysisExamId(examId); setAnalysisTab("detail"); }}
            onSelectGroup={(groupId) => { setAnalysisGroupId(groupId); }}
          />
        )}
        {analysisGroupId != null && (
          <ExamGroupDetailPage
            groupId={analysisGroupId}
            onBack={() => setAnalysisGroupId(null)}
            onExport={() => setShowGroupExport(true)}
          />
        )}
        {analysisTab === "detail" && selectedAnalysisExamId != null && analysisGroupId == null && (
          <ScoreDetailPage
            examId={selectedAnalysisExamId}
            examName={exams.find((e) => e.id === selectedAnalysisExamId)?.name ?? ""}
            subject={exams.find((e) => e.id === selectedAnalysisExamId)?.subject ?? null}
            onBack={() => { setSelectedAnalysisExamId(null); setAnalysisTab("select"); }}
          />
        )}
      </section>
    </div>
  );
}
