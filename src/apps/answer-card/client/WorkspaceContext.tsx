// WorkspaceContext — 阶段 2.3 / 2.4 的共享状态中枢。
// App.tsx 持有全部状态与处理函数，构建 WorkspaceValue 并通过 Provider 下发；
// AppShell 与各个 page 组件通过 useWorkspace() 消费，无需逐层 prop 透传。
import { createContext, useContext } from "react";
import type { Dispatch, MutableRefObject, ReactElement, SetStateAction } from "react";
import type {
  AnswerCard,
  CardSummary,
  CombinedGradingBatchResult,
  CombinedGradingRow,
  ExamRecord,
  ExamOverview,
  QuestionAnalysisItem,
  StudentRankingItem,
  LayoutDocument,
  BodyBlock,
  SubjectiveBlock
} from "../../../shared/types";
import type { CardScoreValidationResult } from "../../../shared/cardScoreValidation";
import type { ProjectXAppMode, ProjectXVariantConfig } from "../../../shared/appVariant";
import type { useAuth } from "./auth/AuthContext";
import type { NewCardFormData } from "./components/NewCardModal";
import type { ImportCardFormData } from "./components/ImportCardModal";

export type AppMode = ProjectXAppMode;

export type AutoSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export type ExamGroupSummary = {
  id: number;
  name: string;
  tag: string | null;
  grade_name: string | null;
  member_count: number;
  has_results: number;
  created_at: string;
};

export type CardDeleteConflict = {
  cardId: string;
  cardTitle: string;
  referencedExamCount: number;
  referencedExamNames: string[];
  deleteReferencedExams: boolean;
};

export type ExamDeleteTarget = {
  exams: ExamRecord[];
  deleteLinkedCards: boolean;
};

export type GroupDeleteTarget = {
  groupId: number;
  groupName: string;
  memberCount: number;
  deleteExams: boolean;
};

export type PdfWarningState = {
  validation: CardScoreValidationResult;
  pdfUrl: string;
  step: "score" | "paper" | "knowledge";
  paperInfo?: { hasPaper: boolean; filename?: string; mimeType?: string };
  knowledgeReady?: boolean;
  knowledgePoints?: Array<{ question_number: number; points: string[] }>;
  cardId?: string;
};

export type WorkspaceUser = NonNullable<ReturnType<typeof useAuth>["user"]>;

