import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Camera,
  ChevronDown,
  ClipboardCheck,
  Download,
  FileDown,
  FolderOpen,
  ImagePlus,
  ListPlus,
  Plus,
  Save,
  SquarePen,
  Trash2,
  Upload,
  Users
} from "lucide-react";
import { useAuth } from "./auth/AuthContext";
import { authFetch, fetchJson, urlWithToken } from "./auth/api";
import { PERMISSIONS } from "./auth/types";
import { LoginPage } from "./components/LoginPage";
import { AccountMenu } from "./components/AccountMenu";
import { AccountManagement } from "./components/AccountManagement";
import { StudentScores } from "./components/StudentScores";
import { NewCardModal, type NewCardFormData } from "./components/NewCardModal";
import type {
  AnswerCard,
  BlankLabelStyle,
  BodyBlock,
  CardSummary,
  CombinedGradingBatchResult,
  CombinedGradingRow,
  LayoutDocument,
  ObjectiveBlock,
  ObjectiveMode,
  PageRenderBlock,
  SubjectiveBlock,
  SubjectiveKind,
  SubjectiveQuestion,
  SubjectiveStyle
} from "../../../shared/types";
import { normalizeObjectiveAnswerKey, objectiveQuestionNumbers, optionLabelsFor } from "../../../shared/grading";
import { buildLayout } from "../../../shared/layout";
import { createBlockId } from "../../../shared/defaultCard";
import { formatBlankLabel } from "../../../shared/blankLabels";
import { ScannerPanel } from "./components/ScannerPanel";
import { AnalysisOverview } from "./components/AnalysisOverview";
import { AnalysisDistribution } from "./components/AnalysisDistribution";
import { AnalysisRanking } from "./components/AnalysisRanking";
import { AnalysisQuestions } from "./components/AnalysisQuestions";
import type {
  ExamOverview,
  ExamRecord,
  QuestionAnalysisItem,
  StudentRankingItem
} from "../../../shared/types";

const modeLabels: Record<ObjectiveMode, string> = {
  single: "单选",
  multiple: "多选",
  indefinite: "不定项"
};

const styleLabels: Record<SubjectiveStyle, string> = {
  manual_score_grid: "带顶部分数填涂区",
  plain_subjective: "纯主观题书写块"
};

const kindLabels: Record<SubjectiveKind, string> = {
  blank: "填空",
  lined_answer: "横线格",
  plain_box: "空白大框"
};

const blankLabelStyleLabels: Record<BlankLabelStyle, string> = {
  none: "不带序号",
  arabic_parentheses: "(1)(2)",
  roman_parentheses: "(i)(ii)"
};

function cloneCard(card: AnswerCard): AnswerCard {
  return JSON.parse(JSON.stringify(card)) as AnswerCard;
}

type AppMode = "design" | "grading" | "analysis" | "scores" | "account";

type GradingProgress = {
  active: boolean;
  finished: number;
  total: number;
};

type GradingProgressEvent = {
  type: "start" | "progress" | "done" | "error";
  batchId: string;
  finished: number;
  total: number;
};

function defaultModeForUser(
  hasPermission: (perm: string) => boolean,
  isStudent: boolean
): AppMode {
  if (isStudent) return "scores";
  if (hasPermission(PERMISSIONS.CARD_READ)) return "design";
  if (hasPermission(PERMISSIONS.GRADE_READ)) return "grading";
  if (hasPermission(PERMISSIONS.EXAM_READ)) return "analysis";
  if (hasPermission(PERMISSIONS.USER_MANAGE)) return "account";
  return "scores";
}

const directoryInputProps = {
  webkitdirectory: "",
  directory: ""
} as Record<string, string>;

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|bmp|webp|tiff?)$/i.test(file.name);
}

function answerText(options: string[]): string {
  return options.length > 0 ? options.join("") : "-";
}

function csvTextCell(value: string | number | null | undefined): string {
  // 前导制表符可阻止 Excel 将 "8/10"、"3/4" 等识别为日期
  const text = String(value ?? "");
  if (/^\d{1,2}\/\d{1,2}$/.test(text) || /^\d{1,2}-\d{1,2}$/.test(text)) {
    return `\t${text}`;
  }
  return text;
}

