import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Route, Routes, Navigate, useBlocker, useLocation, useNavigate } from "react-router-dom";
import { MODE_PATH, pathToMode } from "./modeRoutes";
import { WorkspaceProvider, type WorkspaceValue } from "./WorkspaceContext";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ClipboardCheck,
  ClipboardList,
  Download,
  FileDown,
  FolderOpen,
  ImagePlus,
  Layers,
  ListPlus,
  Menu,
  Moon,
  Plus,
  Save,
  Search,
  Settings,
  Sun,
  BookOpen,
  Home,
  SquarePen,
  Upload,
  Users,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Check,
  X,
  ArrowLeft,
} from "lucide-react";
import { useAuth } from "./auth/AuthContext";
import { apiUrl, authFetch, fetchJson, mediaUrl, urlWithToken } from "./auth/api";
import { cn } from "./lib/utils";
import { PERMISSIONS } from "./auth/types";
import { LoginPage } from "./components/LoginPage";
import { AccountMenu } from "./components/AccountMenu";
import { BeianFooter } from "./components/BeianFooter";
import { NotFound } from "./components/NotFound";
import { NewCardModal, type NewCardFormData } from "./components/NewCardModal";
import { AssignedFormulaModal } from "./components/AssignedFormulaModal";
import { CreateExamGroupModal } from "./components/CreateExamGroupModal";
import { GroupExportModal } from "./components/GroupExportModal";
import { HomeRoutePage } from "./pages/HomeRoutePage";
import {
  AppShell,
  AppMain,
  AppContentRow,
  AppContent,
  AppRail,
  AppRailBrand,
  AppRailNav,
  AppRailGroupLabel,
  AppRailItem,
  AppRailFooter,
  PageHeader,
  StatusBar,
  StatusItem,
  StatusSpacer,
  SaveStatus,
  Button,
  Badge,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetBody,
  Spinner,
  TooltipProvider,
  Toaster,
  Card,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  EmptyState,
  Checkbox,
  type SaveState,
} from "./components/ui/v2";

// 路由级懒加载（dev 首屏性能）：登录后首屏只需 HomeRoutePage，
// 其余模式页面按需加载，将 chart.js / react-markdown 等重依赖隔离出首屏模块图。
const DesignPage = lazy(() => import("./pages/DesignPage").then((m) => ({ default: m.DesignPage })));
const ExamManagePage = lazy(() => import("./pages/ExamManagePage").then((m) => ({ default: m.ExamManagePage })));
const AnalysisRoutePage = lazy(() => import("./pages/AnalysisRoutePage").then((m) => ({ default: m.AnalysisRoutePage })));
const ScoresRoutePage = lazy(() => import("./pages/ScoresRoutePage").then((m) => ({ default: m.ScoresRoutePage })));
const AccountRoutePage = lazy(() => import("./pages/AccountRoutePage").then((m) => ({ default: m.AccountRoutePage })));
const AccountSettingsPage = lazy(() => import("./pages/AccountSettingsPage").then((m) => ({ default: m.AccountSettingsPage })));
const SponsorRoutePage = lazy(() => import("./pages/InfoRoutePages").then((m) => ({ default: m.SponsorRoutePage })));
const PermissionsRoutePage = lazy(() => import("./pages/InfoRoutePages").then((m) => ({ default: m.PermissionsRoutePage })));
const GuideRoutePage = lazy(() => import("./pages/InfoRoutePages").then((m) => ({ default: m.GuideRoutePage })));
const GlobalSettingsRoutePage = lazy(() => import("./pages/GlobalSettingsRoutePage").then((m) => ({ default: m.GlobalSettingsRoutePage })));
const GradePanel = lazy(() => import("./components/GradePanel").then((m) => ({ default: m.GradePanel })));
const PaperUploadPanel = lazy(() => import("./components/PaperUploadPanel").then((m) => ({ default: m.PaperUploadPanel })));

// 懒加载路由切换时的居中加载指示（与 loading 态文案一致）
const routeFallback = (
  <div className="flex min-h-[40vh] items-center justify-center gap-2 text-muted-foreground">
    <Spinner size={18} />
    <span className="text-sm">正在加载...</span>
  </div>
);
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
import type {
  ExamRecord,
} from "../../../shared/types";
import {
  modeLabels,
  optionLayoutLabels,
  styleLabels,
  kindLabels,
  blankLabelStyleLabels,
  subjectiveBlockKind,
  subjectiveBlockKindLabel,
  answerBlankItems,
  cloneCard,
  answerText,
  defaultObjective,
  defaultSubjective,
  defaultBlankBlock,
  defaultEssayBlock,
  defaultAnswerBlankQuestion,
  answerLineCount,
  heightForAnswerLines,
  numericQuestionValue,
  findNextQuestionNumber,
  defaultBlankQuestion
} from "./cardModel";



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

