import type { HistogramBin, NormalityResult, QQPoint, ThresholdBand } from "./stats";

export type ObjectiveMode = "single" | "multiple" | "indefinite";
export type ObjectiveDensity = "loose" | "normal" | "compact" | "dense";
export type ObjectiveOptionLayout = "horizontal" | "vertical";
export type SubjectiveStyle = "manual_score_grid" | "plain_subjective";
export type SubjectiveKind = "blank" | "lined_answer" | "plain_box";
export type SubjectiveBlockKind = "fill_blank" | "answer" | "essay";
export type SubjectiveQuestionNumber = number | string;
export type BlankLabelStyle = "none" | "arabic_parentheses" | "roman_parentheses";
export type BlankItem = { label?: string; widthMm: number; heightMm: number; rightAnnotation?: string };

export type ObjectiveScoringRule =
  | {
      type: "per_selected_count";
      partialScores: Record<number, number>;
      wrongOrExtraScore?: number;
      allowWrongOptions?: boolean;
    }
  | {
      type: "by_correct_count";
      partialScoresByCorrectCount: Record<number, Record<number, number>>;
      wrongOrExtraScore?: number;
      allowWrongOptions?: boolean;
    }
  | {
      type: "fixed_partial";
      partialScore: number;
      wrongOrExtraScore?: number;
      allowWrongOptions?: boolean;
    };

export type ObjectiveQuestionConfig = {
  questionNumber: number;
  mode?: ObjectiveMode;
  optionCount?: number;
  score?: number;
  answerKey?: string[];
  scoringRule?: ObjectiveScoringRule;
  optionLayout?: ObjectiveOptionLayout;
};

export type PaperSettings = {
  size: "A4" | "A3";
  orientation: "portrait" | "landscape";
};

export type StudentInfoField = "姓名" | "班级" | "座位号" | "考号" | "学号";

export type StudentInfoSettings = {
  /** @deprecated 旧版字段列表，新版使用显式开关 */
  fields?: StudentInfoField[];
  studentNumberDigits: number;
  showName?: boolean;
  showClass?: boolean;
  showSeat?: boolean;
  showExamNumber?: boolean;
  showStudentNumber?: boolean;
  showNotes?: boolean;
  notesText?: string;
};

export type ObjectiveBlock = {
  id: string;
  type: "objective";
  title: string;
  questionStart: number;
  questionCount: number;
  optionCount: number;
  mode: ObjectiveMode;
  scorePerQuestion: number;
  density: ObjectiveDensity;
  optionLayout?: ObjectiveOptionLayout;
  answerKey?: Record<number, string[]>;
  multipleScoring?: {
    partialScores: Record<number, number>;
    wrongOrExtraScore: number;
  };
  questions?: ObjectiveQuestionConfig[];
};

export type SubjectiveQuestion = {
  id: string;
  number: SubjectiveQuestionNumber;
  score: number;
  style: SubjectiveStyle;
  kind: SubjectiveKind;
  blanks?: { count: number; widthMm: number; heightMm: number; labelStyle?: BlankLabelStyle; items?: BlankItem[] };
  lineGrid?: LineGridConfig;
  essayGrid?: EssayGridConfig;
  scoreGrid?: ScoreGridConfig;
  images?: Array<{
    assetId: string;
    originalName?: string;
    widthMm: number;
    heightMm: number;
    align: "left" | "center" | "right";
  }>;
  minHeightMm: number;
};

export type ScoreGridConfig = {
  enabled: boolean;             // 是否显示得分格，默认 true
  strokeColor?: string;         // 格线色，默认 "#999"
  strokeWidthMm?: number;       // 格线宽 mm，默认 0.15
  fillColor?: string;           // 填充色，默认 "#fff"
  fontSize?: number;            // 数字大小 (SVG mm)，默认 2.8
  dividerColor?: string;        // 分隔线色，默认 "#ccc"
  dividerWidthMm?: number;      // 分隔线宽 mm，默认 0.1
  showLabel?: boolean;          // 是否显示"得分"标签，默认 true
};

export type LineGridConfig = {
  enabled: boolean;
  lineSpacingMm: number;     // 线间距 mm
  fixedLineCount?: number;   // 固定行数（设置后自动算高度）
  lineColor?: string;        // 线色，默认 "#222"
  lineWidthMm?: number;      // 线宽 mm，默认 0.15
  insetLeftMm?: number;      // 左边距 mm，默认 8
  insetRightMm?: number;     // 右边距 mm，默认 6
  lineStyle?: "solid" | "dashed" | "dotted"; // 线型，默认 "solid"
};

export type EssayGridConfig = {
  columns: number;          // 每栏格数（0=自动）
  rows: number;             // 目标行数（0=按高度自动）
  cellWidthMm: number;      // 格子宽度，默认 7
  cellHeightMm: number;     // 格子高度，默认 7
  targetChars: number;      // 目标字数，默认 600
  showTitle: boolean;       // 显示标题
  lineColor: string;        // 线色，默认 "#222"
  lineWidthMm: number;      // 线宽，默认 0.15
  showFrame?: boolean;      // 显示作文区粗边框（默认 true）
  showWordScale?: boolean;  // 显示字数刻度（每 100 字标注，默认 true）
};

