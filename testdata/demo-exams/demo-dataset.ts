/**
 * 演示考试静态数据集 — 与 seed.ts 保持一致，供种子脚本与 public/demo 共用。
 */

export const DEMO_PREFIX = "演示-";

export const STUDENT_NUMBERS = [
  "20260101", "20260102", "20260103", "20260104",
  "20260105", "20260106", "20260107", "20260108",
  "20260109", "20260110", "20260111", "20260112",
  "20260113", "20260114", "20260115", "20260116"
] as const;

export const STUDENT_NAMES = [
  "张明", "李华", "王芳", "刘强", "陈静", "赵伟", "孙丽", "周杰",
  "吴敏", "郑涛", "钱磊", "冯雪", "褚亮", "卫红", "蒋浩", "沈婷"
] as const;

export const CLASS_NAMES = ["演示1班", "演示2班"] as const;
export const GRADE_NAME = "高一(演示)";

export interface DemoExamSpec {
  cardId: string;
  name: string;
  subject: string;
  examDate: string;
  fullScore: number;
  scores: Record<string, number>;
  withQuestions?: boolean;
}

export const PRIOR_MATH_EXAM: DemoExamSpec = {
  cardId: "88000008",
  name: `${DEMO_PREFIX}数学月考`,
  subject: "数学",
  examDate: "2026-05-20",
  fullScore: 150,
  scores: {
    "20260101": 130, "20260102": 120, "20260103": 125, "20260104": 135,
    "20260105": 115, "20260106": 105, "20260107": 118, "20260108": 138,
    "20260109": 122, "20260110": 118, "20260111": 110, "20260112": 125,
    "20260113": 115, "20260114": 128, "20260115": 112, "20260116": 120
  }
};

export const WEEK_EXAMS: DemoExamSpec[] = [
  {
    cardId: "88000001", name: `${DEMO_PREFIX}语文`, subject: "语文", examDate: "2026-06-16", fullScore: 150,
    scores: {
      "20260101": 132, "20260102": 125, "20260103": 118, "20260104": 140,
      "20260105": 128, "20260106": 115, "20260107": 122, "20260108": 135,
      "20260109": 130, "20260110": 120, "20260111": 128, "20260112": 116,
      "20260113": 124, "20260114": 138, "20260115": 121, "20260116": 127
    }
  },
  {
    cardId: "88000002", name: `${DEMO_PREFIX}数学`, subject: "数学", examDate: "2026-06-17", fullScore: 150,
    withQuestions: true,
    scores: {
      "20260101": 145, "20260102": 128, "20260103": 128, "20260104": 138,
      "20260105": 120, "20260106": 110, "20260107": 125, "20260108": 142,
      "20260109": 128, "20260110": 128, "20260111": 115, "20260112": 130,
      "20260113": 122, "20260114": 136, "20260115": 118, "20260116": 124
    }
  },
  {
    cardId: "88000003", name: `${DEMO_PREFIX}英语`, subject: "英语", examDate: "2026-06-18", fullScore: 150,
    scores: {
      "20260101": 128, "20260102": 135, "20260103": 122, "20260104": 130,
      "20260105": 118, "20260106": 125, "20260107": 140, "20260108": 115,
      "20260109": 132, "20260110": 128, "20260111": 120, "20260112": 138,
      "20260113": 126, "20260114": 122, "20260115": 134, "20260116": 119
    }
  },
  {
    cardId: "88000004", name: `${DEMO_PREFIX}物理`, subject: "物理", examDate: "2026-06-19", fullScore: 100,
    scores: {
      "20260101": 88, "20260102": 76, "20260103": 82, "20260104": 91,
      "20260105": 85, "20260106": 70, "20260107": 78, "20260108": 92,
      "20260109": 80, "20260110": 76, "20260111": 88, "20260112": 74,
      "20260113": 82, "20260114": 90, "20260115": 77, "20260116": 84
    }
  },
  {
    cardId: "88000005", name: `${DEMO_PREFIX}化学`, subject: "化学", examDate: "2026-06-20", fullScore: 100,
    scores: {
      "20260101": 85, "20260102": 78, "20260103": 80, "20260104": 88,
      "20260105": 72, "20260106": 75, "20260107": 82,
      "20260109": 79, "20260110": 83, "20260111": 76, "20260112": 81,
      "20260113": 77, "20260114": 86, "20260115": 74, "20260116": 80
    }
  },
  {
    cardId: "88000006", name: `${DEMO_PREFIX}生物`, subject: "生物", examDate: "2026-06-21", fullScore: 100,
    scores: {
      "20260101": 90, "20260102": 82, "20260103": 85, "20260104": 88,
      "20260105": 78, "20260106": 80, "20260107": 86, "20260108": 84,
      "20260109": 81, "20260110": 79, "20260111": 83, "20260112": 77,
      "20260113": 85, "20260114": 89, "20260115": 82
    }
  }
];

