import { useEffect, useState } from "react";
import { ArrowLeft, ImageOff, Pencil, Save, Search } from "lucide-react";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import { isManuallyModified } from "../util/score";
import {
  Button,
  EmptyState,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
  type SegmentedItem,
} from "./ui/v2";
import { AnswerCardLightbox, type LightboxItem } from "./AnswerCardLightbox";
import type { AnswerBlockCrop } from "../../../../shared/types";

/**
 * ScoreFixPage —— T2 迁移（T04 明细/订正/弹窗）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · 放大答题卡：手写 Portal + 手写 ESC + 魔法 z 层级 → `AnswerCardLightbox`（O-6）
 *  · 双模式切换：手写 div 拼色 → v2 `SegmentedControl`
 *  · 旧按钮工具类 / 满屏行内 style → v2 `Button`/`Input`/`Select`/`Table` + 语义类
 *  · 「已手动修改」判定统一走 `isManuallyModified()`（O-2，兼容 boolean 与 0/1）
 */

interface Props {
  examId: number;
  examName: string;
  subject: string | null;
  onBack: () => void;
}

type FixMode = "score" | "answer";

interface StudentScore {
  student: { id: number; name: string; studentNumber: string };
  totalScore: { objectiveScore: number; subjectiveScore: number; totalScore: number; assignedScore: number | null; manuallyModified: boolean } | null;
  questionScores: Array<{
    id: number; question_number: number; score_type: string; score: number; max_score: number;
    mode: string; optionCount: number; answerKey: string[]; scoringRule: any; step: number; blockType: string;
    manually_modified: number; modified_at: string | null;
  }>;
  recognition: Record<number, { selectedOptions: string[]; confidence: number }>;
  scans: Array<{ recordId: number; fileName: string; pageNum: number }>;
  answerBlocks: AnswerBlockCrop[];
  cardId: string;
}

interface CardAnswer {
  questionNumber: number;
  questionType: string;
  mode?: string;
  optionCount?: number;
  score: number;
  answerKey?: string[];
  scoringRule?: any;
}

interface StudentHit {
  id: number;
  name: string;
  studentNumber: string;
}

const OPTION_LABELS = ["A","B","C","D","E","F","G","H","I","J"];

const FIX_MODE_ITEMS: readonly SegmentedItem<FixMode>[] = [
  { value: "score", label: "个别改分" },
  { value: "answer", label: "修改答案" },
];

