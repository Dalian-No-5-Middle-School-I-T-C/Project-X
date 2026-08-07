/**
 * 【临时文件 · DESIGN_PREVIEW】P2 过闸走查页
 *
 * EXECUTION-PLAN P2 过闸要求：
 *   「每个组件在一个临时 /design-preview 本地路由（不发布）中
 *     渲染全变体 × light/dark/compact，截图核对 demo.html」
 *
 * ⚠ 不属于产品功能，不接任何后端。P5 清理阶段删除本文件 +
 *   main.tsx 中标了 DESIGN_PREVIEW 的路由（搜索该关键字即可定位全部残留）。
 */

import * as React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BarChart3,
  ChevronLeft,
  Copy,
  Download,
  FileText,
  Home,
  Inbox,
  LayoutGrid,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Settings,
  Sun,
  Trash2,
  Users,
} from "lucide-react";

import {
  AppContent,
  AppContentRow,
  AppMain,
  AppRail,
  AppRailBrand,
  AppRailFooter,
  AppRailGroupLabel,
  AppRailItem,
  AppRailNav,
  AppShell,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  ContextItem,
  ContextPanel,
  ContextPanelBody,
  ContextPanelHeader,
  ControlRow,
  DataTable,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  ExamStatusBadge,
  Field,
  Input,
  Kbd,
  Label,
  Pagination,
  PageHeader,
  Progress,
  RadioGroup,
  RadioGroupItem,
  SaveStatus,
  ScoreBadge,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  SkeletonText,
  Spinner,
  StatCard,
  StatCardRow,
  StatusBar,
  StatusItem,
  StatusSpacer,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
  Tabs,
  TabsContent,
  TabsCount,
  TabsList,
  TabsTrigger,
  TaskProgress,
  Textarea,
  Tip,
  Toaster,
  TooltipProvider,
  UploadZone,
  notify,
  type ColumnDef,
  type ExamStatus,
  type SaveState,
} from "../components/ui/v2";

/* ── 走查页自身的排版助手（非设计系统组件）────────────────────────── */

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <div className="rounded-lg border border-border bg-card p-5">{children}</div>
    </section>
  );
}

function Row({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 border-b border-border-subtle py-3 first:pt-0 last:border-0 last:pb-0">
      <span className="w-28 shrink-0 pt-1 text-xs text-muted-foreground">
        {label}
      </span>
      <div
        className={
          align === "center"
            ? "flex min-w-0 flex-1 flex-wrap items-center gap-2"
            : "flex min-w-0 flex-1 flex-wrap items-start gap-3"
        }
      >
        {children}
      </div>
    </div>
  );
}

/* ── 演示数据 ─────────────────────────────────────────────────────── */

type ExamRow = {
  id: string;
  name: string;
  klass: string;
  score: number;
  full: number;
  status: ExamStatus;
};

const DEMO_ROWS: ExamRow[] = [
  { id: "20260101", name: "陈嘉禾", klass: "高三(1)班", score: 132, full: 150, status: "done" },
  { id: "20260102", name: "林知远", klass: "高三(1)班", score: 118, full: 150, status: "done" },
  { id: "20260103", name: "苏晚棠", klass: "高三(2)班", score: 96, full: 150, status: "grading" },
  { id: "20260104", name: "顾承宇", klass: "高三(2)班", score: 141, full: 150, status: "done" },
  { id: "20260105", name: "叶清和", klass: "高三(3)班", score: 74, full: 150, status: "error" },
  { id: "20260106", name: "沈砚书", klass: "高三(3)班", score: 108, full: 150, status: "pending" },
  { id: "20260107", name: "白鹿鸣", klass: "高三(1)班", score: 125, full: 150, status: "done" },
  { id: "20260108", name: "温亦初", klass: "高三(2)班", score: 89, full: 150, status: "grading" },
  { id: "20260109", name: "许南枝", klass: "高三(3)班", score: 137, full: 150, status: "done" },
  { id: "20260110", name: "宋淮舟", klass: "高三(1)班", score: 63, full: 150, status: "error" },
];

