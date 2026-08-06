/**
 * Spatial index â€” the single geometry lookup layer of the layout layer.
 *
 * A uniform-grid spatial hash: entries (a stable key + a box + a payload) are
 * inserted into every grid cell they touch, so membership queries only scan
 * the cells a query box covers. The index is immutable after build (build once,
 * query many) and fully deterministic: membership queries return results in
 * insertion order, nearest queries in (distance, insertion) order.
 *
 * Queries supported: overlap search, containment search (both directions),
 * point lookup, radius search and k-nearest. Word/line/region/node builders
 * keep the index the single lookup layer for every later milestone.
 */
import type { BBox, OcrLine, OcrWord } from "@/lib/pipeline/types";
import {
  boxesDistance,
  boxesIntersect,
  boxCenter,
  boxContains,
  centerDistance,
} from "./geometry";
import type { Point } from "./geometry";
import type { LayoutNode, LayoutRegion } from "./types";

/** A boxed entry stored in the index. */
export interface SpatialEntry<T> {
  /** Stable unique key of the entry. */
  readonly key: string;
  /** Axis-aligned box of the entry, in the indexed coordinate space. */
  readonly bbox: BBox;
  /** Arbitrary payload. */
  readonly value: T;
}

export interface SpatialIndexOptions {
  /**
   * Grid cell size. Default: median of entry box sizes, clamped to a sane
   * range (keeps the grid balanced for both sparse and dense documents).
   */
  cellSize?: number;
}

const DEFAULT_CELL_SIZE = 16;
const MIN_CELL_SIZE = 1;
const MAX_CELL_SIZE = 4096;

type CellMap = ReadonlyMap<number, readonly number[]>;
type Grid = ReadonlyMap<number, CellMap>;

export class SpatialIndex<T> {
  private readonly items: readonly SpatialEntry<T>[];
  private readonly byKey: ReadonlyMap<string, number>;
  private readonly cells: Grid;
  private readonly cellSize: number;

  private constructor(
    entries: readonly SpatialEntry<T>[],
    byKey: ReadonlyMap<string, number>,
    cells: Grid,
    cellSize: number
  ) {
    this.items = entries;
    this.byKey = byKey;
    this.cells = cells;
    this.cellSize = cellSize;
  }

  /** Build an immutable index from a list of boxed entries. */
  static build<T>(
    entries: readonly SpatialEntry<T>[],
    options: SpatialIndexOptions = {}
  ): SpatialIndex<T> {
    const list = validateEntries(entries);
    const cellSize = resolveCellSize(list, options.cellSize);

    const byKey = new Map<string, number>();
    const cells = new Map<number, Map<number, number[]>>();
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (byKey.has(entry.key)) {
        throw new Error(`duplicate spatial entry key: ${entry.key}`);
      }
      byKey.set(entry.key, i);
      insertIntoGrid(cells, entry.bbox, i, cellSize);
    }

    const frozenCells = new Map<number, Map<number, readonly number[]>>();
    for (const [cx, col] of cells) {
      const frozenCol = new Map<number, readonly number[]>();
      for (const [cy, indices] of col) {
        frozenCol.set(cy, Object.freeze(indices));
      }
      frozenCells.set(cx, frozenCol);
    }

