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
            <p className="m-0 mt-3 text-lg font-semibold text-foreground">页面加载失败</p>
            <p className="m-0 mt-1 text-sm text-muted-foreground">请刷新后重试，或联系管理员</p>
            <p className="m-0 mt-3 rounded-sm bg-muted p-2 text-left text-xs break-words text-muted-foreground">
              {this.state.error.message}
            </p>
            <Button
              className="mt-4"
              variant="primary"
              block
              type="button"
              icon={<RefreshCw />}
              onClick={() => window.location.reload()}
            >
              刷新页面
            </Button>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
