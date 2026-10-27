import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Download,
  MessageSquareWarning,
  Paperclip,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { fetchJson } from "../auth/api";
import { ROLE_LABELS } from "../auth/types";
import { cn } from "../lib/utils";
import { downloadBlob } from "../util/download";
import { MAX_FEEDBACK_ATTACHMENTS, MAX_FEEDBACK_ATTACHMENT_BYTES } from "../../../../shared/feedbackLimits";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  UploadZone,
} from "./ui/v2";

type FeedbackCategory = "problem" | "suggestion" | "other";
type FeedbackStatus = "open" | "resolved";
type FeedbackFilter = "all" | FeedbackStatus;

type FeedbackAttachment = {
  id: number;
  filename: string;
  mime: string | null;
  sizeBytes: number;
};

type FeedbackReport = {
  id: number;
  category: FeedbackCategory;
  title: string;
  content: string;
  contact: string | null;
  status: FeedbackStatus;
  username: string;
  displayName: string;
  roleName: string;
  context: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  attachments: FeedbackAttachment[];
};

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  problem: "问题",
  suggestion: "建议",
  other: "其他",
};

const MAX_TITLE = 100;
const MAX_CONTENT = 5000;
const MAX_CONTACT = 100;

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 提交时自动附带的环境信息。不收集任何成绩、学生或凭据数据。 */
function collectContext(): Record<string, unknown> {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; architecture?: string; bitness?: string };
  };
  try {
    return {
      appVersion: import.meta.env.VITE_APP_VERSION,
      page: window.location.pathname + window.location.search,
      userAgent: navigator.userAgent,
      platform: nav.userAgentData?.platform ?? navigator.platform,
      architecture: nav.userAgentData?.architecture ?? null,
      bitness: nav.userAgentData?.bitness ?? null,
      language: navigator.language,
      screen: `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x`,
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      electron: navigator.userAgent.includes("Electron"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      submittedAt: new Date().toISOString(),
    };
  } catch {
    return { appVersion: import.meta.env.VITE_APP_VERSION, page: window.location.pathname };
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Electron 壳对剪贴板权限可能默认拒绝，落到下面的 textarea 回退
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

/** 复制成可直接贴进 GitHub issue 的 Markdown，方便管理员在网络方便时转发。 */
function formatAsMarkdown(report: FeedbackReport): string {
  const lines = [
    `### ${report.title}`,
    "",
    `- 类型：${CATEGORY_LABELS[report.category] ?? report.category}`,
    `- 提交人：${report.displayName || report.username || "未知"}（${ROLE_LABELS[report.roleName] || report.roleName || "未知角色"}）`,
    `- 提交时间：${formatTime(report.createdAt)}`,
    `- 联系方式：${report.contact || "未填写"}`,
    "",
    report.content,
  ];
  if (report.context) {
    lines.push("", "<details><summary>环境信息</summary>", "", "```json", JSON.stringify(report.context, null, 2), "```", "</details>");
  }
  if (report.attachments.length > 0) {
    lines.push("", `- 附件：${report.attachments.map((file) => `${file.filename}（${formatFileSize(file.sizeBytes)}）`).join("、")}`);
  }
  return lines.join("\n");
}

function Banner({ tone, children }: { tone: "success" | "error"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 rounded-md border px-3 py-2 text-sm",
        tone === "success"
          ? "border-border bg-secondary text-foreground"
          : "border-destructive-border bg-secondary text-destructive-fg"
      )}
    >
      {tone === "success" ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> : <AlertTriangle size={15} className="mt-0.5 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function FeedbackSection({ mode = "admin" }: { mode?: "admin" | "mine" }) {
  const isAdminMode = mode === "admin";
  const endpoint = isAdminMode ? "/api/feedback" : "/api/feedback/mine";
  const [reports, setReports] = useState<FeedbackReport[]>([]);
  const [counts, setCounts] = useState({ total: 0, open: 0 });
  const [filter, setFilter] = useState<FeedbackFilter>("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>("problem");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formMsg, setFormMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FeedbackReport | null>(null);
  const loadSeq = useRef(0);
  const filterRef = useRef(filter);

  const load = useCallback(async (reset = true, cursor?: number) => {
    // 筛选快速切换时只让最新一次请求提交结果；重载时读取当前筛选，避免 PATCH/DELETE
    // 在筛选已变化后还按旧筛选发起请求。
    const seq = ++loadSeq.current;
    const activeFilter = filterRef.current;
    if (reset) {
      setLoading(true);
      setLoadingMore(false);
      setNextCursor(null);
      setReports([]);
    } else {
      setLoadingMore(true);
    }
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (activeFilter !== "all") params.set("status", activeFilter);
      if (cursor !== undefined) params.set("cursor", String(cursor));
      const res = await fetchJson<{
        ok: boolean;
        data: FeedbackReport[];
        counts: { total: number; open: number };
        nextCursor: number | null;
      }>(`${endpoint}?${params.toString()}`);
      if (seq !== loadSeq.current) return;
      setReports((prev) => (reset ? res.data : [...prev, ...res.data]));
      setCounts(res.counts ?? { total: 0, open: 0 });
      setNextCursor(typeof res.nextCursor === "number" ? res.nextCursor : null);
    } catch (err: any) {
      if (seq !== loadSeq.current) return;
      if (reset) setReports([]);
      setLoadError(err?.message || "反馈列表加载失败");
    } finally {
      if (seq === loadSeq.current) {
        if (reset) {
          setLoading(false);
          setLoadingMore(false);
        } else {
          setLoadingMore(false);
        }
      }
    }
  }, [endpoint]);

  useEffect(() => {
    filterRef.current = filter;
    void load(true);
  }, [filter, load]);

  const resetForm = () => {
    setCategory("problem");
    setTitle("");
    setContent("");
    setContact("");
    setAttachments([]);
  };

  const addAttachments = (files: File[]) => {
    setFormMsg(null);
    const tooLarge = files.find((file) => file.size > MAX_FEEDBACK_ATTACHMENT_BYTES);
    if (tooLarge) {
      setFormMsg({ tone: "error", text: `${tooLarge.name} 超过 ${MAX_FEEDBACK_ATTACHMENT_BYTES / 1024 / 1024} MB` });
      return;
    }
    if (attachments.length + files.length > MAX_FEEDBACK_ATTACHMENTS) {
      setFormMsg({ tone: "error", text: `最多附加 ${MAX_FEEDBACK_ATTACHMENTS} 个文件` });
      return;
    }
    setAttachments((prev) => [...prev, ...files]);
  };

  async function submitFeedback(event: FormEvent) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (!trimmedTitle) {
      setFormMsg({ tone: "error", text: "请填写标题" });
      return;
    }
    if (!trimmedContent) {
      setFormMsg({ tone: "error", text: "请填写详细描述" });
      return;
    }
    setSubmitting(true);
    setFormMsg(null);
    try {
      const form = new FormData();
      form.set("category", category);
      form.set("title", trimmedTitle);
      form.set("content", trimmedContent);
      if (contact.trim()) form.set("contact", contact.trim());
      form.set("context", JSON.stringify(collectContext()));
      for (const file of attachments) form.append("files", file, file.name);
      await fetchJson<{ ok: boolean; data: { id: number } }>("/api/feedback", {
        method: "POST",
        body: form,
      });
      resetForm();
      setFormMsg({
        tone: "success",
        text: isAdminMode
          ? "已提交。反馈保存在本系统数据库，管理员可在下方查看和处理。"
          : "已提交。管理员处理后可在这里查看状态。",
      });
      if (filterRef.current !== "all") setFilter("all");
      else await load(true);
    } catch (err: any) {
      setFormMsg({ tone: "error", text: err?.message || "提交失败" });
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleStatus(report: FeedbackReport) {
    setBusyId(report.id);
    setLoadError(null);
    try {
      const next: FeedbackStatus = report.status === "open" ? "resolved" : "open";
      await fetchJson(`/api/feedback/${report.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      await load(true);
    } catch (err: any) {
      setLoadError(err?.message || "操作失败");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteReport(report: FeedbackReport) {
    setBusyId(report.id);
    setLoadError(null);
    try {
      await fetchJson(`/api/feedback/${report.id}`, { method: "DELETE" });
      if (expandedId === report.id) setExpandedId(null);
      setPendingDelete(null);
      await load(true);
    } catch (err: any) {
      setLoadError(err?.message || "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  async function copyReport(report: FeedbackReport) {
    const ok = await copyText(formatAsMarkdown(report));
    if (!ok) {
      setLoadError("复制失败：浏览器拒绝了剪贴板访问，请展开详情手动复制");
      return;
    }
    setCopiedId(report.id);
    setTimeout(() => setCopiedId((current) => (current === report.id ? null : current)), 2000);
  }

  async function downloadAttachment(reportId: number, attachment: FeedbackAttachment) {
    setLoadError(null);
    try {
      await downloadBlob(
        `/api/feedback/${reportId}/attachments/${attachment.id}`,
        attachment.filename
      );
    } catch (err: any) {
      setLoadError(err?.message || "附件下载失败");
    }
  }

  const totalAttachmentBytes = attachments.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className={cn("flex flex-col gap-3", isAdminMode && "border-t border-border-subtle pt-5")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <MessageSquareWarning size={15} className="shrink-0" />
          {isAdminMode ? "问题反馈" : "我的反馈"}
        </div>
        <Button
          variant={formOpen ? "outline" : "primary"}
          size="sm"
          onClick={() => {
            setFormOpen((open) => !open);
            setFormMsg(null);
          }}
        >
          {formOpen ? "收起表单" : "＋ 提交反馈"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {isAdminMode
          ? `扫卡室或教室遇到问题时在这里提交，会自动带上版本、页面与系统信息；可附带最多 ${MAX_FEEDBACK_ATTACHMENTS} 个文件（单个小于 ${MAX_FEEDBACK_ATTACHMENT_BYTES / 1024 / 1024} MB）。反馈保存在本系统数据库，不依赖 GitHub。管理员可在下方查看、标记处理，需要转发时一键复制成 Markdown。`
          : `遇到问题时在这里提交，会自动带上版本、页面与系统信息；可附带最多 ${MAX_FEEDBACK_ATTACHMENTS} 个文件（单个小于 ${MAX_FEEDBACK_ATTACHMENT_BYTES / 1024 / 1024} MB）。管理员处理后可在这里查看状态和附件。`}
      </p>

      {formOpen && (
        <form
          onSubmit={(event) => void submitFeedback(event)}
          className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-secondary p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="类型">
              <Select value={category} onValueChange={(value) => setCategory(value as FeedbackCategory)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="problem">问题</SelectItem>
                  <SelectItem value="suggestion">建议</SelectItem>
                  <SelectItem value="other">其他</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="联系方式（可选）" hint="邮箱、电话或微信，仅管理员可见">
              <Input
                value={contact}
                maxLength={MAX_CONTACT}
                onChange={(event) => setContact(event.target.value)}
                placeholder="方便回访时填写"
              />
            </Field>
          </div>
          <Field label="标题" required hint={`${title.length}/${MAX_TITLE}`}>
            <Input
              value={title}
              maxLength={MAX_TITLE}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="一句话说明问题，例如：导入 PDF 后第 2 页答题卡错位"
            />
          </Field>
          <Field label="详细描述" required hint={`${content.length}/${MAX_CONTENT} · 请写清操作步骤、实际现象和期望结果`}>
            <Textarea
              value={content}
              maxLength={MAX_CONTENT}
              rows={6}
              onChange={(event) => setContent(event.target.value)}
              placeholder={"操作步骤：\n1. \n2. \n\n实际现象：\n\n期望结果："}
            />
          </Field>
          <Field
            label="附件（可选）"
            hint={`最多 ${MAX_FEEDBACK_ATTACHMENTS} 个，单个小于 ${MAX_FEEDBACK_ATTACHMENT_BYTES / 1024 / 1024} MB${attachments.length > 0 ? ` · 已选 ${attachments.length} 个，共 ${formatFileSize(totalAttachmentBytes)}` : ""}`}
          >
            <UploadZone
              accept=""
              multiple
              maxSize={0}
              onFiles={addAttachments}
              label="点击或拖拽添加附件"
              sublabel="日志、截图、PDF、压缩包等"
              size="sm"
              disabled={submitting}
            />
          </Field>
          {attachments.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {attachments.map((file, index) => (
                <div
                  key={`${file.name}-${file.size}-${index}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-card px-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs text-foreground">
                    <Paperclip size={14} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{file.name}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`移除 ${file.name}`}
                      onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <X size={14} />
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {attachments.length > 0
                ? "附件较大时上传需要一些时间，请勿关闭页面。"
                : "自动附带：当前页面、浏览器与操作系统、屏幕信息、版本号、服务端运行环境"}
            </span>
            <Button type="submit" variant="primary" size="sm" loading={submitting}>
              {submitting ? "提交中..." : "提交反馈"}
            </Button>
          </div>
          {formMsg && <Banner tone={formMsg.tone}>{formMsg.text}</Banner>}
        </form>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          共 {counts.total} 条 · 待处理 {counts.open} 条
        </span>
        <SegmentedControl
          value={filter}
          onValueChange={(value) => {
            filterRef.current = value as FeedbackFilter;
            setFilter(value as FeedbackFilter);
          }}
          items={[
            { value: "all", label: "全部" },
            { value: "open", label: "待处理" },
            { value: "resolved", label: "已处理" },
          ]}
          size="sm"
          aria-label="反馈状态筛选"
        />
      </div>

      {loadError && <Banner tone="error">{loadError}</Banner>}

      {loading ? (
        <p className="text-xs text-muted-foreground">加载中...</p>
      ) : reports.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {filter === "all" ? "暂无反馈。" : filter === "open" ? "没有待处理的反馈。" : "还没有已处理的反馈。"}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {reports.map((report) => {
            const expanded = expandedId === report.id;
            const roleLabel = ROLE_LABELS[report.roleName] ?? report.roleName ?? "";
            return (
              <div key={report.id} className="rounded-lg border border-border-subtle bg-secondary p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={report.status === "open" ? "warning" : "success"} dot>
                        {report.status === "open" ? "待处理" : "已处理"}
                      </Badge>
                      <Badge tone="neutral">{CATEGORY_LABELS[report.category] ?? report.category}</Badge>
                      <span className="min-w-0 break-words text-sm font-medium text-foreground">{report.title}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <span>{report.displayName || report.username || "未知用户"}{roleLabel ? `（${roleLabel}）` : ""}</span>
                      <span aria-hidden>·</span>
                      <span className="tabular-nums">{formatTime(report.createdAt)}</span>
                      {report.attachments.length > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="inline-flex items-center gap-1">
                            <Paperclip size={12} />
                            {report.attachments.length} 个附件
                          </span>
                        </>
                      )}
                      {report.status === "resolved" && report.resolvedAt && (
                        <>
                          <span aria-hidden>·</span>
                          <span>
                            {report.resolvedByName ? `由 ${report.resolvedByName} 于 ` : "于 "}
                            {formatTime(report.resolvedAt)} 标记处理
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpandedId(expanded ? null : report.id)}
                    >
                      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      {expanded ? "收起" : "详情"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void copyReport(report)}>
                      {copiedId === report.id ? <Check size={14} /> : <ClipboardCopy size={14} />}
                      {copiedId === report.id ? "已复制" : "复制"}
                    </Button>
                    {isAdminMode && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === report.id}
                          onClick={() => void toggleStatus(report)}
                        >
                          {report.status === "open" ? <Check size={14} /> : <RotateCcw size={14} />}
                          {report.status === "open" ? "标记已处理" : "重新打开"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive-fg"
                          disabled={busyId === report.id}
                          onClick={() => setPendingDelete(report)}
                        >
                          <Trash2 size={14} />
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {!expanded && (
                  <p className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-sm text-secondary-foreground">
                    {report.content}
                  </p>
                )}

                {expanded && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3">
                    <p className="whitespace-pre-wrap break-words text-sm text-foreground">{report.content}</p>
                    <p className="text-xs text-muted-foreground">
                      联系方式：{report.contact || "未填写"}
                    </p>
                    {report.attachments.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <div className="text-xs font-medium text-muted-foreground">附件（{report.attachments.length}）</div>
                        {report.attachments.map((attachment) => (
                          <button
                            key={attachment.id}
                            type="button"
                            onClick={() => void downloadAttachment(report.id, attachment)}
                            className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-card px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-secondary"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <Paperclip size={14} className="shrink-0 text-muted-foreground" />
                              <span className="truncate">{attachment.filename}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                              {formatFileSize(attachment.sizeBytes)}
                              <Download size={14} />
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    {report.context && (
                      <details className="rounded-md border border-border-subtle bg-card px-3 py-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground">环境信息</summary>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
                          {JSON.stringify(report.context, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && nextCursor !== null && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            loading={loadingMore}
            onClick={() => void load(false, nextCursor)}
          >
            加载更多
          </Button>
        </div>
      )}

      {isAdminMode && (
        <ConfirmDialog
          open={pendingDelete !== null}
          onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
          title="删除反馈"
          description={`确认删除反馈「${pendingDelete?.title ?? ""}」？删除后不可恢复。`}
          confirmLabel="删除"
          tone="danger"
          loading={pendingDelete !== null && busyId === pendingDelete.id}
          onConfirm={() => { if (pendingDelete) void deleteReport(pendingDelete); }}
        />
      )}
    </div>
  );
}
