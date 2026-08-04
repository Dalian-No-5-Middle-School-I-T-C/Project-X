import React, { useState, useEffect, useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { DisputeItem, ArbitratorCandidate } from "../../../../shared/types";

interface Props {
  examId: number;
}

export function DisputeManagePage({ examId }: Props) {
  const [disputes, setDisputes] = useState<DisputeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDispute, setSelectedDispute] = useState<DisputeItem | null>(null);
  const [arbitrators, setArbitrators] = useState<ArbitratorCandidate[]>([]);
  const [resolutionScore, setResolutionScore] = useState("");

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
    const excludedIds = new Set<number>();
    const dispute = disputes.find((d) => d.blockId === blockId);
    if (dispute) {
      // 简单收集已评审教师
    }
    const res = await fetchJson<{ ok: boolean; data: ArbitratorCandidate[] }>(
      `/api/review-arbitration/exams/${examId}/blocks/${encodeURIComponent(blockId)}/arbitrators`
    );
    if (res.ok) setArbitrators(res.data);
  };

  const handleResolve = async (cropId: string) => {
    if (!resolutionScore) return;
    await fetchJson(`/api/review-arbitration/crops/${encodeURIComponent(cropId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ score: Number(resolutionScore) }),
    });
    setSelectedDispute(null);
    setResolutionScore("");
    load();
  };

  if (loading) return <div style={{ padding: 24 }}>加载中...</div>;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 16 }}>争议管理 ({disputes.length})</div>

      {disputes.length === 0 ? (
        <div style={{ color: "var(--color-text-tertiary)" }}>暂无争议卷</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {disputes.map((d) => (
            <div key={d.cropId} style={{
              padding: "12px 16px",
              background: d.status === "pending" ? "rgba(226,75,74,0.05)" : "var(--color-background-secondary)",
              borderRadius: 8,
              border: d.status === "pending" ? "1px solid #f09595" : "0.5px solid var(--color-border-tertiary)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontWeight: 500 }}>{d.studentName}</span>
                  <span style={{ fontSize: 12, color: "var(--color-text-secondary)", marginLeft: 8 }}>
                    {d.studentNumber} · {d.blockTitle}
                  </span>
                </div>
                <div style={{ fontSize: 13 }}>
                  分差: <span style={{ color: "#E24B4A", fontWeight: 500 }}>{d.scoreDiff}</span> / 阈值 {d.threshold}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
                {d.scores.map((s, i) => (
                  <span key={i} style={{ marginRight: 12 }}>{s.reviewerName}: {s.score}分</span>
                ))}
                {d.arbitratorName && <span style={{ color: "#639922" }}>仲裁: {d.arbitratorName}</span>}
                {!d.arbitratorName && d.status === "pending" && (
                  <span style={{ color: "#E24B4A", display: "inline-flex", alignItems: "center", gap: 4 }}><AlertTriangle size={14} aria-hidden="true" /> 搁置中</span>
                )}
              </div>
              {d.status === "pending" && (
                <button
                  onClick={() => { setSelectedDispute(d); loadArbitrators(d.blockId); }}
                  style={{ marginTop: 8, ...actionBtnStyle }}
                >
                  处理
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 处理弹窗 */}
      {selectedDispute && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
        }}>
          <div style={{
            background: "var(--color-background-primary)",
            borderRadius: 12,
            padding: 24,
            minWidth: 360,
            maxWidth: 480,
          }}>
            <div style={{ fontWeight: 500, marginBottom: 16 }}>
              仲裁 — {selectedDispute.studentName} · {selectedDispute.blockTitle}
            </div>
            <div style={{ marginBottom: 12 }}>
              {selectedDispute.scores.map((s, i) => (
                <div key={i} style={{ fontSize: 14 }}>{s.reviewerName}: {s.score}分</div>
              ))}
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>最终分</label>
              <input
                type="number"
                value={resolutionScore}
                onChange={(e) => setResolutionScore(e.target.value)}
                style={{ ...inputStyle, width: "100%", marginTop: 4 }}
                step={0.5}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setSelectedDispute(null)} style={actionBtnStyle}>取消</button>
              <button
                onClick={() => handleResolve(selectedDispute.cropId)}
                style={{ ...actionBtnStyle, background: "#3C3489", color: "#fff" }}
              >
                提交仲裁
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 13,
  borderRadius: 6,
  border: "0.5px solid var(--color-border-primary)",
  background: "var(--color-background-secondary)",
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--color-border-primary)",
  borderRadius: 6,
  fontSize: 14,
};