const DEMO_COLUMNS: ColumnDef<ExamRow, any>[] = [
  { accessorKey: "id", header: "学号", meta: { widthClass: "w-28" } },
  { accessorKey: "name", header: "姓名", meta: { widthClass: "w-24" } },
  { accessorKey: "klass", header: "班级" },
  {
    accessorKey: "score",
    header: "得分",
    meta: { numeric: true, widthClass: "w-24" },
  },
  {
    id: "rate",
    header: "得分率",
    cell: ({ row }) => (
      <ScoreBadge score={row.original.score} full={row.original.full} />
    ),
    enableSorting: false,
    meta: { widthClass: "w-32" },
  },
  {
    accessorKey: "status",
    header: "状态",
    cell: ({ row }) => <ExamStatusBadge status={row.original.status} />,
    meta: { widthClass: "w-28" },
  },
  {
    id: "actions",
    header: "操作",
    enableSorting: false,
    meta: { action: true, widthClass: "w-20" },
    cell: () => (
      <Button variant="ghost" size="sm">
        查看
      </Button>
    ),
  },
];

const SAVE_STATES: SaveState[] = ["idle", "editing", "saving", "saved", "error"];

/* ── 各分区 ───────────────────────────────────────────────────────── */

function ButtonsSection() {
  return (
    <Section id="button" title="Button" note="5 变体 × 5 尺寸 · 主按钮每屏 ≤1">
      <Row label="变体">
        <Button variant="primary">保存答题卡</Button>
        <Button variant="secondary">次要操作</Button>
        <Button variant="outline">描边</Button>
        <Button variant="ghost">幽灵</Button>
        <Button variant="destructive">删除考试</Button>
      </Row>
      <Row label="尺寸">
        <Button variant="primary" size="sm">
          sm 28
        </Button>
        <Button variant="primary" size="md">
          md 32
        </Button>
        <Button variant="primary" size="lg">
          lg 36
        </Button>
        <Tip label="新建题块">
          <Button variant="primary" size="icon" aria-label="新建题块">
            <Plus />
          </Button>
        </Tip>
        <Tip label="更多">
          <Button variant="outline" size="icon-sm" aria-label="更多">
            <MoreHorizontal />
          </Button>
        </Tip>
      </Row>
      <Row label="带图标">
        <Button variant="primary">
          <Plus />
          新建
        </Button>
        <Button variant="outline">
          <Download />
          导出成绩
        </Button>
        <Button variant="destructive">
          <Trash2 />
          删除
        </Button>
      </Row>
      <Row label="状态">
        <Button variant="primary" disabled>
          禁用
        </Button>
        <Button variant="primary" disabled>
          <Spinner size={14} className="text-primary-foreground" />
          保存中
        </Button>
        <Button variant="outline" disabled>
          禁用描边
        </Button>
      </Row>
      <Row label="通栏">
        <div className="w-72">
          <Button variant="primary" block>
            登录
          </Button>
        </div>
      </Row>
    </Section>
  );
}

