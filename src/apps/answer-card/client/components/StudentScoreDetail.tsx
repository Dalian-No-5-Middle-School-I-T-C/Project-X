import { useEffect, useState } from "react";
import { ArrowLeft, ImageOff, Printer } from "lucide-react";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import { isManuallyModified } from "../util/score";
import {
  Button,
  EmptyState,
  ErrorState,
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
  type ProgressTone,
} from "./ui/v2";
import { AnswerCardLightbox, type LightboxItem } from "./AnswerCardLightbox";
import { StudentTrendBlock } from "./StudentTrendBlock";
import { StudentReportPrint } from "./StudentReportPrint";
import type { AnswerBlockCrop } from "../../../../shared/types";

/**
 * StudentScoreDetail —— T2 迁移（T04 明细/订正/弹窗）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · 放大答题卡：手写 Portal + 魔法 z 层级 + 硬编码近黑底 → `AnswerCardLightbox`（O-6）
 *  · 手写得分率进度条（含硬编码橙色）→ v2 `Progress` + tone 分档
 *  · 手写 table + 斑马纹 → v2 `Table` 原语，改分行走 `selected` 高亮
 *  · 「已手动修改」判定统一走 `isManuallyModified()`（O-2）
 */

interface Props {
  examId: number;
  studentId: number;
  studentName: string;
  studentNumber: string;
  examName: string;
  onBack: () => void;
}

interface ClassQStat { avgScore: number; maxScore: number; count: number }

interface StudentScore {
  student: { id: number; name: string; studentNumber: string };
  totalScore: { objectiveScore: number; subjectiveScore: number; totalScore: number; manuallyModified: boolean } | null;
  questionScores: Array<{
    id: number; question_number: number; score_type: string;
    score: number; max_score: number;
    mode: string; optionCount: number; blockType: string;
    answerKey?: string[];
    manually_modified: number;
  }>;
  recognition?: Record<number, { selectedOptions: string[]; confidence: number }>;
  classQuestionStats: Record<number, ClassQStat>;
  scans: Array<{ recordId: number; fileName: string; pageNum: number }>;
  answerBlocks: AnswerBlockCrop[];
  cardId: string;
}

/** 得分率分档 → 语义色（替代原先的 绿 / 橙 / 品牌色 三段硬编码） */
function rateTone(rate: number): ProgressTone {
  if (rate >= 80) return "success";
  if (rate >= 60) return "warning";
  return "destructive";
}

