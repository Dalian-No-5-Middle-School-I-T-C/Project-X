import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  Download,
  FileDown,
  FolderOpen,
  ImagePlus,
  Layers,
  ListPlus,
  Plus,
  Save,
  Search,
  BookOpen,
  FileUp,
  Home,
  SquarePen,
  Trash2,
  Upload,
  Users
} from "lucide-react";
import { useAuth } from "./auth/AuthContext";
import { apiUrl, authFetch, fetchJson, mediaUrl, urlWithToken } from "./auth/api";
import { PERMISSIONS } from "./auth/types";
import { LoginPage } from "./components/LoginPage";
import { AccountMenu } from "./components/AccountMenu";
import { AccountManagement } from "./components/AccountManagement";
import { BeianFooter } from "./components/BeianFooter";
import { StudentScores } from "./components/StudentScores";
import { SponsorPage } from "./components/SponsorPage";
import { UserGuidePage } from "./components/UserGuidePage";
import { PermissionManager } from "./components/PermissionManager";
import { NewCardModal, type NewCardFormData } from "./components/NewCardModal";
import { PaperUploadPanel } from "./components/PaperUploadPanel";
import { ExamSelectPage } from "./components/ExamSelectPage";
import { ScoreDetailPage } from "./components/ScoreDetailPage";
import { AssignedFormulaModal } from "./components/AssignedFormulaModal";
import { CreateExamGroupModal } from "./components/CreateExamGroupModal";
import { ExamGroupDetailPage } from "./components/ExamGroupDetailPage";
import { GroupExportModal } from "./components/GroupExportModal";
import { HomePage } from "./components/HomePage";
import { GradePanel } from "./components/GradePanel";
import { ExamDetailPage } from "./components/ExamDetailPage";
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
  ObjectiveOptionLayout,
  PageRenderBlock,
  BlankItem,
  SubjectiveBlock,
  SubjectiveBlockKind,
  SubjectiveKind,
  SubjectiveQuestion,
  SubjectiveStyle
} from "../../../shared/types";
import {
  normalizeObjectiveAnswerKey,
  normalizeObjectiveQuestions,
  objectiveQuestionDefinitions,
  objectiveQuestionNumbers,
  optionLabelsForQuestion
} from "../../../shared/grading";
import {
  validateCardScores,
  type CardScoreValidationResult
} from "../../../shared/cardScoreValidation";
import { buildLayout } from "../../../shared/layout";
import { createBlockId } from "../../../shared/defaultCard";
import { formatBlankLabel } from "../../../shared/blankLabels";
import {
  getProjectXVariantConfig,
  type ProjectXAppMode,
  type ProjectXVariantConfig
} from "../../../shared/appVariant";
import { ScanPreviewModal, type ScanPage } from "./components/ScanPreviewModal";
import { ImportCardModal, type ImportCardFormData } from "./components/ImportCardModal";
import { AnalysisOverview } from "./components/AnalysisOverview";
import { AnalysisDistribution } from "./components/AnalysisDistribution";
import { AnalysisAiPanel } from "./components/AnalysisAiPanel";
import { AnalysisRanking } from "./components/AnalysisRanking";
import { AnalysisQuestions } from "./components/AnalysisQuestions";
import { AnalysisTrend } from "./components/AnalysisTrend";
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

const optionLayoutLabels: Record<ObjectiveOptionLayout, string> = {
  horizontal: "横向",
  vertical: "竖向（4题一组）"
};

type CardDeleteConflict = {
  cardId: string;
  cardTitle: string;
  referencedExamCount: number;
  referencedExamNames: string[];
  deleteReferencedExams: boolean;
};

type ExamDeleteTarget = {
  exams: ExamRecord[];
  deleteLinkedCards: boolean;
};

type GroupDeleteTarget = {
  groupId: number;
  groupName: string;
  memberCount: number;
  deleteExams: boolean;
};

type AutoSaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type PreviewMode = "fit-width" | "fit-page" | "fit-panel" | "custom";

const PREVIEW_SETTINGS_KEY = "projectx-card-preview-settings-v1";
const PREVIEW_MIN_PERCENT = 50;
const PREVIEW_MAX_PERCENT = 400;

type PdfWarningState = {
  validation: CardScoreValidationResult;
  pdfUrl: string;
  step: "score" | "paper" | "knowledge";  // 当前步骤
  paperInfo?: { hasPaper: boolean; filename?: string; mimeType?: string };
  knowledgeReady?: boolean;   // 知识点是否已分析
  knowledgePoints?: Array<{ question_number: number; points: string[] }>;  // 知识点列表
  cardId?: string;
};

const styleLabels: Record<SubjectiveStyle, string> = {
  manual_score_grid: "带分数填涂区",
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

function subjectiveBlockKind(block: SubjectiveBlock): SubjectiveBlockKind {
  if (block.blockKind) return block.blockKind;
  if (block.title.includes("解答")) return "answer";
  if (block.title.includes("作文")) return "essay";
  if (block.questions.length > 0 && block.questions.every((question) => question.kind === "blank")) return "fill_blank";
  return "answer";
}

function subjectiveBlockKindLabel(block: SubjectiveBlock): string {
  const kind = subjectiveBlockKind(block);
  if (kind === "fill_blank") return "填空题";
  if (kind === "essay") return "作文题";
  return "解答题";
}

function answerBlankItems(question: SubjectiveQuestion): BlankItem[] {
  const fallbackWidth = question.blanks?.widthMm ?? 32;
  const fallbackHeight = question.blanks?.heightMm ?? 6;
  if (question.blanks?.items?.length) {
    return question.blanks.items.map((item) => ({
      label: item.label ?? "",
      widthMm: item.widthMm || fallbackWidth,
      heightMm: item.heightMm || fallbackHeight,
      rightAnnotation: item.rightAnnotation
    }));
  }
  const count = Math.max(1, question.blanks?.count ?? 4);
  return Array.from({ length: count }, (_, index) => ({
    label: formatBlankLabel(question.blanks?.labelStyle ?? "arabic_parentheses", index),
    widthMm: fallbackWidth,
    heightMm: fallbackHeight
  }));
}

function cloneCard(card: AnswerCard): AnswerCard {
  return JSON.parse(JSON.stringify(card)) as AnswerCard;
}

type AppMode = ProjectXAppMode;

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
  variantConfig: ProjectXVariantConfig
): AppMode {
  const canOpenMode = (mode: AppMode): boolean => {
    if (!variantConfig.allowedModes.includes(mode)) return false;
    if (mode === "home") return true;
    if (mode === "scores") return hasPermission(PERMISSIONS.SCORE_READ);
    if (mode === "design") return hasPermission(PERMISSIONS.CARD_READ);
    if (mode === "exam-manage") return hasPermission(PERMISSIONS.EXAM_WRITE);
    if (mode === "analysis") return hasPermission(PERMISSIONS.EXAM_READ);
    if (mode === "account") return hasPermission(PERMISSIONS.USER_MANAGE);
    return false;
  };

  if (canOpenMode(variantConfig.defaultMode)) return variantConfig.defaultMode;
  return variantConfig.allowedModes.find(canOpenMode) ?? variantConfig.defaultMode;
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
  // L-S13: CSV 公式注入防御 — 对以 =, +, -, @, TAB, CR 开头的单元格加前缀单引号
  const csv = lines.map((line) => line.map((cell) => {
    const safe = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
    return `"${safe.replace(/"/g, '""')}"`;
  }).join(",")).join("\n");
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

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
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
    optionLayout: "horizontal",
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
    blockKind: "answer",
    title: "解答题",
    questions: [
      {
        id: createBlockId("q"),
        number: nextNumber,
        score: 12,
        style: "manual_score_grid",
        kind: "lined_answer",
        lineGrid: { enabled: true, lineSpacingMm: 8, fixedLineCount: 5, lineColor: "#222", lineWidthMm: 0.15, insetLeftMm: 8, insetRightMm: 6 },
        scoreGrid: { enabled: true, strokeColor: "#999", strokeWidthMm: 0.15, fillColor: "#fff", fontSize: 2.8, dividerColor: "#ccc", dividerWidthMm: 0.1, showLabel: true },
        images: [],
        minHeightMm: 54   // 14 + 5×8
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
    lineGrid: { enabled: false, lineSpacingMm: 8, lineColor: "#222", lineWidthMm: 0.15, insetLeftMm: 8, insetRightMm: 6 },
    images: [],
    minHeightMm: 14
  };
}

function defaultBlankBlock(nextNumber: number): SubjectiveBlock {
  return {
    id: createBlockId("subj"),
    type: "subjective",
    blockKind: "fill_blank",
    title: "填空题",
    questions: Array.from({ length: 10 }, (_, index) =>
      defaultBlankQuestion(nextNumber + index, index === 0 ? 15 : 0, index === 0 ? "manual_score_grid" : "plain_subjective")
    )
  };
}

function defaultEssayBlock(nextNumber: number): SubjectiveBlock {
  return {
    id: createBlockId("subj"),
    type: "subjective",
    blockKind: "essay",
    title: "作文",
    questions: [{
      id: createBlockId("q"),
      number: nextNumber,
      score: 60,
      style: "manual_score_grid",
      kind: "plain_box",
      lineGrid: { enabled: false, lineSpacingMm: 8, lineColor: "#222", lineWidthMm: 0.15, insetLeftMm: 8, insetRightMm: 6 },
      images: [],
      minHeightMm: 280,
      essayGrid: {
        columns: 0,
        rows: 0,
        cellWidthMm: 7,
        cellHeightMm: 7,
        targetChars: 600,
        showTitle: true,
        lineColor: "#222",
        lineWidthMm: 0.15,
      },
    }],
  };
}

function defaultAnswerBlankQuestion(nextNumber: number): SubjectiveQuestion {
  return {
    ...defaultBlankQuestion(nextNumber, 12, "manual_score_grid"),
    minHeightMm: 62,
    blanks: {
      count: 4,
      widthMm: 32,
      heightMm: 6,
      labelStyle: "arabic_parentheses",
      items: Array.from({ length: 4 }, (_, index) => ({
        label: `(${index + 1})`,
        widthMm: 32,
        heightMm: 6
      }))
    }
  };
}

function answerLineCount(question: SubjectiveQuestion): number {
  const spacing = Math.max(5, question.lineGrid?.lineSpacingMm ?? 8);
  return Math.max(1, Math.min(20, Math.ceil((question.minHeightMm - 14) / spacing)));
}

function heightForAnswerLines(lineCount: number, spacing: number): number {
  return 14 + Math.max(1, Math.min(20, lineCount)) * Math.max(5, spacing);
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

/** v1.8.0 — 导出检查卡片内的知识点分析小面板 */
function KnowledgeAnalysisInline({ cardId, onDone }: { cardId: string; onDone: (points: Array<{ question_number: number; points: string[] }>) => void }) {
  const [questionRange, setQuestionRange] = useState("全部");
  const [customRange, setCustomRange] = useState("");
  const [extraNotes, setExtraNotes] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setError(null);
    const range = questionRange === "all" ? "全部" : customRange.trim();
    if (!range) { setError("请输入题目范围"); setAnalyzing(false); return; }

    try {
      const res = await fetchJson<{ knowledgePoints?: Array<{ questionNumber: number; points: string[] }>; mode?: string; message?: string }>(
        `/api/cards/${cardId}/knowledge-points/analyze`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionRange: range, extraNotes: extraNotes.trim() }) }
      );
      if (res.message && (!res.knowledgePoints || res.knowledgePoints.length === 0)) {
        setError(res.message); setAnalyzing(false); return;
      }
      const pts = (res.knowledgePoints || []).map(k => ({ question_number: k.questionNumber || (k as any).question_number, points: k.points }));
      // Auto-save
      await fetchJson(`/api/cards/${cardId}/knowledge-points`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: pts.flatMap(p => p.points.map(pt => ({ question_number: p.question_number, point_text: pt }))) })
      }).catch(() => {});
      onDone(pts);
    } catch (e: any) {
      setError(e?.message || "AI 服务暂时不可用，请检查 llmclient 是否启动");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div>
      <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>题目范围 *</h4>
      <label className="radio-label">
        <input type="radio" name="kpRange" checked={questionRange === "all"} onChange={() => setQuestionRange("all")} />
        全部题目
      </label>
      <label className="radio-label">
        <input type="radio" name="kpRange" checked={questionRange === "custom"} onChange={() => setQuestionRange("custom")} />
        自定义范围
      </label>
      {questionRange === "custom" && (
        <input type="text" className="text-input" placeholder="如：第1-15题、选择题"
          value={customRange} onChange={(e) => setCustomRange(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
      )}
      <textarea className="textarea-input" placeholder="特别描述（可选）" value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} rows={2} style={{ width: "100%", marginBottom: 8 }} />
      {error && <p className="field-error" style={{ marginBottom: 8 }}>{error}</p>}
      <button className="primary-button" type="button" onClick={handleAnalyze} disabled={analyzing}>
        {analyzing ? "分析中..." : "🤖 开始分析"}
      </button>
      {analyzing && <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>正在调用 AI 分析，约需 10-30 秒...</p>}
    </div>
  );
}

