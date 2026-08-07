import { Home } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MODE_PATH } from "../modeRoutes";
import { Button, EmptyState } from "./ui/v2";

type NotFoundProps = {
  /** 「返回首页」目标路径，默认首页；调用方传入与路由兜底一致的 fallback 路径 */
  to?: string;
};

/** 未知路径的 404 视觉（EXECUTION-PLAN T8）：仍可一键回到原兜底目标，可达性不变。 */
export function NotFound({ to = MODE_PATH.home }: NotFoundProps) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={<span className="text-5xl font-bold text-primary tabular-nums">404</span>}
        title="页面不存在"
        description="你访问的页面可能已被移动或删除"
        action={
          <Button
            variant="primary"
            icon={<Home />}
            onClick={() => navigate(to, { replace: true })}
          >
            返回首页
          </Button>
        }
      />
    </div>
  );
}
