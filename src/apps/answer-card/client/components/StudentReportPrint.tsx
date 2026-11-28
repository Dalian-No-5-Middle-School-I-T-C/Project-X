import { useEffect, useMemo, useRef, useState } from "react";
import { Printer, X } from "lucide-react";
import { fetchJson } from "../auth/api";
import { formatScore } from "../util/format";
import { examPairInTrend, scoreRateChange } from "../../../../shared/scoreProgress";
import type { StudentTrendPoint } from "../../../../shared/types";
import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Spinner } from "./ui/v2";

interface WeakRow { point_text: string; question_numbers: string; rate: number }

export interface StudentReportTarget {
  examId: number;
  examName: string;
  studentId: number;
  studentName: string;
  studentNumber: string;
  totalScore: number;
  objectiveScore: number;
  subjectiveScore: number;
}

interface LoadedReport {
  target: StudentReportTarget;
  trend: StudentTrendPoint[];
  weak: WeakRow[];
}

interface ReportBodyProps {
  examName: string; studentName: string; studentNumber: string;
  totalScore: number; objectiveScore: number; subjectiveScore: number;
  current: StudentTrendPoint | null;
  previousName: string | null;
  scoreChange: number | null;
  scoreRateDelta: number | null;
  rankChange: number | null;
  weakRows: WeakRow[];
}

function reportBodyProps({ target, trend, weak }: LoadedReport): ReportBodyProps {
  // 报告单必须描述所选场次，不能误用趋势中更晚的考试。
  const pair = examPairInTrend(trend, target.examId);
  const current = pair?.current ?? null;
  const previous = pair?.previous ?? null;
  const scoreChange = current && previous ? Math.round((current.totalScore - previous.totalScore) * 10) / 10 : null;
  const scoreRateDelta = scoreRateChange(current?.scoreRate, previous?.scoreRate);
  const rankChange = current && previous && previous.rank > 0 ? previous.rank - current.rank : null;
  return {
    examName: target.examName,
    studentName: target.studentName,
    studentNumber: target.studentNumber,
    totalScore: target.totalScore,
    objectiveScore: target.objectiveScore,
    subjectiveScore: target.subjectiveScore,
    current,
    previousName: previous?.examName ?? null,
    scoreChange,
    scoreRateDelta,
    rankChange,
    weakRows: weak.slice(0, 8),
  };
}

/** 限制到四个在途报告，全部读完后一次性挂载多个打印页。 */
function useStudentReports(targets: StudentReportTarget[]) {
  const [reports, setReports] = useState<LoadedReport[]>([]);
  const [completed, setCompleted] = useState(0);
  const request = useRef(0);
  const targetKey = useMemo(() => JSON.stringify(targets), [targets]);

  useEffect(() => {
    const seq = ++request.current;
    const controller = new AbortController();
    const loaded: LoadedReport[] = new Array(targets.length);
    let next = 0;
    let done = 0;
    setReports([]);
    setCompleted(0);

    async function worker() {
      while (seq === request.current) {
        const index = next++;
        if (index >= targets.length) return;
        const target = targets[index];
        const options = { signal: controller.signal };
        const [trend, knowledge] = await Promise.all([
          fetchJson<StudentTrendPoint[]>(`/api/analysis/students/${target.studentId}/trend`, options).catch(() => []),
          fetchJson<{ weaknesses: WeakRow[] }>(`/api/analysis/knowledge-points/${target.examId}/students/${target.studentId}`, options)
            .then((data) => data?.weaknesses ?? [])
            .catch(() => []),
        ]);
        if (seq !== request.current) return;
        loaded[index] = { target, trend, weak: knowledge };
        done += 1;
        setCompleted(done);
      }
    }

    void Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker())).then(() => {
      if (seq === request.current) setReports(loaded.filter(Boolean));
    });
    return () => {
      request.current += 1;
      controller.abort();
    };
    // targets is supplied as a stable snapshot by callers; the key also protects
    // against an equivalent inline array causing another load on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  return { reports, completed, loading: completed < targets.length };
}

