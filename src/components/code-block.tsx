"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { Copy, Check, Download } from "lucide-react";
import { downloadText, getFilenameForDownload } from "@/lib/download";

interface CodeBlockProps {
  children: ReactNode;
  language?: string;
  inline?: boolean;
}

export function CodeBlock({ children, language, inline }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  if (inline) {
    return (
      <code className="px-1.5 py-0.5 rounded-md bg-accent text-accent-foreground text-[0.85em] font-mono border border-border">
        {children}
      </code>
    );
  }

  const codeText = extractText(children);

  function handleCopy() {
    navigator.clipboard.writeText(codeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    const filename = getFilenameForDownload(codeText, language || "");
    downloadText(codeText, filename);
  }

  return (
    <div className="group relative rounded-xl border border-border bg-card overflow-hidden my-3">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-accent/50">
        <span className="text-xs font-mono text-muted-foreground">
          {language || "code"}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Copy code"
          >
            {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
            <span className="hidden sm:inline">{copied ? "Copied!" : "Copy"}</span>
          </button>
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Download file"
          >
            <Download size={13} />
            <span className="hidden sm:inline">Download</span>
          </button>
        </div>
      </div>
      <pre className="p-4 overflow-x-auto text-sm leading-relaxed">
        <code ref={codeRef} className="font-mono text-foreground">
          {children}
        </code>
      </pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as any).props.children);
  }
  return "";
}
