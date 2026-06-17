export type ObjectiveMode = "single" | "multiple" | "indefinite";
export type ObjectiveDensity = "loose" | "normal" | "compact" | "dense";
export type SubjectiveStyle = "manual_score_grid" | "plain_subjective";
export type SubjectiveKind = "blank" | "lined_answer" | "plain_box";
export type SubjectiveBlockKind = "fill_blank" | "answer";
export type SubjectiveQuestionNumber = number | string;
export type BlankLabelStyle = "none" | "arabic_parentheses" | "roman_parentheses";
export type BlankItem = { label?: string; widthMm: number; heightMm: number };

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
};

export type PaperSettings = {
  size: "A4";
  orientation: "portrait";
};

export type StudentInfoSettings = {
  fields: Array<"姓名" | "班级" | "学号">;
  studentNumberDigits: number;
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
  lineGrid?: { enabled: boolean; lineSpacingMm: number };
  images?: Array<{
    assetId: string;
    originalName?: string;
    widthMm: number;
    heightMm: number;
    align: "left" | "center" | "right";
  }>;
  minHeightMm: number;
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
  layoutVersion: 1;
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
  blanks: Rect[];
  blankLabels?: string[];
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
    };

export type StudentAreaLayout = {
  infoRect: Rect;
  digitRect: Rect;
  digitCells: Array<{ digitIndex: number; digit: number; rect: Rect }>;
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

export type ClassScoreSummary = {
  classId: number;
  className: string;
  summary: ScoreSummary;
};

export type ExamOverview = {
  totalStudents: number;
  gradedCount: number;
  avgScore: number;
  maxScore: number;
  minScore: number;
  stdDev: number;
  passRate: number;
  excellentRate: number;
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
};

export type ExamRecord = {
  id: number;
  name: string;
  card_id: string;
  grade_id: number | null;
  class_id: number | null;
  subject: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
  created_at: string;
};

export type AiModelOption = {
  id: string;
  provider: string;
  label: string;
  available: boolean;
  thinking?: boolean;
};

export type AiAnalysisStatus = {
  available: boolean;
  reason?: string;
  defaultModel: string | null;
  models: AiModelOption[];
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
