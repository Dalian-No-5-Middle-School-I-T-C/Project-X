import { useState, type FormEvent } from "react";
import { BookOpen, ChevronDown, ChevronRight, Globe, LogIn, Shield } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { BeianFooter } from "./BeianFooter";
import { ServerConfigDialog } from "./ServerConfigDialog";
import { SkinSwitcher } from "./SkinSwitcher";
import { UserGuideModal } from "./UserGuideModal";
import { Button, Card, Checkbox, ControlRow, Field, Input } from "./ui/v2";

// 远端服务器配置已抽至 ServerConfigDialog（复用 SERVER_URL_KEY / getStoredApiKey/storeApiKey）
function hasStoredServerUrl(): boolean {
  try {
    return (localStorage.getItem("projectx_server_url") ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

interface Props {
  /** v2.5.0: 受控皮肤（由 ScannerApp 下发；未传时回退自管模式，保持组件独立可用） */
  skin?: string;
  onSkinChange?: (skin: string) => void;
}

export function LoginPageScanner({ skin, onSkinChange }: Props) {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  // 远端连接配置（表单已抽至 ServerConfigDialog:embedded）
  const [showRemote, setShowRemote] = useState(hasStoredServerUrl);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!identifier.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }

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
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-center gap-4 bg-background p-4">
      {/* v2.5.0: 扫描端登录页皮肤入口（受控模式：由 ScannerApp 下发 skin/onSkinChange，
          登录前切换即更新 App state——避免自管模式下认证完成时以陈旧闭包 skin 误发 PATCH
          覆盖账号偏好；未传 props 时回退自管模式） */}
      <div className="absolute right-4 top-4 z-10">
        {skin !== undefined && onSkinChange ? (
          <SkinSwitcher skin={skin} onSkinChange={onSkinChange} />
        ) : (
          <SkinSwitcher />
        )}
      </div>
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
          {/* ── 远端服务器配置（已抽共用组件） ── */}
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
            {showRemote && <ServerConfigDialog mode="embedded" />}
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
      <BeianFooter className="text-xs" floating />
      <UserGuideModal open={showGuide} onClose={() => setShowGuide(false)} />
    </div>
  );
}
