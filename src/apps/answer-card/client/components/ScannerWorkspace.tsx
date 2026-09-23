/// <reference types="vite/client" />

import { useState } from "react";
import {
  ArrowLeft,
  Camera,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Database,
  Download,
  FolderOpen,
  Globe,
  ImagePlus,
  Upload as UploadIcon,
} from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import { getScannerMode, isRemoteServerConfigured, readServerUrl, useScannerMode } from "../lib/scannerMode";
import { downloadGradingCsv } from "../lib/gradingCsv";
import { scannerUploadManager } from "../lib/scannerUploadManager";
import { ScannerPanel } from "./ScannerPanel";
import { ServerConfigDialog } from "./ServerConfigDialog";
import { ServerStatusIndicator } from "./ServerStatusIndicator";
import { SkinSwitcher } from "./SkinSwitcher";
import type { AnswerCard, CombinedGradingBatchResult, CombinedGradingRow } from "../../../../shared/types";
import { buildLayout } from "../../../../shared/layout";
import { mapImportedScanPages } from "../../../../shared/scanPages";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
  SegmentedControl,
} from "./ui/v2";

interface Props {
  cardId: string;
  cardTitle: string;
  onBack: () => void;
  /** v2.5.0: 受控皮肤（由 ScannerApp 下发；未传时不渲染切换器，保持组件独立可用） */
  skin?: string;
  onSkinChange?: (skin: string) => void;
}

const directoryInputProps = {
  webkitdirectory: "",
  directory: ""
} as Record<string, string>;

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|bmp|webp|tiff?)$/i.test(file.name);
}

