import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { DragDropZone } from "./DragDropZone";
import { KnowledgeTagList } from "./KnowledgeTagList";
import { BrainCircuit, X } from "lucide-react";
import { authFetch } from "../auth/api";

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

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="paper-upload-panel">
        <div className="paper-upload-header">
          <h3>原卷信息</h3>
          <button className="modal-close-btn" aria-label="关闭原卷信息" onClick={onClose}><X size={16} /></button>
        </div>

        {/* 导入文件区（支持多页） */}
        <div className="paper-section">
          <h4>导入文件（支持多页）</h4>
          <DragDropZone
            accept=".docx,.pdf,image/*"
            maxSize={50 * 1024 * 1024}
            multiple
            onFiles={handleFiles}
            disabled={uploading}
            label={uploading ? "上传中..." : "拖拽文件到此处，或点击选择（可多选多页）"}
            sublabel="DOCX / PDF / 图片，最大 50MB，可一次选择多页"
          />
          {pages.length > 0 && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              {pages.map((p) => (
                <div
                  key={p.pageIndex}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 12px",
                    background: "var(--color-background-secondary)",
                    borderRadius: 8,
                    border: "0.5px solid var(--color-border-tertiary)",
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 13 }}>第 {p.pageIndex} 页 · {p.filename}</span>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button className="ghost-button" onClick={() => window.open(`/api/cards/${cardId}/paper?page=${p.pageIndex}`, "_blank")}>查看</button>
                    <button className="ghost-button danger" onClick={() => void handleDeletePage(p.pageIndex)}>删除</button>
                  </div>
                </div>
              ))}
              <button className="ghost-button danger" onClick={() => void handleDelete()} style={{ alignSelf: "flex-start", marginTop: 4 }}>
                删除全部原卷
              </button>
            </div>
          )}
          {uploadError && <p className="field-error">{uploadError}</p>}
        </div>

        {/* 题目范围 */}
        <div className="paper-section">
          <h4>题目范围 *</h4>
          <label className="radio-label">
            <input
              type="radio"
              name="range"
              checked={questionRange === "all"}
              onChange={() => setQuestionRange("all")}
            />
            全部题目
          </label>
          <label className="radio-label">
            <input
              type="radio"
              name="range"
              checked={questionRange === "custom"}
              onChange={() => setQuestionRange("custom")}
            />
            自定义范围
          </label>
          {questionRange === "custom" && (
            <input
              type="text"
              className="text-input"
              placeholder="如：第1-15题、选择题部分"
              value={customRange}
              onChange={(e) => setCustomRange(e.target.value)}
            />
          )}
        </div>

        {/* 特别描述 */}
        <div className="paper-section">
          <h4>特别描述（可选）</h4>
          <textarea
            className="textarea-input"
            placeholder="如：本次考试重点考察力学综合运用能力..."
            value={extraNotes}
            onChange={(e) => setExtraNotes(e.target.value)}
            rows={3}
          />
        </div>

        {/* AI 分析区 */}
        <div className="paper-section">
          <h4>AI 知识点分析</h4>
          {analyzeError && <p className="field-error">{analyzeError}</p>}
          <button
            className="primary-button"
            onClick={handleAnalyze}
            disabled={analyzing || pages.length === 0}
          >
            <BrainCircuit size={16} /> {analyzing ? "分析中..." : "开始分析"}
          </button>
          {knowledgePoints.length > 0 && (
            <div style={{ marginTop: "12px" }}>
              <KnowledgeTagList
                questions={knowledgePoints}
                onChange={setKnowledgePoints}
                editable
              />
              <button
                className="ghost-button"
                onClick={handleAnalyze}
                disabled={analyzing}
                style={{ marginTop: "8px" }}
              >
                重新分析
              </button>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="paper-upload-footer">
          <button className="ghost-button" onClick={onClose}>关闭</button>
          <button
            className="primary-button"
            onClick={handleSave}
            disabled={saving || pages.length === 0}
          >
            {saving ? "保存中..." : "保存全部"}
          </button>
        </div>
      </div>
    </div>,
    document.body
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
