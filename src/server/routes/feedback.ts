/**
 * 问题反馈 API（#357）
 * 挂载点: /api/feedback
 * 表: feedback_reports
 * 权限: 全部 SYSTEM_MANAGE（主站管理员端）
 *
 * 反馈落在本系统数据库，不依赖 GitHub：扫卡室网络访问 GitHub 很慢，
 * 直连还需要把 token 放在学校服务器上。管理员在全局设置里查看，
 * 需要转发时一键复制成 Markdown 再贴到 issue。
 */
import { Router } from "express";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { getMysqlDb } from "../db";
import { databaseTimestamp } from "../db/timestamp";

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

function toReport(row: FeedbackRow, dialect: "sqlite" | "mariadb") {
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
  };
}

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
    const counts = await db.get<{ total: number | string; open: number | string | null }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open
         FROM feedback_reports`
    );
    res.json({
      ok: true,
      data: page.map((row) => toReport(row, db.dialect)),
      counts: { total: Number(counts?.total ?? 0), open: Number(counts?.open ?? 0) },
      hasMore,
      nextCursor,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/feedback — 提交反馈，自动附带服务端环境信息
router.post("/", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = readText(body.title);
    const content = readText(body.content);
    const contact = readText(body.contact);
    const category = body.category === undefined ? "problem" : String(body.category);

    if (!title) return res.status(400).json({ ok: false, error: "标题不能为空" });
    if (title.length > MAX_TITLE) return res.status(400).json({ ok: false, error: `标题不能超过 ${MAX_TITLE} 字` });
    if (!content) return res.status(400).json({ ok: false, error: "详细描述不能为空" });
    if (content.length > MAX_CONTENT) return res.status(400).json({ ok: false, error: `详细描述不能超过 ${MAX_CONTENT} 字` });
    if (contact.length > MAX_CONTACT) return res.status(400).json({ ok: false, error: `联系方式不能超过 ${MAX_CONTACT} 字` });
    if (!CATEGORIES.has(category)) return res.status(400).json({ ok: false, error: "反馈类型无效" });

    const user = req.user!;
    const db = getMysqlDb();
    const now = databaseTimestamp();
    const contextJson = buildContextJson(sanitizeContext(body.context), db.dialect);
    const result = await db.run(
      `INSERT INTO feedback_reports
         (user_id, username, display_name, role_name, category, title, content, contact, context_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      user.id,
      user.username.slice(0, 100),
      user.name.slice(0, 100),
      user.role_name.slice(0, 32),
      category, title, content, contact || null, contextJson, now, now
    );
    res.status(201).json({ ok: true, data: { id: result.lastInsertRowid } });
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

// DELETE /api/feedback/:id — 删除反馈
router.delete("/:id", async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "无效的反馈 ID" });
    const result = await getMysqlDb().run("DELETE FROM feedback_reports WHERE id = ?", id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: "反馈不存在" });
    res.json({ ok: true, message: "反馈已删除" });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
