import React, { useState, useEffect, useCallback } from "react";
import { AlertTriangle, CheckCircle2, FileText, ShieldCheck } from "lucide-react";
import { retryMediaTicketImage } from "../lib/mediaTicketRetry";
import { authFetch, fetchJson, mediaUrl } from "../auth/api";
import type { ArbitrationDisputeItem, ArbitrationDisputesResponse, ArbitrationQuestionRule } from "../../../../shared/arbitration";
import { arbitrationScoreError, validateArbitrationScores } from "../../../../shared/arbitration";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Spinner,
} from "./ui/v2";

interface Props {
  examId: number;
}

function OriginalPaperViewer({ pageNumber, imageUrl }: { pageNumber: number; imageUrl: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setLoading(true);
    setError("");
    setImage(null);
    authFetch(imageUrl, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 404 ? "该原卷页不可用" : "原卷页加载失败");
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!controller.signal.aborted) setImage(objectUrl);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "原卷页加载失败");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, imageUrl]);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-subtle p-3">
      <Button variant="outline" size="sm" icon={<FileText />} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? `收起第 ${pageNumber} 页原卷` : `查看第 ${pageNumber} 页原卷`}
      </Button>
      {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size={14} /> 正在加载原卷页…</div>}
      {error && <p role="alert" className="text-sm text-destructive-fg">{error}</p>}
      {image && <img src={image} alt={`争议卷原卷第 ${pageNumber} 页`} className="max-w-full" />}
    </div>
  );
}

function numericScores(questionNumbers: number[], scores: Record<string, string>): Record<string, number | null> {
  return Object.fromEntries(questionNumbers.map(number => {
    const raw = scores[String(number)]?.trim() ?? "";
    return [String(number), raw ? Number(raw) : null];
  }));
}

