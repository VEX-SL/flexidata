"use client";

import type { NormalizedBox } from "./bbox-utils";
import { bboxStateClass, normalizedToPercentageBBox } from "./bbox-utils";

/** One overlay box; coordinates are normalized 0..1000 (or 0..1). */
export interface OverlayBox {
  id: string;
  box: NormalizedBox;
  color: string;
  label: string;
  value: string;
  confidence: number;
  active: boolean;
  hovered: boolean;
  dimmed: boolean;
}

interface BBoxOverlayProps {
  boxes: OverlayBox[];
  onEnter?: (id: string) => void;
  onLeave?: () => void;
  onSelect?: (id: string) => void;
}

/**
 * Absolute-positioned overlay of field boxes over the document image.
 * Every box is a CSS-percentage rect, so the overlay scales responsively
 * with the image (including CSS zoom / pan transforms on the image wrapper).
 */
export default function BBoxOverlay({ boxes, onEnter, onLeave, onSelect }: BBoxOverlayProps) {
  return (
    <>
      <style>{`
        .fd-inspector-overlay { position: absolute; inset: 0; pointer-events: none; }
        .fd-inspector-box {
          position: absolute; border: 1.5px solid transparent; border-radius: 3px;
          box-sizing: border-box; cursor: pointer; pointer-events: auto;
          transition: background .12s ease, box-shadow .12s ease, border-color .12s ease;
        }
        .fd-inspector-box--hovered {
          border-width: 2px; box-shadow: 0 0 0 2px rgba(255,255,255,.45), 0 4px 12px rgba(0,0,0,.25);
        }
        .fd-inspector-box--active { border-width: 2.5px; box-shadow: 0 0 0 3px rgba(255,255,255,.6), 0 6px 16px rgba(0,0,0,.3); }
        .fd-inspector-box--dimmed { opacity: .35; }
        .fd-inspector-tip {
          position: absolute; left: 2px; bottom: calc(100% + 6px); min-width: 130px; max-width: 220px;
          padding: .4rem .55rem; border-radius: 8px; font-size: .68rem; line-height: 1.35;
          background: rgba(17,24,39,.94); color: #fff; pointer-events: none;
          box-shadow: 0 6px 18px rgba(0,0,0,.28); opacity: 0; transform: translateY(4px);
          transition: opacity .12s ease, transform .12s ease; z-index: 30; white-space: normal;
        }
        .fd-inspector-box:hover .fd-inspector-tip,
        .fd-inspector-box--active .fd-inspector-tip { opacity: 1; transform: translateY(0); }
        .fd-inspector-tip-title { font-weight: 700; margin-bottom: .1rem; word-break: break-word; }
        .fd-inspector-tip-value { opacity: .85; word-break: break-word; }
        .fd-inspector-tip-conf { display: inline-block; margin-top: .25rem; font-weight: 700; }
      `}</style>
      <div className="fd-inspector-overlay" onMouseLeave={() => onLeave?.()}>
        {boxes.map((b) => {
          const pct = normalizedToPercentageBBox(b.box);
          const dimmed = b.dimmed && !b.active && !b.hovered;
          return (
            <div
              key={b.id}
              className={bboxStateClass(b.active, b.hovered) + (dimmed ? " fd-inspector-box--dimmed" : "")}
              style={{
                left: `${pct.left}%`,
                top: `${pct.top}%`,
                width: `${pct.width}%`,
                height: `${pct.height}%`,
                borderColor: b.color,
                background: `${b.color}2e`,
              }}
              onMouseEnter={(e) => { e.stopPropagation(); onEnter?.(b.id); }}
              onClick={(e) => { e.stopPropagation(); onSelect?.(b.id); }}
            >
              <span className="fd-inspector-tip">
                <span className="fd-inspector-tip-title">{b.label}</span>
                {b.value && <span className="fd-inspector-tip-value">{b.value}</span>}
                <span className="fd-inspector-tip-conf" style={{ color: b.color }}>
                  {Math.round(b.confidence * 100)}%
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}