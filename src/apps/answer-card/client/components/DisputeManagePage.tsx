// DisputeManagePage —— 争议管理（T5 v2 迁移）
// 视觉层整体切换到 v2：Card / Badge / Dialog / Field / Input / Button / EmptyState。
// 功能守恒：
//  · GET  /api/review-arbitration/exams/:examId/disputes
//  · GET  /api/review-arbitration/exams/:examId/blocks/:blockId/arbitrators
//  · POST /api/review-arbitration/crops/:cropId/resolve  { score }
// 请求/响应形状与权限判断零改动，仅替换视觉层。
import React, { useState, useEffect, useCallback } from "react";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { DisputeItem, ArbitratorCandidate } from "../../../../shared/types";
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

export function DisputeManagePage({ examId }: Props) {
  const [disputes, setDisputes] = useState<DisputeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDispute, setSelectedDispute] = useState<DisputeItem | null>(null);
  const [arbitrators, setArbitrators] = useState<ArbitratorCandidate[]>([]);
  const [resolutionScore, setResolutionScore] = useState("");
  // UI-1/UI-2：提交节流 + loading 态，避免重复仲裁
  const [resolving, setResolving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ ok: boolean; data: DisputeItem[] }>(
        `/api/review-arbitration/exams/${examId}/disputes`
      );
      if (res.ok) setDisputes(res.data);
    } catch { /* silent */ }
    setLoading(false);
  }, [examId]);

  useEffect(() => { load(); }, [load]);

  const loadArbitrators = async (blockId: string) => {
    const res = await fetchJson<{ ok: boolean; data: ArbitratorCandidate[] }>(
      `/api/review-arbitration/exams/${examId}/blocks/${encodeURIComponent(blockId)}/arbitrators`
    );
    if (res.ok) setArbitrators(res.data);
  };

  const handleResolve = async (cropId: string) => {
    if (!resolutionScore || resolving) return;
    setResolving(true);
    setErrorMsg("");
    try {
      await fetchJson(`/api/review-arbitration/crops/${encodeURIComponent(cropId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ score: Number(resolutionScore) }),
      });
      setSelectedDispute(null);
      setResolutionScore("");
      load();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "仲裁提交失败，请重试");
    } finally {
      setResolving(false);
    }
  };

  const closeDialog = (open: boolean) => {
    if (open || resolving) return;
    setSelectedDispute(null);
    setResolutionScore("");
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
        <span className="text-sm tabular-nums text-muted-foreground">
          共 {disputes.length} 份
        </span>
      </div>

      {errorMsg && (
        <div className="rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">
          {errorMsg}
        </div>
      )}

      {disputes.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="暂无争议卷"
          description="多评分差均在阈值内，无需仲裁。"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {disputes.map((d) => {
            const pending = d.status === "pending";
            return (
              <Card
                key={d.cropId}
                className={
                  pending
                    ? "border-destructive-border bg-destructive-soft p-4"
                    : "p-4"
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium text-foreground">{d.studentName}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {d.studentNumber} · {d.blockTitle}
                    </span>
                  </div>
                  <div className="text-sm text-secondary-foreground">
                    分差:{" "}
                    <span className="font-medium tabular-nums text-destructive-fg">
                      {d.scoreDiff}
                    </span>{" "}
                    / 阈值 <span className="tabular-nums">{d.threshold}</span>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {d.scores.map((s, i) => (
                    <span key={i} className="tabular-nums">
                      {s.reviewerName}: {s.score}分
                    </span>
                  ))}
                  {d.arbitratorName && (
                    <Badge tone="success" dot>
                      仲裁: {d.arbitratorName}
                    </Badge>
                  )}
                  {!d.arbitratorName && pending && (
                    <Badge tone="danger" icon={<AlertTriangle aria-hidden="true" />}>
                      搁置中
                    </Badge>
                  )}
                </div>

                {pending && (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSelectedDispute(d);
                        setResolutionScore("");
                        loadArbitrators(d.blockId);
                      }}
                    >
                      处理
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* 仲裁处理对话框 */}
      <Dialog open={selectedDispute != null} onOpenChange={closeDialog}>
        {selectedDispute && (
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>
                仲裁 — {selectedDispute.studentName} · {selectedDispute.blockTitle}
              </DialogTitle>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <div className="flex flex-col gap-1 rounded-md bg-secondary p-3">
                {selectedDispute.scores.map((s, i) => (
                  <div key={i} className="text-sm tabular-nums text-foreground">
                    {s.reviewerName}: {s.score}分
                  </div>
                ))}
              </div>

              {arbitrators.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  可选仲裁人：
                  {arbitrators.map((a) => (
                    <Badge key={a.id} tone="neutral">
                      {a.name}
                    </Badge>
                  ))}
                </div>
              )}

              <Field label="最终分" htmlFor="dispute-final-score">
                <Input
                  id="dispute-final-score"
                  type="number"
                  step={0.5}
                  value={resolutionScore}
                  onChange={(e) => setResolutionScore(e.target.value)}
                  className="tabular-nums"
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={resolving}
                onClick={() => closeDialog(false)}
              >
                取消
              </Button>
              <Button
                variant="primary"
                loading={resolving}
                disabled={!resolutionScore}
                onClick={() => handleResolve(selectedDispute.cropId)}
              >
                提交仲裁
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
