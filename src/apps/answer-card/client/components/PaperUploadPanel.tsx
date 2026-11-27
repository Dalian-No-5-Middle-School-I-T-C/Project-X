import { useState, useEffect } from "react";
import { KnowledgeTagList } from "./KnowledgeTagList";
import { BrainCircuit } from "lucide-react";
import { authFetch, fetchJson, mediaUrl } from "../auth/api";
import {
  Button,
  ControlRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  RadioGroup,
  RadioGroupItem,
  Textarea,
  UploadZone,
} from "./ui/v2";

interface Props {
  cardId: string;
  open: boolean;
  onClose: () => void;
  hasExistingPaper?: boolean;
  existingFilename?: string;
  onUploaded?: () => void;
}

interface KnowledgePointItem {
  question_number: number;
  points: string[];
}

interface PaperPage {
  pageIndex: number;
  filename: string;
}

type PaperInfo = { pages?: PaperPage[]; question_range?: string | null; extra_notes?: string | null };
type KnowledgePointResponse = { questionNumber?: number; question_number?: number; points: string[] };

function normalizeKnowledgePoints(items: KnowledgePointResponse[] | undefined): KnowledgePointItem[] {
  return (items ?? []).flatMap(item => {
    const number = item.question_number ?? item.questionNumber;
    return typeof number === "number" && Number.isFinite(number) && number > 0
      ? [{ question_number: number, points: item.points }]
      : [];
  });
}

