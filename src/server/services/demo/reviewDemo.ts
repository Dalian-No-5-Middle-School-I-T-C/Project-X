import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { resolveAnswerCardDataDir, type DbAdapter } from "../../db";
import { rebalanceWorkload } from "../ReviewAssignmentService";
import { makePlaceholderPng } from "./png";
const REVIEW_CARD_ID = "88000999";
const REVIEW_EXAM_NAME = "演示-网阅测试";

function ensurePlaceholderImage(): string {
  const dir = path.join(resolveAnswerCardDataDir(), "recognition", "crops", "demo-review");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "placeholder.png");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, makePlaceholderPng(240, 320, [228, 228, 232]));
  }
  // 存库用相对路径（服务进程 cwd = 仓库根，图片路由按 cwd 解析）
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

interface ReviewBlockSpec {
  blockId: string;
  title: string;
  type: string;
  questions: number[];
  maxScorePerQuestion: number;
  hasHalf: number;
}

const REVIEW_BLOCKS: ReviewBlockSpec[] = [
  {
    blockId: "A",
    title: "解答题A（满分15·含0.5·双评）",
    type: "subjective",
    questions: [1, 2, 3],
    maxScorePerQuestion: 5,
    hasHalf: 1
  },
  {
    blockId: "B",
    title: "解答题B（满分25·单评）",
    type: "subjective",
    questions: [4, 5, 6, 7, 8],
    maxScorePerQuestion: 5,
    hasHalf: 0
  }
];