    return new SpatialIndex(
      Object.freeze([...list]),
      byKey,
      frozenCells as Grid,
      cellSize
    );
  }

  /** Number of indexed entries. */
  get size(): number {
    return this.items.length;
  }

  /** Look up an entry by key. */
  get(key: string): SpatialEntry<T> | undefined {
    const i = this.byKey.get(key);
    return i === undefined ? undefined : this.items[i];
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** All entries, in insertion order. */
  entries(): readonly SpatialEntry<T>[] {
    return this.items;
  }

  /** Entries whose box shares area with the query box (touching excluded). */
  searchOverlap(box: BBox): readonly SpatialEntry<T>[] {
    return this.query(box, (e) => boxesIntersect(e.bbox, box));
  }

  /** Entries fully contained by the query box (edges inclusive). */
  searchContained(box: BBox): readonly SpatialEntry<T>[] {
    return this.query(box, (e) => boxContains(box, e.bbox));
  }

  /** Entries that fully contain the query box (edges inclusive). */
  searchContaining(box: BBox): readonly SpatialEntry<T>[] {
    return this.query(box, (e) => boxContains(e.bbox, box));
  }

  /** Entries whose box contains the query point. */
  lookupPoint(p: Point): readonly SpatialEntry<T>[] {
    return this.searchContaining({ x: p.x, y: p.y, width: 0, height: 0 });
  }

  /** Entries within `radius` (box-to-box distance) of the query box. */
  searchNearby(box: BBox, radius: number): readonly SpatialEntry<T>[] {
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError("radius must be a non-negative finite number");
    }
    const expanded: BBox = {
      x: box.x - radius,
      y: box.y - radius,
      width: box.width + radius * 2,
      height: box.height + radius * 2,
    };
    return this.query(expanded, (e) => boxesDistance(e.bbox, box) <= radius);
  }

  /**
   * The k nearest entries by center distance (ties broken by insertion
   * order). Returns fewer than k when the index holds fewer entries.
   */
  nearest(box: BBox, k: number): readonly SpatialEntry<T>[] {
    if (k <= 0 || this.items.length === 0) return [];
    const center = boxCenter(box);
    const cs = this.cellSize;
    const ccx = Math.floor(center.x / cs);
    const ccy = Math.floor(center.y / cs);
    const ringMax = maxRing(this.cells, ccx, ccy);

    const seen = new Set<number>();
    const candidates: Array<{ i: number; d: number }> = [];
    let kth = Infinity;

    for (let ring = 0; ring <= ringMax; ring++) {
      let ringMinDist = Infinity;
      let hasCells = false;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const col = this.cells.get(ccx + dx);
          const indices = col?.get(ccy + dy);
          if (!indices) continue;
          hasCells = true;
          ringMinDist = Math.min(
            ringMinDist,
            cellMinDistance(ccx + dx, ccy + dy, cs, center)
          );
          for (const i of indices) {
            if (seen.has(i)) continue;
            seen.add(i);
            candidates.push({ i, d: centerDistance(this.items[i].bbox, box) });
          }
        }
      }
      candidates.sort((a, b) => a.d - b.d || a.i - b.i);
      if (candidates.length >= k) kth = candidates[k - 1].d;
      // No candidate in this or any outer ring can beat the current kth.
      if (hasCells && candidates.length >= k && ringMinDist > kth) break;
    }

    return Object.freeze(candidates.slice(0, k).map((c) => this.items[c.i]));
  }

  private query(
    box: BBox,
    test: (entry: SpatialEntry<T>) => boolean
  ): readonly SpatialEntry<T>[] {
    const x0 = Math.floor(box.x / this.cellSize);
    const x1 = Math.floor((box.x + box.width) / this.cellSize);
    const y0 = Math.floor(box.y / this.cellSize);
    const y1 = Math.floor((box.y + box.height) / this.cellSize);

    const found = new Set<number>();
    for (let cx = x0; cx <= x1; cx++) {
      const col = this.cells.get(cx);
      if (!col) continue;
      for (let cy = y0; cy <= y1; cy++) {
        const indices = col.get(cy);
        if (!indices) continue;
        for (const i of indices) found.add(i);
      }
    }

    // Output in insertion order (indices are the insertion sequence).
    const ordered = Array.from(found).sort((a, b) => a - b);
    const out: SpatialEntry<T>[] = [];
    for (const i of ordered) {
      const entry = this.items[i];
      if (test(entry)) out.push(entry);
    }
    return out;
  }
}

// â”€â”€â”€ Builders over layout + OCR primitives â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Index layout nodes by id. */
export function buildNodeIndex(
  nodes: readonly LayoutNode[]
): SpatialIndex<LayoutNode> {
  return SpatialIndex.build(
    nodes.map((n) => ({ key: n.id, bbox: n.bbox, value: n }))
  );
}

/** Index layout regions by id. */
export function buildRegionIndex(
  regions: readonly LayoutRegion[]
): SpatialIndex<LayoutRegion> {
  return SpatialIndex.build(
    regions.map((r) => ({ key: r.id, bbox: r.bbox, value: r }))
  );
}

/** A word projected into the index, with its OCR coordinates. */
export interface IndexedWord {
  readonly lineIndex: number;
  readonly wordIndex: number;
  readonly word: OcrWord;
}

