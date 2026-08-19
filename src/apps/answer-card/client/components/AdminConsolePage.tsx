import { useState, useEffect, useCallback, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import { Button, Field, Input, Switch, Card } from "./ui/v2";

interface Props {
  onBack: () => void;
}

// ── 类型（与后端 console.ts / data-retention.ts 响应对齐） ──

type Summary = {
  exams: { total: number; formal: number; quiz: number; reviewEnabled: number };
  answerCards: { total: number; active: number };
  users: { total: number; teachers: number; students: number; admins: number };
  grading: { cropsTotal: number; cropsGraded: number; completionRate: number };
  generatedAt?: string;
};

type ActivityEvent = { entityType: string; action: string; count: number; lastAt: string | null };
type Activity = { source: string; events?: ActivityEvent[]; recentExams?: Array<{ day: string; cnt: number }>; recentCards?: Array<{ day: string; cnt: number }> };

type Distribution = Record<string, number>;
type Preferences = { scoreDisplayMode: Distribution; showTabBar: Distribution; theme: Distribution; colorScheme: Distribution; track: Distribution };

type AiUsage = {
  available: boolean;
  reason?: string;
  totals?: { runs: number; success: number; failed: number; totalTokensIn: number; totalTokensOut: number; avgLatencyMs: number };
  byFeature?: Array<{ feature: string; count: number; success: number; successRate: number; avgLatencyMs: number; totalTokens: number }>;
};

type DataQuality = {
  originalPaperAttachment: { withOriginal: number; total: number; rate: number };
  gradingCompletion: { graded: number; total: number; rate: number | string };
  scanSuccessRate: number | "not_available";
  manualModificationRate: number | "not_available";
};

type RetentionPolicy = { id: number; name: string; retainDays: number; autoArchive: number; autoDelete: number };

// ── 工具 ──

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "0";
  return n.toLocaleString("zh-CN");
}

function fmtPct(n: number | string | null | undefined): string {
  if (n === "not_available") return "—";
  if (typeof n !== "number") return "—";
  return `${n}%`;
}

function DistBar({ label, dist }: { label: string; dist: Distribution }) {
  const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, c]) => s + c, 0);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium text-foreground">{label}</div>
      {entries.length === 0 && <div className="text-xs text-muted-foreground">暂无数据</div>}
      {entries.map(([k, c]) => (
        <div key={k} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 truncate text-muted-foreground">{k === "null" ? "（未设置）" : k}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-sm bg-secondary">
            <div
              className="h-full bg-[var(--px-accent-bg)]"
              style={{ width: total > 0 ? `${Math.round((c / total) * 100)}%` : "0%" }}
            />
          </div>
          <span className="w-14 shrink-0 text-right tabular-nums text-foreground">{fmtNum(c)}</span>
        </div>
      ))}
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border-subtle bg-secondary px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums text-foreground">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Banner({ tone, children }: { tone: "success" | "error"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm",
        tone === "success"
          ? "border-border bg-secondary text-foreground"
          : "border-destructive-border bg-secondary text-destructive-fg"
      )}
    >
      {tone === "success" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
      {children}
    </div>
  );
}

function SectionCard({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      {children}
    </Card>
  );
}

// ── 主组件 ──

