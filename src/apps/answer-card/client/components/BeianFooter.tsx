import beianIconUrl from "../../../../../resources/备案图标.png";

type BeianFooterProps = {
  className?: string;
  /**
   * When true, the footer is absolutely positioned at the bottom-right of its
   * nearest positioned ancestor. Use this in full-screen flex containers
   * (LoginPage / LoginPageScanner / loading shell) so the footer does NOT
   * participate in the flex flow and crowd the centered content.
   * In inline contexts (e.g. StatusBar) leave this false.
   */
  floating?: boolean;
};

export function BeianFooter({ className = "", floating = false }: BeianFooterProps) {
  const base =
    "inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground";
  const position = floating
    ? "absolute bottom-3 right-3 z-10 pointer-events-auto"
    : "static";
  return (
    <div className={`${base} ${position} ${className}`.trim()}>
      <a className="inline-flex items-center gap-1 text-muted-foreground no-underline opacity-75" href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
        辽ICP备2026013340号
      </a>
      <a
        className="inline-flex items-center gap-1 text-muted-foreground no-underline opacity-75"
        href="https://beian.mps.gov.cn/#/query/webSearch?code=21020402001085"
        rel="noreferrer"
        target="_blank"
      >
        <img className="size-3.5 shrink-0 opacity-70" src={beianIconUrl} alt="" />
        <span>辽公网安备21020402001085号</span>
      </a>
    </div>
  );
}