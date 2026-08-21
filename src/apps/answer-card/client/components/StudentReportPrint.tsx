import { useEffect, useState } from "react";
import { Printer, X } from "lucide-react";
import { fetchJson } from "../auth/api";
import { formatScore } from "../util/format";
import type { StudentTrendPoint } from "../../../../shared/types";

interface WeakRow { point_text: string; question_numbers: string; rate: number }

/**
 * 建议 13：学生个人成绩报告单（家长会/学生手册场景）。
 * 单页 A4 内容：总分与排名、客观/主观得分、薄弱知识点、相对上次进退。
 * 打印走浏览器 printToPDF 等价通道（window.print，可另存为 PDF），零新依赖。
 */
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
}: {
  examId: number;
  studentId: number;
  studentName: string;
  studentNumber: string;
  examName: string;
  totalScore: number;
  objectiveScore: number;
  subjectiveScore: number;
  onClose: () => void;
}) {
  const [trend, setTrend] = useState<StudentTrendPoint[] | null>(null);
  const [weak, setWeak] = useState<WeakRow[] | null>(null);

  useEffect(() => {
    fetchJson<StudentTrendPoint[]>(`/api/analysis/students/${studentId}/trend`)
      .then(setTrend)
      .catch(() => setTrend([]));
    fetchJson<{ weaknesses: WeakRow[] }>(`/api/analysis/knowledge-points/${examId}/students/${studentId}`)
      .then((d) => setWeak(d?.weaknesses ?? []))
      .catch(() => setWeak([]));
  }, [examId, studentId]);

  const current = trend && trend.length > 0 ? trend[trend.length - 1] : null;
  const previous = trend && trend.length > 1 ? trend[trend.length - 2] : null;
  const scoreChange = current && previous ? Math.round((current.totalScore - previous.totalScore) * 10) / 10 : null;
  const rankChange = current && previous && previous.rank > 0 ? previous.rank - current.rank : null;
  const previousName = previous?.examName ?? null;

  const weakRows = (weak ?? []).slice(0, 8);

  const bodyProps = {
    examName, studentName, studentNumber,
    totalScore, objectiveScore, subjectiveScore,
    current, previousName, scoreChange, rankChange, weakRows,
  };

  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .report-print, .report-print * { visibility: visible !important; }
          .report-print { position: absolute; left: 0; top: 0; width: 100%; z-index: 9999; }
          .report-no-print { display: none !important; }
        }
      `}</style>

      {/* 预览 + 打印控制（屏幕显示，打印时隐藏） */}
      <div className="report-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-card">
          <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-3">
            <span className="text-sm font-semibold text-foreground">成绩报告单预览</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex h-control-sm items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground"
              >
                <Printer className="size-3.5" aria-hidden />打印（可另存为 PDF）
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-control-sm items-center gap-1.5 rounded-md border border-border px-3 text-xs text-secondary-foreground"
              >
                <X className="size-3.5" aria-hidden />关闭
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ReportBody {...bodyProps} />
          </div>
        </div>
      </div>

      {/* 打印内容（A4） */}
      <div className="report-print hidden" aria-hidden>
        <ReportBody {...bodyProps} />
      </div>
    </>
  );
}

function ReportBody({
  examName, studentName, studentNumber, totalScore, objectiveScore, subjectiveScore,
  current, previousName, scoreChange, rankChange, weakRows,
}: {
  examName: string; studentName: string; studentNumber: string;
  totalScore: number; objectiveScore: number; subjectiveScore: number;
  current: StudentTrendPoint | null;
  previousName: string | null;
  scoreChange: number | null;
  rankChange: number | null;
  weakRows: WeakRow[];
}) {
  return (
    <div className="bg-white p-8 text-[#111]">
      {/* 标题 */}
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

      {/* 总分与排名 */}
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

      {/* 相对上次 */}
      {(scoreChange != null || rankChange != null) && (
        <div className="mt-5 rounded border border-[#ccc] p-3 text-sm">
          <p className="m-0 font-semibold">较上次考试{previousName ? `（${previousName}）` : ""}</p>
          <p className="m-0 mt-1 text-[#333]">
            总分{scoreChange == null ? "—" : scoreChange >= 0 ? `↑ ${scoreChange}` : `↓ ${Math.abs(scoreChange)}`} 分；
            名次{rankChange == null ? "—" : rankChange > 0 ? `↑ ${rankChange}` : rankChange < 0 ? `↓ ${Math.abs(rankChange)}` : "持平"}
          </p>
        </div>
      )}

      {/* 薄弱知识点 */}
      <div className="mt-5">
        <h2 className="m-0 text-sm font-bold">薄弱知识点</h2>
        {weakRows.length === 0 ? (
          <p className="m-0 mt-1 text-sm text-[#555]">暂无知识点标注数据。</p>
        ) : (
          <table className="mt-2 w-full border-collapse text-sm">
            <tbody>
              {weakRows.map((w, i) => (
                <tr key={`${w.point_text}-${i}`} className="border-b border-[#ddd]">
                  <td className="py-1.5 pr-2">{w.point_text}</td>
                  <td className="py-1.5 pr-2 text-[#555]">题 {w.question_numbers}</td>
                  <td className="py-1.5 text-right tabular-nums">{w.rate}%</td>
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
