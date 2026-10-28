import { useEffect, useState } from "react";
import { Button, Card } from "./ui/v2";

/**
 * 主进程在渲染进程崩溃重载后置位 `window.__projectxRendererRecovered` 并派发同名事件；
 * 两边靠这个事件名对上，改动时两处一起改（electron/main.cjs 的 did-finish-load）。
 */
const RECOVERED_EVENT = "projectx:renderer-recovered";

declare global {
  interface Window { __projectxRendererRecovered?: boolean }
}

type NoticeState =
  | { kind: "recovered" }
  | { kind: "problem"; title: string; detail: string };

let emit: ((state: NoticeState) => void) | null = null;
let pending: NoticeState | null = null;

/**
 * 全局未捕获错误交给通知卡渲染：样式走 v2 组件与语义令牌，不再往页面里塞内联 CSS，
 * 主题、密度、焦点环与无障碍更新都能一并覆盖到这块应急界面。
 */
export function reportRendererProblem(title: string, detail: string): void {
  const state: NoticeState = { kind: "problem", title, detail };
  if (emit) emit(state);
  else pending = state;
}

export function ScannerNotice() {
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    emit = setNotice;
    if (pending) { setNotice(pending); pending = null; }
    // 事件可能在 React 挂载前就派发过了，所以挂载时先补读一次标记再监听。
    const showRecovered = () => {
      if (!window.__projectxRendererRecovered) return;
      window.__projectxRendererRecovered = false;
      setNotice({ kind: "recovered" });
    };
    showRecovered();
    window.addEventListener(RECOVERED_EVENT, showRecovered);
    return () => {
      emit = null;
      window.removeEventListener(RECOVERED_EVENT, showRecovered);
    };
  }, []);

  if (!notice) return null;
  const problem = notice.kind === "problem";
  return (
    <Card
      role={problem ? "alert" : "status"}
      className={`fixed bottom-4 left-4 z-[100] flex w-[440px] max-w-[calc(100vw-2rem)] flex-col gap-2 border-l-4 p-3 text-sm shadow-lg ${
        problem
          ? "border-warning-border border-l-warning-foreground bg-warning-soft text-warning-foreground"
          : "border-info-border border-l-info-foreground bg-info-soft text-info-foreground"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <strong className="font-semibold">{problem ? notice.title : "界面已自动恢复"}</strong>
          <p className="m-0 text-muted-foreground">
            {problem
              ? "界面操作可能受影响。已写入本机的订正草稿会保留；未写入的修改可能丢失，请核对后重新保存。"
              : "本机草稿会尝试恢复未保存的订正，请核对后重新保存。"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {problem && <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>重新加载</Button>}
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>知道了</Button>
        </div>
      </div>
      {problem && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">技术信息</summary>
          <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{notice.detail}</pre>
        </details>
      )}
    </Card>
  );
}
