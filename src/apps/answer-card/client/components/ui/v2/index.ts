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
