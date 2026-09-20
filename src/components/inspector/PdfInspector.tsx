"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { BBox, OcrDocument, OcrLine } from "@/lib/pipeline/types";
import DocumentInspector, { type InspectorField } from "./DocumentInspector";

export interface PdfInspectorProps {
  fileUrl: string;
  fields: InspectorField[];
  ocr?: OcrDocument | null;
  labels: { verified: string; uncertain: string; missing: string; hint: string };
  t: (key: string, params?: Record<string, string | number>) => string;
}

/**
 * Per-page inspector for whole-document PDF OCR. Lines carry a `page` number
 * and a bbox normalized WITHIN that page (0..1000); this component renders the
 * requested page to an image (server-side, /api/files/{id}/pages/{n}),
 * rescales the page's lines into that image's pixel space, remaps field
 * evidence to this page's local line indices and hands everything to the
 * shared DocumentInspector. Multi-page documents get the same hover/click
 * boxed review as single images.
 */
export default function PdfInspector({
  fileUrl,
  fields,
  ocr,
  labels,
  t,
}: PdfInspectorProps) {
  const lines = useMemo(() => ocr?.lines ?? [], [ocr]);
  const [page, setPage] = useState(1);
  const [pageDims, setPageDims] = useState<{ w: number; h: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const totalPages = useMemo(() => {
    let max = 0;
    for (const l of lines) {
      if (typeof l.page === "number" && l.page > max) max = l.page;
    }
    return max;
  }, [lines]);

  const pageUrl = useMemo(() => `${fileUrl}/pages/${page}`, [fileUrl, page]);

  // Pages that carry at least one field's evidence — highlighted in the nav so
  // the reviewer can jump straight to where fields were found.
  const evidencePages = useMemo(() => {
    const found = new Set<number>();
    for (const f of fields) {
      for (const e of f.evidence ?? []) {
        if (typeof e.lineIndex !== "number") continue;
        const l = lines[e.lineIndex];
        if (l && typeof l.page === "number") found.add(l.page);
      }
    }
    return found;
  }, [fields, lines]);

  // Clamp the page when the document shrinks (refreshed data, etc.).
  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  // Resolve the rendered page's pixel size from the page-image endpoint, so
  // per-page normalized bboxes can be scaled onto the PNG.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setPageDims(null);
    fetch(pageUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const w = Number(r.headers.get("X-Page-Width"));
        const h = Number(r.headers.get("X-Page-Height"));
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          throw new Error("page dimensions unavailable");
        }
        if (!cancelled) {
          setPageDims({ w, h });
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pageUrl, attempt]);

  const perPage = useMemo(() => {
    if (!pageDims) return null;
    const remap = new Map<number, number>();
    const pageLines: OcrLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.page !== page) continue;
      remap.set(i, pageLines.length);
      pageLines.push({
        ...l,
        ...(l.bbox ? { bbox: scaleBox(l.bbox, pageDims.w, pageDims.h) } : {}),
        words: l.words.map((w) =>
          w.bbox ? { ...w, bbox: scaleBox(w.bbox, pageDims.w, pageDims.h) } : w
        ),
      });
    }
    const pageFields: InspectorField[] = fields.map((f) => {
      const evidence = (f.evidence ?? [])
        .map((e) =>
          typeof e.lineIndex === "number" && remap.has(e.lineIndex)
            ? { ...e, lineIndex: remap.get(e.lineIndex)! }
            : null
        )
        .filter((e): e is NonNullable<typeof e> => e !== null);
      return evidence.length ? { ...f, evidence } : { ...f, evidence: [] };
    });
    return { pageLines, pageFields };
  }, [lines, page, pageDims, fields]);

  const prev = () => setPage((p) => Math.max(1, p - 1));
  const next = () => setPage((p) => Math.min(Math.max(totalPages, 1), p + 1));

  return (
    <div className="fd-pdf-inspector">
      <style>{`
        .fd-pdf-inspector-nav {
          display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
          margin-bottom: .75rem; padding: .45rem .65rem;
          border: 1px solid var(--color-border); border-radius: 12px;
          background: var(--color-card);
        }
        .fd-pdf-inspector-pages {
          flex: 1; display: flex; align-items: center; gap: .3rem; flex-wrap: wrap;
        }
        .fd-pdf-inspector-chip {
          min-width: 1.7rem; height: 1.7rem; padding: 0 .32rem;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: 8px; border: 1px solid var(--color-border);
          background: transparent; font-size: .7rem; font-weight: 700;
          color: var(--color-muted-foreground); cursor: pointer;
        }
        .fd-pdf-inspector-chip.active {
          background: var(--color-border); color: var(--color-foreground);
        }
        .fd-pdf-inspector-chip.busy { opacity: .5; pointer-events: none; }
        .fd-pdf-inspector-dot {
          width: .35rem; height: .35rem; border-radius: 50%;
          background: var(--color-muted-foreground); margin-inline-start: .2rem;
        }
        .fd-pdf-inspector-navbtn {
          display: inline-flex; align-items: center; justify-content: center;
          width: 2rem; height: 2rem; border-radius: 8px;
          border: 1px solid var(--color-border); background: transparent;
          color: var(--color-foreground); cursor: pointer;
        }
        .fd-pdf-inspector-navbtn:disabled { opacity: .35; cursor: default; }
        .fd-pdf-inspector-pagetitle {
          font-size: .72rem; font-weight: 700; color: var(--color-muted-foreground);
          white-space: nowrap;
        }
        .fd-pdf-inspector-state {
          display: flex; flex-direction: column; align-items: center; gap: .6rem;
          padding: 2.2rem 1rem; border: 1px solid var(--color-border);
          border-radius: 14px; background: var(--color-card);
          font-size: .78rem; color: var(--color-muted-foreground);
        }
      `}</style>

      <div className="fd-pdf-inspector-nav">
        <button
          type="button"
          className="fd-pdf-inspector-navbtn"
          onClick={prev}
          disabled={page <= 1 || loading}
          aria-label={t("documents.inspector.prevPage")}
        >
          <ChevronRight size={15} />
        </button>
        <div className="fd-pdf-inspector-pages">
          {Array.from({ length: Math.max(totalPages, 1) }, (_, i) => i + 1).map(
            (n) => (
              <button
                key={n}
                type="button"
                className={`fd-pdf-inspector-chip ${n === page ? "active" : ""}`}
                onClick={() => setPage(n)}
                disabled={loading}
                title={evidencePages.has(n) ? "⦿" : undefined}
              >
                {n}
                {evidencePages.has(n) && <span className="fd-pdf-inspector-dot" />}
              </button>
            )
          )}
        </div>
        <span className="fd-pdf-inspector-pagetitle">
          {t("documents.inspector.page", {
            current: page,
            total: totalPages,
          })}
        </span>
        <button
          type="button"
          className="fd-pdf-inspector-navbtn"
          onClick={next}
          disabled={page >= totalPages || loading}
          aria-label={t("documents.inspector.nextPage")}
        >
          <ChevronLeft size={15} />
        </button>
      </div>

      {loading ? (
        <div className="fd-pdf-inspector-state">
          <Loader2 size={18} className="animate-spin" />
          <span>{t("documents.inspector.loading")}</span>
        </div>
      ) : error ? (
        <div className="fd-pdf-inspector-state">
          <span>{t("documents.inspector.loadError")}</span>
          <button
            type="button"
            className="fd-pdf-inspector-navbtn"
            onClick={() => setAttempt((a) => a + 1)}
          >
            <RefreshCw size={14} />
            <span style={{ marginInlineStart: 4 }}>{t("documents.inspector.retry")}</span>
          </button>
        </div>
      ) : perPage ? (
        <DocumentInspector
          imageUrl={pageUrl}
          fields={perPage.pageFields}
          ocr={{
            text: perPage.pageLines.map((l) => l.text).join("\n"),
            lines: perPage.pageLines,
          }}
          labels={labels}
        />
      ) : null}
    </div>
  );
}

/** Scale a 0..1000 normalized per-page box into a pixel-space box. */
function scaleBox(b: BBox, pageW: number, pageH: number): BBox {
  return {
    x: (b.x / 1000) * pageW,
    y: (b.y / 1000) * pageH,
    width: (b.width / 1000) * pageW,
    height: (b.height / 1000) * pageH,
  };
}