function FormsSection() {
  const [text, setText] = React.useState("2026 届高三第二次月考");
  const [subject, setSubject] = React.useState("math");
  const [sided, setSided] = React.useState("double");
  const [checked, setChecked] = React.useState(true);
  const [half, setHalf] = React.useState(false);
  const [autoArb, setAutoArb] = React.useState(true);

  return (
    <Section id="form" title="表单控件" note="Input / Textarea / Field / Select / Checkbox / Radio / Switch">
      <Row label="输入框" align="start">
        <div className="w-64">
          <Field label="考试名称" required htmlFor="dp-name" hint="用于成绩单抬头">
            <Input
              id="dp-name"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="请输入考试名称"
            />
          </Field>
        </div>
        <div className="w-64">
          <Field label="满分" htmlFor="dp-full" error="满分必须为正数">
            <Input id="dp-full" defaultValue="-150" invalid className="tabular-nums" />
          </Field>
        </div>
        <div className="w-64">
          <Field label="禁用" htmlFor="dp-disabled">
            <Input id="dp-disabled" defaultValue="不可编辑" disabled />
          </Field>
        </div>
      </Row>
      <Row label="多行" align="start">
        <div className="w-[520px] max-w-full">
          <Field label="备注" hint="最多 200 字">
            <Textarea rows={3} placeholder="阅卷注意事项…" />
          </Field>
        </div>
      </Row>
      <Row label="下拉" align="start">
        <div className="w-52">
          <Label className="mb-1.5 block">科目</Label>
          <Select value={subject} onValueChange={setSubject}>
            <SelectTrigger>
              <SelectValue placeholder="请选择科目" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chinese">语文</SelectItem>
              <SelectItem value="math">数学</SelectItem>
              <SelectItem value="english">英语</SelectItem>
              <SelectItem value="physics">物理</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-52">
          <Label className="mb-1.5 block">禁用态</Label>
          <Select disabled>
            <SelectTrigger>
              <SelectValue placeholder="不可选择" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="x">x</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Row>
      <Row label="勾选 / 单选" align="start">
        <div className="flex flex-col gap-2">
          <ControlRow
            htmlFor="dp-cb1"
            control={
              <Checkbox
                id="dp-cb1"
                checked={checked}
                onCheckedChange={(v) => setChecked(v === true)}
              />
            }
            label="识别后自动入库"
            description="识别置信度低于阈值的卷子仍会进入待复核"
          />
          <ControlRow
            htmlFor="dp-cb2"
            control={<Checkbox id="dp-cb2" disabled />}
            label="禁用项"
          />
        </div>
        <RadioGroup value={sided} onValueChange={setSided} className="flex flex-col gap-2">
          <ControlRow
            htmlFor="dp-r1"
            control={<RadioGroupItem id="dp-r1" value="single" />}
            label="单面答题卡"
          />
          <ControlRow
            htmlFor="dp-r2"
            control={<RadioGroupItem id="dp-r2" value="double" />}
            label="双面答题卡"
            description="背面布局单独设计"
          />
        </RadioGroup>
      </Row>
      <Row label="开关" align="start">
        <div className="flex w-[520px] max-w-full flex-col gap-3">
          <ControlRow
            reverse
            htmlFor="dp-sw1"
            control={<Switch id="dp-sw1" checked={half} onCheckedChange={setHalf} />}
            label="允许 0.5 分"
            description="按题块生效，位值模式下仅十分位可给 0.5"
          />
          <ControlRow
            reverse
            htmlFor="dp-sw2"
            control={
              <Switch id="dp-sw2" checked={autoArb} onCheckedChange={setAutoArb} />
            }
            label="争议卷自动改派"
            description="未指定仲裁人时按工作量均衡自动分配"
          />
          <ControlRow
            reverse
            htmlFor="dp-sw3"
            control={<Switch id="dp-sw3" disabled />}
            label="禁用开关"
          />
        </div>
      </Row>
    </Section>
  );
}

function BadgesSection() {
  return (
    <Section id="badge" title="Badge / 状态" note="7 色调 · 考试四状态为定死项">
      <Row label="色调">
        <Badge>中性</Badge>
        <Badge tone="accent">强调</Badge>
        <Badge tone="success" dot>
          已完成
        </Badge>
        <Badge tone="warning" dot>
          进行中
        </Badge>
        <Badge tone="info" dot>
          提示
        </Badge>
        <Badge tone="danger" dot>
          异常
        </Badge>
        <Badge tone="solid">实底</Badge>
      </Row>
      <Row label="考试状态">
        <ExamStatusBadge status="pending" />
        <ExamStatusBadge status="grading" />
        <ExamStatusBadge status="grading" label="阅卷中 3/5" />
        <ExamStatusBadge status="done" />
        <ExamStatusBadge status="error" />
      </Row>
      <Row label="得分徽标">
        <ScoreBadge score={141} full={150} />
        <ScoreBadge score={108} full={150} />
        <ScoreBadge score={63} full={150} />
        <ScoreBadge score={12} full={15} size="sm" />
        <ScoreBadge score={9.5} full={15} hideFull />
      </Row>
      <Row label="辅助">
        <Kbd>Ctrl</Kbd>
        <Kbd>S</Kbd>
        <span className="text-xs text-muted-foreground">保存</span>
        <Kbd>←</Kbd>
        <Kbd>→</Kbd>
        <span className="text-xs text-muted-foreground">上/下一张</span>
      </Row>
    </Section>
  );
}