export const OUTSIDE_WEEK_EXAM: DemoExamSpec = {
  cardId: "88000007",
  name: `${DEMO_PREFIX}历史`,
  subject: "历史",
  examDate: "2026-06-10",
  fullScore: 100,
  scores: {
    "20260101": 78, "20260102": 85, "20260103": 72, "20260104": 88,
    "20260105": 80, "20260106": 76, "20260107": 82, "20260108": 90,
    "20260109": 74, "20260110": 86, "20260111": 79, "20260112": 83,
    "20260113": 77, "20260114": 84, "20260115": 81, "20260116": 75
  }
};

export const ALL_EXAMS: DemoExamSpec[] = [
  PRIOR_MATH_EXAM,
  ...WEEK_EXAMS,
  OUTSIDE_WEEK_EXAM
];

export const WEEK_EXAM_CARD_IDS = WEEK_EXAMS.map((e) => e.cardId);

export const EXAM_GROUP = {
  name: `${DEMO_PREFIX}2026高考摸底大考`,
  description: "语数英物化生六科联考演示数据",
  examCardIds: WEEK_EXAM_CARD_IDS
};

export const CROSS_EXAM_GROUP = {
  name: `${DEMO_PREFIX}第25周考试包`,
  startDate: "2026-06-16",
  endDate: "2026-06-22",
  examCardIds: WEEK_EXAM_CARD_IDS
};

/** 演示-数学知识点（对齐主站跨班深度对比 / class-compare） */
export const MATH_KNOWLEDGE_POINTS = [
  { pointText: "函数与导数", questionNumbers: [1, 2] },
  { pointText: "立体几何", questionNumbers: [3, 4] },
  { pointText: "概率统计", questionNumbers: [5] }
] as const;

export const TEST_SCENARIOS = [
  {
    id: "tie-rank-math",
    feature: "并列排名",
    steps: "单科 → 演示-数学 → 成绩",
    expect: "4 人 128 分并列，年排均为 6（competitionRank）"
  },
  {
    id: "percentile-formula-a",
    feature: "百分位公式 A",
    steps: "单科 → 演示-数学 → 百分位列",
    expect: "与主站 rankingUpdate 一致：(total - rank) / (total - 1) × 100，末名 0"
  },
  {
    id: "absent-chem-bio",
    feature: "缺考",
    expect: "化学缺周杰(20260108)；生物缺沈婷(20260116)"
  },
  {
    id: "cross-week",
    feature: "跨考按周",
    steps: "跨考 → 2026-06-16~22",
    expect: "6 场考试，16 人；仅全勤 14 人"
  },
  {
    id: "exam-group",
    feature: "大考合集",
    steps: "大考 → 演示-2026高考摸底大考",
    expect: "6 科概览 + 跨科排名表"
  },
  {
    id: "cross-saved-group",
    feature: "跨考已存组",
    steps: "跨考 → 已存组 → 演示-第25周考试包",
    expect: "6 场考试统计"
  },
  {
    id: "rank-change",
    feature: "名次变化",
    expect: "演示-数学月考 vs 演示-数学，可查看 rankChange"
  },
  {
    id: "question-export",
    feature: "客观题小分",
    expect: "演示-数学含 Q1~Q5 客观题小分"
  },
  {
    id: "class-compare",
    feature: "跨班深度对比",
    steps: "教师端 → 跨班对比 → 演示-数学",
    expect: "两班均分/及格率/题目得分率矩阵/知识点弱项可对比；支持基准班级差值"
  }
] as const;

export function buildQuestionScores(total: number): Array<{ q: number; score: number; max: number }> {
  const perQ = Math.floor(total / 5);
  const remainder = total - perQ * 5;
  return [1, 2, 3, 4, 5].map((q) => ({
    q,
    score: q === 5 ? perQ + remainder : perQ,
    max: 30
  }));
}

export function buildStaticDemoPayload() {
  const students = STUDENT_NUMBERS.map((no, i) => ({
    id: no,
    studentNo: no,
    name: STUDENT_NAMES[i],
    className: i < 8 ? CLASS_NAMES[0] : CLASS_NAMES[1]
  }));

  const exams = ALL_EXAMS.map((spec) => ({
    ...spec,
    questionScores: spec.withQuestions
      ? Object.fromEntries(
          Object.entries(spec.scores).map(([no, total]) => [no, buildQuestionScores(total)])
        )
      : undefined
  }));

  return {
    version: "1.1.0",
    grade: GRADE_NAME,
    classes: [...CLASS_NAMES],
    students,
    exams,
    examGroup: EXAM_GROUP,
    crossExamGroup: CROSS_EXAM_GROUP,
    knowledgePoints: {
      "88000002": MATH_KNOWLEDGE_POINTS.map((k) => ({
        pointText: k.pointText,
        questionNumbers: [...k.questionNumbers]
      }))
    },
    testScenarios: TEST_SCENARIOS,
    accounts: {
      teacher: { identifier: "demo-teacher", password: "teacher123", name: "演示教师" },
      students: { passwordRule: "与学号相同", range: "20260101-20260116" },
      offlineDemo: { identifier: "offline-demo", password: "offline-demo", path: "/demo/" }
    }
  };
}
