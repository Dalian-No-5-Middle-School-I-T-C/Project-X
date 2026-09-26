/**
 * v53: 教师/管理员端「本次正确答案」配置接口
 * 挂载点：/api/exams/:examId/answer-key（路径前缀 /api/exams 已被 examGate 覆盖：
 * GET 需 EXAM_READ，写操作需 EXAM_WRITE；再叠加 requireExamAccess 的数据范围校验）
 *
 * 设计约束：
 * - 答案以「考试」为单位（不是答题卡）：同一张答题卡复用于多次考试时，
 *   每次的正确答案不同，因此不能塞进卡片级 objective_answer_keys。
 * - 只存文字、只出文字：接口不判对错，也不与 question_scores 交互。
 * - OCR 结果是草稿，必须由教师显式 PUT 保存后才对学生可见。
 */
import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import type { Request, Response } from "express";
import { getMysqlDb, buildUpsertSQL } from "../../../../server/db/mysql";
import {
  ANSWER_KEY_EXTENSIONS,
  answerKeyBaseName,
  listAnswerKeyPages,
  listExamAnswerKeys,
  listExamPaperPages,
  resolveAnswerKeyPageFile,
} from "../../../../server/services/ExamPaperViewService";
import { answerKeyDir, answerKeysDir, ensureAnswerKeyDir } from "../storage";
import { MAX_FILE_SIZE, storeAnswerKeyPageFile, validatePaperFile } from "../paper-converter";
import { extractDocxText, extractPdfText, extractImageText } from "../paper-ocr";
import { MAX_ANSWER_TEXT_LENGTH, MAX_QUESTION_NUMBER, parseAnswerKeyText } from "../answer-key-ocr";
import { requireExamAccess } from "../middleware";

/** 答案页上限：既是单批上传上限，也是单场考试的累计上限（页码查看/重识别/删除接口只认 1..该值） */
const MAX_ANSWER_KEY_PAGES = 10;
/** 单场考试可配置的题数上限 */
const MAX_ANSWER_ROWS = MAX_QUESTION_NUMBER;

function decodeMultipartFilename(name: string): string {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("latin1") === name) return decoded;
    return name;
  } catch { return name; }
}

const answerKeyUpload = multer({
  dest: path.join(answerKeysDir, "_tmp"),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_ANSWER_KEY_PAGES },
  fileFilter: (_req, file, cb) => {
    const err = validatePaperFile(decodeMultipartFilename(file.originalname), MAX_FILE_SIZE);
    if (err) {
      cb(new Error(err));
      return;
    }
    cb(null, true);
  },
});

type ExamRow = {
  id: number;
  card_id: string | null;
  name?: string;
  show_original_paper: number | null;
  score_published: number | null;
};

async function loadExam(examId: number): Promise<ExamRow | null> {
  return await getMysqlDb().get<ExamRow>(
    "SELECT id, card_id, name, show_original_paper, score_published FROM exams WHERE id = ?",
    examId
  ) ?? null;
}

function invalidExamId(res: Response, raw: string | string[]): boolean {
  const id = Array.isArray(raw) ? Number.NaN : Number(raw);
  if (Number.isInteger(id) && id > 0) return false;
  res.status(400).json({ message: "无效的考试 ID" });
  return true;
}

/** 从 req.params 取单个字符串值（Express 5 的 params 类型为 string | string[]） */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function normalizePageIndex(value: unknown, max = 9999): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/** OCR：按扩展名选择提取器（图片→tesseract，PDF→文字层，DOCX→mammoth） */
async function ocrAnswerKeyFile(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".docx") return extractDocxText(filePath);
  if (ext === ".pdf") return extractPdfText(filePath);
  return extractImageText(filePath);
}

function draftPayload(text: string | null) {
  const drafts = text ? parseAnswerKeyText(text) : [];
  return {
    recognized: Boolean(text),
    drafts: drafts.map((d) => ({ questionNumber: d.questionNumber, answerText: d.answerText })),
  };
}

