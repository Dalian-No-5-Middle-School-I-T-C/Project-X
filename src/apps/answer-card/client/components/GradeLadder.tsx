import { useCallback, useEffect, useState } from "react";
import { Power, RefreshCw, TrendingUp } from "lucide-react";
import { fetchJson } from "../auth/api";
import { useAuth } from "../auth/AuthContext";
import type { LadderResponse, ExamFilterItem, ExamGroupFilterItem } from "../../../../shared/types";
import {
  Button,
  EmptyState,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  notify,
} from "./ui/v2";
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
      notify.error(msg);
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
    return <EmptyState icon={<TrendingUp />} title="加载中…" />;
  }

  // 天梯关闭且非管理员
  if (blocked) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={<Power />}
          title="成绩天梯暂未开放"
          description="管理员已关闭天梯功能，开放后可在此查看年级前十名榜单。"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 管理员开关 */}
      {isAdmin && (
        <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-card px-4 py-3">
          <span className="text-sm text-muted-foreground">
            {ladderEnabled ? "成绩天梯已开放" : "成绩天梯已关闭（仅管理员可见）"}
          </span>
          <Button
            variant={ladderEnabled ? "outline" : "primary"}
            size="sm"
            icon={<Power size={14} />}
            onClick={() => void toggleLadder()}
            disabled={toggling}
          >
            {toggling ? "..." : ladderEnabled ? "关闭" : "开启"}
          </Button>
        </div>
      )}

      {/* 范围选择器 */}
      <SegmentedControl
        aria-label="天梯榜单范围"
        value={scope}
        onValueChange={changeScope}
        items={[
          { value: "single", label: "单场考试" },
          { value: "group", label: "大考组" },
          { value: "cross", label: "跨考累计" },
        ]}
      />

      {/* 次级选择器 */}
      <div className="flex flex-wrap items-center gap-2">
        {scope === "single" && (
          <Select
            value={selectedExamId?.toString() ?? ""}
            onValueChange={(v) => setSelectedExamId(v ? Number(v) : null)}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="请选择考试" />
            </SelectTrigger>
            <SelectContent>
              {exams.map((e) => (
                <SelectItem key={e.id} value={e.id.toString()}>
                  {e.name}
                  {e.subject ? ` (${e.subject})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {scope === "group" && (
          <Select
            value={selectedGroupId?.toString() ?? ""}
            onValueChange={(v) => setSelectedGroupId(v ? Number(v) : null)}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="请选择大考组" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id.toString()}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {scope === "cross" && (
          <Select
            value={crossMode}
            onValueChange={(v) => setCrossMode(v as "week" | "selected" | "group")}
          >
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">按日期包</SelectItem>
              <SelectItem value="selected">手动选择</SelectItem>
              <SelectItem value="group">大考组模式</SelectItem>
            </SelectContent>
          </Select>
        )}

        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={14} />}
          onClick={loadLadder}
          disabled={busy}
        >
          刷新
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">
          {error}
        </div>
      )}

      {/* 统计栏 */}
      {data && hasSelection && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3">
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {data.studentCount}
            </span>
            <span className="text-xs text-muted-foreground">参与人数</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3">
            {data.myRank != null ? (
              <>
                <span className="text-lg font-semibold tabular-nums text-foreground">
                  第 {data.myRank} 名
                </span>
                <span className="text-xs text-muted-foreground">你的排名</span>
              </>
            ) : (
              <>
                <span className="text-lg font-semibold tabular-nums text-foreground">—</span>
                <span className="text-xs text-muted-foreground">
                  {data.studentCount > 0 ? "未参加" : "暂无数据"}
                </span>
              </>
            )}
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3">
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {data.myScore != null ? `${data.myScore} 分` : "—"}
            </span>
            <span className="text-xs text-muted-foreground">你的总分</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3">
            <span className="text-lg font-semibold text-foreground">{data.scopeName}</span>
            <span className="text-xs text-muted-foreground">当前榜单</span>
          </div>
        </div>
      )}

      {/* 前十名阶梯榜单 */}
      {busy && <EmptyState icon={<TrendingUp />} title="加载中…" />}

      {!busy && !hasSelection && (
        <EmptyState
          icon={<TrendingUp />}
          title="年级前十名"
          description="请在上方选择考试范围，查看年级前十名榜单。"
        />
      )}

      {!busy && hasSelection && data && data.rows.length === 0 && (
        <EmptyState
          icon={<TrendingUp />}
          title="暂无排名数据"
          description="该范围内暂无成绩记录。"
        />
      )}

      {!busy && data && data.rows.length > 0 && <LadderLeaderboard rows={data.rows} />}
    </div>
  );
}
