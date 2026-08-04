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
    "beian-footer inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground";
  const position = floating
    ? "absolute bottom-3 right-3 z-10 pointer-events-auto"
    : "static";
  return (
    <div className={`${base} ${position} ${className}`.trim()}>
      <a className="beian-link hover:underline" href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
        辽ICP备2026013340号
      </a>
      <a
        className="beian-link inline-flex items-center gap-1 hover:underline"
        href="https://beian.mps.gov.cn/#/query/webSearch?code=21020402001085"
        rel="noreferrer"
        target="_blank"
      >
        <img className="beian-icon size-3.5" src={beianIconUrl} alt="" />
        <span>辽公网安备21020402001085号</span>
      </a>
    </div>
  );
}