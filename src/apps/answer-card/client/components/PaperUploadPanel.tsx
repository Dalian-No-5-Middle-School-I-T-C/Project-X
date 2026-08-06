import { useState, useEffect, useCallback } from "react";
import { KnowledgeTagList } from "./KnowledgeTagList";
import { BrainCircuit } from "lucide-react";
import { authFetch } from "../auth/api";
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

export function PaperUploadPanel({ cardId, open, onClose, hasExistingPaper, existingFilename, onUploaded }: Props) {
  const [filename, setFilename] = useState<string | null>(existingFilename || null);
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

  const loadPages = useCallback(async () => {
    try {
      const res = await authFetch(`/api/cards/${cardId}/paper/info`);
      if (res.ok) {
        const data = await res.json();
        setPages(data.pages || []);
        setFilename(data.filename || (data.pages && data.pages[0]?.filename) || null);
      }
    } catch { /* silent */ }
  }, [cardId]);

  // Reset when panel opens
  useEffect(() => {
    if (open) {
      setQuestionRange("all");
      setCustomRange("");
      setExtraNotes("");
      setUploadError(null);
      setAnalyzeError(null);
      setKnowledgePoints([]);
      void loadPages();
    }
  }, [open, loadPages]);

  if (!open) return null;

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          const compressed = await compressImageFile(file);
          formData.append("files", compressed, file.name.replace(/\.[^.]+$/, ".jpg"));
        } else {
          formData.append("files", file);
        }
      }

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
      setFilename(null);
      setPages([]);
      setKnowledgePoints([]);
    } catch {
      // ignore
    }
  };

  const handleAnalyze = async () => {
    if (analyzing) return;
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

      setKnowledgePoints(data.knowledgePoints || []);
    } catch (err: any) {
      setAnalyzeError(err.message || "分析失败");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const range = questionRange === "all" ? "全部" : customRange.trim();

      // Save question range + notes
      await authFetch(`/api/cards/${cardId}/paper/info`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionRange: range, extraNotes: extraNotes.trim() }),
      });

      // Save knowledge points
      if (knowledgePoints.length > 0) {
        const flatPoints = knowledgePoints.flatMap((q) =>
          q.points.map((p) => ({
            question_number: q.question_number,
            point_text: p,
          }))
        );

        await authFetch(`/api/cards/${cardId}/knowledge-points`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points: flatPoints }),
        });
      }

      onClose();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>原卷信息</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-6">
          {/* 导入文件区（支持多页） */}
          <section className="flex flex-col gap-2">
            <h4 className="m-0 text-base font-medium text-foreground">导入文件（支持多页）</h4>
            <UploadZone
              accept=".docx,.pdf,image/*"
              maxSize={50 * 1024 * 1024}
              multiple
              onFiles={handleFiles}
              disabled={uploading}
              label={uploading ? "上传中..." : "拖拽文件到此处，或点击选择（可多选多页）"}
              sublabel="DOCX / PDF / 图片，最大 50MB，可一次选择多页"
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
                        onClick={() => window.open(`/api/cards/${cardId}/paper?page=${p.pageIndex}`, "_blank")}
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
              disabled={pages.length === 0}
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
          <Button variant="outline" onClick={onClose}>关闭</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={pages.length === 0}
            onClick={() => void handleSave()}
          >
            {saving ? "保存中..." : "保存全部"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 前端压缩图片：Canvas resize max 2048px, JPEG 80%
 */
async function compressImageFile(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const maxDim = 2048;
      let w = img.width;
      let h = img.height;
      if (w > maxDim || h > maxDim) {
        const ratio = maxDim / Math.max(w, h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
          else reject(new Error("压缩失败"));
        },
        "image/jpeg",
        0.8
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("图片加载失败"));
    };
    img.src = objectUrl;
  });
}
