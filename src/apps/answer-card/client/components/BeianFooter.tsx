import { useEffect, useState } from "react";
import beianIconUrl from "../../../../../resources/备案图标.png";

type BeianConfig = {
  icp?: string;
  publicSecurity?: string;
};

type BeianFooterProps = {
  className?: string;
  /** Position the footer over the login page or loading shell. */
  floating?: boolean;
};

export function BeianFooter({ className = "", floating = false }: BeianFooterProps) {
  const [config, setConfig] = useState<BeianConfig | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function loadConfig() {
      try {
        const response = await fetch("/beian.json", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const data: BeianConfig | null = await response.json();
        if (!controller.signal.aborted) setConfig(data);
      } catch {
        // The footer is optional if the configuration cannot be loaded.
      }
    }
    void loadConfig();
    return () => controller.abort();
  }, []);

  const icp = typeof config?.icp === "string" ? config.icp.trim() : "";
  const publicSecurity = typeof config?.publicSecurity === "string" ? config.publicSecurity.trim() : "";
  const publicSecurityCode = publicSecurity.match(/\d+/)?.[0];
  if (!icp && !publicSecurityCode) return null;

  const base =
    "inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground";
  const position = floating
    ? "absolute bottom-3 right-3 z-10 pointer-events-auto"
    : "static";
  const linkClassName = "inline-flex items-center gap-1 text-muted-foreground no-underline opacity-75";
  return (
    <div className={`${base} ${position} ${className}`.trim()}>
      {icp && (
        <a className={linkClassName} href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
          {icp}
        </a>
      )}
      {publicSecurityCode && (
        <a
          className={linkClassName}
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${publicSecurityCode}`}
          rel="noreferrer"
          target="_blank"
        >
          <img className="size-3.5 shrink-0 opacity-70" src={beianIconUrl} alt="" />
          <span>{publicSecurity}</span>
        </a>
      )}
    </div>
  );
}