export function ScannerWorkspace({ cardId, cardTitle, onBack, skin, onSkinChange }: Props) {
  const [cfgOpen, setCfgOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");

  // ── File import states ──
  const [gradingFiles, setGradingFiles] = useState<File[]>([]);
  const [gradingResult, setGradingResult] = useState<CombinedGradingBatchResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  // v2.5.1: 导入阅卷的图片去向档位（与直扫面板共用同一记忆，hook 内置跨实例同步）
  // v2.5.6: 提升为工作台级常驻选择器（见侧栏「图片去向」卡），直扫与导入共用同一份状态
  const [imageMode, setImageMode] = useScannerMode();

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
    // v2.5.1: remote 档位时图片同时后台排队上传（不阻塞判分）
    let uploadQueued = false;
    let serverUnconfigured = false;
    try {
      if (getScannerMode() === "remote") {
        if (isRemoteServerConfigured()) {
          const card = await fetchJson<AnswerCard>(`/api/cards/${encodeURIComponent(cardId)}`);
          const pages = mapImportedScanPages(gradingFiles.length, buildLayout(card).pages.length, card.sided);
          scannerUploadManager.startUpload({
            kind: "import",
            cardId,
            name: `导入_${cardTitle}_${new Date().toISOString().slice(0, 10)}`,
            paperSize: card.paper.size,
            pages: gradingFiles.map((file, i) => ({
              ...pages[i],
              getBlob: () => Promise.resolve(file),
            })),
          });
          uploadQueued = true;
        } else {
          serverUnconfigured = true;
        }
      }
      setStatus("正在识别答题卡...");
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
      setStatus(
        `阅卷完成：${result.rows.length} 张，${reviewCount} 题待复核${uploadQueued ? "；图片已后台排队上传到服务器" : ""}${serverUnconfigured ? "；未配置服务器地址，本次仅本地判分" : ""}`,
      );
    } catch (err) {
      setStatus(`${err instanceof Error ? err.message : "阅卷失败"}${serverUnconfigured ? "；未配置服务器地址，仅本地判分" : ""}`);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <main className="paper-grid flex h-screen min-w-0 flex-col overflow-hidden bg-background">
        <header className="flex h-page-header shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-5">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="返回答题卡列表"><ArrowLeft size={18} /></Button>
          <div className="flex min-w-0 flex-1 flex-col"><strong className="truncate text-base font-semibold">{cardTitle}</strong><span className="truncate text-xs text-muted-foreground">扫描仪直扫或导入图片进行阅卷判分 · ID:{cardId}</span></div>
          {skin !== undefined && onSkinChange && (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ServerStatusIndicator />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="服务器连接"
                onClick={() => setCfgOpen(true)}
              >
                <Globe size={16} />
              </Button>
              <SkinSwitcher skin={skin} onSkinChange={onSkinChange} />
            </div>
          )}
          {/* v2.5.6：对话框移出皮肤条件块——「图片去向」卡的「去配置」入口必须在任何情况下都能打开它 */}
          <ServerConfigDialog mode="dialog" open={cfgOpen} onOpenChange={setCfgOpen} />
        </header>

        <div className="flex min-h-0 flex-1 flex-row-reverse">
          {/* ── Main area: ScannerPanel or GradingResults ── */}
          <section className="min-w-0 flex-1 overflow-auto bg-background p-6">
            {scanning ? (
              <ScannerPanel
                cardId={cardId}
                onScansComplete={(_sId, pageCount) => {
                  // v2.5.1: 保持面板挂在 done 视图（成绩表可见、上传由全局卡片接管）；退出走面板内按钮
                  setStatus(`扫描完成：${pageCount} 张`);
                }}
                onClose={() => setScanning(false)}
              />
            ) : gradingResult ? (
              <GradingResultsInline
                result={gradingResult}
                onDownloadCsv={() => gradingResult && downloadGradingCsv(gradingResult.rows, gradingResult.cardId)}
              />
            ) : (
              <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-muted-foreground">
                <Camera className="mb-4 size-12 opacity-30" />
                <p className="text-sm">开始扫描或导入图片进行阅卷</p>
                {status && <p className="mt-2 text-sm text-primary">{status}</p>}
              </div>
            )}
          </section>

          {/* ── Sidebar: Scan settings + File import ── */}
          <aside className="flex w-[340px] shrink-0 flex-col gap-4 overflow-auto border-r border-border-subtle bg-card p-4">
            {/* ── 图片去向（v2.5.6 提升为常驻首位）────────────────────────
                现场反馈「依旧无法选择本地阅卷与上传服务器」：此前直扫的档位藏在
                ScannerPanel 的「扫描设置」里，而该设置卡又被"检测到扫描仪"门控，
                检测一失败就整个消失，老师根本找不到选择入口。现固定在侧栏首位，
                直扫与导入共用，且与扫描仪检测结果完全解耦。 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <UploadIcon size={17} /> 图片去向
                </CardTitle>
              </CardHeader>
              <CardContent>
                <SegmentedControl
                  aria-label="图片去向"
                  value={imageMode}
                  onValueChange={setImageMode}
                  block
                  items={[
                    { value: "local", label: "仅本地", icon: <Database size={14} />, tip: "图片与成绩只留在本机" },
                    { value: "remote", label: "本地判分+上传服务器", icon: <UploadIcon size={14} />, tip: "本地照常判分，图片与识别结果同时上传到远端服务器" },
                  ]}
                />
                {imageMode === "remote" ? (
                  isRemoteServerConfigured() ? (
                    <p className="mt-2 m-0 rounded-md bg-secondary p-2 text-xs text-muted-foreground">
                      已连接服务器：<code className="font-mono">{readServerUrl()}</code>。扫描与导入的图片都会上传。
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-col gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
                      <span>尚未配置可用的服务器地址，图片无法上传。请先填写地址与 API Key。</span>
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        className="self-start"
                        icon={<Globe size={14} />}
                        onClick={() => setCfgOpen(true)}
                      >
                        去配置
                      </Button>
                    </div>
                  )
                ) : (
                  <p className="mt-2 m-0 rounded-md bg-secondary p-2 text-xs text-muted-foreground">
                    图片与成绩只留在本机，不上传服务器。
                  </p>
                )}
              </CardContent>
            </Card>

            {/* ── TWAIN Scanner ── */}
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Camera size={17} /> 扫描仪直扫</CardTitle></CardHeader>
              <CardContent>
              <Button
                variant="primary"
                block
                icon={<Camera size={17} />}
                onClick={() => {
                  setScanning(true);
                  setGradingResult(null);
                  setStatus("");
                }}
                disabled={isBusy}
              >
                开始扫描
              </Button>
              <p className="mt-2 rounded-md bg-secondary p-2 text-xs text-muted-foreground">连接扫描仪进行 TWAIN 直扫和自动识别</p>
              </CardContent>
            </Card>

            {/* ── File Import ── */}
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ImagePlus size={17} /> 导入阅卷</CardTitle></CardHeader>
              <CardContent>

                {/* v2.5.6：此处不再放第二个档位控件——侧栏首位的「图片去向」是唯一选择入口，
                    同栏相邻两个同名控件只会让人分不清哪个生效。仅回显当前档位。 */}
                <p className="mb-3 m-0 rounded-md bg-secondary p-2 text-xs text-muted-foreground">
                  图片去向：{imageMode === "remote" ? "本地判分 + 上传服务器" : "仅本地"}
                  {imageMode === "remote" && !isRemoteServerConfigured() && (
                    <span className="text-warning-foreground">（未配置服务器地址，本次仅本地判分）</span>
                  )}
                </p>

              <p className="mb-2 text-xs text-muted-foreground">多页答题卡请按学生逐份添加，每份按布局页序排列；双面卡无需导入末尾空白背面。</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" asChild>
                  <label className="cursor-pointer">
                    <FolderOpen size={16} /> 导入目录
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      {...directoryInputProps}
                      onChange={(event) => {
                        addGradingFiles(event.target.files);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <label className="cursor-pointer">
                    <ImagePlus size={16} /> 导入图片
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        addGradingFiles(event.target.files);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </Button>
              </div>

                <div className="mt-3 flex items-center justify-between text-sm">
                <div className="flex items-baseline gap-1">
                  <strong className="tabular-nums">{gradingFiles.length}</strong>
                  <span className="text-muted-foreground">张待阅卷图片</span>
                </div>
                {gradingFiles.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => setGradingFiles([])}
                  >
                    清空
                  </Button>
                )}
              </div>

              {gradingFiles.length > 0 && (
                <div className="mt-2 flex max-h-32 flex-col gap-1 overflow-auto rounded-md border border-border-subtle bg-secondary p-2">
                  {gradingFiles.slice(0, 6).map((file) => (
                    <span
                      key={`${file.name}_${file.size}_${file.lastModified}`}
                      className="truncate text-xs text-muted-foreground"
                    >
                      {file.webkitRelativePath || file.name}
                    </span>
                  ))}
                  {gradingFiles.length > 6 && (
                    <span className="text-xs text-muted-foreground">还有 {gradingFiles.length - 6} 张...</span>
                  )}
                </div>
              )}

              <Button
                variant="primary"
                block
                className="mt-3"
                icon={<ClipboardCheck size={17} />}
                loading={isBusy}
                onClick={() => void gradeAnswerCardFiles()}
                disabled={gradingFiles.length === 0 || isBusy}
              >
                开始识别判分
              </Button>
              </CardContent>
            </Card>

            {/* ── Status ── */}
            {status && (
              <Card><CardHeader><CardTitle className="text-base">状态</CardTitle></CardHeader><CardContent><p className="text-sm">{status}</p></CardContent></Card>
            )}
          </aside>
        </div>
        <footer className="flex h-statusbar shrink-0 items-center border-t border-border-subtle bg-card px-4 text-xs text-muted-foreground">{status || "扫描服务已就绪"}</footer>
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  if (!result || result.rows.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardCheck />}
        title="等待阅卷"
        description="导入答题卡图片后开始识别。"
      />
    );
  }

  const totalReview = result.rows.reduce((sum, row) => sum + row.needsReviewCount, 0);
  const totalIssues = result.rows.reduce((sum, row) => sum + row.issueCount, 0);

  function toggleRow(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="m-0 text-lg font-semibold text-foreground">成绩表</h2>
          <p className="m-0 text-sm text-muted-foreground">
            <span className="tabular-nums">{result.rows.length}</span> 张答题卡 / 待复核{" "}
            <span className="tabular-nums">{totalReview}</span> 题 / 异常{" "}
            <span className="tabular-nums">{totalIssues}</span> 处
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          type="button"
          icon={<Download size={16} />}
          onClick={onDownloadCsv}
          disabled={result.rows.length === 0}
        >
          CSV
        </Button>
      </div>

      <TableWrap className="rounded-lg border border-border-subtle bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>文件</TableHead>
              <TableHead>学号</TableHead>
              <TableHead>状态</TableHead>
              <TableHead numeric>总分</TableHead>
              <TableHead numeric>客观/主观</TableHead>
              <TableHead numeric>复核</TableHead>
              <TableHead>答题卡</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row) => {
              const key = `${row.fileName}_${row.recognition.imagePath ?? row.fileName}`;
              const isOpen = expanded.has(key);
              const isClean = row.recognitionStatus === "ok" && row.issueCount === 0;
              return [
                <TableRow
                  key={key}
                  clickable
                  aria-expanded={isOpen}
                  onClick={() => toggleRow(key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleRow(key);
                    }
                  }}
                  tabIndex={0}
                >
                  <TableCell className="max-w-[220px]">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {isOpen
                        ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                        : <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden />}
                      <span className="truncate" title={row.fileName}>{row.fileName}</span>
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">{row.studentId ?? "未识别"}</TableCell>
                  <TableCell>
                    <Badge tone={isClean ? "success" : "warning"} dot className={isClean ? "scan-lime" : undefined}>
                      {row.recognitionStatus}
                    </Badge>
                  </TableCell>
                  <TableCell numeric>{row.totalScore}/{row.totalMaxScore}</TableCell>
                  <TableCell numeric>
                    {row.objectiveScore}/{row.objectiveMaxScore} · {row.subjectiveScore}/{row.subjectiveMaxScore}
                  </TableCell>
                  <TableCell numeric>{row.needsReviewCount}</TableCell>
                  <TableCell>
                    {row.previewUrl ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto px-1 py-0 text-xs text-accent-foreground underline underline-offset-2"
                        onClick={(event) => {
                          event.stopPropagation();
                          const url = mediaUrl(row.previewUrl!);
                          window.open(url, "_blank");
                        }}
                      >
                        预览
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>,
                isOpen ? (
                  <TableRow key={`${key}__detail`} className="hover:bg-transparent">
                    <TableCell colSpan={7} className="h-auto bg-secondary py-3">
                      <div className="flex flex-col gap-2">
                        {row.message && (
                          <p className="m-0 text-xs text-destructive-fg">{row.message}</p>
                        )}
                        {row.questions.length > 0 && (
                          <p className="m-0 text-xs font-medium text-muted-foreground">客观题</p>
                        )}
                        {row.questions.map((question) => {
                          const flagged = question.needsReview || question.status === "missing_key";
                          return (
                            <div
                              key={question.questionNumber}
                              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border-subtle bg-card px-3 py-1.5 text-xs"
                            >
                              <strong className="tabular-nums text-foreground">{question.questionNumber}</strong>
                              <span className="text-muted-foreground">标准 {(question.correctOptions || []).join("")}</span>
                              <span className="text-muted-foreground">识别 {(question.selectedOptions || []).join("")}</span>
                              <span className="tabular-nums text-foreground">{question.score}/{question.maxScore}</span>
                              <span className="tabular-nums text-muted-foreground">置信 {question.confidence.toFixed(3)}</span>
                              <Badge tone={flagged ? "danger" : "neutral"} dot={flagged} className="ml-auto">
                                {question.message ?? question.status}
                              </Badge>
                            </div>
                          );
                        })}
                        {row.subjectiveQuestions.length > 0 && (
                          <p className="m-0 text-xs font-medium text-muted-foreground">主观题</p>
                        )}
                        {row.subjectiveQuestions.map((question) => (
                          <div
                            key={question.questionId}
                            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border-subtle bg-card px-3 py-1.5 text-xs"
                          >
                            <strong className="tabular-nums text-foreground">{question.questionNumber}</strong>
                            <span className="text-muted-foreground">
                              有效 {question.validCells.map((cell) => cell.score).join("+") || "-"}
                            </span>
                            <span className="tabular-nums text-muted-foreground">无效 {question.invalidCells.length}</span>
                            <span className="tabular-nums text-foreground">{question.score}/{question.maxScore}</span>
                            <span className="tabular-nums text-muted-foreground">置信 {question.confidence.toFixed(3)}</span>
                            <Badge tone={question.needsReview ? "danger" : "neutral"} dot={question.needsReview} className="ml-auto">
                              {question.message ?? question.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null,
              ];
            })}
          </TableBody>
        </Table>
      </TableWrap>
    </div>
  );
}
