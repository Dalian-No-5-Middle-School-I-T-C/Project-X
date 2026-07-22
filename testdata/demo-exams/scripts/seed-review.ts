/**
 * 网阅打分面板 DEV 演示种子（v1.9.4 路径 B 测试入口）
 *
 * 设计目标：在不依赖 C++ 原生模块（OMR/TWAIN）的前提下，一键产出网阅打分面板
 * 所需的全部数据，使 `demo-teacher` 登录后即可实测：
 *   - 题块 A（满分 15，含 0.5）：枚举模式 + 底部 0/0.5 专用行
 *   - 题块 B（满分 25，不含 0.5）：十位+个位+十分位 位值模式
 *   - 工作量均衡自动再分配 / 全局设置等可在后续阶段验证
 *
 * 复用 seed.ts 已建立的 db / 年级 / 学生 / demo-teacher。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { DbAdapter } from "../../../src/server/db/index";
import { rebalanceWorkload } from "../../../src/server/services/ReviewAssignmentService";

const REVIEW_CARD_ID = "88000999";
const REVIEW_EXAM_NAME = "演示-网阅测试";

// ---- 自包含占位图（生成有效 PNG，避免依赖外部图片/二进制） ----
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePlaceholderPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

function ensurePlaceholderImage(repoRoot: string): string {
  const dir = path.join(repoRoot, "data", "answer-card", "recognition", "crops", "demo-review");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "placeholder.png");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, makePlaceholderPng(240, 320, [228, 228, 232]));
  }
  // 存库用相对路径（服务进程 cwd = 仓库根，图片路由按 cwd 解析）
  return path.relative(repoRoot, file).split(path.sep).join("/");
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
    title: "解答题A（满分15·含0.5）",
    type: "subjective",
    questions: [1, 2, 3],
    maxScorePerQuestion: 5,
    hasHalf: 1
  },
  {
    blockId: "B",
    title: "解答题B（满分25）",
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
  secondTeacherId?: number
): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  // 1. 答题卡（submitReviewCropScores 需要 card 存在，body 可空）
  db.prepare(
    "INSERT OR IGNORE INTO answer_cards (id, title, subject_label, exam_date) VALUES (?, ?, ?, ?)"
  ).run(REVIEW_CARD_ID, "演示-网阅卡", "数学", "2026-06-25");

  // 2. 考试（review_enabled=1）
  const examInfo = db.prepare(
    `INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, review_enabled, created_by)
     VALUES (?, ?, ?, ?, ?, 'closed', 1, (SELECT id FROM users WHERE username = 'admin'))`
  ).run(REVIEW_EXAM_NAME, REVIEW_CARD_ID, grade.id, "数学", "2026-06-25");
  const examId = Number(examInfo.lastInsertRowid);

  const imgPath = ensurePlaceholderImage(repoRoot);

  // 取前 8 名学生用于演示（份数适中，便于观察进度条与均衡）
  const studentIds = STUDENT_NUMBERS_FOR_REVIEW.map((num) => studentIdByNumber.get(num)).filter(
    (id): id is number => typeof id === "number"
  );

  const insertCrop = db.prepare(
    `INSERT INTO answer_block_crops
       (id, card_id, exam_id, student_id, student_number, source_type, source_record_id,
        block_id, block_title, block_type, page_number, segment_index,
        question_numbers, rect_json, image_path, width_px, height_px, dpi, status)
     VALUES (?, ?, ?, ?, ?, 'demo', ?, ?, ?, ?, 1, 0, ?, '{}', ?, 240, 320, 300, 'ready')`
  );
  const insertQS = db.prepare(
    `INSERT INTO question_scores
       (exam_id, student_id, question_number, question_id, block_id, score, max_score, score_type, manually_modified, modified_by, modified_at)
     VALUES (?, ?, ?, NULL, ?, 0, ?, 'subjective', 0, (SELECT id FROM users WHERE username = 'admin'), datetime('now'))`
  );
  const insertConfig = db.prepare(
    `INSERT OR IGNORE INTO block_grading_config
       (exam_id, block_id, dispute_threshold, rounding, arbitrator_id, review_mode, has_half_point, auto_reassign_no_arb, workload_balance_threshold)
     VALUES (?, ?, 2, 'ceil', NULL, 1, ?, 1, 4)`
  );
  const insertAssignment = db.prepare(
    `INSERT INTO review_assignments (exam_id, block_id, teacher_id, student_count, assigned_student_ids, auto_assigned)
     VALUES (?, ?, ?, ?, ?, 0)`
  );

  for (const block of REVIEW_BLOCKS) {
    insertConfig.run(examId, block.blockId, block.hasHalf);
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

  // 题块 A 工作量均衡：把 8 份卷在已分配教师间收敛到「份数差 ≤ 4」
  if (secondTeacherId != null) {
    await rebalanceWorkload(examId, "A", makeSyncAdapter(db));
  }

  const aAssign = db.prepare("SELECT teacher_id, student_count, auto_assigned FROM review_assignments WHERE exam_id = ? AND block_id = 'A' ORDER BY teacher_id").all(examId) as Array<{ teacher_id: number; student_count: number; auto_assigned: number }>;
  const aSummary = aAssign.map((r) => `教师${r.teacher_id}:${r.student_count}份${r.auto_assigned ? "(含自动追加)" : ""}`).join("，");

  console.log(
    `[seed] 网阅演示: 考试「${REVIEW_EXAM_NAME}」(id=${examId})，题块 A(满分${REVIEW_BLOCKS[0].questions.length * 5}·含0.5) / B(满分${REVIEW_BLOCKS[1].questions.length * 5})。` +
      `题块A分配均衡后：${aSummary}`
  );
}

/** 用同步 better-sqlite3 实例构造 DbAdapter，便于种子脚本复用服务端 rebalanceWorkload 逻辑 */
function makeSyncAdapter(db: Database.Database): DbAdapter {
  const adapter: DbAdapter = {
    dialect: "sqlite",
    get: (sql, ...params) => Promise.resolve(db.prepare(sql).get(...params) ?? null),
    all: (sql, ...params) => Promise.resolve(db.prepare(sql).all(...params)),
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

// 与 seed.ts 中 STUDENT_NUMBERS 对应，取前 8 名
const STUDENT_NUMBERS_FOR_REVIEW = [
  "20260101", "20260102", "20260103", "20260104",
  "20260105", "20260106", "20260107", "20260108"
];
