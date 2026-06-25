import beianIconUrl from "../../../../../resources/备案图标.png";

type BeianFooterProps = {
  className?: string;
};

export function BeianFooter({ className = "" }: BeianFooterProps) {
  return (
    <div className={`beian-footer ${className}`.trim()}>
      <a className="beian-link" href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
        辽ICP备2026013340号
      </a>
      <a
        className="beian-link"
        href="https://beian.mps.gov.cn/#/query/webSearch?code=21020402001085"
        rel="noreferrer"
        target="_blank"
      >
        <img className="beian-icon" src={beianIconUrl} alt="" />
        <span>辽公网安备21020402001085号</span>
      </a>
    </div>
  );
}