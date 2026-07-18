import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, UserPlus } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ReviewAssignment, ReviewBlockSummary } from "../../../../shared/types";

interface Props {
  examId: number;
}

type TeacherOption = { id: number; name: string; subject: string | null };
type AssignmentInput = { teacherId: number; count: number };

export function ReviewAssignPage({ examId }: Props) {
  const [blocks, setBlocks] = useState<ReviewBlockSummary[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState("");
  const [assignments, setAssignments] = useState<ReviewAssignment[]>([]);
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [inputs, setInputs] = useState<AssignmentInput[]>([{ teacherId: 0, count: 0 }]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  // 加载题块列表
  useEffect(() => {
    fetchJson<{ ok: boolean; data: ReviewBlockSummary[] }>(`/api/review/exams/${examId}/blocks`)
      .then((res) => {
        if (res.ok && res.data.length > 0) {
          setBlocks(res.data);
          setSelectedBlockId(res.data[0].blockId);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [examId]);

  // 加载教师列表
  useEffect(() => {
    fetchJson<{ ok: boolean; data: TeacherOption[] }>(`/api/review-assign/exams/${examId}/eligible-teachers`)
      .then((res) => { if (res.ok) setTeachers(res.data); })
      .catch(() => {});
  }, [examId]);

  // 选择题块时加载分配
  const loadAssignments = useCallback((blockId: string) => {
    if (!blockId) return;
    fetchJson<{ ok: boolean; data: ReviewAssignment[] }>(
      `/api/review-assign/exams/${examId}/blocks/${encodeURIComponent(blockId)}`
    ).then((res) => { if (res.ok) setAssignments(res.data); }).catch(() => {});
  }, [examId]);

  useEffect(() => {
    if (selectedBlockId) loadAssignments(selectedBlockId);
  }, [selectedBlockId, loadAssignments]);

  // 更新输入行
  const updateInput = (idx: number, field: "teacherId" | "count", value: number) => {
    const next = [...inputs];
    next[idx] = { ...next[idx], [field]: value };
    setInputs(next);
  };

  // 随机分配
  const handleCreate = async () => {
    const valid = inputs.filter((i) => i.teacherId > 0 && i.count > 0);
    if (valid.length === 0 || !selectedBlockId) return;

    const teacherCounts: Record<number, number> = {};
    for (const i of valid) teacherCounts[i.teacherId] = i.count;

    setSaving(true);
    setMsg("");
    try {
      const res = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/review-assign/exams/${examId}/blocks/${encodeURIComponent(selectedBlockId)}`,
        { method: "POST", body: JSON.stringify({ teacherCounts }) }
      );
      if (res.ok) {
        setMsg("✅ 分配成功！系统已随机分配学生");
        setInputs([{ teacherId: 0, count: 0 }]);
        loadAssignments(selectedBlockId);
      } else {
        setMsg(res.error || "分配失败");
      }
    } catch (err: any) {
      setMsg(err.message || "网络错误");
    }
    setSaving(false);
  };

  // 删除分配
  const handleDelete = async (id: number) => {
    await fetchJson(`/api/review-assign/${id}`, { method: "DELETE" });
    loadAssignments(selectedBlockId);
  };

  const totalAssigned = assignments.reduce((s, a) => s + a.studentCount, 0);

  if (loading) return <div style={{ padding: 24 }}>加载中...</div>;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 16 }}>
        阅卷任务分配
        <button onClick={() => loadAssignments(selectedBlockId)} style={{ ...iconBtn, marginLeft: 8 }}>
          <RefreshCw size={14} />
        </button>
      </div>

      {/* 题块选择 */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>选择题块</label>
        <select
          value={selectedBlockId}
          onChange={(e) => setSelectedBlockId(e.target.value)}
          style={selectStyle}
        >
          {blocks.map((b) => (
            <option key={b.blockId} value={b.blockId}>
              {b.blockTitle} （待批 {b.pendingCount}/{b.totalCount}）
            </option>
          ))}
        </select>
        {selectedBlockId && (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
            已分配 {totalAssigned} 份
          </div>
        )}
      </div>

      {/* 已有分配 */}
      {assignments.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>当前分配</div>
          {assignments.map((a) => (
            <div key={a.id} style={rowStyle}>
              <span style={{ flex: 1 }}>{a.teacherName ?? `教师${a.teacherId}`}</span>
              <span style={{ marginRight: 16, color: "var(--color-text-secondary)" }}>{a.studentCount} 份</span>
              <button onClick={() => handleDelete(a.id)} style={smallRedBtn}>删除</button>
            </div>
          ))}
        </div>
      )}

      {/* 新建分配 */}
      <div style={{ borderTop: "0.5px solid var(--color-border-primary)", paddingTop: 16 }}>
        <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 12 }}>新建分配</div>

        {inputs.map((input, idx) => (
          <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <select
              value={input.teacherId}
              onChange={(e) => updateInput(idx, "teacherId", Number(e.target.value))}
              style={{ ...selectStyle, width: 180 }}
            >
              <option value={0}>选择教师...</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.subject ? ` (${t.subject})` : ""}</option>
              ))}
            </select>
            <input
              type="number"
              placeholder="份数"
              min={1}
              value={input.count || ""}
              onChange={(e) => updateInput(idx, "count", Number(e.target.value))}
              style={numInputStyle}
            />
            {inputs.length > 1 && (
              <button onClick={() => setInputs(inputs.filter((_, i) => i !== idx))} style={smallRedBtn}>×</button>
            )}
          </div>
        ))}

        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            onClick={() => setInputs([...inputs, { teacherId: 0, count: 0 }])}
            style={actionBtn}
          >
            <UserPlus size={14} /> 添加教师
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !selectedBlockId}
            style={{ ...actionBtn, background: "#3C3489", color: "#fff", border: "none" }}
          >
            {saving ? "分配中..." : "🎲 随机分配"}
          </button>
        </div>

        {msg && (
          <div style={{
            marginTop: 12,
            fontSize: 13,
            padding: "8px 12px",
            borderRadius: 6,
            background: msg.includes("✅") ? "rgba(99,153,34,0.1)" : "rgba(226,75,74,0.1)",
            color: msg.includes("✅") ? "#639922" : "#E24B4A",
          }}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--color-border-primary)",
  borderRadius: 6,
  fontSize: 13,
  background: "var(--color-background-secondary)",
};

const numInputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--color-border-primary)",
  borderRadius: 6,
  fontSize: 13,
  width: 80,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "8px 12px",
  background: "var(--color-background-secondary)",
  borderRadius: 6,
  marginBottom: 6,
  fontSize: 14,
};

const actionBtn: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  borderRadius: 6,
  border: "0.5px solid var(--color-border-primary)",
  background: "var(--color-background-secondary)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const smallRedBtn: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 12,
  color: "#E24B4A",
  border: "1px solid #f09595",
  borderRadius: 4,
  background: "transparent",
  cursor: "pointer",
};

const iconBtn: React.CSSProperties = {
  padding: "2px 6px",
  border: "none",
  background: "none",
  cursor: "pointer",
  color: "var(--color-text-secondary)",
};
