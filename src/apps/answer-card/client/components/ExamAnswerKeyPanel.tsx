// v53: 教师/管理员端「原卷与答案解析」配置面板（考试管理页打开）。
// 三件事：显示原卷开关（跟随考试保存）、上传本次正确答案并 OCR、逐题文字答案人工修正后保存。
// 只做文字：面板不判对错，也不与 question_scores 交互。
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileSearch, Plus, RefreshCw, Trash2 } from "lucide-react";
import { authFetch, fetchJson, mediaUrl } from "../auth/api";
import {
  Badge,
  Button,
  ControlRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  UploadZone,
} from "./ui/v2";

/** 与后端 exam-answer-key-routes 保持一致：题号上限、单页答案文本上限 */
const MAX_QUESTION_NUMBER = 200;
const MAX_ANSWER_TEXT_LENGTH = 500;
const PAGE_NONE = "__none__";

type PaperPage = { pageIndex: number; filename: string; mimeType: string; isImage: boolean };
type AnswerRow = { questionNumber: string; answerText: string; pageIndex: number | null };

type AnswerKeyPayload = {
  examId: number;
  examName: string | null;
  cardId: string | null;
  showOriginalPaper: number;
  scorePublished: number;
  hasOriginalPaper: boolean;
  paperPages: PaperPage[];
  answerPages: PaperPage[];
  answers: Array<{ questionNumber: number; answerText: string; pageIndex: number | null }>;
};

type OcrPageResult = {
  pageIndex: number;
  recognized?: boolean;
  drafts?: Array<{ questionNumber: number; answerText: string }>;
  error?: string;
};

interface Props {
  examId: number;
  examName: string;
  open: boolean;
  onClose: () => void;
  /** 开关写入成功后通知列表刷新，保证列表徽章与后端一致 */
  onExamChanged?: () => void;
}

function byQuestionNumber(a: AnswerRow, b: AnswerRow): number {
  return Number(a.questionNumber) - Number(b.questionNumber);
}

/** OCR 草稿并入编辑表：已有题号只在空白时填充，不覆盖教师手写的修正 */
function mergeDrafts(rows: AnswerRow[], drafts: Array<{ questionNumber: number; answerText: string }>): AnswerRow[] {
  const next = rows.map((row) => ({ ...row }));
  for (const draft of drafts) {
    const existing = next.find((row) => Number(row.questionNumber) === draft.questionNumber);
    if (existing) {
      if (!existing.answerText.trim()) existing.answerText = draft.answerText;
      continue;
    }
    next.push({ questionNumber: String(draft.questionNumber), answerText: draft.answerText, pageIndex: null });
  }
  return next.sort(byQuestionNumber);
}

