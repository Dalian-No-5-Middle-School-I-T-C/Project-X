/**
 * components/ui/v2 —— 设计系统组件基座（Tailwind v4 + shadcn/ui 配方）
 *
 * 纪律（EXECUTION-PLAN §4 防串台规约）：
 *  · 页面只能从这里 import 通用组件，禁止跨页面互相 import
 *  · 组件内零手写 CSS，只用工具类 + cva
 *  · 颜色只说语义（bg-primary / text-muted-foreground），禁写十六进制
 *  · 图标只用 lucide-react
 *
 * 旧 components/ui/*（PascalCase）在 P5 之前保留，两套并存互不影响。
 */

export { Button, buttonVariants, type ButtonProps } from "./button";
export {
  Input,
  Textarea,
  Label,
  Field,
  type InputProps,
  type TextareaProps,
  type FieldProps,
} from "./input";
export {
  Badge,
  badgeVariants,
  ExamStatusBadge,
  type BadgeProps,
  type ExamStatus,
} from "./badge";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Panel,
  type CardProps,
} from "./card";
export { Spinner, Skeleton, SkeletonText, Kbd } from "./feedback";
export {
  Checkbox,
  RadioGroup,
  RadioGroupItem,
  Switch,
  ControlRow,
} from "./toggle-inputs";
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from "./select";

/* ── 覆盖层 / 导航 / 反馈（P2-2）────────────────────────────────── */
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  ConfirmDialog,
  type DialogSize,
  type DialogContentProps,
  type ConfirmDialogProps,
} from "./dialog";
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
  type SheetContentProps,
} from "./sheet";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu";
export {
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipContent,
  Tip,
  type TipProps,
} from "./tooltip";
export { Toaster, notify, toast } from "./toaster";
export { Tabs, TabsList, TabsTrigger, TabsContent, TabsCount } from "./tabs";
export {
  SegmentedControl,
  ToggleGroup,
  ToggleGroupItem,
  type SegmentedItem,
  type SegmentedControlProps,
} from "./segmented-control";
export {
  Progress,
  TaskProgress,
  type ProgressProps,
  type ProgressTone,
  type TaskProgressProps,
} from "./progress";
export { Pagination, type PaginationProps } from "./pagination";

/* ── 数据展示 / 业务外壳（P2-3）──────────────────────────────────── */
export {
  TableWrap,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./table";
export {
  DataTable,
  type DataTableProps,
  type ColumnDef,
  type SortingState,
} from "./data-table";
export {
  EmptyState,
  ErrorState,
  type EmptyStateProps,
  type ErrorStateProps,
} from "./empty-state";
export {
  StatCard,
  StatCardRow,
  ScoreBadge,
  type StatCardProps,
  type ScoreBadgeProps,
} from "./stat-card";
export { UploadZone, type UploadZoneProps } from "./upload-zone";
export {
  Chart,
  chartPalette,
  chartBaseOptions,
  paletteColor,
  rampPalette,
  useChartTheme,
  withAlpha,
  type ChartProps,
  type ChartTheme,
} from "./chart";
export {
  AppShell,
  AppMain,
  AppContentRow,
  AppContent,
  AppRail,
  AppRailBrand,
  AppRailNav,
  AppRailGroupLabel,
  AppRailItem,
  AppRailFooter,
  PageHeader,
  ContextPanel,
  ContextPanelHeader,
  ContextPanelBody,
  ContextItem,
  StatusBar,
  StatusItem,
  StatusSpacer,
  SaveStatus,
  type AppContentProps,
  type AppRailProps,
  type AppRailBrandProps,
  type AppRailItemProps,
  type PageHeaderProps,
  type ContextItemProps,
  type StatusItemProps,
  type SaveState,
  type SaveStatusProps,
} from "./shell";
