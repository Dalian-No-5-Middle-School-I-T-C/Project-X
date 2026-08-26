// v2.5.1: 远端服务器连接状态指示器（工作台顶栏常驻 / 上传进度卡头部复用）。
// 数据源 remoteServerStatus 单例；hover 显示服务器地址、探活详情与最后探测时间。
import { useSyncExternalStore } from "react";
import { StatusItem } from "./ui/v2";
import { serverStatus } from "../lib/remoteServerStatus";
import type { ServerStatusKind } from "../lib/remoteServerStatus";

const TONE: Record<ServerStatusKind, "ok" | "warn" | "error" | "idle"> = {
  online: "ok",
  checking: "idle",
  unconfigured: "idle",
  api_disabled: "warn",
  offline: "error",
};

const LABEL: Record<ServerStatusKind, string> = {
  online: "服务器在线",
  checking: "检测服务器…",
  unconfigured: "未配置服务器",
  api_disabled: "扫描 API 未启用",
  offline: "服务器离线",
};

export function ServerStatusIndicator() {
  const snap = useSyncExternalStore(serverStatus.subscribe, serverStatus.getState);
  const checkedAt = snap.lastCheckedAt
    ? new Date(snap.lastCheckedAt).toLocaleTimeString("zh-CN")
    : "";
  const title = snap.serverUrl
    ? `${snap.serverUrl} · ${snap.detail}${checkedAt ? ` · 探测于 ${checkedAt}` : ""}`
    : snap.detail;
  return (
    <StatusItem tone={TONE[snap.kind]} title={title} className="shrink-0 text-xs">
      {LABEL[snap.kind]}
    </StatusItem>
  );
}