function CardsSection() {
  const [selected, setSelected] = React.useState(1);
  return (
    <Section id="card" title="Card" note="默认 / 可点 / 选中">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>普通卡片</CardTitle>
            <CardDescription>静态容器，无交互反馈</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-secondary-foreground">
            答题卡定义、布局与资产分开存储。
          </CardContent>
        </Card>
        {[1, 2].map((i) => (
          <Card
            key={i}
            interactive
            selected={selected === i}
            onClick={() => setSelected(i)}
          >
            <CardHeader>
              <CardTitle>可点卡片 {i}</CardTitle>
              <CardDescription>
                {selected === i ? "当前选中" : "点击选中"}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-secondary-foreground">
              hover 抬升 + 选中描边为品牌红。
            </CardContent>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function NavSection() {
  const [tab, setTab] = React.useState("all");
  const [align, setAlign] = React.useState<"left" | "center" | "right">("left");
  const [view, setView] = React.useState<"list" | "grid">("list");

  return (
    <Section id="nav" title="Tabs / SegmentedControl" note="下划线为唯一 Tab 形态">
      <Row label="Tabs" align="start">
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList>
            <TabsTrigger value="all">
              全部 <TabsCount>128</TabsCount>
            </TabsTrigger>
            <TabsTrigger value="pending">
              待复核 <TabsCount>7</TabsCount>
            </TabsTrigger>
            <TabsTrigger value="done">已完成</TabsTrigger>
            <TabsTrigger value="off" disabled>
              禁用页
            </TabsTrigger>
          </TabsList>
          <TabsContent value="all" className="pt-3 text-sm text-secondary-foreground">
            全部 128 份答卷。
          </TabsContent>
          <TabsContent
            value="pending"
            className="pt-3 text-sm text-secondary-foreground"
          >
            7 份识别置信度偏低，需人工确认。
          </TabsContent>
          <TabsContent value="done" className="pt-3 text-sm text-secondary-foreground">
            已完成入库。
          </TabsContent>
        </Tabs>
      </Row>
      <Row label="分段控件">
        <SegmentedControl
          value={view}
          onValueChange={setView}
          aria-label="视图切换"
          items={[
            { value: "list", label: "列表" },
            { value: "grid", label: "网格" },
          ]}
        />
        <SegmentedControl
          size="sm"
          value={align}
          onValueChange={setAlign}
          aria-label="对齐方式"
          items={[
            { value: "left", icon: <AlignLeft />, ariaLabel: "左对齐", tip: "左对齐" },
            {
              value: "center",
              icon: <AlignCenter />,
              ariaLabel: "居中",
              tip: "居中",
            },
            {
              value: "right",
              icon: <AlignRight />,
              ariaLabel: "右对齐",
              tip: "右对齐",
            },
          ]}
        />
      </Row>
    </Section>
  );
}

function ProgressSection() {
  const [pct, setPct] = React.useState(42);
  return (
    <Section id="progress" title="Progress" note="扫描/导出必须确定性进度">
      <Row label="进度条" align="start">
        <div className="flex w-full max-w-lg flex-col gap-3">
          <Progress value={0} />
          <Progress value={pct} />
          <Progress value={100} tone="success" />
          <Progress value={68} tone="warning" size="sm" />
          <Progress value={33} tone="destructive" size="sm" />
          <div>
            <span className="mb-1 block text-xs text-muted-foreground">
              value=null（总量未知，仅瞬时态允许）
            </span>
            <Progress value={null} />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setPct((v) => Math.max(0, v - 10))}>
              −10
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPct((v) => Math.min(100, v + 10))}>
              +10
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
          </div>
        </div>
      </Row>
      <Row label="任务进度" align="start">
        <div className="flex w-full max-w-lg flex-col gap-4">
          <TaskProgress
            label="扫描识别"
            current="20260107_正面.jpg"
            done={73}
            total={128}
          />
          <TaskProgress
            label="导出成绩单"
            done={128}
            total={128}
            tone="success"
          />
          <TaskProgress
            label="批量识别"
            current="20260110_背面.jpg"
            done={96}
            total={128}
            failed={4}
            tone="warning"
          />
        </div>
      </Row>
    </Section>
  );
}

function OverlaySection() {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [hardOpen, setHardOpen] = React.useState(false);
  const [menuChecked, setMenuChecked] = React.useState(true);

  return (
    <Section
      id="overlay"
      title="覆盖层"
      note="Dialog 3 档宽 · Sheet 3 方向 · DropdownMenu · Tooltip · Toast"
    >
      <Row label="Dialog">
        {(["sm", "md", "lg"] as const).map((size) => (
          <Dialog key={size}>
            <DialogTrigger asChild>
              <Button variant="outline">Dialog {size}</Button>
            </DialogTrigger>
            <DialogContent size={size}>
              <DialogHeader>
                <DialogTitle>新建答题卡（{size}）</DialogTitle>
                <DialogDescription>
                  标题左对齐，关闭按钮固定右上角。
                </DialogDescription>
              </DialogHeader>
              <DialogBody>
                <Field label="名称" htmlFor={`dp-dlg-${size}`} required>
                  <Input id={`dp-dlg-${size}`} placeholder="例如：高三月考数学" />
                </Field>
                <p className="mt-3 text-sm text-secondary-foreground">
                  遮罩为纯色半透明 scrim，不使用背景模糊。
                </p>
              </DialogBody>
              <DialogFooter>
                <Button variant="ghost">取消</Button>
                <Button variant="primary">创建</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ))}
      </Row>
      <Row label="确认框">
        <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
          删除考试（普通危险）
        </Button>
        <Button variant="destructive" onClick={() => setHardOpen(true)}>
          清空成绩库（需逐字输入）
        </Button>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          tone="danger"
          title="删除考试「2026 届高三第二次月考」？"
          description="该考试下 128 份答卷与识别结果将一并删除，且不可恢复。"
          confirmLabel="删除"
          onConfirm={() => {
            setConfirmOpen(false);
            notify.undoable("已删除考试", () => notify.info("已撤销删除"));
          }}
        />
        <ConfirmDialog
          open={hardOpen}
          onOpenChange={setHardOpen}
          tone="danger"
          title="清空整个成绩库？"
          description="所有考试、答卷、成绩与排名将被永久删除。请输入下方文字以确认。"
          confirmText="清空成绩库"
          confirmLabel="我已知晓，执行清空"
          onConfirm={() => {
            setHardOpen(false);
            notify.error("演示环境不会真的执行");
          }}
        />
      </Row>
      <Row label="Sheet">
        {(["right", "left", "bottom"] as const).map((side) => (
          <Sheet key={side}>
            <SheetTrigger asChild>
              <Button variant="outline">Sheet {side}</Button>
            </SheetTrigger>
            <SheetContent side={side}>
              <SheetHeader>
                <SheetTitle>题块属性</SheetTitle>
                <SheetDescription>抽屉用于窄屏或次要属性编辑。</SheetDescription>
              </SheetHeader>
              <SheetBody>
                <Field label="题块名称" htmlFor={`dp-sheet-${side}`}>
                  <Input id={`dp-sheet-${side}`} defaultValue="第 21 题 解答题" />
                </Field>
              </SheetBody>
              <SheetFooter>
                <Button variant="ghost">取消</Button>
                <Button variant="primary">应用</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        ))}
      </Row>
      <Row label="下拉菜单">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              操作
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>答题卡</DropdownMenuLabel>
            <DropdownMenuItem>
              <Pencil />
              重命名
              <DropdownMenuShortcut>F2</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Copy />
              复制一份
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Download />
              导出 .projectx-card.json
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={setMenuChecked}
            >
              显示网格
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger">
              <Trash2 />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tip label="提示只解释图标或截断文本，200ms 延迟">
          <Button variant="ghost" size="icon-sm" aria-label="帮助">
            <Search />
          </Button>
        </Tip>
      </Row>
      <Row label="Toast">
        <Button variant="outline" onClick={() => notify.success("答题卡已保存")}>
          success
        </Button>
        <Button variant="outline" onClick={() => notify.info("已切换到位值打分模式")}>
          info
        </Button>
        <Button
          variant="outline"
          onClick={() => notify.warning("有 4 份答卷缺少原卷图片")}
        >
          warning
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            notify.error("识别服务未响应", {
              description: "scanner-bridge.exe 未启动或端口被占用",
            })
          }
        >
          error（常驻）
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            const id = notify.loading("正在识别 128 份答卷…");
            window.setTimeout(() => {
              notify.dismiss(id);
              notify.success("识别完成：124 成功 / 4 待复核");
            }, 1800);
          }}
        >
          loading → success
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            notify.undoable("已删除 1 个题块", () => notify.info("已撤销"))
          }
        >
          undoable
        </Button>
      </Row>
    </Section>
  );
}

