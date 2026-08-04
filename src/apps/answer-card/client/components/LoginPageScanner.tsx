import { useState, type FormEvent } from "react";
import { BookOpen, ChevronDown, ChevronRight, Globe, LogIn, Shield } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { BeianFooter } from "./BeianFooter";
import { UserGuideModal } from "./UserGuideModal";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ControlRow,
  Field,
  Input,
} from "./ui/v2";

// v1.6.0: 远端服务器配置（仅扫描端需要）
const SERVER_URL_STORAGE = "projectx_server_url";
const API_KEY_STORAGE = "projectx_api_key";

function loadServerUrl(): string {
  try {
    return localStorage.getItem(SERVER_URL_STORAGE) ?? "";
  } catch {
    return "";
  }
}
function saveServerUrl(url: string): void {
  try {
    localStorage.setItem(SERVER_URL_STORAGE, url);
  } catch {
    /* ignore */
  }
}
function loadApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}
function saveApiKey(key: string): void {
  try {
    localStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    /* ignore */
  }
}

export function LoginPageScanner() {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  // v1.6.0: 远端连接配置
  const [showRemote, setShowRemote] = useState(!!loadServerUrl());
  const [serverUrl, setServerUrl] = useState(loadServerUrl());
  const [apiKey, setApiKey] = useState(loadApiKey());
  const [testStatus, setTestStatus] = useState<"" | "testing" | "ok" | "fail">("");
  const [testMessage, setTestMessage] = useState("");

  async function handleTestConnection() {
    if (!serverUrl.trim()) return;
    setTestStatus("testing");
    setTestMessage("");
    try {
      const url = serverUrl.replace(/\/+$/, "") + "/api/app/health";
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
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

  function handleSaveRemoteConfig() {
    const url = serverUrl.trim().replace(/\/+$/, "");
    saveServerUrl(url);
    saveApiKey(apiKey.trim());
    setShowRemote(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!identifier.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    // 每次提交前同步服务器URL到localStorage
    const url = serverUrl.trim().replace(/\/+$/, "");
    if (url) saveServerUrl(url);
    saveApiKey(apiKey.trim());

    setBusy(true);
    try {
      await login(identifier.trim(), password, rememberMe);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-4 bg-background p-4">
      <Card className="w-full max-w-[420px] p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
            <Shield size={22} />
          </div>
          <div className="min-w-0">
            <strong className="block text-lg font-semibold leading-tight">答题卡扫描端</strong>
            <span className="block text-sm text-muted-foreground">Project-X · 账号登录</span>
          </div>
        </div>

        <form className="mt-5 flex flex-col gap-4" onSubmit={(e) => void handleSubmit(e)}>
          {/* ── v1.6.0: 远端服务器配置 ── */}
          <div>
            <Button
              variant="outline"
              block
              type="button"
              onClick={() => setShowRemote(!showRemote)}
              icon={<Globe size={14} />}
              iconRight={showRemote ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            >
              服务器连接（可选）
            </Button>
            {showRemote && (
              <div className="mt-2 flex flex-col gap-3 rounded-md border border-border-subtle bg-secondary p-3">
                <p className="m-0 text-xs text-muted-foreground">
                  扫描、识别和账号登录始终在本机完成。填入服务器地址和 API Key 后，可将扫描结果上传到远端服务器。
                </p>
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
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-xxx..."
                    autoComplete="off"
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    loading={testStatus === "testing"}
                    onClick={() => void handleTestConnection()}
                    disabled={!serverUrl.trim() || testStatus === "testing"}
                  >
                    {testStatus === "testing" ? "测试中..." : "测试连接"}
                  </Button>
                  {testStatus === "ok" && <Badge tone="success" dot>服务器可达</Badge>}
                  {testStatus === "fail" && (
                    <Badge tone="danger" dot>
                      {testMessage || "连接失败"}
                    </Badge>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    type="button"
                    className="ml-auto"
                    onClick={handleSaveRemoteConfig}
                  >
                    保存配置
                  </Button>
                </div>
              </div>
            )}
          </div>

          <Field label="用户名 / 学号 / 职工号">
            <Input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="请输入用户名 / 学号"
              autoComplete="username"
              disabled={busy}
            />
          </Field>
          <Field label="密码">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
              disabled={busy}
            />
          </Field>
          <ControlRow
            control={
              <Checkbox
                checked={rememberMe}
                onCheckedChange={(c) => setRememberMe(c === true)}
                disabled={busy}
              />
            }
            label="记住密码（6个月内免登录）"
          />
          {error && <p className="m-0 text-sm text-destructive-fg">{error}</p>}
          <Button variant="primary" block type="submit" loading={busy} icon={<LogIn size={17} />}>
            {busy ? "登录中..." : "登录"}
          </Button>
          <Button
            variant="outline"
            block
            type="button"
            onClick={() => setShowGuide(true)}
            disabled={busy}
            icon={<BookOpen size={16} />}
          >
            使用说明
          </Button>
        </form>
      </Card>
      <BeianFooter className="text-xs" />
      <UserGuideModal open={showGuide} onClose={() => setShowGuide(false)} />
    </div>
  );
}