export type SubjectiveBlock = {
  id: string;
  type: "subjective";
  blockKind?: SubjectiveBlockKind;
  title: string;
  questions: SubjectiveQuestion[];
};

export type BodyBlock = ObjectiveBlock | SubjectiveBlock;

export type AnswerCard = {
  id: string;
  title: string;
  subject?: string;
  subjectLabel?: string;
  examDate?: string;
  paper: PaperSettings;
  studentInfo: StudentInfoSettings;
  bodyBlocks: BodyBlock[];
  sided: "single" | "double";
  layoutVersion: 1 | 2;
  updatedAt: string;
};

export type CardSummary = {
  id: string;
  title: string;
  subject?: string;
  subjectLabel?: string;
  examDate?: string;
  updatedAt: string;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LayoutElement =
  | { id: string; type: "marker"; role: string; rect: Rect }
  | { id: string; type: "student_digit"; digitIndex: number; digit: number; rect: Rect }
  | { id: string; type: "objective_row_marker"; blockId: string; row: number; side: "left" | "right"; rect: Rect }
  | { id: string; type: "objective_option"; blockId: string; questionNumber: number; option: string; rect: Rect }
  | { id: string; type: "subjective_box"; blockId: string; questionId: string; questionNumber: SubjectiveQuestionNumber; rect: Rect }
  | { id: string; type: "score_cell"; blockId: string; questionId: string; questionNumber: SubjectiveQuestionNumber; score: number; rect: Rect }
  | { id: string; type: "image_area"; blockId: string; questionId: string; assetId: string; rect: Rect };

export type ObjectiveRenderItem = {
  questionNumber: number;
  options: Array<{ label: string; rect: Rect }>;
  labelX: number;
  labelY: number;
};

export type SubjectiveRenderItem = {
  blockId: string;
  questionId: string;
  questionNumber: SubjectiveQuestionNumber;
  score: number;
  style: SubjectiveStyle;
  kind: SubjectiveKind;
  rect: Rect;
  contentRect: Rect;
  scoreCells: Array<{ score: number | null; rect: Rect }>;
  lineYs: number[];
  lineGrid?: LineGridConfig;
  scoreGrid?: ScoreGridConfig;
  blanks: Rect[];
  blankLabels?: string[];
  blankRightAnnotations?: string[];
  blankLabelStyle?: BlankLabelStyle;
  blankLabelSlotWidth?: number;
  images: Array<{ assetId: string; originalName?: string; rect: Rect }>;
};

export type PageRenderBlock =
  | {
      type: "objective";
      blockId: string;
      title: string;
      rect: Rect;
      frameRect: Rect;
      rowMarkers: Array<{ row: number; left: Rect; right: Rect }>;
      items: ObjectiveRenderItem[];
      density: ObjectiveDensity;
    }
  | {
      type: "subjective";
      blockId: string;
      title: string;
      rect: Rect;
      frameRect?: Rect;
      questions: SubjectiveRenderItem[];
      panelIndex?: number;
      essayStartCell?: number;
    };

export type StudentAreaFieldRow = {
  label: string;
  labelX: number;
  /** 标签文本基线 y（mm，PDF 渲染语义；SVG 预览按 lineY 自行偏移） */
  labelY: number;
  lineX1: number;
  lineX2: number;
  lineY: number;
};

export type StudentAreaLayout = {
  infoRect: Rect;
  digitRect: Rect;
  digitCells: Array<{ digitIndex: number; digit: number; rect: Rect }>;
  /** 信息区手写字段行（姓名/班级/座位号/考号，按 studentInfo 开关过滤），渲染层据此画标签与下划线 */
  fieldRows: StudentAreaFieldRow[];
  /** 注意事项文本行（showNotes 开启时），渲染层逐行绘制 */
  notesLines?: string[];
  /** 注意事项首行文本基线 y（mm） */
  notesY?: number;
};

export type PageLayout = {
  pageNumber: number;
  width: number;
  height: number;
  markers: Array<{ role: string; rect: Rect }>;
  header: {
    id: string;
    title?: string;
    idTextX: number;
    idTextY: number;
    codeBoxes: Rect[];
    titleX?: number;
    titleY?: number;
  };
  studentArea?: StudentAreaLayout;
  panels: Array<{
    index: number;
    role: "single" | "left" | "middle" | "right";
    rect: Rect;
  }>;
  blocks: PageRenderBlock[];
  elements: LayoutElement[];
};

export type LayoutDocument = {
  cardId: string;
  width: number;
  height: number;
  pages: PageLayout[];
  elements: LayoutElement[];
  warnings: string[];
};

export type ObjectiveRecognitionQuestion = {
  questionNumber: number;
  selectedOptions: string[];
  confidence: number;
  optionScores?: Record<string, number>;
};

export type ObjectiveRecognitionResult = {
  status: "ok" | "partial" | "failed" | string;
  cardId?: string;
  imagePath?: string;
  layoutPath?: string;
  pageNumber?: number;
  message?: string;
  studentId?: {
    status: "ok" | "failed" | string;
    value: string | null;
    source?: "recognized" | "inherited" | "not_present";
    digits?: unknown[];
    failures?: unknown[];
  };
  quality?: Record<string, unknown>;
  questions: ObjectiveRecognitionQuestion[];
};

export type ObjectiveQuestionGradeStatus = "correct" | "wrong" | "partial" | "missing_key" | "review";

export type ObjectiveQuestionGrade = {
  questionNumber: number;
  selectedOptions: string[];
  correctOptions: string[];
  score: number;
  maxScore: number;
  confidence: number;
  status: ObjectiveQuestionGradeStatus;
  needsReview: boolean;
  message?: string;
};

export type ObjectiveGradingRow = {
  fileName: string;
  previewUrl?: string;
  studentId: string | null;
  recognitionStatus: string;
  score: number;
  maxScore: number;
  needsReviewCount: number;
  issueCount: number;
  message?: string;
  questions: ObjectiveQuestionGrade[];
  recognition: ObjectiveRecognitionResult;
};

export type ObjectiveGradingBatchResult = {
  batchId: string;
  cardId: string;
  rows: ObjectiveGradingRow[];
};

export type SubjectiveScoreCellRecognition = {
  blockId?: string;
  questionId?: string;
  questionNumber?: SubjectiveQuestionNumber;
  score: number;
  rect?: Rect;
  metrics?: Record<string, unknown>;
  reason?: string;
};

export type SubjectiveRecognitionQuestion = {
  blockId?: string;
  questionId: string;
  questionNumber: SubjectiveQuestionNumber;
  score: number;
  maxScore: number;
  status: "ok" | "invalid" | "review" | string;
  validCells: SubjectiveScoreCellRecognition[];
  invalidCells: SubjectiveScoreCellRecognition[];
  confidence: number;
  message?: string;
};

export type CombinedRecognitionResult = ObjectiveRecognitionResult & {
  subjectiveQuestions: SubjectiveRecognitionQuestion[];
  blockCrops?: RecognitionBlockCrop[];
};

export type RecognitionBlockCrop = {
  blockId: string;
  blockTitle: string;
  blockType: "objective" | "subjective" | string;
  pageNumber: number;
  segmentIndex: number;
  questionNumbers: Array<number | string>;
  rect: Rect;
  path: string;
  widthPx: number;
  heightPx: number;
  dpi: number;
};

export type AnswerBlockCropSourceType = "scan_record" | "twain_scan_record";

export type AnswerBlockCrop = {
  id: string;
  cardId: string;
  examId?: number | null;
  studentId?: number | null;
  studentNumber?: string | null;
  sourceType: AnswerBlockCropSourceType;
  sourceRecordId: string;
  blockId: string;
  blockTitle: string;
  blockType: "objective" | "subjective" | string;
  pageNumber: number;
  segmentIndex: number;
  questionNumbers: Array<number | string>;
  rect: Rect;
  imageUrl: string;
  widthPx: number;
  heightPx: number;
  dpi: number;
  status?: string;
  score?: number | null;
  maxScore?: number | null;
  /** 本题块是否允许 0.5 小数（来自 block_grading_config，用于打分面板） */
  hasHalfPoint?: number;
};

/** 网上阅卷题块汇总 */
export type ReviewBlockSummary = {
  blockId: string;
  blockTitle: string;
  blockType: string;
  totalCount: number;
  pendingCount: number;
  reviewedCount: number;
  /** 本题块是否含 0.5 小数（v1.9.4） */
  hasHalfPoint: number;
  /** 本题块满分（逐题 max_score 求和，v1.9.4 打分面板用） */
  maxScore: number;
};

/** 网上阅卷队列项（含学生姓名） */
export type ReviewBlockCropItem = AnswerBlockCrop & {
  studentName?: string | null;
};

export type ReviewBlockCropsResponse = {
  examId: number;
  rows: ReviewBlockCropItem[];
};

export type ReviewSubmitScoreInput = {
  questionNumber: number;
  scoreType: "objective" | "subjective" | string;
  score: number;
  maxScore?: number;
};

export type ReviewSubmitResult = {
  ok: true;
  cropId: string;
  status: string;
  totalScore: number;
  disputed?: boolean;
  disputeReason?: string;
  reviewRound?: number;
  finalScore?: number | null;
};

export type SubjectiveQuestionGradeStatus = "ok" | "invalid" | "missing_score_grid";

export type SubjectiveQuestionGrade = {
  questionId: string;
  questionNumber: SubjectiveQuestionNumber;
  score: number;
  maxScore: number;
  status: SubjectiveQuestionGradeStatus;
  needsReview: boolean;
  confidence: number;
  validCells: SubjectiveScoreCellRecognition[];
  invalidCells: SubjectiveScoreCellRecognition[];
  message?: string;
};

export type CombinedGradingRow = ObjectiveGradingRow & {
  objectiveScore: number;
  objectiveMaxScore: number;
  subjectiveScore: number;
  subjectiveMaxScore: number;
  totalScore: number;
  totalMaxScore: number;
  subjectiveQuestions: SubjectiveQuestionGrade[];
  recognition: CombinedRecognitionResult;
};

export type CombinedGradingBatchResult = {
  batchId: string;
  cardId: string;
  rows: CombinedGradingRow[];
  persistence?: GradingPersistenceResult;
};

export type GradingPersistenceFailure = {
  fileName: string;
  studentId?: string;
  code: "RECOGNITION_FAILED" | "STUDENT_ID_MISSING" | "STUDENT_NOT_FOUND" | "PERSISTENCE_FAILED";
  message: string;
};

export type GradingPersistenceResult = {
  batchId: number;
  status: "done" | "partial" | "error";
  persisted: number;
  failedCount: number;
  failed: GradingPersistenceFailure[];
};

// ── Analysis Types ────────────────────────────────────

export type ScoreSummary = {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  avg: number;
  count: number;
};

export type ScoreTrendPoint = {
  examId: number;
  examName: string;
  subject: string;
  examTime: string;
  gradeAvg: number;
  gradeCount: number;
  classAvg?: number | null;
  classCount?: number;
};

/** 学生个人趋势数据点（含班级/年级均分对比） */
export type StudentTrendPoint = {
  examId: number;
  examName: string;
  subject: string;
  examTime: string;
  totalScore: number;
  classAvg: number;
  gradeAvg: number;
  classSize: number;
  rank: number;
  percentile: number;
};

/** 学科薄弱分析结果 */
export type SubjectWeaknessItem = {
  subject: string;
  examCount: number;
  avgScore: number;
  avgClassAvg: number;
  gapToClass: number;
  bestScore: number;
  worstScore: number;
  trend: "up" | "down" | "stable";
};

/** 学生个人 AI 分析请求 */
export type StudentAiAnalysisRequest = {
  examId?: number;     // 不传则表示整体分析
  model: string;
  providerId?: number;
};

export type ClassScoreSummary = {
  classId: number;
  className: string;
  gradeName?: string;
  summary: ScoreSummary;
};

export type ExamOverview = {
  /** 已阅人数（当前版本等同 gradedCount，因无独立“注册学生”表；后续迭代可对接学籍名册） */
  totalStudents: number;
  gradedCount: number;
  avgScore: number;
  maxScore: number;
  minScore: number;
  stdDev: number;
  passRate: number;
  excellentRate: number;
  /** 及格线（绝对分），由全局阈值配置 × 满分计算 */
  passScore: number;
  /** 优秀线（绝对分），由全局阈值配置 × 满分计算 */
  excellentScore: number;
  distribution: Array<{ range: string; min: number; max: number; count: number }>;
  scoreSummary: ScoreSummary | null;
  overallScoreSummary: ScoreSummary | null;
  classSummaries: ClassScoreSummary[];
  highErrorQuestionCount: number;
  errorRateBuckets: { low: number; medium: number; high: number };
};

export type ErrorRateLevel = "none" | "low" | "medium" | "high";

export type StudentRankingItem = {
  rank: number;
  studentNumber: string;
  studentName: string;
  totalScore: number;
  objectiveScore: number;
  subjectiveScore: number;
  lowScoreCount: number;
  questionCount: number;
  errorRate: number;
  errorRateLevel: ErrorRateLevel;
};

export type QuestionAnalysisItem = {
  questionNumber: string;
  questionType: string;
  scoreRate: number;
  correctRate: number | null;
  avgScore: number;
  maxScore: number;
  errorCount: number;
  errorRate: number;
  errorRateLevel: ErrorRateLevel;
  totalCount: number;
  /** 难度系数 P（0-1）= 平均得分 / 满分 */
  difficulty: number;
  /** 区分度 D（极端组法，-1~1）= 高分组得分率 - 低分组得分率 */
  discrimination: number;
  /** 关联知识点文本（若已标注） */
  knowledgePoint?: string | null;
};

// ── 逐题选项分析（v29）──────────────────────────────
export type OptionStat = {
  /** 选项标签，如 "A" */
  option: string;
  /** 选择该选项的人次（多选题按人次计） */
  count: number;
  /** 选择率（百分比 0-100，基数为作答人数） */
  rate: number;
  /** 是否属于标准答案 */
  isCorrect: boolean;
};

export type OptionAnalysisQuestion = {
  questionNumber: number;
  /** single / multiple / indeterminate */
  mode: string;
  optionCount: number;
  maxScore: number;
  answerKey: string[];
  /** 满分率（百分比）；无法判定时为 null */
  correctRate: number | null;
  answeredCount: number;
  unansweredCount: number;
  options: OptionStat[];
};

export type OptionAnalysisResponse = {
  /** false = 该考试阅卷时未记录选项数据（历史考试） */
  hasOptionData: boolean;
  questions: OptionAnalysisQuestion[];
};

// ── 跨班对比（v29）─────────────────────────────────
export type ClassComparisonClassSummary = {
  classId: number;
  className: string;
  gradeName?: string;
  count: number;
  avgScore: number;
  maxScore: number;
  minScore: number;
  median: number;
  stdDev: number;
  passRate: number;
  excellentRate: number;
  distribution: Array<{ range: string; min: number; max: number; count: number }>;
};

export type ClassComparisonQuestionStat = {
  questionNumber: number;
  /** objective / subjective */
  scoreType: string;
  maxScore: number;
  byClass: Array<{ classId: number; scoreRate: number; correctRate: number | null }>;
};

export type ClassComparisonOptionStat = {
  questionNumber: number;
  answerKey: string[];
  byClass: Array<{ classId: number; options: OptionStat[] }>;
};

export type ClassComparisonResponse = {
  classes: ClassComparisonClassSummary[];
  questionStats: ClassComparisonQuestionStat[];
  /** 仅当 includeOptions=1 且有选项数据时返回 */
  optionStats?: ClassComparisonOptionStat[];
};

// ── 知识点弱点 + 阈值配置（v29）────────────────────
export type KnowledgeSeverity = "common_weak" | "weak" | "ok";

export type KnowledgeWeaknessItem = {
  point_text: string;
  question_numbers: string;
  avg_rate: number;
  student_count: number;
  total_questions: number;
  severity: KnowledgeSeverity;
  coverage_rate: number;
};

export type AnalysisThresholds = {
  passRate: number;
  excellentRate: number;
  segmentSize: number;
  errorTiers: [number, number, number];
};

export type ExamRecord = {
  id: number;
  name: string;
  card_id: string | null;
  grade_id: number | null;
  class_id: number | null;
  subject: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
  assigned_formula: string | null;
  created_at: string;
};

export type AiModelOption = {
  id: string;
  provider: string;
  label: string;
  available: boolean;
  thinking?: boolean;
};

export type AiProviderConfig = {
  id: number;
  name: string;
  providerType: string;       // openai / deepseek / haqimi / gemini
  baseUrl: string;
  apiKey: string;
  models: string[] | null;    // null=自动获取
  isActive: boolean;
};

export type AiAnalysisStatus = {
  available: boolean;
  reason?: string;
  defaultModel: string | null;
  models: AiModelOption[];
  providers: AiProviderConfig[];  // v1.4.0 多服务商
};

export type AiAnalysisQuestionAction = {
  questionNumber: string;
  reason: string;
  action: string;
};

export type AiAnalysisReport = {
  overallJudgement: string;
  distributionInsight: string;
  weakPoints: string[];
  reviewRisks: string[];
  teachingSuggestions: string[];
  nextActions: string[];
  questionActions: AiAnalysisQuestionAction[];
  caveats: string[];
};

export type AiAnalysisToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  summary: string;
};