export function ExamAnswerKeyPanel({ examId, examName, open, onClose, onExamChanged }: Props) {
  const [data, setData] = useState<AnswerKeyPayload | null>(null);
  const [rows, setRows] = useState<AnswerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [showPaper, setShowPaper] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [withOcr, setWithOcr] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [ocrBusyPage, setOcrBusyPage] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await fetchJson<AnswerKeyPayload>(`/api/exams/${examId}/answer-key`);
      setData(payload);
      setShowPaper(payload.showOriginalPaper === 1);
      setRows(payload.answers.map((a) => ({ questionNumber: String(a.questionNumber), answerText: a.answerText, pageIndex: a.pageIndex })));
      setSavedCount(payload.answers.length);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "加载答案配置失败");
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    if (!open) return;
    setPanelError(null);
    void load();
  }, [open, load]);

  /** 原卷页码是答案的归属坐标系（与 /api/scores/me/exams/:id/paper 的分页一致） */
  const paperPageOptions = useMemo(
    () => (data?.paperPages ?? []).map((page) => page.pageIndex),
    [data],
  );

  async function toggleShowPaper(next: boolean) {
    if (toggleBusy) return;
    setToggleBusy(true);
    setPanelError(null);
    const previous = showPaper;
    setShowPaper(next);
    try {
      await fetchJson(`/api/exams/${examId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showOriginalPaper: next }),
      });
      setData((cur) => (cur ? { ...cur, showOriginalPaper: next ? 1 : 0 } : cur));
      onExamChanged?.();
    } catch (err) {
      setShowPaper(previous);
      setPanelError(err instanceof Error ? err.message : "显示原卷开关保存失败");
    } finally {
      setToggleBusy(false);
    }
  }

  async function handleFiles(files: File[]) {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    setPanelError(null);
    try {
      const formData = new FormData();
      for (const file of files) formData.append("files", file);
      const res = await authFetch(`/api/exams/${examId}/answer-key/pages${withOcr ? "" : "?ocr=0"}`, {
        method: "POST",
        body: formData,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || "答案上传失败");
      setData((cur) => (cur ? { ...cur, answerPages: body.answerPages ?? cur.answerPages } : cur));
      const merged = (body.ocr as OcrPageResult[] | undefined) ?? [];
      const drafts = merged.flatMap((item) => item.drafts ?? []);
      if (drafts.length > 0) setRows((cur) => mergeDrafts(cur, drafts));
      const failed = (body.failed as Array<{ filename: string; error: string }> | undefined) ?? [];
      if (failed.length > 0) setPanelError(`部分文件未入库：${failed.map((f) => `${f.filename}（${f.error}）`).join("；")}`);
      const ocrErrors = merged.filter((item) => item.error).map((item) => `第 ${item.pageIndex} 页：${item.error}`);
      if (ocrErrors.length > 0) setPanelError(ocrErrors.join("；"));
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : "答案上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function reocrPage(pageIndex: number) {
    if (ocrBusyPage !== null) return;
    setOcrBusyPage(pageIndex);
    setPanelError(null);
    try {
      const res = await authFetch(`/api/exams/${examId}/answer-key/pages/${pageIndex}/ocr`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || "OCR 识别失败");
      const drafts = (body.drafts as Array<{ questionNumber: number; answerText: string }> | undefined) ?? [];
      if (drafts.length === 0) {
        setPanelError(`第 ${pageIndex} 页未识别出答案，请手动录入`);
        return;
      }
      setRows((cur) => mergeDrafts(cur, drafts));
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : "OCR 识别失败");
    } finally {
      setOcrBusyPage(null);
    }
  }

  async function deletePage(pageIndex: number) {
    setPanelError(null);
    try {
      const res = await authFetch(`/api/exams/${examId}/answer-key/pages/${pageIndex}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || "答案页删除失败");
      setData((cur) => (cur ? { ...cur, answerPages: body.answerPages ?? [] } : cur));
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : "答案页删除失败");
    }
  }

  function updateRow(index: number, patch: Partial<AnswerRow>) {
    setRows((cur) => cur.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function handleSave() {
    if (saving) return;
    const cleaned: Array<{ questionNumber: number; answerText: string; pageIndex: number | null }> = [];
    const seen = new Set<number>();
    for (const row of rows) {
      const text = row.answerText.trim();
      if (!text) {
        if (row.questionNumber.trim()) setPanelError(`第 ${row.questionNumber} 题答案为空，请填写或删除该行`);
        continue;
      }
      const questionNumber = Number(row.questionNumber);
      if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > MAX_QUESTION_NUMBER) {
        setPanelError(`无效题号：${row.questionNumber || "（空）"}，题号须为 1-${MAX_QUESTION_NUMBER} 的整数`);
        return;
      }
      if (seen.has(questionNumber)) {
        setPanelError(`题号重复：${questionNumber}`);
        return;
      }
      seen.add(questionNumber);
      cleaned.push({ questionNumber, answerText: text.slice(0, MAX_ANSWER_TEXT_LENGTH), pageIndex: row.pageIndex });
    }
    setPanelError(null);
    setSaving(true);
    try {
      const res = await fetchJson<{ saved: number; answers: AnswerKeyPayload["answers"] }>(`/api/exams/${examId}/answer-key`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: cleaned }),
      });
      setRows(res.answers.map((a) => ({ questionNumber: String(a.questionNumber), answerText: a.answerText, pageIndex: a.pageIndex })));
      setSavedCount(res.saved);
      setData((cur) => (cur ? { ...cur, answers: res.answers } : cur));
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : "保存答案失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next: boolean) => { if (!next && !saving && !uploading) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>原卷与答案解析 — {examName}</DialogTitle>
          <DialogDescription>
            学生只有在成绩已公布且「显示原卷」开启时才能看到原卷与逐题答案。答案只存文字、不判对错。
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-6">
          {loading && <p className="m-0 text-sm text-muted-foreground">加载中…</p>}
          {loadError && <p className="m-0 text-sm text-destructive-fg">{loadError}</p>}
          {panelError && <p className="m-0 text-sm text-destructive-fg">{panelError}</p>}

          {!loading && (
            <>
              {/* 显示原卷开关：跟随考试保存，默认关闭 */}
              <section className="flex flex-col gap-2">
                <ControlRow
                  reverse
                  htmlFor="show-original-paper"
                  label="显示原卷"
                  description={
                    data?.scorePublished === 1
                      ? "当前考试已公布，开启后学生立即可查看原卷与逐题答案。"
                      : "关闭后学生端不出现「查看原卷」入口；开启但未公布成绩时学生仍不可见。"
                  }
                  control={
                    <Switch
                      id="show-original-paper"
                      checked={showPaper}
                      disabled={toggleBusy}
                      onCheckedChange={(checked: boolean) => void toggleShowPaper(checked)}
                      aria-label="显示原卷"
                    />
                  }
                />
                <div className="flex items-center gap-2">
                  <Badge tone={data?.scorePublished === 1 ? "success" : "neutral"}>
                    {data?.scorePublished === 1 ? "成绩已公布" : "成绩未公布"}
                  </Badge>
                  <Badge tone={showPaper ? "info" : "neutral"}>{showPaper ? "原卷可见" : "原卷隐藏"}</Badge>
                </div>
              </section>

              {/* 原卷页（答题卡级资产，只读预览） */}
              <section className="flex flex-col gap-2">
                <h4 className="m-0 text-base font-medium text-foreground">原卷页</h4>
                {(data?.paperPages.length ?? 0) === 0 ? (
                  <p className="m-0 text-sm text-muted-foreground">原卷未上传。学生侧将显示「原卷未上传」，可在答题卡管理中上传原卷。</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {data?.paperPages.map((page) => (
                      <div key={page.pageIndex} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-secondary px-3 py-2.5">
                        <span className="truncate text-sm text-foreground">
                          第 <span className="tabular-nums">{page.pageIndex}</span> 页 · {page.filename}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<FileSearch />}
                          onClick={() => window.open(mediaUrl(`/api/cards/${data?.cardId}/paper?page=${page.pageIndex}`), "_blank", "noopener")}
                        >
                          查看
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 本次正确答案：上传 + OCR 草稿 */}
              <section className="flex flex-col gap-2">
                <h4 className="m-0 text-base font-medium text-foreground">本次正确答案（上传后可 OCR 识别，识别结果为草稿）</h4>
                <ControlRow
                  htmlFor="answer-key-ocr"
                  control={<Checkbox id="answer-key-ocr" checked={withOcr} onCheckedChange={(checked) => setWithOcr(checked === true)} />}
                  label="上传时自动 OCR 识别"
                  description="识别结果只填进下方表格，仍需教师核对后保存才对学生生效。"
                />
                <UploadZone
                  accept=".docx,.pdf,image/*"
                  maxSize={50 * 1024 * 1024}
                  multiple
                  onFiles={(files) => void handleFiles(files)}
                  disabled={uploading}
                  label={uploading ? "上传中…" : "拖拽答案文件到此处，或点击选择（可多选多页）"}
                  sublabel="DOCX / PDF / 图片，最大 50MB"
                />
                {(data?.answerPages.length ?? 0) > 0 && (
                  <div className="flex flex-col gap-2">
                    {data?.answerPages.map((page) => (
                      <div key={page.pageIndex} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-secondary px-3 py-2.5">
                        <span className="truncate text-sm text-foreground">
                          答案第 <span className="tabular-nums">{page.pageIndex}</span> 页 · {page.filename}
                        </span>
                        <div className="flex shrink-0 gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => window.open(mediaUrl(`/api/exams/${examId}/answer-key/pages/${page.pageIndex}/image`), "_blank", "noopener")}
                          >
                            预览
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<RefreshCw />}
                            loading={ocrBusyPage === page.pageIndex}
                            disabled={ocrBusyPage !== null}
                            onClick={() => void reocrPage(page.pageIndex)}
                          >
                            重新识别
                          </Button>
                          <Button size="sm" variant="ghost" className="text-destructive-fg" onClick={() => void deletePage(page.pageIndex)}>
                            删除
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 逐题文字答案编辑 */}
              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="m-0 text-base font-medium text-foreground">
                    逐题答案 <span className="tabular-nums text-muted-foreground">（{rows.length} 题）</span>
                  </h4>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Plus />}
                    onClick={() => setRows((cur) => [...cur, { questionNumber: "", answerText: "", pageIndex: null }].sort(byQuestionNumber))}
                  >
                    添加一题
                  </Button>
                </div>
                <p className="m-0 text-xs text-muted-foreground">
                  「归属页」决定答案渲染在哪张原卷图片下方；留空则归到最后一页，不会丢答案。
                </p>
                {rows.length === 0 ? (
                  <p className="m-0 py-4 text-center text-sm text-muted-foreground">还没有答案，可上传后 OCR，或点击「添加一题」手动录入。</p>
                ) : (
                  <div className="flex max-h-96 flex-col gap-2 overflow-auto pr-1">
                    {rows.map((row, index) => (
                      <div key={`${index}-${row.questionNumber}`} className="flex items-start gap-2">
                        <Input
                          className="w-20 shrink-0 tabular-nums"
                          inputMode="numeric"
                          value={row.questionNumber}
                          onChange={(event) => updateRow(index, { questionNumber: event.target.value.replace(/[^\d]/g, "") })}
                          placeholder="题号"
                          aria-label={`第 ${index + 1} 行的题号`}
                        />
                        <Input
                          className="min-w-0 flex-1"
                          value={row.answerText}
                          maxLength={MAX_ANSWER_TEXT_LENGTH}
                          onChange={(event) => updateRow(index, { answerText: event.target.value })}
                          placeholder="答案文字，如 B / x=2 / ①③"
                          aria-label={`第 ${row.questionNumber || index + 1} 题的答案`}
                        />
                        <Select
                          value={row.pageIndex == null ? PAGE_NONE : String(row.pageIndex)}
                          onValueChange={(value) => updateRow(index, { pageIndex: value === PAGE_NONE ? null : Number(value) })}
                          disabled={paperPageOptions.length === 0}
                        >
                          <SelectTrigger className="w-28 shrink-0" aria-label="归属原卷页">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={PAGE_NONE}>不指定</SelectItem>
                            {paperPageOptions.map((pageIndex) => (
                              <SelectItem key={pageIndex} value={String(pageIndex)}>第 {pageIndex} 页</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0 text-destructive-fg"
                          aria-label={`删除第 ${row.questionNumber || index + 1} 题`}
                          onClick={() => setRows((cur) => cur.filter((_, i) => i !== index))}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <span className="mr-auto text-xs text-muted-foreground">
            {savedCount !== null ? `已保存 ${savedCount} 题答案` : "尚未保存"}
          </span>
          <Button variant="outline" onClick={onClose} disabled={saving || uploading}>关闭</Button>
          <Button variant="primary" loading={saving} disabled={loading} onClick={() => void handleSave()}>
            保存答案
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
