"use client";

import { useMemo, useState } from "react";
import { MousePointerClick } from "lucide-react";
import type { OcrDocument } from "@/lib/pipeline/types";
import type { OverlayBox } from "./BBoxOverlay";
import DocumentCanvas from "./DocumentCanvas";
import type { SidebarField } from "./ExtractionSidebar";
import ExtractionSidebar from "./ExtractionSidebar";
import {
  confidenceColor,
  fieldRegionBox,
  fieldTone,
  pixelBBoxToNormalized,
  type NormalizedBox,
} from "./bbox-utils";
import type { BBox } from "@/lib/pipeline/types";

export interface InspectorField {
  key: string;
  label: string;
  value: string;
  confidence: number;
  evidence?: Array<{ lineIndex?: number; quote?: string }>;
}

export interface DocumentInspectorProps {
  imageUrl: string;
  fields: InspectorField[];
  ocr?: OcrDocument | null;
  labels?: {
    verified: string;
    uncertain: string;
    missing: string;
    hint: string;
  };
}

/**
 * Interactive document inspector: the source image with per-field bounding
 * boxes overlaid, next to a grouped extraction sidebar. Hovering or clicking
 * in either panel highlights the matching region in the other.
 */
export default function DocumentInspector({
  imageUrl,
  fields,
  ocr,
  labels,
}: DocumentInspectorProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);

  const fieldBoxes = useMemo(() => {
    const boxes = new Map<string, BBox | null>();
    for (const f of fields) {
      boxes.set(f.key, fieldRegionBox(f, ocr));
    }
    return boxes;
  }, [fields, ocr]);

  const overlayBoxes: OverlayBox[] = useMemo(() => {
    if (!imageSize) return [];
    return fields.flatMap((f) => {
      const pixel = fieldBoxes.get(f.key);
      if (!pixel) return [];
      const box: NormalizedBox = pixelBBoxToNormalized(pixel, imageSize.w, imageSize.h);
      return [{
        id: f.key,
        box,
        color: confidenceColor(f.confidence),
        label: f.label,
        value: f.value,
        confidence: f.confidence,
        active: activeKey === f.key,
        hovered: hoveredKey === f.key,
        dimmed: hoveredKey !== null && hoveredKey !== f.key,
      }];
    });
  }, [fields, fieldBoxes, imageSize, activeKey, hoveredKey]);

  const sidebarFields: SidebarField[] = useMemo(
    () =>
      fields.map((f) => ({
        key: f.key,
        label: f.label,
        value: f.value,
        confidence: f.confidence,
        tone: fieldTone(f.confidence, f.value !== ""),
      })),
    [fields]
  );

  const handleEnter = (key: string) => setHoveredKey(key);
  const handleLeave = () => setHoveredKey(null);
  const handleSelect = (key: string) => setActiveKey((cur) => (cur === key ? null : key));

  return (
    <div className="fd-inspector">
      <style>{`
        .fd-inspector {
          display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, .9fr);
          gap: 1rem; align-items: start;
        }
        .fd-inspector-panel {
          border-radius: 14px; border: 1px solid var(--color-border);
          background: var(--color-card); padding: .9rem;
        }
        .fd-inspector-panel-title {
          display: flex; align-items: center; gap: .45rem;
          font-size: .7rem; font-weight: 800; text-transform: uppercase;
          letter-spacing: .05em; color: var(--color-muted-foreground); margin-bottom: .7rem;
        }
        .fd-inspector-canvas-wrap { min-width: 0; }
        .fd-inspector-hint {
          display: flex; align-items: center; gap: .4rem; margin-top: .6rem;
          font-size: .68rem; color: var(--color-muted-foreground);
        }
        @media (max-width: 900px) {
          .fd-inspector { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className="fd-inspector-panel fd-inspector-canvas-wrap">
        <DocumentCanvas
          imageUrl={imageUrl}
          boxes={overlayBoxes}
          onEnter={handleEnter}
          onLeave={handleLeave}
          onSelect={handleSelect}
          onImageSize={(w, h) => setImageSize({ w, h })}
        />
        <p className="fd-inspector-hint">
          <MousePointerClick size={12} />
          {labels?.hint ?? "Hover or click a region to inspect the matching field"}
        </p>
      </div>

      <div className="fd-inspector-panel">
        <ExtractionSidebar
          fields={sidebarFields}
          activeKey={activeKey}
          hoveredKey={hoveredKey}
          onEnter={handleEnter}
          onLeave={handleLeave}
          onSelect={handleSelect}
          labels={labels}
        />
      </div>
    </div>
  );
}