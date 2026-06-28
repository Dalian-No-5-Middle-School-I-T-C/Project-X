import { useCallback, useEffect, useState } from "react";
import { Power, RefreshCw, TrendingUp } from "lucide-react";
import { fetchJson } from "../auth/api";
import { useAuth } from "../auth/AuthContext";
import type { LadderResponse, ExamFilterItem, ExamGroupFilterItem } from "../../../../shared/types";
import { LadderLeaderboard } from "./LadderLeaderboard";

type Scope = "single" | "group" | "cross";

interface LadderConfig {
  enabled: boolean;
}

export function GradeLadder() {
  const { isAdmin } = useAuth();

  const [scope, setScope] = useState<Scope>("single");
  const [data, setData] = useState<LadderResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 切换范围时清空旧数据
  function changeScope(next: Scope) {
    if (next !== scope) {
      setData(null);
      setError("");
    }
    setScope(next);
  }

  // 考试列表
  const [exams, setExams] = useState<ExamFilterItem[]>([]);
  const [groups, setGroups] = useState<ExamGroupFilterItem[]>([]);

  // 当前选择
  const [selectedExamId, setSelectedExamId] = useState<number | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [crossMode, setCrossMode] = useState<"week" | "selected" | "group">("week");

  // 天梯开关
  const [ladderEnabled, setLadderEnabled] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);

  // 获取开关状态
  const loadConfig = useCallback(async () => {
    try {
      const cfg = await fetchJson<LadderConfig>("/api/ladder/config");
      setLadderEnabled(cfg.enabled);
    } catch {
      setLadderEnabled(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // 加载可用列表
  const loadExams = useCallback(async () => {
    try {
      const list = await fetchJson<ExamFilterItem[]>("/api/exams");
      setExams(Array.isArray(list) ? list : []);
    } catch {
      setExams([]);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      const list = await fetchJson<ExamGroupFilterItem[]>("/api/exam-groups");
      setGroups(Array.isArray(list) ? list : []);
    } catch {
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    loadExams();
    loadGroups();
  }, [loadExams, loadGroups]);

  // 加载天梯数据
  const loadLadder = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      let url = "";
      if (scope === "single" && selectedExamId) {
        url = `/api/ladder/exams/${selectedExamId}`;
      } else if (scope === "group" && selectedGroupId) {
        url = `/api/ladder/exam-groups/${selectedGroupId}`;
      } else if (scope === "cross") {
        url = `/api/ladder/cross-exam?mode=${crossMode}`;
      } else {
        setBusy(false);
        return;
      }
      const resp = await fetchJson<LadderResponse>(url);
      setData(resp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "加载天梯数据失败";
      // 如果是天梯关闭的 403，后端已返回 message
      setError(msg);
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [scope, selectedExamId, selectedGroupId, crossMode]);

  useEffect(() => {
    if (ladderEnabled || isAdmin) {
      loadLadder();
    }
  }, [loadLadder, ladderEnabled, isAdmin]);

  // 管理员切换开关
  async function toggleLadder() {
    setToggling(true);
    try {
      const newVal = !ladderEnabled;
      await fetchJson<LadderConfig>("/api/ladder/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newVal }),
      });
      setLadderEnabled(newVal);
    } catch {
      // ignore
    } finally {
      setToggling(false);
    }
  }

  const hasSelection =
    (scope === "single" && selectedExamId != null) ||
    (scope === "group" && selectedGroupId != null) ||
    scope === "cross";

  // 是否因关闭而阻止数据加载（管理员不受限）
  const blocked = !ladderEnabled && !isAdmin;

  // 配置加载中
  if (ladderEnabled === null) {
    return (
      <div className="scores-empty">
        <TrendingUp size={40} />
        <h2>加载中...</h2>
      </div>
    );
  }

  // 天梯关闭且非管理员
  if (blocked) {
    return (
      <div className="ladder-container">
        <div className="scores-empty">
          <Power size={40} />
          <h2>成绩天梯暂未开放</h2>
          <p>管理员已关闭天梯功能，开放后可在此查看年级前十名榜单。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ladder-container">
      {/* 管理员开关 */}
      {isAdmin && (
        <div className="ladder-admin-bar">
          <span className="ladder-admin-label">
            {ladderEnabled ? "成绩天梯已开放" : "成绩天梯已关闭（仅管理员可见）"}
          </span>
          <button
            type="button"
            className={`ladder-toggle-btn ${ladderEnabled ? "ladder-toggle-off" : ""}`}
            onClick={toggleLadder}
            disabled={toggling}
          >
            <Power size={14} /> {toggling ? "..." : ladderEnabled ? "关闭" : "开启"}
          </button>
        </div>
      )}

      {/* 范围选择器 */}
      <div className="ladder-scope-selector">
        <button
          type="button"
          className={`ladder-scope-btn ${scope === "single" ? "active" : ""}`}
          onClick={() => changeScope("single")}
        >
          单场考试
        </button>
        <button
          type="button"
          className={`ladder-scope-btn ${scope === "group" ? "active" : ""}`}
          onClick={() => changeScope("group")}
        >
          大考组
        </button>
        <button
          type="button"
          className={`ladder-scope-btn ${scope === "cross" ? "active" : ""}`}
          onClick={() => changeScope("cross")}
        >
          跨考累计
        </button>
      </div>

      {/* 次级选择器 */}
      <div className="ladder-sub-selector">
        {scope === "single" && (
          <select
            className="ladder-select"
            value={selectedExamId ?? ""}
            onChange={(e) => setSelectedExamId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">请选择考试</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} {e.subject ? `(${e.subject})` : ""}
              </option>
            ))}
          </select>
        )}

        {scope === "group" && (
          <select
            className="ladder-select"
            value={selectedGroupId ?? ""}
            onChange={(e) => setSelectedGroupId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">请选择大考组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}

        {scope === "cross" && (
          <select
            className="ladder-select"
            value={crossMode}
            onChange={(e) => setCrossMode(e.target.value as "week" | "selected" | "group")}
          >
            <option value="week">按日期包</option>
            <option value="selected">手动选择</option>
            <option value="group">大考组模式</option>
          </select>
        )}

        <button type="button" className="ghost-button" onClick={loadLadder} disabled={busy}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {error && <p className="login-error">{error}</p>}

      {/* 统计栏 */}
      {data && hasSelection && (
        <div className="ladder-stats">
          <div className="ladder-stat-item">
            <span className="ladder-stat-value">{data.studentCount}</span>
            <span className="ladder-stat-label">参与人数</span>
          </div>
          <div className="ladder-stat-item">
            {data.myRank != null ? (
              <>
                <span className="ladder-stat-value">第 {data.myRank} 名</span>
                <span className="ladder-stat-label">你的排名</span>
              </>
            ) : (
              <>
                <span className="ladder-stat-value">—</span>
                <span className="ladder-stat-label">
                  {data.studentCount > 0 ? "未参加" : "暂无数据"}
                </span>
              </>
            )}
          </div>
          <div className="ladder-stat-item">
            <span className="ladder-stat-value">
              {data.myScore != null ? `${data.myScore} 分` : "—"}
            </span>
            <span className="ladder-stat-label">你的总分</span>
          </div>
          <div className="ladder-stat-item">
            <span className="ladder-stat-value">{data.scopeName}</span>
            <span className="ladder-stat-label">当前榜单</span>
          </div>
        </div>
      )}

      {/* 前十名阶梯榜单 */}
      {busy && (
        <div className="scores-empty">
          <TrendingUp size={40} />
          <h2>加载中...</h2>
        </div>
      )}

      {!busy && !hasSelection && (
        <div className="scores-empty">
          <TrendingUp size={40} />
          <h2>年级前十名</h2>
          <p>请在上方选择考试范围，查看年级前十名榜单。</p>
        </div>
      )}

      {!busy && hasSelection && data && data.rows.length === 0 && (
        <div className="scores-empty">
          <TrendingUp size={40} />
          <h2>暂无排名数据</h2>
          <p>该范围内暂无成绩记录。</p>
        </div>
      )}

      {!busy && data && data.rows.length > 0 && <LadderLeaderboard rows={data.rows} />}
    </div>
  );
}