export function DisputeManagePage({ examId }: Props) {
  const [disputes, setDisputes] = useState<ArbitrationDisputeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedDispute, setSelectedDispute] = useState<ArbitrationDisputeItem | null>(null);
  const [resolutionScores, setResolutionScores] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const res = await fetchJson<ArbitrationDisputesResponse>(`/api/review-arbitration/exams/${examId}/disputes`);
      if (res.ok) {
        setDisputes(res.data);
        setLoadError("");
      }
    } catch (err) {
      if (!background) setLoadError(err instanceof Error ? err.message : "争议列表加载失败");
    } finally {
      if (!background) setLoading(false);
    }
  }, [examId]);

  useEffect(() => { void load(); }, [load]);

  const validation = selectedDispute
    ? validateArbitrationScores(selectedDispute.questionNumbers, selectedDispute.questions, numericScores(selectedDispute.questionNumbers, resolutionScores))
    : null;
  const pending = selectedDispute?.status === "pending";
  const canSubmit = Boolean(pending && !selectedDispute?.reviewIssue && validation?.ok);
  const hasNext = selectedDispute ? disputes.some(item => item.cropId !== selectedDispute.cropId) : false;

  function selectDispute(dispute: ArbitrationDisputeItem) {
    setSelectedDispute(dispute);
    setResolutionScores(Object.fromEntries(dispute.questionNumbers.map(number => [String(number), ""])));
    setErrorMsg("");
    setSuccessMsg("");
  }

  function nextDispute(current: ArbitrationDisputeItem, remaining: ArbitrationDisputeItem[]): ArbitrationDisputeItem | null {
    const index = disputes.findIndex(item => item.cropId === current.cropId);
    const following = disputes.slice(index + 1).find(item => remaining.some(candidate => candidate.cropId === item.cropId));
    return following ?? remaining[0] ?? null;
  }

  const handleResolve = async (advance: boolean) => {
    const current = selectedDispute;
    if (!current || resolving) return;
    if (current.status !== "pending") {
      if (!advance) return;
      const next = nextDispute(current, disputes);
      if (next) selectDispute(next);
      return;
    }
    const checked = validateArbitrationScores(current.questionNumbers, current.questions, numericScores(current.questionNumbers, resolutionScores));
    if (!checked.ok || current.reviewIssue) {
      setErrorMsg(checked.ok ? current.reviewIssue ?? "当前切图不可仲裁" : checked.error);
      return;
    }
    setResolving(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      await fetchJson(`/api/review-arbitration/crops/${encodeURIComponent(current.cropId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ questionScores: checked.values }),
      });
      const remaining = disputes.filter(item => item.cropId !== current.cropId);
      setDisputes(remaining);
      if (advance) {
        const next = nextDispute(current, remaining);
        if (next) {
          selectDispute(next);
        } else {
          setSelectedDispute({ ...current, status: "arbitrated" });
          setSuccessMsg("仲裁已提交，当前已是最后一份。");
        }
      } else {
        // Keep this DialogBody mounted so a successful submission does not reset scroll.
        setSelectedDispute({ ...current, status: "arbitrated" });
        setSuccessMsg("仲裁已提交。可继续查看原卷，或点击“仲裁并下一份”。");
      }
      void load(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "仲裁提交失败，请重试");
    } finally {
      setResolving(false);
    }
  };

  const closeDialog = (open: boolean) => {
    if (open || resolving) return;
    setSelectedDispute(null);
    setResolutionScores({});
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner size={16} /> 加载中...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold text-foreground">争议管理</h2>
        <span className="text-sm tabular-nums text-muted-foreground">共 {disputes.length} 份</span>
      </div>

      {loadError && (
        <div role="alert" className="rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">
          {loadError}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void load()}>重试</Button>
        </div>
      )}

      {disputes.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title="暂无争议卷" description="多评分差均在阈值内，无需仲裁。" />
      ) : (
        <div className="flex flex-col gap-2">
          {disputes.map(dispute => (
            <Card key={dispute.cropId} className={dispute.status === "pending" ? "border-destructive-border bg-destructive-soft p-4" : "p-4"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-foreground">{dispute.studentName}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{dispute.studentNumber} · {dispute.blockTitle}</span>
                </div>
                <div className="text-sm text-secondary-foreground">
                  分差: <span className="font-medium tabular-nums text-destructive-fg">{dispute.scoreDiff}</span>
                  {" / 阈值 "}<span className="tabular-nums">{dispute.threshold}</span>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {dispute.scores.map((score, index) => <span key={index} className="tabular-nums">{score.reviewerName}: {score.score}分</span>)}
                {dispute.arbitratorName && <Badge tone="success" dot>仲裁: {dispute.arbitratorName}</Badge>}
              </div>
              <div className="mt-3">
                <Button size="sm" variant="outline" onClick={() => selectDispute(dispute)}>处理</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={selectedDispute != null} onOpenChange={closeDialog}>
        {selectedDispute && (
          <DialogContent size={selectedDispute.reviewImages?.length || selectedDispute.originalPages.length ? "lg" : "sm"}>
            <DialogHeader>
              <DialogTitle>仲裁 — {selectedDispute.studentName} · {selectedDispute.blockTitle}</DialogTitle>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-secondary p-3">
                <div className="text-sm tabular-nums text-muted-foreground">
                  {selectedDispute.studentNumber} · {selectedDispute.scores.length} 位评阅人
                </div>
                {selectedDispute.arbitratorName && <Badge tone="info" dot>指定仲裁人：{selectedDispute.arbitratorName}</Badge>}
              </div>

              <div className="flex flex-col gap-1 rounded-md bg-secondary p-3">
                {selectedDispute.scores.map((score, index) => (
                  <div key={index} className="text-sm tabular-nums text-foreground">{score.reviewerName}: {score.score}分</div>
                ))}
              </div>

              {errorMsg && <div role="alert" className="rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">{errorMsg}</div>}
              {successMsg && <div role="status" className="rounded-md border border-success-border bg-success-soft px-3 py-2 text-sm text-success-foreground">{successMsg}</div>}
              {selectedDispute.reviewIssue && <p role="alert" className="text-sm text-destructive-fg">{selectedDispute.reviewIssue}</p>}

              {selectedDispute.reviewImages?.map((image, index) => (
                <figure key={image.id}>
                  <figcaption className="mb-1 text-xs text-muted-foreground">作文第 {index + 1} 段（第 {image.pageNumber} 页）</figcaption>
                  <img src={mediaUrl(image.imageUrl)} alt={`作文第 ${index + 1} 段（第 ${image.pageNumber} 页）`} className="max-w-full" onError={event => retryMediaTicketImage(event.currentTarget)} />
                </figure>
              ))}
              {!selectedDispute.reviewImages?.length && (
                <figure>
                  <figcaption className="mb-1 text-xs text-muted-foreground">学生作答切图（第 {selectedDispute.originalPages[0]?.pageNumber ?? "—"} 页题块）</figcaption>
                  <img src={mediaUrl(selectedDispute.cropImageUrl)} alt={`${selectedDispute.studentName} 的 ${selectedDispute.blockTitle} 作答切图`} className="max-w-full" onError={event => retryMediaTicketImage(event.currentTarget)} />
                </figure>
              )}

              {selectedDispute.originalPages.length > 0 && (
                <section className="flex flex-col gap-2" aria-label="争议卷原卷页">
                  <h3 className="text-sm font-medium text-foreground">原卷查看</h3>
                  <p className="text-xs text-muted-foreground">仅展示当前争议卷已核验归属的页面。</p>
                  <div className="flex flex-col gap-2">
                    {selectedDispute.originalPages.map(page => <OriginalPaperViewer key={page.pageNumber} {...page} />)}
                  </div>
                </section>
              )}

              <section className="flex flex-col gap-3" aria-label="逐题仲裁分数">
                <h3 className="text-sm font-medium text-foreground">逐题最终分</h3>
                {selectedDispute.questions.map(rule => {
                  const raw = resolutionScores[String(rule.number)]?.trim() ?? "";
                  const fieldError = raw ? arbitrationScoreError(Number(raw), rule as ArbitrationQuestionRule) : null;
                  const inputId = `dispute-final-${selectedDispute.cropId}-${rule.number}`;
                  return (
                    <Field
                      key={rule.number}
                      label={`第 ${rule.number} 题最终分`}
                      htmlFor={inputId}
                      hint={`满分 ${rule.maxScore} · 步长 ${rule.step} 分`}
                      error={fieldError}
                      required={pending}
                    >
                      <Input
                        id={inputId}
                        type="number"
                        min={0}
                        max={rule.maxScore}
                        step={rule.step}
                        inputMode="decimal"
                        value={resolutionScores[String(rule.number)] ?? ""}
                        disabled={!pending || resolving}
                        aria-invalid={Boolean(fieldError)}
                        onChange={event => setResolutionScores({ ...resolutionScores, [String(rule.number)]: event.target.value })}
                        className="tabular-nums"
                      />
                    </Field>
                  );
                })}
                {pending && validation && !validation.ok && !errorMsg && (
                  <p className="text-xs text-muted-foreground">{validation.error}</p>
                )}
              </section>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" disabled={resolving} onClick={() => closeDialog(false)}>关闭</Button>
              <Button variant="outline" loading={resolving} disabled={pending ? !canSubmit : !hasNext} onClick={() => void handleResolve(true)}>
                仲裁并下一份
              </Button>
              <Button variant="primary" loading={resolving} disabled={!canSubmit} onClick={() => void handleResolve(false)}>
                提交仲裁
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
