import { ArrowLeft, BookOpen } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import userGuideMarkdown from "../../../../../user guide/Project-X用户使用说明.md?raw";

export function UserGuidePage({ onBack, embedded }: { onBack?: () => void; embedded?: boolean }) {
  return (
    <div className="user-guide-page">
      {!embedded && (
        <div className="account-panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <BookOpen size={20} />
            <strong>Project-X 用户使用说明</strong>
          </div>
          {onBack && (
            <button className="ghost-button" type="button" onClick={onBack}>
              <ArrowLeft size={16} /> 返回
            </button>
          )}
        </div>
      )}
      <article className="user-guide-content markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...props }) => {
              if (href && !href.startsWith("http") && !href.startsWith("mailto:")) {
                return <span className="guide-link-disabled" title={href} {...props}>{children}</span>;
              }
              return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
            }
          }}
        >
          {userGuideMarkdown}
        </ReactMarkdown>
      </article>
    </div>
  );
}