export function StudentScoreDetail({ examId, studentId, studentName, studentNumber, examName, onBack }: Props) {
  const [data, setData] = useState<StudentScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [enlargeIdx, setEnlargeIdx] = useState(-1);
  const [zoom, setZoomState] = useState(1);
  const [activeImageId, setActiveImageId] = useState("");
  const [printOpen, setPrintOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchJson<StudentScore>(`/api/exams/${examId}/student/${studentId}/scores`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [examId, studentId]);

  const objScores = data?.questionScores.filter((q) => q.score_type === "objective") ?? [];
  const subjScores = data?.questionScores.filter((q) => q.score_type === "subjective") ?? [];

  // Class-level aggregate rates
  const cs = data?.classQuestionStats ?? {};
  const classObjTotal = objScores.reduce((s, q) => s + (cs[q.question_number]?.avgScore ?? 0), 0);
  const classObjMax = objScores.reduce((s, q) => s + (cs[q.question_number]?.maxScore ?? q.max_score), 0);
  const classSubjTotal = subjScores.reduce((s, q) => s + (cs[q.question_number]?.avgScore ?? 0), 0);
  const classSubjMax = subjScores.reduce((s, q) => s + (cs[q.question_number]?.maxScore ?? q.max_score), 0);
  const classObjRate = classObjMax > 0 ? Math.round(classObjTotal / classObjMax * 100) : 0;
  const classSubjRate = classSubjMax > 0 ? Math.round(classSubjTotal / classSubjMax * 100) : 0;

  if (loading) return <div className="p-10 text-center text-sm text-muted-foreground">加载中...</div>;
  if (error) return <ErrorState description={error} />;
  if (!data) return null;

  const answerBlocks = data.answerBlocks ?? [];
  const imageItems: LightboxItem[] = answerBlocks.length > 0
    ? answerBlocks.map((block) => ({
        id: block.id,
        title: `${block.blockTitle || "大题"} · 第 ${block.pageNumber} 页`,
        subtitle: `题号 ${block.questionNumbers.join(", ")}${block.score != null && block.maxScore != null ? ` · ${block.score}/${block.maxScore}` : ""}`,
        imageUrl: block.imageUrl
      }))
    : data.scans.map((scan) => ({
        id: String(scan.recordId),
        title: `第 ${scan.pageNum} 页`,
        subtitle: "整页答题卡",
        imageUrl: `/api/scanner/grading-image/${data.cardId}/${encodeURIComponent(scan.fileName)}`
      }));

  function blockForQuestion(questionNumber: number): AnswerBlockCrop | undefined {
    return answerBlocks.find((block) => block.questionNumbers.some((item) => String(item) === String(questionNumber)));
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-6 py-3">
        <Button variant="outline" size="sm" icon={<ArrowLeft />} onClick={onBack}>
          返回成绩表
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-base font-semibold">
            {studentName} · <span className="tabular-nums">{studentNumber}</span>
          </h2>
          <span className="text-xs text-muted-foreground">{examName}</span>
        </div>
        {data.totalScore && (
          <div className="flex shrink-0 items-center gap-4 text-sm">
            <span>客观: <strong className="tabular-nums">{data.totalScore.objectiveScore}</strong></span>
            <span>主观: <strong className="tabular-nums">{data.totalScore.subjectiveScore}</strong></span>
            <span className="text-base font-bold tabular-nums text-primary">{data.totalScore.totalScore}</span>
          </div>
        )}
        <Button variant="outline" size="sm" icon={<Printer />} onClick={() => setPrintOpen(true)} disabled={!data?.totalScore}>
          打印报告单
        </Button>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 gap-5 overflow-y-auto p-6">
        {/* Left: scores */}
        <div className="min-w-0 flex-1">
          <div className="mb-4 overflow-hidden rounded-lg border border-border-subtle bg-card">
            <div className="border-b border-border-subtle px-3.5 py-2 text-sm font-medium">逐题得分</div>
            <TableWrap>
              <Table className="text-sm">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>题号</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead numeric>得分/满分</TableHead>
                    <TableHead>作答</TableHead>
                    <TableHead>班级得分率</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.questionScores.map((q, i) => {
                    const stat = cs[q.question_number];
                    const classRate = stat && stat.maxScore > 0 ? Math.round(stat.avgScore / stat.maxScore * 100) : 0;
                    const perfect = q.score >= q.max_score;
                    const zero = q.score === 0;
                    const isObj = q.score_type === "objective";
                    const rec = data.recognition?.[q.question_number];
                    const selected = rec?.selectedOptions ?? [];
                    const answerKey: string[] = isObj ? (q.answerKey ?? []) : [];
                    // 选项显示
                    let answerDisplay: string | null = null;
                    let answerClass = "text-muted-foreground";
                    if (isObj && answerKey.length > 0) {
                      if (selected.length === 0) {
                        answerDisplay = "未答";
                        answerClass = "text-muted-foreground";
                      } else {
                        answerDisplay = selected.join("");
                        const correct = q.score >= q.max_score;
                        answerClass = correct ? "text-success-foreground" : "text-destructive-fg";
                      }
                    }
                    return (
                      <TableRow
                        key={i}
                        selected={isManuallyModified(q.manually_modified)}
                        clickable={answerBlocks.length > 0}
                        onClick={() => {
                          const block = blockForQuestion(q.question_number);
                          if (block) setActiveImageId(block.id);
                        }}
                      >
                        <TableCell className="tabular-nums">{q.question_number}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {q.score_type === "objective" ? (q.mode === "multiple" ? "多选" : "单选") : "解答"}
                        </TableCell>
                        <TableCell numeric>
                          <span
                            className={cn(
                              "font-semibold",
                              perfect ? "text-success-foreground" : zero ? "text-destructive-fg" : "text-foreground",
                            )}
                          >
                            {q.score}
                          </span>
                          /{q.max_score}
                          {isManuallyModified(q.manually_modified) && (
                            <span className="ml-1 text-xs text-primary">改</span>
                          )}
                        </TableCell>
                        <TableCell className={cn("text-xs font-semibold", answerClass)}>
                          {answerDisplay ?? "—"}
                        </TableCell>
                        <TableCell>
                          {stat ? (
                            <div className="flex items-center gap-1.5">
                              <Progress
                                value={classRate}
                                tone={rateTone(classRate)}
                                size="sm"
                                className="max-w-25"
                              />
                              <span className="shrink-0 text-xs tabular-nums">
                                {stat.avgScore}/{stat.maxScore} ({classRate}%)
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableWrap>
          </div>

          {/* Class rate bars */}
          <div className="flex gap-3">
            <div className="flex-1 rounded-lg border border-border-subtle bg-card p-3">
              <div className="mb-1.5 text-xs text-secondary-foreground">
                选择题 <strong className="tabular-nums">班级均分率 {classObjRate}%</strong> ({objScores.length}题)
              </div>
              <Progress value={classObjRate} tone={rateTone(classObjRate)} />
            </div>
            {subjScores.length > 0 && (
              <div className="flex-1 rounded-lg border border-border-subtle bg-card p-3">
                <div className="mb-1.5 text-xs text-secondary-foreground">
                  解答题 <strong className="tabular-nums">班级均分率 {classSubjRate}%</strong> ({subjScores.length}题)
                </div>
                <Progress value={classSubjRate} tone={rateTone(classSubjRate)} />
              </div>
            )}
          </div>

          {/* 建议 3：跨考试成长趋势 */}
          <StudentTrendBlock studentId={studentId} />
        </div>

        {/* Right: card images */}
        <div className="flex max-h-[calc(100vh-140px)] w-85 shrink-0 flex-col rounded-lg border border-border-subtle bg-card">
          <div className="shrink-0 border-b border-border-subtle px-3 py-2 text-xs font-medium">
            {answerBlocks.length > 0 ? "大题作答图片" : "答题卡"}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            {imageItems.length > 0 ? (
              imageItems.map((item, idx) => (
                <button
                  key={`${item.id}-${idx}`}
                  type="button"
                  onClick={() => { setActiveImageId(item.id); setEnlargeIdx(idx); }}
                  className="block w-full cursor-zoom-in border-0 bg-transparent p-0 text-left outline-none focus-visible:shadow-focus"
                >
                  <div
                    className={cn(
                      "mb-1 text-xs",
                      item.id === activeImageId ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {item.title} · {item.subtitle}
                  </div>
                  <img
                    src={item.imageUrl}
                    alt={item.title}
                    className={cn(
                      "block w-full rounded-xs border",
                      item.id === activeImageId ? "border-primary" : "border-border-subtle",
                    )}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                </button>
              ))
            ) : (
              <EmptyState size="sm" icon={<ImageOff />} title="暂无扫描" />
            )}
          </div>
        </div>
      </div>

      {/* 放大答题卡（O-6：Dialog + bg-overlay + v2 缩放/翻页） */}
      <AnswerCardLightbox
        items={imageItems}
        index={enlargeIdx}
        zoom={zoom}
        onIndexChange={setEnlargeIdx}
        onZoomChange={setZoomState}
        onClose={() => setEnlargeIdx(-1)}
      />

      {/* 建议 13：成绩报告单（打印 / 另存为 PDF） */}
      {printOpen && data?.totalScore && (
        <StudentReportPrint
          examId={examId}
          studentId={studentId}
          studentName={studentName}
          studentNumber={studentNumber}
          examName={examName}
          totalScore={data.totalScore.totalScore}
          objectiveScore={data.totalScore.objectiveScore}
          subjectiveScore={data.totalScore.subjectiveScore}
          onClose={() => setPrintOpen(false)}
        />
      )}
    </div>
  );
}