export type AiAnalysisResponse = {
  generatedAt: string;
  model: string;
  report: AiAnalysisReport;
  toolCalls: AiAnalysisToolCall[];
};

// ============================================================
// v1.4.0 新增类型：成绩查看改造
// ============================================================

/** 赋分公式类型 */
export type AssignedFormulaType = "proportional" | "linear" | "custom";

/** 赋分公式参数 */
export interface AssignedFormulaParams {
  minIn?: number;
  maxIn?: number;
  minOut?: number;
  maxOut?: number;
  a?: number;          // linear: 系数
  b?: number;          // linear: 常数
  expression?: string; // custom: 表达式
}

/** 赋分公式配置 */
export interface AssignedFormula {
  type: AssignedFormulaType;
  params: AssignedFormulaParams;
  enabled: boolean;
}

/** 成绩显示模式 */
export type ScoreDisplayMode = "deviation" | "zscore" | "percentile";

/** 成绩表格行 */
export interface ScoreTableRow {
  rank: number;
  studentId: number;
  studentNumber: string;
  studentName: string;
  className: string;
  classId: number | null;
  gradeName?: string | null;
  totalScore: number;
  assignedScore: number | null;
  gradeRank: number;
  classRank: number;
  rankChange: number | null;       // null=无上次考试
  prevRank: number | null;
  prevExamName: string | null;
  displayValue: number | null;     // 偏差值/Z值/百分位
  objectiveScore: number;
  subjectiveScore: number;
  needsReview: boolean;            // 需要复核
}