function DataSection() {
  const [state, setState] = React.useState<"success" | "loading" | "error" | "empty">(
    "success",
  );
  const [page, setPage] = React.useState(3);

  return (
    <Section id="data" title="表格 / 分页" note="Table 原语 + DataTable 异步四态">
      <Row label="Table 原语" align="start">
        <TableWrap className="w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>题号</TableHead>
                <TableHead>类型</TableHead>
                <TableHead numeric>满分</TableHead>
                <TableHead numeric>平均分</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>1–12</TableCell>
                <TableCell>单选</TableCell>
                <TableCell numeric>60</TableCell>
                <TableCell numeric>48.3</TableCell>
              </TableRow>
              <TableRow selected>
                <TableCell>13–16</TableCell>
                <TableCell>填空</TableCell>
                <TableCell numeric>20</TableCell>
                <TableCell numeric>11.7</TableCell>
              </TableRow>
              <TableRow clickable onClick={() => notify.info("点击了第 17–22 题")}>
                <TableCell>17–22</TableCell>
                <TableCell>解答</TableCell>
                <TableCell numeric>70</TableCell>
                <TableCell numeric>39.5</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableWrap>
      </Row>
      <Row label="DataTable" align="start">
        <div className="w-full">
          <div className="mb-3">
            <SegmentedControl
              size="sm"
              value={state}
              onValueChange={setState}
              aria-label="异步四态"
              items={[
                { value: "success", label: "success" },
                { value: "loading", label: "loading" },
                { value: "error", label: "error" },
                { value: "empty", label: "empty" },
              ]}
            />
          </div>
          <DataTable<ExamRow>
            columns={DEMO_COLUMNS}
            data={state === "empty" ? [] : DEMO_ROWS}
            loading={state === "loading"}
            error={state === "error" ? "无法连接到成绩服务（HTTP 503）" : null}
            onRetry={() => setState("success")}
            pageSize={5}
            pageSizeOptions={[5, 10, 20]}
            isRowSelected={(row) => row.status === "error"}
            getRowId={(row) => row.id}
            onRowClick={(row) => notify.info(`打开 ${row.name} 的答卷`)}
            initialSorting={[{ id: "score", desc: true }]}
          />
        </div>
      </Row>
      <Row label="Pagination" align="start">
        <div className="w-full">
          <Pagination
            total={2431}
            page={page}
            pageSize={20}
            onPageChange={setPage}
            pageSizeOptions={[20, 50, 100]}
            onPageSizeChange={() => setPage(1)}
          />
        </div>
      </Row>
    </Section>
  );
}

