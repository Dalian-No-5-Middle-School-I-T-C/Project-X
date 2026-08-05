// OnlineReviewPanel —— 在线阅卷（逐题打分，T5 v2 迁移）
// 视觉层整体切换到 v2：Panel / Card / SegmentedControl / Badge / Input / Button / EmptyState。
// 功能守恒（API / 请求体 / 状态机零改动）：
//  · GET  /api/review/exams/:examId/blocks
//  · GET  /api/review/exams/:examId/block-crops?blockId=&classId=&status=
//  · GET  /api/block-grading-config/exams/:examId/blocks/:blockId
//  · GET  /api/exams/:examId/student/:studentId/scores
//  · POST /api/review/exams/:examId/block-crops/:cropId/submit  { scores, status }
// PR #189 二次修复的三态 scoringMode（block_total / per_question / unknown）
// 与其提交禁用规则逐行保留，仅把双态横幅换成 danger / warning 语义配色。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, RefreshCw
} from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import {
  resolveScoringMode,
  type ClientScoringMode,
  type ConfigFetchResult
} from "../../../../server/services/scoringModeValidator";
import type {
  ReviewBlockCropItem,
  ReviewBlockCropsResponse,
  ReviewBlockSummary,
  ReviewSubmitResult
} from "../../../../shared/types";
import { cn } from "../lib/utils";
import {
  Button,
  EmptyState,
  Input,
  Panel,
  SegmentedControl,
  Spinner,
} from "./ui/v2";

interface Props {
  examId: number;
  examName: string;
  classId?: string;
}

type StatusFilter = "pending" | "reviewed" | "all";

const STATUS_FILTER_ITEMS = [
  { value: "pending", label: "待阅" },
  { value: "reviewed", label: "已阅" },
  { value: "all", label: "全部" },
];

