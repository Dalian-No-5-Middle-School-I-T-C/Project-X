import { useCallback, useEffect, useState } from "react";
import { Award, BarChart3, BookOpen, ChevronRight, ClipboardList, ScanLine, SquarePen, Users } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { DashboardData } from "../../../../shared/types";
import { Badge, Card, CardContent, CardDescription, CardTitle, Skeleton } from "../components/ui/v2";

interface Props {
  userRole: string;
  teacherRole: string | null;
  userName: string;
  onNavigate: (mode: string) => void;
  /** Compatibility prop retained for existing callers; all app navigation stays in-page. */
  onOpenNewTab?: (mode: string) => void;
  onEnterExam: (examId: number) => void;
  onOpenAnalysis: (examId: number) => void;
}

const moduleCards = [
  { id: "design", icon: SquarePen, label: "答题卡设计", desc: "创建和编辑答题卡模板" },
  { id: "exam-manage", icon: ClipboardList, label: "考试管理", desc: "安排考试、网上阅卷入口" },
  { id: "analysis", icon: BarChart3, label: "成绩分析", desc: "查看分析报告与跨班对比" },
];

export function HomePage({ userRole, teacherRole, userName, onNavigate, onEnterExam, onOpenAnalysis }: Props) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [recentExams, setRecentExams] = useState<Array<{ id: number; name: string; subject?: string | null; exam_date?: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const loadDashboard = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; data: DashboardData }>("/api/dashboard");
      if (res.ok) setDashboard(res.data);
      const exams = await fetchJson<Array<{ id: number; name: string; subject?: string | null; exam_date?: string | null }>>("/api/exams");
      setRecentExams(exams.slice(0, 4));
    } catch { /* dashboard is supplemental */ }
    setLoading(false);
  }, []);
  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const isAdmin = userRole === "admin";
  const quickCards = [
    dashboard?.hasUnfinishedGrading && dashboard.unfinishedTask ? {
      icon: SquarePen, title: "继续阅卷", description: `${dashboard.unfinishedTask.examName} · ${dashboard.unfinishedTask.blockTitle}`,
      tone: "border-warning-border bg-warning-soft text-warning-foreground", onClick: () => onEnterExam(dashboard.unfinishedTask!.examId),
    } : {
      icon: SquarePen, title: "继续阅卷", description: "暂无待阅卷任务",
      tone: "border-warning-border bg-warning-soft text-warning-foreground", onClick: () => onNavigate("exam-manage"),
    },
    dashboard?.latestScanExam ? {
      icon: ScanLine, title: "最新扫描", description: `${dashboard.latestScanExam.examName}${dashboard.latestScanExam.subject ? ` · ${dashboard.latestScanExam.subject}` : ""}`,
      tone: "border-border bg-card text-secondary-foreground", onClick: () => onEnterExam(dashboard.latestScanExam!.examId),
    } : {
      icon: ScanLine, title: "最新扫描", description: "暂无扫描记录",
      tone: "border-border bg-card text-secondary-foreground", onClick: () => onNavigate("exam-manage"),
    },
    dashboard?.latestReleasedExam ? {
      icon: Award, title: "最新出分", description: `${dashboard.latestReleasedExam.examName}${dashboard.latestReleasedExam.subject ? ` · ${dashboard.latestReleasedExam.subject}` : ""}`,
      tone: "border-warning-border bg-warning-soft text-warning-foreground", onClick: () => onOpenAnalysis(dashboard.latestReleasedExam!.examId),
    } : {
      icon: Award, title: "最新出分", description: "暂无出分记录",
      tone: "border-warning-border bg-warning-soft text-warning-foreground", onClick: () => onNavigate("analysis"),
    },
    { icon: ClipboardList, title: "考试管理", description: "查看和管理所有考试", tone: "border-border bg-card text-secondary-foreground", onClick: () => onNavigate("exam-manage") },
  ] as Array<{ icon: typeof ClipboardList; title: string; description: string; tone: string; onClick: () => void }>;

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="mb-0 text-3xl font-bold tracking-tight text-foreground">欢迎回来，{userName}</h1>
          <p className="mt-5 text-sm text-muted-foreground">今天也把每一份答题卡，变成清晰可靠的结果。</p>
        </div>
        {teacherRole && <Badge tone="accent" dot>{teacherRole === "grade_leader" ? "学年主任" : teacherRole === "head_teacher" ? "班主任" : "学科老师"}</Badge>}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {loading ? <Skeleton className="h-20" /> : quickCards.map(({ icon: Icon, title, description, tone, onClick }) => (
          <Card key={title} interactive className={tone} onClick={onClick}>
            <CardContent className="flex items-center gap-3 p-4"><Icon className="size-5" /><div className="min-w-0 flex-1"><CardTitle className="text-sm">{title}</CardTitle><CardDescription className="mt-1 truncate">{description}</CardDescription></div><ChevronRight className="size-4 text-muted-foreground" /></CardContent>
          </Card>
        ))}
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">工作模块</h2><span className="text-xs text-muted-foreground">快速进入常用功能</span></div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {moduleCards.map(({ id, icon: Icon, label, desc }) => <Card key={id} interactive onClick={() => onNavigate(id)}><CardContent className="flex items-start gap-4 p-5"><Icon className="size-6 text-primary" /><div><CardTitle className="text-base">{label}</CardTitle><CardDescription className="mt-1">{desc}</CardDescription></div></CardContent></Card>)}
          {isAdmin && <Card interactive onClick={() => onNavigate("account")}><CardContent className="flex items-start gap-4 p-5"><Users className="size-6 text-primary" /><div><CardTitle className="text-base">账号管理</CardTitle><CardDescription className="mt-1">管理师生账号</CardDescription></div></CardContent></Card>}
          {isAdmin && <Card interactive onClick={() => onNavigate("global-settings")}><CardContent className="flex items-start gap-4 p-5"><BookOpen className="size-6 text-secondary-foreground" /><div><CardTitle className="text-base">全局设置</CardTitle><CardDescription className="mt-1">系统级默认值与策略</CardDescription></div></CardContent></Card>}
        </div>
      </section>

      <Card>
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4"><CardTitle className="text-base">最近考试</CardTitle><button className="border-0 bg-transparent flex items-center gap-1 text-sm text-secondary-foreground hover:text-foreground" type="button" onClick={() => onNavigate("exam-manage")}>全部考试 <ChevronRight className="size-4" /></button></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm"><thead className="bg-secondary text-xs text-muted-foreground"><tr><th className="px-5 py-3 text-left font-medium">考试名称</th><th className="px-5 py-3 text-left font-medium">学科</th><th className="px-5 py-3 text-left font-medium">日期</th><th className="px-5 py-3 text-right font-medium">操作</th></tr></thead><tbody>
            {recentExams.map((exam) => <tr key={exam.id} className="border-t border-border-subtle"><td className="px-5 py-3 font-medium">{exam.name}</td><td className="px-5 py-3 text-muted-foreground">{exam.subject || "未设科目"}</td><td className="px-5 py-3 tabular-nums text-muted-foreground">{exam.exam_date || "-"}</td><td className="px-5 py-3 text-right"><button className="border-0 bg-transparent text-secondary-foreground hover:text-foreground" type="button" onClick={() => onNavigate("exam-manage")}>查看</button></td></tr>)}
            {!loading && recentExams.length === 0 && <tr><td colSpan={4} className="px-5 py-8 text-center text-muted-foreground">暂无考试记录</td></tr>}
          </tbody></table>
        </div>
      </Card>
    </div>
  );
}
