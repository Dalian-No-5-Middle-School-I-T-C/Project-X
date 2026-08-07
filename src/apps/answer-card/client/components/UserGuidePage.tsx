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
      <article className="mx-auto w-full max-w-3xl px-6 py-8 text-sm leading-[1.75] text-secondary-foreground max-[480px]:text-[13px] max-[480px]:leading-[1.7]">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...props }) => {
              if (href && !href.startsWith("http") && !href.startsWith("mailto:")) {
                return <span title={href} {...props}>{children}</span>;
              }
              return <a className="text-primary hover:underline" href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
            },
            h1: ({ children, ...props }) => (
              <h1 className="mb-[0.6em] mt-0 text-2xl leading-[1.35] text-foreground max-[480px]:text-xl" {...props}>{children}</h1>
            ),
            h2: ({ children, ...props }) => (
              <h2 className="mb-[0.6em] mt-[1.4em] border-b border-border-subtle pb-[0.35em] text-[1.15rem] leading-[1.35] text-foreground max-[480px]:text-[1.05rem]" {...props}>{children}</h2>
            ),
            h3: ({ children, ...props }) => (
              <h3 className="mb-[0.6em] mt-[1.4em] text-base leading-[1.35] text-foreground" {...props}>{children}</h3>
            ),
            p: ({ children, ...props }) => (
              <p className="my-[0.75em]" {...props}>{children}</p>
            ),
            ul: ({ children, ...props }) => (
              <ul className="my-[0.75em] list-disc pl-[1.4em] [&>li+li]:mt-[0.25em]" {...props}>{children}</ul>
            ),
            ol: ({ children, ...props }) => (
              <ol className="my-[0.75em] list-decimal pl-[1.4em] [&>li+li]:mt-[0.25em]" {...props}>{children}</ol>
            ),
            li: ({ children, ...props }) => (
              <li {...props}>{children}</li>
            ),
            blockquote: ({ children, ...props }) => (
              <blockquote className="my-[0.75em] rounded-r-md border-l-[3px] border-primary bg-secondary px-4 py-[0.6em] text-muted-foreground" {...props}>{children}</blockquote>
            ),
            code: ({ children, ...props }) => (
              <code className="rounded-xs bg-secondary px-[0.35em] py-[0.1em] font-mono text-[0.92em]" {...props}>{children}</code>
            ),
            pre: ({ children, ...props }) => (
              <pre className="my-[0.75em] overflow-x-auto rounded-md border border-border-subtle bg-secondary px-3.5 py-3 [&_code]:bg-transparent [&_code]:p-0 max-[480px]:p-2.5 max-[480px]:text-xs" {...props}>{children}</pre>
            ),
            table: ({ children, ...props }) => (
              <table className="my-[0.75em] w-full border-collapse text-[13px] max-[480px]:block max-[480px]:overflow-x-auto max-[480px]:text-[11px]" {...props}>{children}</table>
            ),
            th: ({ children, ...props }) => (
              <th className="border border-border-subtle bg-secondary px-2.5 py-2 text-left align-top font-semibold text-foreground" {...props}>{children}</th>
            ),
            td: ({ children, ...props }) => (
              <td className="border border-border-subtle px-2.5 py-2 text-left align-top" {...props}>{children}</td>
            ),
            hr: (props) => (
              <hr className="my-[1.5em] border-0 border-t border-border-subtle" {...props} />
            ),
            em: ({ children, ...props }) => (
              <em className="text-muted-foreground" {...props}>{children}</em>
            ),
          }}
        >
          {userGuideMarkdown}
        </ReactMarkdown>
      </article>
    </div>
  );
}