function StateSection() {
  return (
    <Section id="state" title="空态 / 错误态 / 骨架" note="§7 异步四态">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-border-subtle">
          <EmptyState
            icon={<Inbox />}
            title="还没有答题卡"
            description="创建第一张答题卡，或从 .projectx-card.json 导入。"
            action={
              <>
                <Button variant="primary">
                  <Plus />
                  新建答题卡
                </Button>
                <Button variant="outline">导入</Button>
              </>
            }
          />
        </div>
        <div className="rounded-md border border-border-subtle">
          <ErrorState
            description="读取扫描目录失败：EPERM, operation not permitted"
            onRetry={() => notify.info("重试中…")}
          />
        </div>
        <div className="rounded-md border border-border-subtle">
          <EmptyState size="sm" title="无搜索结果" description="换个关键词试试。" />
        </div>
        <div className="rounded-md border border-border-subtle p-5">
          <div className="mb-3 flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1">
              <Skeleton className="mb-1.5 h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <SkeletonText lines={3} />
          <div className="mt-3 flex items-center gap-2">
            <Spinner />
            <span className="text-xs text-muted-foreground">加载中…</span>
          </div>
        </div>
      </div>
    </Section>
  );
}

function StatsSection() {
  return (
    <Section id="stat" title="StatCard" note="数字等宽 · 环比方向可反转">
      <StatCardRow>
        <StatCard label="参考人数" value={1284} suffix="人" delta={3.2} deltaLabel="较上次" />
        <StatCard
          label="平均分"
          value={108.6}
          suffix="/ 150"
          delta={-4.1}
          deltaLabel="较上次"
        />
        <StatCard
          label="不及格率"
          value="12.4%"
          delta={2.8}
          direction="up-is-bad"
          deltaLabel="较上次"
          hint="低于 90 分计为不及格"
        />
        <StatCard label="待复核" value={7} suffix="份" loading />
      </StatCardRow>
    </Section>
  );
}

function UploadSection() {
  return (
    <Section id="upload" title="UploadZone" note="拖拽 + 键盘可达">
      <div className="grid gap-3 lg:grid-cols-3">
        <UploadZone
          accept=".jpg,.jpeg,.png"
          multiple
          label="拖拽答卷图片到此处"
          sublabel="支持 JPG / PNG，单张不超过 20 MB"
          maxSize={20 * 1024 * 1024}
          onFiles={(files) => notify.success(`已选择 ${files.length} 个文件`)}
        />
        <UploadZone
          accept=".projectx-card.json,.json"
          size="sm"
          label="导入答题卡定义"
          sublabel=".projectx-card.json"
          onFile={(file) => notify.info(`已选择 ${file.name}`)}
        />
        <UploadZone accept=".pdf" size="sm" disabled label="禁用态" sublabel="暂不可用" />
      </div>
    </Section>
  );
}

