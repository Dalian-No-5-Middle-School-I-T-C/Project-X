/**
 * 跨班深度对比：概况柱状图 + 班级汇总表 + 题目得分率矩阵 + 知识点矩阵。
 * 数据来自 GET /api/analysis/exams/:examId/class-compare
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Columns2, RefreshCw } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { CrossClassDeepCompareResponse } from "../../../../shared/types";
import { ComparisonBar } from "./AnalysisCharts";

interface Props {
  examId: number;
  /** 可选：从父级传入的默认基准班级 */
  initialBaselineClassId?: string;
}

const thS: CSSProperties = {
  padding: "8px 10px",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
  background: "var(--surface-tint)",
  zIndex: 1
};
const tdS: CSSProperties = { padding: "6px 10px", fontSize: 13, whiteSpace: "nowrap" };

function rateColor(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "var(--muted)";
  if (rate >= 80) return "#3B6D11";
  if (rate >= 60) return "var(--text-primary)";
  if (rate >= 40) return "#B45309";
  return "#A32D2D";
}

function rateBg(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "transparent";
  if (rate >= 80) return "rgba(59, 109, 17, 0.10)";
  if (rate >= 60) return "transparent";
  if (rate >= 40) return "rgba(180, 83, 9, 0.10)";
  return "rgba(163, 45, 45, 0.12)";
}

function formatDelta(value: number | null): { text: string; color: string } {
  if (value == null || value === 0) return { text: "—", color: "var(--muted)" };
  if (value > 0) return { text: `↑+${value}`, color: "#3B6D11" };
  return { text: `↓${value}`, color: "#A32D2D" };
}