/** 成绩表响应 */
export interface ScoreTableResponse {
  examId: number;
  examName: string;
  subject: string;
  examDate: string | null;
  classId: number | undefined;
  displayMode: ScoreDisplayMode;
  hasAssignedScore: boolean;
  rows: ScoreTableRow[];
  totalCount: number;
}

/** 上次考试对比 */
export interface PreviousExamComparison {
  prevExamId: number | null;
  prevExamName: string | null;
  prevAvgScore: number | null;
  prevPassRate: number | null;
  avgScoreChange: number | null;
  passRateChange: number | null;
}

/** 学期内学科汇总 */
export interface SemesterSubjectSummary {
  subject: string;
  examCount: number;
  avgScore: number;
  bestScore: number;
  avgClassGap: number;
}

/** 单个学期成绩汇总 */
export interface SemesterSummary {
  label: string;
  startDate: string;
  endDate: string;
  examCount: number;
  avgScore: number;
  subjects: SemesterSubjectSummary[];
}

/** 学生本学期 vs 上学期对比 */
export interface StudentSemesterComparison {
  current: SemesterSummary | null;
  previous: SemesterSummary | null;
  avgScoreChange: number | null;
  improvedSubjects: string[];
  declinedSubjects: string[];
}

/** 考试筛选列表项（考试选择页用） */
export interface ExamFilterItem {
  id: number;
  name: string;
  subject: string | null;
  grade_id: number | null;
  grade_name: string | null;
  exam_date: string | null;
  status: string;
  graded_count: number;
  avg_score: number;
  has_assigned_score: number;
}

