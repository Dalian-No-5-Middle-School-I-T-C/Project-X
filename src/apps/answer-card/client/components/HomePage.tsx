import React, { useEffect, useState, useCallback } from "react";
import { SquarePen, ClipboardList, BarChart3, Users, Clock, BookOpen } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { DashboardData } from "../../../../shared/types";

interface Props {
  userRole: string;
  teacherRole: string | null;
  userName: string;
  onNavigate: (mode: string) => void;
  onEnterExam: (examId: number) => void;
}

const moduleCards = [
  { id: "design", icon: SquarePen, label: "答题卡设计", desc: "创建和编辑答题卡模板", permission: "card:read" },
  { id: "exam-manage", icon: ClipboardList, label: "考试管理", desc: "安排考试、网上阅卷入口", permission: "exam:write" },
  { id: "analysis", icon: BarChart3, label: "成绩分析", desc: "查看分析报告与跨班对比", permission: "exam:read" },
];

const adminCard = { id: "account", icon: Users, label: "账号管理", desc: "管理师生账号", permission: "user:manage" };
const globalSettingsCard = { id: "global-settings", icon: BookOpen, label: "全局设置", desc: "系统级默认值与策略", permission: "system:manage" };

export function HomePage({ userRole, teacherRole, userName, onNavigate, onEnterExam }: Props) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; data: DashboardData }>("/api/dashboard");
      if (res.ok) setDashboard(res.data);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const isAdmin = userRole === "admin";
  // 始终尝试渲染快捷入口，API 无数据时显示默认卡片
  const hasContinueReview = dashboard?.hasUnfinishedGrading && dashboard.unfinishedTask;
  const hasLatestScan = dashboard?.latestScanExam;

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "32px 24px" }}>
      {/* 欢迎 */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>
          欢迎回来，{userName}
        </h1>
        {teacherRole && (
          <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
            {teacherRole === "grade_leader" ? "学年主任" : teacherRole === "head_teacher" ? "班主任" : "学科老师"}
          </span>
        )}
      </div>

      {/* 快捷入口 — 始终显示 */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 16,
        marginBottom: 32,
        minHeight: 80,
      }}>
        {loading ? (
          <div style={{ ...quickCardStyle("#F1EFE8", "#888780"), cursor: "default" }}>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>加载中...</div>
          </div>
        ) : hasContinueReview ? (
          <div
            style={quickCardStyle("#FFF8E1", "#FFA000")}
            onClick={() => onEnterExam(dashboard!.unfinishedTask!.examId)}
            role="button" tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onEnterExam(dashboard!.unfinishedTask!.examId)}
          >
            <div style={{ fontSize: 20, marginBottom: 6 }}>📝</div>
            <div style={{ fontWeight: 500, fontSize: 15 }}>继续阅卷</div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
              {dashboard!.unfinishedTask!.examName} · {dashboard!.unfinishedTask!.blockTitle}
            </div>
          </div>
        ) : hasLatestScan ? (
          <div
            style={quickCardStyle("#E6F1FB", "#378ADD")}
            onClick={() => onEnterExam(dashboard!.latestScanExam!.examId)}
            role="button" tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onEnterExam(dashboard!.latestScanExam!.examId)}
          >
            <div style={{ fontSize: 20, marginBottom: 6 }}>🆕</div>
            <div style={{ fontWeight: 500, fontSize: 15 }}>最新扫描</div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
              {dashboard!.latestScanExam!.examName}{dashboard!.latestScanExam!.subject ? ` · ${dashboard!.latestScanExam!.subject}` : ""}
            </div>
          </div>
        ) : (
          <div style={{ ...quickCardStyle("#EEEDFE", "#7F77DD"), cursor: "pointer" }}
            onClick={() => onNavigate("exam-manage")}
            role="button" tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onNavigate("exam-manage")}
          >
            <div style={{ fontSize: 20, marginBottom: 6 }}>📋</div>
            <div style={{ fontWeight: 500, fontSize: 15 }}>考试管理</div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
              查看和管理所有考试
            </div>
          </div>
        )}
      </div>

      {/* 模块卡片 */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 16
      }}>
        {moduleCards.map((card) => (
          <div
            key={card.id}
            style={cardStyle}
            onClick={() => onNavigate(card.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onNavigate(card.id)}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <card.icon size={36} style={{ color: "var(--color-text-secondary)", flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 4 }}>{card.label}</div>
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                  {card.desc}
                </div>
              </div>
            </div>
          </div>
        ))}

        {isAdmin && (
          <div
            style={cardStyle}
            onClick={() => onNavigate(adminCard.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onNavigate(adminCard.id)}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <adminCard.icon size={36} style={{ color: "var(--color-text-secondary)", flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 4 }}>{adminCard.label}</div>
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                  {adminCard.desc}
                </div>
              </div>
            </div>
          </div>
        )}

        {isAdmin && (
          <div
            style={cardStyle}
            onClick={() => onNavigate(globalSettingsCard.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onNavigate(globalSettingsCard.id)}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <globalSettingsCard.icon size={36} style={{ color: "var(--color-text-secondary)", flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 4 }}>{globalSettingsCard.label}</div>
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                  {globalSettingsCard.desc}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--color-background-secondary)",
  borderRadius: 12,
  padding: "24px",
  cursor: "pointer",
  border: "0.5px solid var(--color-border-tertiary)",
  transition: "box-shadow 0.15s",
};

const quickCardStyle = (bg: string, border: string): React.CSSProperties => ({
  ...cardStyle,
  background: bg,
  borderLeft: `3px solid ${border}`,
});
