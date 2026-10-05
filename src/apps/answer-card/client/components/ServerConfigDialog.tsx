import { useEffect, useRef, useSyncExternalStore, useState } from "react";
import { Eye, EyeOff, Globe } from "lucide-react";
import { isValidServerUrl, normalizeServerUrl, readServerUrl, writeServerUrl } from "../lib/scannerMode";
import {
  evaluateCredentialTransport,
  grantInsecureTransportAllowance,
  parseServerTarget,
  readInsecureTransportHosts,
  revokeInsecureTransportAllowance,
} from "../lib/remoteCredentialTransport";
import { getStoredApiKey, storeApiKey } from "../auth/api";
import { serverStatus } from "../lib/remoteServerStatus";
import { scannerUploadManager } from "../lib/scannerUploadManager";
import {
  Badge,
  Button,
  Checkbox,
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
  /**
   * embedded 模式由宿主(如登录页)注入：登录提交前兜底落盘当前表单，
   * 避免用户填好地址/Key 后直接登录导致配置静默丢失。
   */
  saveRef?: { current: (() => void) | null };
}

function loadUrl(): string {
  // v2.5.6：读出即归一化，存量里"缺 http://"的地址会被自动补全并回显
  return readServerUrl();
}

function saveUrl(url: string): void {
  writeServerUrl(url);
}

