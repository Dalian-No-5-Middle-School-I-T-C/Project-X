import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, Inbox, Loader2, RefreshCw
} from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import {
  resolveScoringMode,
  type ClientScoringMode,
  type ConfigFetchResult
} from "../../../../server/services/scoringModeValidator";
import type {
  ReviewBlockCropItem,
  ReviewBlockSummary,
  ReviewPoolSummary,
  ReviewSubmitResult
} from "../../../../shared/types";
import { QuestionScorePad } from "./QuestionScorePad";

interface Props {
  examId: number;
  examName: string;
  classId?: string;
}

export function OnlineReviewPanel({ examId, examName, classId }: Props) {
  const [blocks, setBlocks] = useState<ReviewBlockSummary[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState("");
  const [pool, setPool] = useState<ReviewPoolSummary | null>(null);
  const [queue, setQueue] = useState<ReviewBlockCropItem[]>([]);
  const [index, setIndex] = useState(0);
  const [scoreEdits, setScoreEdits] = useState<Record<number, string>>({});
  const [scoreMeta, setScoreMeta] = useState<Record<number, { score: number; maxScore: number }>>({});
  /** Issue #173：可选的给分步进（0.5 / 1），默认 1 */
  const [step, setStep] = useState<0.5 | 1>(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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

  /** 仅刷新试卷池汇总（不重置队列） */
  const loadPoolSummary = useCallback(async () => {
    if (!selectedBlockId) {
      setPool(null);
      return;
    }
    try {
      const data = await fetchJson<{ ok: boolean; data: { summary: ReviewPoolSummary } }>(
        `/api/review-pool/exams/${examId}/blocks/${encodeURIComponent(selectedBlockId)}?mine=1`
      );
      if (data.ok) setPool(data.data.summary);
    } catch {
      /* 汇总失败时保留上次状态 */
    }
  }, [examId, selectedBlockId]);

  /** Issue #174：队列 = 我领取的试卷；同时刷新试卷池汇总 */
  const loadPool = useCallback(async (preserveIndex = false) => {
    if (!selectedBlockId) {
      setQueue([]);
      setPool(null);
      return;
    }
    setError("");
    try {
      const data = await fetchJson<{
        ok: boolean;
        data: { summary: ReviewPoolSummary; entries: ReviewBlockCropItem[] };
      }>(`/api/review-pool/exams/${examId}/blocks/${encodeURIComponent(selectedBlockId)}?mine=1`);
      if (data.ok) {
        setPool(data.data.summary);
        setQueue(data.data.entries);
        if (!preserveIndex) setIndex(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载试卷池失败");
      setQueue([]);
    }
  }, [examId, selectedBlockId]);

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
    void loadPool();
  }, [loadPool]);

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
        const meta: Record<number, { score: number; maxScore: number }> = {};
        for (const qNum of current.questionNumbers) {
          const num = Number(qNum);
          if (!Number.isFinite(num)) continue;
          const row = detail.questionScores.find((item) => item.question_number === num);
          initial[num] = row != null ? String(row.score) : "";
          if (row != null) meta[num] = { score: row.score, maxScore: row.max_score };
        }
        setScoreEdits(initial);
        setScoreMeta(meta);
      } catch {
        if (!cancelled) {
          setScoreEdits({});
          setScoreMeta({});
        }
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

  useEffect(() => {
    if (!selectedBlock?.hasHalfPoint) setStep(1);
  }, [selectedBlockId, selectedBlock?.hasHalfPoint]);

  /** Issue #174：从试卷池领取下一份（支持按班级领取） */
  async function claimNext() {
    if (claiming || !selectedBlockId || !pool || pool.inPoolCount === 0) return;
    setClaiming(true);
    setError("");
    setMessage("");
    try {
      const body: Record<string, unknown> = {};
      if (classId) body.classId = Number(classId);
      const res = await fetchJson<{ ok: boolean; data?: ReviewBlockCropItem; error?: string }>(
        `/api/review-pool/exams/${examId}/blocks/${encodeURIComponent(selectedBlockId)}/claim`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      );
      if (!res.ok || !res.data) throw new Error(res.error ?? "领卷失败");
      setQueue([...queue, res.data!]);
      setIndex(queue.length);
      setMessage(`已领取：${res.data.studentName ?? res.data.studentNumber ?? "学生"}`);
      await loadPoolSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "领卷失败");
      await loadPoolSummary();
    } finally {
      setClaiming(false);
    }
  }

  /** 释放当前试卷回池（本人领取的） */
  async function releaseCurrent() {
    if (!current) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/review-pool/exams/${examId}/blocks/${encodeURIComponent(selectedBlockId)}/crops/${encodeURIComponent(current.id)}/release`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }
      );
      if (!res.ok) throw new Error(res.error ?? "释放失败");
      setQueue((prev) => prev.filter((item) => item.id !== current.id));
      setIndex((prev) => Math.max(0, prev - 1));
      setMessage("已释放回试卷池");
      await loadPoolSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "释放失败");
    } finally {
      setSaving(false);
    }
  }

  async function submitCurrent(status: "reviewed" | "disputed" = "reviewed", advance = true) {
    if (!current || !current.studentId) return;
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
      await loadPool();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
      await loadPoolSummary();
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
        <p>请先完成阅卷识别。识别成功后会自动按大题生成作答图片切块，供网上阅卷使用。</p>
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
            {pool && (
              <>
                <span className="hint">
                  <Inbox size={13} style={{ verticalAlign: -2, marginRight: 3 }} />
                  池中可领 {pool.inPoolCount}
                </span>
                <span className="hint">我已领 {pool.myClaimedCount}</span>
                <span className="hint">已阅 {pool.reviewedCount}/{pool.totalCount}</span>
                {pool.pendingCount > 0 && <span className="hint">待复核 {pool.pendingCount}</span>}
                {pool.disputedCount > 0 && <span className="hint" style={{ color: "#A32D2D" }}>争议 {pool.disputedCount}</span>}
              </>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              className="primary-button"
              type="button"
              disabled={claiming || !pool || pool.inPoolCount === 0}
              onClick={() => void claimNext()}
            >
              {claiming ? <Loader2 size={14} className="spin" /> : <Inbox size={14} />}
              {claiming ? "领取中..." : "领取下一份"}
            </button>
            <button className="ghost-button" type="button" onClick={() => void loadPool()}>
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
        </div>

        {selectedBlock && (
          <span className="hint">
            {selectedBlock.blockTitle} · 已阅 {selectedBlock.reviewedCount}/{selectedBlock.totalCount}
          </span>
        )}

        {error && <p className="login-error">{error}</p>}
        {message && <p className="hint" style={{ color: "var(--success)" }}>{message}</p>}

        {!current ? (
          <div className="scores-empty" style={{ minHeight: 280 }}>
            <Inbox size={36} />
            <h2>当前无已领取试卷</h2>
            <p>点击「领取下一份」从试卷池领取试卷；试卷领取后仅供本人批阅，避免同时批阅冲突。</p>
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
              {scoringMode === "unknown" && (
                <div
                  style={{
                    fontSize: 13,
                    color: "#B45309",
                    padding: "10px 14px",
                    background: "rgba(245,158,11,0.12)",
                    borderRadius: 8,
                    marginBottom: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 10
                  }}
                >
                  <span style={{ flex: 1 }}>
                    ⚠ 题块配置加载失败{configLoadError ? `（${configLoadError}）` : ""}，未能确认评分模式。
                    本次提交将按当前页面输入（逐题）发送，服务端校验兜底；若被拒绝请重试或联系管理员。
                  </span>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => void loadBlockConfig()}
                    style={{ fontSize: 12, padding: "4px 10px" }}
                  >
                    重试加载
                  </button>
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>给分步进：</span>
                <button
                  type="button"
                  disabled={!selectedBlock?.hasHalfPoint}
                  onClick={() => setStep(1)}
                  style={{
                    minHeight: 28,
                    padding: "3px 12px",
                    fontSize: 13,
                    borderRadius: 7,
                    border: step === 1 ? "2px solid var(--primary)" : "1px solid var(--border)",
                    background: step === 1 ? "var(--primary)" : "var(--surface)",
                    color: step === 1 ? "#fff" : "var(--text-primary)",
                    cursor: !selectedBlock?.hasHalfPoint ? "default" : "pointer",
                    opacity: !selectedBlock?.hasHalfPoint ? 0.55 : 1,
                  }}
                >
                  1 分
                </button>
                <button
                  type="button"
                  disabled={!selectedBlock?.hasHalfPoint}
                  onClick={() => setStep(0.5)}
                  style={{
                    minHeight: 28,
                    padding: "3px 12px",
                    fontSize: 13,
                    borderRadius: 7,
                    border: step === 0.5 ? "2px solid var(--primary)" : "1px solid var(--border)",
                    background: step === 0.5 ? "var(--primary)" : "var(--surface)",
                    color: step === 0.5 ? "#fff" : "var(--text-primary)",
                    cursor: !selectedBlock?.hasHalfPoint ? "default" : "pointer",
                    opacity: !selectedBlock?.hasHalfPoint ? 0.55 : 1,
                  }}
                >
                  0.5 分
                </button>
                {!selectedBlock?.hasHalfPoint && (
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>本题块未启用 0.5 分</span>
                )}
              </div>

              <div className="online-review-score-grid">
                {current.questionNumbers.map((qNum) => {
                  const num = Number(qNum);
                  if (!Number.isFinite(num)) return null;
                  return (
                    <div key={num} className="online-review-score-row">
                      <span>第 {num} 题</span>
                      <QuestionScorePad
                        maxScore={scoreMeta[num]?.maxScore ?? 0}
                        step={step}
                        value={scoreEdits[num] ?? ""}
                        onChange={(value) => setScoreEdits((prev) => ({ ...prev, [num]: value }))}
                        disabled={saving}
                      />
                    </div>
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
                <button className="ghost-button" type="button" disabled={saving} onClick={() => void releaseCurrent()}>
                  释放回池
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
