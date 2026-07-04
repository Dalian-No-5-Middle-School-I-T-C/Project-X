/**
 * Card knowledge-point / original-paper routes.
 * Mounted at /api/cards/:cardId (mergeParams: true).
 */
import express from "express";
import multer from "multer";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getDatabase } from "../../../../server/db";
import { ApiError } from "../../../../server/api-error";
import { assetsDir } from "../storage";

const router = express.Router({ mergeParams: true });

function cardId(req: express.Request): string {
  return (req.params as any).cardId as string;
}

const DATA_DIR = path.join(assetsDir, "..", "original-papers");

const paperUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await mkdir(DATA_DIR, { recursive: true });
      cb(null, DATA_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".pdf";
      cb(null, `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif"];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error("仅支持 PDF 和图片 (PNG/JPG/TIFF)"));
    }
  },
});

function fail(res: express.Response, error: unknown) {
  console.error(error);
  if (!res.headersSent) {
    res.status(500).json({ message: error instanceof Error ? error.message : "服务器错误" });
  }
}

// ── Upload ──────────────────────────────────────────────
router.post("/original-paper", paperUpload.single("file"), async (req, res) => {
  try {
    const cid = cardId(req);
    if (!req.file) {
      res.status(400).json({ code: ApiError.MISSING_REQUIRED, message: "请选择要上传的原卷文件" });
      return;
    }
    const db = getDatabase();
    db.prepare(`
      UPDATE answer_cards SET has_original_paper = 1, original_paper_filename = ?,
      original_paper_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.file.originalname, req.file.destination + "/" + req.file.filename, cid);
    res.json({ ok: true, filename: req.file.originalname });
  } catch (error) { fail(res, error); }
});

// ── View ────────────────────────────────────────────────
router.get("/original-paper/view", (req, res) => {
  try {
    const row = getDatabase().prepare(
      "SELECT original_paper_path FROM answer_cards WHERE id = ?"
    ).get(cardId(req)) as any;
    if (!row?.original_paper_path || !existsSync(row.original_paper_path)) {
      res.status(404).json({ message: "未上传原卷" });
      return;
    }
    res.sendFile(row.original_paper_path);
  } catch (error) { fail(res, error); }
});

// ── Get knowledge points ────────────────────────────────
router.get("/knowledge-points", (req, res) => {
  try {
    const rows = getDatabase().prepare(
      "SELECT * FROM knowledge_points WHERE card_id = ? ORDER BY question_number, category"
    ).all(cardId(req));
    res.json(rows);
  } catch (error) { fail(res, error); }
});

// ── Save knowledge points ───────────────────────────────
router.put("/knowledge-points", (req, res) => {
  try {
    const cid = cardId(req);
    const { points } = req.body as { points: Array<{ question_number: number; category?: string; point_text: string }> };
    if (!Array.isArray(points)) { res.status(400).json({ message: "points 必须是数组" }); return; }
    const db = getDatabase();
    db.prepare("DELETE FROM knowledge_points WHERE card_id = ?").run(cid);
    const insert = db.prepare(
      "INSERT OR REPLACE INTO knowledge_points (card_id, question_number, point_text, category, sort_order) VALUES (?,?,?,?,?)"
    );
    let idx = 0;
    for (const p of points) insert.run(cid, p.question_number, p.point_text, p.category ?? null, idx++);
    const raw = points.map((p) => `${p.category ?? ""}:${p.point_text}`).join("\n");
    db.prepare("UPDATE answer_cards SET knowledge_points_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(raw, cid);
    res.json({ ok: true, count: points.length });
  } catch (error) { fail(res, error); }
});

// ── AI analyze ──────────────────────────────────────────
router.post("/ai-analyze-questions", async (req, res) => {
  try {
    const cid = cardId(req);
    const row = getDatabase().prepare(
      "SELECT original_paper_path FROM answer_cards WHERE id = ? AND has_original_paper = 1"
    ).get(cid) as any;
    if (!row?.original_paper_path) { res.status(400).json({ message: "请先上传原卷" }); return; }

    const prompt = buildPrompt(cid);
    const llm = process.env.LLMCLIENT_URL || "http://127.0.0.1:8766";
    const r = await fetch(`${llm}/analysis/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.LLMCLIENT_INTERNAL_API_KEY ? { Authorization: `Bearer ${process.env.LLMCLIENT_INTERNAL_API_KEY}` } : {}) },
      body: JSON.stringify({ mode: "analyze-questions", cardId: cid, prompt }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) { res.status(502).json({ code: ApiError.AI_SERVICE_ERROR, message: `AI 服务返回 ${r.status}` }); return; }
    const result = await r.json() as any;
    res.json(result.questions || []);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      res.status(504).json({ code: ApiError.AI_SERVICE_TIMEOUT, message: "AI 分析超时" }); return;
    }
    fail(res, error);
  }
});

// ── AI format tags ──────────────────────────────────────
router.post("/ai-format-knowledge-points", async (req, res) => {
  try {
    const { rawTags, subject } = req.body as { rawTags: string[]; subject?: string };
    if (!rawTags?.length) { res.status(400).json({ message: "rawTags 不能为空" }); return; }
    const llm = process.env.LLMCLIENT_URL || "http://127.0.0.1:8766";
    const r = await fetch(`${llm}/analysis/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.LLMCLIENT_INTERNAL_API_KEY ? { Authorization: `Bearer ${process.env.LLMCLIENT_INTERNAL_API_KEY}` } : {}) },
      body: JSON.stringify({ mode: "format-knowledge-points", rawTags, subject: subject ?? "" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) { res.status(502).json({ code: ApiError.AI_SERVICE_ERROR, message: `AI 服务返回 ${r.status}` }); return; }
    res.json(await r.json());
  } catch (error) { fail(res, error); }
});

function buildPrompt(cardId: string): string {
  const db = getDatabase();
  const card = db.prepare("SELECT title, subject_label FROM answer_cards WHERE id = ?").get(cardId) as any;
  const blocks = db.prepare("SELECT * FROM objective_blocks WHERE card_id = ? ORDER BY sort_order").all(cardId) as any[];
  const subject = card?.subject_label || "未知科目";
  let p = `请分析以下${subject}试卷的题目知识点:\n\n试卷: ${card?.title || cardId}\n`;
  for (const b of blocks) {
    p += `\n## ${b.title}\n`;
    const qs = db.prepare("SELECT * FROM objective_questions WHERE block_id = ? ORDER BY question_number").all(b.id) as any[];
    for (const q of qs) p += `- 第${q.question_number}题 (${q.mode==="single"?"单选":"多选"}, ${q.option_count}选项, ${q.score}分)\n`;
  }
  p += `\n为每道题标注: 章节(如"必修一·函数")、知识点(如"二次函数顶点式")。返回JSON: [{"question_number":1,"category":"章节","point_text":"知识点"}]`;
  return p;
}

export default router;
