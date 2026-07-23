import { Spinner } from "./Spinner";

/** 全屏/区块加载屏：复用 .loading-screen / .loading-spinner（修复 ScannerApp 缺失类） */
export function LoadingScreen({
  label = "加载中…",
  fullscreen = true,
}: {
  label?: string;
  fullscreen?: boolean;
}) {
  return (
    <div className={fullscreen ? "loading-screen" : "loading-inline"}>
      <span className="loading-spinner" />
      {label && <p>{label}</p>}
    </div>
  );
}

export { Spinner };
