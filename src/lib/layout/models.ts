/**
 * Immutable constructors for the layout domain models.
 *
 * Every value produced here is deep-frozen (Object.freeze on the object and
 * its array/object children) so the structural model can be shared freely
 * between layers without accidental mutation.
 */
import type { BBox } from "@/lib/pipeline/types";
import type { OcrDocument } from "@/lib/pipeline/types";
import type {
  ConfidenceDistribution,
  LayoutDocument,
  LayoutNode,
  LayoutNodeId,
  LayoutPage,
  LayoutPageIndex,
  LayoutRegion,
  LayoutRegionId,
  LayoutSourceRef,
} from "./types";
import { LAYOUT_VERSION } from "./types";

/**
 * Summary statistics of a set of confidence values. Empty input yields a
 * neutral zero distribution (never NaN). Rejects non-finite values.
 */
export function createConfidenceDistribution(
  values: readonly number[]
): ConfidenceDistribution {
  for (const v of values) {
    if (!Number.isFinite(v)) {
      throw new RangeError(`confidence value must be finite, got ${v}`);
    }
  }
  const count = values.length;
  if (count === 0) {
    return freeze({ count: 0, mean: 0, variance: 0, min: 0, max: 0 });
  }
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / count;
  let sse = 0;
  for (const v of values) sse += (v - mean) * (v - mean);
  return freeze({
    count,
    mean,
    variance: sse / count,
    min: Math.min(...values),
    max: Math.max(...values),
  });
}

/** Create an immutable layout node. */
export function createLayoutNode(opts: {
  id: LayoutNodeId;
  page: LayoutPageIndex;
  bbox: BBox;
  confidence?: ConfidenceDistribution;
  source?: LayoutSourceRef;
}): LayoutNode {
  return freeze({
    id: opts.id,
    page: opts.page,
    bbox: freeze({ ...opts.bbox }),
    confidence: opts.confidence ?? createConfidenceDistribution([]),
    ...(opts.source
      ? { source: freeze({ ...opts.source }) }
      : {}),
  });
}

/** Create an immutable layout region. */
export function createLayoutRegion(opts: {
  id: LayoutRegionId;
  page: LayoutPageIndex;
  bbox: BBox;
  nodeIds?: readonly LayoutNodeId[];
}): LayoutRegion {
  return freeze({
    id: opts.id,
    page: opts.page,
    bbox: freeze({ ...opts.bbox }),
    nodeIds: freeze([...(opts.nodeIds ?? [])]),
  });
}

/** Create an immutable layout page. */
export function createLayoutPage(opts: {
  index: LayoutPageIndex;
  bounds: BBox;
  nodeIds?: readonly LayoutNodeId[];
  regionIds?: readonly LayoutRegionId[];
}): LayoutPage {
  return freeze({
    index: opts.index,
    bounds: freeze({ ...opts.bounds }),
    nodeIds: freeze([...(opts.nodeIds ?? [])]),
    regionIds: freeze([...(opts.regionIds ?? [])]),
  });
}

/**
 * Create an immutable layout document. The document-level confidence is the
 * unweighted distribution over node confidence means — a construction
 * aggregate, not the propagation algorithm (that lands with its own
 * milestone).
 */
export function createLayoutDocument(opts: {
  pages: readonly LayoutPage[];
  nodes: readonly LayoutNode[];
  regions: readonly LayoutRegion[];
  version?: number;
  source?: OcrDocument;
}): LayoutDocument {
  const doc: LayoutDocument = {
    version: opts.version ?? LAYOUT_VERSION,
    pages: freeze([...opts.pages]),
    nodes: freeze([...opts.nodes]),
    regions: freeze([...opts.regions]),
    confidence: createConfidenceDistribution(
      opts.nodes.map((n) => n.confidence.mean)
    ),
    ...(opts.source ? { source: opts.source } : {}),
  };
  return freeze(doc);
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