function ShellSection() {
  const [collapsed, setCollapsed] = React.useState(false);
  const [active, setActive] = React.useState("design");
  const [block, setBlock] = React.useState("q21");
  const [saveState, setSaveState] = React.useState<SaveState>("saved");

  const navItems = [
    { key: "home", icon: <Home />, label: "首页" },
    { key: "design", icon: <LayoutGrid />, label: "答题卡设计" },
    { key: "scan", icon: <ScanLine />, label: "扫描评分", badge: <Badge tone="danger">4</Badge> },
    { key: "analysis", icon: <BarChart3 />, label: "成绩分析" },
  ];
  const manageItems = [
    { key: "account", icon: <Users />, label: "教师与学生" },
    { key: "settings", icon: <Settings />, label: "全局设置" },
  ];

  return (
    <Section
      id="shell"
      title="应用外壳"
      note="AppRail 232↔64 · PageHeader 60 · ContextPanel 300 · StatusBar 30"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setCollapsed((v) => !v)}>
          <PanelLeft />
          {collapsed ? "展开侧栏" : "收起侧栏"}
        </Button>
        <span className="text-xs text-muted-foreground">
          收起后导航项自动挂 Tooltip；选中态＝浅红底 + 左侧 3px 品牌红指示条
        </span>
      </div>

      <AppShell className="h-[560px] overflow-hidden rounded-lg border border-border">
        <AppRail collapsed={collapsed}>
          <AppRailBrand
            logo="X"
            title="Project-X"
            subtitle="答题卡系统"
            collapsed={collapsed}
          />
          <AppRailNav>
            {navItems.map((it) => (
              <AppRailItem
                key={it.key}
                icon={it.icon}
                label={it.label}
                badge={it.badge}
                collapsed={collapsed}
                active={active === it.key}
                onClick={() => setActive(it.key)}
              />
            ))}
            <AppRailGroupLabel collapsed={collapsed}>管理</AppRailGroupLabel>
            {manageItems.map((it) => (
              <AppRailItem
                key={it.key}
                icon={it.icon}
                label={it.label}
                collapsed={collapsed}
                active={active === it.key}
                onClick={() => setActive(it.key)}
              />
            ))}
          </AppRailNav>
          <AppRailFooter>
            <Tip label="切换主题" side="right">
              <Button variant="ghost" size="icon-sm" aria-label="切换主题">
                <Sun />
              </Button>
            </Tip>
            {!collapsed && (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                admin · 管理员
              </span>
            )}
          </AppRailFooter>
        </AppRail>

        <AppMain>
          <PageHeader
            leading={
              <Button variant="ghost" size="icon-sm" aria-label="返回">
                <ChevronLeft />
              </Button>
            }
            title="高三月考数学 · 答题卡设计"
            subtitle="A4 双面 · 8 个题块 · 最后保存 14:02"
            actions={
              <>
                <Button variant="outline" size="sm">
                  预览
                </Button>
                <Button variant="primary" size="sm">
                  保存
                </Button>
              </>
            }
          />
          <AppContentRow>
            <ContextPanel>
              <ContextPanelHeader>
                <span className="text-sm font-medium text-foreground">题块</span>
                <Button variant="ghost" size="icon-sm" aria-label="新增题块">
                  <Plus />
                </Button>
              </ContextPanelHeader>
              <ContextPanelBody>
                {[
                  { key: "q1", title: "第 1–12 题 单选", meta: "60 分 · 客观" },
                  { key: "q13", title: "第 13–16 题 填空", meta: "20 分 · 客观" },
                  { key: "q21", title: "第 21 题 解答", meta: "12 分 · 主观" },
                  { key: "q22", title: "第 22 题 解答", meta: "14 分 · 主观" },
                ].map((b) => (
                  <ContextItem
                    key={b.key}
                    icon={<FileText />}
                    title={b.title}
                    meta={b.meta}
                    active={block === b.key}
                    onClick={() => setBlock(b.key)}
                  />
                ))}
              </ContextPanelBody>
            </ContextPanel>
            <AppContent width="full" bare>
              <div className="flex h-full items-center justify-center bg-background p-6">
                <div className="flex h-full max-h-[300px] w-[240px] items-center justify-center rounded-xs border border-border bg-paper text-xs text-paper-foreground/50 shadow-2">
                  纸面恒白（A4 画布示意）
                </div>
              </div>
            </AppContent>
          </AppContentRow>
          <StatusBar>
            <StatusItem tone="ok">扫描仪已连接</StatusItem>
            <StatusItem tone="warn">4 份待复核</StatusItem>
            <StatusSpacer />
            <SaveStatus
              state={saveState}
              savedAt="14:02"
              onRetry={() => setSaveState("saving")}
            />
            <StatusItem plain>v1.9.4</StatusItem>
          </StatusBar>
        </AppMain>
      </AppShell>

      <div className="mt-4">
        <Row label="保存状态机">
          <SegmentedControl
            size="sm"
            value={saveState}
            onValueChange={setSaveState}
            aria-label="保存状态"
            items={SAVE_STATES.map((s) => ({ value: s, label: s }))}
          />
          <div className="ml-2 flex items-center gap-4 rounded-md border border-border-subtle px-3 py-1.5">
            {SAVE_STATES.map((s) => (
              <SaveStatus key={s} state={s} savedAt="14:02" />
            ))}
          </div>
        </Row>
      </div>
    </Section>
  );
}

