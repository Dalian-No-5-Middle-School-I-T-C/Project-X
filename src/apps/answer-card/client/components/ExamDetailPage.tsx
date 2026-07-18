import React, { useState } from "react";
import { ClipboardCheck, Users, AlertCircle, FileSearch, Settings } from "lucide-react";
import { BlockSelectPage } from "./BlockSelectPage";
import { ReviewAssignPage } from "./ReviewAssignPage";
import { DisputeManagePage } from "./DisputeManagePage";
import { ReviewTracePage } from "./ReviewTracePage";
import { GradingConfigPage } from "./GradingConfigPage";

type ExamDetailTab = "review" | "assign" | "disputes" | "trace" | "settings";

interface Props {
  examId: number;
  teacherId: number;
  teacherRole: string | null;
  userRole: string;
  onBackToList: () => void;
  onBackHome: () => void;
  onStartReview: (examId: number, blockId: string) => void;
}

const tabs: Array<{
  key: ExamDetailTab;
  icon: React.FC<{ size?: number }>;
  label: string;
  requiresRole: "all" | "grade_leader" | "admin";
}> = [
  { key: "review", icon: ClipboardCheck, label: "阅卷", requiresRole: "all" },
  { key: "assign", icon: Users, label: "阅卷分配", requiresRole: "grade_leader" },
  { key: "disputes", icon: AlertCircle, label: "争议管理", requiresRole: "grade_leader" },
  { key: "trace", icon: FileSearch, label: "阅卷溯源", requiresRole: "grade_leader" },
  { key: "settings", icon: Settings, label: "网阅设置", requiresRole: "admin" },
];

export function ExamDetailPage({
  examId, teacherId, teacherRole, userRole,
  onBackToList, onBackHome, onStartReview
}: Props) {
  const [activeTab, setActiveTab] = useState<ExamDetailTab>("review");

  const isGradeLeader = teacherRole === "grade_leader" || userRole === "admin";
  const isAdmin = userRole === "admin";

  const canSeeTab = (requiresRole: string) => {
    if (requiresRole === "all") return true;
    if (requiresRole === "grade_leader") return isGradeLeader;
    if (requiresRole === "admin") return isAdmin;
    return false;
  };

  const visibleTabs = tabs.filter((t) => canSeeTab(t.requiresRole));

  return (
    <div style={{ padding: 24 }}>
      {/* v1.9.0: 返回按钮由全局 topbar 提供 */}
      {/* Tab 栏 */}
      <div style={{ display: "flex", gap: 0, borderBottom: "2px solid var(--color-border-primary)", marginBottom: 24 }}>
        {visibleTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: activeTab === tab.key ? 500 : 400,
              color: activeTab === tab.key ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              borderBottom: activeTab === tab.key ? "2px solid var(--color-text-primary)" : "2px solid transparent",
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: -2,
            }}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      {activeTab === "review" && (
        <BlockSelectPage
          examId={examId}
          teacherId={teacherId}
          onSelectBlock={(blockId) => onStartReview(examId, blockId)}
        />
      )}

      {activeTab === "assign" && <ReviewAssignPage examId={examId} />}
      {activeTab === "disputes" && <DisputeManagePage examId={examId} />}
      {activeTab === "trace" && <ReviewTracePage examId={examId} />}
      {activeTab === "settings" && <GradingConfigPage examId={examId} />}
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  height: 44,
  padding: "0 18px",
  fontSize: 14,
  fontWeight: 500,
  border: "1px solid var(--color-border-primary)",
  borderRadius: 8,
  background: "var(--color-background-secondary)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};