function downloadCsv(rows: CombinedGradingRow[], cardId: string) {
  const header = ["文件名", "学号", "识别状态", "总分", "满分", "客观题得分", "主观题得分", "待复核题数", "异常数", "备注"];
  const lines = [
    header,
    ...rows.map((row) => [
      row.fileName,
      row.studentId ?? "未识别",
      row.recognitionStatus,
      String(row.totalScore),
      String(row.totalMaxScore),
      csvTextCell(`${row.objectiveScore}/${row.objectiveMaxScore}`),
      csvTextCell(`${row.subjectiveScore}/${row.subjectiveMaxScore}`),
      String(row.needsReviewCount),
      String(row.issueCount),
      row.message ?? ""
    ])
  ];
  const csv = lines.map((line) => line.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `成绩表_${cardId}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function defaultObjective(start: number): ObjectiveBlock {
  return {
    id: createBlockId("obj"),
    type: "objective",
    title: "客观题",
    questionStart: start,
    questionCount: 10,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 5,
    density: "compact",
    answerKey: {},
    multipleScoring: {
      partialScores: { 1: 2, 2: 4 },
      wrongOrExtraScore: 0
    }
  };
}

function defaultSubjective(nextNumber: number): SubjectiveBlock {
  return {
    id: createBlockId("subj"),
    type: "subjective",
    title: "主观题",
    questions: [
      {
        id: createBlockId("q"),
        number: nextNumber,
        score: 12,
        style: "manual_score_grid",
        kind: "plain_box",
        lineGrid: { enabled: false, lineSpacingMm: 8 },
        images: [],
        minHeightMm: 62
      }
    ]
  };
}

function defaultBlankQuestion(
  questionNumber: string | number,
  score = 0,
  style: SubjectiveStyle = "plain_subjective"
): SubjectiveQuestion {
  return {
    id: createBlockId("q"),
    number: questionNumber,
    score,
    style,
    kind: "blank",
    blanks: { count: 1, widthMm: 22, heightMm: 6, labelStyle: "none" },
    lineGrid: { enabled: false, lineSpacingMm: 8 },
    images: [],
    minHeightMm: 14
  };
}

function defaultBlankBlock(nextNumber: number): SubjectiveBlock {
  return {
    id: createBlockId("subj"),
    type: "subjective",
    title: "填空题",
    questions: Array.from({ length: 10 }, (_, index) =>
      defaultBlankQuestion(nextNumber + index, index === 0 ? 15 : 0, index === 0 ? "manual_score_grid" : "plain_subjective")
    )
  };
}

function numericQuestionValue(value: string | number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findNextQuestionNumber(card: AnswerCard): number {
  let max = 0;
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") max = Math.max(max, block.questionStart + block.questionCount - 1);
    if (block.type === "subjective") {
      for (const question of block.questions) max = Math.max(max, numericQuestionValue(question.number));
    }
  }
  return max + 1;
}

function App() {
  const { user, loading, hasPermission, isStudent } = useAuth();
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [card, setCard] = useState<AnswerCard | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [mode, setMode] = useState<AppMode>("design");
  const [gradingFiles, setGradingFiles] = useState<File[]>([]);
  const [gradingExamId, setGradingExamId] = useState<string>("");
  const [gradingResult, setGradingResult] = useState<CombinedGradingBatchResult | null>(null);
  const [gradingProgress, setGradingProgress] = useState<GradingProgress>({ active: false, finished: 0, total: 0 });
  const [status, setStatus] = useState("准备就绪");
  const [isBusy, setIsBusy] = useState(false);
  const gradingProgressSourceRef = useRef<EventSource | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [analysisExamId, setAnalysisExamId] = useState<number | null>(null);
  const [analysisClassId, setAnalysisClassId] = useState<string>("");
  const [analysisClasses, setAnalysisClasses] = useState<Array<{ classId: number; className: string }>>([]);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [analysisOverview, setAnalysisOverview] = useState<ExamOverview | null>(null);
  const [analysisRanking, setAnalysisRanking] = useState<StudentRankingItem[]>([]);
  const [analysisQuestions, setAnalysisQuestions] = useState<QuestionAnalysisItem[]>([]);
  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [showCreateExam, setShowCreateExam] = useState(false);
  const [newExamName, setNewExamName] = useState("");
  const [newExamSubject, setNewExamSubject] = useState("");
  const [newExamCardId, setNewExamCardId] = useState("");
  const [selectedExamIds, setSelectedExamIds] = useState<Set<number>>(new Set());
  const [analysisTab, setAnalysisTab] = useState<"manage" | "view">("view");
  const [showNewCardModal, setShowNewCardModal] = useState(false);

  const layout = useMemo<LayoutDocument | null>(() => (card ? buildLayout(card) : null), [card]);

  const canDesign = hasPermission(PERMISSIONS.CARD_READ);
  const canGrade = hasPermission(PERMISSIONS.GRADE_READ);
  const canAnalyze = hasPermission(PERMISSIONS.EXAM_READ);
  const canWriteExam = hasPermission(PERMISSIONS.EXAM_WRITE);
  const canViewScores = hasPermission(PERMISSIONS.SCORE_READ);
  const canManageAccounts = hasPermission(PERMISSIONS.USER_MANAGE);
  const showCardSidebar = mode === "design";
  const showScoresTab = isStudent && canViewScores;

  useEffect(() => {
    if (user) {
      setMode(defaultModeForUser(hasPermission, isStudent));
    }
  }, [user?.id, hasPermission, isStudent]);

  useEffect(() => {
    if (!user || (!canDesign && !canGrade)) return;
    void refreshCards(canDesign);
  }, [user?.id, canDesign, canGrade]);

  useEffect(() => {
    return () => {
      gradingProgressSourceRef.current?.close();
    };
  }, []);

  async function refreshCards(loadFirst = false) {
    const list = await fetchJson<CardSummary[]>("/api/cards");
    setCards(list);
    if (loadFirst && list.length > 0) {
      await loadCard(list[0].id);
    }
  }

  async function createCard(formData: NewCardFormData) {
    setShowNewCardModal(false);
    setIsBusy(true);
    try {
      const created = await fetchJson<AnswerCard>("/api/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: formData.subject,
          subjectLabel: formData.subjectLabel,
          title: formData.title,
          examDate: formData.examDate
        })
      });
      setCard(created);
      setSelectedBlockId(created.bodyBlocks[0]?.id ?? null);
      setStatus(`已创建答题卡 「${created.title}」 (${created.id})`);
      await refreshCards();
    } finally {
      setIsBusy(false);
    }
  }

  async function loadCard(id: string) {
    setIsBusy(true);
    try {
      const loaded = await fetchJson<AnswerCard>(`/api/cards/${id}`);
      setCard(loaded);
      setSelectedBlockId(loaded.bodyBlocks[0]?.id ?? null);
      setGradingResult(null);
      setStatus(`已载入 ${loaded.title}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function saveCard() {
    if (!card) return;
    setIsBusy(true);
    try {
      const saved = await fetchJson<AnswerCard>(`/api/cards/${card.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(card)
      });
      setCard(saved);
      setStatus("已保存，并生成坐标布局数据");
      await refreshCards();
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteCard(cardId: string) {
    setIsBusy(true);
    try {
      const result = await fetchJson<{ ok: boolean; referencedExamCount: number; referencedExamNames: string[] }>(
        `/api/cards/${cardId}`,
        { method: "DELETE" }
      );
      if (result.referencedExamCount > 0) {
        setStatus(`已删除答题卡（被 ${result.referencedExamCount} 个考试引用：${result.referencedExamNames.join("、")}）`);
      } else {
        setStatus("已删除答题卡");
      }
      if (card?.id === cardId) {
        setCard(null);
        setSelectedBlockId(null);
      }
      await refreshCards();
    } finally {
      setIsBusy(false);
    }
  }

  async function exportCard(cardId: string) {
    const a = document.createElement("a");
    a.href = urlWithToken(`/api/cards/${cardId}/export`);
    a.download = `答题卡_${cardId}.projectx-card.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("正在导出答题卡...");
  }

  async function importCard() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setIsBusy(true);
      setStatus("正在导入答题卡...");
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const result = await fetchJson<CardSummary>("/api/cards/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data)
        });
        setStatus(`已导入答题卡：${result.title} (${result.id})`);
        await refreshCards();
        await loadCard(result.id);
      } catch (err) {
        setStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setIsBusy(false);
      }
    };
    input.click();
  }

  function updateCard(mutator: (draft: AnswerCard) => void) {
    if (!card) return;
    const draft = cloneCard(card);
    mutator(draft);
    setCard(draft);
  }

  function updateBlock(blockId: string, mutator: (block: BodyBlock) => void) {
    updateCard((draft) => {
      const block = draft.bodyBlocks.find((item) => item.id === blockId);
      if (block) mutator(block);
    });
  }

  function moveBlock(blockId: string, direction: -1 | 1) {
    updateCard((draft) => {
      const index = draft.bodyBlocks.findIndex((item) => item.id === blockId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= draft.bodyBlocks.length) return;
      const [block] = draft.bodyBlocks.splice(index, 1);
      draft.bodyBlocks.splice(nextIndex, 0, block);
    });
  }

  function removeBlock(blockId: string) {
    updateCard((draft) => {
      draft.bodyBlocks = draft.bodyBlocks.filter((item) => item.id !== blockId);
      if (selectedBlockId === blockId) setSelectedBlockId(draft.bodyBlocks[0]?.id ?? null);
    });
  }

  function addObjectiveBlock(afterIndex?: number) {
    if (!card) return;
    const block = defaultObjective(findNextQuestionNumber(card));
    updateCard((draft) => {
      const index = afterIndex ?? draft.bodyBlocks.length - 1;
      draft.bodyBlocks.splice(index + 1, 0, block);
    });
    setSelectedBlockId(block.id);
  }

  function addSubjectiveBlock() {
    if (!card) return;
    const block = defaultSubjective(findNextQuestionNumber(card));
    updateCard((draft) => {
      draft.bodyBlocks.push(block);
    });
    setSelectedBlockId(block.id);
  }

  function addBlankBlock() {
    if (!card) return;
    const block = defaultBlankBlock(findNextQuestionNumber(card));
    updateCard((draft) => {
      draft.bodyBlocks.push(block);
    });
    setSelectedBlockId(block.id);
  }

  async function uploadImage(blockId: string, questionId: string, file: File) {
    if (!card) return;
    const form = new FormData();
    form.append("file", file);
    const uploaded = await fetchJson<{ assetId: string; originalName: string }>(`/api/cards/${card.id}/assets`, {
      method: "POST",
      body: form
    });
    updateBlock(blockId, (block) => {
      if (block.type !== "subjective") return;
      const question = block.questions.find((item) => item.id === questionId);
      if (!question) return;
      question.images = [
        ...(question.images ?? []),
        {
          assetId: uploaded.assetId,
          originalName: uploaded.originalName,
          widthMm: 48,
          heightMm: 28,
          align: "left"
        }
      ];
    });
    setStatus("图片已加入主观题，保存后写入答题卡配置");
  }

  function addGradingFiles(files: FileList | null) {
    if (!files) return;
    const nextFiles = Array.from(files).filter(isImageFile);
    // Single-sided card: filter out back-side images (filename ends with B.jpg / B.jpeg / B.png etc.)
    const isSingleSided = card?.sided === "single";
    const backSidePattern = /B\.(jpg|jpeg|png|bmp|tiff|tif)$/i;
    let skippedBacks = 0;
    const filteredFiles = isSingleSided
      ? nextFiles.filter((file) => {
          if (backSidePattern.test(file.name)) {
            skippedBacks++;
            return false;
          }
          return true;
        })
      : nextFiles;
    setGradingFiles((current) => {
      const seen = new Set(current.map((file) => `${file.name}_${file.size}_${file.lastModified}`));
      return [
        ...current,
        ...filteredFiles.filter((file) => {
          const key = `${file.name}_${file.size}_${file.lastModified}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
      ];
    });
    if (filteredFiles.length > 0 || skippedBacks > 0) {
      const parts: string[] = [];
      if (filteredFiles.length > 0) parts.push(`已加入 ${filteredFiles.length} 张待阅卷图片`);
      if (skippedBacks > 0) parts.push(`（单面答题卡：跳过 ${skippedBacks} 张背面）`);
      setStatus(parts.join(" "));
    }
  }

  function createGradingProgressId(): string {
    const randomPart =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2, 12);
    return `grading_${Date.now()}_${randomPart}`;
  }

  function listenGradingProgress(cardId: string, progressId: string, initialTotal: number) {
    gradingProgressSourceRef.current?.close();
    setGradingProgress({ active: true, finished: 0, total: initialTotal });
    const es = new EventSource(urlWithToken(`/api/cards/${encodeURIComponent(cardId)}/grading/progress/${encodeURIComponent(progressId)}`));
    gradingProgressSourceRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as GradingProgressEvent;
      setGradingProgress({
        active: data.type !== "error",
        finished: data.finished,
        total: data.total
      });
      if (data.type === "start" || data.type === "progress") {
        setStatus(`识别答题卡，已识别 ${data.finished}/${data.total} 张`);
      }
      if (data.type === "done" || data.type === "error") {
        es.close();
      }
    };

    es.onerror = () => {
      es.close();
    };
  }

  async function gradeAnswerCardFiles() {
    if (!card || gradingFiles.length === 0) return;
    setIsBusy(true);
    const progressId = createGradingProgressId();
    listenGradingProgress(card.id, progressId, gradingFiles.length);
    setStatus(`识别答题卡，已识别 0/${gradingFiles.length} 张`);
    try {
      const form = new FormData();
      for (const file of gradingFiles) {
        form.append("files", file);
      }
      form.append("progressId", progressId);
      if (gradingExamId) {
        form.append("examId", gradingExamId);
      }
      const result = await fetchJson<CombinedGradingBatchResult>(`/api/cards/${card.id}/grading`, {
        method: "POST",
        body: form
      });
      setGradingResult(result);
      const msg = `阅卷完成：${result.rows.length} 张，${result.rows.reduce((sum, row) => sum + row.needsReviewCount, 0)} 题待复核`;
      const extra = gradingExamId ? "，正在后台写入数据库..." : "（未选择考试，数据未落库）";
      setStatus(msg + extra);
    } finally {
      gradingProgressSourceRef.current?.close();
      gradingProgressSourceRef.current = null;
      setGradingProgress((current) => ({ ...current, active: false }));
      setIsBusy(false);
    }
  }

  async function loadExams() {
    try {
      const data = await fetchJson<ExamRecord[]>("/api/exams");
      setExams(data);
    } catch {
      setExams([]);
    }
  }

  async function loadAnalysis(examId: number, classId?: string) {
    setAnalysisExamId(examId);
    const cidParam = classId ? `?classId=${classId}` : "";
    try {
      const [overview, ranking, questions, classes] = await Promise.all([
        fetchJson<ExamOverview>(`/api/analysis/exams/${examId}/overview${cidParam}`),
        fetchJson<StudentRankingItem[]>(`/api/analysis/exams/${examId}/students${cidParam}`),
        fetchJson<QuestionAnalysisItem[]>(`/api/analysis/exams/${examId}/questions${cidParam}`),
        classId ? Promise.resolve([]) : fetchJson<Array<{ classId: number; className: string }>>(`/api/analysis/exams/${examId}/classes`)
      ]);
      setAnalysisOverview(overview);
      setAnalysisRanking(ranking);
      setAnalysisQuestions(questions);
      if (!classId) setAnalysisClasses(classes);
      setStatus(`分析加载完成：${overview.gradedCount} 人${classId ? "（当前班级）" : ""}`);
    } catch (err) {
      setStatus(`分析加载失败：${err instanceof Error ? err.message : String(err)}`);
      setAnalysisOverview(null);
      setAnalysisRanking([]);
      setAnalysisQuestions([]);
    }
  }

  function downloadAnalysisCsv(classId?: string) {
    if (!analysisExamId) return;
    setShowExportMenu(false);
    const params = classId ? `?classId=${classId}` : "";
    const exam = exams.find(e => e.id === analysisExamId);
    const filename = `${exam?.name ?? "成绩表"}_${classId ? "班级" : "年级"}.csv`;

    authFetch(`/api/analysis/exams/${analysisExamId}/export-csv${params}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStatus("CSV 导出完成");
      })
      .catch((err) => setStatus(`导出失败: ${err instanceof Error ? err.message : String(err)}`));
  }

  const selectedBlock = card?.bodyBlocks.find((block) => block.id === selectedBlockId) ?? null;

  if (loading) {
    return (
      <div className="login-shell">
        <p className="empty-text">正在加载...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <main className={`app-shell ${showCardSidebar ? "" : "no-card-sidebar"}`}>
      {showCardSidebar && (
      <aside className="sidebar">
        <div className="brand">
          <img src="/resources/icon.png" alt="" className="brand-icon" />
          <div>
            <strong>答题卡设计阅卷系统</strong>
            <span>Project-X v1</span>
          </div>
        </div>
        <div style={{ gap: 8, display: "flex", flexDirection: "column" }}>
          <button className="primary-button" onClick={() => setShowNewCardModal(true)} disabled={isBusy || !canDesign} style={{ width: "100%" }}>
            <Plus size={17} /> 新建答题卡
          </button>
        </div>
        <div className="card-list">
          {cards.map((item) => (
            <div
              key={item.id}
              className={`card-list-item ${card?.id === item.id ? "active" : ""}`}
            >
              <button
                className="card-list-main"
                onClick={() => void loadCard(item.id)}
              >
                <span>{item.title || "未命名答题卡"}</span>
                <small>{item.subjectLabel ? `${item.subjectLabel} · ` : ""}ID:{item.id}</small>
              </button>
              <div className="card-list-actions">
                <button title="导出" onClick={(e) => { e.stopPropagation(); void exportCard(item.id); }}>
                  <Download size={14} />
                </button>
                <button
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`确定删除「${item.title || item.id}」？此操作不可撤销。`)) {
                      void deleteCard(item.id);
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          {cards.length === 0 && <p className="empty-text">暂无答题卡，先新建一张。</p>}
        </div>
        <button className="ghost-button" onClick={() => void importCard()} disabled={isBusy} style={{ marginTop: 8, width: "100%" }}>
          <Upload size={16} /> 导入答题卡
        </button>
      </aside>
      )}

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>
              {mode === "scores" ? "我的成绩" : mode === "account" ? "账号管理" : card?.title ?? (canDesign ? "答题卡设计器" : "答题卡系统")}
            </h1>
            <p>
              {mode === "scores"
                ? "查看各场考试得分、排名与逐题明细"
                : mode === "account"
                  ? "管理用户、班级与花名册"
                  : card
                    ? `ID:${card.id} · ${card.sided === "single" ? "单面" : "双面"} · ${layout?.pages.length ?? 1} 页 · ${layout?.elements.length ?? 0} 个 · 预览页面仅供参考，以实际导出的 PDF 文件的样式为准`
                    : canDesign
                      ? "创建答题卡后开始编辑"
                      : `${user.name} · ${user.role_display_name ?? user.role_name}`}
            </p>
          </div>
          <div className="topbar-actions-left">
            {card && canDesign && mode === "design" && (
              <>
                <a className="ghost-button" href={urlWithToken(`/api/cards/${card.id}/layout`)} target="_blank" rel="noreferrer">
                  坐标JSON
                </a>
                <a className="ghost-button" href={urlWithToken(`/api/cards/${card.id}/pdf?v=${encodeURIComponent(card.updatedAt)}`)} target="_blank" rel="noreferrer">
                  <FileDown size={17} /> PDF
                </a>
                <button className="primary-button" onClick={() => void saveCard()} disabled={isBusy}>
                  <Save size={17} /> 保存
                </button>
              </>
            )}
          </div>
          <div className="topbar-actions">
            <div className="mode-toggle" role="tablist" aria-label="工作模式">
              {canDesign && (
              <button className={mode === "design" ? "active" : ""} onClick={() => setMode("design")} type="button">
                <SquarePen size={16} /> 设计
              </button>
              )}
              {canGrade && (
              <button className={mode === "grading" ? "active" : ""} onClick={() => setMode("grading")} type="button">
                <ClipboardCheck size={16} /> 阅卷
              </button>
              )}
              {canAnalyze && (
              <button className={mode === "analysis" ? "active" : ""} onClick={() => { setMode("analysis"); loadExams(); }} type="button">
                <BarChart3 size={16} /> 分析
              </button>
              )}
              {showScoresTab && (
              <button className={mode === "scores" ? "active" : ""} onClick={() => setMode("scores")} type="button">
                <BarChart3 size={16} /> 我的成绩
              </button>
              )}
              {canManageAccounts && (
              <button className={mode === "account" ? "active" : ""} onClick={() => setMode("account")} type="button">
                <Users size={16} /> 账号
              </button>
              )}
            </div>
            <AccountMenu />
          </div>
        </header>

        <div className={`main-grid ${mode === "design" ? "" : "hidden-panel"}`}>
          <section className="preview-panel">
            {card && layout ? <CardPreview card={card} layout={layout} /> : <div className="blank-preview">选择或新建答题卡</div>}
          </section>

          <aside className="inspector">
            {card ? (
              <>
                <section className="panel">
                  <div className="panel-title">
                    <SquarePen size={17} /> 基本信息
                  </div>
                  <label>
                    标题
                    <input value={card.title} onChange={(event) => updateCard((draft) => void (draft.title = event.target.value))} />
                  </label>
                  {card.subjectLabel && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 13, color: "var(--text-secondary)" }}>
                      <span>科目</span>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{card.subjectLabel}</span>
                    </div>
                  )}
                  {card.examDate && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 13, color: "var(--text-secondary)" }}>
                      <span>考试时间</span>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{card.examDate}</span>
                    </div>
                  )}
                  <label>
                    学号位数
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={card.studentInfo.studentNumberDigits}
                      onChange={(event) =>
                        updateCard((draft) => void (draft.studentInfo.studentNumberDigits = Number(event.target.value)))
                      }
                    />
                  </label>
                  <label>
                    答题卡面
                    <select
                      value={card.sided ?? "double"}
                      onChange={(event) =>
                        updateCard((draft) => void (draft.sided = event.target.value as "single" | "double"))
                      }
                    >
                      <option value="single">单面（仅正面有题）</option>
                      <option value="double">双面（正反面均有题）</option>
                    </select>
                  </label>
                </section>

                <section className="panel">
                  <div className="panel-title">
                    <ListPlus size={17} /> 正文题块
                  </div>
                  <div className="block-list">
                    {card.bodyBlocks.map((block, index) => (
                      <div key={block.id} className={`block-chip ${selectedBlockId === block.id ? "active" : ""}`}>
                        <button onClick={() => setSelectedBlockId(block.id)}>
                          <strong>{block.type === "objective" ? "客观题" : "主观题"}</strong>
                          <span>{block.title}</span>
                        </button>
                        <div className="chip-actions">
                          <button title="上移" onClick={() => moveBlock(block.id, -1)} disabled={index === 0}>
                            <ArrowUp size={15} />
                          </button>
                          <button title="下移" onClick={() => moveBlock(block.id, 1)} disabled={index === card.bodyBlocks.length - 1}>
                            <ArrowDown size={15} />
                          </button>
                          <button title="在后面插入客观题" onClick={() => addObjectiveBlock(index)}>
                            <Plus size={15} />
                          </button>
                          <button title="删除" onClick={() => removeBlock(block.id)}>
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="split-actions">
                    <button className="ghost-button" onClick={() => addObjectiveBlock()}>
                      <Plus size={16} /> 客观题块
                    </button>
                    <button className="ghost-button" onClick={addBlankBlock}>
                      <Plus size={16} /> 填空题块
                    </button>
                    <button className="ghost-button" onClick={addSubjectiveBlock}>
                      <Plus size={16} /> 主观题块
                    </button>
                  </div>
                </section>

                {selectedBlock && (
                  <section className="panel">
                    {selectedBlock.type === "objective" ? (
                      <ObjectiveEditor block={selectedBlock} onChange={(mutator) => updateBlock(selectedBlock.id, mutator)} />
                    ) : (
                      <SubjectiveEditor block={selectedBlock} onChange={(mutator) => updateBlock(selectedBlock.id, mutator)} onUpload={uploadImage} />
                    )}
                  </section>
                )}

                {layout?.warnings.length ? (
                  <section className="panel warning-panel">
                    {layout.warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </section>
                ) : null}
              </>
            ) : (
              <div className="empty-text">请新建或载入答题卡。</div>
            )}
          </aside>
        </div>
        <div className={`main-grid grading-grid ${mode === "grading" ? "" : "hidden-panel"}`}>
          <section className="preview-panel grading-results-panel">
            {showScanner && card ? (
              <ScannerPanel
                cardId={card.id}
                onScansComplete={(sessionId, pageCount) => {
                  setStatus(`扫描完成：${pageCount} 张，学号已识别并存入数据库`);
                }}
                onClose={() => setShowScanner(false)}
              />
            ) : (
              <GradingResults result={gradingResult} onDownloadCsv={() => gradingResult && downloadCsv(gradingResult.rows, gradingResult.cardId)} />
            )}
          </section>

          <aside className="inspector">
            <section className="panel">
              <div className="panel-title">
                <ClipboardCheck size={17} /> 阅卷设置
              </div>
              <label>
                答题卡 ID
                <select value={card?.id ?? ""} onChange={(event) => void loadCard(event.target.value)} disabled={isBusy || cards.length === 0}>
                  <option value="" disabled>
                    请选择答题卡
                  </option>
                  {cards.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} / {item.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                考试
                <select
                  value={gradingExamId}
                  onChange={(e) => setGradingExamId(e.target.value)}
                  onFocus={() => { if (exams.length === 0) loadExams(); }}
                >
                  <option value="">不关联考试</option>
                  {exams.map((exam) => (
                    <option key={exam.id} value={String(exam.id)}>
                      {exam.name} {exam.subject ? `(${exam.subject})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="split-actions">
                <label className="upload-button">
                  <Upload size={16} /> 导入图片
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      addGradingFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <label className="upload-button">
                  <FolderOpen size={16} /> 导入目录
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    {...directoryInputProps}
                    onChange={(event) => {
                      addGradingFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
              <button
                className="primary-button wide-button"
                style={{ marginTop: 8 }}
                onClick={() => setShowScanner(true)}
                disabled={!card || isBusy}
              >
                <Camera size={17} /> 扫描仪录入
              </button>
              <div className="file-queue">
                <div>
                  <strong>{gradingFiles.length}</strong>
                  <span>张待阅卷图片</span>
                </div>
                <button className="ghost-button" type="button" onClick={() => setGradingFiles([])} disabled={gradingFiles.length === 0 || isBusy}>
                  清空
                </button>
              </div>
              {gradingFiles.length > 0 && (
                <div className="queued-files">
                  {gradingFiles.slice(0, 8).map((file) => (
                    <span key={`${file.name}_${file.size}_${file.lastModified}`}>{file.webkitRelativePath || file.name}</span>
                  ))}
                  {gradingFiles.length > 8 && <span>还有 {gradingFiles.length - 8} 张...</span>}
                </div>
              )}
              <button className="primary-button wide-button" onClick={() => void gradeAnswerCardFiles()} disabled={!card || gradingFiles.length === 0 || isBusy}>
                <ClipboardCheck size={17} /> 开始识别并判分
              </button>
              {gradingProgress.active && (
                <div className="grading-progress">
                  <div className="grading-progress-text">
                    识别答题卡，已识别 {gradingProgress.finished}/{gradingProgress.total} 张
                  </div>
                  <div className="grading-progress-track">
                    <div
                      className="grading-progress-fill"
                      style={{
                        width: `${gradingProgress.total > 0 ? Math.min(100, (gradingProgress.finished / gradingProgress.total) * 100) : 0}%`
                      }}
                    />
                  </div>
                </div>
              )}
              <p className="hint">低置信题会标记待复核；学号未识别时仍保留成绩行。</p>
            </section>
          </aside>
        </div>
        <div className={`main-grid analysis-grid ${mode === "analysis" ? "" : "hidden-panel"}`}>
          {/* Sub-tabs */}
          <section className="preview-panel analysis-results-panel" style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", gap: 0, marginBottom: 12, borderBottom: "1px solid var(--line)", padding: "0 24px" }}>
              <button
                onClick={() => setAnalysisTab("view")}
                style={{
                  padding: "8px 18px", border: "none", background: "none", cursor: "pointer",
                  fontSize: 14, color: analysisTab === "view" ? "var(--brand)" : "var(--muted)",
                  borderBottom: analysisTab === "view" ? "2px solid var(--brand)" : "2px solid transparent",
                  fontWeight: analysisTab === "view" ? 600 : 400
                }}
              >
                <BarChart3 size={15} style={{ verticalAlign: "middle", marginRight: 4 }} />
                成绩分析
              </button>
              {canWriteExam && (
              <button
                onClick={() => setAnalysisTab("manage")}
                style={{
                  padding: "8px 18px", border: "none", background: "none", cursor: "pointer",
                  fontSize: 14, color: analysisTab === "manage" ? "var(--brand)" : "var(--muted)",
                  borderBottom: analysisTab === "manage" ? "2px solid var(--brand)" : "2px solid transparent",
                  fontWeight: analysisTab === "manage" ? 600 : 400
                }}
              >
                <ListPlus size={15} style={{ verticalAlign: "middle", marginRight: 4 }} />
                考试管理
              </button>
              )}
            </div>

            {/* Tab: 成绩分析 */}
            {analysisTab === "view" && (
              <div style={{ display: "grid", gridTemplateColumns: "268px minmax(0, 1fr)", minHeight: 0, flex: 1 }}>
                <aside className="inspector" style={{ borderRight: "1px solid var(--line)", overflowY: "auto" }}>
                  <section className="panel">
                    <div className="panel-title">选择考试</div>
                    {exams.length === 0 ? (
                      <div className="empty-text" style={{ fontSize: 12 }}>暂无考试，请先创建</div>
                    ) : (
                      <div style={{ maxHeight: 400, overflowY: "auto" }}>
                        {exams.map((exam) => (
                          <div
                            key={exam.id}
                            className={`card-list-item ${analysisExamId === exam.id ? "active" : ""}`}
                            style={{ cursor: "pointer", padding: "6px 8px" }}
                            onClick={() => { setAnalysisClassId(""); loadAnalysis(exam.id); }}
                          >
                            <span style={{ fontSize: 13, fontWeight: analysisExamId === exam.id ? 600 : 400 }}>{exam.name}</span>
                            {exam.subject && <small style={{ display: "block", color: "var(--muted)", fontSize: 11 }}>{exam.subject}</small>}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                  {analysisClasses.length > 0 && (
                    <section className="panel">
                      <div className="panel-title">班级筛选</div>
                      <select value={analysisClassId} onChange={(e) => { setAnalysisClassId(e.target.value); if (analysisExamId) loadAnalysis(analysisExamId, e.target.value || undefined); }} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }}>
                        <option value="">全部班级</option>
                        {analysisClasses.map((c) => (<option key={c.classId} value={String(c.classId)}>{c.className}</option>))}
                      </select>
                    </section>
                  )}
                </aside>
                <section style={{ overflowY: "auto", padding: 24 }}>
                  {!analysisExamId ? (
                    <div className="empty-text" style={{ padding: 60, textAlign: "center" }}>从左侧选择一个考试查看分析。</div>
                  ) : (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                        <BarChart3 size={18} style={{ color: "var(--brand)" }} />
                        <strong style={{ fontSize: 17 }}>{exams.find(e => e.id === analysisExamId)?.name || "成绩分析"}</strong>
                        <div style={{ marginLeft: "auto", position: "relative" }}>
                          <button
                            className="primary-button"
                            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}
                            onClick={() => setShowExportMenu(!showExportMenu)}
                          >
                            <Download size={16} /> 导出 <ChevronDown size={14} />
                          </button>
                          {showExportMenu && (
                            <div className="export-menu" style={{
                              position: "absolute", right: 0, top: "100%", zIndex: 100, marginTop: 4,
                              background: "#fff", border: "1px solid var(--line-strong)", borderRadius: 8,
                              boxShadow: "0 4px 16px rgba(0,0,0,0.12)", padding: 4, minWidth: 180
                            }}>
                              <button onClick={() => downloadAnalysisCsv()} className="export-menu-btn">
                                导出年级排名（全部班级）
                              </button>
                              <button
                                onClick={() => downloadAnalysisCsv(analysisClassId || undefined)}
                                disabled={!analysisClassId}
                                className="export-menu-btn"
                                title={!analysisClassId ? "请先在左侧选择班级" : ""}
                              >
                                导出班级排名（仅当前班）
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Click outside to close menu */}
                      {showExportMenu && (
                        <div
                          style={{ position: "fixed", inset: 0, zIndex: 99 }}
                          onClick={() => setShowExportMenu(false)}
                        />
                      )}
                      <AnalysisOverview overview={analysisOverview} />
                      {analysisOverview && analysisOverview.distribution.length > 0 && (
                        <AnalysisDistribution distribution={analysisOverview.distribution} />
                      )}
                      <AnalysisRanking ranking={analysisRanking} />
                      <AnalysisQuestions questions={analysisQuestions} />
                    </>
                  )}
                </section>
              </div>
            )}

            {/* Tab: 考试管理 */}
            {canWriteExam && analysisTab === "manage" && (
              <div style={{ padding: 24, flex: 1, overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                  <strong style={{ fontSize: 16 }}>考试管理</strong>
                  <button className="primary-button" onClick={() => setShowCreateExam(!showCreateExam)}>
                    <Plus size={16} /> 新建考试
                  </button>
                  {selectedExamIds.size > 0 && (
                    <button className="ghost-button" style={{ color: "var(--brand)" }} onClick={async () => {
                      if (!confirm(`删除选中的 ${selectedExamIds.size} 个考试？`)) return;
                      for (const id of selectedExamIds) await fetchJson(`/api/exams/${id}`, { method: "DELETE" });
                      setSelectedExamIds(new Set());
                      if (analysisExamId && selectedExamIds.has(analysisExamId)) { setAnalysisExamId(null); setAnalysisOverview(null); setAnalysisRanking([]); setAnalysisQuestions([]); }
                      loadExams();
                    }}>
                      <Trash2 size={16} /> 删除选中 ({selectedExamIds.size})
                    </button>
                  )}
                  {exams.length > 0 && (
                    <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)" }}>共 {exams.length} 个考试</span>
                  )}
                </div>

                {showCreateExam && (
                  <div style={{ background: "var(--surface-soft)", borderRadius: 8, padding: 14, marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
                    <input value={newExamName} onChange={(e) => setNewExamName(e.target.value)} placeholder="考试名称" style={{ padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }} />
                    <input value={newExamSubject} onChange={(e) => setNewExamSubject(e.target.value)} placeholder="科目（可选）" style={{ padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }} />
                    <select value={newExamCardId || card?.id || ""} onChange={(e) => setNewExamCardId(e.target.value)} style={{ padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }}>
                      <option value="" disabled>选择答题卡</option>
                      {cards.map((c) => (<option key={c.id} value={c.id}>{c.title}</option>))}
                    </select>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="primary-button" onClick={async () => {
                        const name = newExamName.trim();
                        if (!name || !newExamCardId && !card?.id) { setStatus("请填写名称和选择答题卡"); return; }
                        try {
                          await fetchJson("/api/exams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cardId: newExamCardId || card?.id, subject: newExamSubject.trim() || undefined }) });
                          setNewExamName(""); setNewExamSubject(""); setShowCreateExam(false);
                          loadExams();
                        } catch (err) { setStatus(`创建失败: ${err instanceof Error ? err.message : String(err)}`); }
                      }}>确认创建</button>
                      <button className="ghost-button" onClick={() => setShowCreateExam(false)}>取消</button>
                    </div>
                  </div>
                )}

                {exams.length === 0 && !showCreateExam && (
                  <div className="empty-text" style={{ padding: 60, textAlign: "center" }}>暂无考试，点击上方「新建考试」创建。</div>
                )}

                {exams.length > 0 && (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid var(--line)", textAlign: "left" }}>
                        <th style={{ padding: "8px 10px", width: 40 }}>
                          <input type="checkbox" onChange={(e) => {
                            if (e.target.checked) setSelectedExamIds(new Set(exams.map(ex => ex.id)));
                            else setSelectedExamIds(new Set());
                          }} checked={selectedExamIds.size === exams.length && exams.length > 0} />
                        </th>
                        <th style={{ padding: "8px 10px" }}>考试名称</th>
                        <th style={{ padding: "8px 10px", width: 120 }}>科目</th>
                        <th style={{ padding: "8px 10px", width: 100 }}>答题卡</th>
                        <th style={{ padding: "8px 10px", width: 80 }}>状态</th>
                        <th style={{ padding: "8px 10px", width: 80 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exams.map((exam) => (
                        <tr key={exam.id} style={{ borderBottom: "1px solid var(--line)" }}>
                          <td style={{ padding: "8px 10px" }}>
                            <input type="checkbox" checked={selectedExamIds.has(exam.id)} onChange={() => {
                              const next = new Set(selectedExamIds);
                              if (next.has(exam.id)) next.delete(exam.id); else next.add(exam.id);
                              setSelectedExamIds(next);
                            }} />
                          </td>
                          <td style={{ padding: "8px 10px", fontWeight: 500 }}>{exam.name}</td>
                          <td style={{ padding: "8px 10px", color: "var(--muted)" }}>{exam.subject || "—"}</td>
                          <td style={{ padding: "8px 10px", color: "var(--muted)", fontSize: 12 }}>{exam.card_id}</td>
                          <td style={{ padding: "8px 10px" }}>
                            <span style={{
                              padding: "1px 8px", borderRadius: 10, fontSize: 11,
                              background: exam.status === "closed" ? "#dcfce7" : exam.status === "grading" ? "#fef3c7" : "#f3f4f6",
                              color: exam.status === "closed" ? "#166534" : exam.status === "grading" ? "#92400e" : "#6b7280"
                            }}>
                              {exam.status === "closed" ? "已完成" : exam.status === "grading" ? "阅卷中" : exam.status === "draft" ? "草稿" : exam.status}
                            </span>
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <button className="ghost-button" style={{ fontSize: 12, color: "var(--brand)", padding: "2px 6px" }} onClick={async () => {
                              if (!confirm(`删除「${exam.name}」？`)) return;
                              await fetchJson(`/api/exams/${exam.id}`, { method: "DELETE" });
                              if (analysisExamId === exam.id) { setAnalysisExamId(null); setAnalysisOverview(null); setAnalysisRanking([]); setAnalysisQuestions([]); }
                              loadExams();
                            }}>删除</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        </div>
        <div className={`main-grid scores-grid ${mode === "scores" ? "" : "hidden-panel"}`}>
          <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
            <StudentScores />
          </section>
        </div>
        <div className={`main-grid account-grid ${mode === "account" ? "" : "hidden-panel"}`}>
          <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
            <AccountManagement />
          </section>
        </div>
        <footer className="statusbar">{status}</footer>
      </section>
      <NewCardModal open={showNewCardModal} onClose={() => setShowNewCardModal(false)} onCreate={createCard} />
    </main>
  );
}

function GradingResults({
  result,
  onDownloadCsv
}: {
  result: CombinedGradingBatchResult | null;
  onDownloadCsv: () => void;
}) {
  if (!result) {
    return (
      <div className="grading-empty">
        <ClipboardCheck size={36} />
        <h2>等待阅卷</h2>
        <p>选择答题卡，导入答题卡图片或图片目录后开始识别。</p>
      </div>
    );
  }

  const totalReview = result.rows.reduce((sum, row) => sum + row.needsReviewCount, 0);
  const totalIssues = result.rows.reduce((sum, row) => sum + row.issueCount, 0);

  return (
    <div className="grading-results">
      <div className="grading-results-header">
        <div>
          <h2>成绩表</h2>
          <p>
            {result.rows.length} 张答题卡 / 待复核 {totalReview} 题 / 异常 {totalIssues} 处
          </p>
        </div>
        <button className="primary-button" type="button" onClick={onDownloadCsv} disabled={result.rows.length === 0}>
          <Download size={17} /> CSV
        </button>
      </div>
      <div className="score-table">
        <div className="score-table-head">
          <span>文件</span>
          <span>学号</span>
          <span>状态</span>
          <span>总分</span>
          <span>客观/主观</span>
          <span>复核</span>
          <span>答题卡</span>
        </div>
        {result.rows.map((row) => (
          <details className="score-row" key={`${row.fileName}_${row.recognition.imagePath ?? row.fileName}`}>
            <summary>
              <span title={row.fileName}>{row.fileName}</span>
              <span>{row.studentId ?? "未识别"}</span>
              <span className={row.recognitionStatus === "ok" && row.issueCount === 0 ? "status-ok" : "status-warn"}>{row.recognitionStatus}</span>
              <span>
                {row.totalScore}/{row.totalMaxScore}
              </span>
              <span>
                {row.objectiveScore}/{row.objectiveMaxScore} · {row.subjectiveScore}/{row.subjectiveMaxScore}
              </span>
              <span>{row.needsReviewCount}</span>
              <span>
                {row.previewUrl ? (
                  <a
                    className="score-preview-link"
                    href={urlWithToken(row.previewUrl)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                  >
                    预览
                  </a>
                ) : (
                  <span className="muted-cell">-</span>
                )}
              </span>
            </summary>
            <div className="question-grade-list">
              {row.message && <p className="row-message">{row.message}</p>}
              {row.questions.length > 0 && <p className="grading-section-title">客观题</p>}
              {row.questions.map((question) => (
                <div className={`question-grade ${question.needsReview || question.status === "missing_key" ? "needs-review" : ""}`} key={question.questionNumber}>
                  <strong>{question.questionNumber}</strong>
                  <span>标准 {answerText(question.correctOptions)}</span>
                  <span>识别 {answerText(question.selectedOptions)}</span>
                  <span>
                    {question.score}/{question.maxScore}
                  </span>
                  <span>置信 {question.confidence.toFixed(3)}</span>
                  <em>{question.message ?? question.status}</em>
                </div>
              ))}
              {row.subjectiveQuestions.length > 0 && <p className="grading-section-title">主观题</p>}
              {row.subjectiveQuestions.map((question) => (
                <div className={`question-grade subjective-grade ${question.needsReview ? "needs-review" : ""}`} key={question.questionId}>
                  <strong>{question.questionNumber}</strong>
                  <span>有效 {question.validCells.map((cell) => cell.score).join("+") || "-"}</span>
                  <span>无效 {question.invalidCells.length}</span>
                  <span>
                    {question.score}/{question.maxScore}
                  </span>
                  <span>置信 {question.confidence.toFixed(3)}</span>
                  <em>{question.message ?? question.status}</em>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function ObjectiveEditor({ block, onChange }: { block: ObjectiveBlock; onChange: (mutator: (block: BodyBlock) => void) => void }) {
  const questions = objectiveQuestionNumbers(block);
  const options = optionLabelsFor(block);
  const answerKey = normalizeObjectiveAnswerKey(block);
  const missingAnswerCount = questions.filter((questionNumber) => !answerKey[questionNumber]?.length).length;

  function toggleAnswer(questionNumber: number, option: string) {
    onChange((draft) => {
      const objective = draft as ObjectiveBlock;
      objective.answerKey = normalizeObjectiveAnswerKey(objective);
      const current = new Set(objective.answerKey[questionNumber] ?? []);
      if (objective.mode === "single") {
        objective.answerKey[questionNumber] = current.has(option) ? [] : [option];
      } else {
        if (current.has(option)) {
          current.delete(option);
        } else {
          current.add(option);
        }
        objective.answerKey[questionNumber] = Array.from(current).sort();
      }
      if (objective.answerKey[questionNumber].length === 0) {
        delete objective.answerKey[questionNumber];
      }
      objective.answerKey = normalizeObjectiveAnswerKey(objective);
    });
  }

  return (
    <>
      <div className="panel-title">客观题机器阅卷块</div>
      <label>
        标题
        <input value={block.title} onChange={(event) => onChange((draft) => void (draft.title = event.target.value))} />
      </label>
      <div className="answer-key-editor">
        <div className="answer-key-title">
          <strong>标准答案</strong>
          <span>{missingAnswerCount === 0 ? "已全部配置" : `${missingAnswerCount} 题未配置`}</span>
        </div>
        <div className="answer-key-grid">
          {questions.map((questionNumber) => (
            <div className="answer-key-row" key={questionNumber}>
              <span>{questionNumber}</span>
              <div>
                {options.map((option) => {
                  const active = answerKey[questionNumber]?.includes(option) ?? false;
                  return (
                    <button
                      key={option}
                      type="button"
                      className={active ? "active" : ""}
                      onClick={() => toggleAnswer(questionNumber, option)}
                      title={`第 ${questionNumber} 题 ${option} 选项`}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="two-col">
        <label>
          起始题号
          <input
            type="number"
            min={1}
            value={block.questionStart}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.questionStart = Number(event.target.value);
                objective.answerKey = normalizeObjectiveAnswerKey(objective);
              })
            }
          />
        </label>
        <label>
          题目数
          <input
            type="number"
            min={1}
            max={120}
            value={block.questionCount}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.questionCount = Number(event.target.value);
                objective.answerKey = normalizeObjectiveAnswerKey(objective);
              })
            }
          />
        </label>
      </div>
      <div className="two-col">
        <label>
          选项数
          <input
            type="number"
            min={2}
            max={8}
            value={block.optionCount}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.optionCount = Number(event.target.value);
                objective.answerKey = normalizeObjectiveAnswerKey(objective);
              })
            }
          />
        </label>
        <label>
          每题分值
          <input type="number" min={0} step={0.5} value={block.scorePerQuestion} onChange={(event) => onChange((draft) => void ((draft as ObjectiveBlock).scorePerQuestion = Number(event.target.value)))} />
        </label>
      </div>
      <label>
        题型
        <select
          value={block.mode}
          onChange={(event) =>
            onChange((draft) => {
              const objective = draft as ObjectiveBlock;
              objective.mode = event.target.value as ObjectiveMode;
              objective.answerKey = normalizeObjectiveAnswerKey(objective);
            })
          }
        >
          {Object.entries(modeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="two-col">
        <label>
          少选1项得分
          <input
            type="number"
            step={0.5}
            value={block.multipleScoring?.partialScores[1] ?? 0}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.multipleScoring ??= { partialScores: {}, wrongOrExtraScore: 0 };
                objective.multipleScoring.partialScores[1] = Number(event.target.value);
              })
            }
          />
        </label>
        <label>
          多选/错选得分
          <input
            type="number"
            step={0.5}
            value={block.multipleScoring?.wrongOrExtraScore ?? 0}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.multipleScoring ??= { partialScores: {}, wrongOrExtraScore: 0 };
                objective.multipleScoring.wrongOrExtraScore = Number(event.target.value);
              })
            }
          />
        </label>
      </div>
      <p className="hint">客观题使用固定紧凑排版，填涂框尺寸保持一致。</p>
    </>
  );
}

function SubjectiveEditor({
  block,
  onChange,
  onUpload
}: {
  block: SubjectiveBlock;
  onChange: (mutator: (block: BodyBlock) => void) => void;
  onUpload: (blockId: string, questionId: string, file: File) => Promise<void>;
}) {
  const isBlankBlock = block.questions.length > 0 && block.questions.every((question) => question.kind === "blank");

  function updateQuestion(questionId: string, mutator: (question: SubjectiveQuestion) => void) {
    onChange((draft) => {
      if (draft.type !== "subjective") return;
      const question = draft.questions.find((item) => item.id === questionId);
      if (question) mutator(question);
    });
  }

  return (
    <>
      <div className="panel-title">主观题块</div>
      <label>
        标题
        <input value={block.title} onChange={(event) => onChange((draft) => void (draft.title = event.target.value))} />
      </label>
      {isBlankBlock && (
        <label>
          填空题块满分
          <input
            type="number"
            min={0}
            max={60}
            step={0.5}
            value={block.questions[0]?.score ?? 0}
            onChange={(event) =>
              onChange((draft) => {
                if (draft.type !== "subjective") return;
                const scoreQuestion = draft.questions[0];
                if (!scoreQuestion) return;
                scoreQuestion.score = Number(event.target.value);
                scoreQuestion.style = "manual_score_grid";
              })
            }
          />
        </label>
      )}
      {block.questions.map((question) => (
        <div className="question-editor" key={question.id}>
          <div className="question-editor-title">
            <strong>第 {question.number} 题</strong>
            <button
              title="删除小题"
              onClick={() =>
                onChange((draft) => {
                  if (draft.type !== "subjective") return;
                  const isScoreQuestion = isBlankBlock && draft.questions[0]?.id === question.id;
                  const blockScore = draft.questions[0]?.score ?? 0;
                  draft.questions = draft.questions.filter((item) => item.id !== question.id);
                  if (isScoreQuestion && draft.questions[0]) {
                    draft.questions[0].score = blockScore;
                    draft.questions[0].style = "manual_score_grid";
                  }
                })
              }
            >
              <Trash2 size={15} />
            </button>
          </div>
          <div className="two-col">
            <label>
              题号
              <input value={question.number} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.number = event.target.value))} />
            </label>
            {isBlankBlock ? (
              <label>
                横线宽(mm)
                <input
                  type="number"
                  min={8}
                  value={question.blanks?.widthMm ?? 22}
                  onChange={(event) =>
                    updateQuestion(
                      question.id,
                      (draft) => void (draft.blanks = { ...(draft.blanks ?? { count: 1, heightMm: 6, labelStyle: "none" }), widthMm: Number(event.target.value) })
                    )
                  }
                />
              </label>
            ) : (
              <label>
                分值
                <input type="number" min={0} step={0.5} value={question.score} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.score = Number(event.target.value)))} />
              </label>
            )}
          </div>
          {isBlankBlock ? (
            <div className="three-col">
              <label>
                空数
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={question.blanks?.count ?? 1}
                  onChange={(event) =>
                    updateQuestion(
                      question.id,
                      (draft) => void (draft.blanks = { ...(draft.blanks ?? { widthMm: 22, heightMm: 6, labelStyle: "none" }), count: Number(event.target.value) })
                    )
                  }
                />
              </label>
              <label>
                横线高度(mm)
                <input
                  type="number"
                  min={4}
                  value={question.blanks?.heightMm ?? 6}
                  onChange={(event) =>
                    updateQuestion(
                      question.id,
                      (draft) => void (draft.blanks = { ...(draft.blanks ?? { count: 1, widthMm: 22, labelStyle: "none" }), heightMm: Number(event.target.value) })
                    )
                  }
                />
              </label>
              <label>
                序号类型
                <select
                  value={question.blanks?.labelStyle ?? "none"}
                  onChange={(event) =>
                    updateQuestion(
                      question.id,
                      (draft) =>
                        void (draft.blanks = {
                          ...(draft.blanks ?? { count: 1, widthMm: 22, heightMm: 6 }),
                          labelStyle: event.target.value as BlankLabelStyle
                        })
                    )
                  }
                >
                  {Object.entries(blankLabelStyleLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <>
              <label>
                主观题样式
                <select value={question.style} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.style = event.target.value as SubjectiveStyle))}>
                  {Object.entries(styleLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                作答区类型
                <select value={question.kind} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.kind = event.target.value as SubjectiveKind))}>
                  {Object.entries(kindLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                最小高度(mm)
                <input type="number" min={24} max={220} value={question.minHeightMm} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.minHeightMm = Number(event.target.value)))} />
              </label>
            </>
          )}
          {question.kind === "blank" && !isBlankBlock && (
            <div className="three-col">
              <label>
                空数
                <input type="number" min={1} value={question.blanks?.count ?? 4} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.blanks = { ...(draft.blanks ?? { widthMm: 28, heightMm: 6 }), count: Number(event.target.value) }))} />
              </label>
              <label>
                宽
                <input type="number" min={8} value={question.blanks?.widthMm ?? 28} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.blanks = { ...(draft.blanks ?? { count: 4, heightMm: 6 }), widthMm: Number(event.target.value) }))} />
              </label>
              <label>
                高
                <input type="number" min={4} value={question.blanks?.heightMm ?? 6} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.blanks = { ...(draft.blanks ?? { count: 4, widthMm: 28 }), heightMm: Number(event.target.value) }))} />
              </label>
            </div>
          )}
          {!isBlankBlock && (
            <>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={question.lineGrid?.enabled ?? false}
                  onChange={(event) => updateQuestion(question.id, (draft) => void (draft.lineGrid = { ...(draft.lineGrid ?? { lineSpacingMm: 8 }), enabled: event.target.checked }))}
                />
                使用横线格
              </label>
              <label>
                横线间距(mm)
                <input
                  type="number"
                  min={5}
                  max={16}
                  value={question.lineGrid?.lineSpacingMm ?? 8}
                  onChange={(event) => updateQuestion(question.id, (draft) => void (draft.lineGrid = { ...(draft.lineGrid ?? { enabled: true }), lineSpacingMm: Number(event.target.value) }))}
                />
              </label>
              <label className="upload-button">
                <ImagePlus size={16} /> 插入图片
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void onUpload(block.id, question.id, file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              {(question.images ?? []).map((image, index) => (
                <div className="image-row" key={`${image.assetId}_${index}`}>
                  <span>{image.originalName ?? image.assetId}</span>
                  <input type="number" min={10} value={image.widthMm} onChange={(event) => updateQuestion(question.id, (draft) => void ((draft.images![index].widthMm = Number(event.target.value))))} />
                  <input type="number" min={10} value={image.heightMm} onChange={(event) => updateQuestion(question.id, (draft) => void ((draft.images![index].heightMm = Number(event.target.value))))} />
                </div>
              ))}
            </>
          )}
        </div>
      ))}
      <button
        className="ghost-button"
        onClick={() =>
          onChange((draft) => {
            if (draft.type !== "subjective") return;
            const next = Math.max(0, ...draft.questions.map((item) => numericQuestionValue(item.number))) + 1;
            draft.questions.push(isBlankBlock ? defaultBlankQuestion(next) : defaultSubjective(next).questions[0]);
          })
        }
      >
        <Plus size={16} /> {isBlankBlock ? "添加填空题" : "添加主观小题"}
      </button>
    </>
  );
}

function CardPreview({ card, layout }: { card: AnswerCard; layout: LayoutDocument }) {
  return (
    <div className="pages">
      {layout.pages.map((page) => (
        <svg className="page" key={page.pageNumber} viewBox="0 0 210 297" role="img" aria-label={`第${page.pageNumber}页预览`}>
          <rect x="0" y="0" width="210" height="297" fill="#fff" />
          {page.markers.map((marker) => (
            <rect key={marker.role} {...marker.rect} fill="#20342f" />
          ))}
          <text x={page.header.idTextX} y={page.header.idTextY} className="svg-small">
            ID:{page.header.id}
          </text>
          {page.header.codeBoxes.map((box, index) => (
            <rect key={index} {...box} fill={index === 0 || index === page.header.codeBoxes.length - 1 ? "#20342f" : "#fff"} stroke="#222" strokeWidth="0.25" />
          ))}
          {page.header.title && (
            <text x="105" y={page.header.titleY} textAnchor="middle" className="svg-title">
              {page.header.title}
            </text>
          )}
          {page.studentArea && <StudentAreaSvg area={page.studentArea} />}
          {page.blocks.map((block, index) =>
            block.type === "objective" ? <ObjectiveSvg block={block} key={`${block.blockId}_${index}`} /> : <SubjectiveSvg card={card} block={block} key={`${block.blockId}_${index}`} />
          )}
          <text x="105" y="284" textAnchor="middle" className="svg-footer">
            第{page.pageNumber}页/共{layout.pages.length}页
          </text>
        </svg>
      ))}
    </div>
  );
}

function StudentAreaSvg({ area }: { area: NonNullable<LayoutDocument["pages"][number]["studentArea"]> }) {
  const rowCount = Math.max(...area.digitCells.map((cell) => cell.digitIndex)) + 1;
  const separatorX = area.digitRect.x + 8.5;
  return (
    <g>
      <rect {...area.infoRect} fill="none" stroke="#333" strokeWidth="0.25" />
      <rect {...area.digitRect} fill="none" stroke="#333" strokeWidth="0.25" />
      <text x={area.digitRect.x + area.digitRect.width / 2} y={area.digitRect.y + 5.2} textAnchor="middle" className="svg-label">
        填涂号区
      </text>
      <text x={area.infoRect.x + 5} y={area.infoRect.y + 13.5} className="svg-label">
        姓名：
      </text>
      <line x1={area.infoRect.x + 18} y1={area.infoRect.y + 14.5} x2={area.infoRect.x + area.infoRect.width - 9} y2={area.infoRect.y + 14.5} stroke="#333" strokeWidth="0.25" />
      <text x={area.infoRect.x + 5} y={area.infoRect.y + 25.5} className="svg-label">
        班级：
      </text>
      <line x1={area.infoRect.x + 18} y1={area.infoRect.y + 26.5} x2={area.infoRect.x + area.infoRect.width - 9} y2={area.infoRect.y + 26.5} stroke="#333" strokeWidth="0.25" />
      {Array.from({ length: rowCount }).map((_, row) => (
        <line key={row} x1={area.digitRect.x} y1={area.digitRect.y + 7 + row * 4.8} x2={area.digitRect.x + area.digitRect.width} y2={area.digitRect.y + 7 + row * 4.8} stroke="#999" strokeWidth="0.15" />
      ))}
      <line x1={separatorX} y1={area.digitRect.y + 7} x2={separatorX} y2={area.digitRect.y + area.digitRect.height} stroke="#333" strokeWidth="0.2" />
      {area.digitCells.map((cell) => (
        <g key={`${cell.digitIndex}_${cell.digit}`}>
          <rect {...cell.rect} fill="#fff" stroke="#333" strokeWidth="0.15" />
          <text x={cell.rect.x + cell.rect.width / 2} y={cell.rect.y + cell.rect.height / 2} textAnchor="middle" dominantBaseline="middle" className="svg-tiny">
            {cell.digit}
          </text>
        </g>
      ))}
    </g>
  );
}

function ObjectiveSvg({ block }: { block: Extract<PageRenderBlock, { type: "objective" }> }) {
  return (
    <g>
      <text x={block.rect.x} y={block.rect.y + 4.4} className="svg-section">
        {block.title}
      </text>
      <rect {...block.frameRect} fill="none" stroke="#222" strokeWidth="0.25" />
      {block.rowMarkers.map((marker) => (
        <g key={marker.row}>
          <rect {...marker.left} fill="#20342f" />
          <rect {...marker.right} fill="#20342f" />
        </g>
      ))}
      {block.items.map((item) => (
        <g key={item.questionNumber}>
          <text x={item.labelX - 2.5} y={(item.options[0]?.rect.y ?? item.labelY) + (item.options[0]?.rect.height ?? 0) / 2 - 0.28} dominantBaseline="middle" className="svg-option-label">
            {item.questionNumber}
          </text>
          {item.options.map((option) => (
            <g key={option.label}>
              <rect {...option.rect} fill="#fff" stroke="#333" strokeWidth="0.15" />
              <text x={option.rect.x + option.rect.width / 2} y={option.rect.y + option.rect.height / 2 - 0.28} textAnchor="middle" dominantBaseline="middle" className="svg-option-label">
                {option.label}
              </text>
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}

function SubjectiveSvg({ card, block }: { card: AnswerCard; block: Extract<PageRenderBlock, { type: "subjective" }> }) {
  return (
    <g>
      {block.title && (
        <text x={block.rect.x} y={block.rect.y + 4.4} className="svg-section">
          {block.title}
        </text>
      )}
      {block.frameRect && <rect {...block.frameRect} fill="none" stroke="#222" strokeWidth="0.25" />}
      {block.questions.map((question) => (
        <g key={question.questionId}>
          {!block.frameRect && <rect {...question.rect} fill="none" stroke="#222" strokeWidth="0.25" />}
          {question.style === "manual_score_grid" && (
            <>
              {block.frameRect && question.kind === "blank" && question.scoreCells.length > 0 ? (
                <>
                  <text x={block.frameRect.x + 4} y={question.scoreCells[0].rect.y + 4.2} className="svg-tiny">
                    得分
                  </text>
                  <line
                    x1={block.frameRect.x}
                    y1={question.scoreCells[0].rect.y + question.scoreCells[0].rect.height + 2}
                    x2={block.frameRect.x + block.frameRect.width}
                    y2={question.scoreCells[0].rect.y + question.scoreCells[0].rect.height + 2}
                    stroke="#777"
                    strokeWidth="0.2"
                    strokeDasharray="1.5 1.5"
                  />
                </>
              ) : (
                <line x1={question.rect.x} y1={question.contentRect.y} x2={question.rect.x + question.rect.width} y2={question.contentRect.y} stroke="#777" strokeWidth="0.2" strokeDasharray="1.5 1.5" />
              )}
              {question.scoreCells.map((cell) => (
                <g key={cell.score}>
                  <rect {...cell.rect} fill="#fff" stroke="#222" strokeWidth="0.2" />
                  <text x={cell.rect.x + cell.rect.width / 2} y={cell.rect.y + 4.2} textAnchor="middle" className="svg-tiny">
                    {cell.score}
                  </text>
                </g>
              ))}
            </>
          )}
          {question.kind === "blank" ? (
            <text x={question.contentRect.x + 3} y={question.contentRect.y + 7.2} className="svg-tiny">
              {question.questionNumber}
            </text>
          ) : (
            <text x={question.rect.x + 2} y={question.contentRect.y + 6} className="svg-tiny">
              {question.questionNumber}.（{question.score}分）
            </text>
          )}
          {question.lineYs.map((lineY) => (
            <line key={lineY} x1={question.contentRect.x + 8} y1={lineY} x2={question.contentRect.x + question.contentRect.width - 6} y2={lineY} stroke="#888" strokeWidth="0.2" />
          ))}
          {question.blanks.map((blank, index) => {
            const blankLabel = question.kind === "blank" ? formatBlankLabel(question.blankLabelStyle, index) : `${question.questionNumber}.${index + 1}`;
            return (
              <g key={index}>
                {blankLabel && (
                  <text x={blank.x - 0.8} y={blank.y + blank.height} textAnchor="end" dominantBaseline="middle" className="svg-blank-label">
                    {blankLabel}
                  </text>
                )}
                <line x1={blank.x} y1={blank.y + blank.height} x2={blank.x + blank.width} y2={blank.y + blank.height} stroke="#333" strokeWidth="0.25" />
              </g>
            );
          })}
          {question.images.map((image) => (
            <g key={image.assetId}>
              <image href={`/assets/${card.id}/${image.assetId}`} x={image.rect.x} y={image.rect.y} width={image.rect.width} height={image.rect.height} preserveAspectRatio="xMidYMid meet" />
              <rect {...image.rect} fill="none" stroke="#666" strokeWidth="0.18" />
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}

export default App;