/* ── 页面 ─────────────────────────────────────────────────────────── */

const SECTIONS = [
  ["button", "Button"],
  ["form", "表单"],
  ["badge", "Badge"],
  ["card", "Card"],
  ["nav", "Tabs"],
  ["progress", "Progress"],
  ["overlay", "覆盖层"],
  ["data", "表格"],
  ["state", "空/错/骨架"],
  ["stat", "StatCard"],
  ["upload", "上传"],
  ["shell", "外壳"],
] as const;

export default function DesignPreviewPage() {
  const [theme, setTheme] = React.useState<"light" | "dark">(
    () =>
      (document.documentElement.getAttribute("data-theme") as "light" | "dark") ??
      "light",
  );
  const [density, setDensity] = React.useState<"normal" | "compact">("normal");

  React.useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute("data-theme");
    root.setAttribute("data-theme", theme);
    return () => {
      if (prev) root.setAttribute("data-theme", prev);
      else root.removeAttribute("data-theme");
    };
  }, [theme]);

  React.useEffect(() => {
    const root = document.documentElement;
    if (density === "compact") root.setAttribute("data-density", "compact");
    else root.removeAttribute("data-density");
    return () => root.removeAttribute("data-density");
  }, [density]);

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="sticky top-0 z-(--px-z-header) border-b border-border-subtle bg-card/95 px-6 py-3">
          <div className="mx-auto flex max-w-content-wide flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-semibold">设计系统走查 · P2 过闸</span>
              <span className="text-xs text-muted-foreground">
                临时页面，不发布；P5 清理时删除
              </span>
            </div>
            <SegmentedControl
              size="sm"
              value={theme}
              onValueChange={setTheme}
              aria-label="主题"
              items={[
                { value: "light", label: "亮色", icon: <Sun /> },
                { value: "dark", label: "暗色", icon: <Moon /> },
              ]}
            />
            <SegmentedControl
              size="sm"
              value={density}
              onValueChange={setDensity}
              aria-label="密度"
              items={[
                { value: "normal", label: "标准" },
                { value: "compact", label: "紧凑" },
              ]}
            />
            <nav className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1">
              {SECTIONS.map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className="rounded-sm px-2 py-1 text-xs text-secondary-foreground transition-colors duration-(--px-dur-1) hover:bg-secondary hover:text-foreground"
                >
                  {label}
                </a>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto flex max-w-content-wide flex-col gap-8 px-6 py-8">
          <ButtonsSection />
          <FormsSection />
          <BadgesSection />
          <CardsSection />
          <NavSection />
          <ProgressSection />
          <OverlaySection />
          <DataSection />
          <StateSection />
          <StatsSection />
          <UploadSection />
          <ShellSection />
          <footer className="pb-12 text-xs text-muted-foreground">
            共 {SECTIONS.length} 组 · 组件来自 components/ui/v2 ·
            切换上方「亮色/暗色」「标准/紧凑」核对三态
          </footer>
        </main>

        <Toaster />
      </div>
    </TooltipProvider>
  );
}