export type WorkspaceValue = {
  // ── 用户 / 变体 ──
  user: WorkspaceUser | null;
  hasPermission: (perm: string) => boolean;
  appVariant: ProjectXVariantConfig;
  variantAllows: (modeName: AppMode) => boolean;

  // ── 路由 mode ──
  mode: AppMode;
  setMode: Dispatch<SetStateAction<AppMode>>;
  previousModeRef: MutableRefObject<AppMode>;
  /** 从赞助/说明/权限页返回上一模式（同步 URL） */
  navigateBackFromInfo: () => void;
  /** 切换模式并同步 URL（保留 flush 未保存答题卡逻辑） */
  switchMode: (nextMode: AppMode, afterSwitch?: () => void | Promise<void>) => void;

  // ── 答题卡设计 ──
  cards: CardSummary[];
  card: AnswerCard | null;
  setCard: Dispatch<SetStateAction<AnswerCard | null>>;
  selectedBlockId: string | null;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  layout: LayoutDocument | null;
  selectedBlock: BodyBlock | null;
  updateCard: (mutator: (draft: AnswerCard) => void) => void;
  updateBlock: (blockId: string, mutator: (block: BodyBlock) => void) => void;
  moveBlock: (blockId: string, direction: -1 | 1) => void;
  removeBlock: (blockId: string) => void;
  addObjectiveBlock: (afterIndex?: number) => void;
  addSubjectiveBlock: () => void;
  addBlankBlock: () => void;
  addEssayBlock: () => void;
  uploadImage: (blockId: string, questionId: string, file: File) => Promise<void>;
  subjectiveBlockKindLabel: (block: SubjectiveBlock) => string;
  loadCard: (id: string) => Promise<void>;
  createCard: (formData: NewCardFormData) => Promise<void>;
  saveCard: () => Promise<void>;
  exportPdfForCurrentCard: () => Promise<void>;
  deleteCard: (
    cardId: string,
    options?: { unlinkExams?: boolean; deleteReferencedExams?: boolean }
  ) => Promise<boolean>;
  refreshCards: (loadFirst?: boolean) => Promise<void>;
  flushPendingCardSave: (
    source?: "auto" | "manual" | "switch" | "pdf",
    force?: boolean
  ) => Promise<AnswerCard | null>;

  // ── 自动保存状态 ──
  autoSaveState: AutoSaveState;
  autoSaveLabel: string;
  isBusy: boolean;
  setIsBusy: Dispatch<SetStateAction<boolean>>;
  status: string;
  setStatus: Dispatch<SetStateAction<string>>;

  // ── 阅卷 ──
  gradingFiles: File[];
  setGradingFiles: Dispatch<SetStateAction<File[]>>;
  gradingExamId: string;
  setGradingExamId: Dispatch<SetStateAction<string>>;
  cardOverride: boolean;
  setCardOverride: Dispatch<SetStateAction<boolean>>;
  gradingResult: CombinedGradingBatchResult | null;
  setGradingResult: Dispatch<SetStateAction<CombinedGradingBatchResult | null>>;
  gradingProgress: { active: boolean; finished: number; total: number };
  addGradingFiles: (files: FileList | null) => void;
  gradeAnswerCardFiles: () => Promise<void>;
  downloadCsv: (rows: CombinedGradingRow[], cardId: string) => void;

  // ── 考试管理 ──
  exams: ExamRecord[];
  setExams: Dispatch<SetStateAction<ExamRecord[]>>;
  examListRefreshKey: number;
  examGroups: ExamGroupSummary[];
  setExamGroups: Dispatch<SetStateAction<ExamGroupSummary[]>>;
  examManageMode: "single" | "group";
  setExamManageMode: Dispatch<SetStateAction<"single" | "group">>;
  showCreateExam: boolean;
  setShowCreateExam: Dispatch<SetStateAction<boolean>>;
  showCreateGroup: boolean;
  setShowCreateGroup: Dispatch<SetStateAction<boolean>>;
  selectedExamIds: Set<number>;
  setSelectedExamIds: Dispatch<SetStateAction<Set<number>>>;
  selectedExamId: number | null;
  setSelectedExamId: Dispatch<SetStateAction<number | null>>;
  newExamName: string;
  setNewExamName: Dispatch<SetStateAction<string>>;
  newExamSubject: string;
  setNewExamSubject: Dispatch<SetStateAction<string>>;
  newExamCardId: string;
  setNewExamCardId: Dispatch<SetStateAction<string>>;
  loadExams: () => Promise<void>;
  loadExamGroups: () => Promise<void>;
  deleteExams: (target: ExamDeleteTarget) => Promise<boolean>;
  setExamDeleteTarget: Dispatch<SetStateAction<ExamDeleteTarget | null>>;
  setGroupDeleteTarget: Dispatch<SetStateAction<GroupDeleteTarget | null>>;
  setAssignedFormulaExamId: Dispatch<SetStateAction<number | null>>;
  /** 从考试详情启动阅卷弹层 */
  onStartReview: (examId: number, blockId: string) => void;

  // ── 成绩分析 ──
  analysisTab: "select" | "view" | "trend" | "detail";
  setAnalysisTab: Dispatch<SetStateAction<"select" | "view" | "trend" | "detail">>;
  selectedAnalysisExamId: number | null;
  setSelectedAnalysisExamId: Dispatch<SetStateAction<number | null>>;
  analysisGroupId: number | null;
  setAnalysisGroupId: Dispatch<SetStateAction<number | null>>;
  showGroupExport: boolean;
  setShowGroupExport: Dispatch<SetStateAction<boolean>>;
  loadAnalysis: (examId: number, classId?: string) => Promise<void>;

  // ── 导入 / 原卷 / 导出检查 ──
  showImportCardModal: boolean;
  setShowImportCardModal: Dispatch<SetStateAction<boolean>>;
  importCardData: { card?: { title?: string; subject?: string; subjectLabel?: string; examDate?: string } } | null;
  setImportCardData: Dispatch<
    SetStateAction<{ card?: { title?: string; subject?: string; subjectLabel?: string; examDate?: string } } | null>
  >;
  handleImportConfirm: (formData: ImportCardFormData) => Promise<void>;
  showPaperPanel: boolean;
  setShowPaperPanel: Dispatch<SetStateAction<boolean>>;
  paperPanelCardId: string | null;
  setPaperPanelCardId: Dispatch<SetStateAction<string | null>>;
  exportCheck: PdfWarningState | null;
  setExportCheck: Dispatch<SetStateAction<PdfWarningState | null>>;
  paperPreviewOpen: string | null;
  setPaperPreviewOpen: Dispatch<SetStateAction<string | null>>;
  paperZoom: number;
  setPaperZoom: Dispatch<SetStateAction<number>>;

  // ── 删除冲突 ──
  cardDeleteConflict: CardDeleteConflict | null;
  setCardDeleteConflict: Dispatch<SetStateAction<CardDeleteConflict | null>>;

  // ── 主题 / 背景 ──
  theme: "light" | "dark";
  setTheme: Dispatch<SetStateAction<"light" | "dark">>;
  showBg: number;
  setShowBg: Dispatch<SetStateAction<number>>;

  // ── 移动端 Drawer ──
  drawerOpen: boolean;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;

  // ── 权限派生 ──
  canDesign: boolean;
  canManageExams: boolean;
  canGrade: boolean;
  canAnalyze: boolean;
  canViewScores: boolean;
  canManageAccounts: boolean;
  canManageGlobal: boolean;
  canWriteExam: boolean;
  showCardSidebar: boolean;
  showScoresTab: boolean;

  // ── 移动端导航 ──
  mobileNavItems: Array<{
    id: AppMode;
    icon: ReactElement;
    label: string;
    shortLabel: string;
    onEnter?: () => void | Promise<void>;
  }>;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ value, children }: { value: WorkspaceValue; children: React.ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace 必须在 <WorkspaceProvider> 内使用");
  }
  return ctx;
}
