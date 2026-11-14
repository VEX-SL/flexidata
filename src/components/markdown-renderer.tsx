"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/code-block";

interface MarkdownRendererProps {
  content: string;
  /**
   * When true, the renderer is in "streaming mode": content is appended
   * token-by-token. Instead of waiting for the response to finish, every
   * frame renders the largest SAFE prefix of the markdown:
   *
   *  - Plain text (e.g. "hey") renders instantly, character by character.
   *  - When a markdown-relevant character appears (`*`, `` ` ``, `[`, `<`,
   *    `&`, `~`) the ambiguous tail is HELD BACK for a frame until the
   *    stream resolves it (e.g. `**` → bold opener, `[` → command/link).
   *  - Constructs that are clearly OPEN render immediately in their final
   *    style by auto-closing them: `**bold` shows as bold while streaming,
   *    an unclosed ``` fence shows as a live code block, etc. The literal
   *    `**` / ` ``` ` characters are never flashed to the user.
   *
   * When false (saved messages), the exact content is rendered as-is.
   */
  streaming?: boolean;
}

// ─── Incremental markdown safety ─────────────────────────────────────────────

const FENCE_LINE_RE = /^[ \t]*(?:```|~~~)/;

/**
 * Walk the text line by line and report:
 *  - inFence:     the text ends INSIDE an unclosed ``` / ~~~ code fence
 *  - backtickOdd: an odd number of backticks outside fences (unclosed `code`)
 */
function scanStructure(text: string): { inFence: boolean; backtickOdd: boolean } {
  let inFence = false;
  let backticks = 0;
  for (const line of text.split("\n")) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) backticks += (line.match(/`/g) || []).length;
  }
  return { inFence, backtickOdd: backticks % 2 === 1 };
}

/** Mask code so delimiter counting never mistakes code samples for formatting. */
function maskCodeForEmphasis(text: string): string {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      return line.replace(/[^\n]/g, " ");
    }
    if (inFence) return line.replace(/[^\n]/g, " ");
    return line.replace(/(`+)[^\n]*?\1/g, (code) => code.replace(/[^\n]/g, " "));
  }).join("\n");
}

/**
 * Given a PARTIAL markdown document (mid-stream), return the text that is
 * safe to render RIGHT NOW plus auto-closers for clearly-open constructs.
 *
 * HOLD rules (the tail is not displayed until resolved):
 *  - "[" with no "]" and no newline yet  → could be a command ([NEW_FILE: …],
 *    [QUICK_RESPONSE]) or a link — hold from the "["
 *  - "<tag" with no ">" yet              → could be an HTML tag — hold
 *  - "&ent" (<10 chars, no ";" / space)  → could be an entity — hold
 *  - trailing run of *_~`                → could be an opener or closer — hold
 *
 * AUTO-CLOSE rules (render in final style immediately):
 *  - open code fence      → append closing fence (live code block)
 *  - odd inline backtick  → append closing backtick (live inline code)
 *  - odd "**" occurrences → append "**" (bold shows instantly, exactly like
 *    the user asked: text after a streamed "**" renders bold right away)
 *  - odd "~~" occurrences → append "~~" (strikethrough)
 */
export function makeStreamSafe(md: string): string {
  if (!md) return md;
  let end = md.length;
  const { inFence } = scanStructure(md);

  if (!inFence) {
    // 1) Unmatched `[` may become a command, link, or image: hold it.
    const lb = md.lastIndexOf("[");
    if (lb !== -1) {
      const rest = md.slice(lb);
      const bracketStart = md[lb - 1] === "!" ? lb - 1 : lb;
      const closeBracket = rest.indexOf("]");
      if (closeBracket === -1 && !rest.includes("\n")) {
        end = Math.min(end, bracketStart);
      } else if (closeBracket !== -1) {
        // After `[label]`, wait one more token to learn whether this is a
        // literal bracket or the start of `[label](destination)`.
        const afterLabel = rest.slice(closeBracket + 1);
        if (
          afterLabel === "" ||
          (afterLabel.startsWith("(") && !afterLabel.includes(")"))
        ) {
          end = Math.min(end, bracketStart);
        }
      }
    }
    // 2) "<tag"-like tail with no ">" yet (plain "a < b" is NOT held).
    const lt = md.lastIndexOf("<");
    if (lt !== -1) {
      const rest = md.slice(lt);
      if (!rest.includes(">") && /^<[a-zA-Z!/?]/.test(rest)) end = Math.min(end, lt);
    }
    // 3) "&entity" that hasn't closed yet.
    const amp = md.lastIndexOf("&");
    if (amp !== -1 && md.length - amp <= 10) {
      const rest = md.slice(amp);
      if (!rest.includes(";") && !/\s/.test(rest)) end = Math.min(end, amp);
    }

    // Hold a line that currently consists only of a possible block marker.
    // Once its required space/content arrives, Markdown can render it live.
    const lineStart = md.lastIndexOf("\n") + 1;
    const tailLine = md.slice(lineStart);
    if (/^[ \t]{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])$/.test(tailLine)) {
      end = Math.min(end, lineStart);
    }
  }

  // 4) trailing delimiter run (always held, even inside fences — this is
  //    what hides the closing ``` / ** characters while they stream in).
  const tailRun = md.match(/[*_~`]{1,3}$/);
  if (tailRun) end = Math.min(end, md.length - tailRun[0].length);

  let safe = end > 0 ? md.slice(0, end) : "";

  // 5) auto-close clearly-open constructs so they render FINAL-style now.
  const st = scanStructure(safe);
  if (st.inFence) {
    safe += "\n```";
  } else {
    if (st.backtickOdd) safe += " `";
    const markdownText = maskCodeForEmphasis(safe);
    if ((markdownText.match(/(?<!\\)\*\*/g) || []).length % 2 === 1) safe += "**";
    if ((markdownText.match(/(?<!\\)__/g) || []).length % 2 === 1) safe += "__";
    if ((markdownText.match(/(?<!\\)(?<!\*)\*(?!\*)/g) || []).length % 2 === 1) safe += "*";
    if ((markdownText.match(/(?<!\\)(?<![A-Za-z0-9_])_(?!_)|(?<!_)_(?![A-Za-z0-9])/g) || []).length % 2 === 1) safe += "_";
    if ((markdownText.match(/(?<!\\)~~/g) || []).length % 2 === 1) safe += "~~";
  }
  return safe;
}

// ─── Component overrides ─────────────────────────────────────────────────────

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

export function MarkdownRenderer({ content, streaming = false }: MarkdownRendererProps) {
  // Memoize the cleaned content so React doesn't recompute on every parent
  // re-render (the regex replace runs only when content actually changes).
  const cleaned = useMemo(
    () => content.replace(/\[GENERATE_IMAGE:\s*.+?\]/g, "").trim(),
    [content]
  );

  // Streaming: render the safe prefix (holds ambiguous tails, auto-closes
  // open constructs). Plain text still streams instantly — only genuinely
  // ambiguous characters are held back for a frame or two.
  const visible = useMemo(
    () => (streaming ? makeStreamSafe(cleaned) : cleaned),
    [cleaned, streaming]
  );

  return (
    <div dir="auto" className="max-w-none text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as any}>
        {visible}
      </ReactMarkdown>
    </div>
  );
}
