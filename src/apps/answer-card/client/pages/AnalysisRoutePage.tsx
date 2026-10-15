import { useWorkspace } from "../WorkspaceContext";
import { useEffect, useState } from "react";
import { fetchJson } from "../auth/api";
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

  const [exam, setExam] = useState<{ id: number; name: string; subject: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    setExam(null);
    if (selectedAnalysisExamId != null) {
      void fetchJson<{ id: number; name: string; subject: string | null }>(`/api/exams/${selectedAnalysisExamId}`)
        .then(value => { if (active) setExam(value); }).catch(() => {});
    }
    return () => { active = false; };
  }, [selectedAnalysisExamId]);
  const selectedExam = exam?.id === selectedAnalysisExamId ? exam : exams.find(e => e.id === selectedAnalysisExamId);

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
              examName={selectedExam?.name ?? ""}
              subject={selectedExam?.subject ?? null}
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
