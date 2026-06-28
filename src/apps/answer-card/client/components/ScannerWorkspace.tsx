/// <reference types="vite/client" />

import { useState } from "react";
import { ArrowLeft, Camera, ClipboardCheck, Download, FolderOpen, ImagePlus } from "lucide-react";
import { fetchJson, urlWithToken } from "../auth/api";
import { ScannerPanel } from "./ScannerPanel";
import type { CombinedGradingBatchResult, CombinedGradingRow } from "../../../../shared/types";

interface Props {
  cardId: string;
  cardTitle: string;
  onBack: () => void;
}

const directoryInputProps = {
  webkitdirectory: "",
  directory: ""
} as Record<string, string>;

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|bmp|webp|tiff?)$/i.test(file.name);
}

function downloadCsv(rows: CombinedGradingRow[], cardId: string) {
  const header = ["文件名", "学号", "识别状态", "总分", "满分", "客观题得分", "主观题得分", "待复核题数", "异常数", "备注"];
  const lines = [
    header,
    ...rows.map((row) => [
      row.fileName,
      row.studentId ?? "未识别",
      row.recognitionStatus,
      String(row.totalScore),
      String(row.totalMaxScore),
      `${row.objectiveScore}/${row.objectiveMaxScore}`,
      `${row.subjectiveScore}/${row.subjectiveMaxScore}`,
      String(row.needsReviewCount),
      String(row.issueCount),
      row.message ?? ""
    ])
  ];
  const csv = lines.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `成绩表_${cardId}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ScannerWorkspace({ cardId, cardTitle, onBack }: Props) {
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");

  // ── File import states ──
  const [gradingFiles, setGradingFiles] = useState<File[]>([]);
  const [gradingResult, setGradingResult] = useState<CombinedGradingBatchResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  function addGradingFiles(files: FileList | null) {
    if (!files) return;
    const nextFiles = Array.from(files).filter(isImageFile);
    setGradingFiles((current) => {
      const seen = new Set(current.map((f) => `${f.name}_${f.size}_${f.lastModified}`));
      return [
        ...current,
        ...nextFiles.filter((f) => {
          const key = `${f.name}_${f.size}_${f.lastModified}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
      ];
    });
    if (nextFiles.length > 0) setStatus(`已加入 ${nextFiles.length} 张待阅卷图片`);
  }

  async function gradeAnswerCardFiles() {
    if (gradingFiles.length === 0) return;
    setIsBusy(true);
    setStatus("正在识别答题卡...");
    try {
      const form = new FormData();
      for (const file of gradingFiles) {
        form.append("files", file);
      }
      const result = await fetchJson<CombinedGradingBatchResult>(`/api/cards/${cardId}/grading`, {
        method: "POST",
        body: form
      });
      setGradingResult(result);
      const reviewCount = result.rows.reduce((sum, row) => sum + row.needsReviewCount, 0);
      setStatus(`阅卷完成：${result.rows.length} 张，${reviewCount} 题待复核`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "阅卷失败");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <main className="app-shell no-card-sidebar">
      <section className="workspace">
        <header className="topbar">
          <div>
            <h1 style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 16 }}>
              <button
                onClick={onBack}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  padding: 4, borderRadius: 6, color: "var(--muted)",
                  display: "flex", alignItems: "center"
                }}
              >
                <ArrowLeft size={18} />
              </button>
              <span style={{ fontWeight: 700 }}>{cardTitle}</span>
              <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 400 }}>ID:{cardId}</span>
            </h1>
            <p>扫描仪直扫或导入图片进行阅卷判分</p>
          </div>
        </header>

        <div className="main-grid grading-grid">
          {/* ── Main area: ScannerPanel or GradingResults ── */}
          <section className="preview-panel grading-results-panel">
            {scanning ? (
              <ScannerPanel
                cardId={cardId}
                onScansComplete={(sId, pageCount) => {
                  setStatus(`扫描完成：${pageCount} 张`);
                  setScanning(false);
                }}
                onClose={() => setScanning(false)}
              />
            ) : gradingResult ? (
              <GradingResultsInline
                result={gradingResult}
                onDownloadCsv={() => gradingResult && downloadCsv(gradingResult.rows, gradingResult.cardId)}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-secondary)" }}>
                <Camera size={48} style={{ marginBottom: 16, opacity: 0.3 }} />
                <p style={{ fontSize: 15 }}>开始扫描或导入图片进行阅卷</p>
                {status && <p style={{ fontSize: 13, marginTop: 8, color: "var(--brand)" }}>{status}</p>}
              </div>
            )}
          </section>

          {/* ── Sidebar: Scan settings + File import ── */}
          <aside className="inspector">
            {/* ── TWAIN Scanner ── */}
            <section className="panel">
              <div className="panel-title">
                <Camera size={17} /> 扫描仪直扫
              </div>
              <button
                className="primary-button wide-button"
                onClick={() => {
                  setScanning(true);
                  setGradingResult(null);
                  setStatus("");
                }}
                disabled={isBusy}
              >
                <Camera size={17} /> 开始扫描
              </button>
              <p className="hint" style={{ marginTop: 8 }}>连接扫描仪进行 TWAIN 直扫和自动识别</p>
            </section>

            {/* ── File Import ── */}
            <section className="panel">
              <div className="panel-title">
                <ImagePlus size={17} /> 导入阅卷
              </div>

              <div className="split-actions">
                <label className="upload-button">
                  <FolderOpen size={16} /> 导入目录
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    {...directoryInputProps}
                    onChange={(event) => {
                      addGradingFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <label className="upload-button">
                  <ImagePlus size={16} /> 导入图片
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      addGradingFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>

              <div className="file-queue" style={{ marginTop: 12 }}>
                <div>
                  <strong>{gradingFiles.length}</strong>
                  <span>张待阅卷图片</span>
                </div>
                {gradingFiles.length > 0 && (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => setGradingFiles([])}
                    style={{ fontSize: 12 }}
                  >
                    清空
                  </button>
                )}
              </div>

              {gradingFiles.length > 0 && (
                <div className="queued-files">
                  {gradingFiles.slice(0, 6).map((file) => (
                    <span key={`${file.name}_${file.size}_${file.lastModified}`}>
                      {file.webkitRelativePath || file.name}
                    </span>
                  ))}
                  {gradingFiles.length > 6 && <span>还有 {gradingFiles.length - 6} 张...</span>}
                </div>
              )}

              <button
                className="primary-button wide-button"
                style={{ marginTop: 12 }}
                onClick={() => void gradeAnswerCardFiles()}
                disabled={gradingFiles.length === 0 || isBusy}
              >
                <ClipboardCheck size={17} /> 开始识别判分
              </button>
            </section>

            {/* ── Status ── */}
            {status && (
              <section className="panel">
                <div className="panel-title">状态</div>
                <p style={{ fontSize: 13 }}>{status}</p>
              </section>
            )}
          </aside>
        </div>

        <footer className="statusbar">
          <span className="statusbar-message">{status}</span>
        </footer>
      </section>
    </main>
  );
}