export function AnalysisClassCompare({ examId, initialBaselineClassId }: Props) {
  const [data, setData] = useState<CrossClassDeepCompareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedClassIds, setSelectedClassIds] = useState<number[] | null>(null);
  const [baselineClassId, setBaselineClassId] = useState(initialBaselineClassId ?? "");
  const [availableClasses, setAvailableClasses] = useState<Array<{ classId: number; className: string; gradeName?: string }>>([]);

  const load = useCallback(async () => {
    if (selectedClassIds && selectedClassIds.length === 0) {
      setData((prev) => ({
        examId,
        examName: prev?.examName ?? "",
        baselineClassId: baselineClassId !== "" ? Number(baselineClassId) : null,
        classes: [],
        questionMatrix: [],
        knowledgeMatrix: []
      }));
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedClassIds && selectedClassIds.length > 0) {
        params.set("classIds", selectedClassIds.join(","));
      }
      if (baselineClassId !== "") {
        params.set("baselineClassId", baselineClassId);
      }
      const qs = params.toString();
      const result = await fetchJson<CrossClassDeepCompareResponse>(
        `/api/analysis/exams/${examId}/class-compare${qs ? `?${qs}` : ""}`
      );
      setData(result);
      setAvailableClasses((prev) => {
        if (prev.length > 0) return prev;
        return result.classes.map((c) => ({
          classId: c.classId,
          className: c.className,
          gradeName: c.gradeName
        }));
      });
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "加载跨班对比失败");
    } finally {
      setLoading(false);
    }
  }, [examId, selectedClassIds, baselineClassId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 首次拉取考试班级列表（用于多选，即使当前筛选为空也能展示选项）
  useEffect(() => {
    fetchJson<Array<{ classId: number; className: string; gradeName?: string }>>(
      `/api/analysis/exams/${examId}/classes`
    )
      .then((list) => {
        if (list.length > 0) setAvailableClasses(list);
      })
      .catch(() => {});
  }, [examId]);

  const baseline = useMemo(() => {
    if (!data || baselineClassId === "") return null;
    const id = Number(baselineClassId);
    return data.classes.find((c) => c.classId === id) ?? null;
  }, [data, baselineClassId]);

  const chartData = useMemo(() => {
    if (!data || data.classes.length === 0) return null;
    return {
      labels: data.classes.map((c) => c.className),
      datasets: [
        { label: "均分", data: data.classes.map((c) => c.avgScore), color: "#C00F28" },
        { label: "及格率%", data: data.classes.map((c) => c.passRate), color: "#3B82F6" },
        { label: "优秀率%", data: data.classes.map((c) => c.excellentRate), color: "#10B981" }
      ]
    };
  }, [data]);

  function toggleClass(classId: number) {
    setSelectedClassIds((prev) => {
      const current = prev ?? availableClasses.map((c) => c.classId);
      if (current.includes(classId)) {
        const next = current.filter((id) => id !== classId);
        return next.length === 0 ? [] : next;
      }
      return [...current, classId];
    });
  }

  function selectAllClasses() {
    setSelectedClassIds(null);
  }

  const classOptions = availableClasses.length > 0
    ? availableClasses
    : (data?.classes.map((c) => ({ classId: c.classId, className: c.className, gradeName: c.gradeName })) ?? []);

  const activeSelection = selectedClassIds ?? classOptions.map((c) => c.classId);

  return (
    <div className="analysis-section class-compare-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div className="panel-title" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
          <Columns2 size={16} /> 跨班深度对比
        </div>
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
          基准班级
          <select
            value={baselineClassId}
            onChange={(e) => setBaselineClassId(e.target.value)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid var(--line-strong)",
              fontSize: 12,
              background: "var(--surface)",
              cursor: "pointer"
            }}
          >
            <option value="">不设基准</option>
            {classOptions.map((c) => (
              <option key={c.classId} value={String(c.classId)}>
                {(c.gradeName ? `${c.gradeName} — ` : "") + c.className}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--line-strong)",
            background: "var(--surface)",
            fontSize: 12,
            cursor: loading ? "wait" : "pointer",
            color: "var(--text-primary)"
          }}
        >
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      {/* 班级多选 */}
      {classOptions.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>对比班级</span>
          <button
            type="button"
            onClick={selectAllClasses}
            style={{
              padding: "3px 10px",
              borderRadius: 999,
              border: selectedClassIds == null ? "1px solid var(--brand)" : "1px solid var(--line-strong)",
              background: selectedClassIds == null ? "var(--brand-soft)" : "var(--surface)",
              color: selectedClassIds == null ? "var(--brand)" : "var(--text-primary)",
              fontSize: 12,
              cursor: "pointer"
            }}
          >
            全部
          </button>
          {classOptions.map((c) => {
            const active = activeSelection.includes(c.classId);
            return (
              <button
                key={c.classId}
                type="button"
                onClick={() => toggleClass(c.classId)}
                style={{
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: active ? "1px solid var(--brand)" : "1px solid var(--line-strong)",
                  background: active ? "var(--brand-soft)" : "var(--surface)",
                  color: active ? "var(--brand)" : "var(--text-primary)",
                  fontSize: 12,
                  cursor: "pointer"
                }}
              >
                {c.className}
              </button>
            );
          })}
        </div>
      )}

      {loading && !data && (
        <div style={{ textAlign: "center", padding: 32, color: "var(--muted)", fontSize: 13 }}>正在加载跨班对比…</div>
      )}
      {error && (
        <div style={{ padding: 16, color: "#A32D2D", fontSize: 13, background: "rgba(163,45,45,0.06)", borderRadius: 8 }}>
          {error}
        </div>
      )}
      {!loading && data && data.classes.length === 0 && (
        <div style={{ textAlign: "center", padding: 32, color: "var(--muted)", fontSize: 13 }}>暂无可对比的班级成绩</div>
      )}

      {data && data.classes.length > 0 && (
        <>
          {/* 概况柱状图 */}
          {chartData && (
            <div style={{ marginBottom: 20, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--text-secondary)" }}>均分 / 及格率 / 优秀率</div>
              <ComparisonBar data={chartData} height={240} />
            </div>
          )}

          {/* 班级汇总表 */}
          <div style={{ overflowX: "auto", marginBottom: 20 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--line)" }}>
                  <th style={thS}>班级</th>
                  <th style={thS}>人数</th>
                  <th style={thS}>均分</th>
                  {baseline && <th style={thS}>vs {baseline.className}</th>}
                  <th style={thS}>最高</th>
                  <th style={thS}>最低</th>
                  <th style={thS}>中位</th>
                  <th style={thS}>标准差</th>
                  <th style={thS}>及格率</th>
                  <th style={thS}>优秀率</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const byGrade = new Map<string, typeof data.classes>();
                  for (const cs of data.classes) {
                    const grade = cs.gradeName || "无年级";
                    if (!byGrade.has(grade)) byGrade.set(grade, []);
                    byGrade.get(grade)!.push(cs);
                  }
                  const rows: ReactNode[] = [];
                  for (const [grade, list] of byGrade.entries()) {
                    rows.push(
                      <tr key={`g-${grade}`}>
                        <td colSpan={baseline ? 10 : 9} style={{ ...tdS, fontWeight: 600, color: "var(--brand)", background: "var(--bg-soft)", paddingTop: 8, paddingBottom: 8 }}>
                          {grade}
                        </td>
                      </tr>
                    );
                    list.forEach((cs, i) => {
                      const isBaseline = baseline && cs.classId === baseline.classId;
                      const avgDiff = baseline
                        ? Math.round((cs.avgScore - baseline.avgScore) * 10) / 10
                        : null;
                      const delta = formatDelta(isBaseline ? null : avgDiff);
                      rows.push(
                        <tr
                          key={cs.classId}
                          style={{
                            borderTop: "1px solid var(--line-light)",
                            background: isBaseline ? "var(--brand-soft)" : i % 2 === 0 ? "var(--surface)" : "var(--bg-soft)"
                          }}
                        >
                          <td style={{ ...tdS, fontWeight: isBaseline ? 600 : 400 }}>
                            {cs.className}{isBaseline ? " ·基准" : ""}
                          </td>
                          <td style={tdS}>{cs.gradedCount}</td>
                          <td style={{ ...tdS, fontWeight: isBaseline ? 600 : 400 }}>{cs.avgScore}</td>
                          {baseline && (
                            <td style={{ ...tdS, fontWeight: 500, color: delta.color }}>{delta.text}</td>
                          )}
                          <td style={tdS}>{cs.maxScore}</td>
                          <td style={tdS}>{cs.minScore}</td>
                          <td style={tdS}>{cs.scoreSummary?.median ?? "—"}</td>
                          <td style={tdS}>{cs.stdDev}</td>
                          <td style={{ ...tdS, color: rateColor(cs.passRate) }}>{cs.passRate}%</td>
                          <td style={{ ...tdS, color: rateColor(cs.excellentRate) }}>{cs.excellentRate}%</td>
                        </tr>
                      );
                    });
                  }
                  return rows;
                })()}
              </tbody>
            </table>
          </div>

          {/* 题目得分率矩阵 */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--text-secondary)" }}>题目得分率矩阵</div>
            {data.questionMatrix.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--muted)", padding: 12 }}>暂无题目得分数据</div>
            ) : (
              <div style={{ overflowX: "auto", maxHeight: 420, border: "1px solid var(--line)", borderRadius: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, background: "var(--surface)" }}>
                  <thead>
                    <tr>
                      <th style={{ ...thS, left: 0, zIndex: 2, minWidth: 64 }}>题号</th>
                      <th style={thS}>类型</th>
                      <th style={thS}>满分</th>
                      {data.classes.map((c) => (
                        <th key={c.classId} style={thS}>{c.className}</th>
                      ))}
                      {data.classes.length >= 2 && <th style={thS}>班间落差</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.questionMatrix.map((row, idx) => {
                      const rates = data.classes
                        .map((c) => row.byClass[String(c.classId)]?.scoreRate)
                        .filter((v): v is number => v != null);
                      const spread = rates.length >= 2 ? Math.round((Math.max(...rates) - Math.min(...rates)) * 10) / 10 : null;
                      return (
                        <tr key={row.questionNumber} style={{ borderTop: "1px solid var(--line-light)", background: idx % 2 === 0 ? "var(--surface)" : "var(--bg-soft)" }}>
                          <td style={{ ...tdS, fontWeight: 600, position: "sticky", left: 0, background: "inherit", zIndex: 1 }}>{row.questionNumber}</td>
                          <td style={tdS}>{row.questionType}</td>
                          <td style={tdS}>{row.maxScore}</td>
                          {data.classes.map((c) => {
                            const cell = row.byClass[String(c.classId)];
                            const rate = cell?.scoreRate;
                            return (
                              <td
                                key={c.classId}
                                style={{
                                  ...tdS,
                                  textAlign: "center",
                                  fontWeight: 500,
                                  color: rateColor(rate),
                                  background: rateBg(rate)
                                }}
                                title={cell ? `均分 ${cell.avgScore} · 错误率 ${cell.errorRate}%` : undefined}
                              >
                                {rate != null ? `${rate}%` : "—"}
                              </td>
                            );
                          })}
                          {data.classes.length >= 2 && (
                            <td style={{ ...tdS, color: spread != null && spread >= 20 ? "#A32D2D" : "var(--muted)", fontWeight: spread != null && spread >= 20 ? 600 : 400 }}>
                              {spread != null ? `${spread}pp` : "—"}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 知识点矩阵 */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--text-secondary)" }}>知识点得分率对比</div>
            {data.knowledgeMatrix.length === 0 ? (
              <div style={{
                padding: 20,
                textAlign: "center",
                color: "var(--muted)",
                background: "var(--bg-soft)",
                borderRadius: 10,
                border: "1px dashed var(--line-strong)",
                fontSize: 13
              }}>
                本场考试尚未标注知识点 — 上传原卷并完成 AI 知识点分析后可在此对比各班弱项
              </div>
            ) : (
              <div style={{ overflowX: "auto", maxHeight: 360, border: "1px solid var(--line)", borderRadius: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, background: "var(--surface)" }}>
                  <thead>
                    <tr>
                      <th style={{ ...thS, left: 0, zIndex: 2, minWidth: 120 }}>知识点</th>
                      <th style={thS}>题号</th>
                      {data.classes.map((c) => (
                        <th key={c.classId} style={thS}>{c.className}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.knowledgeMatrix.map((row, idx) => (
                      <tr key={row.pointText} style={{ borderTop: "1px solid var(--line-light)", background: idx % 2 === 0 ? "var(--surface)" : "var(--bg-soft)" }}>
                        <td style={{ ...tdS, fontWeight: 500, position: "sticky", left: 0, background: "inherit", zIndex: 1, whiteSpace: "normal", maxWidth: 180 }}>
                          {row.pointText}
                        </td>
                        <td style={{ ...tdS, color: "var(--muted)" }}>{row.questionNumbers || "—"}</td>
                        {data.classes.map((c) => {
                          const cell = row.byClass[String(c.classId)];
                          const rate = cell?.avgRate;
                          return (
                            <td
                              key={c.classId}
                              style={{
                                ...tdS,
                                textAlign: "center",
                                fontWeight: 500,
                                color: rateColor(rate),
                                background: rateBg(rate)
                              }}
                              title={cell ? `${cell.studentCount} 人` : undefined}
                            >
                              {rate != null ? `${rate}%` : "—"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
