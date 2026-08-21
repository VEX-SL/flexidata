"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, Plus, Maximize, Move } from "lucide-react";
import type { OverlayBox } from "./BBoxOverlay";
import BBoxOverlay from "./BBoxOverlay";
import { findBoxAt } from "./bbox-utils";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

interface DocumentCanvasProps {
  imageUrl: string;
  alt?: string;
  boxes: OverlayBox[];
  onEnter?: (id: string) => void;
  onLeave?: () => void;
  onSelect?: (id: string) => void;
  onImageSize?: (width: number, height: number) => void;
}

/**
 * Document image with the field BBox overlay. Supports wheel zoom (cursor
 * anchored), drag pan, and hover hit-testing. The overlay shares the image's
 * coordinate frame, so all interactions stay accurate under zoom/pan.
 */
export default function DocumentCanvas({
  imageUrl,
  alt,
  boxes,
  onEnter,
  onLeave,
  onSelect,
  onImageSize,
}: DocumentCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const clampPan = (x: number, y: number, z: number) => {
    const c = containerRef.current;
    const f = frameRef.current;
    if (!c || !f) return { x, y };
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    const fw = f.offsetWidth * z;
    const fh = f.offsetHeight * z;
    const maxX = Math.max(0, (fw - cw) / 2);
    const maxY = Math.max(0, (fh - ch) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  };

  const applyView = (z: number, p: { x: number; y: number }) => {
    zoomRef.current = z;
    panRef.current = p;
    setZoom(z);
    setPan(p);
  };

  // Non-passive wheel listener so preventDefault() is honored. Zoom anchors
  // at the cursor: the image point under the pointer stays fixed.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = containerRef.current;
      const f = frameRef.current;
      const z = zoomRef.current;
      const p = panRef.current;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      if (f && c) {
        const crect = c.getBoundingClientRect();
        const lx = (e.clientX - crect.left - p.x) / z;
        const ly = (e.clientY - crect.top - p.y) / z;
        const nx = e.clientX - crect.left - next * lx;
        const ny = e.clientY - crect.top - next * ly;
        applyView(next, clampPan(nx, ny, next));
      } else {
        applyView(next, p);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const movePoint = (e: React.MouseEvent) => {
    const frame = frameRef.current;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const nx = ((e.clientX - rect.left) / rect.width) * 1000;
    const ny = ((e.clientY - rect.top) / rect.height) * 1000;
    return { nx, ny };
  };

  const handleMove = (e: React.MouseEvent) => {
    const pt = movePoint(e);
    if (!pt) return;
    const id = findBoxAt(boxes, pt.nx, pt.ny);
    if (id !== hoverId) {
      setHoverId(id);
      if (id) onEnter?.(id);
      else onLeave?.();
    }
  };

  const handleLeave = () => {
    setHoverId(null);
    onLeave?.();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      const z = zoomRef.current;
      applyView(z, clampPan(drag.current!.px + dx, drag.current!.py + dy, z));
    };
    const onUp = () => {
      drag.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const resetView = () => {
    applyView(1, { x: 0, y: 0 });
  };

  const zoomBy = (f: number) => {
    const z = zoomRef.current;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * f));
    applyView(next, clampPan(panRef.current.x, panRef.current.y, next));
  };

  return (
    <div className="fd-inspector-canvas">
      <style>{`
        .fd-inspector-canvas {
          position: relative; overflow: hidden; border-radius: 12px;
          border: 1px solid var(--color-border); background:
            repeating-conic-gradient(#1a1a1a 0% 25%, #222 0% 50%) 0 0 / 22px 22px;
          user-select: none; touch-action: none;
        }
        .fd-inspector-stage {
          position: relative; transform-origin: 0 0; will-change: transform;
        }
        .fd-inspector-frame { position: relative; display: inline-block; }
        .fd-inspector-frame img {
          display: block; max-width: 100%; max-height: 70vh;
          border-radius: 0; pointer-events: none;
        }
        .fd-inspector-canvas.dragging { cursor: grabbing; }
        .fd-inspector-canvas .fd-inspector-frame { cursor: grab; }
        .fd-inspector-toolbar {
          position: absolute; top: 10px; right: 10px; z-index: 20;
          display: flex; align-items: center; gap: .35rem;
          padding: .3rem; border-radius: 10px;
          background: rgba(15,23,42,.85); border: 1px solid rgba(255,255,255,.1);
          backdrop-filter: blur(6px);
        }
        .fd-inspector-toolbar button {
          display: inline-flex; align-items: center; justify-content: center;
          width: 30px; height: 30px; border-radius: 8px; border: none;
          background: transparent; color: #e2e8f0; cursor: pointer; transition: background .15s;
        }
        .fd-inspector-toolbar button:hover { background: rgba(255,255,255,.14); }
        .fd-inspector-zoom-label {
          min-width: 38px; text-align: center; font-size: .72rem; font-weight: 700;
          color: #e2e8f0; font-variant-numeric: tabular-nums;
        }
        .fd-inspector-canvas .fd-inspector-pan-hint {
          position: absolute; bottom: 10px; left: 10px; z-index: 20;
          display: flex; align-items: center; gap: .4rem;
          padding: .3rem .6rem; border-radius: 8px; font-size: .66rem; font-weight: 600;
          color: #cbd5e1; background: rgba(15,23,42,.7); border: 1px solid rgba(255,255,255,.08);
        }
        .fd-inspector-canvas .fd-inspector-empty {
          position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
          color: #94a3b8; font-size: .8rem;
        }
      `}</style>

      <div
        ref={containerRef}
        className={`fd-inspector-canvas ${dragging ? "dragging" : ""}`}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onMouseDown={handleMouseDown}
        onDoubleClick={resetView}
      >
        <div
          className="fd-inspector-stage"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <div ref={frameRef} className="fd-inspector-frame">
            <img
              src={imageUrl}
              alt={alt ?? "document"}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  onImageSize?.(img.naturalWidth, img.naturalHeight);
                }
              }}
            />
            <BBoxOverlay
              boxes={boxes}
              onEnter={onEnter}
              onLeave={onLeave}
              onSelect={onSelect}
            />
          </div>
        </div>

        <div className="fd-inspector-toolbar">
          <button onClick={() => zoomBy(1 / 1.25)} title="Zoom out">
            <Minus size={15} />
          </button>
          <span className="fd-inspector-zoom-label">{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomBy(1.25)} title="Zoom in">
            <Plus size={15} />
          </button>
          <button onClick={resetView} title="Reset view">
            <Maximize size={14} />
          </button>
        </div>

        <div className="fd-inspector-pan-hint">
          <Move size={12} />
          drag to pan · scroll to zoom
        </div>
      </div>
    </div>
  );
}