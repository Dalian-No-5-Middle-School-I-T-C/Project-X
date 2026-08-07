import { useState, type FormEvent } from "react";
import { BookOpen, LogIn, Shield } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { BeianFooter } from "./BeianFooter";
import { UserGuideModal } from "./UserGuideModal";
import { SkinSwitcher } from "./SkinSwitcher";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ControlRow, Field, Input, Switch } from "./ui/v2";

export function LoginPage() {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

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
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-y-auto bg-background p-6">
      {/* v2.1.0: 登录页皮肤入口（自管模式：登录前直接读写 localStorage + data-* 属性；
          登录后由 App 接管，本地选择优先并同步到账号） */}
      <SkinSwitcher className="absolute right-4 top-4 z-10" />
      <Card className="login-card-demo grid w-full max-w-[820px] overflow-hidden shadow-3 md:grid-cols-[340px_minmax(0,1fr)]">
        <div className="login-brand-panel flex flex-col gap-3 border-b border-border-subtle bg-secondary p-7 md:border-b-0 md:border-r">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Shield size={22} /></div>
          <div>
            <h1 className="text-3xl font-bold leading-tight tracking-tight text-foreground">答题卡设计<br />阅卷系统</h1>
            <p className="mt-2 text-sm text-muted-foreground">Project-X · 大连市第五中学</p>
          </div>
          <div className="mt-auto flex flex-col gap-2 pt-6 text-sm text-secondary-foreground">
            <span>扫描识别 · 手写判分入库</span>
            <span>成绩分析 · 班级对比</span>
            <span>学生端 · 仅本人可见</span>
          </div>
        </div>
        <CardContent className="flex flex-col justify-center gap-4 p-8 md:p-12">
          <CardHeader className="space-y-1 p-0">
            <CardTitle>欢迎回来</CardTitle>
            <CardDescription>使用工号 / 学号登录 Project-X</CardDescription>
          </CardHeader>
          <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(e)}>
            <Field label="账号">
              <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="工号 / 学号" autoComplete="username" disabled={busy} />
            </Field>
            <Field label="密码">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" autoComplete="current-password" disabled={busy} />
            </Field>
            <div className="flex items-center justify-between gap-3 text-sm text-secondary-foreground">
              <ControlRow
                control={<Switch id="remember-me" checked={rememberMe} onCheckedChange={setRememberMe} disabled={busy} />}
                label="记住登录"
                htmlFor="remember-me"
              />
              <button type="button" className="text-accent-foreground hover:underline" onClick={() => setError("请联系管理员重置密码")} disabled={busy}>忘记密码？</button>
            </div>
            {error && <p className="text-sm text-destructive-fg">{error}</p>}
            <Button variant="primary" size="lg" block type="submit" disabled={busy} loading={busy}>{!busy && <LogIn size={17} />} 登录</Button>
            <Button variant="ghost" block type="button" onClick={() => setShowGuide(true)} disabled={busy}><BookOpen size={16} /> 使用说明</Button>
            <p className="text-center text-xs text-muted-foreground">首次登录需修改初始密码 · 登录即代表同意校内使用规范</p>
          </form>
        </CardContent>
      </Card>
      <BeianFooter className="absolute inset-x-0 bottom-4 justify-center" floating />
      <UserGuideModal open={showGuide} onClose={() => setShowGuide(false)} />
    </div>
  );
}
