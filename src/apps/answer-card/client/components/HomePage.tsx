import React, { useEffect, useState, useCallback } from "react";
import { SquarePen, ClipboardList, BarChart3, Users, Clock, BookOpen } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { DashboardData } from "../../../../shared/types";

interface Props {
  userRole: string;
  teacherRole: string | null;
  userName: string;
  onNavigate: (mode: string) => void;
  /** 在新标签打开某功能并让当前页也跳转过去（首页“答题卡设计”等入口使用） */
  onOpenNewTab?: (mode: string) => void;
  onEnterExam: (examId: number) => void;
}

const moduleCards = [
  { id: "design", icon: SquarePen, label: "答题卡设计", desc: "创建和编辑答题卡模板", permission: "card:read" },
  { id: "exam-manage", icon: ClipboardList, label: "考试管理", desc: "安排考试、网上阅卷入口", permission: "exam:write" },
  { id: "analysis", icon: BarChart3, label: "成绩分析", desc: "查看分析报告与跨班对比", permission: "exam:read" },
];

const adminCard = { id: "account", icon: Users, label: "账号管理", desc: "管理师生账号", permission: "user:manage" };
const globalSettingsCard = { id: "global-settings", icon: BookOpen, label: "全局设置", desc: "系统级默认值与策略", permission: "system:manage" };

export function HomePage({ userRole, teacherRole, userName, onNavigate, onOpenNewTab, onEnterExam }: Props) {
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
    <div className="home-container">
      {/* 欢迎 */}
      <div className="home-welcome">
        <h1 className="home-welcome-title">
          欢迎回来，{userName}
        </h1>
        {teacherRole && (
          <span className="home-welcome-role">
            {teacherRole === "grade_leader" ? "学年主任" : teacherRole === "head_teacher" ? "班主任" : "学科老师"}
          </span>
        )}
      </div>

      {/* 快捷入口 — 始终显示（多卡并列，不再互斥：继续阅卷 / 最新扫描 / 考试管理 可同时出现） */}
      <div className="home-quick-grid">
        {loading ? (
          <div className="home-quick-card home-quick-card-gray" style={{ cursor: "default" }}>
            <div className="home-quick-card-desc">加载中...</div>
          </div>
        ) : (
          <>
            {hasContinueReview && (
              <div
                className="home-quick-card home-quick-card-amber"
                onClick={() => onEnterExam(dashboard!.unfinishedTask!.examId)}
                role="button" tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onEnterExam(dashboard!.unfinishedTask!.examId)}
              >
                <div className="home-quick-card-icon">📝</div>
                <div className="home-quick-card-label">继续阅卷</div>
                <div className="home-quick-card-desc">
                  {dashboard!.unfinishedTask!.examName} · {dashboard!.unfinishedTask!.blockTitle}
                </div>
              </div>
            )}
            {hasLatestScan && (
              <div
                className="home-quick-card home-quick-card-blue"
                onClick={() => onEnterExam(dashboard!.latestScanExam!.examId)}
                role="button" tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onEnterExam(dashboard!.latestScanExam!.examId)}
              >
                <div className="home-quick-card-icon">🆕</div>
                <div className="home-quick-card-label">最新扫描</div>
                <div className="home-quick-card-desc">
                  {dashboard!.latestScanExam!.examName}{dashboard!.latestScanExam!.subject ? ` · ${dashboard!.latestScanExam!.subject}` : ""}
                </div>
              </div>
            )}
            <div className="home-quick-card home-quick-card-purple"
              onClick={() => onNavigate("exam-manage")}
              role="button" tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onNavigate("exam-manage")}
            >
              <div className="home-quick-card-icon">📋</div>
              <div className="home-quick-card-label">考试管理</div>
              <div className="home-quick-card-desc">
                查看和管理所有考试
              </div>
            </div>
          </>
        )}
      </div>

      {/* 模块卡片 */}
      <div className="home-module-grid">
        {moduleCards.map((card) => {
          // “答题卡设计”从首页进入时单开新标签，当前页也跳转过去
          const enter = (): void => {
            if (onOpenNewTab) onOpenNewTab(card.id);
            else onNavigate(card.id);
          };
          return (
          <div
            key={card.id}
            className="home-card"
            onClick={enter}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && enter()}
          >
            <div className="home-card-inner">
              <card.icon size={36} className="home-card-icon" />
              <div>
                <div className="home-card-label">{card.label}</div>
                <div className="home-card-desc">
                  {card.desc}
                </div>
              </div>
            </div>
          </div>
          );
        })}

        {isAdmin && (
          <div
            className="home-card"
            onClick={() => (onOpenNewTab ? onOpenNewTab(adminCard.id) : onNavigate(adminCard.id))}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && (onOpenNewTab ? onOpenNewTab(adminCard.id) : onNavigate(adminCard.id))}
          >
            <div className="home-card-inner">
              <adminCard.icon size={36} className="home-card-icon" />
              <div>
                <div className="home-card-label">{adminCard.label}</div>
                <div className="home-card-desc">
                  {adminCard.desc}
                </div>
              </div>
            </div>
          </div>
        )}

        {isAdmin && (
          <div
            className="home-card"
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
