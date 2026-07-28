"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/code-block";

interface MarkdownRendererProps {
  content: string;
}

function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    return extractText((node as { props: { children: unknown } }).props.children);
  }
  return "";
}

const components = {
  // ── Code ────────────────────────────────────────────────────────────────────
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || "");
    const isBlock = Boolean(match || className);

    if (!isBlock) {
      return (
        <code
          className="px-1.5 py-0.5 rounded-md font-mono text-[0.82em] bg-muted text-foreground border border-border/60"
          {...props}
        >
          {children}
        </code>
      );
    }

    return (
      <CodeBlock language={match?.[1]}>
        {extractText(children).replace(/\n$/, "")}
      </CodeBlock>
    );
  },

  pre({ children }: any) {
    return <>{children}</>;
  },

  // ── Headings ────────────────────────────────────────────────────────────────
  h1({ children }: any) {
    return (
      <h1 className="text-xl font-bold text-foreground mt-7 mb-3 leading-snug tracking-tight">
        {children}
      </h1>
    );
  },
  h2({ children }: any) {
    return (
      <h2 className="text-base font-semibold text-foreground mt-6 mb-2.5 leading-snug tracking-tight">
        {children}
      </h2>
    );
  },
  h3({ children }: any) {
    return (
      <h3 className="text-sm font-semibold text-foreground mt-5 mb-2 leading-snug">
        {children}
      </h3>
    );
  },
  h4({ children }: any) {
    return (
      <h4 className="text-sm font-medium text-foreground mt-4 mb-1.5 leading-snug">
        {children}
      </h4>
    );
  },

  // ── Paragraph ───────────────────────────────────────────────────────────────
  p({ children }: any) {
    return (
      <p className="text-sm leading-relaxed text-foreground my-2.5">
        {children}
      </p>
    );
  },

  // ── Lists ───────────────────────────────────────────────────────────────────
  ul({ children }: any) {
    return (
      <ul className="my-2.5 ml-1 space-y-1 list-none">
        {children}
      </ul>
    );
  },
  ol({ children }: any) {
    return (
      <ol className="my-2.5 ml-1 space-y-1 list-none counter-reset-[item]">
        {children}
      </ol>
    );
  },
  li({ children, ordered, index }: any) {
    return (
      <li className="flex gap-2.5 text-sm text-foreground leading-relaxed">
        <span className="mt-[0.3em] shrink-0 text-muted-foreground select-none">
          {ordered ? `${(index ?? 0) + 1}.` : "•"}
        </span>
        <span className="flex-1 min-w-0">{children}</span>
      </li>
    );
  },

  // ── Blockquote ──────────────────────────────────────────────────────────────
  blockquote({ children }: any) {
    return (
      <blockquote className="my-4 relative pl-4 border-l-2 border-primary/40">
        <div className="text-sm text-muted-foreground italic leading-relaxed">
          {children}
        </div>
      </blockquote>
    );
  },

  // ── Table ───────────────────────────────────────────────────────────────────
  table({ children }: any) {
    return (
      <div className="my-4 overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  thead({ children }: any) {
    return (
      <thead className="bg-muted/60 border-b border-border">
        {children}
      </thead>
    );
  },
  tbody({ children }: any) {
    return <tbody className="divide-y divide-border/50">{children}</tbody>;
  },
  tr({ children }: any) {
    return (
      <tr className="transition-colors hover:bg-muted/30">
        {children}
      </tr>
    );
  },
  th({ children }: any) {
    return (
      <th className="px-3.5 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
        {children}
      </th>
    );
  },
  td({ children }: any) {
    return (
      <td className="px-3.5 py-2.5 text-sm text-foreground">
        {children}
      </td>
    );
  },

  // ── Inline ──────────────────────────────────────────────────────────────────
  a({ href, children }: any) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 decoration-primary/40 hover:decoration-primary transition-colors"
      >
        {children}
      </a>
    );
  },
  strong({ children }: any) {
    return (
      <strong className="font-semibold text-foreground">{children}</strong>
    );
  },
  em({ children }: any) {
    return <em className="italic text-foreground/90">{children}</em>;
  },
  del({ children }: any) {
    return <del className="line-through text-muted-foreground">{children}</del>;
  },

  // ── Misc ────────────────────────────────────────────────────────────────────
  hr() {
    return <hr className="my-5 border-border/60" />;
  },
  img({ src, alt }: any) {
    return (
      <span className="relative inline-block group/img">
        <img
          src={src}
          alt={alt}
          className="my-4 rounded-xl border border-border max-w-full h-auto"
        />
        {src && (
          <a
            href={src}
            download
            target="_blank"
            rel="noopener noreferrer"
            className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white opacity-0 group-hover/img:opacity-100 transition-opacity hover:bg-black/70"
            title="Download image"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
      </span>
    );
  },
};

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  // Strip [GENERATE_IMAGE: ...] markers — images are handled via SSE image events
  const cleaned = content.replace(/\[GENERATE_IMAGE:\s*.+?\]/g, "").trim();

  return (
    <div dir="auto" className="max-w-none text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components as any}
      >
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}