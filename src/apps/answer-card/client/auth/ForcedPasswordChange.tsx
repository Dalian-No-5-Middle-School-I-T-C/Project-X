import { useState, type FormEvent } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { fetchJson } from "./api";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "../components/ui/v2";

interface Props {
  username: string;
  onChanged: () => void;
}

export function ForcedPasswordChange({ username, onChanged }: Props) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    try {
      await fetchJson("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword })
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改密码失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center overflow-y-auto bg-background p-6">
      <Card className="w-full max-w-[460px]">
        <CardHeader>
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground"><ShieldCheck size={22} /></div>
          <CardTitle className="mt-3">首次登录安全设置</CardTitle>
          <CardDescription>账号 {username} 必须先修改一次性密码</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
            <Field label="一次性密码">
              <Input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="请输入当前一次性密码"
                autoComplete="current-password"
                disabled={busy}
              />
            </Field>
            <Field label="新密码">
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="设置新密码"
                autoComplete="new-password"
                disabled={busy}
              />
            </Field>
            <Field label="确认新密码">
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入新密码"
                autoComplete="new-password"
                disabled={busy}
              />
            </Field>
            {error && <p className="text-sm text-destructive-fg">{error}</p>}
            <Button
              variant="primary"
              size="lg"
              block
              type="submit"
              disabled={busy || !oldPassword || !newPassword || !confirmPassword}
              loading={busy}
            >
              {!busy && <KeyRound size={17} />} 修改密码并重新登录
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
