/**
 * Reading order builder — deterministic reading-sequence construction.
 *
 * Builds the immutable `ReadingOrderGraph` from a Milestone 4 `LayoutHierarchy`
 * using ONLY geometry and the document's own OCR ordering metadata — never OCR
 * text, language, keywords or semantic inference:
 *
 *   - Every level chain (Words → Lines → Blocks → Regions → Pages →
 *     Document) is produced by a deterministic comparator sort.
 *   - The primary reading signal is the OCR ordering metadata carried by each
 *     hierarchy node's `sourceRefs` (page, line, word indices). A derived
 *     container without its own references (a Region, or a ref-less Block in a
 *     hand-built hierarchy) inherits the minimum source reference of its
 *     subtree, so Arabic and multi-column ordering emerges from the OCR's own
 *     output order without any script- or column-specific rule.
 *   - When no OCR ordering metadata exists at all, the fallback is the stable
 *     geometric order (page, top-to-bottom, then left-to-right) of the boxes,
 *     with the optional `SpatialIndex` resolving coincident-box ties through a
 *     genuine neighborhood query (`searchOverlap`).
 *
 * Determinism: identical input reproduces identical graphs; every tie-break is
 * stable (source order, then geometry, then the spatial index's insertion
 * order, then id). Complexity is O(N log N) for the sorts plus O(N) for the
 * ref resolution — there are no pairwise scans.
 */
import type { HierarchyNode, LayoutHierarchy } from "./hierarchy";
import { HIERARCHY_ROOT_LEVEL } from "./hierarchy";
import type { HierarchyLevel } from "./hierarchy";
import { NODE_LEVEL } from "./node-levels";
import type { SpatialIndex } from "./spatial-index";
import {
  READING_NEXT,
  READING_PREVIOUS,
  READING_LEVEL_SEQUENCE,
  ReadingOrderGraph,
  createReadingOrderNode,
} from "./reading-order";
import type { ReadingOrderEdge } from "./reading-order";

export interface BuildReadingOrderOptions {
  /**
   * Optional spatial index over the hierarchy nodes. When supplied it must
   * contain every hierarchy node; it is used to break coincident-box ties in
   * the pure-geometry fallback via `searchOverlap`. Defaults to no index (id
   * tie-break).
   */
  readonly spatialIndex?: SpatialIndex<HierarchyNode>;
}

/** Build the immutable reading-order graph of a document. */
export function buildReadingOrder(
  hierarchy: LayoutHierarchy,
  options: BuildReadingOrderOptions = {}
): ReadingOrderGraph {
  const spatialIndex = options.spatialIndex;
  if (spatialIndex !== undefined) {
    for (const node of hierarchy.nodes()) {
      if (!spatialIndex.has(node.id)) {
        throw new Error(
          `spatial index is missing hierarchy node ${node.id}`
        );
      }
    }
  }

  const nodes = [];
  const edges: ReadingOrderEdge[] = [];
  let position = 0;

  for (const level of READING_LEVEL_SEQUENCE) {
    const levelNodes = hierarchy.nodesAtLevel(level);
    const keys = new Map<string, ReadingKey>();
    for (const node of levelNodes) {
      keys.set(node.id, readingKeyOf(hierarchy, node, level));
    }
    const ordered = [...levelNodes].sort((a, b) =>
      compareReadingNodes(keys.get(a.id)!, keys.get(b.id)!, a, b, spatialIndex)
    );

    for (let i = 0; i < ordered.length; i++) {
      const node = ordered[i];
      nodes.push(
        createReadingOrderNode({
          id: node.id,
          level: node.level,
          pageIndex: node.pageIndex,
          bbox: node.bbox,
          normalizedBBox: node.normalizedBBox,
          sourceRefs: node.sourceRefs,
          position,
        })
      );
      position += 1;
      if (i > 0) {
        const prevId = ordered[i - 1].id;
        const curId = node.id;
        edges.push({ type: READING_NEXT, from: prevId, to: curId });
        edges.push({ type: READING_PREVIOUS, from: curId, to: prevId });
      }
    }
  }

  return new ReadingOrderGraph(nodes, edges);
}

