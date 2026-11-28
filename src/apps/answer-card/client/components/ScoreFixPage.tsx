import { CardCorrectionButton } from "./CardCorrectionEditor";
import { useEffect, useState } from "react";
import { ArrowLeft, ImageOff, ListChecks, Pencil, Save, Search } from "lucide-react";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import { isManuallyModified } from "../util/score";
import { isMultiSelectMode, objectiveModeLabel } from "../../../../shared/objectiveMode";
import { isLegalObjectiveScore, objectiveScoreCandidates } from "../../../../shared/grading";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  ControlRow,
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
  initialStudent?: StudentHit;
  onBack: () => void;
}

type FixMode = "score" | "answer" | "batch";
type SaveState = { status: "idle" | "success" | "error"; message: string };

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

interface BatchOperation {
  questionNumber: number;
  scoreType: "objective" | "subjective";
  operation: "full" | "add";
  amount?: number;
}

interface BatchPreviewRow {
  studentId: number;
  studentName: string;
  questionNumber: number;
  scoreType: "objective" | "subjective";
  operation: "full" | "add";
  amount?: number;
  currentScore: number;
  maxScore: number;
  targetScore: number;
  legal: boolean;
}

interface PendingConfirmation {
  action: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  tone: "danger" | "default";
}

const OPTION_LABELS = ["A","B","C","D","E","F","G","H","I","J"];

const FIX_MODE_ITEMS: readonly SegmentedItem<FixMode>[] = [
  { value: "score", label: "个别改分" },
  { value: "answer", label: "修改答案" },
  { value: "batch", label: "批量送分/加分" },
];

const EMPTY_SAVE_STATE: SaveState = { status: "idle", message: "" };

function sameOptions(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((option, index) => option === b[index]);
}

function parseScoreDraft(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const score = Number(normalized);
  return Number.isFinite(score) ? score : null;
}

function roundClientScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function ScoreFixPage({ examId, examName, initialStudent, onBack }: Props) {
  // Mode selection first
  const [fixMode, setFixMode] = useState<FixMode | null>(initialStudent ? "score" : null);

  // Score mode
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [searchMsg, setSearchMsg] = useState("");
  const [student, setStudent] = useState<StudentScore | null>(null);
  const [loadingStudent, setLoadingStudent] = useState(false);
  const [scoreEdits, setScoreEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(EMPTY_SAVE_STATE);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);

  // Answer mode
  const [cardAnswers, setCardAnswers] = useState<CardAnswer[]>([]);
  const [answerEdits, setAnswerEdits] = useState<Record<string, string[]>>({});
  const [loadingAnswers, setLoadingAnswers] = useState(false);

  // Batch mode
  const [batchSelectedIds, setBatchSelectedIds] = useState<number[]>([]);
  const [batchStudents, setBatchStudents] = useState<Record<number, StudentHit>>({});
  const [batchDetails, setBatchDetails] = useState<Record<number, StudentScore>>({});
  const [batchOps, setBatchOps] = useState<Record<string, { operation: "full" | "add"; amount: string }>>({});
  const [batchPreview, setBatchPreview] = useState<BatchPreviewRow[] | null>(null);
  const [loadingBatch, setLoadingBatch] = useState(false);

  // Preview
  const [previewPages, setPreviewPages] = useState<Array<{ recordId: number; fileName: string; pageNum: number }>>([]);
  const [enlargeIdx, setEnlargeIdx] = useState(-1); // -1 = closed, >=0 = active page index
  const [zoom, setZoomState] = useState(1);
  const [activeImageId, setActiveImageId] = useState("");

  const hasScoreDraft = Object.entries(scoreEdits).some(([key, value]) => {
    if (value.trim() === "") return true;
    const question = student?.questionScores.find((item) => `${item.question_number}_${item.score_type}` === key);
    return !question || Number(value) !== Number(question.score);
  });
  const hasAnswerDraft = cardAnswers.some((question) => {
    const draft = answerEdits[String(question.questionNumber)];
    return draft != null && !sameOptions(draft, question.answerKey ?? []);
  });
  const hasBatchDraft = batchSelectedIds.length > 0 || Object.keys(batchOps).length > 0;
  const hasUnsavedChanges = fixMode === "score"
    ? hasScoreDraft
    : fixMode === "answer" ? hasAnswerDraft : fixMode === "batch" && hasBatchDraft;

  // Load answers when entering answer mode
  useEffect(() => {
    if (fixMode === "answer" && cardAnswers.length === 0) {
      setLoadingAnswers(true);
      setSaveState(EMPTY_SAVE_STATE);
      fetchJson<{ questions: CardAnswer[]; cardId: string }>(`/api/exams/${examId}/answers`)
        .then((data) => {
          setCardAnswers(data.questions);
          setAnswerEdits({});
        })
        .catch((err) => setSaveState({ status: "error", message: err instanceof Error ? err.message : "加载答案失败" }))
        .finally(() => setLoadingAnswers(false));
    }
  }, [fixMode, examId]);

  useEffect(() => {
    if (!initialStudent) return;
    void loadStudent(initialStudent.id, initialStudent.name, initialStudent.studentNumber);
  }, [initialStudent?.id]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    setBatchPreview(null);
  }, [batchSelectedIds, batchOps]);

  function guardUnsaved(action: () => void) {
    if (hasUnsavedChanges) {
      setPendingConfirmation({
        action,
        title: "放弃未保存的修改？",
        description: "当前成绩、答案或批量操作草稿尚未保存，继续后将丢失这些修改。",
        confirmLabel: "放弃并继续",
        tone: "danger"
      });
      return;
    }
    action();
  }

  function clearModeDrafts() {
    setScoreEdits({});
    setAnswerEdits({});
    setBatchSelectedIds([]);
    setBatchStudents({});
    setBatchDetails({});
    setBatchOps({});
    setBatchPreview(null);
    setSaveState(EMPTY_SAVE_STATE);
  }

  function requestModeChange(next: FixMode) {
    if (next === fixMode) return;
    guardUnsaved(() => {
      clearModeDrafts();
      setStudent(null);
      setHits([]);
      setSearch("");
      setSearchMsg("");
      setFixMode(next);
    });
  }

  function handleHeaderBack() {
    guardUnsaved(() => {
      if (fixMode === "score" && student) {
        setStudent(null);
        setHits([]);
        setSearch("");
        setSearchMsg("");
        setScoreEdits({});
        setSaveState(EMPTY_SAVE_STATE);
        return;
      }
      clearModeDrafts();
      setStudent(null);
      setHits([]);
      setSearch("");
      setSearchMsg("");
      setFixMode(null);
    });
  }

  function searchStudent() {
    if (!search.trim()) return;
    const runSearch = async () => {
      setSearchMsg("");
      setHits([]);
      setStudent(null);
      setScoreEdits({});
      setSaveState(EMPTY_SAVE_STATE);

      try {
        const data = await fetchJson<StudentHit[]>(
          `/api/exams/${examId}/students/search?q=${encodeURIComponent(search.trim())}`
        );
        setHits(data);
        if (data.length === 0) setSearchMsg("未找到该学生，请检查考号或姓名");
      } catch (err) {
        setSearchMsg(err instanceof Error ? err.message : "搜索失败");
      }
    };
    if (student) guardUnsaved(() => { void runSearch(); });
    else void runSearch();
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

  function setScoreEdit(qNum: number, scoreType: string, val: string) {
    setScoreEdits((prev) => ({ ...prev, [`${qNum}_${scoreType}`]: val }));
    setSaveState(EMPTY_SAVE_STATE);
  }

  function getScoreEdit(qNum: number, scoreType: string, defaultScore: number): string {
    const key = `${qNum}_${scoreType}`;
    return key in scoreEdits ? scoreEdits[key] : String(defaultScore);
  }

  async function saveScoreEdits() {
    if (!student) return;
    const updates: Array<{ questionNumber: number; scoreType: string; score: number }> = [];
    for (const [key, draft] of Object.entries(scoreEdits)) {
      const [qNum, scoreType] = key.split("_");
      const question = student.questionScores.find((item) => `${item.question_number}_${item.score_type}` === key);
      const score = parseScoreDraft(draft);
      if (!question || score == null) {
        setSaveState({ status: "error", message: `第 ${qNum} 题请输入有效的 0 至两位小数` });
        return;
      }
      if (score < 0 || score > question.max_score) {
        setSaveState({ status: "error", message: `第 ${qNum} 题分数需在 [0, ${question.max_score}] 范围内` });
        return;
      }
      if (question.score_type === "objective" &&
          !isLegalObjectiveScore(score, question.max_score, question.step || question.max_score, question.mode === "single" ? "single" : "multiple")) {
        const candidates = objectiveScoreCandidates(question.max_score, question.step || question.max_score, question.mode === "single" ? "single" : "multiple");
        setSaveState({ status: "error", message: `第 ${qNum} 题合法分值为 ${candidates.join("、")}` });
        return;
      }
      updates.push({ questionNumber: Number(qNum), scoreType, score });
    }
    if (updates.length === 0) {
      setSaveState({ status: "error", message: "没有需要保存的修改" });
      return;
    }

    setSaving(true);
    setSaveState(EMPTY_SAVE_STATE);
    try {
      await fetchJson(`/api/exams/${examId}/student/${student.student.id}/scores`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scores: updates })
      });
      let data: StudentScore;
      try {
        data = await fetchJson<StudentScore>(`/api/exams/${examId}/student/${student.student.id}/scores`);
      } catch (refreshError) {
        setSaveState({
          status: "error",
          message: `成绩已保存，但界面刷新失败：${refreshError instanceof Error ? refreshError.message : "请稍后重试"}`
        });
        return;
      }
      data.student = student.student;
      setStudent(data);
      setScoreEdits({});
      setSaveState({ status: "success", message: "保存成功，排名与详情已刷新" });
    } catch (err) {
      setSaveState({ status: "error", message: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  function toggleOption(qNum: number, opt: string, isMulti: boolean) {
    setSaveState(EMPTY_SAVE_STATE);
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
    const changedAnswers: Record<string, string[]> = {};
    for (const question of cardAnswers) {
      if (question.questionType !== "objective") continue;
      const draft = answerEdits[String(question.questionNumber)];
      if (draft != null && !sameOptions(draft, question.answerKey ?? [])) {
        changedAnswers[String(question.questionNumber)] = draft;
      }
    }
    if (Object.keys(changedAnswers).length === 0) {
      setSaveState({ status: "error", message: "没有需要保存的答案修改" });
      return;
    }
    setSaving(true);
    setSaveState(EMPTY_SAVE_STATE);
    try {
      const resp = await fetchJson<{ ok: boolean; updatedCount: number }>(`/api/exams/${examId}/answers`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: changedAnswers })
      });
      let refreshed: { questions: CardAnswer[]; cardId: string };
      try {
        refreshed = await fetchJson<{ questions: CardAnswer[]; cardId: string }>(`/api/exams/${examId}/answers`);
      } catch (refreshError) {
        setSaveState({
          status: "error",
          message: `答案已保存并重算 ${resp.updatedCount} 名学生，但界面刷新失败：${refreshError instanceof Error ? refreshError.message : "请稍后重试"}`
        });
        return;
      }
      setCardAnswers(refreshed.questions);
      setAnswerEdits({});
      setSaveState({ status: "success", message: `答案已保存，已重算 ${resp.updatedCount} 名学生并刷新` });
    } catch (err) {
      setSaveState({ status: "error", message: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  function toggleBatchStudent(hit: StudentHit) {
    setBatchSelectedIds((previous) => previous.includes(hit.id)
      ? previous.filter((id) => id !== hit.id)
      : [...previous, hit.id]);
    setBatchStudents((previous) => ({ ...previous, [hit.id]: hit }));
    setSaveState(EMPTY_SAVE_STATE);
  }

  function setBatchOperation(key: string, operation: "none" | "full" | "add") {
    setBatchOps((previous) => {
      if (operation === "none") {
        const next = { ...previous };
        delete next[key];
        return next;
      }
      return { ...previous, [key]: { operation, amount: previous[key]?.amount ?? "1" } };
    });
    setSaveState(EMPTY_SAVE_STATE);
  }

  function setBatchAmount(key: string, amount: string) {
    setBatchOps((previous) => previous[key]
      ? { ...previous, [key]: { ...previous[key], amount } }
      : previous);
    setSaveState(EMPTY_SAVE_STATE);
  }

  function validatedBatchOperations(): BatchOperation[] | null {
    const operations: BatchOperation[] = [];
    for (const [key, draft] of Object.entries(batchOps)) {
      const [questionNumberRaw, scoreTypeRaw] = key.split("_");
      if (scoreTypeRaw !== "objective" && scoreTypeRaw !== "subjective") return null;
      if (draft.operation === "add") {
        const amount = parseScoreDraft(draft.amount);
        if (amount == null || amount <= 0) {
          setSaveState({ status: "error", message: `第 ${questionNumberRaw} 题加分值必须为正数且最多两位小数` });
          return null;
        }
        operations.push({ questionNumber: Number(questionNumberRaw), scoreType: scoreTypeRaw, operation: "add", amount });
      } else {
        operations.push({ questionNumber: Number(questionNumberRaw), scoreType: scoreTypeRaw, operation: "full" });
      }
    }
    if (operations.length === 0) {
      setSaveState({ status: "error", message: "请至少为一道题选择送分或加分操作" });
      return null;
    }
    return operations;
  }

  async function loadBatchQuestions() {
    if (batchSelectedIds.length === 0) {
      setSaveState({ status: "error", message: "请先选择学生" });
      return;
    }
    setLoadingBatch(true);
    setSaveState(EMPTY_SAVE_STATE);
    try {
      const entries = await Promise.all(batchSelectedIds.map(async (id) => {
        const data = await fetchJson<StudentScore>(`/api/exams/${examId}/student/${id}/scores`);
        const hit = batchStudents[id];
        if (hit) data.student = { id: hit.id, name: hit.name, studentNumber: hit.studentNumber };
        return [id, data] as const;
      }));
      setBatchDetails(Object.fromEntries(entries) as Record<number, StudentScore>);
    } catch (err) {
      setSaveState({ status: "error", message: err instanceof Error ? err.message : "加载题目失败" });
    } finally {
      setLoadingBatch(false);
    }
  }

  async function generateBatchPreview() {
    if (batchSelectedIds.length === 0) {
      setSaveState({ status: "error", message: "请先选择学生" });
      return;
    }
    const operations = validatedBatchOperations();
    if (!operations) return;
    setLoadingBatch(true);
    setSaveState(EMPTY_SAVE_STATE);
    try {
      const entries = await Promise.all(batchSelectedIds.map(async (id) => {
        const data = await fetchJson<StudentScore>(`/api/exams/${examId}/student/${id}/scores`);
        const hit = batchStudents[id];
        if (hit) data.student = { id: hit.id, name: hit.name, studentNumber: hit.studentNumber };
        return [id, data] as const;
      }));
      const details = Object.fromEntries(entries) as Record<number, StudentScore>;
      setBatchDetails(details);
      const rows: BatchPreviewRow[] = [];
      for (const [id, data] of entries) {
        for (const operation of operations) {
          const question = data.questionScores.find((item) =>
            item.question_number === operation.questionNumber && item.score_type === operation.scoreType);
          if (!question) {
            setSaveState({ status: "error", message: `${data.student.name} 缺少第 ${operation.questionNumber} 题成绩，无法预览` });
            setBatchPreview(null);
            return;
          }
          const currentScore = Number(question.score);
          const maxScore = Number(question.max_score);
          const targetScore = operation.operation === "full"
            ? maxScore
            : roundClientScore(Math.min(maxScore, currentScore + operation.amount!));
          const legal = Number.isFinite(currentScore) && Number.isFinite(maxScore) &&
            currentScore >= 0 && maxScore >= 0 && currentScore <= maxScore && targetScore >= 0 && targetScore <= maxScore &&
            (operation.scoreType !== "objective" || isLegalObjectiveScore(
              targetScore, maxScore, question.step || maxScore, question.mode === "single" ? "single" : "multiple"
            ));
          rows.push({
            studentId: id,
            studentName: data.student.name,
            questionNumber: operation.questionNumber,
            scoreType: operation.scoreType,
            operation: operation.operation,
            ...(operation.amount != null ? { amount: operation.amount } : {}),
            currentScore,
            maxScore,
            targetScore,
            legal
          });
        }
      }
      setBatchPreview(rows);
    } catch (err) {
      setBatchPreview(null);
      setSaveState({ status: "error", message: err instanceof Error ? err.message : "加载预览失败" });
    } finally {
      setLoadingBatch(false);
    }
  }

  async function submitBatchScores() {
    const operations = validatedBatchOperations();
    if (!operations || !batchPreview || batchPreview.some((row) => !row.legal)) return;
    setSaving(true);
    setSaveState(EMPTY_SAVE_STATE);
    try {
      const result = await fetchJson<{ updatedCount: number; updatedStudents: number }>(`/api/exams/${examId}/scores/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds: batchSelectedIds, scores: operations })
      });
      setBatchSelectedIds([]);
      setBatchStudents({});
      setBatchDetails({});
      setBatchOps({});
      setBatchPreview(null);
      setHits([]);
      setSearch("");
      setSaveState({
        status: "success",
        message: `批量保存成功：${result.updatedStudents} 名学生，${result.updatedCount} 道题已更新`
      });
    } catch (err) {
      setSaveState({ status: "error", message: err instanceof Error ? err.message : "批量保存失败" });
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

  const batchQuestionCatalog = (() => {
    const questions = new Map<string, { questionNumber: number; scoreType: "objective" | "subjective"; maxScore: number; mode: string; step: number }>();
    for (const id of batchSelectedIds) {
      for (const question of batchDetails[id]?.questionScores ?? []) {
        if (question.score_type !== "objective" && question.score_type !== "subjective") continue;
        const key = `${question.question_number}_${question.score_type}`;
        const existing = questions.get(key);
        if (!existing || question.max_score > existing.maxScore) {
          questions.set(key, {
            questionNumber: question.question_number,
            scoreType: question.score_type,
            maxScore: question.max_score,
            mode: question.mode,
            step: question.step
          });
        }
      }
    }
    return [...questions.values()].sort((left, right) =>
      left.questionNumber - right.questionNumber || left.scoreType.localeCompare(right.scoreType));
  })();

  const saveMsgClass = saveState.status === "success"
    ? "text-success-foreground"
    : saveState.status === "error" ? "text-destructive-fg" : "text-muted-foreground";

  // Mode selection screen
  if (!fixMode) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-6 py-3">
          <Button variant="outline" size="sm" icon={<ArrowLeft />} onClick={() => guardUnsaved(onBack)}>
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
          <ModeCard
            icon={<ListChecks className="size-9 text-primary" />}
            title="批量送分 / 加分"
            description="选择多名学生 → 预览目标分 → 整批提交"
            onClick={() => setFixMode("batch")}
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
          onClick={handleHeaderBack}
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
          onValueChange={requestModeChange}
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
                      <CardCorrectionButton disabled={hasScoreDraft || saving} url={`/api/exams/${examId}/student/${student.student.id}/correction`} onSaved={() => loadStudent(student.student.id,student.student.name,student.student.studentNumber)} />
                      {saveState.message && <span className={cn("text-xs", saveMsgClass)}>{saveState.message}</span>}
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<Save />}
                        onClick={saveScoreEdits}
                        loading={saving}
                        disabled={!hasScoreDraft || saving}
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
                            const draftKey = `${qs.question_number}_${qs.score_type}`;
                            const modified = draftKey in scoreEdits &&
                              (scoreEdits[draftKey].trim() === "" || Number(scoreEdits[draftKey]) !== Number(qs.score));
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
                                  {isObj ? objectiveModeLabel(qs.mode) : "解答"}
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
                                    const options = objectiveScoreCandidates(
                                      qs.max_score,
                                      step,
                                      qs.mode === "single" ? "single" : "multiple"
                                    );
                                    return (
                                      <Select
                                        value={String(cur)}
                                        onValueChange={(v) => setScoreEdit(qs.question_number, qs.score_type, v)}
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
                                      type="text"
                                      inputMode="decimal"
                                      value={cur}
                                      aria-label={`第 ${qs.question_number} 题得分`}
                                      onChange={(e) => setScoreEdit(qs.question_number, qs.score_type, e.target.value)}
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

        {/* ============== BATCH MODE ============== */}
        {fixMode === "batch" && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <div className="relative w-full max-w-90">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="搜索并选择多名学生..."
                  aria-label="搜索批量改分学生"
                  className="h-control-sm pl-9 text-sm"
                />
              </div>
              <Button variant="primary" size="sm" icon={<Search />} onClick={searchStudent}>搜索</Button>
              <Button
                variant="outline"
                size="sm"
                onClick={loadBatchQuestions}
                loading={loadingBatch}
                disabled={batchSelectedIds.length === 0}
              >
                加载题目
              </Button>
            </div>

            {searchMsg && (
              <div className={cn("text-sm", searchMsg.includes("未找到") ? "text-muted-foreground" : "text-destructive-fg")}>
                {searchMsg}
              </div>
            )}
            {saveState.message && <div className={cn("text-sm", saveMsgClass)}>{saveState.message}</div>}

            {hits.length > 0 && (
              <div className="flex flex-col gap-1 rounded-md border border-border-subtle bg-card p-2">
                {hits.map((hit) => (
                  <ControlRow
                    key={hit.id}
                    htmlFor={`batch-student-${hit.id}`}
                    className="rounded-sm px-2 py-1.5 hover:bg-secondary"
                    control={
                      <Checkbox
                        id={`batch-student-${hit.id}`}
                        checked={batchSelectedIds.includes(hit.id)}
                        onCheckedChange={() => toggleBatchStudent(hit)}
                      />
                    }
                    label={<span className="text-sm font-medium">{hit.name}</span>}
                    description={<span className="tabular-nums">考号 {hit.studentNumber || "—"}</span>}
                  />
                ))}
              </div>
            )}

            {batchSelectedIds.length > 0 && (
              <div className="text-sm text-muted-foreground">
                已选 {batchSelectedIds.length} 名学生：
                {batchSelectedIds.map((id) => batchStudents[id]?.name).filter(Boolean).join("、")}
              </div>
            )}

            {batchQuestionCatalog.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-border-subtle bg-card">
                <div className="border-b border-border-subtle px-3 py-2 text-sm font-medium">逐题操作</div>
                <TableWrap>
                  <Table className="text-sm">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>题号</TableHead>
                        <TableHead>类型 / 满分</TableHead>
                        <TableHead>操作</TableHead>
                        <TableHead>加分值</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {batchQuestionCatalog.map((question) => {
                        const key = `${question.questionNumber}_${question.scoreType}`;
                        const draft = batchOps[key];
                        return (
                          <TableRow key={key}>
                            <TableCell className="font-medium tabular-nums">{question.questionNumber}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {question.scoreType === "objective"
                                ? `${objectiveModeLabel(question.mode)} / ${question.maxScore}`
                                : `解答 / ${question.maxScore}`}
                            </TableCell>
                            <TableCell>
                              <Select
                                value={draft?.operation ?? "none"}
                                onValueChange={(value) => setBatchOperation(key, value as "none" | "full" | "add")}
                              >
                                <SelectTrigger className="h-control-sm w-32" aria-label={`第 ${question.questionNumber} 题批量操作`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">不操作</SelectItem>
                                  <SelectItem value="full">送分（满分）</SelectItem>
                                  <SelectItem value="add">加分</SelectItem>
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell>
                              {draft?.operation === "add" ? (
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  value={draft.amount}
                                  onChange={(event) => setBatchAmount(key, event.target.value)}
                                  aria-label={`第 ${question.questionNumber} 题加分值`}
                                  className="h-control-sm w-20 text-sm tabular-nums"
                                />
                              ) : <span className="text-muted-foreground">—</span>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableWrap>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={generateBatchPreview}
                loading={loadingBatch}
                disabled={batchSelectedIds.length === 0 || Object.keys(batchOps).length === 0 || loadingBatch}
              >
                生成目标分预览
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Save />}
                disabled={!batchPreview || batchPreview.some((row) => !row.legal) || saving}
                onClick={() => {
                  if (!batchPreview) return;
                  setPendingConfirmation({
                    action: () => { void submitBatchScores(); },
                    title: "确认批量修改成绩？",
                    description: `将按预览更新 ${batchSelectedIds.length} 名学生、${Object.keys(batchOps).length} 道题，并重新计算总分、排名与公布状态。`,
                    confirmLabel: "确认提交",
                    tone: "default"
                  });
                }}
              >
                提交批量修改
              </Button>
            </div>

            {batchPreview && (
              <div className="overflow-hidden rounded-lg border border-border-subtle bg-card">
                <div className="border-b border-border-subtle px-3 py-2 text-sm font-medium">目标分预览（提交前请核对）</div>
                <TableWrap>
                  <Table className="text-sm">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>学生</TableHead>
                        <TableHead>题号</TableHead>
                        <TableHead>操作</TableHead>
                        <TableHead numeric>当前分</TableHead>
                        <TableHead numeric>目标分</TableHead>
                        <TableHead>校验</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {batchPreview.map((row) => (
                        <TableRow key={`${row.studentId}_${row.questionNumber}_${row.scoreType}`}>
                          <TableCell>{row.studentName}</TableCell>
                          <TableCell className="tabular-nums">{row.questionNumber}</TableCell>
                          <TableCell className="text-xs">
                            {row.operation === "full" ? "送分" : `加分 ${row.amount}`}
                          </TableCell>
                          <TableCell numeric className="tabular-nums">{row.currentScore} / {row.maxScore}</TableCell>
                          <TableCell numeric className="font-semibold tabular-nums">{row.targetScore}</TableCell>
                          <TableCell className={row.legal ? "text-success-foreground" : "text-destructive-fg"}>
                            {row.legal ? "可提交" : "目标分非法"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableWrap>
              </div>
            )}
          </div>
        )}

        {/* ============== ANSWER MODE ============== */}
        {fixMode === "answer" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-subtle bg-card">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-3 py-2 text-xs font-medium">
              <span>标准答案编辑</span>
              <div className="flex shrink-0 items-center gap-2">
                {saveState.message && <span className={cn("text-xs", saveMsgClass)}>{saveState.message}</span>}
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Save />}
                  onClick={saveAnswerEdits}
                  loading={saving}
                  disabled={!hasAnswerDraft || saving}
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
                    const isMulti = isMultiSelectMode(q.mode);
                    const draft = answerEdits[String(q.questionNumber)];
                    const changed = draft != null && !sameOptions(draft, q.answerKey ?? []);
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
      <ConfirmDialog
        open={pendingConfirmation !== null}
        onOpenChange={(open) => { if (!open) setPendingConfirmation(null); }}
        title={pendingConfirmation?.title ?? "确认操作"}
        description={pendingConfirmation?.description}
        confirmLabel={pendingConfirmation?.confirmLabel}
        tone={pendingConfirmation?.tone}
        loading={saving}
        onConfirm={() => {
          const action = pendingConfirmation?.action;
          setPendingConfirmation(null);
          action?.();
        }}
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