export function OnlineReviewPanel({ examId, examName, classId }: Props) {
  const [blocks, setBlocks] = useState<ReviewBlockSummary[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [queue, setQueue] = useState<ReviewBlockCropItem[]>([]);
  const [index, setIndex] = useState(0);
  const [scoreEdits, setScoreEdits] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // PR #189 二次修复：客户端评分模式从二态（block_total/per_question）扩为三态：
  //   - "block_total" → 配置明确读到 block_total，禁用提交（与管理配置一致）
  //   - "per_question" → 配置明确读到 per_question，正常提交
  //   - "unknown"      → 配置加载失败，黄色警告 + 保留提交（服务端兜底）
  // 之前 fetch 失败时直接按 block_total 处理是"安全失败"，但与管理界面无法切换
  // 模式叠加后会形成硬锁死（网络抖动一下老师就再也提交不了分数）。
  // null = 题块未选中 / 配置尚未加载完成。
  const [scoringMode, setScoringMode] = useState<ClientScoringMode | null>(null);
  const [configLoadError, setConfigLoadError] = useState<string | null>(null);

  const current = queue[index] ?? null;

  const loadBlocks = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchJson<{ examId: number; blocks: ReviewBlockSummary[] }>(
        `/api/review/exams/${examId}/blocks`
      );
      setBlocks(data.blocks);
      if (!selectedBlockId && data.blocks.length > 0) {
        const firstPending = data.blocks.find((block) => block.pendingCount > 0) ?? data.blocks[0];
        setSelectedBlockId(firstPending.blockId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载题块失败");
      setBlocks([]);
    } finally {
      setLoading(false);
    }
  }, [examId, selectedBlockId]);

  const loadQueue = useCallback(async (preserveIndex = false) => {
    if (!selectedBlockId) {
      setQueue([]);
      return;
    }
    setError("");
    try {
      const params = new URLSearchParams({ blockId: selectedBlockId });
      if (classId) params.set("classId", classId);
      if (statusFilter !== "all") params.set("status", statusFilter === "pending" ? "ready" : "reviewed");
      const data = await fetchJson<ReviewBlockCropsResponse>(
        `/api/review/exams/${examId}/block-crops?${params.toString()}`
      );
      setQueue(data.rows);
      if (!preserveIndex) setIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载阅卷队列失败");
      setQueue([]);
    }
  }, [examId, selectedBlockId, classId, statusFilter]);

  // PR #189 二次修复：加载评分模式并归一为三态。
  // 区分"配置缺失但响应成功"（合法未配置，回退 block_total）
  // 和"配置加载失败"（网络/服务异常，必须走 unknown 让服务端兜底）。
  const loadBlockConfig = useCallback(async () => {
    if (!selectedBlockId) {
      setScoringMode(null);
      setConfigLoadError(null);
      return;
    }
    let fetchResult: ConfigFetchResult;
    try {
      const res = await fetchJson<{ ok: boolean; data?: { scoringMode?: string } }>(
        `/api/block-grading-config/exams/${examId}/blocks/${encodeURIComponent(selectedBlockId)}`
      );
      // res.ok=true 但 data.scoringMode 为空 → 合法"未配置"
      // res.ok=false → 服务端说配置不存在（也可能返回 404）
      if (res.ok && res.data) {
        fetchResult = { kind: "ok", scoringMode: res.data.scoringMode };
      } else {
        fetchResult = { kind: "config-missing" };
      }
    } catch (err) {
      fetchResult = {
        kind: "fetch-failed",
        error: err instanceof Error ? err.message : "配置加载失败"
      };
    }
    const { mode, configLoadError: errMsg } = resolveScoringMode(fetchResult);
    setScoringMode(mode);
    setConfigLoadError(errMsg);
  }, [examId, selectedBlockId]);

  useEffect(() => {
    void loadBlocks();
  }, [loadBlocks]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    void loadBlockConfig();
  }, [loadBlockConfig]);

  useEffect(() => {
    if (!current?.studentId) {
      setScoreEdits({});
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const detail = await fetchJson<{
          questionScores: Array<{ question_number: number; score: number; max_score: number; score_type: string }>;
        }>(`/api/exams/${examId}/student/${current.studentId}/scores`);
        if (cancelled) return;
        const initial: Record<number, string> = {};
        for (const qNum of current.questionNumbers) {
          const num = Number(qNum);
          if (!Number.isFinite(num)) continue;
          const row = detail.questionScores.find((item) => item.question_number === num);
          initial[num] = row != null ? String(row.score) : "";
        }
        setScoreEdits(initial);
      } catch {
        if (!cancelled) setScoreEdits({});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.studentId, examId]);

  const selectedBlock = useMemo(
    () => blocks.find((block) => block.blockId === selectedBlockId) ?? null,
    [blocks, selectedBlockId]
  );

  async function submitCurrent(status: "reviewed" | "disputed" = "reviewed", advance = true) {
    if (!current || !current.studentId) return;
    // UI-1/UI-2：提交节流，避免连点造成重复提交
    if (saving) return;
    // PR #189 二次修复：只在「配置明确读到 block_total」时禁用提交。
    // "unknown"（配置加载失败）必须允许提交，让服务端校验兜底——
    // 否则网络抖动一下老师就被硬锁死。
    if (scoringMode === "block_total") {
      setError("本题块配置为「题块总分」模式，请使用阅卷面板（GradePanel）输入合计分；或请管理员将该题块评分模式改为「逐题评分」");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const scores = current.questionNumbers
        .map((qNum) => Number(qNum))
        .filter((qNum) => Number.isFinite(qNum))
        .map((questionNumber) => {
          const raw = scoreEdits[questionNumber];
          const score = raw === "" || raw == null ? Number(current.score ?? 0) : Number(raw);
          const scoreType = current.blockType === "objective" ? "objective" : "subjective";
          return { questionNumber, scoreType, score };
        });

      if (scores.some((item) => !Number.isFinite(item.score))) {
        setError("请填写有效分数");
        return;
      }

      const result = await fetchJson<ReviewSubmitResult>(
        `/api/review/exams/${examId}/block-crops/${encodeURIComponent(current.id)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scores, status })
        }
      );
      setMessage(`已保存：${current.studentName ?? current.studentNumber ?? "学生"}，总分 ${result.totalScore}`);
      await loadBlocks();
      const params = new URLSearchParams({ blockId: selectedBlockId });
      if (classId) params.set("classId", classId);
      if (statusFilter !== "all") params.set("status", statusFilter === "pending" ? "ready" : "reviewed");
      const refreshed = await fetchJson<ReviewBlockCropsResponse>(
        `/api/review/exams/${examId}/block-crops?${params.toString()}`
      );
      const removed = refreshed.rows.length < queue.length;
      setQueue(refreshed.rows);
      setIndex((value) => {
        if (refreshed.rows.length === 0) return 0;
        // 列表因当前项被复核而缩短时，原索引已自动指向下一份；
        // 否则（如"全部"筛选下当前项仍在）需显式 +1 才能前进。
        const target = advance && !removed ? value + 1 : value;
        return Math.max(0, Math.min(target, refreshed.rows.length - 1));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
        <Spinner size={16} /> 正在加载网上阅卷...
      </div>
    );
  }

  if (blocks.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardCheck />}
        title="暂无大题切块"
        description="请先完成阅卷识别。识别成功后会按大题自动生成作答图片切块，供网上阅卷使用。"
      />
    );
  }

  const submitDisabled = saving || scoringMode === "block_total";

  return (
    <div className="flex h-full min-h-0 w-full gap-4 overflow-hidden p-4">
      {/* ── 题块列表 ─────────────────────────────────────── */}
      <Panel className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto p-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold text-foreground">题块列表</h2>
          <p className="truncate text-xs text-muted-foreground">{examName}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          {blocks.map((block) => {
            const active = selectedBlockId === block.blockId;
            return (
              <button
                key={block.blockId}
                type="button"
                onClick={() => setSelectedBlockId(block.blockId)}
                className={cn(
                  "w-full rounded-md border px-3 py-2 text-left",
                  "transition-colors duration-(--px-dur-1) ease-standard",
                  "outline-none focus-visible:shadow-focus",
                  active
                    ? "border-accent-border bg-accent"
                    : "border-border-subtle bg-card hover:bg-secondary",
                )}
              >
                <div className="truncate text-sm font-medium text-foreground">
                  {block.blockTitle || block.blockId}
                </div>
                <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                  待阅 {block.pendingCount} / 共 {block.totalCount}
                </div>
              </button>
            );
          })}
        </div>

        <Button
          variant="outline"
          size="sm"
          block
          icon={<RefreshCw />}
          className="mt-2"
          onClick={() => void loadBlocks()}
        >
          刷新
        </Button>
      </Panel>

      {/* ── 主区 ─────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
            items={STATUS_FILTER_ITEMS}
            size="sm"
          />
          {selectedBlock && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {selectedBlock.blockTitle} · 已阅 {selectedBlock.reviewedCount}/{selectedBlock.totalCount}
            </span>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive-fg"
          >
            {error}
          </p>
        )}
        {message && (
          <p
            role="status"
            className="rounded-md bg-success-soft px-3 py-2 text-sm text-success-foreground"
          >
            {message}
          </p>
        )}

        {!current ? (
          <EmptyState
            icon={<CheckCircle2 />}
            title="当前筛选下无待阅答卷"
            description="可切换题块或筛选条件继续阅卷。"
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
            {/* 图片区 */}
            <Panel className="flex min-w-0 flex-1 flex-col gap-3 p-3">
              <div className="flex flex-wrap items-baseline gap-3 text-sm">
                <strong className="text-foreground">{current.studentName ?? "未知姓名"}</strong>
                <span className="tabular-nums text-muted-foreground">
                  {current.studentNumber ? `考号 ${current.studentNumber}` : ""}
                </span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  第 {index + 1} / {queue.length} 份
                </span>
              </div>

              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md bg-paper p-2">
                <img
                  src={mediaUrl(current.imageUrl)}
                  alt={current.blockTitle}
                  className="max-w-full object-contain"
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  icon={<ChevronLeft />}
                  disabled={index <= 0}
                  onClick={() => setIndex((v) => v - 1)}
                >
                  上一份
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  iconRight={<ChevronRight />}
                  disabled={index >= queue.length - 1}
                  onClick={() => setIndex((v) => v + 1)}
                >
                  下一份
                </Button>
              </div>
            </Panel>

            {/* 打分区 */}
            <Panel className="flex w-full shrink-0 flex-col gap-3 p-4 lg:w-80">
              <div className="flex flex-col gap-0.5">
                <h3 className="text-base font-semibold text-foreground">
                  {current.blockTitle || "大题阅卷"}
                </h3>
                <p className="text-xs text-muted-foreground">
                  题号：{current.questionNumbers.join("、")}
                </p>
                {current.score != null && current.maxScore != null && (
                  <p className="text-xs tabular-nums text-muted-foreground">
                    当前得分：{current.score} / {current.maxScore}
                  </p>
                )}
              </div>

              {/* PR #189 二次修复：双态横幅。
                   - block_total：红色硬警告 + 禁用提交（与管理配置一致）
                   - unknown   ：黄色软警告 + 保留提交（让服务端兜底，避免硬锁死）
              */}
              {scoringMode === "block_total" && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive-border bg-destructive-soft px-3.5 py-3 text-sm text-destructive-fg"
                >
                  本题块配置为「题块总分」模式，请使用阅卷面板（GradePanel）输入合计分；如需在此面板按题打分，请管理员将本题块评分模式改为「逐题评分」。
                </div>
              )}
              {scoringMode === "unknown" && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-md border border-warning-border bg-warning-soft px-3.5 py-2.5 text-sm text-warning-foreground"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1">
                    题块配置加载失败{configLoadError ? `（${configLoadError}）` : ""}，未能确认评分模式。
                    本次提交将按当前页面输入（逐题）发送，服务端校验兜底；若被拒绝请重试或联系管理员。
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void loadBlockConfig()}
                  >
                    重试加载
                  </Button>
                </div>
              )}

              <div className="flex flex-col gap-2">
                {current.questionNumbers.map((qNum) => {
                  const num = Number(qNum);
                  if (!Number.isFinite(num)) return null;
                  return (
                    <label key={num} className="flex items-center gap-3">
                      <span className="w-20 shrink-0 text-sm text-secondary-foreground">
                        第 {num} 题
                      </span>
                      <Input
                        type="number"
                        min={0}
                        step={0.5}
                        className="tabular-nums"
                        value={scoreEdits[num] ?? ""}
                        onChange={(e) => setScoreEdits((prev) => ({ ...prev, [num]: e.target.value }))}
                      />
                    </label>
                  );
                })}
              </div>

              <div className="mt-auto flex flex-col gap-2 pt-2">
                <Button
                  variant="primary"
                  block
                  icon={<CheckCircle2 />}
                  loading={saving}
                  disabled={submitDisabled}
                  onClick={() => void submitCurrent("reviewed", true)}
                >
                  保存并下一份
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    block
                    disabled={submitDisabled}
                    onClick={() => void submitCurrent("reviewed", false)}
                  >
                    仅保存
                  </Button>
                  <Button
                    variant="outline"
                    block
                    disabled={submitDisabled}
                    onClick={() => void submitCurrent("disputed", false)}
                  >
                    标记争议
                  </Button>
                </div>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
