import React, { useState, useEffect, useCallback } from "react";
import { fetchJson } from "../auth/api";
import type { BlockGradingConfig, ArbitratorCandidate } from "../../../../shared/types";

interface Props {
  examId: number;
}

export function GradingConfigPage({ examId }: Props) {
  const [blocks, setBlocks] = useState<Array<{ blockId: string; blockTitle: string }>>([]);
  const [configs, setConfigs] = useState<Record<string, BlockGradingConfig>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBatch, setShowBatch] = useState(false);
  const [batchThreshold, setBatchThreshold] = useState("");
  const [batchRounding, setBatchRounding] = useState("");
  const [batchHasHalf, setBatchHasHalf] = useState("");
  const [loading, setLoading] = useState(true);
  const [arbitrators, setArbitrators] = useState<ArbitratorCandidate[]>([]);

  // v1.9.4 设置重构：本场考试的「网阅默认」模板（block_id='__default__'）
  const [defThreshold, setDefThreshold] = useState("2");
  const [defRounding, setDefRounding] = useState("ceil");
  const [defHasHalf, setDefHasHalf] = useState("0");
  const [defAutoReassign, setDefAutoReassign] = useState(true);
  const [defWorkload, setDefWorkload] = useState("4");
  const [savingDefault, setSavingDefault] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 获取题块
      const blockRes = await fetchJson<{ ok: boolean; data: any[] }>(
        `/api/review/exams/${examId}/blocks`
      );
      if (blockRes.ok) {
        setBlocks(blockRes.data.map((b: any) => ({ blockId: b.blockId, blockTitle: b.blockTitle || b.blockId })));

        // 获取配置
        const configRes = await fetchJson<{ ok: boolean; data: BlockGradingConfig[] }>(
          `/api/block-grading-config/exams/${examId}`
        );
        if (configRes.ok) {
          const map: Record<string, BlockGradingConfig> = {};
          for (const c of configRes.data) map[c.blockId] = c;
          setConfigs(map);
          // 初始化「网阅默认」表单
          const d = map["__default__"];
          if (d) {
            setDefThreshold(String(d.disputeThreshold ?? 2));
            setDefRounding(d.rounding ?? "ceil");
            setDefHasHalf(String(d.hasHalfPoint === 1 ? 1 : 0));
            setDefAutoReassign(d.autoReassignNoArb !== 0);
            setDefWorkload(String(d.workloadBalanceThreshold ?? 4));
          }
        }
      }
    } catch { /* silent */ }
    setLoading(false);
  }, [examId]);

  const handleSaveDefault = async () => {
    setSavingDefault(true);
    try {
      await fetchJson(`/api/block-grading-config/exams/${examId}/blocks/__default__`, {
        method: "PUT",
        body: JSON.stringify({
          disputeThreshold: Number(defThreshold) || 2,
          rounding: defRounding,
          hasHalfPoint: Number(defHasHalf),
          autoReassignNoArb: defAutoReassign ? 1 : 0,
          workloadBalanceThreshold: Number(defWorkload) || 4,
        }),
      });
      load();
    } finally {
      setSavingDefault(false);
    }
  };

  useEffect(() => { load(); }, [load]);

  const toggleSelect = (blockId: string) => {
    const next = new Set(selected);
    if (next.has(blockId)) next.delete(blockId);
    else next.add(blockId);
    setSelected(next);
  };

  const selectAll = () => {
    if (selected.size === blocks.length) setSelected(new Set());
    else setSelected(new Set(blocks.map((b) => b.blockId)));
  };

  const handleBatchApply = async () => {
    const blockIds = Array.from(selected);
    if (blockIds.length === 0) return;

    const body: any = { blockIds };
    if (batchThreshold) body.disputeThreshold = Number(batchThreshold);
    if (batchRounding) body.rounding = batchRounding;
    if (batchHasHalf) body.hasHalfPoint = Number(batchHasHalf);

    await fetchJson(`/api/block-grading-config/exams/${examId}/batch`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    setShowBatch(false);
    setBatchThreshold("");
    setBatchRounding("");
    setBatchHasHalf("");
    load();
  };

  if (loading) return <div style={{ padding: 24 }}>加载中...</div>;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>网阅设置</div>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16 }}>
        配置各题块的分差阈值、取整方式和仲裁人。选中多题后可使用批量调整。
      </div>

      {/* v1.9.4 设置重构：本场考试的「网阅默认」模板（此前误放在全局设置） */}
      <div style={{ padding: "14px 16px", background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>网阅默认（新建题块模板）</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
          本场考试新建题块未单独配置时套用以下默认策略；仍可在下方逐题覆盖。
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ fontSize: 13 }}>
            分差阈值
            <input type="number" value={defThreshold} onChange={(e) => setDefThreshold(e.target.value)} style={selectStyle} />
          </label>
          <label style={{ fontSize: 13 }}>
            均衡阈值（份）
            <input type="number" value={defWorkload} onChange={(e) => setDefWorkload(e.target.value)} style={selectStyle} />
          </label>
          <label style={{ fontSize: 13 }}>
            取整方式
            <select value={defRounding} onChange={(e) => setDefRounding(e.target.value)} style={selectStyle}>
              <option value="ceil">向上取整</option>
              <option value="floor">向下取整</option>
              <option value="round">四舍五入</option>
              <option value="half">保留 0.5</option>
              <option value="none">保留小数</option>
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            本题块含 0.5 小数
            <select value={defHasHalf} onChange={(e) => setDefHasHalf(e.target.value)} style={selectStyle}>
              <option value="1">是</option>
              <option value="0">否</option>
            </select>
          </label>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 12 }}>
          <input type="checkbox" checked={defAutoReassign} onChange={(e) => setDefAutoReassign(e.target.checked)} />
          无仲裁人时自动重分配争议/剩余卷
        </label>
        <button
          onClick={() => void handleSaveDefault()}
          disabled={savingDefault}
          style={{ ...smallBtnStyle, background: "#3C3489", color: "#fff", marginTop: 12 }}
        >
          {savingDefault ? "保存中..." : "保存网阅默认"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={selectAll} style={smallBtnStyle}>
          {selected.size === blocks.length ? "取消全选" : "全选"}
        </button>
        <button
          onClick={() => setShowBatch(true)}
          disabled={selected.size === 0}
          style={{ ...smallBtnStyle, background: selected.size > 0 ? "#3C3489" : undefined, color: selected.size > 0 ? "#fff" : undefined }}
        >
          调整选中 ({selected.size})
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blocks.map((block) => {
          const config = configs[block.blockId];
          return (
            <div key={block.blockId} style={{
              display: "flex",
              alignItems: "center",
              padding: "10px 14px",
              background: selected.has(block.blockId) ? "#EEEDFE" : "var(--color-background-secondary)",
              borderRadius: 8,
              border: selected.has(block.blockId) ? "1px solid #AFA9EC" : "0.5px solid var(--color-border-tertiary)",
              gap: 12,
            }}>
              <input
                type="checkbox"
                checked={selected.has(block.blockId)}
                onChange={() => toggleSelect(block.blockId)}
                style={{ width: 18, height: 18 }}
              />
              <div style={{ flex: 1, fontSize: 14 }}>{block.blockTitle}</div>
              <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
                阈值: {config?.disputeThreshold ?? "—"} ·
                取整: {config?.rounding === "ceil" ? "↑" : config?.rounding === "half" ? "0.5" : config?.rounding === "none" ? "—" : config?.rounding ?? "—"} ·
                0.5: {config?.hasHalfPoint === 1 ? "是" : config?.hasHalfPoint === 0 ? "否" : "—"} ·
                仲裁: {config?.arbitratorId ? `教师${config.arbitratorId}` : "未指定"}
              </div>
            </div>
          );
        })}
      </div>

      {/* 批量调整弹窗 */}
      {showBatch && (
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
            minWidth: 300,
          }}>
            <div style={{ fontWeight: 500, marginBottom: 16 }}>调整 {selected.size} 道题的设置</div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 13 }}>分差阈值</label>
              <select value={batchThreshold} onChange={(e) => setBatchThreshold(e.target.value)} style={selectStyle}>
                <option value="">不修改</option>
                <option value="1">1 分</option>
                <option value="2">2 分</option>
                <option value="3">3 分</option>
                <option value="5">5 分</option>
                <option value="10">10 分</option>
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13 }}>取整方式</label>
              <select value={batchRounding} onChange={(e) => setBatchRounding(e.target.value)} style={selectStyle}>
                <option value="">不修改</option>
                <option value="ceil">向上取整</option>
                <option value="floor">向下取整</option>
                <option value="round">四舍五入</option>
                <option value="half">保留 0.5</option>
                <option value="none">保留小数</option>
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13 }}>本题块含 0.5 小数</label>
              <select value={batchHasHalf} onChange={(e) => setBatchHasHalf(e.target.value)} style={selectStyle}>
                <option value="">不修改</option>
                <option value="1">是（启用手写 0.5 评分）</option>
                <option value="0">否</option>
              </select>
            </div>

            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
              将覆盖: {Array.from(selected).map((id) => blocks.find((b) => b.blockId === id)?.blockTitle ?? id).join(", ")}
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowBatch(false)} style={smallBtnStyle}>取消</button>
              <button onClick={handleBatchApply} style={{ ...smallBtnStyle, background: "#3C3489", color: "#fff" }}>
                确认修改
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const smallBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 13,
  borderRadius: 6,
  border: "0.5px solid var(--color-border-primary)",
  background: "var(--color-background-secondary)",
  cursor: "pointer",
};

const selectStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "8px",
  border: "1px solid var(--color-border-primary)",
  borderRadius: 6,
  fontSize: 13,
  background: "var(--color-background-secondary)",
};
