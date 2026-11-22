"use client";

import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Sparkles,
  Wrench,
  FileCode,
  Trash2,
  Image as ImageIcon,
  Search,
  Terminal,
  Brain,
  MousePointer2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ToolStep {
  type:
    | "thinking"
    | "skill"
    | "file_edit"
    | "new_file"
    | "file_delete"
    | "image"
    | "search"
    | "cmd"
    | "browser";
  title: string;
  content?: string;
  duration_ms?: number;
  timestamp?: number;
}

const STEP_STYLES: Record<ToolStep["type"], { icon: LucideIcon; color: string; bg: string }> = {
  thinking:    { icon: Brain,    color: "text-purple-500",    bg: "bg-muted/40 border-border/60 hover:border-border" },
  skill:       { icon: Sparkles, color: "text-blue-500",      bg: "bg-muted/40 border-border/60 hover:border-border" },
  file_edit:   { icon: FileCode, color: "text-amber-500",     bg: "bg-muted/40 border-border/60 hover:border-border" },
  new_file:    { icon: FileCode, color: "text-emerald-500",   bg: "bg-muted/40 border-border/60 hover:border-border" },
  file_delete: { icon: Trash2,   color: "text-red-500",       bg: "bg-muted/40 border-border/60 hover:border-border" },
  image:       { icon: ImageIcon,color: "text-pink-500",      bg: "bg-muted/40 border-border/60 hover:border-border" },
  search:      { icon: Search,   color: "text-cyan-500",      bg: "bg-muted/40 border-border/60 hover:border-border" },
  cmd:         { icon: Terminal, color: "text-orange-500",    bg: "bg-muted/40 border-border/60 hover:border-border" },
  browser:     { icon: MousePointer2, color: "text-sky-500",  bg: "bg-muted/40 border-border/60 hover:border-border" },
};

// Custom slim scrollbars for the expanded step content — the native
// scrollbars (with their big up/down ARROW buttons on Windows) looked
// terrible inside the dark event drawer.
const STEP_SCROLL_CSS = `
.fd-step-scroll { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,0.45) transparent; }
.fd-step-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.fd-step-scroll::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
.fd-step-scroll::-webkit-scrollbar-track { background: transparent; border-radius: 8px; }
.fd-step-scroll::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.45); border-radius: 8px; }
.fd-step-scroll::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.65); }
`;

function StepHeader({
  step,
  isOpen,
  onClick,
}: {
  step: ToolStep;
  isOpen: boolean;
  onClick: () => void;
}) {
  const style = STEP_STYLES[step.type] ?? STEP_STYLES.skill;
  const Icon = style.icon;
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-muted/40 border-border/60 hover:border-border hover:bg-accent/60 transition-colors text-xs text-foreground w-fit max-w-full min-w-[200px]"
    >
      <span className="shrink-0 flex items-center">
        {isOpen ? (
          <ChevronDown size={14} className={`${style.color} transition-transform`} />
        ) : (
          <ChevronRight size={14} className={`${style.color} transition-transform`} />
        )}
      </span>
      <Icon size={13} className={`shrink-0 ${style.color}`} />
      <span className="font-medium truncate">{step.title}</span>
      {step.duration_ms !== undefined && step.duration_ms > 0 && (
        <span className="text-muted-foreground text-[10px] shrink-0 tabular-nums">
          {(step.duration_ms / 1000).toFixed(1)}s
        </span>
      )}
    </button>
  );
}

function StepContent({ step }: { step: ToolStep }) {
  if (!step.content) {
    return (
      <div className="mt-1 px-3 py-1.5 rounded-lg bg-muted/30 border border-border/50 text-xs text-muted-foreground italic w-fit">
        No additional content
      </div>
    );
  }

  // Image steps render as an actual image preview
  if (step.type === "image" && step.content?.startsWith("http")) {
    return (
      <div className="mt-1 p-1.5 rounded-xl bg-muted/30 border border-border/50 w-fit">
        <img
          src={step.content}
          alt={step.title}
          className="rounded-lg max-w-full h-auto max-h-64"
          loading="lazy"
        />
      </div>
    );
  }

  // Code/file content in a clean monospace drawer
  if (step.type === "file_edit" || step.type === "new_file" || step.type === "file_delete" || step.type === "cmd") {
    return (
      <div className="mt-1 rounded-xl border border-border/60 bg-muted/30 overflow-hidden max-w-full">
        <pre className="fd-step-scroll m-0 p-3 text-[11px] font-mono leading-relaxed text-foreground/90 whitespace-pre max-h-[360px] overflow-auto">
          {step.content}
        </pre>
      </div>
    );
  }

  // Default: text content
  return (
    <div className="fd-step-scroll mt-1 p-3 rounded-xl bg-muted/30 border border-border/50 text-xs text-foreground whitespace-pre-wrap leading-relaxed max-h-[360px] overflow-y-auto max-w-full">
      {step.content}
    </div>
  );
}

export function ToolSteps({ steps }: { steps?: ToolStep[] | null }) {
  const [openStep, setOpenStep] = useState<number | null>(null);

  if (!steps || steps.length === 0) return null;

  return (
    <div className="mb-2.5 space-y-1">
      <style dangerouslySetInnerHTML={{ __html: STEP_SCROLL_CSS }} />
      {steps.map((step, i) => {
        const isOpen = openStep === i;
        return (
          <div key={`${step.timestamp ?? i}-${i}`}>
            <StepHeader
              step={step}
              isOpen={isOpen}
              onClick={() => setOpenStep(isOpen ? null : i)}
            />
            {isOpen && <StepContent step={step} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Aggregate summary header — used when there are multiple steps.
 * Example: "Used 3 tools >" → click to expand all individual steps.
 */
export function ToolStepsSummary({ steps }: { steps?: ToolStep[] | null }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!steps || steps.length === 0) return null;

  const count = steps.length;
  const types = new Set(steps.map((s) => s.type));
  const label =
    count === 1
      ? steps[0].title
      : `Used ${count} tools (${Array.from(types).join(", ")})`;

  return (
    <div className="mb-2.5">
      <style dangerouslySetInnerHTML={{ __html: STEP_SCROLL_CSS }} />
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/40 border border-border/60 hover:border-border hover:bg-accent/60 transition-colors text-xs text-foreground w-fit"
      >
        {isOpen ? (
          <ChevronDown size={14} className="text-primary" />
        ) : (
          <ChevronRight size={14} className="text-primary" />
        )}
        <Wrench size={13} className="text-primary" />
        <span className="font-medium">{label}</span>
      </button>
      {isOpen && (
        <div className="mt-1.5 space-y-1">
          {steps.map((step, i) => (
            <StepHeader
              key={`${step.timestamp ?? i}-${i}`}
              step={step}
              isOpen={false}
              onClick={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  );
}