function App() {
  const { user, loading, hasPermission, persona, teacherRoleOverride } = useAuth();
  // v1.6.0: 运行时 persona 替换 compile-time VITE_PROJECTX_VARIANT
  const appVariant = useMemo(
    () => getProjectXVariantConfig(persona),
    [persona]
  );
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [card, setCard] = useState<AnswerCard | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [mode, setMode] = useState<AppMode>("home");
  const modeInitialized = useRef(false);
  const showTabBar = (user as any)?.show_tab_bar === 1;
  const [selectedExamId, setSelectedExamId] = useState<number | null>(null);
  const [gradingPanel, setGradingPanel] = useState<{ examId: number; blockId: string } | null>(null);
  const previousModeRef = useRef<AppMode>("home");
  const latestCardRef = useRef<AnswerCard | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const editRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const [gradingFiles, setGradingFiles] = useState<File[]>([]);
  const [gradingExamId, setGradingExamId] = useState<string>("");
  const [cardOverride, setCardOverride] = useState(false);  // 阅卷时是否手动覆盖答题卡
  const [gradingResult, setGradingResult] = useState<CombinedGradingBatchResult | null>(null);
  const [gradingProgress, setGradingProgress] = useState<GradingProgress>({ active: false, finished: 0, total: 0 });
  const [status, setStatus] = useState("准备就绪");
  const [isBusy, setIsBusy] = useState(false);
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>("idle");
  const gradingProgressSourceRef = useRef<EventSource | null>(null);
  // Note: Scanner has been split into a separate build (ScannerApp.tsx).
  // Web mode never renders ScannerPanel; the "扫描仪录入" button is removed.
  const [analysisExamId, setAnalysisExamId] = useState<number | null>(null);
  const [analysisClassId, setAnalysisClassId] = useState<string>("");
  const [analysisClasses, setAnalysisClasses] = useState<Array<{ classId: number; className: string }>>([]);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [analysisOverview, setAnalysisOverview] = useState<ExamOverview | null>(null);
  const [analysisRanking, setAnalysisRanking] = useState<StudentRankingItem[]>([]);
  const [analysisQuestions, setAnalysisQuestions] = useState<QuestionAnalysisItem[]>([]);
  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [examListRefreshKey, setExamListRefreshKey] = useState(0);
  // Exam groups
  const [examGroups, setExamGroups] = useState<Array<{ id: number; name: string; tag: string | null; grade_name: string | null; member_count: number; has_results: number; created_at: string }>>([]);
  const [showCreateExam, setShowCreateExam] = useState(false);
  const [showImportCardModal, setShowImportCardModal] = useState(false);
  const [importCardData, setImportCardData] = useState<{ card?: { title?: string; subject?: string; subjectLabel?: string; examDate?: string } } | null>(null);
  const [newExamName, setNewExamName] = useState("");
  const [newExamSubject, setNewExamSubject] = useState("");
  const [newExamCardId, setNewExamCardId] = useState("");
  const [selectedExamIds, setSelectedExamIds] = useState<Set<number>>(new Set());
  // Exam groups
  const [examManageMode, setExamManageMode] = useState<"single" | "group">("single");
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [analysisGroupId, setAnalysisGroupId] = useState<number | null>(null);
  const [showGroupExport, setShowGroupExport] = useState(false);
  const [analysisTab, setAnalysisTab] = useState<"select" | "view" | "trend" | "detail">("select");
  const [selectedAnalysisExamId, setSelectedAnalysisExamId] = useState<number | null>(null);
  const [showNewCardModal, setShowNewCardModal] = useState(false);
  const [showPaperPanel, setShowPaperPanel] = useState(false);
  const [paperPanelCardId, setPaperPanelCardId] = useState<string | null>(null);
  const [cardDeleteConflict, setCardDeleteConflict] = useState<CardDeleteConflict | null>(null);
  const [examDeleteTarget, setExamDeleteTarget] = useState<ExamDeleteTarget | null>(null);
  const [groupDeleteTarget, setGroupDeleteTarget] = useState<GroupDeleteTarget | null>(null);
  const [assignedFormulaExamId, setAssignedFormulaExamId] = useState<number | null>(null);
  const [showBg, setShowBg] = useState(0); // opacity 0~1, 0=关闭
  const [paperPreviewOpen, setPaperPreviewOpen] = useState<string | null>(null);
  const [paperZoom, setPaperZoom] = useState(1);
  const [exportCheck, setExportCheck] = useState<PdfWarningState | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return (localStorage.getItem("projectx-theme") as "light" | "dark") || "light";
    } catch {
      return "light";
    }
  });

  const layout = useMemo<LayoutDocument | null>(() => (card ? buildLayout(card) : null), [card]);
  const autoSaveLabel =
    autoSaveState === "dirty"
      ? "有未保存更改"
      : autoSaveState === "saving"
        ? "正在自动保存"
        : autoSaveState === "saved"
          ? "已自动保存"
          : autoSaveState === "error"
            ? "自动保存失败"
            : "";

  const variantAllows = useCallback(
    (modeName: AppMode) => appVariant.allowedModes.includes(modeName),
    [appVariant]
  );

  // 扫描 TAB：需要 variant 允许扫描 + grading 权限 + 本地有扫描硬件
  const canDesign = variantAllows("design") && hasPermission(PERMISSIONS.CARD_READ);
  const canManageExams = variantAllows("exam-manage") && hasPermission(PERMISSIONS.EXAM_WRITE);
  const canGrade = hasPermission(PERMISSIONS.GRADE_READ);
  const canAnalyze = variantAllows("analysis") && hasPermission(PERMISSIONS.EXAM_READ);
  const canWriteExam = hasPermission(PERMISSIONS.EXAM_WRITE);
  const canViewScores = variantAllows("scores") && hasPermission(PERMISSIONS.SCORE_READ);
  const canManageAccounts = variantAllows("account") && hasPermission(PERMISSIONS.USER_MANAGE);
  const showCardSidebar = mode === "design" && canDesign;
  const showScoresTab = canViewScores;

  // ── 移动端底部导航配置 ──
  const mobileNavItems = useMemo(() => {
    type NavItem = {
      id: AppMode;
      icon: ReactElement;
      label: string;
      shortLabel: string;
      onEnter?: () => void | Promise<void>;
    };
    const items: NavItem[] = [];
    items.push({ id: "home", icon: <Home size={22} />, label: "首页", shortLabel: "首页" });
    if (canDesign) {
      items.push({ id: "design", icon: <SquarePen size={22} />, label: "答题卡设计", shortLabel: "设计" });
    }
    if (canManageExams) {
      items.push({ id: "exam-manage", icon: <ClipboardList size={22} />, label: "考试管理", shortLabel: "考试", onEnter: async () => { await loadExams(); await loadExamGroups(); } });
    }
    if (canAnalyze) {
      items.push({ id: "analysis", icon: <BarChart3 size={22} />, label: "成绩分析", shortLabel: "分析", onEnter: loadExams });
    }
    if (showScoresTab) {
      items.push({ id: "scores", icon: <BarChart3 size={22} />, label: "我的成绩", shortLabel: "成绩" });
    }
    if (canManageAccounts) {
      items.push({ id: "account", icon: <Users size={22} />, label: "账号管理", shortLabel: "账号" });
    }
    // 移动端最多5个Tab
    return items.slice(0, 5);
  }, [canDesign, canManageExams, canGrade, canAnalyze, showScoresTab, canManageAccounts, loadExams, loadExamGroups]);

  useEffect(() => {
    latestCardRef.current = card;
  }, [card]);

  useEffect(() => {
    if (user && !modeInitialized.current) { modeInitialized.current = true;
      setMode(defaultModeForUser(hasPermission, appVariant)); }
  }, [user?.id, hasPermission, appVariant]);

  useEffect(() => {
    const flushOnHide = () => {
      if (document.visibilityState === "hidden") {
        saveCurrentCardBestEffort();
      }
    };
    const flushOnPageHide = () => saveCurrentCardBestEffort();
    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushOnHide);
    window.addEventListener("beforeunload", flushOnPageHide);
    return () => {
      clearAutoSaveTimer();
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushOnHide);
      window.removeEventListener("beforeunload", flushOnPageHide);
    };
  }, []);

  useEffect(() => {
    if (!user || (!canDesign && !canGrade)) return;
    void refreshCards(canDesign);
  }, [user?.id, canDesign, canGrade]);

  // 加载用户设置（背景图等）
  useEffect(() => {
    if (!user) return;
    fetchJson<{ backgroundOpacity: number }>("/api/users/me/settings")
      .then((s) => { if (s) setShowBg(s.backgroundOpacity ?? 0); })
      .catch(() => {});
  }, [user?.id]);

  // 背景图：body::after 半透明浮层 (pointer-events:none 不挡交互)
  useEffect(() => {
    if (showBg > 0) {
      document.documentElement.style.setProperty("--bg-opacity", String(showBg));
      document.body.classList.add("has-bg-image");
    } else {
      document.documentElement.style.setProperty("--bg-opacity", "0");
      document.body.classList.remove("has-bg-image");
    }
    return () => {
      document.body.classList.remove("has-bg-image");
    };
  }, [showBg]);

  // 日间/夜间模式切换
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("projectx-theme", theme);
    } catch {
      /* private browsing / storage disabled */
    }
  }, [theme]);

  useEffect(() => {
    return () => {
      gradingProgressSourceRef.current?.close();
    };
  }, []);

  // 全局 ESC 返回上一级 (v1.4.7)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // 检查是否有输入框聚焦，跳过（让用户正常退出输入）
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // 检查是否有 modal overlay 打开（modal 自行处理 ESC）
      if (document.querySelector(".modal-overlay")) return;

      // 成绩分析子页 → 返回考试选择
      if (mode === "analysis" && analysisTab !== "select") {
        setSelectedAnalysisExamId(null);
        setAnalysisTab("select");
        return;
      }
      // 赞助/使用说明 → 返回上一模式
      if (mode === "sponsor" || mode === "guide" || mode === "permissions") {
        setMode(previousModeRef.current);
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, analysisTab]);

  // 进入阅卷模式时预加载考试列表
  useEffect(() => {
    if (mode === "exam-manage" && exams.length === 0) {
      loadExams();
    }
  }, [mode, exams.length]);

  function clearAutoSaveTimer() {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }

  function acceptSavedCard(nextCard: AnswerCard | null, state: AutoSaveState = "idle") {
    clearAutoSaveTimer();
    if (nextCard) autoNameBlocks(nextCard);
    editRevisionRef.current += 1;
    savedRevisionRef.current = editRevisionRef.current;
    latestCardRef.current = nextCard;
    setCard(nextCard);
    setAutoSaveState(nextCard ? state : "idle");
  }

  function scheduleAutoSave() {
    clearAutoSaveTimer();
    autoSaveTimerRef.current = window.setTimeout(() => {
      void flushPendingCardSave("auto");
    }, 1200);
  }

  async function persistCardSnapshot(
    snapshot: AnswerCard,
    revision: number,
    source: "auto" | "manual" | "switch" | "pdf" = "manual"
  ): Promise<AnswerCard> {
    setAutoSaveState("saving");
    if (source !== "auto") {
      setIsBusy(true);
      setStatus(source === "pdf" ? "正在保存并检查分值..." : "正在保存答题卡...");
    }
    try {
      const saved = await fetchJson<AnswerCard>(`/api/cards/${snapshot.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot)
      });

      const stillCurrent = latestCardRef.current?.id === snapshot.id;
      const noNewerEdits = editRevisionRef.current === revision;
      if (stillCurrent && noNewerEdits) {
        autoNameBlocks(saved);
        latestCardRef.current = saved;
        savedRevisionRef.current = revision;
        setCard(saved);
        setAutoSaveState("saved");
      } else if (stillCurrent) {
        scheduleAutoSave();
      }

      try {
        await refreshCards();
      } catch {
        // Saving succeeded; a stale sidebar timestamp is less important than preserving edits.
      }

      if (source === "auto") setStatus("已自动保存");
      else if (source === "pdf") setStatus("已保存，正在检查分值");
      else if (source === "switch") setStatus("已保存当前答题卡");
      else setStatus("已保存，并生成坐标布局数据");
      return saved;
    } catch (err) {
      setAutoSaveState("error");
      const message = err instanceof Error ? err.message : String(err);
      setStatus(source === "auto" ? `自动保存失败：${message}` : `保存失败：${message}`);
      throw err;
    } finally {
      if (source !== "auto") setIsBusy(false);
    }
  }

  async function flushPendingCardSave(
    source: "auto" | "manual" | "switch" | "pdf" = "manual",
    force = false
  ): Promise<AnswerCard | null> {
    clearAutoSaveTimer();
    const snapshot = latestCardRef.current;
    if (!snapshot) return null;
    const revision = editRevisionRef.current;
    if (!force && revision === savedRevisionRef.current) return snapshot;
    return persistCardSnapshot(cloneCard(snapshot), revision, source);
  }

  function saveCurrentCardBestEffort() {
    const snapshot = latestCardRef.current;
    if (!snapshot || editRevisionRef.current === savedRevisionRef.current) return;
    clearAutoSaveTimer();
    const revision = editRevisionRef.current;
    void authFetch(`/api/cards/${snapshot.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
      keepalive: true
    }).then((response) => {
      if (response.ok && editRevisionRef.current === revision) {
        savedRevisionRef.current = revision;
        setAutoSaveState("saved");
      }
    }).catch(() => undefined);
  }

  async function refreshCards(loadFirst = false) {
    const list = asArray<CardSummary>(await fetchJson<CardSummary[]>("/api/cards"));
    setCards(list);
    if (loadFirst && list.length > 0) {
      await loadCard(list[0].id);
    }
  }

  async function createCard(formData: NewCardFormData) {
    setShowNewCardModal(false);
    try {
      await flushPendingCardSave("switch");
    } catch {
      // 保存当前卡失败，刷新列表后退出（避免侧栏状态不一致）
      await refreshCards();
      return;
    }
    setIsBusy(true);
    try {
      const created = await fetchJson<AnswerCard>("/api/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: formData.subject,
          subjectLabel: formData.subjectLabel,
          title: formData.title,
          examDate: formData.examDate,
          englishListening: formData.englishListening,
          chineseChoicePlacement: formData.chineseChoicePlacement,
          paperSize: formData.paperSize
        })
      });
      acceptSavedCard(created, "saved");
      setSelectedBlockId(created.bodyBlocks[0]?.id ?? null);

      // 处理考试关联
      let statusExtra = "";
      if (formData.examAction === "create") {
        const examName = formData.examName || formData.title;
        try {
          await fetchJson<any>("/api/exams", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: examName, cardId: created.id, subject: formData.subjectLabel })
          });
          statusExtra = "，已同步创建考试";
          await loadExams();
        } catch (err: any) {
          statusExtra = `，考试创建失败：${err?.message || "已存在同名考试"}`;
        }
      } else if (formData.examAction === "link" && formData.linkExamId) {
        try {
          await fetchJson(`/api/exams/${formData.linkExamId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cardId: created.id })
          });
          statusExtra = "，已关联到已有考试";
          await loadExams();
        } catch (err: any) {
          statusExtra = `，关联考试失败：${err?.message || "考试不存在"}`;
        }
      }

      setStatus(`已创建答题卡 「${created.title}」 (${created.id})${statusExtra}`);

      // v1.8.0: 自动弹出原卷上传面板
      const userSettings = await fetchJson<{ requireOriginalPaper?: number }>("/api/users/me/settings").catch((): { requireOriginalPaper?: number } => ({}));
      if (userSettings.requireOriginalPaper !== 0) {
        setPaperPanelCardId(created.id);
        setShowPaperPanel(true);
      }
    } finally {
      await refreshCards();
      setIsBusy(false);
    }
  }

  async function loadCard(id: string) {
    if (latestCardRef.current?.id === id) {
      try {
        await flushPendingCardSave("switch");
      } catch {
        // Status is set by the shared save path.
      }
      return;
    }
    try {
      await flushPendingCardSave("switch");
    } catch {
      return;
    }
    setIsBusy(true);
    try {
      const loaded = await fetchJson<AnswerCard>(`/api/cards/${id}`);
      acceptSavedCard(loaded, "saved");
      setSelectedBlockId(loaded.bodyBlocks[0]?.id ?? null);
      setGradingResult(null);
      setStatus(`已载入 ${loaded.title}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function saveCard() {
    if (!card) return;
    try {
      await flushPendingCardSave("manual", true);
    } catch {
      // Status is set by the shared save path.
    }
  }

  async function deleteCard(
    cardId: string,
    options: { unlinkExams?: boolean; deleteReferencedExams?: boolean } = {}
  ): Promise<boolean> {
    setIsBusy(true);
    try {
      const result = await fetchJson<{ ok: boolean; referencedExamCount: number; referencedExamNames: string[] }>(
        `/api/cards/${cardId}`,
        {
          method: "DELETE",
          headers: Object.keys(options).length > 0 ? { "Content-Type": "application/json" } : undefined,
          body: Object.keys(options).length > 0 ? JSON.stringify(options) : undefined
        }
      );
      setStatus(result.referencedExamCount > 0
        ? `已删除答题卡，并处理 ${result.referencedExamCount} 个关联考试`
        : "已删除答题卡");
      if (card?.id === cardId) {
        acceptSavedCard(null);
        setSelectedBlockId(null);
      }
      await refreshCards();
      await loadExams();
      return true;
    } catch (err) {
      const error = err as Error & {
        status?: number;
        referencedExamCount?: number;
        referencedExamNames?: string[];
      };
      if (error.status === 409 && typeof error.referencedExamCount === "number") {
        const target = cards.find((item) => item.id === cardId);
        setCardDeleteConflict({
          cardId,
          cardTitle: target?.title || cardId,
          referencedExamCount: error.referencedExamCount,
          referencedExamNames: Array.isArray(error.referencedExamNames) ? error.referencedExamNames : [],
          deleteReferencedExams: false
        });
        const names = Array.isArray(error.referencedExamNames) && error.referencedExamNames.length > 0
          ? `（${error.referencedExamNames.join("、")}）`
          : "";
        setStatus(`答题卡已被 ${error.referencedExamCount} 个考试引用${names}，请确认处理方式`);
      } else {
        setStatus(`删除失败：${error.message}`);
      }
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteExams(target: ExamDeleteTarget): Promise<boolean> {
    setIsBusy(true);
    try {
      const linkedCardIds = Array.from(new Set(target.exams.map((exam) => exam.card_id).filter((id): id is string => Boolean(id))));
      for (const exam of target.exams) {
        await fetchJson(`/api/exams/${exam.id}`, { method: "DELETE" });
      }
      setSelectedExamIds(new Set());
      if (analysisExamId && target.exams.some((exam) => exam.id === analysisExamId)) {
        setAnalysisExamId(null);
        setAnalysisOverview(null);
        setAnalysisRanking([]);
        setAnalysisQuestions([]);
      }
      await loadExams();
      if (target.deleteLinkedCards) {
        for (const linkedCardId of linkedCardIds) {
          const deleted = await deleteCard(linkedCardId);
          if (!deleted) return false;
        }
      }
      setStatus(target.deleteLinkedCards
        ? `已删除 ${target.exams.length} 个考试，并删除关联答题卡`
        : target.exams.length > 1 ? `已删除 ${target.exams.length} 个考试` : "已删除考试");
      return true;
    } catch (err) {
      setStatus(`删除考试失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function exportCard(cardId: string) {
    // v1.8.0: 检查原卷是否上传
    try {
      const cardInfo = await fetchJson<{ has_original_paper?: number }>(`/api/cards/${cardId}/paper/info`);
      const settings = await fetchJson<{ requireOriginalPaper?: number }>("/api/users/me/settings").catch((): { requireOriginalPaper?: number } => ({}));
      if (settings.requireOriginalPaper !== 0 && !cardInfo?.has_original_paper) {
        if (confirm("此答题卡尚未上传原卷，根据当前设置不允许导出。是否现在上传原卷？")) {
          setPaperPanelCardId(cardId);
          setShowPaperPanel(true);
        }
        return;
      }
    } catch { /* fall through */ }

    const a = document.createElement("a");
    a.href = urlWithToken(`/api/cards/${cardId}/export`);
    a.download = `答题卡_${cardId}.projectx-card.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("正在导出答题卡...");
  }

  function openPdf(pdfUrl: string) {
    const opened = window.open(pdfUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      const a = document.createElement("a");
      a.href = pdfUrl;
      a.target = "_blank";
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  async function showExportCheck(savedCard: AnswerCard, pdfUrl: string) {
    const settings = await fetchJson<{ requireOriginalPaper?: number }>("/api/users/me/settings").catch((): { requireOriginalPaper?: number } => ({}));
    let paperInfo: { hasPaper: boolean; filename?: string; mimeType?: string } = { hasPaper: false };
    let knowledgeReady = false;
    let knowledgePoints: Array<{ question_number: number; points: string[] }> = [];

    if (settings.requireOriginalPaper !== 0) {
      try {
        const info = await fetchJson<{ has_original_paper?: number; filename?: string; mime_type?: string }>(`/api/cards/${savedCard.id}/paper/info`);
        paperInfo = { hasPaper: !!info?.has_original_paper, filename: info?.filename, mimeType: info?.mime_type };
        // 检查知识点
        if (info?.has_original_paper) {
          try {
            const kp = await fetchJson<{ points?: Array<{ question_number: number; points: string[] }> }>(`/api/cards/${savedCard.id}/knowledge-points`);
            if (kp?.points && kp.points.length > 0) {
              knowledgeReady = true;
              knowledgePoints = kp.points;
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    setExportCheck({
      validation: createEmptyValidation(),
      pdfUrl,
      step: "paper",
      paperInfo,
      knowledgeReady,
      knowledgePoints,
      cardId: savedCard.id,
    });
  }

  function createEmptyValidation(): CardScoreValidationResult {
    return { totalScore: 0, objectiveScore: 0, subjectiveScore: 0, expectedTotals: [], flexibleTotalSubject: false, issues: [] };
  }

  function doFinalPdfExport(pdfUrl: string) {
    setExportCheck(null);
    openPdf(pdfUrl);
    setStatus("正在打开 PDF...");
  }

  async function exportPdfForCurrentCard() {
    let savedCard: AnswerCard | null = null;
    try {
      savedCard = await flushPendingCardSave("pdf");
    } catch {
      return;
    }
    if (!savedCard) return;

    const validation = validateCardScores(savedCard);
    const pdfUrl = urlWithToken(`/api/cards/${savedCard.id}/pdf?v=${encodeURIComponent(savedCard.updatedAt)}`);

    if (validation.issues.length > 0) {
      // Step 1: 显示分值检查
      setExportCheck({ validation, pdfUrl, step: "score", cardId: savedCard.id });
      return;
    }

    // 分值无问题 → 直接进原卷检查
    await showExportCheck(savedCard, pdfUrl);
  }

  async function importCard() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setIsBusy(true);
      setStatus("正在读取答题卡...");
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || data.format !== "projectx-card" || !data.card) {
          setStatus("不支持的文件格式，请使用 .projectx-card.json 导出文件");
          setIsBusy(false);
          return;
        }
        // Show import modal before sending to server
        setImportCardData(data);
        setShowImportCardModal(true);
      } catch (err) {
        setStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`);
        setIsBusy(false);
      }
    };
    input.click();
  }

  async function handleImportConfirm(formData: ImportCardFormData) {
    if (!importCardData) return;
    setShowImportCardModal(false);
    setIsBusy(true);
    setStatus("正在导入答题卡...");
    try {
      const body = {
        ...importCardData,
        overrideTitle: formData.title,
        overrideSubject: formData.subject,
        overrideSubjectLabel: formData.subjectLabel,
        overrideExamDate: formData.examDate,
        examAction: formData.examAction,
        examName: formData.examName,
        linkExamId: formData.linkExamId
      };
      const result = await fetchJson<CardSummary & { createdExamId?: number; duplicateExamName?: string; idConflictMsg?: string }>("/api/cards/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const msgs: string[] = [`已导入答题卡：${result.title} (${result.id})`];
      if (result.idConflictMsg) msgs.push(result.idConflictMsg);
      if (result.createdExamId) msgs.push(`已创建考试 #${result.createdExamId}`);
      if (result.duplicateExamName) msgs.push(`考试「${result.duplicateExamName}」已存在，跳过创建`);
      setStatus(msgs.join(" · "));
      await refreshCards();
      await loadExams();
      await loadCard(result.id);
    } catch (err) {
      setStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsBusy(false);
      setImportCardData(null);
    }
  }

  function updateCard(mutator: (draft: AnswerCard) => void) {
    if (!card) return;
    const draft = cloneCard(card);
    mutator(draft);
    // v1.4.7: 自动为题块生成序号标题
    autoNameBlocks(draft);
    editRevisionRef.current += 1;
    latestCardRef.current = draft;
    setCard(draft);
    setAutoSaveState("dirty");
    scheduleAutoSave();
  }

  /** 根据题块顺序和类型自动生成标题，如 "一. 单选（10题 50分）" */
  function autoNameBlocks(draft: AnswerCard) {
    const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    const tens = ["", "十", "二十", "三十", "四十", "五十", "六十", "七十", "八十", "九十"];
    function toChinese(n: number): string {
      if (n < 1 || n > 100) return String(n);
      if (n < 10) return digits[n];
      if (n < 20) return `十${n === 10 ? "" : digits[n % 10]}`;
      return `${tens[Math.floor(n / 10)]}${n % 10 === 0 ? "" : digits[n % 10]}`;
    }
    const modeName: Record<string, string> = {
      single: "单选", multiple: "多选", indeterminate: "不定项"
    };
    let index = 0;
    for (const block of draft.bodyBlocks) {
      if (block.type === "objective") {
        const obj = block as ObjectiveBlock;
        const typeName = modeName[obj.mode] ?? "客观题";
        const prefix = toChinese(index + 1);
        const count = obj.questionCount ?? 0;
        const total = count * (obj.scorePerQuestion ?? 0);
        block.title = `${prefix}、${typeName}（${count}题 ${total}分）`;
      } else if (block.type === "subjective") {
        const sub = block as SubjectiveBlock;
        const isFillBlank = sub.questions.length > 0 && sub.questions[0]?.style === "manual_score_grid" && sub.questions.every((q) => q.kind === "blank");
        const typeName = isFillBlank ? "填空题" : "解答题";
        const prefix = toChinese(index + 1);
        const count = sub.questions.length;
        const total = sub.questions.reduce((sum, q) => sum + (q.score || 0), 0);
        block.title = `${prefix}、${typeName}（${count}题 ${total}分）`;
      }
      index++;
    }
  }

  function updateBlock(blockId: string, mutator: (block: BodyBlock) => void) {
    updateCard((draft) => {
      const block = draft.bodyBlocks.find((item) => item.id === blockId);
      if (block) mutator(block);
    });
  }

  async function switchMode(nextMode: AppMode, afterSwitch?: () => void | Promise<void>) {
    if (mode === "design" && nextMode !== "design") {
      try {
        await flushPendingCardSave("switch");
      } catch {
        return;
      }
    }
    setMode(nextMode);
    try {
      await afterSwitch?.();
    } catch (err) {
      setStatus(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
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

  function addEssayBlock() {
    if (!card) return;
    const block = defaultEssayBlock(findNextQuestionNumber(card));
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
      let data: GradingProgressEvent;
      try {
        data = JSON.parse(event.data) as GradingProgressEvent;
      } catch {
        // 忽略非 JSON 消息（如心跳），避免抛出未捕获异常
        return;
      }
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
      setExams(asArray<ExamRecord>(data));
    } catch {
      setExams([]);
    } finally {
      setExamListRefreshKey((value) => value + 1);
    }
  }

  async function loadExamGroups() {
    try {
      const data = await fetchJson<Array<{ id: number; name: string; tag: string | null; grade_name: string | null; member_count: number; has_results: number; created_at: string }>>("/api/exam-groups");
      setExamGroups(asArray<{ id: number; name: string; tag: string | null; grade_name: string | null; member_count: number; has_results: number; created_at: string }>(data));
    } catch {
      setExamGroups([]);
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
    const filename = `${exam?.name ?? "成绩表"}_${classId ? "班级" : "年级"}.xlsx`;

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
        setStatus("Excel 导出完成");
      })
      .catch((err) => setStatus(`导出失败: ${err instanceof Error ? err.message : String(err)}`));
  }

  const selectedBlock = card?.bodyBlocks.find((block) => block.id === selectedBlockId) ?? null;

  if (loading) {
    return (
      <div className="login-shell">
        <p className="empty-text">正在加载...</p>
        <BeianFooter className="login-beian-footer" />
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
          <img src="/icon.png" alt="" className="brand-icon" />
          <div>
            <strong>答题卡设计阅卷系统</strong>
            <span>Project-X v{import.meta.env.VITE_APP_VERSION}</span>
          </div>
        </div>
        <div style={{ gap: 8, display: "flex", flexDirection: "column" }}>
          <button className="primary-button" onClick={() => { setShowNewCardModal(true); if (exams.length === 0) loadExams(); }} disabled={isBusy || !canDesign} style={{ width: "100%" }}>
            <Plus size={17} /> 新建答题卡
          </button>
        </div>
        <div className="card-list">
          {cards.map((item) => (
            <div
              key={item.id}
              className={`card-list-item ${card?.id === item.id ? "active" : ""}`}
              style={{
                borderLeft: (item as any).has_original_paper ? "3px solid transparent" : "3px solid var(--warn, #f59e0b)"
              }}
            >
              <button
                className="card-list-main"
                onClick={() => void loadCard(item.id)}
              >
                <span>{item.title || "未命名答题卡"}</span>
                <small>{item.subjectLabel ? `${item.subjectLabel} · ` : ""}ID:{item.id}</small>
              </button>
              <div className="card-list-actions">
                <button title="上传原卷" onClick={(e) => { e.stopPropagation(); setPaperPanelCardId(item.id); setShowPaperPanel(true); }}>
                  <FileUp size={14} />
                </button>
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
              {mode === "home" ? "首页" : mode === "scores"
                ? "我的成绩"
                : mode === "exam-manage"
                  ? "考试管理"
                  : mode === "account"
                    ? "账号管理"
                  : mode === "sponsor"
                    ? "支持项目"
                    : mode === "guide"
                      ? "使用说明"
                    : card?.title ?? (canDesign ? "答题卡设计器" : "答题卡系统")}
            </h1>
            <p>
              {mode === "home" ? `欢迎，${user?.name ?? ""}` : mode === "scores"
                ? "查看各场考试得分、排名与逐题明细"
                : mode === "exam-manage"
                  ? "创建、管理考试与阅卷批次"
                  : mode === "account"
                  ? "管理用户、班级与花名册"
                  : mode === "sponsor"
                    ? "感谢您的信任与支持"
                    : mode === "guide"
                      ? "Project-X 操作指南与常见问题"
                    : card
                    ? `ID:${card.id} · ${layout?.pages.length ?? 1} 页`
                    : canDesign
                      ? "创建答题卡后开始编辑"
                      : `${user.name} · ${user.role_display_name ?? user.role_name}`}
            </p>
          </div>
          <div className="topbar-actions-left">
            {!showTabBar && mode !== "home" && (
              <button onClick={() => switchMode("home")} style={{ height: 44, padding: "0 16px", fontSize: 14, fontWeight: 500, border: "1px solid var(--color-border-primary)", borderRadius: 8, background: "var(--color-background-secondary)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 }}>← 返回首页</button>
            )}
            {card && canDesign && mode === "design" && (
              <>
                <a className="ghost-button" href={urlWithToken(`/api/cards/${card.id}/layout`)} target="_blank" rel="noreferrer">
                  坐标JSON
                </a>
                <button className="ghost-button" type="button" onClick={() => void exportPdfForCurrentCard()} disabled={isBusy}>
                  <FileDown size={17} /> PDF
                </button>
                <button className="primary-button" onClick={() => void saveCard()} disabled={isBusy}>
                  <Save size={17} /> 保存
                </button>
                {autoSaveLabel && (
                  <span className={`autosave-status autosave-${autoSaveState}`}>
                    {autoSaveLabel}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="topbar-actions">
            <div className="mode-toggle" role="tablist" aria-label="工作模式" style={showTabBar ? undefined : { display: "none" }}>
              <button className={mode === "home" ? "active" : ""} onClick={() => void switchMode("home")} type="button">
                <Home size={16} /> 首页
              </button>
              {canDesign && (
              <button className={mode === "design" ? "active" : ""} onClick={() => void switchMode("design")} type="button">
                <SquarePen size={16} /> 设计
              </button>
              )}
              {canManageExams && (
              <button className={mode === "exam-manage" ? "active" : ""} onClick={() => void switchMode("exam-manage", async () => { await loadExams(); await loadExamGroups(); })} type="button">
                <ClipboardList size={16} /> 考试管理
              </button>
              )}
              {canAnalyze && (
              <button className={mode === "analysis" ? "active" : ""} onClick={() => void switchMode("analysis", loadExams)} type="button">
                <BarChart3 size={16} /> 分析
              </button>
              )}
              {showScoresTab && (
              <button className={mode === "scores" ? "active" : ""} onClick={() => void switchMode("scores")} type="button">
                <BarChart3 size={16} /> 我的成绩
              </button>
              )}
              {canManageAccounts && (
              <button className={mode === "account" ? "active" : ""} onClick={() => void switchMode("account")} type="button">
                <Users size={16} /> 账号
              </button>
              )}
            </div>
            <button
              className="theme-toggle"
              type="button"
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
              title={theme === "light" ? "切换为夜间模式" : "切换为日间模式"}
              aria-label="切换主题"
            >
              {theme === "light" ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
            <AccountMenu
              onOpenSponsor={() => {
                const previous = mode;
                void switchMode("sponsor", () => {
                  previousModeRef.current = previous;
                });
              }}
              onOpenGuide={() => {
                previousModeRef.current = mode;
                setMode("guide");
              }}
              onOpenPermissions={() => {
                previousModeRef.current = mode;
                setMode("permissions");
              }}
            />
          </div>
        </header>

        {/* v1.9.0: 首页仪表盘 */}
        <div className={`main-grid home-grid ${mode === "home" ? "" : "hidden-panel"}`}>
          <section style={{ gridColumn: "1 / -1", padding: 0 }}>
            <HomePage userName={user?.name ?? ""} userRole={user?.role_name ?? ""} teacherRole={user?.teacher_role ?? null}
              onNavigate={(m) => switchMode(m as AppMode)}
              onEnterExam={(id) => { switchMode("exam-manage"); setSelectedExamId(id); }} />
          </section>
        </div>

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
                    答题卡纸型
                    <select
                      value={card.paper?.size ?? "A4"}
                      onChange={(event) =>
                        updateCard((draft) => {
                          const size = event.target.value as "A4" | "A3";
                          draft.paper = { size, orientation: size === "A3" ? "landscape" : "portrait" };
                        })
                      }
                    >
                      <option value="A4">A4 纵向</option>
                      <option value="A3">A3 横向三版</option>
                    </select>
                  </label>
                  {card.layoutVersion !== 2 && (
                    <div className="layout-version-banner" role="note">
                      <strong>当前使用 V1 兼容排版</strong>
                      <span>旧打印件仍按原分数格坐标识别。升级后将使用紧凑分数区和更大的作答空间。</span>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => {
                          if (!confirm("升级到 V2 后，已经打印的旧答题卡不能再按此卡片的新坐标识别。确认升级并立即重排吗？")) return;
                          updateCard((draft) => void (draft.layoutVersion = 2));
                        }}
                      >
                        升级到紧凑排版 V2
                      </button>
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
                          <strong>{block.type === "objective" ? "客观题" : subjectiveBlockKindLabel(block)}</strong>
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
                      <Plus size={16} /> 解答题块
                    </button>
                    <button className="ghost-button" onClick={addEssayBlock}>
                      <Plus size={16} /> 作文块
                    </button>
                  </div>
                </section>

                {selectedBlock && (
                  <section className="panel">
                    {selectedBlock.type === "objective" ? (
                      <ObjectiveEditor block={selectedBlock} onChange={(mutator) => updateBlock(selectedBlock.id, mutator)} />
                    ) : (
                      <SubjectiveEditor
                        block={selectedBlock}
                        layoutVersion={card.layoutVersion}
                        onChange={(mutator) => updateBlock(selectedBlock.id, mutator)}
                        onUpload={uploadImage}
                      />
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
        <div className={`main-grid exam-manage-grid ${mode === "exam-manage" ? "" : "hidden-panel"}`}>
          {selectedExamId ? (
            <section style={{ gridColumn: "1 / -1", padding: 0 }}>
              <ExamDetailPage examId={selectedExamId} teacherId={user?.id ?? 0} teacherRole={user?.teacher_role ?? null} userRole={user?.role_name ?? ""} onBackToList={() => setSelectedExamId(null)} onBackHome={() => switchMode("home")} onStartReview={(exId, bId) => setGradingPanel({ examId: exId, blockId: bId })} />
            </section>
          ) : (
          <section className="preview-panel" style={{ gridColumn: "1 / -1", padding: 24, overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 16 }}>考试管理</strong>
              {examManageMode === "single" ? (
                <button className="primary-button" onClick={() => setShowCreateExam(!showCreateExam)}>
                  <Plus size={16} /> 新建考试
                </button>
              ) : (
                <button className="primary-button" onClick={() => setShowCreateGroup(true)}>
                  <Plus size={16} /> 新建大考
                </button>
              )}
              {examManageMode === "single" && selectedExamIds.size > 0 && (
                <button
                  className="ghost-button"
                  style={{ color: "var(--brand)" }}
                  onClick={() => setExamDeleteTarget({
                    exams: exams.filter((exam) => selectedExamIds.has(exam.id)),
                    deleteLinkedCards: false
                  })}
                >
                  <Trash2 size={16} /> 删除选中 ({selectedExamIds.size})
                </button>
              )}
              {(examManageMode === "single" ? exams.length : examGroups.length) > 0 && (
                <span style={{ fontSize: 13, color: "var(--muted)" }}>
                  共 {examManageMode === "single" ? exams.length : examGroups.length} {examManageMode === "single" ? "个考试" : "个大考"}
                </span>
              )}
              {/* Single/Group toggle — right side */}
              <div style={{ display: "flex", gap: 0, border: "1px solid var(--brand)", borderRadius: 6, overflow: "hidden", marginLeft: "auto" }}>
                <button onClick={() => setExamManageMode("single")} style={{
                  padding: "5px 14px", border: "none", background: examManageMode === "single" ? "var(--brand)" : "var(--surface)",
                  color: examManageMode === "single" ? "#fff" : "var(--text)", fontSize: 12, cursor: "pointer", fontWeight: examManageMode === "single" ? 600 : 400
                }}>单科考试</button>
                <button onClick={() => { setExamManageMode("group"); loadExamGroups(); }} style={{
                  padding: "5px 14px", border: "none", background: examManageMode === "group" ? "var(--brand)" : "var(--surface)",
                  color: examManageMode === "group" ? "#fff" : "var(--text)", fontSize: 12, cursor: "pointer", fontWeight: examManageMode === "group" ? 600 : 400,
                  display: "flex", alignItems: "center", gap: 4
                }}><Layers size={13} /> 大考</button>
              </div>
            </div>

            {examManageMode === "single" && showCreateExam && (
              <div style={{ background: "var(--surface-soft)", borderRadius: 8, padding: 14, marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
                <input value={newExamName} onChange={(e) => setNewExamName(e.target.value)} placeholder="考试名称" style={{ padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }} />
                <input value={newExamSubject} onChange={(e) => setNewExamSubject(e.target.value)} placeholder="科目（自动从答题卡继承）" style={{ padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }} />
                <select
                  value={newExamCardId || card?.id || ""}
                  onChange={(e) => {
                    const selectedCardId = e.target.value;
                    setNewExamCardId(selectedCardId);
                    const selectedCard = cards.find((c) => c.id === selectedCardId);
                    if (selectedCard) {
                      if (!newExamName) setNewExamName(selectedCard.title);
                      if (!newExamSubject) setNewExamSubject(selectedCard.subjectLabel || "");
                    }
                  }}
                  style={{ padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }}
                >
                  <option value="" disabled>选择答题卡</option>
                  {cards.map((c) => (<option key={c.id} value={c.id}>{c.title}</option>))}
                </select>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="primary-button" onClick={async () => {
                    const name = newExamName.trim();
                    if (!name) { setStatus("请填写考试名称"); return; }
                    try {
                      let cardId = newExamCardId || card?.id;
                      // 方案 B：如果没有选择答题卡，先自动创建一张最简答题卡
                      if (!cardId) {
                        const subjectPinyinMap: Record<string, string> = {
                          "语文": "yuwen", "数学": "shuxue", "英语": "yingyu", "外语": "yingyu",
                          "物理": "wuli", "化学": "huaxue", "生物": "shengwu",
                          "政治": "zhengzhi", "历史": "lishi", "地理": "dili"
                        };
                        const subjectVal = newExamSubject.trim();
                        const subjectPinyin = subjectPinyinMap[subjectVal] || subjectVal || "custom";
                        const today = new Date().toISOString().split("T")[0];
                        const cardRes = await fetchJson<any>("/api/cards", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            subject: subjectPinyin,
                            title: name,
                            subjectLabel: subjectVal || undefined,
                            examDate: today,
                            englishListening: false,
                            chineseChoicePlacement: "front"
                          })
                        });
                        cardId = cardRes.id;
                      }
                      await fetchJson("/api/exams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cardId, subject: newExamSubject.trim() || undefined }) });
                      setNewExamName(""); setNewExamSubject(""); setShowCreateExam(false);
                      loadExams();
                    } catch (err) { setStatus(`创建失败: ${err instanceof Error ? err.message : String(err)}`); }
                  }}>确认创建</button>
                  <button className="ghost-button" onClick={() => setShowCreateExam(false)}>取消</button>
                </div>
              </div>
            )}

            {examManageMode === "single" && exams.length === 0 && !showCreateExam && (
              <div className="empty-text" style={{ padding: 60, textAlign: "center" }}>暂无考试，点击上方「新建考试」创建。</div>
            )}

            {examManageMode === "single" && exams.length > 0 && (
              <div className="exam-list-table">
                <div className="exam-list-head">
                  <span style={{ width: 36, flexShrink: 0 }}>
                    <input type="checkbox" onChange={(e) => {
                      if (e.target.checked) setSelectedExamIds(new Set(exams.map(ex => ex.id)));
                      else setSelectedExamIds(new Set());
                    }} checked={selectedExamIds.size === exams.length && exams.length > 0} />
                  </span>
                  <span style={{ flex: 1, minWidth: 160 }}>考试名称</span>
                  <span style={{ width: 80 }}>科目</span>
                  <span style={{ width: 100 }}>答题卡</span>
                  <span style={{ width: 70, textAlign: "center" }}>状态</span>
                  <span style={{ width: 100, textAlign: "right" }}>操作</span>
                </div>
                {exams.map((exam) => (
                  <div key={exam.id} className="exam-list-row" style={{ cursor: "default" }}>
                    <span style={{ width: 36, flexShrink: 0 }}>
                      <input type="checkbox" checked={selectedExamIds.has(exam.id)} onChange={() => {
                        const next = new Set(selectedExamIds);
                        if (next.has(exam.id)) next.delete(exam.id); else next.add(exam.id);
                        setSelectedExamIds(next);
                      }} />
                    </span>
                    <span style={{ flex: 1, minWidth: 160, fontWeight: 500 }}>{exam.name}</span>
                    <span style={{ width: 80, color: "var(--muted)" }}>{exam.subject || "—"}</span>
                    <span style={{ width: 100, color: "var(--muted)", fontSize: 12 }}>{exam.card_id ?? "未关联"}</span>
                    <span style={{ width: 70, textAlign: "center" }}>
                      <span className={`exam-list-badge exam-list-badge-${exam.status}`}>
                        {exam.status === "closed" ? "已完成" : exam.status === "grading" ? "阅卷中" : exam.status === "draft" ? "草稿" : exam.status}
                      </span>
                    </span>
                    <span style={{ width: 100, textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="ghost-button" style={{ fontSize: 12, color: "#3C3489", padding: "2px 6px" }}
                        onClick={() => setSelectedExamId(exam.id)}>网阅</button>
                      <button className="ghost-button" style={{ fontSize: 12, color: "var(--brand)", padding: "2px 6px", marginLeft: 4 }}
                        onClick={() => setExamDeleteTarget({ exams: [exam], deleteLinkedCards: false })}>删除</button>
                      <button className="ghost-button" style={{ fontSize: 12, color: "#1D9E75", padding: "2px 6px", marginLeft: 4 }}
                        onClick={() => setAssignedFormulaExamId(exam.id)}>赋分</button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Exam group list */}
            {examManageMode === "group" && examGroups.length === 0 && (
              <div className="empty-text" style={{ padding: 60, textAlign: "center" }}>暂无大考，点击上方「新建大考」创建。</div>
            )}
            {examManageMode === "group" && examGroups.length > 0 && (
              <div className="exam-list-table">
                <div className="exam-list-head">
                  <span style={{ flex: 1, minWidth: 180 }}>大考名称</span>
                  <span style={{ width: 80 }}>标签</span>
                  <span style={{ width: 80 }}>年级</span>
                  <span style={{ width: 80, textAlign: "center" }}>含考试数</span>
                  <span style={{ width: 80, textAlign: "center" }}>有无成绩</span>
                  <span style={{ width: 100, textAlign: "right" }}>操作</span>
                </div>
                {examGroups.map((group: any) => (
                  <div key={group.id} className="exam-list-row" style={{ cursor: "default" }}>
                    <span style={{ flex: 1, minWidth: 180, fontWeight: 500 }}>{group.name}</span>
                    <span style={{ width: 80 }}>
                      <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11,
                        background: group.tag ? "var(--primary)" : "var(--bg-secondary)",
                        color: group.tag ? "#fff" : "var(--muted)" }}>
                        {group.tag || "—"}
                      </span>
                    </span>
                    <span style={{ width: 80, color: "var(--muted)" }}>{group.grade_name || "—"}</span>
                    <span style={{ width: 80, textAlign: "center", fontWeight: 500 }}>{group.member_count}</span>
                    <span style={{ width: 80, textAlign: "center" }}>
                      <span className={`exam-list-badge ${group.has_results ? "exam-list-badge-closed" : "exam-list-badge-draft"}`}>
                        {group.has_results ? "有成绩" : "无成绩"}
                      </span>
                    </span>
                    <span style={{ width: 100, textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="ghost-button" style={{ fontSize: 12, color: "var(--brand)", padding: "2px 6px" }}
                        onClick={() => setGroupDeleteTarget({
                          groupId: group.id,
                          groupName: group.name,
                          memberCount: group.member_count,
                          deleteExams: false
                        })}>删除</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
          )}
        </div>
        <div className="main-grid grading-grid hidden-panel">
          <section className="preview-panel grading-results-panel">
            <GradingResults result={gradingResult} onDownloadCsv={() => gradingResult && downloadCsv(gradingResult.rows, gradingResult.cardId)} />
          </section>

          <aside className="inspector">
            <section className="panel">
              <div className="panel-title">
                <ClipboardCheck size={17} /> 阅卷设置
              </div>
              <label>
                考试
                <select
                  value={gradingExamId}
                  onChange={async (e) => {
                    const examId = e.target.value;
                    setGradingExamId(examId);
                    setCardOverride(false);  // 切换考试时重置覆盖状态
                    if (examId) {
                      // 自动加载考试关联的答题卡
                      const exam = exams.find((ex) => String(ex.id) === examId);
                      if (exam?.card_id && exam.card_id !== card?.id) {
                        await loadCard(exam.card_id);
                      }
                    }
                  }}
                >
                  <option value="">不关联考试</option>
                  {exams.map((exam) => (
                    <option key={exam.id} value={String(exam.id)}>
                      {exam.name} {exam.subject ? `(${exam.subject})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              {gradingExamId && card ? (
                // 已选考试 → 只读展示关联答题卡，可手动覆盖
                <div>
                  <label style={{ marginBottom: 4 }}>关联答题卡</label>
                  {cardOverride ? (
                    <select
                      value={card?.id ?? ""}
                      onChange={(e) => { void loadCard(e.target.value); setCardOverride(false); }}
                      disabled={isBusy}
                    >
                      {cards.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title} / {item.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--surface-soft)", borderRadius: 6 }}>
                      <span style={{ fontSize: 13, flex: 1 }}>{card.title} / {card.id}</span>
                      <button className="link-button" type="button" onClick={() => setCardOverride(true)} disabled={isBusy} style={{ fontSize: 12, padding: "2px 8px" }}>
                        换答题卡
                      </button>
                    </div>
                  )}
                  <p className="hint" style={{ marginTop: 4 }}>答题卡已根据所选考试自动关联</p>
                </div>
              ) : (
                // 未选考试 → 独立选择答题卡（裸阅卷场景）
                <label>
                  答题卡
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
              )}
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
          <section className="preview-panel analysis-results-panel" style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column" }}>

            {/* 考试选择页 */}
            {analysisTab === "select" && analysisGroupId == null && (
              <ExamSelectPage
                refreshKey={examListRefreshKey}
                onSelectExam={(examId) => { setSelectedAnalysisExamId(examId); setAnalysisTab("detail"); }}
                onSelectGroup={(groupId) => { setAnalysisGroupId(groupId); }}
              />
            )}

            {/* 大考详情页 */}
            {analysisGroupId != null && (
              <ExamGroupDetailPage
                groupId={analysisGroupId}
                onBack={() => setAnalysisGroupId(null)}
                onExport={() => setShowGroupExport(true)}
              />
            )}

            {/* 成绩详情页 (v1.4.0) */}
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
        <div className={`main-grid sponsor-grid ${mode === "sponsor" ? "" : "hidden-panel"}`}>
          <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
            <SponsorPage onBack={() => setMode(previousModeRef.current)} />
          </section>
        </div>
        <div className={`main-grid permissions-grid ${mode === "permissions" ? "" : "hidden-panel"}`}>
          <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
            <PermissionManager onBack={() => setMode(previousModeRef.current)} />
          </section>
        </div>
        <div className={`main-grid guide-grid ${mode === "guide" ? "" : "hidden-panel"}`}>
          <section className="preview-panel" style={{ gridColumn: "1 / -1" }}>
            <UserGuidePage onBack={() => setMode(previousModeRef.current)} />
          </section>
        </div>
        {gradingPanel && (
          <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "var(--color-background-primary)" }}>
            <GradePanel examId={gradingPanel.examId} blockId={gradingPanel.blockId} teacherId={user?.id ?? 0} onBack={() => setGradingPanel(null)} />
          </div>
        )}
        <footer className="statusbar">
          <span className="statusbar-message">{status}</span>
          <BeianFooter className="statusbar-beian" />
        </footer>
      </section>

      {/* ── 移动端底部导航栏 ── */}
      {showTabBar && (
      <nav className="bottom-nav" aria-label="主导航">
        <div className="bottom-nav-inner">
          {mobileNavItems.map((m) => (
            <button
              key={m.id}
              className={`bottom-nav-item ${mode === m.id ? "active" : ""}`}
              onClick={() => void switchMode(m.id, m.onEnter)}
              type="button"
              title={m.label}
              aria-label={m.label}
              aria-current={mode === m.id ? "page" : undefined}
            >
              {m.icon}
              <span>{m.shortLabel}</span>
            </button>
          ))}
        </div>
      </nav>
      )}

      <NewCardModal open={showNewCardModal} onClose={() => setShowNewCardModal(false)} onCreate={createCard} exams={exams} />
      {paperPanelCardId && (
        <PaperUploadPanel
          cardId={paperPanelCardId}
          open={showPaperPanel}
          onClose={() => setShowPaperPanel(false)}
          onUploaded={() => void refreshCards()}
        />
      )}
      <ImportCardModal
        open={showImportCardModal && importCardData !== null}
        initialTitle={importCardData?.card?.title ?? ""}
        initialSubject={importCardData?.card?.subject ?? ""}
        initialSubjectLabel={importCardData?.card?.subjectLabel ?? ""}
        initialExamDate={importCardData?.card?.examDate ?? ""}
        exams={exams.map(e => ({ id: e.id, name: e.name, subject: e.subject ?? null }))}
        onConfirm={(data) => void handleImportConfirm(data)}
        onClose={() => { setShowImportCardModal(false); setImportCardData(null); setIsBusy(false); }}
      />
      {exportCheck && (
        <div className="modal-backdrop" onClick={() => setExportCheck(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: "calc(100vw - 40px)", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
            <div className="modal-header">
              <h2>导出检查</h2>
              <button className="modal-close" type="button" onClick={() => setExportCheck(null)}>×</button>
            </div>

            {/* 进度条 */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--line-soft)", flexWrap: "wrap", fontSize: 13 }}>
              <span style={{ color: "var(--success, #10b981)", fontWeight: 600 }}>✓ 分值</span><span style={{ color: "var(--muted)" }}>→</span>
              <span style={{ color: exportCheck.step === "paper" ? "var(--brand)" : exportCheck.paperInfo?.hasPaper ? "var(--success, #10b981)" : "var(--muted)", fontWeight: exportCheck.step === "paper" ? 600 : 400 }}>
                {exportCheck.step === "paper" ? "▶ 原卷" : exportCheck.paperInfo?.hasPaper ? "✓ 原卷" : "○ 原卷"}
              </span><span style={{ color: "var(--muted)" }}>→</span>
              <span style={{ color: exportCheck.step === "knowledge" ? "var(--brand)" : exportCheck.knowledgeReady ? "var(--success, #10b981)" : "var(--muted)", fontWeight: exportCheck.step === "knowledge" ? 600 : 400 }}>
                {exportCheck.step === "knowledge" ? "▶ 知识点" : exportCheck.knowledgeReady ? "✓ 知识点" : "○ 知识点"}
              </span><span style={{ color: "var(--muted)" }}>→</span>
              <span style={{ color: "var(--muted)" }}>○ 导出</span>
            </div>

            <div style={{ overflow: "auto", flex: 1, padding: "8px 0" }}>
              {/* Step 1: 分值检查 */}
              {exportCheck.step === "score" && exportCheck.validation.issues.length > 0 && (
                <div>
                  <div className="score-warning-summary">
                    <strong>当前总分：{exportCheck.validation.totalScore} 分</strong>
                    <span>客观题 {exportCheck.validation.objectiveScore} 分 / 主观题 {exportCheck.validation.subjectiveScore} 分</span>
                    <span>{exportCheck.validation.flexibleTotalSubject ? "语文、英语或外语科目不检查 100/150 总分规则" : `期望总分：${exportCheck.validation.expectedTotals.join(" 或 ")} 分`}</span>
                  </div>
                  <ul className="score-warning-list">
                    {exportCheck.validation.issues.slice(0, 6).map((issue, i) => (
                      <li key={`s_${i}`}><span>{issue.message}</span>{issue.questionRefs?.length ? <small> 涉及：{issue.questionRefs.join("、")}</small> : null}</li>
                    ))}
                  </ul>
                  {exportCheck.validation.issues.length > 6 && <p className="score-warning-more">还有 {exportCheck.validation.issues.length - 6} 条提示</p>}
                </div>
              )}

              {/* Step 2: 原卷检查 */}
              {exportCheck.step === "paper" && (
                <div>
                  {exportCheck.paperInfo?.hasPaper ? (
                    <div>
                      <p style={{ marginBottom: 6, fontSize: 13 }}>✅ 已上传：<strong>{exportCheck.paperInfo.filename}</strong></p>
                      {/* PDF → iframe, 图片 → img, DOCX → 文字 */}
                      {exportCheck.paperInfo.mimeType?.startsWith("image/") ? (
                        <div style={{ border: "1px solid var(--line-soft)", borderRadius: 6, overflow: "hidden", cursor: "pointer", background: "var(--surface-raised)" }}
                          onClick={() => { if (exportCheck.cardId) setPaperPreviewOpen(exportCheck.cardId); }} title="点击放大">
                          <img src={mediaUrl(`/api/cards/${exportCheck.cardId}/paper?format=image`)} alt="原卷"
                            style={{ maxWidth: "100%", maxHeight: 240, objectFit: "contain", display: "block", margin: "0 auto" }}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                          <p style={{ textAlign: "center", padding: "4px 0 8px", color: "var(--muted)", fontSize: 12 }}>点击放大查看</p>
                        </div>
                      ) : exportCheck.paperInfo.mimeType === "application/pdf" ? (
                        <iframe src={mediaUrl(`/api/cards/${exportCheck.cardId}/paper`)} style={{ width: "100%", height: 380, border: "1px solid var(--line-soft)", borderRadius: 6 }} title="原卷PDF" />
                      ) : (
                        <div style={{ border: "1px solid var(--line-soft)", borderRadius: 6, padding: 16, textAlign: "center", background: "var(--surface-raised)" }}>
                          <p style={{ margin: 0, fontWeight: 600 }}>{exportCheck.paperInfo.filename}</p>
                          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted)" }}>DOCX 文件不支持内联预览</p>
                          <a href={urlWithToken(`/api/cards/${exportCheck.cardId}/paper`)} target="_blank" style={{ fontSize: 12, marginTop: 4, display: "inline-block" }}>在 Office 中打开</a>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ background: "var(--brand-soft)", borderRadius: 6, padding: 16, textAlign: "center" }}>
                      <p style={{ color: "var(--brand)", fontWeight: 600, margin: "0 0 8px" }}>⚠ 尚未上传原卷</p>
                      <button className="primary-button" type="button" onClick={() => {
                        setExportCheck(null);
                        if (exportCheck.cardId) { setPaperPanelCardId(exportCheck.cardId); setShowPaperPanel(true); }
                      }}>📤 立即上传原卷</button>
                    </div>
                  )}
                </div>
              )}

              {/* Step 3: 知识点分析 */}
              {exportCheck.step === "knowledge" && (
                <div>
                  {exportCheck.knowledgeReady && exportCheck.knowledgePoints?.length ? (
                    <div>
                      <p style={{ marginBottom: 6, fontSize: 13 }}>✅ 已分析 {exportCheck.knowledgePoints.length} 道题：</p>
                      <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--line-soft)", borderRadius: 6, padding: 8, background: "var(--surface-raised)" }}>
                        {exportCheck.knowledgePoints.map((q) => (
                          <div key={q.question_number} style={{ marginBottom: 4, fontSize: 13, lineHeight: 1.8 }}>
                            <strong style={{ color: "var(--muted)" }}>第{q.question_number}题：</strong>
                            {q.points.map((p, i) => (
                              <span key={i} style={{ display: "inline-block", padding: "1px 8px", borderRadius: 10, margin: "1px 2px", background: "#3b82f6", color: "#fff", fontSize: 12 }}>{p}</span>
                            ))}
                          </div>
                        ))}
                      </div>
                      <button className="ghost-button" type="button" onClick={() => {
                        if (exportCheck.cardId) { setPaperPanelCardId(exportCheck.cardId); setShowPaperPanel(true); }
                      }} style={{ marginTop: 8 }}>编辑或重新分析</button>
                    </div>
                  ) : (
                    <KnowledgeAnalysisInline cardId={exportCheck.cardId!}
                      onDone={(points) => {
                        setExportCheck({ ...exportCheck, knowledgeReady: true, knowledgePoints: points });
                      }} />
                  )}
                </div>
              )}
            </div>

            {/* 底部按钮 */}
            <div style={{ borderTop: "1px solid var(--line-soft)", padding: "12px 0 0", display: "flex", justifyContent: "space-between", gap: 8, flexShrink: 0 }}>
              <div>
                {exportCheck.step !== "score" && (
                  <button className="ghost-button" type="button" onClick={() => {
                    const prev = exportCheck.step === "paper" ? "score" : "paper";
                    setExportCheck({ ...exportCheck, step: prev as "score" | "paper" });
                  }}>← 上一步</button>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
              <button className="ghost-button" type="button" onClick={() => setExportCheck(null)}>取消</button>
              {exportCheck.step === "score" && (
                <button className="primary-button" type="button" onClick={async () => {
                  const cardId = exportCheck.cardId;
                  if (cardId) {
                    const info = await fetchJson<{ has_original_paper?: number; filename?: string; mime_type?: string }>(`/api/cards/${cardId}/paper/info`).catch((): { has_original_paper?: number; filename?: string; mime_type?: string } => ({}));
                    setExportCheck({
                      ...exportCheck, step: "paper",
                      paperInfo: { hasPaper: !!(info as any)?.has_original_paper, filename: (info as any)?.filename, mimeType: (info as any)?.mime_type }
                    });
                  } else { setExportCheck({ ...exportCheck, step: "paper" }); }
                }}>
                  确认分值 → 原卷检查
                </button>
              )}
              {exportCheck.step === "paper" && (
                <>
                  {!exportCheck.paperInfo?.hasPaper && (
                    <button className="ghost-button" type="button" onClick={() => setExportCheck({ ...exportCheck, step: "knowledge" })}>
                      跳过 → 知识点检查
                    </button>
                  )}
                  <button className="primary-button" type="button" onClick={() => setExportCheck({ ...exportCheck, step: "knowledge" })}>
                    原卷 OK → 知识点检查
                  </button>
                </>
              )}
              {exportCheck.step === "knowledge" && exportCheck.knowledgeReady && (
                <button className="primary-button" type="button" onClick={() => doFinalPdfExport(exportCheck.pdfUrl)}>
                  ✅ 确认导出 PDF
                </button>
              )}
              </div>
            </div>
          </div>
        </div>
      )}
      {paperPreviewOpen && (
        <div className="modal-backdrop" onClick={() => { setPaperPreviewOpen(null); setPaperZoom(1); }}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: "90vw", maxWidth: 900, maxHeight: "90vh", overflow: "auto", padding: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--line-soft)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>原卷预览</h3>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="ghost-button" type="button" onClick={() => setPaperZoom(z => Math.max(0.25, z - 0.25))} title="缩小">−</button>
                <button className="ghost-button" type="button" onClick={() => setPaperZoom(1)} title="重置">{Math.round(paperZoom * 100)}%</button>
                <button className="ghost-button" type="button" onClick={() => setPaperZoom(z => Math.min(3, z + 0.25))} title="放大">+</button>
                <button className="modal-close" type="button" onClick={() => { setPaperPreviewOpen(null); setPaperZoom(1); }}>✕</button>
              </div>
            </div>
            <div style={{ padding: 16, textAlign: "center", overflow: "auto" }}>
              <img
                src={mediaUrl(`/api/cards/${paperPreviewOpen}/paper?format=image`)}
                alt="原卷"
                style={{ maxWidth: `${paperZoom * 100}%`, maxHeight: `${paperZoom * 75}vh`, objectFit: "contain", transition: "max-width 0.15s, max-height 0.15s" }}
              />
            </div>
          </div>
        </div>
      )}
      {cardDeleteConflict && (
        <div className="modal-backdrop" onClick={() => setCardDeleteConflict(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: "calc(100vw - 40px)" }}>
            <div className="modal-header">
              <h2>确认删除答题卡</h2>
              <button className="modal-close" type="button" onClick={() => setCardDeleteConflict(null)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ marginTop: 0 }}>
                「{cardDeleteConflict.cardTitle}」已被 {cardDeleteConflict.referencedExamCount} 个考试引用。删除答题卡前需要先解除这些考试的关联。
              </p>
              {cardDeleteConflict.referencedExamNames.length > 0 && (
                <ul style={{ margin: "8px 0 14px", paddingLeft: 20, color: "var(--muted)", fontSize: 13 }}>
                  {cardDeleteConflict.referencedExamNames.map((name) => <li key={name}>{name}</li>)}
                </ul>
              )}
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={cardDeleteConflict.deleteReferencedExams}
                  onChange={(event) => setCardDeleteConflict({ ...cardDeleteConflict, deleteReferencedExams: event.target.checked })}
                  disabled={isBusy}
                />
                同时删除这些考试及其成绩/扫描数据
              </label>
            </div>
            <div className="modal-footer">
              <button className="ghost-button" type="button" onClick={() => setCardDeleteConflict(null)} disabled={isBusy}>取消</button>
              <button
                className="primary-button"
                type="button"
                disabled={isBusy}
                onClick={async () => {
                  const target = cardDeleteConflict;
                  const ok = await deleteCard(target.cardId, {
                    unlinkExams: !target.deleteReferencedExams,
                    deleteReferencedExams: target.deleteReferencedExams
                  });
                  if (ok) setCardDeleteConflict(null);
                }}
              >
                {cardDeleteConflict.deleteReferencedExams ? "删除考试和答题卡" : "解绑考试并删除答题卡"}
              </button>
            </div>
          </div>
        </div>
      )}
      {examDeleteTarget && (
        <div className="modal-backdrop" onClick={() => setExamDeleteTarget(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: "calc(100vw - 40px)" }}>
            <div className="modal-header">
              <h2>确认删除考试</h2>
              <button className="modal-close" type="button" onClick={() => setExamDeleteTarget(null)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ marginTop: 0 }}>
                将删除 {examDeleteTarget.exams.length} 个考试，并解除它们与答题卡的关联。
              </p>
              <ul style={{ margin: "8px 0 14px", paddingLeft: 20, color: "var(--muted)", fontSize: 13 }}>
                {examDeleteTarget.exams.map((exam) => <li key={exam.id}>{exam.name}</li>)}
              </ul>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={examDeleteTarget.deleteLinkedCards}
                  onChange={(event) => setExamDeleteTarget({ ...examDeleteTarget, deleteLinkedCards: event.target.checked })}
                  disabled={isBusy || !examDeleteTarget.exams.some((exam) => exam.card_id)}
                />
                同时删除关联答题卡
              </label>
            </div>
            <div className="modal-footer">
              <button className="ghost-button" type="button" onClick={() => setExamDeleteTarget(null)} disabled={isBusy}>取消</button>
              <button
                className="primary-button"
                type="button"
                disabled={isBusy}
                onClick={async () => {
                  const target = examDeleteTarget;
                  const ok = await deleteExams(target);
                  if (ok) setExamDeleteTarget(null);
                }}
              >
                {examDeleteTarget.deleteLinkedCards ? "删除考试和答题卡" : "解绑答题卡并删除考试"}
              </button>
            </div>
          </div>
        </div>
      )}
      {groupDeleteTarget && (
        <div className="modal-backdrop" onClick={() => setGroupDeleteTarget(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: "calc(100vw - 40px)" }}>
            <div className="modal-header">
              <h2>确认删除大考</h2>
              <button className="modal-close" type="button" onClick={() => setGroupDeleteTarget(null)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ marginTop: 0 }}>
                将删除大考「<strong>{groupDeleteTarget.groupName}</strong>」。
                该大考关联了 <strong>{groupDeleteTarget.memberCount}</strong> 场考试。
              </p>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={groupDeleteTarget.deleteExams}
                  onChange={(event) => setGroupDeleteTarget({ ...groupDeleteTarget, deleteExams: event.target.checked })}
                  disabled={isBusy}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>同时删除这 {groupDeleteTarget.memberCount} 场关联考试</strong>
                  <br />
                  <span style={{ color: "var(--muted)", fontSize: 11 }}>
                    ⚠ 考试的成绩、扫描数据将被永久删除，不可恢复
                  </span>
                </span>
              </label>
              {!groupDeleteTarget.deleteExams && (
                <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 0, marginTop: 8 }}>
                  取消勾选则仅删除大考组，关联的考试保留不变。
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button className="ghost-button" type="button" onClick={() => setGroupDeleteTarget(null)} disabled={isBusy}>取消</button>
              <button
                className="primary-button"
                type="button"
                disabled={isBusy}
                style={{ background: "var(--brand)" }}
                onClick={async () => {
                  const target = groupDeleteTarget;
                  try {
                    const qs = target.deleteExams ? "?deleteExams=1" : "";
                    const res = await authFetch(`/api/exam-groups/${target.groupId}${qs}`, { method: "DELETE" });
                    if (res.ok) {
                      setGroupDeleteTarget(null);
                      loadExamGroups();
                      if (target.deleteExams) loadExams();
                    }
                  } catch (err) {
                    setStatus(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }}
              >
                {groupDeleteTarget.deleteExams ? `删除大考和 ${groupDeleteTarget.memberCount} 场考试` : "仅删除大考"}
              </button>
            </div>
          </div>
        </div>
      )}
      {assignedFormulaExamId != null && (
        <AssignedFormulaModal
          examId={assignedFormulaExamId}
          examName={exams.find((e) => e.id === assignedFormulaExamId)?.name ?? ""}
          subject={exams.find((e) => e.id === assignedFormulaExamId)?.subject ?? null}
          onClose={() => setAssignedFormulaExamId(null)}
          onSaved={() => loadExams()}
        />
      )}
      {showCreateGroup && (
        <CreateExamGroupModal
          onClose={() => setShowCreateGroup(false)}
          onCreated={() => { setShowCreateGroup(false); loadExamGroups(); }}
        />
      )}
      {showGroupExport && analysisGroupId != null && (
        <GroupExportModal
          groupId={analysisGroupId}
          onClose={() => setShowGroupExport(false)}
        />
      )}
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
  // Hooks 必须在任何早返回之前调用，避免 result 由 null 变为非空时 Hook 数量变化导致崩溃
  const [previewPages, setPreviewPages] = useState<ScanPage[] | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");

  function openGradingPreview(row: CombinedGradingRow) {
    if (!row.previewUrl) return;
    setPreviewTitle(`学号: ${row.studentId ?? "未识别"} · 文件: ${row.fileName}`);
    setPreviewPages([{
      recordId: row.fileName,
      pageNum: 1,
      side: "front",
      imageUrl: urlWithToken(row.previewUrl)
    }]);
  }

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
                  <button
                    className="score-preview-link"
                    onClick={(event) => { event.stopPropagation(); openGradingPreview(row); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--brand)", fontSize: 12, padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}
                  >
                    预览
                  </button>
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

      {previewPages !== null && (
        <ScanPreviewModal
          title={previewTitle}
          pages={previewPages}
          onClose={() => setPreviewPages(null)}
        />
      )}
    </div>
  );
}

function ObjectiveEditor({ block, onChange }: { block: ObjectiveBlock; onChange: (mutator: (block: BodyBlock) => void) => void }) {
  const questions = objectiveQuestionNumbers(block);
  const questionConfigs = objectiveQuestionDefinitions(block);
  const answerKey = normalizeObjectiveAnswerKey(block);
  const missingAnswerCount = questions.filter((questionNumber) => !answerKey[questionNumber]?.length).length;
  const [showPerQuestion, setShowPerQuestion] = useState(false);  // v1.4.7: 默认折叠每题配置

  function toggleAnswer(questionNumber: number, option: string) {
    onChange((draft) => {
      const objective = draft as ObjectiveBlock;
      objective.questions = normalizeObjectiveQuestions(objective);
      const config = objective.questions.find((item) => item.questionNumber === questionNumber);
      const current = new Set(config?.answerKey ?? objective.answerKey?.[questionNumber] ?? []);
      if ((config?.mode ?? objective.mode) === "single") {
        if (config) config.answerKey = current.has(option) ? [] : [option];
      } else {
        if (current.has(option)) {
          current.delete(option);
        } else {
          current.add(option);
        }
        if (config) config.answerKey = Array.from(current).sort();
      }
      if (config?.answerKey?.length === 0) {
        delete config.answerKey;
      }
      objective.answerKey = normalizeObjectiveAnswerKey(objective);
    });
  }

  function updateQuestionConfig(questionNumber: number, mutator: (question: NonNullable<ObjectiveBlock["questions"]>[number]) => void) {
    onChange((draft) => {
      const objective = draft as ObjectiveBlock;
      objective.questions = normalizeObjectiveQuestions(objective);
      const question = objective.questions.find((item) => item.questionNumber === questionNumber);
      if (!question) return;
      mutator(question);
      if (question.mode === "single" && question.answerKey && question.answerKey.length > 1) {
        question.answerKey = [question.answerKey[0]];
      }
      objective.answerKey = normalizeObjectiveAnswerKey(objective);
      const first = objective.questions[0];
      objective.questionStart = first?.questionNumber ?? objective.questionStart;
      objective.questionCount = objective.questions.length;
    });
  }

  function defaultQuestionScoringRule() {
    return {
      type: "per_selected_count" as const,
      partialScores: {},
      wrongOrExtraScore: 0
    };
  }

  function scoringRuleFor(question: (typeof questionConfigs)[number]) {
    return question.scoringRule ?? defaultQuestionScoringRule();
  }

  function updateScoringRule(questionNumber: number, mutator: (rule: any) => any) {
    updateQuestionConfig(questionNumber, (draft) => {
      const current = draft.scoringRule ?? defaultQuestionScoringRule();
      draft.scoringRule = mutator(JSON.parse(JSON.stringify(current)));
    });
  }

  function setScoringRuleType(questionNumber: number, type: "per_selected_count" | "by_correct_count" | "fixed_partial") {
    updateScoringRule(questionNumber, (rule) => {
      const common = {
        wrongOrExtraScore: Number(rule.wrongOrExtraScore ?? 0),
        allowWrongOptions: rule.allowWrongOptions === true
      };
      if (type === "fixed_partial") return { type, partialScore: 0, ...common };
      if (type === "by_correct_count") return { type, partialScoresByCorrectCount: {}, ...common };
      return { type, partialScores: {}, ...common };
    });
  }

  function updateWrongOrExtraScore(questionNumber: number, value: number) {
    updateScoringRule(questionNumber, (rule) => ({ ...rule, wrongOrExtraScore: value }));
  }

  function updateAllowWrongOptions(questionNumber: number, checked: boolean) {
    updateScoringRule(questionNumber, (rule) => ({ ...rule, allowWrongOptions: checked }));
  }

  function updateFixedPartialScore(questionNumber: number, value: number) {
    updateScoringRule(questionNumber, (rule) => ({ ...rule, type: "fixed_partial", partialScore: value }));
  }

  function updatePerSelectedScore(questionNumber: number, selectedCount: number, value: number) {
    updateScoringRule(questionNumber, (rule) => ({
      ...rule,
      type: "per_selected_count",
      partialScores: { ...(rule.partialScores ?? {}), [selectedCount]: value }
    }));
  }

  function updateByCorrectCountScore(questionNumber: number, correctCount: number, selectedCount: number, value: number) {
    updateScoringRule(questionNumber, (rule) => ({
      ...rule,
      type: "by_correct_count",
      partialScoresByCorrectCount: {
        ...(rule.partialScoresByCorrectCount ?? {}),
        [correctCount]: {
          ...(rule.partialScoresByCorrectCount?.[correctCount] ?? {}),
          [selectedCount]: value
        }
      }
    }));
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
                {optionLabelsForQuestion(block, questionNumber).map((option) => {
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
                // v1.4.7: 同步到逐题配置
                objective.questions = normalizeObjectiveQuestions(objective);
                for (const q of objective.questions) {
                  q.optionCount = objective.optionCount;
                }
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
      <div className="two-col">
        <label>
          题型
          <select
            value={block.mode}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.mode = event.target.value as ObjectiveMode;
                // v1.4.7: 同步块级题型到所有逐题配置
                objective.questions = normalizeObjectiveQuestions(objective);
                for (const q of objective.questions) {
                  q.mode = objective.mode;
                  if (objective.mode !== "multiple" && objective.mode !== "indefinite") {
                    delete q.scoringRule;
                  }
                }
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
        <label>
          选项排列
          <select
            value={block.optionLayout ?? "horizontal"}
            onChange={(event) =>
              onChange((draft) => {
                (draft as ObjectiveBlock).optionLayout = event.target.value as ObjectiveOptionLayout;
              })
            }
          >
            {Object.entries(optionLayoutLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
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
      <div style={{ marginTop: 8 }}>
        <button className="ghost-button" type="button" onClick={() => setShowPerQuestion(!showPerQuestion)} style={{ fontSize: 12 }}>
          {showPerQuestion ? "▲ 收起每题配置" : "▼ 展开每题配置"}
        </button>
      </div>
      {showPerQuestion && (
      <div className="answer-key-editor">
        <div className="answer-key-title">
          <strong>每题配置</strong>
          <span>可混排单选、多选、不定项</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {questionConfigs.map((question) => (
            <div className="question-editor" key={question.questionNumber} style={{ margin: 0 }}>
              <div className="question-editor-title">
                <strong>第 {question.questionNumber} 题</strong>
              </div>
              <div className="three-col">
                <label>
                  题号
                  <input type="number" min={1} value={question.questionNumber} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.questionNumber = Number(event.target.value)))} />
                </label>
                <label>
                  题型
                  <select value={question.mode} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => { draft.mode = event.target.value as ObjectiveMode; if (draft.mode === "single") draft.scoringRule = undefined; })}>
                    {Object.entries(modeLabels).map(([value, label]) => (<option key={value} value={value}>{label}</option>))}
                  </select>
                </label>
                <label>
                  选项数
                  <input type="number" min={2} max={8} value={question.optionCount} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.optionCount = Number(event.target.value)))} />
                </label>
              </div>
              <label>
                分值
                <input type="number" min={0} step={0.5} value={question.score} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.score = Number(event.target.value)))} />
              </label>
              {question.mode !== "single" && (
                <>
                  <div className="two-col">
                    <label>
                      少选计分方式
                      <select
                        value={scoringRuleFor(question).type}
                        onChange={(event) =>
                          setScoringRuleType(
                            question.questionNumber,
                            event.target.value as "per_selected_count" | "by_correct_count" | "fixed_partial"
                          )
                        }
                      >
                        <option value="per_selected_count">按选对项数给分</option>
                        <option value="by_correct_count">按正确答案数量给分</option>
                        <option value="fixed_partial">少选固定分</option>
                      </select>
                    </label>
                    <label>
                      错选/多选/不选得分
                      <input
                        type="number"
                        step={0.5}
                        value={(scoringRuleFor(question) as any).wrongOrExtraScore ?? 0}
                        onChange={(event) => updateWrongOrExtraScore(question.questionNumber, Number(event.target.value))}
                      />
                    </label>
                  </div>
                  {scoringRuleFor(question).type === "fixed_partial" ? (
                    <label>
                      少选固定得分
                      <input
                        type="number"
                        step={0.5}
                        value={(scoringRuleFor(question) as any).partialScore ?? 0}
                        onChange={(event) => updateFixedPartialScore(question.questionNumber, Number(event.target.value))}
                      />
                    </label>
                  ) : scoringRuleFor(question).type === "by_correct_count" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>
                        根据标准答案个数，设置少选时选对几项得几分
                      </span>
                      {Array.from({ length: Math.max(0, question.optionCount - 1) }, (_, index) => index + 2).map((correctCount) => (
                        <div key={correctCount} style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 8, alignItems: "center" }}>
                          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{correctCount} 个答案</span>
                          <div className="three-col">
                            {Array.from({ length: correctCount - 1 }, (_, index) => index + 1).map((selectedCount) => (
                              <label key={selectedCount}>
                                {selectedCount} 项对
                                <input
                                  type="number"
                                  step={0.5}
                                  value={(scoringRuleFor(question) as any).partialScoresByCorrectCount?.[correctCount]?.[selectedCount] ?? 0}
                                  onChange={(event) =>
                                    updateByCorrectCountScore(
                                      question.questionNumber,
                                      correctCount,
                                      selectedCount,
                                      Number(event.target.value)
                                    )
                                  }
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="three-col">
                      {Array.from({ length: Math.max(1, question.optionCount - 1) }, (_, index) => index + 1).map((selectedCount) => (
                        <label key={selectedCount}>
                          选对 {selectedCount} 项
                          <input
                            type="number"
                            step={0.5}
                            value={(scoringRuleFor(question) as any).partialScores?.[selectedCount] ?? 0}
                            onChange={(event) =>
                              updatePerSelectedScore(question.questionNumber, selectedCount, Number(event.target.value))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={(scoringRuleFor(question) as any).allowWrongOptions === true}
                      onChange={(event) => updateAllowWrongOptions(question.questionNumber, event.target.checked)}
                    />
                    错选但未超过正确答案数时，只按选对项给分
                  </label>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      )}
      <p className="hint">横向模式少于 15 题按行排列、15 题及以上按 5 题小组网格排列；竖向模式按高考 AB 卡式 4 题一组纵向排布，每题选项仍保持横向小组选项。超过 5 个选项的题目独占一行。</p>
    </>
  );
}

function SubjectiveEditor({
  block,
  layoutVersion,
  onChange,
  onUpload
}: {
  block: SubjectiveBlock;
  layoutVersion: 1 | 2;
  onChange: (mutator: (block: BodyBlock) => void) => void;
  onUpload: (blockId: string, questionId: string, file: File) => Promise<void>;
}) {
  const isFillBlankBlock = subjectiveBlockKind(block) === "fill_blank";
  const isEssayBlock = subjectiveBlockKind(block) === "essay";

  function updateQuestion(questionId: string, mutator: (question: SubjectiveQuestion) => void) {
    onChange((draft) => {
      if (draft.type !== "subjective") return;
      const question = draft.questions.find((item) => item.id === questionId);
      if (question) mutator(question);
    });
  }

  function updateAnswerBlankItems(questionId: string, mutator: (items: BlankItem[]) => BlankItem[]) {
    updateQuestion(questionId, (draft) => {
      const items = mutator(answerBlankItems(draft));
      const first = items[0] ?? { label: "(1)", widthMm: 32, heightMm: 6 };
      draft.blanks = {
        ...(draft.blanks ?? { labelStyle: "arabic_parentheses" }),
        count: items.length,
        widthMm: first.widthMm,
        heightMm: first.heightMm,
        labelStyle: draft.blanks?.labelStyle ?? "arabic_parentheses",
        items
      };
    });
  }

  return (
    <>
      <div className="panel-title">{isFillBlankBlock ? "填空题块" : isEssayBlock ? "作文块" : "解答题块"}</div>
      <label>
        标题
        <input value={block.title} onChange={(event) => onChange((draft) => void (draft.title = event.target.value))} />
      </label>
      {isFillBlankBlock && (
        <>
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
          {layoutVersion === 2 && (block.questions[0]?.score ?? 0) <= 0 && (
            <p className="inline-warning">满分为 0，V2 不会生成分数填涂格。请先设置满分。</p>
          )}
        </>
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
                  const isScoreQuestion = isFillBlankBlock && draft.questions[0]?.id === question.id;
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
          {layoutVersion === 2 && !isFillBlankBlock && question.style === "manual_score_grid" && question.score <= 0 && (
            <p className="inline-warning">分值为 0，V2 已隐藏 0/0.5 分数格；设置正分后会自动显示。</p>
          )}
          <div className="two-col">
            <label>
              题号
              <input value={question.number} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.number = event.target.value))} />
            </label>
            {isFillBlankBlock ? (
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
          {isFillBlankBlock ? (
            <>
            <div className="three-col">
              <label>
                空数
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={question.blanks?.count ?? 1}
                  onChange={(event) =>
                    updateQuestion(question.id, (draft) => {
                      const count = Math.max(1, Math.min(8, Number(event.target.value) || 1));
                      const widthMm = draft.blanks?.widthMm ?? 22;
                      const heightMm = draft.blanks?.heightMm ?? 6;
                      const labelStyle = draft.blanks?.labelStyle ?? "none";
                      const prev = draft.blanks?.items ?? [];
                      const items = Array.from({ length: count }, (_, index) => ({
                        label: prev[index]?.label,
                        widthMm: prev[index]?.widthMm ?? widthMm,
                        heightMm: prev[index]?.heightMm ?? heightMm,
                        rightAnnotation: prev[index]?.rightAnnotation
                      }));
                      draft.blanks = { count, widthMm, heightMm, labelStyle, items };
                    })
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
            <div className="blank-item-list">
              {answerBlankItems(question).map((item, blankIndex) => (
                <div className="blank-item-row" key={blankIndex}>
                  <label>
                    空{blankIndex + 1} 右侧批注
                    <input
                      value={item.rightAnnotation ?? ""}
                      placeholder="如：填＞或＜"
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) =>
                            index === blankIndex ? { ...current, rightAnnotation: event.target.value || undefined } : current
                          )
                        )
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
            </>
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
              {question.style === "manual_score_grid" && (
                <div style={{ borderLeft: "1px solid var(--line)", paddingLeft: 8, margin: "4px 0" }}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={question.scoreGrid?.enabled !== false}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        draft.scoreGrid = {
                          enabled: event.target.checked,
                          strokeColor: draft.scoreGrid?.strokeColor ?? "#999",
                          strokeWidthMm: draft.scoreGrid?.strokeWidthMm ?? 0.15,
                          fillColor: draft.scoreGrid?.fillColor ?? "#fff",
                          fontSize: draft.scoreGrid?.fontSize ?? 2.8,
                          dividerColor: draft.scoreGrid?.dividerColor ?? "#ccc",
                          dividerWidthMm: draft.scoreGrid?.dividerWidthMm ?? 0.1,
                          showLabel: draft.scoreGrid?.showLabel !== false,
                        };
                      })}
                    />
                    显示得分填涂格
                  </label>
                  {question.scoreGrid?.enabled !== false && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                      <label>
                        格线色
                        <input type="color" value={question.scoreGrid?.strokeColor ?? "#999"}
                          onChange={(e) => updateQuestion(question.id, (draft) => {
                            if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, strokeColor: e.target.value };
                          })}
                          style={{ padding: 1, height: 24, width: "100%" }} />
                      </label>
                      <label>
                        分隔线
                        <input type="color" value={question.scoreGrid?.dividerColor ?? "#ccc"}
                          onChange={(e) => updateQuestion(question.id, (draft) => {
                            if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, dividerColor: e.target.value };
                          })}
                          style={{ padding: 1, height: 24, width: "100%" }} />
                      </label>
                      <label className="check-row" style={{ gridColumn: "1 / -1" }}>
                        <input type="checkbox" checked={question.scoreGrid?.showLabel !== false}
                          onChange={(e) => updateQuestion(question.id, (draft) => {
                            if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, showLabel: e.target.checked };
                          })} />
                        显示"得分"标签
                      </label>
                    </div>
                  )}
                </div>
              )}
              <label>
                作答区类型
                <select
                  value={question.kind}
                  onChange={(event) =>
                    updateQuestion(question.id, (draft) => {
                      draft.kind = event.target.value as SubjectiveKind;
                      if (draft.kind === "blank" && !draft.blanks?.items?.length) {
                        draft.blanks = defaultAnswerBlankQuestion(numericQuestionValue(draft.number)).blanks;
                      }
                      if (draft.kind === "blank") {
                        draft.style = "manual_score_grid";
                        if (draft.score <= 0) draft.score = 12;
                      }
                    })
                  }
                >
                  {Object.entries(kindLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {layoutVersion === 2 && question.kind === "lined_answer" && question.lineGrid?.enabled ? (
                <label>
                  作答行数
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={answerLineCount(question)}
                    onChange={(event) =>
                      updateQuestion(question.id, (draft) => {
                        const spacing = draft.lineGrid?.lineSpacingMm ?? 8;
                        draft.minHeightMm = heightForAnswerLines(Number(event.target.value), spacing);
                      })
                    }
                  />
                </label>
              ) : (
                <label>
                  最小高度(mm)
                  <input type="number" min={24} max={220} value={question.minHeightMm} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.minHeightMm = Number(event.target.value)))} />
                </label>
              )}
            </>
          )}
          {question.kind === "blank" && !isFillBlankBlock && (
            <div className="blank-item-list">
              {answerBlankItems(question).map((item, blankIndex) => (
                <div className="blank-item-row" key={blankIndex}>
                  <label>
                    小题号
                    <input
                      value={item.label ?? ""}
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, label: event.target.value } : current))
                        )
                      }
                    />
                  </label>
                  <label>
                    右侧批注
                    <input
                      value={item.rightAnnotation ?? ""}
                      placeholder="如：填＞或＜"
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, rightAnnotation: event.target.value || undefined } : current))
                        )
                      }
                    />
                  </label>
                  <label>
                    宽(mm)
                    <input
                      type="number"
                      min={8}
                      value={item.widthMm}
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, widthMm: Number(event.target.value) } : current))
                        )
                      }
                    />
                  </label>
                  <label>
                    高(mm)
                    <input
                      type="number"
                      min={4}
                      value={item.heightMm}
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, heightMm: Number(event.target.value) } : current))
                        )
                      }
                    />
                  </label>
                  <button
                    title="删除这个空"
                    onClick={() => updateAnswerBlankItems(question.id, (items) => (items.length > 1 ? items.filter((_, index) => index !== blankIndex) : items))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <button
                className="ghost-button"
                onClick={() =>
                  updateAnswerBlankItems(question.id, (items) => [
                    ...items,
                    {
                      label: `(${items.length + 1})`,
                      widthMm: items[items.length - 1]?.widthMm ?? 32,
                      heightMm: items[items.length - 1]?.heightMm ?? 6
                    }
                  ])
                }
              >
                <Plus size={16} /> 添加空
              </button>
            </div>
          )}
          {!isFillBlankBlock && (
            <>
              {question.kind !== "blank" && (
                <>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={question.lineGrid?.enabled ?? false}
                  onChange={(event) => updateQuestion(question.id, (draft) => {
                    const wasOn = draft.lineGrid?.enabled;
                    const enabled = event.target.checked;
                    draft.lineGrid = {
                      lineSpacingMm: draft.lineGrid?.lineSpacingMm ?? 8,
                      lineColor: draft.lineGrid?.lineColor ?? "#222",
                      lineWidthMm: draft.lineGrid?.lineWidthMm ?? 0.15,
                      insetLeftMm: draft.lineGrid?.insetLeftMm ?? 8,
                      insetRightMm: draft.lineGrid?.insetRightMm ?? 6,
                      lineStyle: draft.lineGrid?.lineStyle ?? "solid",
                      fixedLineCount: draft.lineGrid?.fixedLineCount,
                      enabled,
                    };
                    if (!wasOn && enabled) {
                      draft.kind = "lined_answer";
                      draft.lineGrid = { ...draft.lineGrid, fixedLineCount: answerLineCount(draft) };
                      draft.minHeightMm = heightForAnswerLines(draft.lineGrid.fixedLineCount!, draft.lineGrid.lineSpacingMm);
                    }
                  })}
                />
                启用横线格
              </label>
              {question.lineGrid?.enabled && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <label style={{ gridColumn: "1 / -1" }}>
                    线型
                    <select
                      value={question.lineGrid.lineStyle ?? "solid"}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, lineStyle: event.target.value as "solid" | "dashed" | "dotted" };
                      })}
                    >
                      <option value="solid">实线</option>
                      <option value="dashed">虚线</option>
                      <option value="dotted">点线</option>
                    </select>
                  </label>
                  <label>
                    行数
                    <input
                      type="number" min={1} max={30}
                      value={question.lineGrid.fixedLineCount ?? answerLineCount(question)}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (!draft.lineGrid) return;
                        const count = Math.max(1, Math.min(30, Number(event.target.value) || 1));
                        draft.lineGrid = { ...draft.lineGrid, fixedLineCount: count };
                        draft.minHeightMm = heightForAnswerLines(count, draft.lineGrid.lineSpacingMm);
                      })}
                    />
                  </label>
                  <label>
                    间距 (mm)
                    <input
                      type="number" min={5} max={16} step={1}
                      value={question.lineGrid.lineSpacingMm ?? 8}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (!draft.lineGrid) return;
                        const sp = Number(event.target.value) || 8;
                        draft.lineGrid = { ...draft.lineGrid, lineSpacingMm: sp };
                        const count = draft.lineGrid.fixedLineCount;
                        if (count) draft.minHeightMm = heightForAnswerLines(count, sp);
                      })}
                    />
                  </label>
                  <label>
                    颜色
                    <input
                      type="color"
                      value={question.lineGrid.lineColor ?? "#222"}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, lineColor: event.target.value };
                      })}
                      style={{ padding: 2, height: 28, width: "100%" }}
                    />
                  </label>
                  <label>
                    线宽 (mm)
                    <input
                      type="number" min={0.05} max={0.5} step={0.05}
                      value={question.lineGrid.lineWidthMm ?? 0.15}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, lineWidthMm: Number(event.target.value) || 0.15 };
                      })}
                    />
                  </label>
                  <label>
                    左边距 (mm)
                    <input
                      type="number" min={0} max={20}
                      value={question.lineGrid.insetLeftMm ?? 8}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, insetLeftMm: Number(event.target.value) ?? 8 };
                      })}
                    />
                  </label>
                  <label>
                    右边距 (mm)
                    <input
                      type="number" min={0} max={20}
                      value={question.lineGrid.insetRightMm ?? 6}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, insetRightMm: Number(event.target.value) ?? 6 };
                      })}
                    />
                  </label>
                </div>
              )}
                </>
              )}
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
      {isFillBlankBlock && (
        <button
          className="ghost-button"
          onClick={() =>
            onChange((draft) => {
              if (draft.type !== "subjective") return;
              const next = Math.max(0, ...draft.questions.map((item) => numericQuestionValue(item.number))) + 1;
              draft.questions.push(defaultBlankQuestion(next));
            })
          }
        >
          <Plus size={16} /> 添加填空题
        </button>
      )}
      {isEssayBlock && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          <label>
            目标字数
            <input
              type="number"
              value={block.questions[0]?.essayGrid?.targetChars ?? 600}
              min={100} max={2000} step={50}
              onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15 };
                draft.essayGrid.targetChars = Number(event.target.value) || 600;
              })}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <label>
              格子宽 (mm)
              <input
                type="number"
                value={block.questions[0]?.essayGrid?.cellWidthMm ?? 7}
                min={4} max={12} step={0.5}
                onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                  if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15 };
                  draft.essayGrid.cellWidthMm = Number(event.target.value) || 7;
                })}
              />
            </label>
            <label>
              格子高 (mm)
              <input
                type="number"
                value={block.questions[0]?.essayGrid?.cellHeightMm ?? 7}
                min={4} max={12} step={0.5}
                onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                  if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15 };
                  draft.essayGrid.cellHeightMm = Number(event.target.value) || 7;
                })}
              />
            </label>
          </div>
          <label>
            <input
              type="checkbox"
              checked={block.questions[0]?.essayGrid?.showTitle !== false}
              onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15 };
                draft.essayGrid.showTitle = event.target.checked;
              })}
            /> 显示"题：（000）"标题
          </label>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            系统将自动计算每栏列数和行数。A3 三栏模式生效时网格均分到三栏。
          </div>
        </div>
      )}
    </>
  );
}

function CardPreview({ card, layout }: { card: AnswerCard; layout: LayoutDocument }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 760, height: 560 });
  const [{ mode, customPercent }, setPreviewSettings] = useState<{ mode: PreviewMode; customPercent: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREVIEW_SETTINGS_KEY) ?? "null") as { mode?: string; customPercent?: number } | null;
      const validModes: PreviewMode[] = ["fit-width", "fit-page", "fit-panel", "custom"];
      const savedMode = validModes.includes(saved?.mode as PreviewMode) ? saved?.mode as PreviewMode : "fit-width";
      const savedPercent = Number(saved?.customPercent);
      return {
        mode: savedMode,
        customPercent: Number.isFinite(savedPercent)
          ? Math.max(PREVIEW_MIN_PERCENT, Math.min(PREVIEW_MAX_PERCENT, savedPercent))
          : 100
      };
    } catch {
      return { mode: "fit-width", customPercent: 100 };
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify({ mode, customPercent }));
    } catch {}
  }, [mode, customPercent]);

  useEffect(() => {
    const root = rootRef.current;
    const parent = root?.parentElement;
    if (!root || !parent) return;
    const measure = () => {
      const style = getComputedStyle(parent);
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      setViewport({
        width: Math.max(1, root.clientWidth),
        height: Math.max(1, parent.clientHeight - verticalPadding - (toolbarRef.current?.offsetHeight ?? 0) - 16)
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const firstPage = layout.pages[0];
  const paperRatio = firstPage ? firstPage.width / firstPage.height : 1;
  const panelRatio = firstPage?.panels[0]?.rect.width
    ? firstPage.width / firstPage.panels[0].rect.width
    : 1;
  const fitPagePercent = Math.max(
    PREVIEW_MIN_PERCENT,
    Math.min(100, viewport.height * paperRatio / viewport.width * 100)
  );
  const effectivePercent = Math.max(
    PREVIEW_MIN_PERCENT,
    Math.min(
      PREVIEW_MAX_PERCENT,
      mode === "fit-page"
        ? fitPagePercent
        : mode === "fit-panel"
          ? panelRatio * 100
          : mode === "custom"
            ? customPercent
            : 100
    )
  );
  const pageWidth = viewport.width * effectivePercent / 100;

  const changeZoom = (delta: number) => {
    const next = Math.max(PREVIEW_MIN_PERCENT, Math.min(PREVIEW_MAX_PERCENT, Math.round(effectivePercent / 10) * 10 + delta));
    setPreviewSettings({ mode: "custom", customPercent: next });
  };

  return (
    <div className="preview-shell" ref={rootRef}>
      <div className="preview-toolbar" ref={toolbarRef} aria-label="预览缩放工具栏">
        <button type="button" className={mode === "fit-width" ? "active" : ""} onClick={() => setPreviewSettings({ mode: "fit-width", customPercent })}>适合宽度</button>
        <button type="button" className={mode === "fit-page" ? "active" : ""} onClick={() => setPreviewSettings({ mode: "fit-page", customPercent })}>适合页面</button>
        <button type="button" className={mode === "fit-panel" ? "active" : ""} onClick={() => setPreviewSettings({ mode: "fit-panel", customPercent })}>适合单版</button>
        <span className="preview-toolbar-separator" />
        <button type="button" aria-label="缩小预览" onClick={() => changeZoom(-10)} disabled={effectivePercent <= PREVIEW_MIN_PERCENT}>−</button>
        <output aria-label="当前缩放比例">{Math.round(effectivePercent)}%</output>
        <button type="button" aria-label="放大预览" onClick={() => changeZoom(10)} disabled={effectivePercent >= PREVIEW_MAX_PERCENT}>＋</button>
      </div>
      <div className="pages">
        {layout.pages.map((page) => (
          <svg
            className="page"
            key={page.pageNumber}
            viewBox={`0 0 ${page.width} ${page.height}`}
            style={{ aspectRatio: `${page.width} / ${page.height}`, width: `${pageWidth}px` }}
            role="img"
            aria-label={`第${page.pageNumber}页预览`}
          >
            <rect x="0" y="0" width={page.width} height={page.height} style={{ fill: "#fff" }} />
            {page.markers.map((marker) => (
              <rect key={marker.role} {...marker.rect} fill="#20342f" />
            ))}
            <text x={page.header.idTextX} y={page.header.idTextY} className="svg-small">
              ID:{page.header.id}
            </text>
            {page.header.codeBoxes.map((box, index) => (
              <rect key={index} {...box} fill={index === 0 || index === page.header.codeBoxes.length - 1 ? "#20342f" : "#fff"} stroke="#222" strokeWidth="0.25" style={index !== 0 && index !== page.header.codeBoxes.length - 1 ? { fill: "#fff" } : undefined} />
            ))}
            {page.header.title && (
              <text x={page.header.titleX} y={page.header.titleY} textAnchor="middle" className="svg-title">
                {page.header.title}
              </text>
            )}
            {page.studentArea && <StudentAreaSvg area={page.studentArea} />}
            {page.blocks.map((block, index) =>
              block.type === "objective" ? <ObjectiveSvg block={block} key={`${block.blockId}_${index}`} /> : <SubjectiveSvg card={card} block={block} key={`${block.blockId}_${index}`} />
            )}
            <text x={page.width / 2} y={page.height - 13} textAnchor="middle" className="svg-footer">
              第{page.pageNumber}页/共{layout.pages.length}页
            </text>
          </svg>
        ))}
      </div>
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
          <rect {...cell.rect} fill="#fff" stroke="#333" strokeWidth="0.15" style={{ fill: "#fff" }} />
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
          <text x={item.labelX - 2.5} y={(item.options[0]?.rect.y ?? item.labelY) + (item.options[0]?.rect.height ?? 0) / 2} textAnchor="middle" dominantBaseline="central" className="svg-option-label">
            {item.questionNumber}
          </text>
          {item.options.map((option) => (
            <g key={option.label}>
              <rect {...option.rect} fill="#fff" stroke="#333" strokeWidth="0.15" style={{ fill: "#fff" }} />
              <text x={option.rect.x + option.rect.width / 2} y={option.rect.y + option.rect.height / 2} textAnchor="middle" dominantBaseline="central" className="svg-option-label">
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
  const isV2 = card.layoutVersion === 2;

  // 作文块专用渲染
  const originalBlock = card.bodyBlocks.find(b => b.id === block.blockId);
  const isEssay = originalBlock?.type === "subjective" && originalBlock.blockKind === "essay";

  if (isEssay) {
    const q = originalBlock && originalBlock.type === "subjective" ? originalBlock.questions[0] : null;
    const g = q?.essayGrid;
    if (!g) return null;
    const cellW = g.cellWidthMm || 7;
    const cellH = g.cellHeightMm || 7;
    const lineColor = g.lineColor || "#222";
    const lineW = g.lineWidthMm ?? 0.15;
    const showTitle = g.showTitle !== false;

    // 计算栏宽和列数
    const bodyW = block.rect.width;
    const insetX = 4;
    const usableW = bodyW - insetX * 2;
    const columns = g.columns > 0 ? g.columns : Math.max(1, Math.floor(usableW / cellW));
    const gridW = columns * cellW;
    const offsetX = block.rect.x + (bodyW - gridW) / 2;

    // 高度内能放的行数
    const gridH = block.rect.height - (showTitle ? 9 : 2);
    const rows = Math.floor(gridH / cellH);
    const startY = block.rect.y + (showTitle ? 9 : 2);

    return (
      <g>
        {showTitle && block.title && (
          <>
            <text x={block.rect.x + insetX} y={block.rect.y + 5} className="svg-section">{block.title}（{q?.score}分）</text>
            <text x={block.rect.x + insetX + 64} y={block.rect.y + 5} className="svg-tiny" fill="#888">
              题：（{String(q?.number ?? 1).padStart(3, "0")}）
            </text>
          </>
        )}
        {[...Array(rows)].map((_, row) =>
          [...Array(columns)].map((_, col) => (
            <rect
              key={`${row}_${col}`}
              x={offsetX + col * cellW}
              y={startY + row * cellH}
              width={cellW}
              height={cellH}
              fill="#fff"
              stroke={lineColor}
              strokeWidth={lineW}
            />
          ))
        )}
      </g>
    );
  }

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
          {question.style === "manual_score_grid" && (!isV2 || question.scoreCells.length > 0) && (
            (() => {
              const sg = question.scoreGrid;
              const sc = sg?.strokeColor ?? "#999";
              const sw = sg?.strokeWidthMm ?? 0.15;
              const fc = sg?.fillColor ?? "#fff";
              const fs = sg?.fontSize ?? 2.8;
              const dc = sg?.dividerColor ?? "#ccc";
              const dw = sg?.dividerWidthMm ?? 0.1;
              const showL = sg?.showLabel !== false;
              return (
            <>
              {block.frameRect && question.kind === "blank" && question.scoreCells.length > 0 ? (
                <>
                  {showL && (
                    <text x={block.frameRect.x + 4} y={question.scoreCells[0].rect.y + (isV2 ? 3 : 4.2)} className="svg-tiny">
                      得分
                    </text>
                  )}
                  <line
                    x1={block.frameRect.x}
                    y1={isV2 ? block.frameRect.y + 6 : question.scoreCells[0].rect.y + question.scoreCells[0].rect.height + 2}
                    x2={block.frameRect.x + block.frameRect.width}
                    y2={isV2 ? block.frameRect.y + 6 : question.scoreCells[0].rect.y + question.scoreCells[0].rect.height + 2}
                    stroke={dc}
                    strokeWidth={dw}
                  />
                </>
              ) : (
                <line x1={question.rect.x} y1={question.contentRect.y} x2={question.rect.x + question.rect.width} y2={question.contentRect.y} stroke={dc} strokeWidth={dw} />
              )}
              {question.scoreCells.map((cell) => (
                <g key={cell.score}>
                  <rect x={cell.rect.x} y={cell.rect.y} width={cell.rect.width} height={cell.rect.height}
                    fill={fc} stroke={sc} strokeWidth={sw} style={{ fill: fc }} />
                  {cell.score !== null && (
                    <text x={cell.rect.x + cell.rect.width / 2} y={cell.rect.y + (isV2 ? 3 : 4.2)} textAnchor="middle"
                      fontSize={fs} fill="#333">
                      {cell.score}
                    </text>
                  )}
                </g>
              ))}
            </>
              );
            })()
          )}
          {question.kind === "blank" ? (
            <text x={question.contentRect.x + 3} y={question.contentRect.y + 7.2} className="svg-tiny">
              {question.questionNumber}
            </text>
          ) : (
            <text x={question.rect.x + 2} y={isV2 ? question.rect.y + 4.3 : question.contentRect.y + 6} className="svg-tiny">
              {question.questionNumber}.（{question.score}分）
            </text>
          )}
          {question.lineYs.map((lineY) => {
            const cfg = question.lineGrid;
            const color = cfg?.lineColor ?? "#222";
            const width = cfg?.lineWidthMm ?? 0.15;
            const insetL = cfg?.insetLeftMm ?? 8;
            const insetR = cfg?.insetRightMm ?? 6;
            const dash = cfg?.lineStyle === "dashed" ? "1.2,0.8" : cfg?.lineStyle === "dotted" ? "0.3,0.7" : undefined;
            return (
              <line key={lineY} x1={question.contentRect.x + insetL} y1={lineY}
                    x2={question.contentRect.x + question.contentRect.width - insetR} y2={lineY}
                    stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap={cfg?.lineStyle === "dotted" ? "round" : undefined} />
            );
          })}
          {question.blanks.map((blank, index) => {
            const blankLabel = question.blankLabels?.[index] ?? (question.kind === "blank" ? formatBlankLabel(question.blankLabelStyle, index) : `${question.questionNumber}.${index + 1}`);
            return (
              <g key={index}>
                {blankLabel && (
                  <text x={blank.x - 0.8} y={blank.y + blank.height} textAnchor="end" dominantBaseline="middle" className="svg-blank-label">
                    {blankLabel}
                  </text>
                )}
                <line x1={blank.x} y1={blank.y + blank.height} x2={blank.x + blank.width} y2={blank.y + blank.height} stroke="#333" strokeWidth="0.25" />
                {question.blankRightAnnotations?.[index] && (
                  <text x={blank.x + blank.width + 1.2} y={blank.y + blank.height} dominantBaseline="middle"
                    fontSize="3" fill="#888">
                    {question.blankRightAnnotations[index]}
                  </text>
                )}
              </g>
            );
          })}
          {question.images.map((image) => (
            <g key={image.assetId}>
              <image href={apiUrl(`/assets/${card.id}/${image.assetId}`)} x={image.rect.x} y={image.rect.y} width={image.rect.width} height={image.rect.height} preserveAspectRatio="xMidYMid meet" />
              <rect {...image.rect} fill="none" stroke="#666" strokeWidth="0.18" />
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}

export default App;
