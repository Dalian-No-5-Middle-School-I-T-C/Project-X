/**
 * 问题反馈 API（#357）
 * 挂载点: /api/feedback
 * 表: feedback_reports / feedback_attachments
 * 权限: 全部 SYSTEM_MANAGE（主站管理员端）
 *
 * 反馈落在本系统数据库，不依赖 GitHub：扫卡室网络访问 GitHub 很慢，
 * 直连还需要把 token 放在学校服务器上。管理员在全局设置里查看，
 * 需要转发时一键复制成 Markdown 再贴到 issue。
 *
 * 附件：单次最多 15 个、单个 100 MiB，文件本体在
 * data/answer-card/feedback/<uuid>/，元数据在 feedback_attachments。
 */
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { getMysqlDb } from "../db";
import { databaseTimestamp } from "../db/timestamp";
import { resolveAnswerCardDataDir } from "../db/paths";
import { requestUploadBudget, isUploadAlreadyRejected } from "../lib/uploadBudget";
import { withFeedbackStorageQuota, FeedbackStorageQuotaError } from "../lib/feedbackStorage";
import { purgeStaleTmpUploads } from "../../apps/answer-card/server/paperQuota";
import {
  MAX_FEEDBACK_ATTACHMENTS,
  MAX_FEEDBACK_ATTACHMENT_BYTES,
  MAX_FEEDBACK_ATTACHMENTS_TOTAL_BYTES,
} from "../../shared/feedbackLimits";

const router = Router();
router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.SYSTEM_MANAGE));

const CATEGORIES = new Set(["problem", "suggestion", "other"]);
const MAX_TITLE = 100;
const MAX_CONTENT = 5000;
const MAX_CONTACT = 100;
const MAX_CONTEXT_BYTES = 8 * 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_FILENAME = 200;
const MAX_MIME = 150;

const dataRoot = resolveAnswerCardDataDir();
const feedbackRoot = path.join(dataRoot, "feedback");
const feedbackTmpDir = path.join(feedbackRoot, "_tmp");
const feedbackRootPrefix = `${path.resolve(feedbackRoot)}${path.sep}`;

type FeedbackRow = {
  id: number;
  category: string;
  title: string;
  content: string;
  contact: string | null;
  status: string;
  username: string;
  display_name: string;
  role_name: string;
  context_json: string | null;
  created_at: string;
  resolved_at: string | null;
  resolver_name: string | null;
};

type FeedbackAttachmentRow = {
  id: number;
  feedback_id: number;
  filename: string;
  mime: string | null;
  size_bytes: number | string;
};

type FeedbackAttachment = {
  id: number;
  filename: string;
  mime: string | null;
  sizeBytes: number;
};

/** 去掉 NUL 与控制字符（保留换行/制表），并按上限直接拒绝而不是静默截断。 */
function readText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function parsePositiveId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 客户端环境信息只收扁平标量，限制键名、数量和单值长度，避免反馈行被撑爆。 */
function sanitizeContext(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 30) break;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 500);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function buildContextJson(client: Record<string, unknown> | null, dialect: string): string {
  const server = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    database: dialect,
  };
  let json = JSON.stringify({ client, server });
  if (Buffer.byteLength(json, "utf8") > MAX_CONTEXT_BYTES) {
    json = JSON.stringify({ client: null, server, note: "客户端环境信息过大，已省略" });
  }
  return json;
}

/** SQLite 写 ISO（带 Z），MariaDB 的 DATETIME 是不带时区的服务器本地时间；
 *  返回给浏览器前补上时区，避免前端把服务器墙钟当成浏览器本地时间。 */