export function AdminConsolePage({ onBack }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [aiUsage, setAiUsage] = useState<AiUsage | null>(null);
  const [dataQuality, setDataQuality] = useState<DataQuality | null>(null);
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const tryFetch = async <T,>(path: string): Promise<T | null> => {
      try {
        const res = await fetchJson<{ ok: boolean; error?: string } & T>(path);
        if (res && (res as any).ok === false) return null;
        return res as unknown as T;
      } catch {
        return null;
      }
    };

    const [s, a, p, ai, dq, pol] = await Promise.all([
      tryFetch<Summary>("/api/admin/console/summary"),
      tryFetch<Activity>("/api/admin/console/activity"),
      tryFetch<Preferences>("/api/admin/console/preferences"),
      tryFetch<AiUsage>("/api/admin/console/ai-usage"),
      tryFetch<DataQuality>("/api/admin/console/data-quality"),
      tryFetch<{ ok: boolean; data: RetentionPolicy[] }>("/api/admin/data-retention-policies"),
    ]);
    setSummary(s);
    setActivity(a);
    setPreferences(p);
    setAiUsage(ai);
    setDataQuality(dq);
    setPolicies(pol?.data ?? []);
  }, []);

  useEffect(() => { load(); }, [load, refreshTick]);

  const savePolicy = async (policy: RetentionPolicy) => {
    setMsg(null);
    try {
      await fetchJson(`/api/admin/data-retention-policies/${policy.id}`, {
        method: "PUT",
        body: JSON.stringify({
          retainDays: policy.retainDays,
          autoArchive: policy.autoArchive ? 1 : 0,
          autoDelete: policy.autoDelete ? 1 : 0,
        }),
      });
      setMsg({ tone: "success", text: "保留策略已更新" });
      setRefreshTick((t) => t + 1);
    } catch (e: any) {
      setMsg({ tone: "error", text: e?.message || "保存失败" });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-base font-semibold text-foreground">管理员控制台</span>
            <span className="rounded-sm bg-secondary px-2 py-0.5 text-xs text-muted-foreground">仅系统管理员</span>
          </div>
          <p className="text-xs text-muted-foreground">平台聚合概览。所有数据均为聚合值，不包含个人明细。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setRefreshTick((t) => t + 1)}>
            <RefreshCw size={14} /> 刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={onBack}>← 返回首页</Button>
        </div>
      </div>

      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      {/* 概览 */}
      <SectionCard title="平台概览" desc="现存答题卡指剔除演示数据后的有效答题卡；阅卷完成率按已评切块数统计。">
        {summary ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="考试总数" value={fmtNum(summary.exams.total)} hint={`大考 ${fmtNum(summary.exams.formal)} · 晨测 ${fmtNum(summary.exams.quiz)}`} />
            <StatTile label="当前考试数（网阅）" value={fmtNum(summary.exams.reviewEnabled)} hint="已开启网上阅卷" />
            <StatTile label="答题卡总数" value={fmtNum(summary.answerCards.total)} />
            <StatTile label="现存答题卡" value={fmtNum(summary.answerCards.active)} hint="剔除演示数据" />
            <StatTile label="用户总数" value={fmtNum(summary.users.total)} hint={`教师 ${fmtNum(summary.users.teachers)} · 学生 ${fmtNum(summary.users.students)} · 管理员 ${fmtNum(summary.users.admins)}`} />
            <StatTile label="阅卷完成率" value={fmtPct(summary.grading.completionRate)} hint={`${fmtNum(summary.grading.cropsGraded)} / ${fmtNum(summary.grading.cropsTotal)} 切块`} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">概览加载失败或暂无数据。</p>
        )}
      </SectionCard>

      {/* 近期活动 */}
      <SectionCard title="实体生命周期（历史累计）" desc="基于 entity_lifecycle_events 的创建/归档/删除/恢复事件计数；数据源缺失时回退为近 14 日创建统计。">
        {activity ? (
          activity.source === "entity_lifecycle_events" && activity.events ? (
            activity.events.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无生命周期事件（自迁移启用后开始累计）。</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {activity.events.map((e) => (
                  <div key={`${e.entityType}-${e.action}`} className="flex items-center justify-between rounded-md border border-border-subtle bg-secondary px-3 py-2 text-sm">
                    <span className="text-foreground">
                      {e.entityType} · <span className="font-medium">{e.action}</span>
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="tabular-nums">{fmtNum(e.count)} 次</span>
                      {e.lastAt && <span className="tabular-nums">{String(e.lastAt).slice(0, 10)}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">事件表尚未启用，展示近 14 日创建统计（兜底）。</p>
              {[...(activity.recentExams ?? []), ...(activity.recentCards ?? [])].length === 0 && (
                <p className="text-xs text-muted-foreground">暂无创建记录。</p>
              )}
            </div>
          )
        ) : (
          <p className="text-xs text-muted-foreground">活动数据加载失败。</p>
        )}
      </SectionCard>

      {/* 偏好分布 */}
      <SectionCard title="用户偏好分布" desc="各设置项在全部用户中的取值分布（不包含个人明细）。">
        {preferences ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <DistBar label="成绩显示模式（score_display_mode）" dist={preferences.scoreDisplayMode} />
            <DistBar label="底部导航栏（show_tab_bar）" dist={preferences.showTabBar} />
            <DistBar label="皮肤（ui_style / theme_skin）" dist={preferences.theme} />
            <DistBar label="明暗（color_scheme）" dist={preferences.colorScheme} />
            <DistBar label="文理分科（track）" dist={preferences.track} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">偏好分布加载失败。</p>
        )}
      </SectionCard>

      {/* AI 用量 */}
      <SectionCard title="AI 调用观测" desc="逻辑任务层聚合：成功率 / 延迟 / Token 用量（不保存提示词与回答内容）。">
        {aiUsage ? (
          aiUsage.available && aiUsage.totals ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <StatTile label="调用次数" value={fmtNum(aiUsage.totals.runs)} />
                <StatTile label="成功率" value={aiUsage.totals.runs > 0 ? `${Math.round((aiUsage.totals.success / aiUsage.totals.runs) * 1000) / 10}%` : "—"} hint={`成功 ${fmtNum(aiUsage.totals.success)} · 失败 ${fmtNum(aiUsage.totals.failed)}`} />
                <StatTile label="平均延迟" value={aiUsage.totals.avgLatencyMs > 0 ? `${fmtNum(aiUsage.totals.avgLatencyMs)} ms` : "—"} />
                <StatTile label="输入 Token" value={fmtNum(aiUsage.totals.totalTokensIn)} />
                <StatTile label="输出 Token" value={fmtNum(aiUsage.totals.totalTokensOut)} />
              </div>
              {aiUsage.byFeature && aiUsage.byFeature.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border-subtle text-muted-foreground">
                        <th className="py-1.5 pr-3 font-medium">功能</th>
                        <th className="py-1.5 pr-3 font-medium">次数</th>
                        <th className="py-1.5 pr-3 font-medium">成功率</th>
                        <th className="py-1.5 pr-3 font-medium">平均延迟</th>
                        <th className="py-1.5 font-medium">Token 合计</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aiUsage.byFeature.map((f) => (
                        <tr key={f.feature} className="border-b border-border-subtle/60 text-foreground">
                          <td className="py-1.5 pr-3">{f.feature}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{fmtNum(f.count)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{fmtPct(f.successRate)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{f.avgLatencyMs > 0 ? `${fmtNum(f.avgLatencyMs)} ms` : "—"}</td>
                          <td className="py-1.5 tabular-nums">{fmtNum(f.totalTokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{aiUsage.reason ?? "暂无 AI 调用记录。"}</p>
          )
        ) : (
          <p className="text-xs text-muted-foreground">AI 用量加载失败。</p>
        )}
      </SectionCard>

      {/* 数据质量 */}
      <SectionCard title="数据质量" desc="原卷附着率与阅卷完成率；扫描成功率/人工修改率因后端无独立扫描表沉淀，暂不可用（不编造）。">
        {dataQuality ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile label="原卷附着率" value={fmtPct(dataQuality.originalPaperAttachment.rate)} hint={`${fmtNum(dataQuality.originalPaperAttachment.withOriginal)} / ${fmtNum(dataQuality.originalPaperAttachment.total)} 答题卡`} />
            <StatTile label="阅卷完成率" value={fmtPct(typeof dataQuality.gradingCompletion.rate === "number" ? dataQuality.gradingCompletion.rate : 0)} hint={`${fmtNum(dataQuality.gradingCompletion.graded)} / ${fmtNum(dataQuality.gradingCompletion.total)} 切块`} />
            <StatTile label="扫描成功率" value={fmtPct(dataQuality.scanSuccessRate)} hint="暂不可用" />
            <StatTile label="人工修改率" value={fmtPct(dataQuality.manualModificationRate)} hint="暂不可用" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">数据质量加载失败。</p>
        )}
      </SectionCard>

      {/* 数据保留策略 */}
      <SectionCard title="数据保留策略" desc="各考试类型的数据保留天数与自动归档/删除策略（0 = 永久保留）。">
        {policies.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无保留策略或加载失败。</p>
        ) : (
          <div className="flex flex-col gap-3">
            {policies.map((p) => (
              <PolicyRow key={p.id} policy={p} onSave={savePolicy} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function PolicyRow({ policy, onSave }: { policy: RetentionPolicy; onSave: (p: RetentionPolicy) => Promise<void> }) {
  const [draft, setDraft] = useState<RetentionPolicy>(policy);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const patch = (p: Partial<RetentionPolicy>) => {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ ...draft });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-border-subtle bg-secondary p-3.5">
      <div className="flex min-w-32 flex-col gap-1">
        <span className="text-xs text-muted-foreground">策略</span>
        <span className="text-sm font-medium text-foreground">{draft.name}</span>
      </div>
      <Field label="保留天数（0=永久）">
        <Input
          type="number"
          min={0}
          value={draft.retainDays}
          onChange={(e) => patch({ retainDays: Math.max(0, Number(e.target.value) || 0) })}
          className="w-24 text-center"
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={draft.autoArchive === 1} onCheckedChange={(c: boolean) => patch({ autoArchive: c ? 1 : 0 })} />
          到期自动归档
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={draft.autoDelete === 1} onCheckedChange={(c: boolean) => patch({ autoDelete: c ? 1 : 0 })} />
          到期自动删除
        </label>
      </div>
      <Button variant={dirty ? "primary" : "outline"} size="sm" onClick={() => void save()} disabled={saving || !dirty}>
        {saving ? "保存中..." : "保存"}
      </Button>
    </div>
  );
}