export async function seedReviewDemo(
  db: Database.Database,
  grade: { id: number },
  studentIdByNumber: Map<string, number>,
  teacherId: number,
  secondTeacherId?: number,
  studentNumbers: string[] = []
): Promise<boolean> {
  // 与调用方演示学号表对应，取前 8 名
  const STUDENT_NUMBERS_FOR_REVIEW = studentNumbers.slice(0, 8);
  // 取前 8 名学生用于演示（份数适中，便于观察进度条与均衡）。
  // 若演示学号已被真实账号占用（batchCreateStudents 会跳过创建 → studentIdByNumber 无映射），
  // 无学生可分配时直接跳过网阅种子：既不创建空壳考试，也避免后续把 undefined studentId
  // 写入 student_scores（student_id NOT NULL）导致 import-demo 500。
  const studentIds = STUDENT_NUMBERS_FOR_REVIEW.map((num) => studentIdByNumber.get(num)).filter(
    (id): id is number => typeof id === "number"
  );
  if (studentIds.length === 0) {
    console.warn("[seed] 网阅演示: 无演示学生可分配（演示学号被占用/跳过），跳过「演示-网阅测试」种子");
    return false;
  }

  // 1. 答题卡 + 真实题块（submitReviewCropScores 依赖卡内题块计算逐题满分，
  //    卡体为空会导致打分提交必失败「题号不在答题卡题目范围内」）。
  db.prepare(
    "INSERT OR IGNORE INTO answer_cards (id, title, subject_label, exam_date, is_demo) VALUES (?, ?, ?, ?, 1)"
  ).run(REVIEW_CARD_ID, "演示-网阅卡", "数学", "2026-06-25");
  const insertReviewBlock = db.prepare(
    "INSERT OR IGNORE INTO subjective_blocks (id, card_id, sort_order, block_kind, title) VALUES (?, ?, ?, 'answer', ?)"
  );
  const insertReviewQuestion = db.prepare(
    `INSERT OR IGNORE INTO subjective_questions
       (id, block_id, number, score, style, kind, min_height_mm, sort_order)
     VALUES (?, ?, ?, ?, 'manual_score_grid', 'plain_box', 68, ?)`
  );
  for (const block of REVIEW_BLOCKS) {
    insertReviewBlock.run(block.blockId, REVIEW_CARD_ID, block.blockId === "A" ? 0 : 1, block.title);
    block.questions.forEach((q, index) => {
      insertReviewQuestion.run(
        `demo-review-${block.blockId}-q${q}`,
        block.blockId,
        q,
        block.maxScorePerQuestion,
        index
      );
    });
  }

  // 2. 考试（review_enabled=1）
  const examInfo = db.prepare(
    `INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, closed_at, review_enabled, created_by)
     VALUES (?, ?, ?, ?, ?, 'closed', CURRENT_TIMESTAMP, 1, (SELECT id FROM users WHERE username = 'admin'))`
  ).run(REVIEW_EXAM_NAME, REVIEW_CARD_ID, grade.id, "数学", "2026-06-25");
  const examId = Number(examInfo.lastInsertRowid);

  const imgPath = ensurePlaceholderImage();

  const insertCrop = db.prepare(
    `INSERT INTO answer_block_crops
       (id, card_id, exam_id, student_id, student_number, source_type, source_record_id,
        block_id, block_title, block_type, page_number, segment_index,
        question_numbers, rect_json, image_path, width_px, height_px, dpi, status, review_round)
     VALUES (?, ?, ?, ?, ?, 'demo', ?, ?, ?, ?, 1, 0, ?, '{}', ?, 240, 320, 300, 'ready', 0)`
  );
  const insertQS = db.prepare(
    `INSERT INTO question_scores
       (exam_id, student_id, question_number, question_id, block_id, score, max_score, score_type, manually_modified, modified_by, modified_at)
     VALUES (?, ?, ?, NULL, ?, 0, ?, 'subjective', 0, (SELECT id FROM users WHERE username = 'admin'), datetime('now'))`
  );
  const insertConfig = db.prepare(
    `INSERT OR IGNORE INTO block_grading_config
       (exam_id, block_id, dispute_threshold, rounding, arbitrator_id, review_mode,
        has_half_point, auto_reassign_no_arb, workload_balance_threshold,
        scoring_mode, score_distribution)
     VALUES (?, ?, 2, 'ceil', NULL, ?, ?, 1, 4, ?, ?)`
  );
  const insertAssignment = db.prepare(
    `INSERT INTO review_assignments (exam_id, block_id, teacher_id, student_count, assigned_student_ids, auto_assigned)
     VALUES (?, ?, ?, ?, ?, 0)`
  );

  for (const block of REVIEW_BLOCKS) {
    // 题块 A: 双评 2P + block_total + proportional；题块 B: 单评 1P + per_question + equal
    const scoringMode = block.blockId === "A" ? "block_total" : "per_question";
    const scoreDist = block.blockId === "A" ? "proportional" : "equal";
    const reviewMode = block.blockId === "A" ? 2 : 1;
    insertConfig.run(examId, block.blockId, reviewMode, block.hasHalf, scoringMode, scoreDist);
  }

  // 分配策略：
  // - 题块 B（满分25，位值模式）：全部 8 份给 demo-teacher（单教师，无均衡演示）。
  // - 题块 A（满分15，枚举模式）：demo-teacher 5 份 + demo-teacher-2 1 份，2 份暂不分配；
  //   随后 rebalanceWorkload 会把未分配卷吸收到份数最少的教师（演示「进度条加卷 + 份数差收敛」）。
  const blockAFirstTeacher = studentIds.slice(0, 5);
  const blockASecondTeacher = secondTeacherId != null ? studentIds.slice(5, 6) : [];
  if (secondTeacherId != null) {
    insertAssignment.run(examId, "A", teacherId, blockAFirstTeacher.length, JSON.stringify(blockAFirstTeacher));
    insertAssignment.run(examId, "A", secondTeacherId, blockASecondTeacher.length, JSON.stringify(blockASecondTeacher));
  } else {
    // 无第二教师时退化为单教师全量分配
    insertAssignment.run(examId, "A", teacherId, studentIds.length, JSON.stringify(studentIds));
  }
  insertAssignment.run(examId, "B", teacherId, studentIds.length, JSON.stringify(studentIds));

  for (const studentId of studentIds) {
    const studentNumberRow = db.prepare("SELECT student_number FROM users WHERE id = ?").get(studentId) as
      | { student_number: string | null }
      | undefined;
    const studentNumber = studentNumberRow?.student_number ?? null;
    for (const block of REVIEW_BLOCKS) {
      const cropId = `demo-${examId}-${block.blockId}-${studentId}`;
      insertCrop.run(
        cropId,
        REVIEW_CARD_ID,
        examId,
        studentId,
        studentNumber,
        `demo-${examId}-${studentId}`,
        block.blockId,
        block.title,
        block.type,
        JSON.stringify(block.questions),
        imgPath
      );
      for (const q of block.questions) {
        insertQS.run(examId, studentId, q, block.blockId, block.maxScorePerQuestion);
      }
    }
  }

  // ── v1.9.9: 打分记录演示（双评 / 争议 / 断点续批 / 批注）──
  // score_breakdown 与 ReviewService.submitReviewCropScores 的落库结构一致：
  // [{ round, reviewerId, score, reviewedAt, questionScores }]
  const r2 = secondTeacherId ?? teacherId;
  const reviewedAt = "2026-06-25T09:30:00.000Z";

  interface ReviewRoundSeed {
    reviewerId: number;
    score: number;
    questionScores: Record<string, number>;
  }
  interface ReviewCropSeed {
    blockId: string;
    studentId: number;
    status: "reviewed" | "disputed" | "pending";
    rounds: ReviewRoundSeed[];
  }

  // 题块 A（双评 2P）：3 份双评一致 → reviewed；1 份双评分歧（9 vs 13，差 4 > 阈值 2）→ disputed；
  // 其余 4 份已评 1 轮 → pending（等待第二评）
  const blockAStates: ReviewCropSeed[] = [
    { blockId: "A", studentId: studentIds[0], status: "reviewed", rounds: [
      { reviewerId: teacherId, score: 10, questionScores: { "1": 4, "2": 3, "3": 3 } },
      { reviewerId: r2, score: 10, questionScores: { "1": 4, "2": 3, "3": 3 } }
    ]},
    { blockId: "A", studentId: studentIds[1], status: "reviewed", rounds: [
      { reviewerId: teacherId, score: 12, questionScores: { "1": 5, "2": 4, "3": 3 } },
      { reviewerId: r2, score: 12, questionScores: { "1": 5, "2": 4, "3": 3 } }
    ]},
    { blockId: "A", studentId: studentIds[2], status: "reviewed", rounds: [
      { reviewerId: teacherId, score: 11, questionScores: { "1": 4, "2": 4, "3": 3 } },
      { reviewerId: r2, score: 11, questionScores: { "1": 4, "2": 4, "3": 3 } }
    ]},
    { blockId: "A", studentId: studentIds[3], status: "disputed", rounds: [
      { reviewerId: teacherId, score: 9, questionScores: { "1": 3, "2": 3, "3": 3 } },
      { reviewerId: r2, score: 13, questionScores: { "1": 5, "2": 4, "3": 4 } }
    ]},
    { blockId: "A", studentId: studentIds[4], status: "pending", rounds: [
      { reviewerId: teacherId, score: 10, questionScores: { "1": 4, "2": 3, "3": 3 } }
    ]},
    { blockId: "A", studentId: studentIds[5], status: "pending", rounds: [
      { reviewerId: teacherId, score: 11, questionScores: { "1": 5, "2": 3, "3": 3 } }
    ]},
    { blockId: "A", studentId: studentIds[6], status: "pending", rounds: [
      { reviewerId: teacherId, score: 9, questionScores: { "1": 3, "2": 3, "3": 3 } }
    ]},
    { blockId: "A", studentId: studentIds[7], status: "pending", rounds: [
      { reviewerId: teacherId, score: 12, questionScores: { "1": 5, "2": 4, "3": 3 } }
    ]}
  ];

  // 题块 B（单评 1P）：3 份已批 → reviewed，其余 5 份保持 ready 待批
  const blockBStates: ReviewCropSeed[] = [
    { blockId: "B", studentId: studentIds[0], status: "reviewed", rounds: [
      { reviewerId: teacherId, score: 20, questionScores: { "4": 4, "5": 4, "6": 4, "7": 4, "8": 4 } }
    ]},
    { blockId: "B", studentId: studentIds[1], status: "reviewed", rounds: [
      { reviewerId: teacherId, score: 22, questionScores: { "4": 5, "5": 4, "6": 5, "7": 4, "8": 4 } }
    ]},
    { blockId: "B", studentId: studentIds[2], status: "reviewed", rounds: [
      { reviewerId: teacherId, score: 18, questionScores: { "4": 4, "5": 4, "6": 3, "7": 3, "8": 4 } }
    ]}
  ];
  // 仅保留有有效学生映射的种子记录：演示学号被部分占用时 studentIds 可能短于 8，
  // 尾部索引为 undefined，若不过滤会把 undefined 写入 student_scores（NOT NULL）报错。
  const reviewSeeds = [...blockAStates, ...blockBStates].filter(
    (s): s is ReviewCropSeed & { studentId: number } => typeof s.studentId === "number"
  );

  const breakdownOf = (rounds: ReviewRoundSeed[]) =>
    rounds.map((r, i) => ({ round: i + 1, reviewerId: r.reviewerId, score: r.score, reviewedAt, questionScores: r.questionScores }));

  // 写切块评分状态：reviewed 落 final_score；disputed 无最终分（等仲裁/复评）；pending 保留第 1 轮
  const updateCrop = db.prepare(`
    UPDATE answer_block_crops
    SET status = ?, reviewer_id = ?, reviewed_at = ?, review_round = ?, final_score = ?,
        final_score_by = ?, score_breakdown = ?
    WHERE id = ?
  `);
  for (const s of reviewSeeds) {
    const last = s.rounds[s.rounds.length - 1];
    const finalScore = s.status === "reviewed" ? last.score : null;
    updateCrop.run(
      s.status, last.reviewerId, reviewedAt, s.rounds.length,
      finalScore, finalScore != null ? last.reviewerId : null,
      JSON.stringify(breakdownOf(s.rounds)),
      `demo-${examId}-${s.blockId}-${s.studentId}`
    );
  }

  // 已批卷逐题主观分落库（与打分提交后的落库语义一致：score_type='subjective'、manually_modified=1）
  const updateQS = db.prepare(`
    UPDATE question_scores
    SET score = ?, score_type = 'subjective', manually_modified = 1, modified_by = ?, modified_at = ?
    WHERE exam_id = ? AND student_id = ? AND question_number = ?
  `);
  for (const s of reviewSeeds) {
    if (s.status !== "reviewed") continue; // 争议/待评卷不落正式分
    const last = s.rounds[s.rounds.length - 1];
    for (const [q, score] of Object.entries(last.questionScores)) {
      updateQS.run(score, last.reviewerId, reviewedAt, examId, s.studentId, Number(q));
    }
  }

  // 网阅考试学生成绩（客观 0、主观 = 已批题块合计；争议卷不计分，仲裁后才会落库）
  const studentTotal = new Map<number, number>();
  for (const s of reviewSeeds) {
    if (s.status !== "reviewed") continue;
    const last = s.rounds[s.rounds.length - 1];
    studentTotal.set(s.studentId, (studentTotal.get(s.studentId) ?? 0) + last.score);
  }
  const insertStudentScore = db.prepare(
    "INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 0, ?, ?)"
  );
  for (const [sid, total] of studentTotal) insertStudentScore.run(examId, sid, total, total);

  // 断点续批：demo-teacher 在题块 B 批到第 4 份时保存的草稿会话（draft_scores 以切块 id 为键，同 GradePanel 语义）
  db.prepare(`
    INSERT OR IGNORE INTO review_sessions (teacher_id, exam_id, block_id, current_index, position_json, draft_scores, updated_at)
    VALUES (?, ?, 'B', 3, '{"zoom":1,"rotation":0}', ?, ?)
  `).run(teacherId, examId, JSON.stringify({ [`demo-${examId}-B-${studentIds[3]}`]: 19 }), reviewedAt);

  // 批注：题块 B 首份已批卷留一条文字批注（data_json 与前端 AnnotationOverlay 一致：{ text }）
  db.prepare(`
    INSERT OR IGNORE INTO review_annotations (id, crop_id, reviewer_id, type, data_json, created_at)
    VALUES (?, ?, ?, 'text', ?, ?)
  `).run(`demo-annot-${examId}-b1`, `demo-${examId}-B-${studentIds[0]}`, teacherId,
    JSON.stringify({ text: "解答规范，书写清晰。" }), reviewedAt);

  // 题块 A 工作量均衡：把 8 份卷在已分配教师间收敛到「份数差 ≤ 4」
  if (secondTeacherId != null) {
    await rebalanceWorkload(examId, "A", makeSyncAdapter(db));
  }

  const aAssign = db.prepare("SELECT teacher_id, student_count, auto_assigned FROM review_assignments WHERE exam_id = ? AND block_id = 'A' ORDER BY teacher_id").all(examId) as Array<{ teacher_id: number; student_count: number; auto_assigned: number }>;
  const aSummary = aAssign.map((r) => `教师${r.teacher_id}:${r.student_count}份${r.auto_assigned ? "(含自动追加)" : ""}`).join("，");

  console.log(
    `[seed] 网阅演示: 考试「${REVIEW_EXAM_NAME}」(id=${examId})，题块 A(满分${REVIEW_BLOCKS[0].questions.length * 5}·含0.5·双评2P) / B(满分${REVIEW_BLOCKS[1].questions.length * 5}·单评1P)。` +
      `已批 A 3 份双评一致 + 1 份争议，B 3 份；断点续批草稿 + 批注 1 条。题块A分配均衡后：${aSummary}`
  );
  return true;
}

/** 用同步 better-sqlite3 实例构造 DbAdapter，便于种子逻辑复用服务端 rebalanceWorkload */
function makeSyncAdapter(db: Database.Database): DbAdapter {
  const adapter: DbAdapter = {
    dialect: "sqlite",
    get: <T = any>(sql: string, ...params: any[]) => Promise.resolve((db.prepare(sql).get(...params) as T | null | undefined) ?? null),
    all: <T = any>(sql: string, ...params: any[]) => Promise.resolve(db.prepare(sql).all(...params) as T[]),
    run: (sql, ...params) => {
      const r = db.prepare(sql).run(...params);
      return Promise.resolve({ lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes });
    },
    exec: (sql) => {
      db.exec(sql);
      return Promise.resolve();
    },
    transaction: async (fn) => {
      db.exec("BEGIN");
      try {
        const v = await fn(adapter);
        db.exec("COMMIT");
        return v;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  };
  return adapter;
}