export function withTimezone(value: string | null, dialect: "sqlite" | "mariadb"): string | null {
  if (!value) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value;
  const iso = value.replace(" ", "T");
  if (dialect === "sqlite") return `${iso}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${iso}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function decodeMultipartFilename(name: string): string {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return Buffer.from(decoded, "utf8").toString("latin1") === name ? decoded : name;
  } catch {
    return name;
  }
}

function safeOriginalName(raw: string): string {
  const base = decodeMultipartFilename(raw).split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001F\u007F"]/g, "").trim();
  return (cleaned || "attachment").slice(0, MAX_FILENAME);
}

function safeExtension(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

function toAttachment(row: FeedbackAttachmentRow): FeedbackAttachment {
  return {
    id: Number(row.id),
    filename: row.filename,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
  };
}

function toReport(
  row: FeedbackRow,
  dialect: "sqlite" | "mariadb",
  attachments: FeedbackAttachment[] = []
) {
  let context: unknown = null;
  if (row.context_json) {
    try { context = JSON.parse(row.context_json); } catch { context = null; }
  }
  return {
    id: Number(row.id),
    category: row.category,
    title: row.title,
    content: row.content,
    contact: row.contact,
    status: row.status === "resolved" ? "resolved" : "open",
    username: row.username,
    displayName: row.display_name,
    roleName: row.role_name,
    context,
    createdAt: withTimezone(row.created_at, dialect),
    resolvedAt: withTimezone(row.resolved_at, dialect),
    resolvedByName: row.resolver_name,
    attachments,
  };
}

function resolveStoredPath(relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const abs = path.resolve(dataRoot, relative);
  return abs.startsWith(feedbackRootPrefix) ? abs : null;
}

async function removeTempFiles(files: unknown): Promise<void> {
  if (!Array.isArray(files)) return;
  await Promise.all(files.map(async (file) => {
    const filePath = (file as Express.Multer.File | undefined)?.path;
    if (filePath) await rm(filePath, { force: true }).catch(() => {});
  }));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await mkdir(feedbackTmpDir, { recursive: true });
        cb(null, feedbackTmpDir);
      } catch (err) {
        cb(err as Error, "");
      }
    },
    filename: (_req, _file, cb) => cb(null, `fb_${randomUUID()}`),
  }),
  limits: { fileSize: MAX_FEEDBACK_ATTACHMENT_BYTES, files: MAX_FEEDBACK_ATTACHMENTS },
});

const attachmentBudget = requestUploadBudget({
  maxTotalBytes: MAX_FEEDBACK_ATTACHMENTS_TOTAL_BYTES,
  label: "问题反馈附件上传",
});

/** JSON 请求直接放行；multipart 先过上传统计与 multer，再交给路由处理。 */
const receiveFeedbackUpload: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) {
    next();
    return;
  }
  void purgeStaleTmpUploads(feedbackTmpDir)
    .catch(() => {})
    .then(() => {
      attachmentBudget(req, res, () => {
        upload.array("files", MAX_FEEDBACK_ATTACHMENTS)(req, res, async (error) => {
          if (!error) {
            next();
            return;
          }
          await removeTempFiles(req.files);
          if (isUploadAlreadyRejected(req, res)) return;
          if (error instanceof multer.MulterError) {
            if (error.code === "LIMIT_FILE_SIZE") {
              res.status(413).json({
                ok: false,
                error: `单个附件不能超过 ${MAX_FEEDBACK_ATTACHMENT_BYTES / 1024 / 1024} MB`,
              });
              return;
            }
            if (error.code === "LIMIT_FILE_COUNT") {
              res.status(400).json({
                ok: false,
                error: `最多附加 ${MAX_FEEDBACK_ATTACHMENTS} 个文件`,
              });
              return;
            }
            res.status(400).json({ ok: false, error: `上传失败：${error.code}` });
            return;
          }
          next(error);
        });
      });
    })
    .catch(next);
};

const SELECT_COLUMNS = `f.id, f.category, f.title, f.content, f.contact, f.status,
  f.username, f.display_name, f.role_name, f.context_json,
  f.created_at, f.resolved_at, u.name AS resolver_name`;

// GET /api/feedback?status=open|resolved|all&limit=100&cursor=<lastId> — 列表
router.get("/", async (req, res) => {
  try {
    const requested = typeof req.query.status === "string" ? req.query.status : "all";
    const status = requested === "open" || requested === "resolved" ? requested : null;
    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit));
    const cursor = req.query.cursor === undefined ? null : parsePositiveId(req.query.cursor);
    if (req.query.cursor !== undefined && !cursor) {
      return res.status(400).json({ ok: false, error: "无效的分页游标" });
    }
    const db = getMysqlDb();
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (status) { conditions.push("f.status = ?"); params.push(status); }
    if (cursor) { conditions.push("f.id < ?"); params.push(cursor); }
    const rows = await db.all<FeedbackRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM feedback_reports f
         LEFT JOIN users u ON u.id = f.resolved_by
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY f.id DESC
        LIMIT ?`,
      ...params,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && page.length > 0 ? Number(page[page.length - 1].id) : null;

    const ids = page.map((row) => Number(row.id));
    const attachmentRows = ids.length > 0
      ? await db.all<FeedbackAttachmentRow>(
          `SELECT id, feedback_id, filename, mime, size_bytes
             FROM feedback_attachments
            WHERE feedback_id IN (${ids.map(() => "?").join(", ")})
            ORDER BY id`,
          ...ids
        )
      : [];
    const attachmentsByReport = new Map<number, FeedbackAttachment[]>();
    for (const row of attachmentRows) {
      const feedbackId = Number(row.feedback_id);
      const list = attachmentsByReport.get(feedbackId) ?? [];
      list.push(toAttachment(row));
      attachmentsByReport.set(feedbackId, list);
    }

    const counts = await db.get<{ total: number | string; open: number | string | null }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open
         FROM feedback_reports`
    );
    res.json({
      ok: true,
      data: page.map((row) => toReport(row, db.dialect, attachmentsByReport.get(Number(row.id)) ?? [])),
      counts: { total: Number(counts?.total ?? 0), open: Number(counts?.open ?? 0) },
      hasMore,
      nextCursor,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/feedback — 提交反馈（multipart 可带附件），自动附带服务端环境信息
router.post("/", receiveFeedbackUpload, async (req, res) => {
  const files = ((req.files as Express.Multer.File[] | undefined) ?? []).filter(Boolean);
  const fail = async (message: string, status = 400): Promise<void> => {
    await removeTempFiles(files);
    res.status(status).json({ ok: false, error: message });
  };

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = readText(body.title);
    const content = readText(body.content);
    const contact = readText(body.contact);
    const category = body.category === undefined ? "problem" : String(body.category);
    let rawContext = body.context;
    if (typeof rawContext === "string") {
      try { rawContext = JSON.parse(rawContext); } catch { rawContext = null; }
    }

    if (!title) { await fail("标题不能为空"); return; }
    if (title.length > MAX_TITLE) { await fail(`标题不能超过 ${MAX_TITLE} 字`); return; }
    if (!content) { await fail("详细描述不能为空"); return; }
    if (content.length > MAX_CONTENT) { await fail(`详细描述不能超过 ${MAX_CONTENT} 字`); return; }
    if (contact.length > MAX_CONTACT) { await fail(`联系方式不能超过 ${MAX_CONTACT} 字`); return; }
    if (!CATEGORIES.has(category)) { await fail("反馈类型无效"); return; }
    if (files.length > MAX_FEEDBACK_ATTACHMENTS) {
      await fail(`最多附加 ${MAX_FEEDBACK_ATTACHMENTS} 个文件`);
      return;
    }
    if (files.some((file) => file.size > MAX_FEEDBACK_ATTACHMENT_BYTES)) {
      await fail(`单个附件不能超过 ${MAX_FEEDBACK_ATTACHMENT_BYTES / 1024 / 1024} MB`, 413);
      return;
    }

    const storageKey = randomUUID();
    const finalDir = path.join(feedbackRoot, storageKey);
    const incomingBytes = files.reduce((sum, file) => sum + file.size, 0);
    try {
      const reportId = await withFeedbackStorageQuota(
        feedbackRoot,
        feedbackTmpDir,
        incomingBytes,
        async () => {
          const stored: Array<{ filename: string; storedPath: string; mime: string | null; sizeBytes: number }> = [];
          if (files.length > 0) await mkdir(finalDir, { recursive: true });
          for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            const originalName = safeOriginalName(file.originalname);
            const storedName = `${index}${safeExtension(originalName)}`;
            const target = path.join(finalDir, storedName);
            await rename(file.path, target);
            stored.push({
              filename: originalName,
              storedPath: path.relative(dataRoot, target).split(path.sep).join("/"),
              mime: file.mimetype ? file.mimetype.slice(0, MAX_MIME) : null,
              sizeBytes: file.size,
            });
          }

          const user = req.user!;
          const db = getMysqlDb();
          const now = databaseTimestamp();
          const contextJson = buildContextJson(sanitizeContext(rawContext), db.dialect);
          return db.transaction(async (tx) => {
            const result = await tx.run(
              `INSERT INTO feedback_reports
                 (user_id, username, display_name, role_name, category, title, content, contact, context_json, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
              user.id,
              user.username.slice(0, 100),
              user.name.slice(0, 100),
              user.role_name.slice(0, 32),
              category, title, content, contact || null, contextJson, now, now
            );
            const id = Number(result.lastInsertRowid);
            for (const attachment of stored) {
              await tx.run(
                `INSERT INTO feedback_attachments
                   (feedback_id, filename, stored_path, mime, size_bytes, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                id, attachment.filename, attachment.storedPath, attachment.mime, attachment.sizeBytes, now
              );
            }
            return id;
          });
        }
      );
      res.status(201).json({ ok: true, data: { id: reportId } });
    } catch (err) {
      await rm(finalDir, { recursive: true, force: true }).catch(() => {});
      await removeTempFiles(files);
      throw err;
    }
  } catch (err: any) {
    if (err instanceof FeedbackStorageQuotaError) {
      if (!res.headersSent) {
        res.status(413).json({ ok: false, code: err.code, error: err.message });
      }
      return;
    }
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/feedback/:id/attachments/:attachmentId — 下载附件（仅管理员）
router.get("/:id/attachments/:attachmentId", async (req, res) => {
  try {
    const feedbackId = parsePositiveId(req.params.id);
    const attachmentId = parsePositiveId(req.params.attachmentId);
    if (!feedbackId || !attachmentId) {
      return res.status(400).json({ ok: false, error: "无效的附件 ID" });
    }
    const row = await getMysqlDb().get<{ filename: string; stored_path: string }>(
      "SELECT filename, stored_path FROM feedback_attachments WHERE id = ? AND feedback_id = ?",
      attachmentId, feedbackId
    );
    if (!row) return res.status(404).json({ ok: false, error: "附件不存在" });
    const absPath = resolveStoredPath(row.stored_path);
    if (!absPath) return res.status(404).json({ ok: false, error: "附件不存在" });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.download(absPath, row.filename, (err) => {
      if (!err) return;
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ ok: false, error: "附件文件不存在" });
      } else {
        res.status(500).json({ ok: false, error: "附件下载失败" });
      }
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/feedback/:id — 标记已处理 / 重新打开
router.patch("/:id", async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "无效的反馈 ID" });
    const status = (req.body ?? {}).status;
    if (status !== "open" && status !== "resolved") {
      return res.status(400).json({ ok: false, error: "状态只能是 open 或 resolved" });
    }
    const db = getMysqlDb();
    const now = databaseTimestamp();
    const result = await db.run(
      `UPDATE feedback_reports
          SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ?
        WHERE id = ?`,
      status,
      status === "resolved" ? now : null,
      status === "resolved" ? req.user!.id : null,
      now,
      id
    );
    if (result.changes === 0) return res.status(404).json({ ok: false, error: "反馈不存在" });
    res.json({ ok: true, message: status === "resolved" ? "已标记为已处理" : "已重新打开" });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/feedback/:id — 删除反馈并清理附件文件
router.delete("/:id", async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "无效的反馈 ID" });
    const db = getMysqlDb();
    const attachments = await db.all<{ stored_path: string }>(
      "SELECT stored_path FROM feedback_attachments WHERE feedback_id = ?",
      id
    );
    const result = await db.run("DELETE FROM feedback_reports WHERE id = ?", id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: "反馈不存在" });

    const dirs = new Set<string>();
    for (const attachment of attachments) {
      const absPath = resolveStoredPath(attachment.stored_path);
      if (absPath) dirs.add(path.dirname(absPath));
    }
    for (const dir of dirs) {
      if (dir.startsWith(feedbackRootPrefix)) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    res.json({ ok: true, message: "反馈已删除" });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
