export type ObjectiveMode = "single" | "multiple" | "indefinite";
export type ObjectiveDensity = "loose" | "normal" | "compact" | "dense";
export type ObjectiveOptionLayout = "horizontal" | "vertical";
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
  optionLayout?: ObjectiveOptionLayout;
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
}

/** 大考概览 */
export interface GroupOverview {
  groupId: number;
  groupName: string;
  totalParticipants: number;
  fullParticipants: number;
  subjects: GroupSubjectSummary[];
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