export type CrossExamTotalMode = "week" | "selected" | "group";
export type CrossExamAttendanceMode = "all" | "full";

export interface CrossExamGroup {
  id: number;
  name: string;
  source: "cross-manual" | "week";
  startDate: string | null;
  endDate: string | null;
  examIds: number[];
  exams: ExamFilterItem[];
  createdAt: string;
  updatedAt: string;
}

export interface CrossExamTotalRequest {
  mode: CrossExamTotalMode;
  examIds?: number[];
  groupId?: number;
  startDate?: string;
  endDate?: string;
  gradeId?: number;
  classId?: number;
  subject?: string;
  attendanceMode?: CrossExamAttendanceMode;
}

export interface CrossExamTotalExam {
  id: number;
  name: string;
  subject: string | null;
  gradeName: string | null;
  examDate: string | null;
  fullScore: number;
  gradedCount: number;
  avgScore: number | null;
}

export interface CrossExamScoreCell {
  examId: number;
  score: number | null;
  absent: boolean;
}

export interface CrossExamTotalRow {
  studentId: number;
  studentNumber: string;
  studentName: string;
  className: string;
  classId: number | null;
  gradeName: string | null;
  totalScore: number;
  totalFullScore: number;
  scoreRate: number | null;
  attendedCount: number;
  absentCount: number;
  gradeRank: number;
  classRank: number;
  scores: CrossExamScoreCell[];
}

