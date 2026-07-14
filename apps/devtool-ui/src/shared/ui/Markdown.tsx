import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownComponents = ComponentProps<typeof ReactMarkdown>["components"];

// Compact element styles tuned for narrow side panels (no typography plugin).
const components: MarkdownComponents = {
  h1: ({ children }) => <div className="font-semibold text-foreground">{children}</div>,
  h2: ({ children }) => <div className="font-semibold text-foreground">{children}</div>,
  h3: ({ children }) => <div className="font-semibold text-foreground">{children}</div>,
  h4: ({ children }) => <div className="font-semibold text-foreground">{children}</div>,
  h5: ({ children }) => <div className="font-semibold text-foreground">{children}</div>,
  h6: ({ children }) => <div className="font-semibold text-foreground">{children}</div>,
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-4 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 break-all"
    >
      {children}
    </a>
  ),
  code: ({ children, className }) =>
    className ? (
      // Block code (inside <pre>): className carries the language- prefix
      <code className={`${className} font-mono text-xs`}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded border border-border bg-background/60 px-2 py-1.5">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-2 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border" />,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted/40 px-1.5 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-border px-1.5 py-1 align-top">{children}</td>,
};

export function Markdown({ content }: { content: string }) {
  return (
    <div className="space-y-2 break-words text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
