import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, QrCode } from "lucide-react";
import { fetchJson } from "../auth/api";

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
    <div className="sponsor-page">
      <div className="account-panel-header">
        <div>
          <strong>{config?.title ?? "支持 Project-X"}</strong>
        </div>
        <button className="ghost-button" type="button" onClick={onBack}>
          <ArrowLeft size={16} /> 返回
        </button>
      </div>

      {error && <p className="login-error">{error}</p>}

      {busy && !config && <p className="empty-text">正在加载...</p>}

      {config && (
        <div className="sponsor-content">
          <div className="sponsor-channel-grid">
            {config.channels.map((channel) => (
              <div key={channel.id} className="analysis-card sponsor-channel-card">
                <p className="hint sponsor-channel-name">{channel.name}</p>
                {channel.qrUrl ? (
                  <img
                    className="sponsor-qr-image"
                    src={channel.qrUrl}
                    alt={`${channel.name}收款码`}
                  />
                ) : (
                  <div className="sponsor-qr-placeholder">
                    <QrCode size={32} />
                    <span>收款码待配置</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="empty-text sponsor-description">{config.description}</p>
        </div>
      )}
    </div>
  );
}
