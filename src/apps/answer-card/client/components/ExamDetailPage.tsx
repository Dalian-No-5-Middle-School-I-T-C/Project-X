import React, { useState } from "react";
import { ArrowLeft, ClipboardCheck, Users, AlertCircle, FileSearch, Settings } from "lucide-react";
import { BlockSelectPage } from "./BlockSelectPage";
import { ReviewAssignPage } from "./ReviewAssignPage";
import { DisputeManagePage } from "./DisputeManagePage";
import { ReviewTracePage } from "./ReviewTracePage";
import { GradingConfigPage } from "./GradingConfigPage";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/v2";

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
  icon: React.FC<{ className?: string }>;
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
  const canSee = (key: ExamDetailTab) => visibleTabs.some((t) => t.key === key);

  return (
    <div className="p-6">
      {/* 返回考试列表 */}
      <Button
        variant="outline"
        className="mb-4"
        icon={<ArrowLeft />}
        onClick={onBackToList}
      >
        返回考试列表
      </Button>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ExamDetailTab)}>
        {/* Tab 栏 */}
        <TabsList className="mb-6">
          {visibleTabs.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              <tab.icon />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Tab 内容 */}
        {canSee("review") && (
          <TabsContent value="review">
            <BlockSelectPage
              examId={examId}
              teacherId={teacherId}
              onSelectBlock={(blockId) => onStartReview(examId, blockId)}
            />
          </TabsContent>
        )}
        {canSee("assign") && (
          <TabsContent value="assign">
            <ReviewAssignPage examId={examId} />
          </TabsContent>
        )}
        {canSee("disputes") && (
          <TabsContent value="disputes">
            <DisputeManagePage examId={examId} />
          </TabsContent>
        )}
        {canSee("trace") && (
          <TabsContent value="trace">
            <ReviewTracePage examId={examId} />
          </TabsContent>
        )}
        {canSee("settings") && (
          <TabsContent value="settings">
            <GradingConfigPage examId={examId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
