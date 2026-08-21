"use client";

import { CheckCircle2, AlertTriangle, HelpCircle } from "lucide-react";
import type { FieldTone } from "./bbox-utils";
import { confidenceColor, rowStateClass } from "./bbox-utils";

export interface SidebarField {
  key: string;
  label: string;
  value: string;
  confidence: number;
  tone: FieldTone;
  hasBox: boolean;
}

interface ExtractionSidebarProps {
  fields: SidebarField[];
  activeKey: string | null;
  hoveredKey: string | null;
  onEnter?: (key: string) => void;
  onLeave?: () => void;
  onSelect?: (key: string) => void;
  labels?: {
    verified: string;
    uncertain: string;
    missing: string;
    noBox: string;
  };
}

const GROUPS: Array<{ tone: FieldTone; color: string; icon: typeof CheckCircle2 }> = [
  { tone: "verified", color: "#22C55E", icon: CheckCircle2 },
  { tone: "uncertain", color: "#F59E0B", icon: AlertTriangle },
  { tone: "missing", color: "#EF4444", icon: HelpCircle },
];

/**
 * Field list grouped by confidence tone (verified / uncertain / missing).
 * Hover and selection mirror the canvas boxes (bidirectional highlight).
 */
export default function ExtractionSidebar({
  fields,
  activeKey,
  hoveredKey,
  onEnter,
  onLeave,
  onSelect,
  labels,
}: ExtractionSidebarProps) {
  const L = {
    verified: "Verified",
    uncertain: "Uncertain",
    missing: "Missing",
    noBox: "no region on image",
    ...labels,
  };

  return (
    <div className="fd-inspector-sidebar">
      <style>{`
        .fd-inspector-sidebar {
          display: flex; flex-direction: column; gap: 1rem;
          max-height: 70vh; overflow: auto; padding-right: .2rem;
        }
        .fd-inspector-group-title {
          display: flex; align-items: center; gap: .4rem;
          font-size: .7rem; font-weight: 800; text-transform: uppercase;
          letter-spacing: .05em; color: var(--color-muted-foreground); margin-bottom: .4rem;
        }
        .fd-inspector-group-title span { margin-left: auto; font-variant-numeric: tabular-nums; }
        .fd-inspector-row {
          display: flex; align-items: center; gap: .6rem;
          padding: .55rem .7rem; border-radius: 10px; cursor: pointer;
          border: 1px solid transparent; transition: background .12s, border-color .12s, box-shadow .12s;
        }
        .fd-inspector-row:hover { background: var(--color-accent); }
        .fd-inspector-row--hovered { background: var(--color-accent); border-color: rgba(99,102,241,.35); }
        .fd-inspector-row--active {
          background: rgba(99,102,241,.08); border-color: rgba(99,102,241,.55);
          box-shadow: 0 0 0 2px rgba(99,102,241,.12);
        }
        .fd-inspector-row-tone { width: 4px; align-self: stretch; border-radius: 2px; flex-shrink: 0; }
        .fd-inspector-row-body { flex: 1; min-width: 0; }
        .fd-inspector-row-label {
          font-size: .74rem; font-weight: 700; color: var(--color-foreground);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .fd-inspector-row-value {
          font-size: .78rem; color: var(--color-foreground); font-weight: 600;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: .1rem;
        }
        .fd-inspector-row-value.empty { color: var(--color-muted-foreground); font-weight: 400; font-style: italic; }
        .fd-inspector-row-badge {
          flex-shrink: 0; font-size: .68rem; font-weight: 800;
          font-variant-numeric: tabular-nums; padding: .18rem .5rem; border-radius: 999px;
        }
        .fd-inspector-row-nobox { font-size: .62rem; color: var(--color-muted-foreground); font-weight: 600; }
        .fd-inspector-sidebar-empty {
          padding: 1.5rem; text-align: center; font-size: .78rem;
          color: var(--color-muted-foreground); border: 1px dashed var(--color-border); border-radius: 12px;
        }
      `}</style>

      {fields.length === 0 && (
        <div className="fd-inspector-sidebar-empty">No extracted fields to highlight.</div>
      )}

      {GROUPS.map((g) => {
        const members = fields.filter((f) => f.tone === g.tone);
        if (members.length === 0) return null;
        const Icon = g.icon;
        return (
          <div key={g.tone}>
            <p className="fd-inspector-group-title">
              <Icon size={12} style={{ color: g.color }} />
              {L[g.tone]}
              <span style={{ color: g.color }}>{members.length}</span>
            </p>
            <div className="space-y-0.5">
              {members.map((f) => {
                const active = activeKey === f.key;
                const hovered = hoveredKey === f.key;
                return (
                  <div
                    key={f.key}
                    className={rowStateClass(active, hovered)}
                    onMouseEnter={() => onEnter?.(f.key)}
                    onMouseLeave={() => onLeave?.()}
                    onClick={() => onSelect?.(f.key)}
                  >
                    <div className="fd-inspector-row-tone" style={{ background: g.color }} />
                    <div className="fd-inspector-row-body">
                      <div className="fd-inspector-row-label" title={f.label}>{f.label}</div>
                      <div className={`fd-inspector-row-value ${f.value ? "" : "empty"}`}>
                        {f.value || "—"}
                        {!f.hasBox && <span className="fd-inspector-row-nobox"> · {L.noBox}</span>}
                      </div>
                    </div>
                    {f.tone !== "missing" && (
                      <span
                        className="fd-inspector-row-badge"
                        style={{ background: `${confidenceColor(f.confidence)}1A`, color: confidenceColor(f.confidence) }}
                      >
                        {Math.round(f.confidence * 100)}%
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}