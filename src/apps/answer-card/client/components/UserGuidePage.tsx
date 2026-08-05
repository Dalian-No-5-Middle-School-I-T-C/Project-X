import { ArrowLeft, BookOpen } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import userGuideMarkdown from "../../../../../user guide/Project-X用户使用说明.md?raw";
import { Button } from "./ui/v2";

export function UserGuidePage({ onBack, embedded }: { onBack?: () => void; embedded?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {!embedded && (
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <BookOpen size={20} className="text-foreground" />
            <strong className="text-lg font-semibold text-foreground">Project-X 用户使用说明</strong>
          </div>
          {onBack && (
            <Button variant="outline" size="sm" icon={<ArrowLeft size={16} />} onClick={onBack}>
              返回
            </Button>
          )}
        </header>
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