export interface CrossExamClassSummary {
  classId: number | null;
  className: string;
  gradeName: string | null;
  count: number;
  avgScore: number;
  maxScore: number;
  minScore: number;
}

export interface CrossExamTotalResponse {
  mode: CrossExamTotalMode;
  group: CrossExamGroup | null;
  exams: CrossExamTotalExam[];
  rows: CrossExamTotalRow[];
  classSummaries: CrossExamClassSummary[];
  summary: {
    examCount: number;
    studentCount: number;
    totalFullScore: number;
    avgTotalScore: number;
    maxTotalScore: number;
    minTotalScore: number;
    fullAttendanceCount: number;
  };
}

/** 导出列定义 */
export interface ExportColumnMeta {
  id: string;
  label: string;
  category: "basic" | "ranking" | "score" | "questions" | "other";
}

/** 导出模板（存入数据库） */
export interface ExportTemplate {
  id: number;
  slot: number;
  name: string;
  columns: string[];
  sideTableN: number;
  gapCols: number;
}

/** 导出配置请求（传给后端） */
export interface ExportConfigRequest {
  examId: number;
  classId?: number;
  columns: string[];
  sideTableN: number;
  gapCols: number;
}

// ============================================================
// v1.4.8 新增类型：大考组
// ============================================================