export function ServerConfigDialog({ mode, open, onOpenChange, onSaved, saveRef }: Props) {
  const [serverUrl, setServerUrl] = useState(loadUrl);
  const [apiKey, setApiKey] = useState(() => getStoredApiKey() ?? "");
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<"" | "testing" | "ok" | "fail">("");
  const [testMessage, setTestMessage] = useState("");
  // 安全（R32）：跨机明文 HTTP 的显式同意。初值取「已保存地址是否曾被勾选过」，
  // 之后一旦目标 host 变化就清零——同意是给某一个 host:port 的，不随地址搬家。
  const [allowInsecure, setAllowInsecure] = useState(
    () => evaluateCredentialTransport(loadUrl(), readInsecureTransportHosts()).reason === "explicit-allowance",
  );

  const typedUrl = normalizeServerUrl(serverUrl);
  const typedHost = parseServerTarget(typedUrl)?.host ?? "";
  const savedHost = parseServerTarget(loadUrl())?.host ?? "";
  const transportDecision = evaluateCredentialTransport(typedUrl, readInsecureTransportHosts());
  // blocked-plaintext = 跨机明文且当前没有勾选：此时 Key 一律不发
  const insecureTarget = transportDecision.reason === "blocked-plaintext";
  const maySendCredential = !insecureTarget || allowInsecure;
  const hostRef = useRef(typedHost);
  useEffect(() => {
    if (hostRef.current === typedHost) return;
    hostRef.current = typedHost;
    setAllowInsecure(false);
  }, [typedHost]);

  const initialKey = (() => {
    try {
      return getStoredApiKey() ?? "";
    } catch {
      return "";
    }
  })();
  // 订阅上传任务状态：在途/暂停判定随任务流转实时更新，切服守卫不滞后
  const uploadSnap = useSyncExternalStore(
    scannerUploadManager.subscribe,
    scannerUploadManager.getState,
  );
  const jobStatuses = uploadSnap.jobs.map((j) => j.status);
  const hasMidFlight = jobStatuses.some((x) => x === "creating" || x === "uploading" || x === "completing");
  const hasPending = jobStatuses.some((x) => x === "queued" || x === "paused");
  const urlChanged = serverUrl.trim().replace(/\/+$/, "") !== loadUrl().replace(/\/+$/, "");
  const keyChanged = apiKey.trim() !== initialKey.trim();
  const configChanged = urlChanged || keyChanged;
  const blockedByActiveJobs = hasMidFlight && configChanged;

  async function handleTest() {
    if (!serverUrl.trim()) return;
    setTestStatus("testing");
    setTestMessage("");
    // v2.5.6：先校验/归一化，避免「地址少写 http://」被误报成"连接失败"而查不到原因
    const base = normalizeServerUrl(serverUrl);
    if (!isValidServerUrl(serverUrl)) {
      setTestStatus("fail");
      setTestMessage(`地址格式不正确：${serverUrl.trim()}。请填写形如 https://projectx.school.edu.cn 的完整地址`);
      return;
    }
    setServerUrl(base);
    try {
      const url = `${base}/api/app/health`;
      const headers: Record<string, string> = {};
      const key = apiKey.trim();
      // 安全（R32）：明文跨机且未勾选时，健康探测照做（不带凭据），Key 不发出去
      const sendKey = Boolean(key) && maySendCredential;
      if (sendKey) headers["X-Api-Key"] = key;
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
        if (!key) throw new Error("服务器可达，请填写 API Key 后验证上传权限");
        if (!sendKey) {
          setTestStatus("ok");
          setTestMessage(`服务器可达，但 ${base} 是跨机明文 HTTP，未发送 API Key。勾选下方确认后才能验证上传权限并保存`);
          return;
        }
        const authRes = await fetch(`${base}/api/scanner/upload/check`, {
          headers,
          signal: AbortSignal.timeout(5000),
          credentials: "omit",
        });
        const authBody = await authRes.json().catch(() => ({})) as { ok?: boolean; message?: string };
        if (!authRes.ok || authBody.ok !== true) {
          throw new Error(authRes.status === 404
            ? "服务器可达，但不支持上传权限检测，请升级服务器后重试"
            : authBody.message || `上传权限验证失败（HTTP ${authRes.status}）`);
        }
        setTestStatus("ok");
        setTestMessage(`已连通 ${base}`);
        setTimeout(() => setTestStatus(""), 3000);
      } else {
        setTestStatus("fail");
        setTestMessage(
          res.ok
            ? `服务器 ${base} 在线，但未启用远程扫描客户端 API（需在服务器设置 PROJECTX_ENABLE_SCANNER_CLIENT_API=1 并重启）`
            : `服务器 ${base} 返回 ${res.status}`
        );
      }
    } catch (err) {
      setTestStatus("fail");
      setTestMessage(`${base} 连接失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  function handleSave() {
    if (blockedByActiveJobs) return;
    if (serverUrl.trim() && !isValidServerUrl(serverUrl)) {
      setTestStatus("fail");
      setTestMessage(`地址格式不正确：${serverUrl.trim()}。请填写形如 https://projectx.school.edu.cn 的完整地址`);
      return;
    }
    // 安全（R32）：跨机明文 HTTP 必须先显式勾选，否则不保存——保存了也只会让上传在
    // 发送 Key 前被闸门拦下，界面上表现为「配置好了但一直失败」，比这里直接拒绝更难查。
    const decision = evaluateCredentialTransport(normalizeServerUrl(serverUrl), readInsecureTransportHosts());
    if (decision.reason === "blocked-plaintext" && !allowInsecure) {
      setTestStatus("fail");
      setTestMessage(decision.message);
      return;
    }
    saveUrl(serverUrl);
    setServerUrl(loadUrl()); // 回显归一化后的实际生效地址
    storeApiKey(apiKey.trim() || null);
    // 同意只留给当前这一个 host:port；改成 https/回环时把历史明文同意一并清掉
    revokeInsecureTransportAllowance();
    if (decision.reason === "blocked-plaintext") grantInsecureTransportAllowance(loadUrl());
    serverStatus.refresh();
    scannerUploadManager.notifyNetworkChanged();
    if (mode === "dialog") onOpenChange?.(false);
    onSaved?.();
  }

  // embedded 模式：把最新 handleSave 挂到宿主 ref，登录提交前可兜底落盘
  useEffect(() => {
    if (mode !== "embedded" || !saveRef) return;
    saveRef.current = handleSave;
    return () => {
      saveRef.current = null;
    };
  });

  const form = (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-xs text-muted-foreground">
        扫描、识别和账号登录始终在本机完成。填入服务器地址和 API Key 后，可将扫描结果上传到远端服务器。
        跨机部署请填写 <code className="font-mono">https://</code> 地址；明文 HTTP 只在勾选确认后才会发送凭据。
      </p>
      {blockedByActiveJobs && (
        <p className="m-0 rounded border border-destructive-border bg-destructive-soft px-2 py-1 text-xs text-destructive-fg">
          上传任务正在进行，暂不能切换服务器。可稍候重试，或在进度卡「取消」已暂停/排队的任务。
        </p>
      )}
      {!blockedByActiveJobs && hasPending && configChanged && (
        <p className="m-0 rounded border border-warning-border bg-warning-soft px-2 py-1 text-xs text-warning-foreground">
          存在排队/暂停的上传任务：它们在切换服务器后仍发往原服务器；新任务将发往新服务器。可先到进度卡取消后再切换。
        </p>
      )}
      <Field label="服务器地址">
        <Input
          value={serverUrl}
          disabled={testStatus === "testing"}
          onChange={(e) => {
            setServerUrl(e.target.value);
            setTestStatus("");
            setTestMessage("");
          }}
          placeholder="https://projectx.school.edu.cn"
          autoComplete="off"
        />
      </Field>
      {serverUrl.trim() && normalizeServerUrl(serverUrl) !== serverUrl.trim() && (
        <p className="m-0 -mt-1 text-xs text-muted-foreground">
          将按 <code className="font-mono">{normalizeServerUrl(serverUrl)}</code> 使用
        </p>
      )}
      {insecureTarget && (
        <div className="m-0 rounded border border-warning-border bg-warning-soft px-2 py-1.5 text-xs text-warning-foreground">
          <p className="m-0">
            <code className="font-mono">{typedHost}</code> 是<strong>跨机明文 HTTP</strong>：
            API Key 与登录凭据会以明文经过整个网段，同网段任何人都能截走它，而这把 Key 能向服务器写入扫描结果。
            正式部署请改用 <code className="font-mono">https://</code> 地址（本机 <code className="font-mono">127.0.0.1</code> 不受此限）。
          </p>
          <label className="mt-1.5 flex cursor-pointer items-start gap-2">
            <Checkbox
              checked={allowInsecure}
              onCheckedChange={(checked) => setAllowInsecure(checked === true)}
              disabled={testStatus === "testing"}
              className="mt-0.5"
            />
            <span>
              我确认这是<strong>隔离的内网测试环境</strong>，允许向 <code className="font-mono">{typedHost}</code> 明文发送凭据。
              未勾选时不会保存该地址，上传也不会发出 API Key。
            </span>
          </label>
        </div>
      )}
      {!insecureTarget && typedHost && typedHost === savedHost && allowInsecure && (
        <p className="m-0 -mt-1 text-xs text-muted-foreground">
          已对 <code className="font-mono">{typedHost}</code> 勾选过明文发送许可；改成 https 后保存即可撤销。
        </p>
      )}
      <Field label="API Key">
        <div className="relative">
          <Input
            type={showKey ? "text" : "password"}
            value={apiKey}
            disabled={testStatus === "testing"}
            onChange={(e) => {
              setApiKey(e.target.value);
              setTestStatus("");
              setTestMessage("");
            }}
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
            服务器可达，上传权限有效
          </Badge>
        )}
        {testStatus === "fail" && <Badge tone="danger" dot>{testMessage || "连接失败"}</Badge>}
        <Button
          variant="primary"
          size="sm"
          type="button"
          className="ml-auto"
          onClick={handleSave}
          disabled={blockedByActiveJobs}
          title={blockedByActiveJobs ? "存在进行中任务，禁止切服" : undefined}
        >
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