function ReportDialog({ targets, onClose }: { targets: StudentReportTarget[]; onClose: () => void }) {
  const { reports, completed, loading } = useStudentReports(targets);
  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open && !loading) onClose(); }}>
        <DialogContent size="lg" className="report-no-print max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>成绩报告单预览</DialogTitle>
            <DialogDescription>
              已加载 {completed} / {targets.length} 份；全部加载完成后一次打印，每份报告单独分页。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="bg-secondary">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Spinner /> 正在加载报告数据…
              </div>
            ) : (
              <div className="mx-auto flex w-full max-w-[210mm] flex-col gap-4">
                {reports.map((report) => (
                  <div key={`${report.target.examId}:${report.target.studentId}`} className="overflow-hidden rounded border border-border-subtle bg-white shadow-1">
                    <ReportBody {...reportBodyProps(report)} />
                  </div>
                ))}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" icon={<X />} onClick={onClose}>关闭</Button>
            <Button variant="primary" icon={<Printer />} disabled={loading} onClick={() => window.print()}>
              打印（可另存为 PDF）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!loading && (
        <div className="report-print hidden print:block" aria-hidden>
          {reports.map((report) => (
            <div className="report-print-page" key={`${report.target.examId}:${report.target.studentId}`}>
              <ReportBody {...reportBodyProps(report)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** 单人报告单入口，保持现有调用方 API。 */
export function StudentReportPrint({
  examId,
  studentId,
  studentName,
  studentNumber,
  examName,
  totalScore,
  objectiveScore,
  subjectiveScore,
  onClose,
}: StudentReportTarget & { onClose: () => void }) {
  const targets = useMemo(() => [{
    examId, examName, studentId, studentName, studentNumber,
    totalScore, objectiveScore, subjectiveScore,
  }], [examId, examName, studentId, studentName, studentNumber, totalScore, objectiveScore, subjectiveScore]);
  return <ReportDialog targets={targets} onClose={onClose} />;
}

/** 按班级或勾选学生批量打印；只生成一次 window.print 调用。 */
export function StudentReportPrintBatch({ targets, onClose }: { targets: StudentReportTarget[]; onClose: () => void }) {
  return <ReportDialog targets={targets} onClose={onClose} />;
}

export function ReportBody({
  examName, studentName, studentNumber, totalScore, objectiveScore, subjectiveScore,
  current, previousName, scoreChange, scoreRateDelta, rankChange, weakRows,
}: ReportBodyProps) {
  return (
    <div className="bg-white p-8 text-[#111]">
      <div className="flex items-start justify-between border-b-2 border-[#111] pb-3">
        <div>
          <h1 className="m-0 text-xl font-bold">成绩报告单</h1>
          <p className="m-0 mt-1 text-sm text-[#555]">{examName}</p>
        </div>
        <div className="text-right text-sm text-[#333]">
          <p className="m-0">姓名：{studentName}</p>
          <p className="m-0">考号：{studentNumber}</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <InfoCell label="总分" value={`${formatScore(totalScore)} 分`} big />
        <InfoCell label="客观题得分" value={`${formatScore(objectiveScore)} 分`} />
        <InfoCell label="主观题得分" value={`${formatScore(subjectiveScore)} 分`} />
        {current ? (
          <>
            <InfoCell label="年级排名" value={`第 ${current.rank} / ${current.classSize} 名`} />
            <InfoCell label="年级百分位" value={`${current.percentile}`} />
            <InfoCell label="得分率" value={current.scoreRate != null ? `${current.scoreRate}%` : "—"} />
          </>
        ) : (
          <InfoCell label="排名" value="—" />
        )}
      </div>

      {(scoreRateDelta != null || scoreChange != null || rankChange != null) && (
        <div className="mt-5 rounded border border-[#ccc] p-3 text-sm">
          <p className="m-0 font-semibold">较上次考试{previousName ? `（${previousName}）` : ""}</p>
          <p className="m-0 mt-1 text-[#333]">
            得分率{scoreRateDelta == null
              ? "—"
              : scoreRateDelta > 0
                ? `↑ +${scoreRateDelta} pp`
                : scoreRateDelta < 0
                  ? `↓ ${scoreRateDelta} pp`
                  : "持平"}；
            总分{scoreChange == null ? "—" : scoreChange > 0 ? `↑ ${scoreChange}` : scoreChange < 0 ? `↓ ${Math.abs(scoreChange)}` : "持平"} 分；
            名次{rankChange == null ? "—" : rankChange > 0 ? `↑ ${rankChange}` : rankChange < 0 ? `↓ ${Math.abs(rankChange)}` : "持平"}
          </p>
        </div>
      )}

      <div className="mt-5">
        <h2 className="m-0 text-sm font-bold">薄弱知识点</h2>
        {weakRows.length === 0 ? (
          <p className="m-0 mt-1 text-sm text-[#555]">暂无知识点标注数据。</p>
        ) : (
          <table className="mt-2 w-full border-collapse text-sm">
            <tbody>
              {weakRows.map((weak, index) => (
                <tr key={`${weak.point_text}-${index}`} className="border-b border-[#ddd]">
                  <td className="py-1.5 pr-2">{weak.point_text}</td>
                  <td className="py-1.5 pr-2 text-[#555]">题 {weak.question_numbers}</td>
                  <td className="py-1.5 text-right tabular-nums">{weak.rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-8 text-center text-xs text-[#888]">本报告单由答题卡设计阅卷系统自动生成</p>
    </div>
  );
}

function InfoCell({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="rounded border border-[#ddd] px-3 py-2">
      <p className="m-0 text-xs text-[#777]">{label}</p>
      <p className={`m-0 font-semibold ${big ? "text-lg" : "text-sm"}`}>{value}</p>
    </div>
  );
}
