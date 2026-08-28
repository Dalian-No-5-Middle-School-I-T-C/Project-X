import { useState } from "react";
import { Eye, EyeOff, Globe } from "lucide-react";
import { SERVER_URL_KEY } from "../lib/scannerMode";
import { getStoredApiKey, storeApiKey } from "../auth/api";
import { serverStatus } from "../lib/remoteServerStatus";
import { scannerUploadManager } from "../lib/scannerUploadManager";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "./ui/v2";

type Mode = "dialog" | "embedded";

interface Props {
  mode: Mode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSaved?: () => void;
}

function loadUrl(): string {
  try {
    return (localStorage.getItem(SERVER_URL_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

function saveUrl(url: string): void {
  try {
    localStorage.setItem(SERVER_URL_KEY, url.trim().replace(/\/+$/, ""));
  } catch {
    /* ignore */
  }
}

export function ServerConfigDialog({ mode, open, onOpenChange, onSaved }: Props) {
  const [serverUrl, setServerUrl] = useState(loadUrl);
  const [apiKey, setApiKey] = useState(() => getStoredApiKey() ?? "");
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<"" | "testing" | "ok" | "fail">("");
  const [testMessage, setTestMessage] = useState("");

  const hasActiveJobs = (() => {
    try {
      const st = scannerUploadManager.getState();
      return st.jobs.some((j) => !["done", "error"].includes(j.status));
    } catch {
      return false;
    }
  })();
  const urlChanged = serverUrl.trim().replace(/\/+$/, "") !== loadUrl().replace(/\/+$/, "");

  async function handleTest() {
    if (!serverUrl.trim()) return;
    setTestStatus("testing");
    setTestMessage("");
    try {
      const base = serverUrl.trim().replace(/\/+$/, "");
      const url = `${base}/api/app/health`;
      const headers: Record<string, string> = {};
      const key = apiKey.trim();
      if (key) headers["X-Api-Key"] = key;
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        capabilities?: { scannerClientApi?: boolean };
      };
      if (res.ok && body.ok === true && body.capabilities?.scannerClientApi === true) {
        setTestStatus("ok");
        setTimeout(() => setTestStatus(""), 3000);
      } else {
        setTestStatus("fail");
        setTestMessage(
          res.ok ? "服务器在线，但未启用远程扫描客户端 API" : `服务器返回 ${res.status}`
        );
      }
    } catch (err) {
      setTestStatus("fail");
      setTestMessage(err instanceof Error ? err.message : "连接失败");
    }
  }

  function handleSave() {
    // P1: 已有上传任务时仍允许切服，但进行中的任务已快照旧地址/Key，不会把 A 的 session 发往 B
    saveUrl(serverUrl);
    storeApiKey(apiKey.trim() || null);
    serverStatus.refresh();
    scannerUploadManager.notifyNetworkChanged();
    if (mode === "dialog") onOpenChange?.(false);
    onSaved?.();
  }

  const form = (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-xs text-muted-foreground">
        扫描、识别和账号登录始终在本机完成。填入服务器地址和 API Key 后，可将扫描结果上传到远端服务器。
      </p>
      {hasActiveJobs && urlChanged && (
        <p className="m-0 rounded border border-warning-border bg-warning-soft px-2 py-1 text-xs text-warning-foreground">
          检测到有进行中的上传任务，切服后该任务仍发往原服务器，新任务将发往新服务器；如需迁移请等待当前任务完成。
        </p>
      )}
      <Field label="服务器地址">
        <Input
          value={serverUrl}
          onChange={(e) => {
            setServerUrl(e.target.value);
            setTestStatus("");
            setTestMessage("");
          }}
          placeholder="http://192.168.1.100:5174"
          autoComplete="off"
        />
      </Field>
      <Field label="API Key">
        <div className="relative">
          <Input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-xxx..."
            autoComplete="off"
            className="pr-8"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-label={showKey ? "隐藏" : "显示"}
          >
            {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          loading={testStatus === "testing"}
          onClick={() => void handleTest()}
          disabled={!serverUrl.trim() || testStatus === "testing"}
        >
          {testStatus === "testing" ? "测试中..." : "测试连接"}
        </Button>
        {testStatus === "ok" && (
          <Badge tone="success" dot className="scan-lime">
            服务器可达
          </Badge>
        )}
        {testStatus === "fail" && <Badge tone="danger" dot>{testMessage || "连接失败"}</Badge>}
        <Button variant="primary" size="sm" type="button" className="ml-auto" onClick={handleSave}>
          保存配置
        </Button>
      </div>
    </div>
  );

  if (mode === "embedded") {
    return <div className="mt-2 rounded-md border border-border-subtle bg-secondary p-3">{form}</div>;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe size={16} />
            服务器连接
          </DialogTitle>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}
