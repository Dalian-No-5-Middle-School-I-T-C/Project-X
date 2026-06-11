export type ObjectiveMode = "single" | "multiple" | "indefinite";
export type ObjectiveDensity = "loose" | "normal" | "compact" | "dense";
export type SubjectiveStyle = "manual_score_grid" | "plain_subjective";
export type SubjectiveKind = "blank" | "lined_answer" | "plain_box";
export type SubjectiveQuestionNumber = number | string;
export type BlankLabelStyle = "none" | "arabic_parentheses" | "roman_parentheses";

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
};

export type SubjectiveQuestion = {
  id: string;
  number: SubjectiveQuestionNumber;
  score: number;
  style: SubjectiveStyle;
  kind: SubjectiveKind;
  blanks?: { count: number; widthMm: number; heightMm: number; labelStyle?: BlankLabelStyle };
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
  title: string;
  questions: SubjectiveQuestion[];
};

export type BodyBlock = ObjectiveBlock | SubjectiveBlock;

export type AnswerCard = {
  id: string;
  title: string;
  paper: PaperSettings;
  studentInfo: StudentInfoSettings;
  bodyBlocks: BodyBlock[];
  layoutVersion: 1;
  updatedAt: string;
};

export type CardSummary = {
  id: string;
  title: string;
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
  scoreCells: Array<{ score: number; rect: Rect }>;
  lineYs: number[];
  blanks: Rect[];
  blankLabelStyle?: BlankLabelStyle;
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