// ── Inline GradingResults (simplified from App.tsx) ──
function GradingResultsInline({
  result,
  onDownloadCsv,
}: {
  result: CombinedGradingBatchResult | null;
  onDownloadCsv: () => void;
}) {
  if (!result || result.rows.length === 0) {
    return (
      <div className="grading-empty">
        <ClipboardCheck size={36} />
        <h2>等待阅卷</h2>
        <p>导入答题卡图片后开始识别。</p>
      </div>
    );
  }

  const totalReview = result.rows.reduce((sum, row) => sum + row.needsReviewCount, 0);
  const totalIssues = result.rows.reduce((sum, row) => sum + row.issueCount, 0);

  return (
    <div className="grading-results">
      <div className="grading-results-header">
        <div>
          <h2>成绩表</h2>
          <p>{result.rows.length} 张答题卡 / 待复核 {totalReview} 题 / 异常 {totalIssues} 处</p>
        </div>
        <button className="primary-button" type="button" onClick={onDownloadCsv} disabled={result.rows.length === 0}>
          <Download size={17} /> CSV
        </button>
      </div>
      <div className="score-table">
        <div className="score-table-head">
          <span>文件</span>
          <span>学号</span>
          <span>状态</span>
          <span>总分</span>
          <span>客观/主观</span>
          <span>复核</span>
          <span>答题卡</span>
        </div>
        {result.rows.map((row) => (
          <details className="score-row" key={`${row.fileName}_${row.recognition.imagePath ?? row.fileName}`}>
            <summary>
              <span title={row.fileName}>{row.fileName}</span>
              <span>{row.studentId ?? "未识别"}</span>
              <span className={row.recognitionStatus === "ok" && row.issueCount === 0 ? "status-ok" : "status-warn"}>
                {row.recognitionStatus}
              </span>
              <span>{row.totalScore}/{row.totalMaxScore}</span>
              <span>{row.objectiveScore}/{row.objectiveMaxScore} · {row.subjectiveScore}/{row.subjectiveMaxScore}</span>
              <span>{row.needsReviewCount}</span>
              <span>
                {row.previewUrl ? (
                  <button
                    className="score-preview-link"
                    onClick={(event) => {
                      event.stopPropagation();
                      const url = urlWithToken(row.previewUrl!);
                      window.open(url, "_blank");
                    }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--brand)", fontSize: 12, padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}
                  >
                    预览
                  </button>
                ) : (
                  <span className="muted-cell">-</span>
                )}
              </span>
            </summary>
            <div className="question-grade-list">
              {row.message && <p className="row-message">{row.message}</p>}
              {row.questions.length > 0 && <p className="grading-section-title">客观题</p>}
              {row.questions.map((question) => (
                <div className={`question-grade ${question.needsReview || question.status === "missing_key" ? "needs-review" : ""}`} key={question.questionNumber}>
                  <strong>{question.questionNumber}</strong>
                  <span>标准 {(question.correctOptions || []).join("")}</span>
                  <span>识别 {(question.selectedOptions || []).join("")}</span>
                  <span>{question.score}/{question.maxScore}</span>
                  <span>置信 {question.confidence.toFixed(3)}</span>
                  <em>{question.message ?? question.status}</em>
                </div>
              ))}
              {row.subjectiveQuestions.length > 0 && <p className="grading-section-title">主观题</p>}
              {row.subjectiveQuestions.map((question) => (
                <div className={`question-grade subjective-grade ${question.needsReview ? "needs-review" : ""}`} key={question.questionId}>
                  <strong>{question.questionNumber}</strong>
                  <span>有效 {question.validCells.map((cell) => cell.score).join("+") || "-"}</span>
                  <span>无效 {question.invalidCells.length}</span>
                  <span>{question.score}/{question.maxScore}</span>
                  <span>置信 {question.confidence.toFixed(3)}</span>
                  <em>{question.message ?? question.status}</em>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