/**
 * Index OCR lines by line index. Lines without a box are indexed with a
 * zero-size box at the origin (they only match queries at the origin).
 */
export function buildLineIndex(
  lines: readonly OcrLine[]
): SpatialIndex<{ index: number; line: OcrLine }> {
  return SpatialIndex.build(
    lines.map((line, index) => ({
      key: String(index),
      bbox: line.bbox ?? { x: 0, y: 0, width: 0, height: 0 },
      value: { index, line },
    }))
  );
}

/**
 * Index OCR words that carry a box. Words without geometry are skipped (they
 * have no position to query). Keys are "lineIndex:wordIndex".
 */
export function buildWordIndex(
  lines: readonly OcrLine[]
): SpatialIndex<IndexedWord> {
  const entries: SpatialEntry<IndexedWord>[] = [];
  lines.forEach((line, li) => {
    line.words.forEach((word, wi) => {
      if (!word.bbox) return;
      entries.push({
        key: `${li}:${wi}`,
        bbox: word.bbox,
        value: { lineIndex: li, wordIndex: wi, word },
      });
    });
  });
  return SpatialIndex.build(entries);
}

// â”€â”€â”€ Grid internals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function validateEntries<T>(
  entries: readonly SpatialEntry<T>[]
): readonly SpatialEntry<T>[] {
  for (const e of entries) {
    if (typeof e.key !== "string" || e.key.length === 0) {
      throw new Error("spatial entry key must be a non-empty string");
    }
    assertFiniteBox(e.bbox);
  }
  return entries;
}

function assertFiniteBox(box: BBox): void {
  const nums = [box.x, box.y, box.width, box.height];
  for (const n of nums) {
    if (!Number.isFinite(n)) {
      throw new RangeError(`spatial entry box must be finite, got ${n}`);
    }
  }
}

function resolveCellSize(
  entries: readonly SpatialEntry<unknown>[],
  cellSize: number | undefined
): number {
  if (cellSize !== undefined) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError("cellSize must be a positive finite number");
    }
    return cellSize;
  }
  if (entries.length === 0) return DEFAULT_CELL_SIZE;
  const dims = entries.map((e) => Math.min(e.bbox.width, e.bbox.height));
  const med = median(dims);
  if (!Number.isFinite(med) || med <= 0) return DEFAULT_CELL_SIZE;
  return clamp(med, MIN_CELL_SIZE, MAX_CELL_SIZE);
}

function insertIntoGrid(
  cells: Map<number, Map<number, number[]>>,
  bbox: BBox,
  index: number,
  cellSize: number
): void {
  const x0 = Math.floor(bbox.x / cellSize);
  const x1 = Math.floor((bbox.x + bbox.width) / cellSize);
  const y0 = Math.floor(bbox.y / cellSize);
  const y1 = Math.floor((bbox.y + bbox.height) / cellSize);
  for (let cx = x0; cx <= x1; cx++) {
    let col = cells.get(cx);
    if (!col) {
      col = new Map();
      cells.set(cx, col);
    }
    for (let cy = y0; cy <= y1; cy++) {
      const arr = col.get(cy) ?? [];
      arr.push(index);
      col.set(cy, arr);
    }
  }
}

/** Chebyshev distance in cells between a point and the furthest occupied cell. */
function maxRing(cells: Grid, ccx: number, ccy: number): number {
  let m = 0;
  for (const [cx, col] of cells) {
    for (const cy of col.keys()) {
      m = Math.max(m, Math.max(Math.abs(cx - ccx), Math.abs(cy - ccy)));
    }
  }
  return m;
}

/** Distance from a point to the nearest edge of a grid cell (0 when inside). */
function cellMinDistance(
  cx: number,
  cy: number,
  cellSize: number,
  p: Point
): number {
  const left = cx * cellSize;
  const right = (cx + 1) * cellSize;
  const top = cy * cellSize;
  const bottom = (cy + 1) * cellSize;
  const dx = Math.max(0, Math.max(left - p.x, p.x - right));
  const dy = Math.max(0, Math.max(top - p.y, p.y - bottom));
  return Math.hypot(dx, dy);
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