type PdfWarningState = {
  validation: CardScoreValidationResult;
  pdfUrl: string;
  step: "score" | "paper" | "knowledge";  // 当前步骤
  paperInfo?: { hasPaper: boolean; filename?: string; mimeType?: string };
  knowledgeReady?: boolean;   // 知识点是否已分析
  knowledgePoints?: Array<{ question_number: number; points: string[] }>;  // 知识点列表
  cardId?: string;
};








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
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">题目范围 *</h4>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name="kpRange" checked={questionRange === "all"} onChange={() => setQuestionRange("all")} />
        全部题目
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name="kpRange" checked={questionRange === "custom"} onChange={() => setQuestionRange("custom")} />
        自定义范围
      </label>
      {questionRange === "custom" && (
        <input type="text" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          placeholder="如：第1-15题、选择题"
          value={customRange} onChange={(e) => setCustomRange(e.target.value)} />
      )}
      <textarea className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        placeholder="特别描述（可选）" value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} rows={2} />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button variant="primary" type="button" onClick={handleAnalyze} disabled={analyzing}
        icon={<BrainCircuit size={16} />}>
        {analyzing ? "分析中..." : "开始分析"}
      </Button>
      {analyzing && <p className="mt-1 text-xs text-muted-foreground">正在调用 AI 分析，约需 10-30 秒...</p>}
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
  const [designScreen, setDesignScreen] = useState<"select" | "editor">("select");
  const [mode, setMode] = useState<AppMode>(pathToMode(window.location.pathname) ?? "home");
  const navigate = useNavigate();
  const location = useLocation();
  const modeInitialized = useRef(false);
  // URL ↔ mode 同步（Phase 2 网页化）：深链/刷新/浏览器前进后退均保持当前页
  // 权限校验在 canOpenMode 声明后统一执行，避免学生端通过教师深链进入页面。

  // 阶段 2.5：离开「设计」页且存在未保存更改时，拦截导航并弹确认（需数据路由支持）
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      mode === "design" &&
      autoSaveState === "dirty" &&
      currentLocation.pathname !== nextLocation.pathname
  );
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
  // v1.9.4: 原卷两开关提升为纯全局，由管理员在「全局设置」统一控制；全平台遵从。
  const [globalPaper, setGlobalPaper] = useState<{ requireOriginalPaper: number; highlightMissingPaper: number }>({
    requireOriginalPaper: 1,
    highlightMissingPaper: 1,
  });
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>("idle");
  const gradingProgressSourceRef = useRef<EventSource | null>(null);
  // Note: Scanner has been split into a separate build (ScannerApp.tsx).
  // Web mode never renders ScannerPanel; the "扫描仪录入" button is removed.
  const [analysisExamId, setAnalysisExamId] = useState<number | null>(null);
  const [analysisClassId, setAnalysisClassId] = useState<string>("");
  const [analysisClasses, setAnalysisClasses] = useState<Array<{ classId: number; className: string }>>([]);
  const [showExportMenu, setShowExportMenu] = useState(false);
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try { return localStorage.getItem("projectx-rail-collapsed") === "true"; } catch { return false; }
  });
  const [railExpandedOnHover, setRailExpandedOnHover] = useState(false);
  const [railAutoExpand, setRailAutoExpand] = useState(() => {
    try { return localStorage.getItem("projectx-rail-auto-expand") !== "false"; } catch { return true; }
  });
  const railCollapseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("projectx-rail-collapsed");
      if (saved !== null) setRailCollapsed(saved === "true");
    } catch { /* ignore storage failures */ }
  }, []);

  useEffect(() => {
    try { localStorage.setItem("projectx-rail-collapsed", String(railCollapsed)); } catch { /* ignore storage failures */ }
  }, [railCollapsed]);

  useEffect(() => {
    const syncRailSetting = (event: Event) => {
      const value = (event as CustomEvent<boolean>).detail;
      if (typeof value === "boolean") setRailAutoExpand(value);
    };
    window.addEventListener("projectx:rail-auto-expand", syncRailSetting);
    return () => window.removeEventListener("projectx:rail-auto-expand", syncRailSetting);
  }, []);
  const effectiveRailCollapsed = railCollapsed && !railExpandedOnHover;

  useEffect(() => () => {
    if (railCollapseTimerRef.current !== null) window.clearTimeout(railCollapseTimerRef.current);
  }, []);

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
  const canManageGlobal = variantAllows("global-settings") && hasPermission(PERMISSIONS.SYSTEM_MANAGE);
  const canOpenMode = useCallback(
    (candidate: AppMode) => {
      if (!appVariant.allowedModes.includes(candidate)) return false;
      if (candidate === "home") return appVariant.id !== "student";
      if (candidate === "scores") return appVariant.id === "student" || hasPermission(PERMISSIONS.SCORE_READ);
      if (candidate === "design") return canDesign;
      if (candidate === "exam-manage") return canManageExams;
      if (candidate === "analysis") return canAnalyze;
      if (candidate === "account") return canManageAccounts;
      if (candidate === "account-settings") return true;
      if (candidate === "global-settings") return canManageGlobal;
      return false;
    },
    [appVariant.allowedModes, appVariant.id, hasPermission, canDesign, canManageExams, canAnalyze, canManageAccounts, canManageGlobal],
  );
  const fallbackMode = appVariant.id === "student" ? "scores" : "home";
  // 设计器已固定为「画廊 → 编辑器」两步流程，不能再叠加旧的全局答题卡侧栏。
  const showCardSidebar = false;
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
    if (canOpenMode("home")) {
      items.push({ id: "home", icon: <Home size={22} />, label: "首页", shortLabel: "首页" });
    }
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
  }, [canOpenMode, canDesign, canManageExams, canAnalyze, showScoresTab, canManageAccounts, loadExams, loadExamGroups]);

  useEffect(() => {
    latestCardRef.current = card;
  }, [card]);

  // v1.9.4: 拉取全局原卷标志（认证即可读），驱动导出拦截/自动弹窗/侧边栏高亮
  const refreshGlobalPaper = useCallback(() => {
    return fetchJson<{ ok: boolean; data: { requireOriginalPaper: number; highlightMissingPaper: number } }>(
      "/api/system-settings/public"
    )
      .then((r) => {
        if (r?.ok && r.data) setGlobalPaper(r.data);
      })
      .catch(() => {});
  }, []);
  useEffect(() => { void refreshGlobalPaper(); }, [refreshGlobalPaper]);

  useEffect(() => {
    if (!user) return;
    const fromUrl = pathToMode(location.pathname);
    const nextMode = fromUrl && canOpenMode(fromUrl) ? fromUrl : fallbackMode;
    if (mode !== nextMode) setMode(nextMode);
    if (!fromUrl || !canOpenMode(fromUrl)) {
      navigate(MODE_PATH[fallbackMode], { replace: true });
    }
    modeInitialized.current = true;
  }, [user?.id, location.pathname, mode, canOpenMode, fallbackMode, navigate]);

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
      // 检查是否有弹层打开（弹层自行处理 ESC）：
      //  · [data-state="open"] 的 dialog/alertdialog —— v2 Dialog/Sheet（Radix 自带 ESC 关闭）
      // P5：App.tsx 内的旧 .modal-overlay/.modal-backdrop 已换成 v2 Dialog，
      // 必须同时识别 Radix 弹层，否则 ESC 会穿透到全局返回逻辑。
      if (
        document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')
      ) return;

      // 成绩分析子页 → 返回考试选择
      if (mode === "analysis" && analysisTab !== "select") {
        setSelectedAnalysisExamId(null);
        setAnalysisTab("select");
        return;
      }
      // 赞助/使用说明 → 返回上一模式（同步 URL）
      if (mode === "sponsor" || mode === "guide" || mode === "permissions") {
        navigate(MODE_PATH[previousModeRef.current] ?? "/home");
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

      // v1.8.0: 自动弹出原卷上传面板（受全局「强制要求上传原卷」控制）
      if (globalPaper.requireOriginalPaper !== 0) {
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
    // v1.8.0: 检查原卷是否上传（受全局「强制要求上传原卷」控制）
    try {
      const cardInfo = await fetchJson<{ has_original_paper?: number }>(`/api/cards/${cardId}/paper/info`);
      if (globalPaper.requireOriginalPaper !== 0 && !cardInfo?.has_original_paper) {
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
    let paperInfo: { hasPaper: boolean; filename?: string; mimeType?: string } = { hasPaper: false };
    let knowledgeReady = false;
    let knowledgePoints: Array<{ question_number: number; points: string[] }> = [];

    // 受全局「强制要求上传原卷」控制
    if (globalPaper.requireOriginalPaper !== 0) {
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
        block.title = `${prefix}、${typeName}（共${count}题，共${total}分）`;
      } else if (block.type === "subjective") {
        const sub = block as SubjectiveBlock;
        let typeName = "解答题";
        if (sub.blockKind === "essay") {
          typeName = "作文";
        } else if (sub.blockKind === "fill_blank") {
          typeName = "填空题";
        } else {
          const isFillBlank = sub.questions.length > 0 && sub.questions[0]?.style === "manual_score_grid" && sub.questions.every((q) => q.kind === "blank");
          typeName = isFillBlank ? "填空题" : "解答题";
        }
        const prefix = toChinese(index + 1);
        const count = sub.questions.length;
        const total = sub.questions.reduce((sum, q) => sum + (q.score || 0), 0);
        block.title = `${prefix}、${typeName}（共${count}题，共${total}分）`;
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
    if (!canOpenMode(nextMode)) {
      const safeMode = canOpenMode(fallbackMode) ? fallbackMode : mode;
      if (safeMode !== mode) {
        setMode(safeMode);
        navigate(MODE_PATH[safeMode]);
      }
      return;
    }
    if (mode === "design" && nextMode !== "design") {
      try {
        await flushPendingCardSave("switch");
      } catch {
        return;
      }
    }
    setMode(nextMode);
    navigate(MODE_PATH[nextMode]);
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
      const extra = !gradingExamId
        ? "（未选择考试，数据未落库）"
        : result.persistence?.status === "done"
          ? `，已持久化 ${result.persistence.persisted} 名学生并关闭考试`
          : `，仅持久化 ${result.persistence?.persisted ?? 0} 名学生，${result.persistence?.failedCount ?? 0} 项失败；考试未关闭，可修正后重试`;
      setStatus(msg + extra);
    } catch (error) {
      const failedResult = error as Error & Partial<CombinedGradingBatchResult>;
      if (Array.isArray(failedResult.rows) && failedResult.persistence) {
        setGradingResult(failedResult as CombinedGradingBatchResult);
        setStatus(
          `阅卷落库失败：已持久化 ${failedResult.persistence.persisted} 名学生，` +
          `${failedResult.persistence.failedCount} 项失败；考试未关闭，可修正后重试`
        );
      } else {
        setStatus(`阅卷失败：${error instanceof Error ? error.message : String(error)}`);
      }
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

  const railNavItems: Array<
    | { type: "item"; id: AppMode; icon: ReactElement; label: string; onClick?: () => void | Promise<void> }
    | { type: "group"; label: string }
  > = useMemo(() => {
    const items: typeof railNavItems = [];
    if (canOpenMode("home")) {
      items.push({ type: "item", id: "home", icon: <Home />, label: "首页" });
    }
    if (canDesign) {
      items.push({ type: "item", id: "design", icon: <SquarePen />, label: "答题卡设计" });
    }
    if (canManageExams) {
      items.push({
        type: "item",
        id: "exam-manage",
        icon: <ClipboardList />,
        label: "考试管理",
        onClick: async () => {
          await loadExams();
          await loadExamGroups();
        },
      });
    }
    if (canAnalyze) {
      items.push({ type: "item", id: "analysis", icon: <BarChart3 />, label: "成绩分析", onClick: loadExams });
    }
    if (showScoresTab) {
      items.push({ type: "item", id: "scores", icon: <BarChart3 />, label: "我的成绩" });
    }
    // 个人账号设置：所有已登录用户可访问（与「账号管理/全局设置」管理区相邻）
    if (canOpenMode("account-settings")) {
      items.push({ type: "item", id: "account-settings", icon: <Settings />, label: "账号设置" });
    }
    if (canManageAccounts || canManageGlobal) {
      items.push({ type: "group", label: "管理" });
    }
    if (canManageAccounts) {
      items.push({ type: "item", id: "account", icon: <Users />, label: "账号管理" });
    }
    if (canManageGlobal) {
      items.push({ type: "item", id: "global-settings", icon: <Settings />, label: "全局设置" });
    }
    return items;
  }, [canOpenMode, canDesign, canManageExams, canAnalyze, showScoresTab, canManageAccounts, canManageGlobal, loadExams, loadExamGroups]);

  const selectedBlock = card?.bodyBlocks.find((block) => block.id === selectedBlockId) ?? null;

  if (loading) {
    // P5：原先用 styles.css 的 .login-shell/.empty-text/.login-beian-footer，
    // 改为 v2 Card + Spinner；BeianFooter 仍 floating 贴右下，不参与居中流。
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
        <Card className="flex flex-col items-center gap-3 px-8 py-7">
          <Spinner size={24} />
          <p className="text-sm font-medium text-muted-foreground">正在加载...</p>
        </Card>
        <BeianFooter floating />
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const navigateBackFromInfo = () => navigate(MODE_PATH[previousModeRef.current] ?? "/home");
  const startReview = (examId: number, blockId: string) => setGradingPanel({ examId, blockId });

  const workspace: WorkspaceValue = {
    user,
    hasPermission,
    appVariant,
    variantAllows,
    mode,
    setMode,
    previousModeRef,
    navigateBackFromInfo,
    switchMode,
    cards,
    card,
    setCard,
    selectedBlockId,
    setSelectedBlockId,
    layout,
    selectedBlock,
    designScreen,
    setDesignScreen,
    updateCard,
    updateBlock,
    moveBlock,
    removeBlock,
    addObjectiveBlock,
    addSubjectiveBlock,
    addBlankBlock,
    addEssayBlock,
    uploadImage,
    subjectiveBlockKindLabel,
    loadCard,
    createCard,
    saveCard,
    exportPdfForCurrentCard,
    deleteCard,
    refreshCards,
    flushPendingCardSave,
    autoSaveState,
    autoSaveLabel,
    isBusy,
    setIsBusy,
    status,
    setStatus,
    gradingFiles,
    setGradingFiles,
    gradingExamId,
    setGradingExamId,
    cardOverride,
    setCardOverride,
    gradingResult,
    setGradingResult,
    gradingProgress,
    addGradingFiles,
    gradeAnswerCardFiles,
    downloadCsv,
    exams,
    setExams,
    examListRefreshKey,
    examGroups,
    setExamGroups,
    examManageMode,
    setExamManageMode,
    showCreateExam,
    setShowCreateExam,
    showCreateGroup,
    setShowCreateGroup,
    selectedExamIds,
    setSelectedExamIds,
    selectedExamId,
    setSelectedExamId,
    newExamName,
    setNewExamName,
    newExamSubject,
    setNewExamSubject,
    newExamCardId,
    setNewExamCardId,
    loadExams,
    loadExamGroups,
    deleteExams,
    setExamDeleteTarget,
    setGroupDeleteTarget,
    setAssignedFormulaExamId,
    onStartReview: startReview,
    analysisTab,
    setAnalysisTab,
    selectedAnalysisExamId,
    setSelectedAnalysisExamId,
    analysisGroupId,
    setAnalysisGroupId,
    showGroupExport,
    setShowGroupExport,
    showImportCardModal,
    setShowImportCardModal,
    importCardData,
    setImportCardData,
    handleImportConfirm,
    showPaperPanel,
    setShowPaperPanel,
    paperPanelCardId,
    setPaperPanelCardId,
    exportCheck,
    setExportCheck,
    paperPreviewOpen,
    setPaperPreviewOpen,
    paperZoom,
    setPaperZoom,
    cardDeleteConflict,
    setCardDeleteConflict,
    theme,
    setTheme,
    showBg,
    setShowBg,
    drawerOpen,
    setDrawerOpen,
    canDesign,
    canManageExams,
    canGrade,
    canAnalyze,
    canViewScores,
    canManageAccounts,
    canManageGlobal,
    canWriteExam,
    showCardSidebar,
    showScoresTab,
    mobileNavItems,
  };

  const pageTitle =
    mode === "home"
      ? "首页"
      : mode === "scores"
        ? "我的成绩"
        : mode === "exam-manage"
          ? "考试管理"
          : mode === "account"
            ? "账号管理"
            : mode === "account-settings"
              ? "账号设置"
              : mode === "sponsor"
              ? "支持项目"
              : mode === "guide"
                ? "使用说明"
                : mode === "global-settings"
                  ? "全局设置"
                  : mode === "permissions"
                    ? "权限说明"
                    : mode === "design" && designScreen === "select"
                      ? "答题卡"
                      : mode === "design" ? "答题卡设计器" : card?.title ?? (canDesign ? "答题卡设计器" : "答题卡系统");

  const pageSubtitle =
    mode === "home"
      ? `欢迎，${user?.name ?? ""}`
      : mode === "scores"
        ? "仅展示本人成绩 · 只读"
        : mode === "exam-manage"
          ? "创建、管理考试与阅卷批次"
          : mode === "account"
            ? "管理用户、班级与花名册"
            : mode === "account-settings"
              ? "个人阅卷、客户端与 AI 服务偏好"
              : mode === "sponsor"
              ? "感谢您的信任与支持"
              : mode === "guide"
                ? "Project-X 操作指南与常见问题"
                : mode === "global-settings"
                  ? "系统级策略与服务商配置"
                  : mode === "permissions"
                    ? `${user.name} · ${user.role_display_name ?? user.role_name}`
                    : mode === "design" && designScreen === "select"
                      ? "选择或新建一张答题卡"
                      : card && mode === "design"
                        ? `${card.title} · ID:${card.id} · ${layout?.pages.length ?? 1} 页`
                        : card
                          ? `ID:${card.id} · ${layout?.pages.length ?? 1} 页`
                        : canDesign
                          ? "创建答题卡后开始编辑"
                          : `${user.name} · ${user.role_display_name ?? user.role_name}`;

  const designActions = canDesign && mode === "design" && (
    designScreen === "select" ? (
      <Button variant="primary" size="sm" onClick={() => setShowNewCardModal(true)} disabled={isBusy}>
        <Plus size={16} /> 新建答题卡
      </Button>
    ) : card ? (
      <>
        <Button variant="ghost" size="sm" onClick={() => setDesignScreen("select")}>
          <ArrowLeft size={16} /> 卡片列表
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <a href={urlWithToken(`/api/cards/${card.id}/layout`)} target="_blank" rel="noreferrer">
            坐标 JSON
          </a>
        </Button>
        <Button variant="outline" size="sm" onClick={() => void exportPdfForCurrentCard()} disabled={isBusy}>
          <FileDown size={16} /> PDF
        </Button>
        <Button variant="primary" size="sm" onClick={() => void saveCard()} disabled={isBusy}>
          <Save size={16} /> 保存
        </Button>
        {autoSaveLabel && (
          <SaveStatus
            state={autoSaveState as SaveState}
            savedAt={autoSaveState === "saved" ? new Date().toLocaleTimeString() : undefined}
          />
        )}
      </>
    ) : null
  );

  return (
    <WorkspaceProvider value={workspace}>
       <TooltipProvider>
       <AppShell>
        <AppRail
          collapsed={effectiveRailCollapsed}
          className="relative"
          onMouseEnter={() => {
            if (railCollapseTimerRef.current !== null) window.clearTimeout(railCollapseTimerRef.current);
             if (railCollapsed && railAutoExpand) setRailExpandedOnHover(true);
          }}
          onMouseLeave={() => {
             if (!railCollapsed || !railAutoExpand) return;
            if (railCollapseTimerRef.current !== null) window.clearTimeout(railCollapseTimerRef.current);
            railCollapseTimerRef.current = window.setTimeout(() => setRailExpandedOnHover(false), 120);
          }}
        >
          <Button
            variant="outline"
            size="icon-sm"
            type="button"
            aria-label={railCollapsed ? "展开侧边栏" : "收起侧边栏"}
            title={railCollapsed ? "展开侧边栏" : "收起侧边栏"}
            className="absolute -right-3 top-1/2 z-50 -translate-y-1/2 rounded-full bg-card shadow-2"
            onClick={() => {
              setRailCollapsed((collapsed) => !collapsed);
              setRailExpandedOnHover(false);
            }}
          >
            <ChevronLeft className={cn("size-3.5 transition-transform duration-(--px-dur-2)", railCollapsed && "rotate-180")} />
          </Button>
          <AppRailBrand
            logo={<span className="text-sm font-bold">P</span>}
            title="Project-X"
            subtitle="答题卡设计系统"
            collapsed={effectiveRailCollapsed}
          />
          <AppRailNav>
            {railNavItems.map((it, idx) =>
              it.type === "group" ? (
                <AppRailGroupLabel key={`g-${idx}`} collapsed={effectiveRailCollapsed}>{it.label}</AppRailGroupLabel>
              ) : (
                <AppRailItem
                  key={it.id}
                  icon={it.icon}
                  label={it.label}
                  active={mode === it.id}
                  collapsed={effectiveRailCollapsed}
                  onClick={() => void switchMode(it.id, it.onClick)}
                />
              ),
            )}
          </AppRailNav>
          <AppRailFooter className={effectiveRailCollapsed ? "flex-col" : undefined}>
            <button
              type="button"
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
              title={theme === "light" ? "切换为夜间模式" : "切换为日间模式"}
              aria-label="切换主题"
              className="inline-flex h-control-md w-control-md items-center justify-center rounded-md text-secondary-foreground transition-colors duration-(--px-dur-1) hover:bg-secondary hover:text-foreground"
            >
              {theme === "light" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <AccountMenu
              compact={effectiveRailCollapsed}
              onOpenSponsor={() => {
                previousModeRef.current = mode;
                void switchMode("sponsor");
              }}
              onOpenGuide={() => {
                previousModeRef.current = mode;
                void switchMode("guide");
              }}
              onOpenPermissions={() => {
                previousModeRef.current = mode;
                void switchMode("permissions");
              }}
            />
          </AppRailFooter>
        </AppRail>

        <AppMain>
          <PageHeader
            title={pageTitle}
            subtitle={pageSubtitle}
             leading={undefined}
            actions={
              <div className="flex items-center gap-2">
                {designActions}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="hidden lg:inline-flex"
                  onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
                  aria-label="切换主题"
                >
                  {theme === "light" ? <Sun size={18} /> : <Moon size={18} />}
                </Button>
                <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
                  <button
                    type="button"
                    className="inline-flex h-control-md w-control-md items-center justify-center rounded-md text-secondary-foreground transition-colors duration-(--px-dur-1) hover:bg-secondary hover:text-foreground lg:hidden"
                    onClick={() => setDrawerOpen(true)}
                    aria-label="打开导航菜单"
                  >
                    <Menu size={20} />
                  </button>
                  <SheetContent side="left" className="w-[260px]">
                    <SheetHeader>
                      <SheetTitle>Project-X 导航</SheetTitle>
                    </SheetHeader>
                    <SheetBody>
                      <nav className="flex flex-col gap-1">
                        {railNavItems.map((it, idx) =>
                          it.type === "group" ? (
                            <div
                              key={`mg-${idx}`}
                              className="mt-3 mb-1 px-2 text-xs font-medium text-muted-foreground"
                            >
                              {it.label}
                            </div>
                          ) : (
                            <button
                              key={it.id}
                              type="button"
                              onClick={() => {
                                setDrawerOpen(false);
                                void switchMode(it.id, it.onClick);
                              }}
                              className={cn(
                                "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-base font-medium transition-colors",
                                mode === it.id
                                  ? "bg-accent text-accent-foreground"
                                  : "text-secondary-foreground hover:bg-secondary hover:text-foreground",
                              )}
                            >
                              {it.icon}
                              {it.label}
                            </button>
                          ),
                        )}
                      </nav>
                    </SheetBody>
                  </SheetContent>
                </Sheet>
              </div>
            }
          />

          <AppContentRow>
            <AppContent width={mode === "home" ? "wide" : "full"} bare={mode !== "home"}>
              {/* C 阶段（2026-07-21）：真实 URL 路由渲染 —— 仅当前路径对应的页面挂载。 */}
              <Routes>
                <Route path="/home" element={canOpenMode("home") ? <HomeRoutePage /> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/design/*" element={canOpenMode("design") ? <Suspense fallback={routeFallback}><DesignPage /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/exam-manage" element={canOpenMode("exam-manage") ? <Suspense fallback={routeFallback}><ExamManagePage /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/analysis" element={canOpenMode("analysis") ? <Suspense fallback={routeFallback}><AnalysisRoutePage /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/scores" element={canOpenMode("scores") ? <Suspense fallback={routeFallback}><ScoresRoutePage /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/account" element={canOpenMode("account") ? <Suspense fallback={routeFallback}><AccountRoutePage /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/account-settings" element={canOpenMode("account-settings") ? <Suspense fallback={routeFallback}><AccountSettingsPage /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/sponsor" element={canOpenMode("home") ? <Suspense fallback={routeFallback}><SponsorRoutePage /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/permissions" element={canOpenMode("account") ? <Suspense fallback={routeFallback}><PermissionsRoutePage /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/guide" element={canOpenMode("home") ? <Suspense fallback={routeFallback}><GuideRoutePage /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="/global-settings" element={canOpenMode("global-settings") ? <Suspense fallback={routeFallback}><GlobalSettingsRoutePage onBack={() => void switchMode("home")} /></Suspense> : <Navigate to={MODE_PATH[fallbackMode]} replace />} />
                <Route path="*" element={<NotFound to={MODE_PATH[fallbackMode]} />} />
              </Routes>
            </AppContent>
          </AppContentRow>

          <StatusBar>
            <StatusItem plain>{status}</StatusItem>
            <StatusSpacer />
            <BeianFooter />
          </StatusBar>
        </AppMain>
       </AppShell>
       </TooltipProvider>

      {gradingPanel && (
        <div className="fixed inset-0 z-(--px-z-lightbox) bg-background">
          <Suspense fallback={routeFallback}>
            <GradePanel examId={gradingPanel.examId} blockId={gradingPanel.blockId} teacherId={user?.id ?? 0} onBack={() => setGradingPanel(null)} />
          </Suspense>
        </div>
      )}

      {/* 移动端底部导航栏 */}
      {showTabBar && (
        <nav className="hidden max-[480px]:fixed max-[480px]:inset-x-0 max-[480px]:bottom-0 max-[480px]:z-(--px-z-header) max-[480px]:flex max-[480px]:h-mobile-nav max-[480px]:border-t max-[480px]:border-border max-[480px]:bg-card max-[480px]:pb-(--px-safe-area-bottom) max-[768px]:landscape:h-12" aria-label="主导航">
          <div className="flex h-full w-full">
            {mobileNavItems.map((m) => (
              <button
                key={m.id}
                data-active={mode === m.id || undefined}
                onClick={() => void switchMode(m.id, m.onEnter)}
                type="button"
                title={m.label}
                aria-label={m.label}
                aria-current={mode === m.id ? "page" : undefined}
                className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-transparent text-[10px] font-medium text-muted-foreground data-[active]:text-primary max-[768px]:landscape:text-[9px] [&_svg]:size-[22px] [&_svg]:shrink-0"
              >
                {m.icon}
                <span>{m.shortLabel}</span>
              </button>
            ))}
          </div>
        </nav>
      )}

      <Toaster />

      <NewCardModal open={showNewCardModal} onClose={() => setShowNewCardModal(false)} onCreate={createCard} exams={exams} />
      {paperPanelCardId && (
        <Suspense fallback={null}>
          <PaperUploadPanel
            cardId={paperPanelCardId}
            open={showPaperPanel}
            onClose={() => setShowPaperPanel(false)}
            onUploaded={() => void refreshCards()}
          />
        </Suspense>
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
        <Dialog open onOpenChange={(next) => { if (!next) setExportCheck(null); }}>
          <DialogContent size="sm" className="max-w-[560px]">
            <DialogHeader>
              <DialogTitle>导出检查</DialogTitle>
            </DialogHeader>

            {/* 进度条：当前步骤品牌红加粗，已完成步骤 success，未开始 muted */}
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-5 py-2.5 text-sm">
              <span className="inline-flex items-center gap-1 font-semibold text-success-foreground"><Check size={14} /> 分值</span>
              <span className="text-muted-foreground">→</span>
              <span
                className={cn(
                  exportCheck.step === "paper"
                    ? "font-semibold text-primary"
                    : exportCheck.paperInfo?.hasPaper
                      ? "text-success-foreground"
                      : "text-muted-foreground",
                )}
              >
                {exportCheck.step === "paper" ? (
                  <span className="inline-flex items-center gap-1">▶ 原卷</span>
                ) : exportCheck.paperInfo?.hasPaper ? (
                  <span className="inline-flex items-center gap-1"><Check size={14} /> 原卷</span>
                ) : (
                  <span className="inline-flex items-center gap-1">○ 原卷</span>
                )}
              </span>
              <span className="text-muted-foreground">→</span>
              <span
                className={cn(
                  exportCheck.step === "knowledge"
                    ? "font-semibold text-primary"
                    : exportCheck.knowledgeReady
                      ? "text-success-foreground"
                      : "text-muted-foreground",
                )}
              >
                {exportCheck.step === "knowledge" ? (
                  <span className="inline-flex items-center gap-1">▶ 知识点</span>
                ) : exportCheck.knowledgeReady ? (
                  <span className="inline-flex items-center gap-1"><Check size={14} /> 知识点</span>
                ) : (
                  <span className="inline-flex items-center gap-1">○ 知识点</span>
                )}
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="text-muted-foreground">○ 导出</span>
            </div>

            <DialogBody>
              {/* Step 1: 分值检查 */}
              {exportCheck.step === "score" && exportCheck.validation.issues.length > 0 && (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5 rounded-lg border border-warning-border bg-warning-soft p-3 text-sm text-foreground">
                    <strong className="text-base tabular-nums">当前总分：{exportCheck.validation.totalScore} 分</strong>
                    <span className="tabular-nums">客观题 {exportCheck.validation.objectiveScore} 分 / 主观题 {exportCheck.validation.subjectiveScore} 分</span>
                    <span className="tabular-nums">{exportCheck.validation.flexibleTotalSubject ? "语文、英语或外语科目不检查 100/150 总分规则" : `期望总分：${exportCheck.validation.expectedTotals.join(" 或 ")} 分`}</span>
                  </div>
                  <ul className="m-0 flex max-h-80 list-none flex-col gap-2 overflow-auto p-0">
                    {exportCheck.validation.issues.slice(0, 6).map((issue, i) => (
                      <li key={`s_${i}`} className="flex flex-col gap-1 rounded-md border border-border bg-card p-2.5 text-sm">
                        <span>{issue.message}</span>
                        {issue.questionRefs?.length ? <small className="text-xs text-muted-foreground"> 涉及：{issue.questionRefs.join("、")}</small> : null}
                      </li>
                    ))}
                  </ul>
                  {exportCheck.validation.issues.length > 6 && <p className="m-0 text-xs text-muted-foreground tabular-nums">还有 {exportCheck.validation.issues.length - 6} 条提示</p>}
                </div>
              )}

              {/* Step 2: 原卷检查 */}
              {exportCheck.step === "paper" && (
                <div>
                  {exportCheck.paperInfo?.hasPaper ? (
                    <div>
                      <p className="mb-1.5 flex items-center gap-1 text-sm"><CheckCircle2 size={15} aria-hidden="true" /> 已上传：<strong>{exportCheck.paperInfo.filename}</strong></p>
                      {/* PDF → iframe, 图片 → img, DOCX → 文字 */}
                      {exportCheck.paperInfo.mimeType?.startsWith("image/") ? (
                        <div className="cursor-pointer overflow-hidden rounded-md border border-border bg-card"
                          onClick={() => { if (exportCheck.cardId) setPaperPreviewOpen(exportCheck.cardId); }} title="点击放大">
                          <img src={mediaUrl(`/api/cards/${exportCheck.cardId}/paper?format=image`)} alt="原卷"
                            className="mx-auto block max-h-60 max-w-full object-contain"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                          <p className="px-0 pt-1 pb-2 text-center text-xs text-muted-foreground">点击放大查看</p>
                        </div>
                      ) : exportCheck.paperInfo.mimeType === "application/pdf" ? (
                        <iframe src={mediaUrl(`/api/cards/${exportCheck.cardId}/paper`)} className="h-95 w-full rounded-md border border-border" title="原卷PDF" />
                      ) : (
                        <div className="rounded-md border border-border bg-card p-4 text-center">
                          <p className="m-0 font-semibold">{exportCheck.paperInfo.filename}</p>
                          <p className="mt-1 mb-0 text-xs text-muted-foreground">DOCX 文件不支持内联预览</p>
                          <a href={urlWithToken(`/api/cards/${exportCheck.cardId}/paper`)} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-primary hover:underline">在 Office 中打开</a>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-md bg-accent p-4 text-center">
                      <p className="m-0 mb-2 flex items-center justify-center gap-1 font-semibold text-primary"><AlertTriangle size={15} aria-hidden="true" /> 尚未上传原卷</p>
                      <Button variant="primary" type="button" icon={<Upload size={15} aria-hidden="true" />} onClick={() => {
                        setExportCheck(null);
                        if (exportCheck.cardId) { setPaperPanelCardId(exportCheck.cardId); setShowPaperPanel(true); }
                      }}>立即上传原卷</Button>
                    </div>
                  )}
                </div>
              )}

              {/* Step 3: 知识点分析 */}
              {exportCheck.step === "knowledge" && (
                <div>
                  {exportCheck.knowledgeReady && exportCheck.knowledgePoints?.length ? (
                    <div>
                      <p className="mb-1.5 flex items-center gap-1 text-sm tabular-nums"><CheckCircle2 size={15} aria-hidden="true" /> 已分析 {exportCheck.knowledgePoints.length} 道题：</p>
                      <div className="max-h-55 overflow-y-auto rounded-md border border-border bg-card p-2">
                        {exportCheck.knowledgePoints.map((q) => (
                          <div key={q.question_number} className="mb-1 text-sm leading-relaxed">
                            <strong className="text-muted-foreground tabular-nums">第{q.question_number}题：</strong>
                            {q.points.map((p, i) => (
                              <span key={i} className="m-0.5 inline-block rounded-full bg-info px-2 py-px text-xs text-primary-foreground">{p}</span>
                            ))}
                          </div>
                        ))}
                      </div>
                      <Button variant="ghost" type="button" className="mt-2" onClick={() => {
                        if (exportCheck.cardId) { setPaperPanelCardId(exportCheck.cardId); setShowPaperPanel(true); }
                      }}>编辑或重新分析</Button>
                    </div>
                  ) : (
                    <KnowledgeAnalysisInline cardId={exportCheck.cardId!}
                      onDone={(points) => {
                        setExportCheck({ ...exportCheck, knowledgeReady: true, knowledgePoints: points });
                      }} />
                  )}
                </div>
              )}
            </DialogBody>

            {/* 底部按钮：左「上一步」，右侧为取消 + 主操作 */}
            <DialogFooter className="justify-between">
              <div>
                {exportCheck.step !== "score" && (
                  <Button variant="ghost" type="button" onClick={() => {
                    const prev = exportCheck.step === "paper" ? "score" : "paper";
                    setExportCheck({ ...exportCheck, step: prev as "score" | "paper" });
                  }}>← 上一步</Button>
                )}
              </div>
              <div className="flex gap-2">
              <Button variant="ghost" type="button" onClick={() => setExportCheck(null)}>取消</Button>
              {exportCheck.step === "score" && (
                <Button variant="primary" type="button" onClick={async () => {
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
                </Button>
              )}
              {exportCheck.step === "paper" && (
                <>
                  {!exportCheck.paperInfo?.hasPaper && (
                    <Button variant="ghost" type="button" onClick={() => setExportCheck({ ...exportCheck, step: "knowledge" })}>
                      跳过 → 知识点检查
                    </Button>
                  )}
                  <Button variant="primary" type="button" onClick={() => setExportCheck({ ...exportCheck, step: "knowledge" })}>
                    原卷 OK → 知识点检查
                  </Button>
                </>
              )}
              {exportCheck.step === "knowledge" && exportCheck.knowledgeReady && (
                <Button variant="primary" type="button" icon={<CheckCircle2 size={15} aria-hidden="true" />} onClick={() => doFinalPdfExport(exportCheck.pdfUrl)}>
                  确认导出 PDF
                </Button>
              )}
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {paperPreviewOpen && (
        <Dialog
          open
          onOpenChange={(next) => { if (!next) { setPaperPreviewOpen(null); setPaperZoom(1); } }}
        >
          <DialogContent size="lg" hideClose className="max-w-[900px] p-0">
            <DialogHeader className="flex-row items-center justify-between py-3 pr-4">
              <DialogTitle className="text-base">原卷预览</DialogTitle>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon-sm" type="button" onClick={() => setPaperZoom(z => Math.max(0.25, z - 0.25))} title="缩小" aria-label="缩小">−</Button>
                <Button variant="ghost" size="sm" type="button" onClick={() => setPaperZoom(1)} title="重置" className="tabular-nums">{Math.round(paperZoom * 100)}%</Button>
                <Button variant="ghost" size="icon-sm" type="button" onClick={() => setPaperZoom(z => Math.min(3, z + 0.25))} title="放大" aria-label="放大">+</Button>
                <Button variant="ghost" size="icon-sm" type="button" aria-label="关闭预览" onClick={() => { setPaperPreviewOpen(null); setPaperZoom(1); }}><X size={16} /></Button>
              </div>
            </DialogHeader>
            <DialogBody className="overflow-auto text-center">
              <img
                src={mediaUrl(`/api/cards/${paperPreviewOpen}/paper?format=image`)}
                alt="原卷"
                className="object-contain transition-[max-width,max-height] duration-(--px-dur-2) ease-standard"
                /* 动态值：缩放倍率由 paperZoom state 实时计算，无法用固定工具类表达 */
                style={{ maxWidth: `${paperZoom * 100}%`, maxHeight: `${paperZoom * 75}vh` }}
              />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
      {cardDeleteConflict && (
        <Dialog open onOpenChange={(next) => { if (!next) setCardDeleteConflict(null); }}>
          <DialogContent size="sm" role="alertdialog" className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle>确认删除答题卡</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="mt-0 text-sm tabular-nums">
                「{cardDeleteConflict.cardTitle}」已被 {cardDeleteConflict.referencedExamCount} 个考试引用。删除答题卡前需要先解除这些考试的关联。
              </p>
              {cardDeleteConflict.referencedExamNames.length > 0 && (
                <ul className="mt-2 mb-3.5 list-disc pl-5 text-sm text-muted-foreground">
                  {cardDeleteConflict.referencedExamNames.map((name) => <li key={name}>{name}</li>)}
                </ul>
              )}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={cardDeleteConflict.deleteReferencedExams}
                  onCheckedChange={(checked) => setCardDeleteConflict({ ...cardDeleteConflict, deleteReferencedExams: checked === true })}
                  disabled={isBusy}
                />
                同时删除这些考试及其成绩/扫描数据
              </label>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={() => setCardDeleteConflict(null)} disabled={isBusy}>取消</Button>
              <Button
                variant="destructive"
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
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {examDeleteTarget && (
        <Dialog open onOpenChange={(next) => { if (!next) setExamDeleteTarget(null); }}>
          <DialogContent size="sm" role="alertdialog" className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle>确认删除考试</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="mt-0 text-sm tabular-nums">
                将删除 {examDeleteTarget.exams.length} 个考试，并解除它们与答题卡的关联。
              </p>
              <ul className="mt-2 mb-3.5 list-disc pl-5 text-sm text-muted-foreground">
                {examDeleteTarget.exams.map((exam) => <li key={exam.id}>{exam.name}</li>)}
              </ul>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={examDeleteTarget.deleteLinkedCards}
                  onCheckedChange={(checked) => setExamDeleteTarget({ ...examDeleteTarget, deleteLinkedCards: checked === true })}
                  disabled={isBusy || !examDeleteTarget.exams.some((exam) => exam.card_id)}
                />
                同时删除关联答题卡
              </label>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={() => setExamDeleteTarget(null)} disabled={isBusy}>取消</Button>
              <Button
                variant="destructive"
                type="button"
                disabled={isBusy}
                onClick={async () => {
                  const target = examDeleteTarget;
                  const ok = await deleteExams(target);
                  if (ok) setExamDeleteTarget(null);
                }}
              >
                {examDeleteTarget.deleteLinkedCards ? "删除考试和答题卡" : "解绑答题卡并删除考试"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {groupDeleteTarget && (
        <Dialog open onOpenChange={(next) => { if (!next) setGroupDeleteTarget(null); }}>
          <DialogContent size="sm" role="alertdialog" className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle>确认删除大考</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="mt-0 text-sm tabular-nums">
                将删除大考「<strong>{groupDeleteTarget.groupName}</strong>」。
                该大考关联了 <strong>{groupDeleteTarget.memberCount}</strong> 场考试。
              </p>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <Checkbox
                  checked={groupDeleteTarget.deleteExams}
                  onCheckedChange={(checked) => setGroupDeleteTarget({ ...groupDeleteTarget, deleteExams: checked === true })}
                  disabled={isBusy}
                  className="mt-0.5"
                />
                <span>
                  <strong className="tabular-nums">同时删除这 {groupDeleteTarget.memberCount} 场关联考试</strong>
                  <br />
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <AlertTriangle size={15} aria-hidden="true" /> 考试的成绩、扫描数据将被永久删除，不可恢复
                  </span>
                </span>
              </label>
              {!groupDeleteTarget.deleteExams && (
                <p className="mt-2 mb-0 text-xs text-muted-foreground">
                  取消勾选则仅删除大考组，关联的考试保留不变。
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={() => setGroupDeleteTarget(null)} disabled={isBusy}>取消</Button>
              <Button
                variant="destructive"
                type="button"
                disabled={isBusy}
                className="tabular-nums"
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
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
      {blocker.state === "blocked" && (
        <Dialog open onOpenChange={(next) => { if (!next) blocker.reset?.(); }}>
          <DialogContent size="sm" role="alertdialog" hideClose>
            <DialogHeader>
              <DialogTitle>未保存的更改</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="m-0 text-sm text-muted-foreground">
                答题卡设计页有未保存的修改，离开将丢失。确定离开吗？
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={() => blocker.reset?.()}>留在此页</Button>
              <Button
                variant="primary"
                type="button"
                onClick={async () => {
                  // 与 switchMode 行为对齐：离开前先尽力落盘，避免静默丢弃
                  // dirty 的答题卡编辑；落盘失败也不拦截 —— 用户已明确选择离开。
                  try { await flushPendingCardSave("switch"); } catch { /* 忽略落盘失败，仍然离开 */ }
                  blocker.proceed?.();
                }}>离开</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </WorkspaceProvider>
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
      <EmptyState
        icon={<ClipboardCheck />}
        title="等待阅卷"
        description="选择答题卡，导入答题卡图片或图片目录后开始识别。"
      />
    );
  }

  const totalReview = result.rows.reduce((sum, row) => sum + row.needsReviewCount, 0);
  const totalIssues = result.rows.reduce((sum, row) => sum + row.issueCount, 0);

  return (
    <div className="mx-auto w-full max-w-[1100px]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-xl font-bold text-foreground">成绩表</h2>
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            {result.rows.length} 张答题卡 / 待复核 {totalReview} 题 / 异常 {totalIssues} 处
          </p>
        </div>
        <Button variant="primary" type="button" icon={<Download size={17} />} onClick={onDownloadCsv} disabled={result.rows.length === 0}>
          CSV
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-2">
        <div className="grid min-h-10 grid-cols-[minmax(170px,1.6fr)_minmax(88px,0.75fr)_78px_78px_minmax(118px,1fr)_58px_72px] items-center gap-2.5 bg-secondary px-4 text-xs font-bold text-secondary-foreground">
          <span>文件</span>
          <span>学号</span>
          <span>状态</span>
          <span>总分</span>
          <span>客观/主观</span>
          <span>复核</span>
          <span>答题卡</span>
        </div>
        {result.rows.map((row) => (
          <details className="border-t border-border transition-colors hover:bg-secondary" key={`${row.fileName}_${row.recognition.imagePath ?? row.fileName}`}>
            <summary className="grid min-h-12 grid-cols-[minmax(170px,1.6fr)_minmax(88px,0.75fr)_78px_78px_minmax(118px,1fr)_58px_72px] cursor-pointer list-none items-center gap-2.5 px-4 [&::-webkit-details-marker]:hidden">
              <span className="truncate font-medium" title={row.fileName}>{row.fileName}</span>
              <span>{row.studentId ?? "未识别"}</span>
              <Badge tone={row.recognitionStatus === "ok" && row.issueCount === 0 ? "success" : "warning"} className="rounded-full px-2.5 py-0.5 text-xs font-bold">
                {row.recognitionStatus}
              </Badge>
              <span className="tabular-nums">
                {row.totalScore}/{row.totalMaxScore}
              </span>
              <span className="tabular-nums">
                {row.objectiveScore}/{row.objectiveMaxScore} · {row.subjectiveScore}/{row.subjectiveMaxScore}
              </span>
              <span className="tabular-nums">{row.needsReviewCount}</span>
              <span>
                {row.previewUrl ? (
                  <button
                    type="button"
                    className="cursor-pointer border-0 bg-transparent p-0 text-xs text-primary underline underline-offset-2"
                    onClick={(event) => { event.stopPropagation(); openGradingPreview(row); }}
                  >
                    预览
                  </button>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </span>
            </summary>
            <div className="grid gap-2 bg-secondary px-4 pt-3.5 pb-4">
              {row.message && <p className="m-0 text-xs font-medium text-warning-foreground">{row.message}</p>}
              {row.questions.length > 0 && <p className="mt-1.5 text-xs font-bold text-secondary-foreground">客观题</p>}
              {row.questions.map((question) => (
                <div className={cn("grid min-h-[34px] grid-cols-[38px_1fr_1fr_70px_86px_minmax(96px,1fr)] items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 py-1.5 text-xs", (question.needsReview || question.status === "missing_key") && "border-warning-border bg-warning-soft")} key={question.questionNumber}>
                  <strong className="font-bold text-primary">{question.questionNumber}</strong>
                  <span>标准 {answerText(question.correctOptions)}</span>
                  <span>识别 {answerText(question.selectedOptions)}</span>
                  <span className="tabular-nums">
                    {question.score}/{question.maxScore}
                  </span>
                  <span className="tabular-nums">置信 {question.confidence.toFixed(3)}</span>
                  <em className="not-italic font-medium text-muted-foreground">{question.message ?? question.status}</em>
                </div>
              ))}
              {row.subjectiveQuestions.length > 0 && <p className="mt-1.5 text-xs font-bold text-secondary-foreground">主观题</p>}
              {row.subjectiveQuestions.map((question) => (
                <div className={cn("grid min-h-[34px] grid-cols-[38px_1fr_70px_70px_86px_minmax(120px,1fr)] items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 py-1.5 text-xs", question.needsReview && "border-warning-border bg-warning-soft")} key={question.questionId}>
                  <strong className="font-bold text-primary">{question.questionNumber}</strong>
                  <span>有效 {question.validCells.map((cell) => cell.score).join("+") || "-"}</span>
                  <span>无效 {question.invalidCells.length}</span>
                  <span className="tabular-nums">
                    {question.score}/{question.maxScore}
                  </span>
                  <span className="tabular-nums">置信 {question.confidence.toFixed(3)}</span>
                  <em className="not-italic font-medium text-muted-foreground">{question.message ?? question.status}</em>
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


export default App;
