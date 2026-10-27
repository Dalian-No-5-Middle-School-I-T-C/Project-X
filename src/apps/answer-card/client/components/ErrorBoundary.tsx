import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button, Card } from "./ui/v2";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[Project-X] UI error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
          <Card className="w-full max-w-md p-6 text-center" role="alert">
            <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-destructive-soft text-destructive-fg">
              <AlertTriangle size={22} aria-hidden />
            </span>
            <p className="m-0 mt-3 text-lg font-semibold text-foreground">界面遇到异常</p>
            <p className="m-0 mt-1 text-sm text-muted-foreground">请重新加载页面。扫描端会自动保留未保存的订正草稿。</p>
            <details className="m-0 mt-3 rounded-sm bg-muted p-2 text-left text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">技术信息</summary>
              <p className="m-0 mt-2 break-words">{this.state.error.message}</p>
            </details>
            <Button
              className="mt-4"
              variant="primary"
              block
              type="button"
              icon={<RefreshCw />}
              onClick={() => window.location.reload()}
            >
              重新加载
            </Button>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