/** 大考组 */
export interface ExamGroup {
  id: number;
  name: string;
  description: string | null;
  grade_id: number | null;
  grade_name?: string | null;
  tag: string | null;
  status: "active" | "archived";
  is_official: number;
  total_score_mode: "raw" | "assigned";
  only_full_participants: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

/** 大考组成员（含汇总信息） */
export interface ExamGroupMember {
  id: number;
  examId: number;
  examName: string;
  subject: string | null;
  sortOrder: number;
  examDate: string | null;
  status: string;
  gradedCount: number;
  avgScore: number;
  hasAssignedScore: number;
}

/** 大考组详情 */
export interface ExamGroupDetail extends ExamGroup {
  members: ExamGroupMember[];
}

/** 大考创建/更新请求 */
export interface ExamGroupRequest {
  name: string;
  description?: string;
  grade_id?: number | null;
  tag?: string;
  is_official?: number;
  total_score_mode?: "raw" | "assigned";
  only_full_participants?: number;
  examIds?: number[];
}

/** 大考概览 - 各科参数 */
export interface GroupSubjectSummary {
  examId: number;
  examName: string;
  subject: string;
  gradedCount: number;
  avgScore: number;
  maxScore: number;
  minScore: number;
  stdDev: number;
  passRate: number;
  excellentRate: number;
  fullScore: number;
  hasAssignedScore: boolean;
  /** 难度系数 P（0-1） */
  difficulty?: number;
  /** 区分度 D（极端组法） */
  discrimination?: number;
}

/** 大考概览 */
export interface GroupOverview {
  groupId: number;
  groupName: string;
  totalParticipants: number;
  fullParticipants: number;
  subjects: GroupSubjectSummary[];
  /** 大考整体难度系数 P */
  difficulty?: number;
  /** 大考整体区分度 D */
  discrimination?: number;
}

/** 大考排名行 - 每科成绩 */
export interface GroupSubjectScore {
  examId: number;
  subject: string;
  totalScore: number;
  assignedScore: number | null;
  gradeRank: number;
  classRank: number;
  objectiveScore: number;
  subjectiveScore: number;
}

/** 大考排名行 */
export interface GroupRankingRow {
  studentId: number;
  studentNumber: string;
  studentName: string;
  className: string;
  classId: number | null;
  gradeName: string | null;
  totalRawScore: number;       // 原始分总分
  totalAssignedScore: number;  // 赋分总分
  totalGradeRank: number;
  totalClassRank: number;
  subjectCount: number;        // 参加了多少科
  isFullParticipant: boolean;  // 是否全科参加
  subjects: GroupSubjectScore[];
}

/** 大考排名响应 */
export interface GroupRankingResponse {
  groupId: number;
  groupName: string;
  totalStudents: number;
  displayColumns: string[];    // 科目顺序
  rows: GroupRankingRow[];
}

/** 大考筛选列表项 */
export interface ExamGroupFilterItem {
  id: number;
  name: string;
  description: string | null;
  tag: string | null;
  grade_id: number | null;
  grade_name: string | null;
  status: string;
  member_count: number;
  has_results: number;
  created_at: string;
}

/** 单科导出增强字段 */
export interface ExamSubScoreExport {
  objectiveSubScores: Array<{ questionNumber: number; score: number; maxScore: number }>;
  subjectiveSubScores: Array<{ questionNumber: number; score: number; maxScore: number }>;
}

/** 用户设置 */
export interface UserSettings {
  scoreDisplayMode: ScoreDisplayMode;
  reviewConfidenceThreshold: number;
}

// ── 成绩天梯系统 ──

/** 排名趋势方向 */
export type RankTrend = "up" | "down" | "same" | "new";

/** 天梯单行（前十名榜单条目） */
export interface LadderRow {
  rank: number;
  studentId: number;
  studentNumber: string;
  studentName: string;
  className: string;
  classId: number | null;
  gradeName: string | null;
  totalScore: number;
  assignedScore?: number | null;
  classRank: number;
  rankTrend: RankTrend;
  rankChange: number | null;        // 正=进步，负=退步，null=无对比
  prevRank: number | null;
  percentile: number;
  /** 大考组/跨考场景的科目明细 */
  subjectScores?: Array<{
    examId?: number;
    examName: string;
    subject: string;
    score: number;
    rank: number;
  }>;
}

/** 天梯 API 响应 */
export interface LadderResponse {
  scope: "single" | "group" | "cross";
  scopeName: string;
  studentCount: number;
  myRank: number | null;            // 当前学生在全量中的排名
  myScore: number | null;           // 当前学生的总分
  rows: LadderRow[];                // 前十名
}

// ============================================================
// v1.9.0 新增类型：网上阅卷系统重构
// ============================================================

/** 阅卷模式 */
export type ReviewMode = 1 | 2 | 3;

/** 分数取整方式 */
export type RoundingMode = "none" | "ceil" | "floor" | "round" | "half";

/** 题块级阅卷设置 */
export interface BlockGradingConfig {
  id: number;
  examId: number;
  blockId: string;
  disputeThreshold: number;
  rounding: RoundingMode;
  arbitratorId: number | null;
  reviewMode: ReviewMode;
  /** 本题块是否允许 0.5 小数打分（按 block 粒度） */
  hasHalfPoint: number;
  /** 未设仲裁人时是否自动按工作量均衡再分配（1=开，0=关） */
  autoReassignNoArb: number;
  /** 工作量均衡阈值：已分配本题块教师「最多-最少份数差」上限 */
  workloadBalanceThreshold: number;
  /** 题块评分模式：block_total=题块合计分（#187 默认），per_question=逐题输入（#186） */
  scoringMode: string;
  /** 题块总分拆分策略：proportional=按小题满分比例，equal=均分 */
  scoreDistribution: string;
  createdAt: string;
  updatedAt: string;
}

/** 阅卷任务分配 */
export interface ReviewAssignment {
  id: number;
  examId: number;
  blockId: string;
  teacherId: number;
  teacherName?: string;
  studentCount: number;
  assignedStudentIds: number[];
  /** 1=自动再分配追加的份数（工作量均衡），0=初始分配 */
  autoAssigned: number;
  createdAt: string;
}

/** 阅卷会话（断点续批） */
export interface ReviewSession {
  id: number;
  teacherId: number;
  examId: number;
  blockId: string;
  currentIndex: number;
  positionJson: Record<string, unknown> | null;
  draftScores: Record<number, number> | null;
  updatedAt: string;
}

/** 阅卷批注 */
export interface ReviewAnnotation {
  id: string;
  cropId: string;
  reviewerId: number;
  reviewerName?: string;
  type: "text" | "drawing";
  dataJson: Record<string, unknown>;
  createdAt: string;
}

/** 阅卷溯源 - 单轮评分 */
export interface ReviewRoundDetail {
  round: number;
  reviewerId: number;
  reviewerName: string;
  score: number;
  reviewedAt: string;
}

/** 阅卷溯源 - 学生一条记录 */
export interface ReviewTraceItem {
  cropId: string;
  studentId: number;
  studentName: string;
  studentNumber: string;
  blockTitle: string;
  rounds: ReviewRoundDetail[];
  finalScore: number | null;
  resolvedBy: string | null;
  status: string;
}

// ============================================================
// 难度系数 / 区分度 / 总体分析（成绩分析增强）
// ============================================================

/** 难度与区分度档位（复用 stats.ThresholdBand 形状） */
export type DifficultyBand = ThresholdBand;
export type DiscriminationBand = ThresholdBand;

/** 大考概览各科补充 P/D */
export interface GroupSubjectMetric extends GroupSubjectSummary {
  difficulty?: number;
  discrimination?: number;
}

/** 普通考试整体难度/区分度指标 */
export interface ExamMetrics {
  difficulty: number;
  discrimination: number;
  fullScore: number;
  avgScore: number;
  gradedCount: number;
}

/** 大考整体 + 逐科难度/区分度指标 */
export interface GroupMetrics {
  difficulty: number;
  discrimination: number;
  totalFullScore: number;
  totalAvg: number;
  memberCount: number;
  subjects: GroupSubjectMetric[];
}

/** 总体分析分布结果（单科/总分/各班） */
export interface DistributionResult {
  /** 维度：subject=单科分布，total=大考总分分布，class=某班分布 */
  scope: "subject" | "total" | "class";
  /** 维度标识（如 classId 或 "total"） */
  scopeId: string;
  label: string;
  fullScore: number;
  segmentSize: number;
  bins: HistogramBin[];
  mean: number;
  stdDev: number;
  normality: NormalityResult;
  difficulty: number;
  discrimination: number;
  sampleSize: number;
  /** 赋分是否可用（只读已落库 assigned_score） */
  assignedAvailable: boolean;
  /** 赋分分布（若可用） */
  assignedBins?: HistogramBin[];
  /** Q-Q 图数据点（样本值 vs 理论正态分位），用于正态性可视化 */
  qq?: QQPoint[];
}

/** 逐题下钻 - 单个学生得分 */
export interface QuestionStudentScore {
  studentId: number;
  studentNumber: string;
  name: string;
  className: string | null;
  score: number;
  maxScore: number;
  scoreRate: number;
  /** 是否满分 */
  isFull: boolean;
  /** 关联知识点文本（若已标注） */
  knowledgePoint?: string | null;
}

/** 大考逐题分析响应（含整体与逐科） */
export interface GroupQuestionAnalysisResponse {
  overall: { difficulty: number; discrimination: number };
  subjects: Array<{
    examId: number;
    subject: string;
    examName: string;
    fullScore: number;
    avgScore: number;
    difficulty: number;
    discrimination: number;
    questions: QuestionAnalysisItem[];
  }>;
}

/** 大考班级对比响应 */
export interface GroupClassComparisonResponse {
  classes: Array<{
    classId: number;
    className: string;
    gradeName?: string;
    count: number;
    avgScore: number;
    maxScore: number;
    minScore: number;
    median: number;
    stdDev: number;
    passRate: number;
    excellentRate: number;
    distribution: HistogramBin[];
  }>;
  /** 逐科 × 班级的均分/得分率对比 */
  subjectClassSummaries: Array<{
    examId: number;
    subject: string;
    byClass: Array<{ classId: number; avgScore: number; scoreRate: number }>;
  }>;
}


/** 争议卷条目 */
export interface DisputeItem {
  cropId: string;
  studentId: number;
  studentName: string;
  studentNumber: string;
  blockId: string;
  blockTitle: string;
  scores: Array<{ reviewerName: string; score: number }>;
  scoreDiff: number;
  threshold: number;
  status: "pending" | "arbitrated" | "shelved";
  arbitratorName: string | null;
}

/** 考试阅卷设置 */
export interface ExamReviewSettings {
  reviewMode: ReviewMode;
  enabled: boolean;
}

/** 教师可选题块 */
export interface TeacherBlockAssignment {
  blockId: string;
  blockTitle: string;
  blockType: string;
  totalCount: number;
  assignedToMe: number;
  remainingForMe: number;
  isSelected: boolean;
  questions: Array<{ number: number; score: number }>;
}

/** 首页仪表盘数据 */
export interface DashboardData {
  hasUnfinishedGrading: boolean;
  unfinishedTask: {
    examId: number;
    examName: string;
    blockTitle: string;
    progress: { done: number; total: number };
  } | null;
  latestScanExam: {
    examId: number;
    examName: string;
    subject: string;
    scannedAt: string;
  } | null;
  stats: {
    totalExams: number;
    activeGradingExams: number;
    completedExams: number;
  };
}

/** 仲裁人候选项 */
export interface ArbitratorCandidate {
  id: number;
  name: string;
  subject: string | null;
  isAssignedTeacher: boolean;
}

/** 批量配置更新请求 */
export interface BatchGradingConfigUpdate {
  examId: number;
  blockIds: string[];
  disputeThreshold?: number;
  rounding?: RoundingMode;
  arbitratorId?: number | null;
}

/** 阅卷进度统计 */
export interface ReviewProgress {
  blockId: string;
  blockTitle: string;
  total: number;
  done: number;
  percentage: number;
}
