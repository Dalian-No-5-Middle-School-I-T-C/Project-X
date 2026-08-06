import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, QrCode } from "lucide-react";
import { fetchJson } from "../auth/api";
import { Button, Card, CardContent } from "./ui/v2";

interface SponsorChannel {
  id: string;
  name: string;
  enabled: boolean;
  qrUrl?: string | null;
}

interface SponsorConfig {
  title: string;
  description: string;
  channels: SponsorChannel[];
}

export function SponsorPage({ onBack }: { onBack: () => void }) {
  const [config, setConfig] = useState<SponsorConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadConfig = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson<SponsorConfig>("/api/sponsor");
      setConfig(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
      setConfig(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <strong className="text-lg font-semibold text-foreground">{config?.title ?? "支持 Project-X"}</strong>
        <Button variant="outline" size="sm" icon={<ArrowLeft size={16} />} onClick={onBack}>
          返回
        </Button>
      </header>

      {error && <p className="text-sm text-destructive-fg">{error}</p>}

      {busy && !config && <p className="text-sm text-muted-foreground">正在加载...</p>}

      {config && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {config.channels.map((channel) => (
              <Card key={channel.id}>
                <CardContent className="flex flex-col items-center gap-3">
                  <p className="text-sm font-medium text-foreground">{channel.name}</p>
                  {channel.qrUrl ? (
                    <img
                      className="h-40 w-40 rounded-md border border-border-subtle object-contain"
                      src={channel.qrUrl}
                      alt={`${channel.name}收款码`}
                    />
                  ) : (
                    <div className="flex h-40 w-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-muted-foreground">
                      <QrCode size={32} />
                      <span className="text-xs">收款码待配置</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{config.description}</p>
        </div>
      )}
    </div>
  );
}
