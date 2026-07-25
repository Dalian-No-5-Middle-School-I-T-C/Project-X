import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, Loader2, RefreshCw
} from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import type {
  ReviewBlockCropItem,
  ReviewBlockCropsResponse,
  ReviewBlockSummary,
  ReviewSubmitResult
} from "../../../../shared/types";

interface Props {
  examId: number;
  examName: string;
  classId?: string;
}

type StatusFilter = "pending" | "reviewed" | "all";

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
  // PR #189 修复：当前题块的评分模式（block_total / per_question）。
  // 当管理员把题块配置为「题块总分」时，本面板（按题输入）应当禁用提交，
  // 避免在线阅卷与 GradePanel 走两套评分语义。
  const [scoringMode, setScoringMode] = useState<"block_total" | "per_question" | null>(null);

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

  // PR #189 修复：加载当前题块的 scoringMode 配置，
  // 决定 OnlineReviewPanel 应该走「逐题」还是「题块总分」输入模式。
  // 若题块配置为「题块总分」，本面板只能禁用提交并提示，避免与 GradePanel 走不同评分语义。
  const loadBlockConfig = useCallback(async () => {
    if (!selectedBlockId) {
      setScoringMode(null);
      return;
    }
    try {
      const res = await fetchJson<{ ok: boolean; data?: { scoringMode?: string } }>(
        `/api/block-grading-config/exams/${examId}/blocks/${encodeURIComponent(selectedBlockId)}`
      );
      if (res.ok && res.data?.scoringMode) {
        setScoringMode(res.data.scoringMode === "per_question" ? "per_question" : "block_total");
      } else {
        // 配置缺失 → 走「网阅默认」/「题块总分」语义（与后端默认一致）
        setScoringMode("block_total");
      }
    } catch {
      setScoringMode("block_total");
    }
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
    // PR #189 修复：本题块若配置为「题块总分」，本面板（按题输入）应拒绝提交。
    // 让用户改用 GradePanel 输入合计分，或让管理员把题块改为「逐题评分」配置。
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
    return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>正在加载网上阅卷...</div>;
  }

  if (blocks.length === 0) {
    return (
      <div className="scores-empty">
        <ClipboardCheck size={40} />
        <h2>暂无大题切块</h2>
        <p>请先完成阅卷识别。识别成功后会按大题自动生成作答图片切块，供网上阅卷使用。</p>
      </div>
    );
  }

  return (
    <div className="online-review-panel">
      <div className="online-review-sidebar">
        <div className="panel-title">题块列表</div>
        <p className="hint" style={{ margin: "0 0 10px" }}>{examName}</p>
        {blocks.map((block) => (
          <button
            key={block.blockId}
            type="button"
            className={`online-review-block-item ${selectedBlockId === block.blockId ? "active" : ""}`}
            onClick={() => setSelectedBlockId(block.blockId)}
          >
            <div className="online-review-block-title">{block.blockTitle || block.blockId}</div>
            <div className="online-review-block-meta">
              待阅 {block.pendingCount} / 共 {block.totalCount}
            </div>
          </button>
        ))}
        <button className="ghost-button" type="button" onClick={() => void loadBlocks()} style={{ marginTop: 12 }}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <div className="online-review-main">
        <div className="online-review-toolbar">
          <div className="online-review-filters">
            {(["pending", "reviewed", "all"] as StatusFilter[]).map((filter) => (
              <button
                key={filter}
                type="button"
                className={`ghost-button ${statusFilter === filter ? "active-filter" : ""}`}
                onClick={() => setStatusFilter(filter)}
              >
                {filter === "pending" ? "待阅" : filter === "reviewed" ? "已阅" : "全部"}
              </button>
            ))}
          </div>
          {selectedBlock && (
            <span className="hint">
              {selectedBlock.blockTitle} · 已阅 {selectedBlock.reviewedCount}/{selectedBlock.totalCount}
            </span>
          )}
        </div>

        {error && <p className="login-error">{error}</p>}
        {message && <p className="hint" style={{ color: "var(--success)" }}>{message}</p>}

        {!current ? (
          <div className="scores-empty" style={{ minHeight: 280 }}>
            <CheckCircle2 size={36} />
            <h2>当前筛选下无待阅答卷</h2>
            <p>可切换题块或筛选条件继续阅卷。</p>
          </div>
        ) : (
          <div className="online-review-workspace">
            <div className="online-review-image-pane">
              <div className="online-review-student-bar">
                <strong>{current.studentName ?? "未知姓名"}</strong>
                <span>{current.studentNumber ? `考号 ${current.studentNumber}` : ""}</span>
                <span>第 {index + 1} / {queue.length} 份</span>
              </div>
              <div className="online-review-image-wrap">
                <img
                  src={mediaUrl(current.imageUrl)}
                  alt={current.blockTitle}
                  className="online-review-image"
                />
              </div>
              <div className="online-review-nav">
                <button className="ghost-button" type="button" disabled={index <= 0} onClick={() => setIndex((v) => v - 1)}>
                  <ChevronLeft size={16} /> 上一份
                </button>
                <button className="ghost-button" type="button" disabled={index >= queue.length - 1} onClick={() => setIndex((v) => v + 1)}>
                  下一份 <ChevronRight size={16} />
                </button>
              </div>
            </div>

            <div className="online-review-score-pane">
              <div className="panel-title">{current.blockTitle || "大题阅卷"}</div>
              <p className="hint">题号：{current.questionNumbers.join("、")}</p>
              {current.score != null && current.maxScore != null && (
                <p className="hint">当前得分：{current.score} / {current.maxScore}</p>
              )}

              {/* PR #189 修复：题块配置为「题块总分」时，本面板（按题输入）禁用提交。
                  显示醒目提示让老师立刻知道应该改用阅卷面板（GradePanel）。 */}
              {scoringMode === "block_total" && (
                <div
                  style={{
                    fontSize: 14,
                    color: "#E24B4A",
                    padding: "12px 14px",
                    background: "rgba(226,75,74,0.1)",
                    borderRadius: 8,
                    marginBottom: 12
                  }}
                >
                  本题块配置为「题块总分」模式，请使用阅卷面板（GradePanel）输入合计分；如需在此面板按题打分，请管理员将本题块评分模式改为「逐题评分」。
                </div>
              )}

              <div className="online-review-score-grid">
                {current.questionNumbers.map((qNum) => {
                  const num = Number(qNum);
                  if (!Number.isFinite(num)) return null;
                  return (
                    <label key={num} className="online-review-score-row">
                      <span>第 {num} 题</span>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={scoreEdits[num] ?? ""}
                        onChange={(e) => setScoreEdits((prev) => ({ ...prev, [num]: e.target.value }))}
                      />
                    </label>
                  );
                })}
              </div>

              <div className="online-review-actions">
                <button className="primary-button" type="button" disabled={saving || scoringMode === "block_total"} onClick={() => void submitCurrent("reviewed", true)}>
                  {saving ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                  保存并下一份
                </button>
                <button className="ghost-button" type="button" disabled={saving || scoringMode === "block_total"} onClick={() => void submitCurrent("reviewed", false)}>
                  仅保存
                </button>
                <button className="ghost-button" type="button" disabled={saving || scoringMode === "block_total"} onClick={() => void submitCurrent("disputed", false)}>
                  标记争议
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