export function examAnswerKeyRoutes(): Router {
  const router = Router();

  // GET /api/exams/:examId/answer-key — 配置面板初始数据（原卷页 + 答案页 + 已存答案 + 开关）
  router.get("/api/exams/:examId/answer-key", requireExamAccess, async (req: Request, res: Response) => {
    try {
      if (invalidExamId(res, req.params.examId)) return;
      const exam = await loadExam(Number(req.params.examId));
      if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }

      const [paperPages, answerPages, answers] = await Promise.all([
        listExamPaperPages(exam.card_id),
        listAnswerKeyPages(exam.id),
        listExamAnswerKeys(exam.id),
      ]);
      res.json({
        examId: exam.id,
        examName: exam.name ?? null,
        cardId: exam.card_id,
        showOriginalPaper: exam.show_original_paper === 1 ? 1 : 0,
        scorePublished: exam.score_published === 1 ? 1 : 0,
        hasOriginalPaper: paperPages.length > 0,
        paperPages,
        answerPages,
        answers,
      });
    } catch (err: any) {
      console.error("[answer-key] load failed:", err);
      res.status(500).json({ message: err.message || "读取答案配置失败" });
    }
  });

  // PUT /api/exams/:examId/answer-key — 全量保存逐题文字答案（body.answers=[] 等价清空）
  router.put("/api/exams/:examId/answer-key", requireExamAccess, async (req: Request, res: Response) => {
    const db = getMysqlDb();
    try {
      if (invalidExamId(res, req.params.examId)) return;
      const exam = await loadExam(Number(req.params.examId));
      if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }

      const raw = (req.body ?? {}).answers;
      if (!Array.isArray(raw)) { res.status(400).json({ message: "answers 必须为数组" }); return; }
      if (raw.length > MAX_ANSWER_ROWS) {
        res.status(400).json({ message: `一次最多保存 ${MAX_ANSWER_ROWS} 题答案` });
        return;
      }

      const normalized: Array<{ questionNumber: number; answerText: string; pageIndex: number | null }> = [];
      const seen = new Set<number>();
      for (const item of raw) {
        const row = (item ?? {}) as Record<string, unknown>;
        const questionNumber = Number(row.questionNumber);
        if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > MAX_QUESTION_NUMBER) {
          res.status(400).json({ message: `无效题号：${String(row.questionNumber)}` });
          return;
        }
        if (seen.has(questionNumber)) {
          res.status(400).json({ message: `题号重复：${questionNumber}` });
          return;
        }
        const answerText = typeof row.answerText === "string"
          ? row.answerText.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_TEXT_LENGTH)
          : "";
        if (!answerText) {
          res.status(400).json({ message: `第 ${questionNumber} 题答案不能为空` });
          return;
        }
        // pageIndex 是「原卷页码」（card 级资产），与答案上传页无关，不能用 MAX_ANSWER_KEY_PAGES 截断
        const pageIndex = normalizePageIndex(row.pageIndex);
        if (row.pageIndex != null && row.pageIndex !== "" && pageIndex === null) {
          res.status(400).json({ message: `第 ${questionNumber} 题页码无效` });
          return;
        }
        seen.add(questionNumber);
        normalized.push({ questionNumber, answerText, pageIndex });
      }

      // 全量替换：删除未提交的题号，其余 upsert。事务保证不出现半套答案。
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM exam_answer_keys WHERE exam_id = ?", exam.id);
        if (normalized.length > 0) {
          const sql = buildUpsertSQL(
            tx.dialect,
            "exam_answer_keys",
            ["exam_id", "question_number", "answer_text", "page_index", "updated_by"],
            ["exam_id", "question_number"],
            ["answer_text", "page_index", "updated_by"]
          );
          for (const row of normalized) {
            await tx.run(sql, exam.id, row.questionNumber, row.answerText, row.pageIndex, req.user?.id ?? null);
          }
        }
      });

      res.json({ success: true, saved: normalized.length, answers: await listExamAnswerKeys(exam.id, db) });
    } catch (err: any) {
      console.error("[answer-key] save failed:", err);
      res.status(500).json({ message: err.message || "保存答案失败" });
    }
  });

  // POST /api/exams/:examId/answer-key/pages — 上传「本次正确答案」并可顺带 OCR
  // ?ocr=0 只入库不识别；识别结果作为草稿返回，不落库（教师确认后 PUT 保存）
  router.post("/api/exams/:examId/answer-key/pages", requireExamAccess, (req, res, next) => {
    answerKeyUpload.array("files", MAX_ANSWER_KEY_PAGES)(req, res, (err) => {
      if (err) {
        res.status(400).json({ message: err.message || "答案文件上传失败" });
        return;
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    const db = getMysqlDb();
    try {
      if (invalidExamId(res, req.params.examId)) return;
      const exam = await loadExam(Number(req.params.examId));
      if (!exam) { res.status(404).json({ message: "考试不存在" }); return; }

      const files = ((req.files as Express.Multer.File[]) || []).filter(Boolean);
      if (files.length === 0) { res.status(400).json({ message: "未选择文件" }); return; }

      await ensureAnswerKeyDir(exam.id);
      const dir = answerKeyDir(exam.id);

      // 逐个校验，不静默跳过（与 /api/cards/:cardId/paper 行为一致）
      const valid: Array<{ file: Express.Multer.File; originalname: string }> = [];
      const failed: Array<{ filename: string; error: string }> = [];
      for (const file of files) {
        const name = decodeMultipartFilename(file.originalname);
        const errMsg = validatePaperFile(name, file.size);
        if (errMsg) {
          failed.push({ filename: name, error: errMsg });
          try { unlinkSync(file.path); } catch {}
        } else {
          valid.push({ file, originalname: name });
        }
      }
      if (valid.length === 0) {
        res.status(400).json({ message: "文件校验失败，未上传任何答案页", failed });
        return;
      }

      const runOcr = req.query.ocr !== "0" && req.query.ocr !== "false";
      const uploaded: Array<{ pageIndex: number; filename: string }> = [];

      // multer 已经把这些文件写进 _tmp，任何提前 return 都要负责清理，否则每次重试都留一份垃圾
      const stagedPaths = valid.map((item) => item.file.path);

      // 累计容量校验：只限单批文件数挡不住分多次上传堆出第 11 页，
      // 而页码查看/重识别/删除接口只认 1..MAX_ANSWER_KEY_PAGES。
      const existingRows = (await db.all<{ page_index: number }>(
        "SELECT page_index FROM exam_answer_key_pages WHERE exam_id = ?",
        exam.id
      )) as Array<{ page_index: number }>;
      const usedIndexes = new Set(existingRows.map((row) => Number(row.page_index)));
      // 取最小空闲页码，保证新页码始终落在 1..MAX（MAX+1 递增会让删过页的考试越界）
      let nextFree = 1;
      const takeIndex = (): number => {
        while (usedIndexes.has(nextFree)) nextFree += 1;
        usedIndexes.add(nextFree);
        return nextFree;
      };

      try {
        if (usedIndexes.size + valid.length > MAX_ANSWER_KEY_PAGES) {
          res.status(400).json({
            message: `累计最多上传 ${MAX_ANSWER_KEY_PAGES} 页答案：当前已有 ${usedIndexes.size} 页，本次 ${valid.length} 页`,
          });
          return;
        }

        // 先落盘再写库：压缩/写文件是真异步 I/O，放进事务会跨过 BEGIN/COMMIT 让出事件循环
        // （SQLite 单连接下并发上传会撞 "cannot start a transaction within a transaction"）。
        const planned: Array<{ pageIndex: number; diskFilename: string; relPath: string }> = [];
        for (const { file, originalname } of valid) {
          const pageIndex = takeIndex();
          const stored = await storeAnswerKeyPageFile(file.path, originalname, dir, pageIndex);
          planned.push({ pageIndex, diskFilename: stored.diskFilename, relPath: stored.relPath });
        }

        try {
          await db.transaction(async (tx) => {
            for (const page of planned) {
              await tx.run(
                "INSERT INTO exam_answer_key_pages (exam_id, page_index, filename, stored_path) VALUES (?, ?, ?, ?)",
                exam.id, page.pageIndex, page.diskFilename, page.relPath
              );
            }
          });
        } catch (err) {
          // 入库失败 → 刚写下的文件没有任何记录引用，直接清掉，不留孤儿
          for (const page of planned) {
            try { unlinkSync(path.join(dir, page.diskFilename)); } catch {}
          }
          throw err;
        }
        // ponytail: 同场考试并发上传时最小空闲页码可能被抢，由 uq_exam_answer_key_pages 挡住后者并回滚其文件
        uploaded.push(...planned.map((page) => ({ pageIndex: page.pageIndex, filename: page.diskFilename })));
      } finally {
        for (const stagedPath of stagedPaths) {
          try { unlinkSync(stagedPath); } catch {}
        }
      }

      // OCR 串行：tesseract 每页起一个 WASM worker，并发会瞬间吃满内存
      const ocrResults: Array<{ pageIndex: number; text?: string; drafts?: Array<{ questionNumber: number; answerText: string }>; recognized?: boolean; error?: string }> = [];
      if (runOcr) {
        for (const page of uploaded) {
          const resolved = resolveAnswerKeyPageFile(exam.id, page.pageIndex);
          if (!resolved) { ocrResults.push({ pageIndex: page.pageIndex, error: "文件不存在" }); continue; }
          try {
            const text = await ocrAnswerKeyFile(resolved.filePath);
            ocrResults.push({ pageIndex: page.pageIndex, ...draftPayload(text) });
          } catch (err: any) {
            ocrResults.push({ pageIndex: page.pageIndex, recognized: false, drafts: [], error: err.message || "OCR 失败" });
          }
        }
      }

      res.json({
        success: true,
        pages: uploaded,
        count: uploaded.length,
        ocr: runOcr ? ocrResults : null,
        answerPages: await listAnswerKeyPages(exam.id, db),
        ...(failed.length > 0 ? { failed } : {}),
      });
    } catch (err: any) {
      console.error("[answer-key] upload failed:", err);
      res.status(500).json({ message: err.message || "答案上传失败" });
    }
  });

  // POST /api/exams/:examId/answer-key/pages/:pageIndex/ocr — 对已上传页重新识别（草稿，不落库）
  router.post("/api/exams/:examId/answer-key/pages/:pageIndex/ocr", requireExamAccess, async (req: Request, res: Response) => {
    try {
      if (invalidExamId(res, req.params.examId)) return;
      const examId = Number(req.params.examId);
      const pageIndex = normalizePageIndex(req.params.pageIndex, MAX_ANSWER_KEY_PAGES);
      if (pageIndex === null) { res.status(400).json({ message: "无效的页码" }); return; }

      const resolved = resolveAnswerKeyPageFile(examId, pageIndex);
      if (!resolved) { res.status(404).json({ message: "答案页不存在" }); return; }
      const text = await ocrAnswerKeyFile(resolved.filePath);
      res.json({ pageIndex, ...draftPayload(text) });
    } catch (err: any) {
      console.error("[answer-key] ocr failed:", err);
      res.status(500).json({ message: err.message || "OCR 识别失败" });
    }
  });

  // GET /api/exams/:examId/answer-key/pages/:pageIndex/image — 答案页图片（教师核对用，学生不可访问）
  router.get("/api/exams/:examId/answer-key/pages/:pageIndex/image", requireExamAccess, async (req: Request, res: Response) => {
    try {
      if (invalidExamId(res, req.params.examId)) return;
      const pageIndex = normalizePageIndex(req.params.pageIndex, MAX_ANSWER_KEY_PAGES);
      if (pageIndex === null) { res.status(400).json({ message: "无效的页码" }); return; }
      const resolved = resolveAnswerKeyPageFile(Number(req.params.examId), pageIndex);
      if (!resolved) { res.status(404).json({ message: "答案页不存在" }); return; }
      res.contentType(resolved.mimeType);
      res.sendFile(resolved.filePath);
    } catch (err: any) {
      console.error("[answer-key] image failed:", err);
      res.status(500).json({ message: err.message || "答案页读取失败" });
    }
  });

  // DELETE /api/exams/:examId/answer-key/pages/:pageIndex — 删除答案页（同页所有扩展名残留一并清理）
  router.delete("/api/exams/:examId/answer-key/pages/:pageIndex", requireExamAccess, async (req: Request, res: Response) => {
    try {
      if (invalidExamId(res, req.params.examId)) return;
      const examId = Number(req.params.examId);
      const pageIndex = normalizePageIndex(req.params.pageIndex, MAX_ANSWER_KEY_PAGES);
      if (pageIndex === null) { res.status(400).json({ message: "无效的页码" }); return; }

      const db = getMysqlDb();
      const row = await db.get(
        "SELECT filename FROM exam_answer_key_pages WHERE exam_id = ? AND page_index = ?",
        examId, pageIndex
      ) as { filename: string } | undefined;
      if (!row) { res.status(404).json({ message: "答案页不存在" }); return; }

      const dir = answerKeyDir(examId);
      const baseName = answerKeyBaseName(pageIndex);
      for (const ext of ANSWER_KEY_EXTENSIONS) {
        const filePath = path.join(dir, `${baseName}${ext}`);
        if (existsSync(filePath)) { try { unlinkSync(filePath); } catch {} }
      }
      await db.run("DELETE FROM exam_answer_key_pages WHERE exam_id = ? AND page_index = ?", examId, pageIndex);
      // 注意：exam_answer_keys.page_index 存的是「原卷页码」（card 级资产，见答案配置面板），
      // 与这里删除的「答案扫描页码」是两套坐标系，不能按同一数字联动清空。
      res.json({ success: true, answerPages: await listAnswerKeyPages(examId, db) });
    } catch (err: any) {
      console.error("[answer-key] delete page failed:", err);
      res.status(500).json({ message: err.message || "答案页删除失败" });
    }
  });

  return router;
}