export function ScoreFixPage({ examId, examName, onBack }: Props) {
  // Mode selection first
  const [fixMode, setFixMode] = useState<FixMode | null>(null);

  // Score mode
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [searchMsg, setSearchMsg] = useState("");
  const [student, setStudent] = useState<StudentScore | null>(null);
  const [loadingStudent, setLoadingStudent] = useState(false);
  const [scoreEdits, setScoreEdits] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Answer mode
  const [cardAnswers, setCardAnswers] = useState<CardAnswer[]>([]);
  const [answerEdits, setAnswerEdits] = useState<Record<string, string[]>>({});
  const [loadingAnswers, setLoadingAnswers] = useState(false);

  // Preview
  const [previewPages, setPreviewPages] = useState<Array<{ recordId: number; fileName: string; pageNum: number }>>([]);
  const [enlargeIdx, setEnlargeIdx] = useState(-1); // -1 = closed, >=0 = active page index
  const [zoom, setZoomState] = useState(1);
  const [activeImageId, setActiveImageId] = useState("");

  // Load answers when entering answer mode
  useEffect(() => {
    if (fixMode === "answer" && cardAnswers.length === 0) {
      setLoadingAnswers(true);
      setSaveMsg("");
      fetchJson<{ questions: CardAnswer[]; cardId: string }>(`/api/exams/${examId}/answers`)
        .then((data) => {
          setCardAnswers(data.questions);
          setAnswerEdits({});
        })
        .catch((err) => setSaveMsg(err instanceof Error ? err.message : "加载答案失败"))
        .finally(() => setLoadingAnswers(false));
    }
  }, [fixMode, examId]);

  async function searchStudent() {
    if (!search.trim()) return;
    setSearchMsg("");
    setHits([]);
    setStudent(null);

    try {
      const data = await fetchJson<StudentHit[]>(
        `/api/exams/${examId}/students/search?q=${encodeURIComponent(search.trim())}`
      );
      setHits(data);
      if (data.length === 0) setSearchMsg("未找到该学生，请检查考号或姓名");
    } catch (err) {
      setSearchMsg(err instanceof Error ? err.message : "搜索失败");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") searchStudent();
  }

  async function loadStudent(sid: number, sname: string, snum: string) {
    setLoadingStudent(true);
    setSearchMsg("");
    setScoreEdits({});
    setEnlargeIdx(-1);
    setZoomState(1);
    try {
      const data = await fetchJson<StudentScore>(`/api/exams/${examId}/student/${sid}/scores`);
      // Ensure student info matches the hit
      data.student = { id: sid, name: sname, studentNumber: snum };
      setStudent(data);
      setPreviewPages(data.scans);
      setActiveImageId(data.answerBlocks?.[0]?.id ?? "");
    } catch (err) {
      setSearchMsg(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoadingStudent(false);
    }
  }

  function setScoreEdit(qNum: number, scoreType: string, val: number) {
    setScoreEdits((prev) => ({ ...prev, [`${qNum}_${scoreType}`]: val }));
  }

  function getScoreEdit(qNum: number, scoreType: string, defaultScore: number): number {
    const key = `${qNum}_${scoreType}`;
    return key in scoreEdits ? scoreEdits[key] : defaultScore;
  }

  async function saveScoreEdits() {
    if (!student) return;
    const updates = Object.entries(scoreEdits).map(([key, score]) => {
      const [qNum, scoreType] = key.split("_");
      return { questionNumber: Number(qNum), scoreType, score };
    });
    if (updates.length === 0) { setSaveMsg("没有修改"); return; }

    setSaving(true);
    setSaveMsg("");
    try {
      await fetchJson(`/api/exams/${examId}/student/${student.student.id}/scores`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scores: updates })
      });
      setSaveMsg("保存成功！已自动更新排名");
      setScoreEdits({});
      const data = await fetchJson<StudentScore>(`/api/exams/${examId}/student/${student.student.id}/scores`);
      data.student = student.student;
      setStudent(data);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function toggleOption(qNum: number, opt: string, isMulti: boolean) {
    setAnswerEdits((prev) => {
      const key = String(qNum);
      const current = [...(prev[key] ?? [])];
      if (!isMulti) return { ...prev, [key]: [opt] };
      const idx = current.indexOf(opt);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(opt);
      return { ...prev, [key]: current };
    });
  }

  function getAnswerEdit(qNum: number, defaultKey: string[]): string[] {
    return answerEdits[String(qNum)] ?? defaultKey;
  }

  function initFromCard(qNum: number, answerKey: string[]) {
    if (String(qNum) in answerEdits) return;
    setAnswerEdits((prev) => ({ ...prev, [String(qNum)]: [...answerKey] }));
  }

  async function saveAnswerEdits() {
    if (Object.keys(answerEdits).length === 0) { setSaveMsg("没有修改答案"); return; }
    setSaving(true);
    setSaveMsg("");
    try {
      const resp = await fetchJson<{ ok: boolean; updatedCount: number }>(`/api/exams/${examId}/answers`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: answerEdits })
      });
      setSaveMsg(`已重算 ${resp.updatedCount} 名学生的成绩！`);
      setAnswerEdits({});
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  // ======== RENDER ========

  const scorePreviewItems: LightboxItem[] = student
    ? (student.answerBlocks?.length > 0
        ? student.answerBlocks.map((block) => ({
            id: block.id,
            title: `${block.blockTitle || "大题"} · 第 ${block.pageNumber} 页`,
            subtitle: `题号 ${block.questionNumbers.join(", ")}${block.score != null && block.maxScore != null ? ` · ${block.score}/${block.maxScore}` : ""}`,
            imageUrl: block.imageUrl
          }))
        : previewPages.map((page) => ({
            id: String(page.recordId),
            title: `第 ${page.pageNum} 页`,
            subtitle: "整页答题卡",
            imageUrl: `/api/scanner/grading-image/${student.cardId}/${encodeURIComponent(page.fileName)}`
          })))
    : [];

  function scoreBlockForQuestion(questionNumber: number): AnswerBlockCrop | undefined {
    return student?.answerBlocks?.find((block) => block.questionNumbers.some((item) => String(item) === String(questionNumber)));
  }

  const saveMsgClass = saveMsg.includes("成功")
    ? "text-success-foreground"
    : "text-destructive-fg";

  // Mode selection screen
  if (!fixMode) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-6 py-3">
          <Button variant="outline" size="sm" icon={<ArrowLeft />} onClick={onBack}>
            返回成绩
          </Button>
          <h2 className="m-0 text-base font-semibold">成绩修改 — {examName}</h2>
        </div>
        <div className="flex flex-1 items-center justify-center gap-6">
          <ModeCard
            icon={<Pencil className="size-9 text-primary" />}
            title="个别改分"
            description="搜索学生 → 逐题修改分数"
            onClick={() => setFixMode("score")}
          />
          <ModeCard
            icon={<Save className="size-9 text-primary" />}
            title="修改答案"
            description="修改正确答案 → 自动重算全部分数"
            onClick={() => setFixMode("answer")}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-6 py-3">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="返回"
          title="返回"
          onClick={() => {
            if (student) { setStudent(null); setHits([]); setSearch(""); setSearchMsg(""); setScoreEdits({}); }
            else { setFixMode(null); }
          }}
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-base font-semibold">成绩修改 — {examName}</h2>
        </div>
        <SegmentedControl
          size="sm"
          aria-label="修改方式"
          value={fixMode}
          items={FIX_MODE_ITEMS}
          onValueChange={(next) => {
            if (next === "score") { setFixMode("score"); setStudent(null); setHits([]); setSearch(""); }
            else { setFixMode("answer"); }
          }}
        />
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        {/* ============== SCORE MODE ============== */}
        {fixMode === "score" && (
          <>
            <div className="flex items-center gap-2">
              <div className="relative w-full max-w-90">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入考号或姓名搜索..."
                  aria-label="搜索学生"
                  className="h-control-sm pl-9 text-sm"
                />
              </div>
              <Button variant="primary" size="sm" icon={<Search />} onClick={searchStudent} loading={loadingStudent}>
                搜索
              </Button>
            </div>

            {searchMsg && (
              <div className={cn("text-sm", searchMsg.includes("未找到") ? "text-muted-foreground" : "text-destructive-fg")}>
                {searchMsg}
              </div>
            )}

            {/* Search results */}
            {hits.length > 0 && !student && (
              <div className="flex flex-col gap-1">
                {hits.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => loadStudent(h.id, h.name, h.studentNumber)}
                    className={cn(
                      "flex items-center gap-3 rounded-md border border-border bg-card px-3.5 py-2 text-left text-sm",
                      "transition-colors duration-(--px-dur-1) ease-standard",
                      "hover:border-border-strong hover:bg-secondary",
                      "outline-none focus-visible:shadow-focus",
                    )}
                  >
                    <span className="font-medium">{h.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">考号 {h.studentNumber}</span>
                  </button>
                ))}
              </div>
            )}

            {loadingStudent && (
              <div className="p-10 text-center text-sm text-muted-foreground">加载学生数据...</div>
            )}

            {student && (
              <div className="flex min-h-0 flex-1 gap-5">
                {/* Left: card image — scrolls vertically */}
                <div className="flex w-90 shrink-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-card">
                  <div className="shrink-0 border-b border-border-subtle px-3 py-2 text-xs font-medium">
                    答题卡 — {student.student.name}
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                    {scorePreviewItems.length > 0 ? (
                      scorePreviewItems.map((item, idx) => (
                        <button
                          key={`${item.id}-${idx}`}
                          type="button"
                          className="block w-full cursor-zoom-in border-0 bg-transparent p-0 text-left outline-none focus-visible:shadow-focus"
                          onClick={() => { setActiveImageId(item.id); setEnlargeIdx(idx); }}
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
                      <EmptyState size="sm" icon={<ImageOff />} title="暂无扫描图片" />
                    )}
                  </div>
                </div>

                {/* Right: scores */}
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-subtle bg-card">
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-3 py-2 text-xs font-medium">
                    <span className="min-w-0 truncate">
                      {student.student.name} · <span className="tabular-nums">{student.student.studentNumber}</span>
                      {isManuallyModified(student.totalScore?.manuallyModified) && (
                        <span className="ml-2 text-xs text-primary">(已手动修改)</span>
                      )}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      {saveMsg && <span className={cn("text-xs", saveMsgClass)}>{saveMsg}</span>}
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<Save />}
                        onClick={saveScoreEdits}
                        loading={saving}
                        disabled={Object.keys(scoreEdits).length === 0}
                      >
                        保存修改
                      </Button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {student.totalScore && (
                      <div className="mb-3 flex flex-wrap gap-4 text-sm">
                        <span>客观题: <strong className="tabular-nums">{student.totalScore.objectiveScore}</strong></span>
                        <span>主观题: <strong className="tabular-nums">{student.totalScore.subjectiveScore}</strong></span>
                        <span>总分: <strong className="tabular-nums">{student.totalScore.totalScore}</strong></span>
                        {student.totalScore.assignedScore != null && (
                          <span>赋分: <strong className="tabular-nums">{student.totalScore.assignedScore}</strong></span>
                        )}
                      </div>
                    )}
                    <TableWrap>
                      <Table className="text-sm">
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead>题号</TableHead>
                            <TableHead>类型</TableHead>
                            <TableHead numeric>得分/满分</TableHead>
                            <TableHead>识别</TableHead>
                            <TableHead>修改</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {student.questionScores.map((qs, i) => {
                            const isObj = qs.score_type === "objective";
                            const rec = student.recognition[qs.question_number];
                            const cur = getScoreEdit(qs.question_number, qs.score_type, qs.score);
                            const modified = `${qs.question_number}_${qs.score_type}` in scoreEdits;
                            const clickable = student.answerBlocks?.length > 0;
                            return (
                              <TableRow
                                key={i}
                                selected={modified}
                                clickable={clickable}
                                onClick={() => {
                                  const block = scoreBlockForQuestion(qs.question_number);
                                  if (block) setActiveImageId(block.id);
                                }}
                              >
                                <TableCell className="font-medium tabular-nums">{qs.question_number}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {isObj ? (qs.mode === "multiple" ? "多选" : qs.mode === "indeterminate" ? "不定" : "单选") : "解答"}
                                </TableCell>
                                <TableCell numeric>
                                  <span
                                    className={cn(
                                      isManuallyModified(qs.manually_modified) && "font-semibold",
                                      modified && "text-primary",
                                    )}
                                  >
                                    {cur}
                                  </span>
                                  /{qs.max_score}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {rec ? rec.selectedOptions.join(",") : "—"}
                                </TableCell>
                                <TableCell onClick={(e) => e.stopPropagation()}>
                                  {isObj ? (() => {
                                    const step = qs.step || qs.max_score;
                                    const options: number[] = qs.mode === "single" || !qs.mode ? [0, qs.max_score] : [];
                                    if (qs.mode !== "single" && qs.mode) {
                                      const steps = Math.round(qs.max_score / step);
                                      for (let s = 0; s <= steps; s++) options.push(Math.round(s * step * 10) / 10);
                                    }
                                    return (
                                      <Select
                                        value={String(cur)}
                                        onValueChange={(v) => setScoreEdit(qs.question_number, qs.score_type, Number(v))}
                                      >
                                        <SelectTrigger
                                          className="h-control-sm w-24 text-sm tabular-nums"
                                          aria-label={`第 ${qs.question_number} 题得分`}
                                        >
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {options.map((v) => (
                                            <SelectItem key={v} value={String(v)}>{v}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    );
                                  })() : (
                                    <Input
                                      type="number"
                                      min={0}
                                      max={qs.max_score}
                                      step={0.5}
                                      value={cur}
                                      aria-label={`第 ${qs.question_number} 题得分`}
                                      onChange={(e) => setScoreEdit(qs.question_number, qs.score_type, Number(e.target.value))}
                                      className="h-control-sm w-20 text-sm tabular-nums"
                                    />
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </TableWrap>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ============== ANSWER MODE ============== */}
        {fixMode === "answer" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-subtle bg-card">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-3 py-2 text-xs font-medium">
              <span>标准答案编辑</span>
              <div className="flex shrink-0 items-center gap-2">
                {saveMsg && <span className={cn("text-xs", saveMsgClass)}>{saveMsg}</span>}
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Save />}
                  onClick={saveAnswerEdits}
                  loading={saving}
                  disabled={Object.keys(answerEdits).length === 0}
                >
                  {saving ? "重算中..." : "保存并重算"}
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {loadingAnswers ? (
                <div className="p-10 text-center text-sm text-muted-foreground">加载答案...</div>
              ) : (
                <div className="flex flex-col gap-3">
                  {cardAnswers.filter((q) => q.questionType === "objective").map((q) => {
                    const cur = getAnswerEdit(q.questionNumber, q.answerKey ?? []);
                    const isMulti = q.mode === "multiple" || q.mode === "indeterminate";
                    const changed = String(q.questionNumber) in answerEdits;
                    return (
                      <div
                        key={q.questionNumber}
                        className={cn(
                          "flex items-center gap-3 rounded-md border px-3 py-2.5",
                          changed ? "border-accent-border bg-accent" : "border-border-subtle bg-secondary",
                        )}
                      >
                        <div className="min-w-12 text-sm font-medium">第{q.questionNumber}题</div>
                        <div className="min-w-15 text-xs text-muted-foreground">
                          {isMulti ? "多选" : "单选"} · {q.optionCount}选项 · {q.score}分
                        </div>
                        <div className="flex flex-1 gap-1">
                          {OPTION_LABELS.slice(0, q.optionCount ?? 4).map((opt) => {
                            const sel = cur.includes(opt);
                            return (
                              <button
                                key={opt}
                                type="button"
                                aria-pressed={sel}
                                onClick={() => {
                                  if (!(String(q.questionNumber) in answerEdits)) initFromCard(q.questionNumber, q.answerKey ?? []);
                                  toggleOption(q.questionNumber, opt, isMulti);
                                }}
                                className={cn(
                                  "size-9 rounded-sm border-2 text-sm font-semibold",
                                  "transition-colors duration-(--px-dur-1) ease-standard",
                                  "outline-none focus-visible:shadow-focus",
                                  sel
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-border bg-card text-foreground hover:border-border-strong hover:bg-secondary",
                                )}
                              >
                                {opt}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {cardAnswers.filter((q) => q.questionType === "subjective").length > 0 && (
                    <div className="p-2 text-xs text-muted-foreground">主观题答案请在「个别改分」模式手动输入。</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 放大答题卡（O-6：Dialog + bg-overlay + v2 缩放/翻页） */}
      <AnswerCardLightbox
        items={scorePreviewItems}
        index={enlargeIdx}
        zoom={zoom}
        onIndexChange={setEnlargeIdx}
        onZoomChange={setZoomState}
        onClose={() => setEnlargeIdx(-1)}
      />
    </div>
  );
}

interface ModeCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}

/** 入口大按钮：hover 走类名，替代原来的 onMouseEnter/Leave 手改内联样式 */
function ModeCard({ icon, title, description, onClick }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-40 w-60 cursor-pointer flex-col items-center justify-center gap-3",
        "rounded-lg border-2 border-border bg-card",
        "transition-[border-color,box-shadow] duration-(--px-dur-2) ease-standard",
        "hover:border-primary hover:shadow-accent",
        "outline-none focus-visible:shadow-focus",
      )}
    >
      {icon}
      <div className="text-base font-semibold">{title}</div>
      <div className="px-3 text-center text-xs text-muted-foreground">{description}</div>
    </button>
  );
}