// ─── Reading keys ────────────────────────────────────────────────────────────

/** The deterministic ordering key of a hierarchy node. */
interface ReadingKey {
  readonly page: number;
  /** OCR ordering line index; undefined when no metadata exists. */
  readonly line: number | undefined;
  /** OCR ordering word index; undefined when no metadata exists. */
  readonly word: number | undefined;
  readonly y: number;
  readonly x: number;
}

/**
 * Derive a node's reading key. Own `sourceRefs` win; a Page falls back to its
 * page index; a derived container without references inherits the minimum
 * source reference of its subtree (the earliest OCR primitive it contains).
 * When nothing exists the node is geometry-only (`line`/`word` undefined).
 */
function readingKeyOf(
  hierarchy: LayoutHierarchy,
  node: HierarchyNode,
  level: HierarchyLevel
): ReadingKey {
  const ref = node.sourceRefs[0];
  let line: number | undefined;
  let word: number | undefined;
  if (ref !== undefined) {
    line = ref.lineIndex;
    word = ref.wordIndex;
  } else if (level === NODE_LEVEL.PAGE) {
    line = node.metadata.index ?? node.pageIndex;
  } else if (node.level !== HIERARCHY_ROOT_LEVEL) {
    const subtree = subtreeSourceRef(hierarchy, node);
    if (subtree !== undefined) {
      line = subtree.line;
      word = subtree.word;
    }
  }
  return {
    page: node.pageIndex,
    line,
    word,
    y: node.bbox.y,
    x: node.bbox.x,
  };
}

/** The minimum (line, word) source reference across a node's descendants. */
function subtreeSourceRef(
  hierarchy: LayoutHierarchy,
  node: HierarchyNode
): { line: number; word: number } | undefined {
  let best: { line: number; word: number } | undefined;
  for (const descendant of hierarchy.descendantsOf(node.id)) {
    const ref = descendant.sourceRefs[0];
    if (ref === undefined) continue;
    const line = ref.lineIndex;
    const word = ref.wordIndex ?? -1;
    if (
      best === undefined ||
      line < best.line ||
      (line === best.line && word < best.word)
    ) {
      best = { line, word };
    }
  }
  return best;
}

// ─── Comparator ──────────────────────────────────────────────────────────────

function compareReadingNodes(
  a: ReadingKey,
  b: ReadingKey,
  aNode: HierarchyNode,
  bNode: HierarchyNode,
  spatialIndex: SpatialIndex<HierarchyNode> | undefined
): number {
  let d = a.page - b.page;
  if (d !== 0) return d;
  if (a.line !== undefined || b.line !== undefined) {
    if (a.line === undefined) return 1;
    if (b.line === undefined) return -1;
    d = a.line - b.line;
    if (d !== 0) return d;
    if (a.word !== undefined && b.word !== undefined) {
      d = a.word - b.word;
      if (d !== 0) return d;
    }
  }
  d = a.y - b.y;
  if (d !== 0) return d;
  d = a.x - b.x;
  if (d !== 0) return d;
  if (spatialIndex !== undefined) {
    const ar = overlapRank(spatialIndex, aNode);
    const br = overlapRank(spatialIndex, bNode);
    d = ar - br;
    if (d !== 0) return d;
  }
  return aNode.id < bNode.id ? -1 : aNode.id > bNode.id ? 1 : 0;
}

/**
 * A node's position inside its own overlap neighborhood — a genuine spatial
 * index query that deterministically resolves coincident-box ties through the
 * index's insertion order. Only reached when page/geometry keys are identical.
 */
function overlapRank(
  index: SpatialIndex<HierarchyNode>,
  node: HierarchyNode
): number {
  const hits = index.searchOverlap(node.bbox);
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].key === node.id) return i;
  }
  return 0;
}