export function PaperUploadPanel({ cardId, open, onClose, onUploaded }: Props) {
  const [pages, setPages] = useState<PaperPage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [questionRange, setQuestionRange] = useState<"all" | "custom">("all");
  const [customRange, setCustomRange] = useState("");
  const [extraNotes, setExtraNotes] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [knowledgePoints, setKnowledgePoints] = useState<KnowledgePointItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const cardUrl = `/api/cards/${cardId}`;

  async function loadPages() {
    const info = await fetchJson<PaperInfo>(`${cardUrl}/paper/info`);
    setPages(info.pages ?? []);
  }

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    setLoadError(null);
    setPages([]);
    setQuestionRange("all");
    setCustomRange("");
    setExtraNotes("");
    setUploadError(null);
    setAnalyzeError(null);
    setSaveError(null);
    setKnowledgePoints([]);

    void Promise.all([
      fetchJson<PaperInfo>(`${cardUrl}/paper/info`, { signal }),
      fetchJson<{ points: KnowledgePointResponse[] }>(`${cardUrl}/knowledge-points`, { signal }),
    ]).then(([info, saved]) => {
      if (signal.aborted) return;
      const range = info.question_range?.trim() ?? "";
      const custom = range !== "" && range !== "全部";
      setPages(info.pages ?? []);
      setQuestionRange(custom ? "custom" : "all");
      setCustomRange(custom ? range : "");
      setExtraNotes(info.extra_notes ?? "");
      setKnowledgePoints(normalizeKnowledgePoints(saved.points));
    }).catch((error) => {
      if (!signal.aborted) setLoadError(error instanceof Error ? error.message : "读取原卷信息失败");
    }).finally(() => {
      if (!signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open, cardUrl, loadAttempt]);

  if (!open) return null;

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      for (const file of files) formData.append("files", file);

      const res = await authFetch(`/api/cards/${cardId}/paper`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || err.message || "上传失败");
      }

      await loadPages();
      onUploaded?.();
    } catch (err: any) {
      setUploadError(err.message || "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const handleDeletePage = async (pageIndex: number) => {
    try {
      await authFetch(`/api/cards/${cardId}/paper/page/${pageIndex}`, { method: "DELETE" });
      await loadPages();
    } catch { /* ignore */ }
  };

  const handleDelete = async () => {
    try {
      await authFetch(`/api/cards/${cardId}/paper`, { method: "DELETE" });
      setPages([]);
    } catch {
      // ignore
    }
  };

  const handleAnalyze = async () => {
    if (analyzing || loading || loadError) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const range = questionRange === "all" ? "全部" : customRange.trim();
      if (!range) {
        setAnalyzeError("请输入题目范围");
        return;
      }

      const res = await authFetch(`/api/cards/${cardId}/knowledge-points/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionRange: range,
          extraNotes: extraNotes.trim(),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || err.error || "分析失败");
      }

      const data = await res.json();

      // Check if backend returned a placeholder (AI not fully implemented)
      if (data.message && data.knowledgePoints?.length === 0) {
        setAnalyzeError(data.message);
        return;
      }

      setKnowledgePoints(normalizeKnowledgePoints(data.knowledgePoints));
    } catch (err: any) {
      setAnalyzeError(err.message || "分析失败");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSave = async () => {
    if (saving || loading || loadError) return;
    const range = questionRange === "all" ? "全部" : customRange.trim();
    if (!range) { setSaveError("请填写自定义题目范围"); return; }
    setSaving(true);
    setSaveError(null);
    try {
      // Save question range + notes
      const infoRes = await authFetch(`/api/cards/${cardId}/paper/info`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionRange: range, extraNotes: extraNotes.trim() }),
      });
      if (!infoRes.ok) {
        const err = await infoRes.json().catch(() => ({} as { error?: string; message?: string }));
        throw new Error(err.error || err.message || "保存原卷信息失败");
      }

      // Save knowledge points
      if (knowledgePoints.length > 0) {
        const flatPoints = knowledgePoints.flatMap((q) =>
          q.points.map((p) => ({
            question_number: q.question_number,
            point_text: p,
          }))
        );

        const kpRes = await authFetch(`/api/cards/${cardId}/knowledge-points`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points: flatPoints }),
        });
        if (!kpRes.ok) {
          const err = await kpRes.json().catch(() => ({} as { error?: string; message?: string }));
          throw new Error(err.error || err.message || "保存知识点失败");
        }
      }

      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>原卷信息</DialogTitle>
          <p className="m-0 text-sm text-muted-foreground">原卷上传与知识点分析均为可选，不影响答题卡导出。可稍后再补充。</p>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-6">
          {loading && <p role="status" className="m-0 text-sm text-muted-foreground">正在读取原卷与知识点…</p>}
          {loadError && (
            <div className="flex items-center gap-2">
              <p role="alert" className="m-0 text-sm text-destructive-fg">读取原卷信息失败：{loadError}</p>
              <Button size="sm" variant="outline" onClick={() => setLoadAttempt(attempt => attempt + 1)}>重试加载</Button>
            </div>
          )}
          {/* 导入文件区（支持多页） */}
          <section className="flex flex-col gap-2">
            <h4 className="m-0 text-base font-medium text-foreground">导入文件</h4>
            <UploadZone
              accept=".docx,.pdf,.jpg,.jpeg,.png,.bmp,.tif,.tiff,.webp"
              maxSize={50 * 1024 * 1024}
              multiple
              onFiles={handleFiles}
              disabled={uploading || loading}
              label={uploading ? "上传中..." : "拖拽文件到此处，或点击选择"}
              sublabel="DOCX、PDF、JPEG、PNG、BMP、TIFF 或 WebP，单个文件最大 50MB"
            />
            {pages.length > 0 && (
              <div className="mt-1 flex flex-col gap-2">
                {pages.map((p) => (
                  <div
                    key={p.pageIndex}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-secondary px-3 py-2.5"
                  >
                    <span className="truncate text-sm text-foreground">
                      第 <span className="tabular-nums">{p.pageIndex}</span> 页 · {p.filename}
                    </span>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => window.open(mediaUrl(`${cardUrl}/paper?page=${p.pageIndex}`), "_blank", "noopener")}
                      >
                        查看
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive-fg"
                        onClick={() => void handleDeletePage(p.pageIndex)}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start text-destructive-fg"
                  onClick={() => void handleDelete()}
                >
                  删除全部原卷
                </Button>
              </div>
            )}
            {uploadError && <p className="m-0 text-xs text-destructive-fg">{uploadError}</p>}
          </section>

          {/* 题目范围 */}
          <section className="flex flex-col gap-2">
            <h4 className="m-0 text-base font-medium text-foreground">
              题目范围 <span className="text-destructive" aria-hidden>*</span>
            </h4>
            <RadioGroup
              value={questionRange}
              disabled={loading || !!loadError}
              onValueChange={(value) => setQuestionRange(value as "all" | "custom")}
            >
              <ControlRow
                htmlFor="paper-range-all"
                control={<RadioGroupItem id="paper-range-all" value="all" />}
                label="全部题目"
              />
              <ControlRow
                htmlFor="paper-range-custom"
                control={<RadioGroupItem id="paper-range-custom" value="custom" />}
                label="自定义范围"
              />
            </RadioGroup>
            {questionRange === "custom" && (
              <Input
                type="text"
                placeholder="如：第1-15题、选择题部分"
                aria-label="自定义题目范围"
                value={customRange}
                onChange={(e) => setCustomRange(e.target.value)}
              />
            )}
          </section>

          {/* 特别描述 */}
          <section className="flex flex-col gap-2">
            <h4 className="m-0 text-base font-medium text-foreground">特别描述（可选）</h4>
            <Textarea
              placeholder="如：本次考试重点考察力学综合运用能力..."
              aria-label="特别描述"
              value={extraNotes}
              disabled={loading || !!loadError}
              onChange={(e) => setExtraNotes(e.target.value)}
              rows={3}
            />
          </section>

          {/* AI 分析区 */}
          <section className="flex flex-col gap-2">
            <h4 className="m-0 text-base font-medium text-foreground">AI 知识点分析</h4>
            {analyzeError && <p className="m-0 text-xs text-destructive-fg">{analyzeError}</p>}
            <Button
              variant="primary"
              className="self-start"
              icon={<BrainCircuit />}
              loading={analyzing}
              disabled={loading || !!loadError || pages.length === 0}
              onClick={() => void handleAnalyze()}
            >
              {analyzing ? "分析中..." : "开始分析"}
            </Button>
            {knowledgePoints.length > 0 && (
              <div className="mt-1 flex flex-col gap-2">
                <KnowledgeTagList
                  questions={knowledgePoints}
                  onChange={setKnowledgePoints}
                  editable
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  loading={analyzing}
                  onClick={() => void handleAnalyze()}
                >
                  重新分析
                </Button>
              </div>
            )}
          </section>
        </DialogBody>

        {/* 底部按钮 */}
        <DialogFooter>
          {saveError && <p className="m-0 mr-auto text-xs text-destructive-fg">{saveError}</p>}
          <Button variant="outline" onClick={onClose}>关闭</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={loading || !!loadError || pages.length === 0}
            onClick={() => void handleSave()}
          >
            {saving ? "保存中..." : "保存全部"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
